/**
 * Secret-scanning gate: drive an installed scanner, or skip VISIBLY.
 *
 * ── WHY THIS GATE HAS NO SCANNER OF ITS OWN ────────────────────────────────
 * The Python sibling (`kragg/gates/secrets.py`) bundles `detect-secrets` as a
 * dependency and calls it. kragg-ts DELIBERATELY DOES NOT BUNDLE A SCANNER,
 * and does not implement one either. Both halves of that are on purpose:
 *
 *  - A hand-rolled scanner would be strictly worse than gitleaks or
 *    secretlint. Those carry hundreds of maintained provider rules, entropy
 *    heuristics, and years of false-positive tuning. Nothing we could write in
 *    a few hundred lines competes, and secret detection is a domain where
 *    "mostly right" has no value.
 *  - A BAD SCANNER IS WORSE THAN NO SCANNER. A weak matcher that reports "no
 *    secrets found" produces the same green as a genuinely clean repo, and a
 *    green gate is read as a guarantee. Everyone downstream then behaves as
 *    though the repo was checked. That is the exact failure mode this whole
 *    project exists to prevent, so it is not a trade we make for convenience.
 *  - Bundling one would also break the zero-runtime-dependency rule in
 *    `docs/dependency-policy.md`, and a secret scanner is a poor candidate for
 *    the first exception: it is a large dependency tree that runs over every
 *    file in the repo.
 *
 * So the gate DETECTS a scanner, and when it cannot find one it skips with the
 * exact install command. That is the governing principle borrowed from
 * `catalog.py`'s `_unconfigured`:
 *
 *     Unconfigured policy-driven gates SKIP VISIBLY, never PASS SILENTLY.
 *
 * A skip is loud, it appears in the report, and nobody mistakes it for a
 * checked repo. Silence would be the fail-open.
 *
 * ── RESOLUTION: OPTIONAL AUTODETECTION vs. A REQUIRED TOOL ─────────────────
 * The `secret_scanner` policy setting takes four values (`SecretScannerChoice`),
 * and the split that matters is between the one that DETECTS and the two that
 * REQUIRE — the same rule `adapters/lint.ts` applies to `lint_tool`:
 *
 *  - `"auto"` (default) — OPTIONAL AUTODETECTION. gitleaks if usable, else
 *    secretlint if installed in the project, else a visible SKIP naming BOTH
 *    options and both install commands. The project never asked for a
 *    scanner, so "none installed" is not a failure; it is a fact, printed.
 *  - `"gitleaks"` / `"secretlint"` — a REQUIRED tool. The project named this
 *    scanner, so a run that cannot use it is an ERROR (exit 3) carrying that
 *    tool's install command, never a skip: a skip exits 0, and a project that
 *    pinned a scanner and got exit 0 believes it was scanned. There is also
 *    NEVER a silent fall-back to the other tool — the preference order for an
 *    explicit choice has one element, which makes that structural rather than
 *    a rule someone has to remember.
 *  - `"off"` — skip with reason `"disabled by policy"`. Turning the gate off
 *    is legitimate, and the report must distinguish "you switched this off"
 *    from "we could not find a scanner"; they call for opposite responses.
 *
 * A scanner that is INSTALLED and then misbehaves is a third thing again, and
 * it is an ERROR under every setting including `"auto"`: see
 * `secrets/gitleaks.ts`'s `versionProblem`.
 *
 * ── THE PATH EXCEPTION, AND WHY IT IS ONLY FOR gitleaks ────────────────────
 * `environment/project.ts` enforces a hard rule: tools are resolved from the
 * PROJECT's `node_modules/.bin` and never from `PATH`, because a globally
 * installed tool of a different version reports results that do not reproduce
 * in CI.
 *
 * gitleaks is the ONE deliberate exception, because the invariant that rule
 * protects does not exist for it: **gitleaks is a Go binary, not an npm
 * package.** It cannot appear in `node_modules/.bin` under any layout, it has
 * no relationship to the project's dependency graph, and there is no "project
 * version" of it to disagree with. Resolving it from `PATH` is the only way it
 * can be found at all. `findGitleaksOnPath` is therefore hardened:
 *
 *  - only ABSOLUTE `PATH` entries are searched. A relative entry — `.`, or the
 *    empty entry that POSIX reads as the current directory — would let a
 *    checked-out repo ship its own `./gitleaks` and have kragg execute it
 *    while scanning that same repo;
 *  - the candidate must be a regular, executable FILE.
 *
 * secretlint gets NO exception. It is an ordinary npm package, so it goes
 * through `resolveBin` like `tsc` does.
 *
 * ── SECRETS NEVER LEAVE THIS MODULE ────────────────────────────────────────
 * Violations reach `.kragg/history.jsonl`, terminals, and agent transcripts.
 * Two structural rules keep credentials out of them:
 *
 *  1. Each adapter builds a `Violation` from a short ALLOWLIST of report
 *     fields (see `secrets/gitleaks.ts` and `secrets/secretlint.ts`). Raw
 *     matches are never read, so they cannot be forwarded.
 *  2. The report itself is read from a PIPE, never written to disk. gitleaks'
 *     `--report-path -` and secretlint's stdout keep the unredacted findings
 *     in memory for the lifetime of one function call. Nothing in this module
 *     writes a file, and nothing puts scanner output into an error message
 *     except the scanner's own stderr on a crash — where there is no report.
 */

