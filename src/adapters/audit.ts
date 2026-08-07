/**
 * Dependency vulnerability adapter: the JavaScript analogue of `pip-audit`.
 *
 * `catalog.py` runs `pip-audit -f json` through `_project_tool_gate`. There is
 * no single equivalent here — each package manager ships its own auditor, with
 * its own JSON, its own flags and its own exit-code convention — so this
 * module dispatches on the manager `environment/project.ts` detected and hands
 * the output to the matching parser in `support/audit*.ts`. Every parser
 * normalizes to `Advisory`, so the report is identical whichever tool ran.
 *
 * ── THE RULE THIS FILE EXISTS TO ENFORCE ───────────────────────────────────
 * **AN AUDIT THAT DID NOT REACH THE NETWORK HAS NOT FOUND NOTHING.** It has
 * found *nothing out*, which is a different statement, and the gap between
 * them is where a supply-chain problem hides. Every failure path below ends in
 * a visible `offline`, `missing-tool` or `crashed` outcome and NONE of them
 * ends in a pass. This is the only gate in kragg whose correctness depends on a
 * remote
 * service, and it is written on the assumption that the service will be down at
 * the worst possible moment.
 *
 * Three specific silent-pass traps, each defended against here because each is
 * a real behaviour of a real tool:
 *
 *  1. `npm audit --offline` returns a well-formed, EMPTY report with exit 0 —
 *     npm's `getReport` short-circuits on `options.offline === true` before
 *     any request. kragg passes `--no-offline` so a project-level or
 *     environment-level offline setting cannot silently empty the report.
 *  2. `pnpm audit --ignore-registry-errors` turns a registry failure into exit
 *     0 with the error text as "output". kragg never passes it.
 *  3. `bun audit --json` ignores `--audit-level` and `--ignore`, so a filter
 *     passed to bun would appear to work and do nothing. kragg filters by
 *     severity itself, for every manager, after parsing.
 *
 * ── EXIT CODES ARE NOT A CRASH SIGNAL HERE ─────────────────────────────────
 * All four tools exit non-zero when they FIND vulnerabilities, and yarn
 * classic exits with a BITMASK (`info=1, low=2, moderate=4, high=8,
 * critical=16`, summed). So the exit code is used for exactly one thing —
 * detecting a binary that could not be spawned — and the PARSE decides
 * everything else. A tool that produced a readable report ran successfully, at
 * any exit code; a tool that did not produced a failure, at any exit code.
 */

import { join } from "node:path";

import type { Violation } from "../engine/models.ts";
import { runCommand } from "../engine/runner.ts";
import { missingTool as missingToolName, remediation } from "../environment/project.ts";
import type { PackageManager, ProjectEnvironment } from "../environment/project.ts";
import { parseBunAudit } from "./support/auditBun.ts";
import { parseNpmAudit } from "./support/auditNpm.ts";
import { parsePnpmAudit } from "./support/auditPnpm.ts";
import { parseYarnBerryAudit, parseYarnClassicAudit } from "./support/auditYarn.ts";
import type { YarnFlavor } from "./support/auditYarn.ts";
import { DEFAULT_SEVERITY_FLOOR, advisoryViolation, meetsFloor } from "./support/auditTypes.ts";
import type { Advisory, AuditParse, Severity } from "./support/auditTypes.ts";
import { fileExists, readJsonFile, readTextFile } from "./support/manifest.ts";
import { capped, crashed, missingTool, notConfigured, offline } from "./support/outcome.ts";
import type { Unavailable } from "./support/outcome.ts";
import { runOptions } from "./support/run.ts";

/** Gate name, matching the Python `pip-audit` gate's role. */
export const AUDIT_GATE = "audit";

export interface AuditOptions {
  readonly env: ProjectEnvironment;
  /** `audit_severity`. Advisories below this are counted but not reported. */
  readonly severityFloor?: Severity | undefined;
  readonly maxViolations: number;
  readonly timeoutMs?: number | undefined;
}

/** The audit ran and produced a report we could read. */
export interface AuditFindings {
  readonly ok: true;
  readonly command: readonly string[];
  readonly violations: readonly Violation[];
  readonly violationCount: number;
  /** Advisories the severity floor excluded. Reported, never hidden. */
  readonly belowFloor: number;
  readonly passed: boolean;
  readonly output: string;
  /**
   * `belowFloor`, as something the report will actually print.
   *
   * `output` carries the same sentence, but the report suppresses a PASSING
   * gate's raw output — and a passing audit is exactly the case where nobody
   * is otherwise told that the floor filtered something out. "Clean at `high`"
   * and "clean at `high`, with three below it" are different facts, and a
   * reader judging whether the floor is set right needs to know which they
   * have. Satisfies the optional `advisories` on `RanReport`; never affects
   * `passed` or the exit code.
   */
  readonly advisories: readonly Violation[];
}

