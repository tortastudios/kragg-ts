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
 * ── RESOLUTION ─────────────────────────────────────────────────────────────
 * The `secret_scanner` policy setting takes four values (`SecretScannerChoice`):
 *
 *  - `"auto"` (default) — gitleaks if usable, else secretlint if installed in
 *    the project, else skip naming BOTH options and both install commands.
 *  - `"gitleaks"` / `"secretlint"` — that one, or a visible skip carrying that
 *    tool's install command. NEVER a silent fall-back to the other: an
 *    explicit choice that cannot be honoured is a fact the operator has to
 *    learn, and a project that pinned `gitleaks` for its rule coverage would
 *    otherwise be quietly scanned by something else.
 *  - `"off"` — skip with reason `"disabled by policy"`. Turning the gate off
 *    is legitimate, and the report must distinguish "you switched this off"
 *    from "we could not find a scanner"; they call for opposite responses.
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

/** Where to get gitleaks; it is not installable through a package manager. */
export const GITLEAKS_RELEASES = "https://github.com/gitleaks/gitleaks/releases";

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
 * "no silent fallback" structural rather than a rule someone has to remember.
 */
export async function runSecretScan(options: SecretScanOptions): Promise<SecretsOutcome> {
  if (options.scanner === "off") {
    return skipped("disabled by policy (secret_scanner = \"off\")");
  }
  const targets = options.targets ?? DEFAULT_TARGETS;
  if (targets.length === 0) {
    // An empty target list is a configuration fact, not a clean repo. Same
    // rule as `_unconfigured`: say so, do not pass.
    return skipped("no scan targets configured");
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
  return skipped(exhaustedReason(options.scanner, reasons));
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

/** Why nothing in the preference order ran. */
function exhaustedReason(
  choice: SecretScanner | "auto",
  reasons: readonly string[],
): string {
  return choice === "auto" ? autoSkipReason(reasons) : (reasons[0] ?? "no scanner");
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
    return Promise.resolve(skipped(notInstalledReason(candidate, options.env)));
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

/** "Not installed", with the one command that fixes it. */
function notInstalledReason(candidate: SecretScanner, env: ProjectEnvironment): string {
  if (candidate === "secretlint") {
    return (
      "secretlint is not installed in this project. " +
      remediation(env.packageManager, SECRETLINT_PACKAGES)
    );
  }
  return `gitleaks was not found on PATH. ${gitleaksInstall()}`;
}

/**
 * The gitleaks install line.
 *
 * gitleaks is a Go binary, so there is no package-manager command to generate
 * from `remediation()`; homebrew is the one-liner on macOS and the release
 * page is the honest answer everywhere else.
 */
function gitleaksInstall(): string {
  if (process.platform === "darwin") {
    return "Fix: brew install gitleaks";
  }
  if (process.platform === "linux") {
    return `Fix: brew install gitleaks, or download a binary from ${GITLEAKS_RELEASES}`;
  }
  return `Fix: download a binary from ${GITLEAKS_RELEASES}`;
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
 * implementation detail and is not reported.
 */
async function runGitleaks(
  context: SecretScanContext,
  run: RunCommand,
): Promise<SecretsOutcome> {
  const probe = await run("gitleaks", gitleaks.versionCommand(context.bin), context.root);
  const unusable = versionProblem(probe);
  if (unusable !== null) {
    return skipped(unusable);
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
 * Why this gitleaks cannot be used, or `null` if it can.
 *
 * Every branch returns a SKIP reason rather than an error, so `"auto"` can
 * move on to secretlint: a gitleaks that is absent, broken or too old is a
 * missing scanner, not a failed scan.
 */
function versionProblem(probe: CompletedCommand): string | null {
  if (probe.returncode !== 0) {
    const missing = missingTool(probe);
    return missing === null
      ? `gitleaks could not be run (\`gitleaks version\` exited ${probe.returncode}). ${gitleaksInstall()}`
      : `gitleaks was not found on PATH (${missing}). ${gitleaksInstall()}`;
  }
  const version = gitleaks.parseVersion(probe.stdout);
  if (version === null) {
    return (
      "could not determine the gitleaks version, so kragg cannot confirm it " +
      `supports \`--report-path -\`; without that the scan would write ` +
      `credentials to a file. ${gitleaksInstall()}`
    );
  }
  if (!gitleaks.versionSupported(version)) {
    return (
      `gitleaks ${version.join(".")} is too old; kragg needs ` +
      `${gitleaks.MINIMUM_VERSION.join(".")} or newer (for \`dir\` and for ` +
      `\`--report-path -\`, which keeps the report off disk). ${gitleaksInstall()}`
    );
  }
  return null;
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