import type { CompletedCommand, Violation } from "../engine/models.ts";
import { runCommand } from "../engine/runner.ts";
import { missingTool, remediation, type ProjectEnvironment } from "../environment/project.ts";
import { defaultLookup, type SecretScannerLookup } from "./secrets/lookup.ts";
import * as gitleaks from "./secrets/gitleaks.ts";
import * as secretlint from "./secrets/secretlint.ts";
import { unreadableTargets } from "./secrets/targets.ts";
import {
  broken,
  scanned,
  skipped,
  type SecretScanContext,
  type SecretScanner,
  type SecretScannerChoice,
  type SecretsOutcome,
} from "./secrets/types.ts";

export type {
  SecretScanContext,
  SecretScanner,
  SecretScannerChoice,
  SecretsOutcome,
} from "./secrets/types.ts";
export { SECRET_CODE } from "./secrets/types.ts";
export {
  defaultLookup,
  findGitleaksOnPath,
  type SecretScannerLookup,
} from "./secrets/lookup.ts";

/** The npm packages a project needs for the secretlint path to work. */
export const SECRETLINT_PACKAGES = "secretlint @secretlint/secretlint-rule-preset-recommend";

export { GITLEAKS_RELEASES } from "./secrets/gitleaks.ts";

/**
 * Scanned by default: the whole project.
 *
 * Not `sourcePaths`. Credentials hide in `.env` files, CI workflows, editor
 * configs and test fixtures far more often than in `src/`, and a secret
 * scanner narrowed to hand-written code is a scanner that misses the common
 * case. The caller may pass narrower `targets` when it wants the fast path.
 */
export const DEFAULT_TARGETS: readonly string[] = ["."];

/** The subset of `runCommand` this gate uses. Injectable for tests. */
export type RunCommand = (
  name: string,
  command: readonly string[],
  cwd: string,
) => Promise<CompletedCommand>;

export interface SecretScanOptions {
  readonly env: ProjectEnvironment;
  /** The `secret_scanner` policy setting. */
  readonly scanner: SecretScannerChoice;
  /** Paths or globs to scan, relative to the root. Defaults to the project. */
  readonly targets?: readonly string[] | undefined;
  /**
   * A reviewed-findings baseline: gitleaks' `--baseline-path`, or secretlint's
   * `--secretlintignore`. The two formats are NOT interchangeable, so a
   * project that switches scanners must supply the matching file.
   */
  readonly baselinePath?: string | null | undefined;
  readonly lookup?: SecretScannerLookup | undefined;
  readonly run?: RunCommand | undefined;
}