export type AuditOutcome = AuditFindings | Unavailable;

/**
 * Run the project's auditor and map its findings onto violations.
 *
 * The package-manager binary is NOT resolved through `resolveBin`: pnpm, npm,
 * yarn and bun are not `node_modules/.bin` entries — they are the tools that
 * populate `node_modules` in the first place. They come from the environment,
 * which is the one place a package manager legitimately lives. The tool NAME
 * still comes from detection rather than from a guess, so kragg never runs
 * npm against a pnpm project.
 */
export async function runAudit(options: AuditOptions): Promise<AuditOutcome> {
  const { env } = options;
  if (env.packageManager === "unknown") {
    return notConfigured(
      "no package manager detected (no lockfile, no package.json#packageManager); " +
        "kragg will not guess which auditor to run",
    );
  }

  const floor = options.severityFloor ?? DEFAULT_SEVERITY_FLOOR;
  const command = auditCommand(env, floor);
  const result = await runCommand(AUDIT_GATE, command, env.root, runOptions(options.timeoutMs));

  const spawnFailure = binaryMissing(env, result.stderr, result.stdout, command);
  if (spawnFailure !== undefined) {
    return spawnFailure;
  }

  const parsed = parse(env, result.stdout, result.stderr);
  if (!parsed.ok) {
    return parsed.reason === "offline"
      ? offline(`${parsed.message}\n${OFFLINE_ADVICE}`)
      : crashed(
          `${parsed.message}\ncommand: ${command.join(" ")} (exit ${result.returncode})`,
        );
  }

  return report(parsed.advisories, floor, env.packageManager, command, options.maxViolations);
}

const OFFLINE_ADVICE =
  "kragg reports this as an environment failure, not a pass: an audit that " +
  "could not reach the advisory database has not cleared this project.";

/** Assemble the argv for the detected manager. Never a shell string. */
export function auditCommand(env: ProjectEnvironment, floor: Severity): readonly string[] {
  switch (env.packageManager) {
    case "npm":
      // `--no-offline` defends against trap 1 in the module docs. npm does not
      // filter its JSON by `--audit-level`, so no level is passed at all.
      return ["npm", "audit", "--json", "--no-offline"];
    case "pnpm":
      // pnpm DOES filter its JSON by the level, so passing it shrinks the
      // payload; kragg re-applies the same floor after parsing regardless.
      return ["pnpm", "audit", "--json", "--audit-level", floor];
    case "yarn":
      return yarnFlavor(env.root) === "berry"
        ? // `--all --recursive` makes berry match what the others do by
          // default: every workspace, transitive dependencies included.
          // `--no-deprecations` keeps deprecation notices out of a
          // vulnerability report (trap 2 in `auditYarn.ts`).
          ["yarn", "npm", "audit", "--json", "--all", "--recursive", "--no-deprecations"]
        : ["yarn", "audit", "--json"];
    case "bun":
      return ["bun", "audit", "--json"];
    case "unknown":
      return [];
  }
}

function parse(env: ProjectEnvironment, stdout: string, stderr: string): AuditParse {
  switch (env.packageManager) {
    case "npm":
      return parseNpmAudit(stdout, stderr);
    case "pnpm":
      return parsePnpmAudit(stdout, stderr);
    case "yarn":
      return yarnFlavor(env.root) === "berry"
        ? parseYarnBerryAudit(stdout, stderr)
        : parseYarnClassicAudit(stdout, stderr);
    case "bun":
      return parseBunAudit(stdout, stderr);
    case "unknown":
      return { ok: false, reason: "unreadable", message: "no package manager detected" };
  }
}

/**
 * Which yarn this project uses. They need different commands AND parsers.
 *
 * Decided from files on disk rather than by running `yarn --version`, because
 * a version probe costs a process spawn before the real work and gives the
 * same answer these files already carry:
 *
 *  1. `package.json#packageManager` — corepack's canonical declaration, and
 *     the only one that states a version outright.
 *  2. `.yarnrc.yml` — berry's config file. Classic uses `.yarnrc`, no
 *     extension, so the two never collide.
 *  3. The lockfile header — berry's `yarn.lock` carries a `__metadata:` block;
 *     classic's opens with `# yarn lockfile v1`.
 *
 * Defaults to CLASSIC when nothing decides, because `yarn audit` exists in
 * both (berry aliases it to a deprecation notice rather than failing), while
 * `yarn npm audit` is a hard error on classic.
 */
