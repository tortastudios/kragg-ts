/**
 * Dead-code and dependency-hygiene adapter: the JavaScript analogue of
 * `kragg audit`'s vulture + deptry pair.
 *
 * `cmd_audit` in the Python sibling runs two tools: vulture for unreachable
 * code and deptry for dependencies that are declared-but-unused or
 * used-but-undeclared. In JavaScript one tool covers both — **knip** — because
 * both questions reduce to the same import graph. Running one tool instead of
 * two is not a simplification kragg chose; it is what the ecosystem provides.
 *
 * The two CATEGORIES survive into the output regardless (`KnipCategory`), and
 * every finding carries its own `code`, because they call for different
 * responses: an unused export is a cleanup you can do at leisure, while an
 * unlisted dependency is a build that works only by accident of hoisting and
 * will break on the next clean install.
 *
 * SEVERITY, DELIBERATELY FLAT. knip 6 defaults `cycles` to `warn` rather than
 * `error`, so knip itself can exit 0 with cycles in its report. kragg does not
 * inherit that: pass/fail here is decided by the PARSED REPORT, not by knip's
 * exit code, so a finding knip downgrades is still a finding. The exit code is
 * used only to tell "ran and found things" from "could not run".
 *
 * VERIFIED AGAINST knip 6.32.0 and 5.88.1 — see `support/knipReport.ts` for
 * the schema provenance. Nothing was executed; kragg installs nothing.
 */

import { runCommand } from "../engine/runner.ts";
import type { Violation } from "../engine/models.ts";
import {
  missingToolMessage,
  missingTool as missingToolName,
  remediation,
  resolveBin,
} from "../environment/project.ts";
import type { ProjectEnvironment } from "../environment/project.ts";
import { capped, crashed, missingTool, notConfigured } from "./support/outcome.ts";
import type { Unavailable } from "./support/outcome.ts";
import { parseKnipJson } from "./support/knipReport.ts";
import type { KnipCounts } from "./support/knipReport.ts";
import { runOptions } from "./support/run.ts";

/** The npm package and the `node_modules/.bin` entry are both `knip`. */
const KNIP_BIN = "knip";
const KNIP_PACKAGE = "knip";

/** Gate name, matching the Python command this replaces. */
export const DEADCODE_GATE = "deadcode";

export interface DeadCodeOptions {
  readonly env: ProjectEnvironment;
  /** `max_violations_per_gate`. Findings beyond it are counted, not shown. */
  readonly maxViolations: number;
  /**
   * Extra knip arguments, e.g. `["--production"]` or `["--workspace", "app"]`.
   * kragg passes them through verbatim as separate argv entries; nothing is
   * ever concatenated into a shell string.
   */
  readonly extraArgs?: readonly string[] | undefined;
  readonly timeoutMs?: number | undefined;
}

/** knip ran and produced a report we could read. */
export interface DeadCodeFindings {
  readonly ok: true;
  readonly command: readonly string[];
  /** Capped for display. */
  readonly violations: readonly Violation[];
  /** True total, including any not in `violations`. */
  readonly violationCount: number;
  readonly counts: KnipCounts;
  readonly passed: boolean;
  /** One-line summary; empty when there is nothing to say. */
  readonly output: string;
}

export type DeadCodeOutcome = DeadCodeFindings | Unavailable;

/**
 * Run knip and map its report onto violations.
 *
 * Resolution goes through `resolveBin`, so knip comes from the PROJECT's
 * `node_modules/.bin` or not at all — a globally-installed knip of a different
 * major reads a different config schema and reports findings that do not
 * reproduce.
 */
export async function runDeadCode(options: DeadCodeOptions): Promise<DeadCodeOutcome> {
  const { env } = options;
  if (env.packageManager === "unknown") {
    return notConfigured(
      "no package manager detected (no lockfile, no package.json#packageManager); " +
        "knip cannot be resolved from an unidentified project",
    );
  }

  const bin = resolveBin(env, KNIP_BIN);
  if (bin === null) {
    return missingTool(missingToolMessage(env, KNIP_BIN, KNIP_PACKAGE));
  }

  const command = [bin, "--reporter", "json", ...(options.extraArgs ?? [])];
  const result = await runCommand(
    DEADCODE_GATE,
    command,
    env.root,
    runOptions(options.timeoutMs),
  );

  const report = parseKnipJson(result.stdout);
  if (report === undefined) {
    return crashOutcome(env, result.returncode, result.stdout, result.stderr, command);
  }

  const violationCount = report.violations.length;
  return {
    ok: true,
    command,
    violations: capped(report.violations, options.maxViolations),
    violationCount,
    counts: report.counts,
    passed: violationCount === 0,
    output: violationCount === 0 ? "" : summarize(report.counts),
  };
}

/**
 * knip produced no report we could parse. Decide WHY, precisely.
 *
 * The three cases below are the only ones that may be reported as an
 * environment failure; anything else is reported as a tool crash carrying the
 * tool's own output, because inventing a diagnosis for output we do not
 * recognise sends the reader to fix the wrong thing. In no case is this a
 * pass — knip that did not run has not checked anything.
 */
function crashOutcome(
  env: ProjectEnvironment,
  returncode: number,
  stdout: string,
  stderr: string,
  command: readonly string[],
): Unavailable {
  const missing = missingToolName({
    name: DEADCODE_GATE,
    command: [...command],
    cwd: env.root,
    returncode,
    stdout,
    stderr,
  });
  if (missing !== null) {
    return missingTool(
      `knip could not run: ${missing} is not available.\n` +
        remediation(env.packageManager, KNIP_PACKAGE),
    );
  }
  if (/Unable to find package\.json/i.test(stderr)) {
    return crashed(
      `knip found no package.json at ${env.root}. knip resolves the import ` +
        "graph from the manifest and cannot run without one.",
    );
  }
  return crashed(
    `knip exited ${returncode} without a readable JSON report ` +
      "(exit 2 is knip's own \"bad input or internal error\").\n" +
      `command: ${command.join(" ")}\n` +
      truncate(`${stderr}\n${stdout}`.trim()),
  );
}

/** The gate's one-line headline. Detail lives in the violations themselves. */
function summarize(counts: KnipCounts): string {
  const parts: string[] = [];
  if (counts.deadCode > 0) {
    parts.push(`${counts.deadCode} dead-code`);
  }
  if (counts.dependencies > 0) {
    parts.push(`${counts.dependencies} dependency`);
  }
  return `knip: ${parts.join(", ")} ${plural(counts.deadCode + counts.dependencies)}`;
}

function plural(total: number): string {
  return total === 1 ? "finding" : "findings";
}

/**
 * Keep a crash report readable.
 *
 * A knip stack trace can run to hundreds of lines. The first 20 carry the
 * cause; the rest is knip's own internals, which the reader cannot act on and
 * which costs them context they need for the actual fix.
 */
function truncate(text: string, maxLines = 20): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return text;
  }
  return [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`].join("\n");
}