/**
 * Run the secret scan, or explain why it did not run.
 *
 * `"auto"` walks the preference order and keeps going while each candidate
 * reports itself UNUSABLE (not installed, too old, unidentifiable). A scanner
 * that ran and BROKE stops the walk immediately and is reported as an error:
 * falling through to the other tool after a crash would mask a real failure
 * behind a second opinion.
 *
 * An explicit choice has a one-element preference order, which is what makes
 * "no silent fallback" structural rather than a rule someone has to remember —
 * and when that one element is unusable the run ENDS IN AN ERROR rather than a
 * skip, because the policy required it. See the module header.
 */
export async function runSecretScan(options: SecretScanOptions): Promise<SecretsOutcome> {
  if (options.scanner === "off") {
    return skipped("disabled by policy (secret_scanner = \"off\")");
  }
  const unscannable = scopeProblem(options);
  if (unscannable !== null) {
    return unscannable;
  }
  const lookup = options.lookup ?? defaultLookup(options.env);
  const run = options.run ?? runCommand;

  const reasons: string[] = [];
  for (const candidate of scannerOrder(options.scanner)) {
    const outcome = await runScanner(candidate, options, lookup, run);
    if (outcome.ok || !outcome.skipped) {
      return outcome;
    }
    reasons.push(outcome.reason);
  }
  return exhausted(options.scanner, reasons);
}

/**
 * Something wrong with the SCOPE, before any scanner is chosen — or `null`.
 *
 * Two different wrongs, and they are not the same outcome:
 *
 *  - nothing to scan at all is a configuration fact, not a clean repo, and it
 *    SKIPS. Same rule as `_unconfigured`: say so, do not pass;
 *  - a scope that does not exist on disk is an ERROR. The scan would have gone
 *    ahead and matched nothing, which reads exactly like a clean repository.
 *
 * Only a CALLER-SUPPLIED scope is checked against the filesystem: the default
 * is the project root, which exists by construction, while `--file`,
 * `--changed` and the Claude hook can each name a path that does not.
 */
function scopeProblem(options: SecretScanOptions): SecretsOutcome | null {
  const targets = options.targets;
  if (targets === undefined) {
    return null;
  }
  if (targets.length === 0) {
    return skipped("no scan targets configured");
  }
  const unreadable = unreadableTargets(options.env.root, targets);
  return unreadable === null ? null : broken(undefined, unreadable);
}

/**
 * The preference order to walk.
 *
 * An explicit choice yields a ONE-ELEMENT order, which is what makes "no
 * silent fallback" structural rather than a rule someone has to remember.
 */
function scannerOrder(choice: SecretScanner | "auto"): readonly SecretScanner[] {
  return choice === "auto" ? ["gitleaks", "secretlint"] : [choice];
}

/**
 * Nothing in the preference order ran — a skip or an error, by the setting.
 *
 * THE WHOLE REQUIRED/OPTIONAL SPLIT IS THIS FUNCTION. `"auto"` asked the
 * environment a question and got "nothing here", which is a visible skip and
 * exit 0. A named scanner is an instruction, and an instruction that could not
 * be carried out leaves the repository UNSCANNED — reported as `error: true`
 * and exit 3, so no pipeline reads it as a clean run.
 */
function exhausted(
  choice: SecretScanner | "auto",
  reasons: readonly string[],
): SecretsOutcome {
  if (choice === "auto") {
    return skipped(autoSkipReason(reasons));
  }
  return broken(undefined, requiredReason(choice, reasons[0] ?? "no scanner"));
}