export function yarnFlavor(root: string): YarnFlavor {
  const manifest = readJsonFile(join(root, "package.json"));
  const declared = manifest === undefined ? undefined : manifest["packageManager"];
  if (typeof declared === "string") {
    const major = /^yarn@(\d+)/u.exec(declared.trim())?.[1];
    if (major !== undefined) {
      return Number.parseInt(major, 10) >= 2 ? "berry" : "classic";
    }
  }
  if (fileExists(join(root, ".yarnrc.yml"))) {
    return "berry";
  }
  const lock = readTextFile(join(root, "yarn.lock"));
  if (lock !== undefined && /^__metadata:/mu.test(lock)) {
    return "berry";
  }
  return "classic";
}

/**
 * The package manager itself could not be spawned.
 *
 * Mirrors `_is_tool_module` in `catalog.py` exactly, and the subtlety is the
 * same one: `missingTool` reports whatever name it found in the output, and
 * that name is only an ENVIRONMENT failure when it is the tool we tried to
 * run. An advisory whose title happens to contain "command not found" must not
 * be mistaken for a missing package manager.
 */
function binaryMissing(
  env: ProjectEnvironment,
  stderr: string,
  stdout: string,
  command: readonly string[],
): Unavailable | undefined {
  const missing = missingToolName({
    name: AUDIT_GATE,
    command: [...command],
    cwd: env.root,
    returncode: 127,
    stdout,
    stderr,
  });
  if (missing === null || missing !== env.packageManager) {
    return undefined;
  }
  return missingTool(
    `${env.packageManager} is not installed or not on PATH, so kragg cannot audit ` +
      `this project's dependencies.\nInstall ${env.packageManager}, then re-run. ` +
      `(${remediation(env.packageManager, "<package>")} shows the form kragg expects.)`,
  );
}

/** Apply the severity floor and build the outcome. */
function report(
  advisories: readonly Advisory[],
  floor: Severity,
  manager: PackageManager,
  command: readonly string[],
  maxViolations: number,
): AuditFindings {
  const reportable = advisories.filter((advisory) => meetsFloor(advisory.severity, floor));
  const violations = reportable.map((advisory) => advisoryViolation(advisory, manager));
  const belowFloor = advisories.length - reportable.length;
  return {
    ok: true,
    command,
    violations: capped(violations, maxViolations),
    violationCount: violations.length,
    belowFloor,
    passed: violations.length === 0,
    output: summarize(violations.length, belowFloor, floor),
    advisories: floorAdvisory(belowFloor, floor),
  };
}

/**
 * One advisory naming what the floor filtered, or none when it filtered
 * nothing.
 *
 * One line, not one per excluded package: the actionable fact is that the
 * floor is doing work and can be lowered, and listing N packages nobody is
 * being asked to fix would cost a reader's attention to say the same thing.
 */
function floorAdvisory(belowFloor: number, floor: Severity): readonly Violation[] {
  if (belowFloor === 0) {
    return [];
  }
  const noun = belowFloor === 1 ? "advisory" : "advisories";
  return [
    {
      message: `${belowFloor} ${noun} below the \`${floor}\` severity floor, not reported`,
      code: "below-severity-floor",
      fixHint: "lower `audit_severity` in kragg.json to see them",
    },
  ];
}

/**
 * The headline.
 *
 * Advisories BELOW the floor are named in the summary even though they are not
 * violations. A filtered finding that leaves no trace is indistinguishable
 * from no finding, and the reader needs to know the floor is doing work before
 * they can judge whether it is set right.
 */
function summarize(found: number, belowFloor: number, floor: Severity): string {
  if (found === 0 && belowFloor === 0) {
    return "";
  }
  const tail = belowFloor === 0 ? "" : ` (${belowFloor} below the \`${floor}\` floor)`;
  if (found === 0) {
    return `audit: no advisories at or above \`${floor}\`${tail}`;
  }
  const noun = found === 1 ? "package" : "packages";
  return `audit: ${found} vulnerable ${noun} at or above \`${floor}\`${tail}`;
}