/** The message for a REQUIRED scanner that could not be used. */
function requiredReason(choice: SecretScanner, reason: string): string {
  return (
    `secret_scanner = "${choice}" requires ${choice}, which this run could not ` +
    "use, so the repository was NOT scanned for secrets.\n" +
    `${reason}\n` +
    "kragg will not substitute the other scanner for a named one. Set " +
    "`secret_scanner` to \"auto\" to use whichever scanner is available, or to " +
    "\"off\" to disable the gate deliberately."
  );
}

/**
 * The `"auto"` skip message.
 *
 * Names every option tried and every install command, on separate lines, so
 * the reader can act without going to look anything up — the shape
 * `environment.py`'s `remediation()` established.
 */
function autoSkipReason(reasons: readonly string[]): string {
  return [
    "no secret scanner available; kragg does not bundle one (a scanner that " +
      "reports \"clean\" without checking is worse than no scanner)",
    ...reasons.map((reason) => `  - ${reason}`),
  ].join("\n");
}

function runScanner(
  candidate: SecretScanner,
  options: SecretScanOptions,
  lookup: SecretScannerLookup,
  run: RunCommand,
): Promise<SecretsOutcome> {
  const bin = candidate === "gitleaks" ? lookup.findGitleaks() : lookup.findSecretlint();
  if (bin === null) {
    return Promise.resolve(skipped(secretScannerMissing(options.env, candidate)));
  }
  const context: SecretScanContext = {
    root: options.env.root,
    bin,
    targets: options.targets ?? DEFAULT_TARGETS,
    baselinePath: options.baselinePath ?? null,
  };
  return candidate === "gitleaks"
    ? runGitleaks(context, run)
    : runSecretlint(options.env, context, run);
}

/**
 * "Not installed", with the one command that fixes it.
 *
 * Exported so `kragg doctor` reports a missing scanner in exactly the words
 * the gate would use. Two diagnostics that disagree about how to install the
 * same tool are worse than one.
 */
export function secretScannerMissing(
  env: ProjectEnvironment,
  candidate: SecretScanner,
): string {
  if (candidate === "secretlint") {
    return (
      "secretlint is not installed in this project. " +
      remediation(env.packageManager, SECRETLINT_PACKAGES)
    );
  }
  return `gitleaks was not found on PATH. ${gitleaks.installHint()}`;
}

/**
 * Drive gitleaks: probe the version, then scan each target.
 *
 * The version probe is not ceremony. `--report-path -` only exists from
 * `gitleaks.MINIMUM_VERSION`; on an older binary the `-` is taken as a
 * FILENAME, and gitleaks would drop a file named `-` containing every
 * credential it found into the project root. A version we cannot read is
 * treated as unusable for the same reason — this gate does not gamble with
 * where secrets get written.
 *
 * `dir` takes a single path, so multiple targets mean multiple invocations.
 * The reported command is the first scan's; the version probe is an
 * implementation detail and is not reported — EXCEPT when the probe itself is
 * what failed, where it is the only command that ran and naming it is the
 * whole diagnosis.
 */
async function runGitleaks(
  context: SecretScanContext,
  run: RunCommand,
): Promise<SecretsOutcome> {
  const probeCommand = gitleaks.versionCommand(context.bin);
  const probe = await run("gitleaks", probeCommand, context.root);
  const problem = gitleaks.versionProblem(probe, context.bin);
  if (problem !== null) {
    return problem.kind === "broken"
      ? broken(probeCommand, problem.reason)
      : skipped(problem.reason);
  }

  const violations: Violation[] = [];
  let reported: readonly string[] = gitleaks.versionCommand(context.bin);
  let first = true;
  for (const target of context.targets) {
    const command = gitleaks.scanCommand(context, target);
    if (first) {
      reported = command;
      first = false;
    }
    const result = await run("gitleaks", command, context.root);
    const outcome = gitleaksFindings(result, command);
    if (!outcome.ok) {
      return outcome;
    }
    violations.push(...outcome.violations);
  }
  return scanned("gitleaks", reported, violations);
}

/**
 * One gitleaks invocation, as an outcome.
 *
 * CONTRADICTIONS FAIL CLOSED. `LEAK_EXIT_CODE` with an empty report, or a
 * report that will not parse, means the tool and its output disagree — and the
 * only safe reading of "I cannot tell whether this repo has secrets in it" is
 * an error. Reporting zero violations there would be a green gate built on a
 * scanner we could not understand. The reverse skew (exit 0 with findings in
 * the report) keeps the findings.
 */
function gitleaksFindings(
  result: CompletedCommand,
  command: readonly string[],
): SecretsOutcome {
  const status = gitleaks.classifyExit(result.returncode);
  if (status === "error") {
    return broken(command, scannerError("gitleaks", result));
  }
  const parsed = gitleaks.parseReport(result.stdout);
  if (parsed === null) {
    return broken(command, unreadableReport("gitleaks", result));
  }
  if (status === "leaks" && parsed.length === 0) {
    return broken(command, contradiction("gitleaks", result.returncode));
  }
  return scanned("gitleaks", command, parsed);
}

/**
 * Drive secretlint. One invocation covers every target.
 *
 * `--output` is never passed; see `secrets/secretlint.ts` for why (it forces
 * exit 0 even with findings). A fatal secretlint error — exit 2, most often a
 * missing `.secretlintrc` — is an ERROR, not a skip: secretlint IS installed,
 * so the project chose this scanner and its configuration is broken. That is
 * exit code 3 with secretlint's own message, which already says how to fix it.
 */
async function runSecretlint(
  env: ProjectEnvironment,
  context: SecretScanContext,
  run: RunCommand,
): Promise<SecretsOutcome> {
  const command = secretlint.scanCommand(context);
  const result = await run("secretlint", command, context.root);
  const status = secretlint.classifyExit(result.returncode);
  if (status === "error") {
    // The binary resolved a moment ago and now will not spawn — a broken shim
    // or a half-installed dependency. That is a MISSING scanner, not a failed
    // scan, so it skips (and lets `"auto"` move on) rather than erroring.
    const missing = missingTool(result);
    if (missing !== null) {
      return skipped(
        `secretlint could not be run (${missing}). ` +
          remediation(env.packageManager, SECRETLINT_PACKAGES),
      );
    }
    return broken(command, scannerError("secretlint", result));
  }
  const parsed = secretlint.parseReport(result.stdout);
  if (parsed === null) {
    return broken(command, unreadableReport("secretlint", result));
  }
  if (status === "leaks" && parsed.length === 0) {
    return broken(command, contradiction("secretlint", result.returncode));
  }
  return scanned("secretlint", command, parsed);
}

/**
 * The message for a scanner that broke.
 *
 * Includes the tool's own stderr, which on this path holds a diagnostic and
 * NOT a report — a crashed scan has no findings to leak. stdout is
 * deliberately excluded: that is where the report would be.
 */
function scannerError(name: string, result: CompletedCommand): string {
  const detail = result.stderr.trim();
  return (
    `${name} failed (exit ${result.returncode}); the repository was NOT scanned.` +
    (detail === "" ? "" : `\n${detail}`)
  );
}

/**
 * The message for a report we could not parse.
 *
 * The unparseable payload is NOT quoted back. It is the report, and a report
 * that failed to parse is still full of credentials.
 */
function unreadableReport(name: string, result: CompletedCommand): string {
  return (
    `${name} exited ${result.returncode} but its JSON report could not be parsed, ` +
    "so kragg cannot tell whether this repository contains secrets. The report " +
    "is not quoted here because it contains the raw matches."
  );
}

function contradiction(name: string, returncode: number): string {
  return (
    `${name} exited ${returncode} to signal findings but reported none. ` +
    "kragg will not report a clean scan it does not understand."
  );
}
