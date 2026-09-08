/**
 * `kragg coverage` — the uncovered lines that actually matter, ranked.
 *
 * The port of `kragg/src/kragg/coverage.py` and its `cmd_coverage`. The
 * Python module's docstring is the design brief and it is worth restating,
 * because every decision below follows from it: THE PERCENTAGE IS THE WEAK,
 * GAMEABLE SIGNAL KRAGG DELIBERATELY DEMOTES. A repo at 92% can have its
 * highest-fan-in function entirely untested; a repo at 71% can be defended
 * exactly where it matters. So this command never prints a dashboard number.
 * It prints the GAP — uncovered lines inside critical functions, ranked by
 * fan-in, as `file:line` pointers an agent can act on without asking a
 * follow-up question.
 *
 * ── IT IS A REPORT, NOT A GATE ─────────────────────────────────────────────
 * "No coverage data" is a STATE and exits `0` with the line `cmd_coverage`
 * prints, byte for byte, followed by the path that was expected. The gating
 * equivalent is `gates/criticalCoverage.ts`, which fails the build on the
 * same data. Two surfaces, one computation: this command calls
 * `criticalCoverageGaps`, the function that gate already exports, so the
 * report and the gate can never disagree about what is uncovered or which
 * functions are unmeasured.
 *
 * A report that IS there but cannot be used — unreadable, truncated, or
 * naming no file under the source paths — is not "no data": it is an ERROR,
 * exit 3, with the file named. Printing "no coverage data" for a corrupt
 * file would send the reader to re-run a suite that already ran.
 *
 * ── WHAT IT READS, AND FROM WHERE ──────────────────────────────────────────
 * The artifact the project's OWN test runner publishes, and nothing else.
 * `kragg check` moves the coverage its run produced to `coverage_report_path`
 * (istanbul JSON, from vitest) or to the `lcov.info` beside it (from `node
 * --test` and `bun test`) — see `adapters/support/testCommands.ts`. This
 * command detects the runner the same way the gate does (`test_runner`, then
 * the project's manifest) and reads the ONE file that runner writes. It does
 * not look for "whichever report exists": after a switch from vitest to
 * `node --test` the older istanbul file is still on disk beside the new
 * tracefile, and preferring the richer format would read the other runner's
 * stale coverage. This command is on demand; the gate never reads from here.
 *
 * ── THE UNMEASURED ROW IS NOT A ZERO ───────────────────────────────────────
 * A critical function the report says nothing usable about is listed
 * separately, with the cause the gate found — never loaded, a name the
 * source could not disambiguate, a body the report is silent on — and is
 * NOT counted as covered or uncovered. The gate fails such a function; this
 * command shows the same row with the same words.
 */

import { relative } from "node:path";

import type { TypeScriptApi } from "../analysis/sourceFile.ts";
import { readCoverageReport } from "../adapters/support/coverage.ts";
import type { CoverageReadFailure } from "../adapters/support/coverage.ts";
import { detectTestRunner } from "../adapters/support/detect.ts";
import type { TestRunnerName } from "../adapters/support/detect.ts";
import { readLcov } from "../adapters/support/lcov.ts";
import { publishedPaths } from "../adapters/support/testCommands.ts";
import { EXIT_ENVIRONMENT, EXIT_OK, EXIT_USAGE } from "../engine/report.ts";
import {
  coverageEvidenceProblem,
  coverageModel,
  criticalCoverageGaps,
  type CriticalCoverageGap,
  type CriticalCoverageOptions,
} from "../gates/criticalCoverage.ts";
import { loadPolicy, PolicyError, type KraggPolicy } from "../policy/policy.ts";

/** What `cmd_coverage` prints when the report is missing. Exit code stays 0. */
export const NO_COVERAGE_DATA_MESSAGE = "no coverage data (run `kragg check` first)";

/** How many uncovered lines are listed before `+N more`, as in Python. */
export const LINE_CAP = 12;

/** Inputs for {@link runCoverage}. Everything optional so the CLI can pass a subset. */
export interface CoverageOptions {
  /** Project root. Defaults to the current working directory. */
  readonly root?: string | undefined;
  /**
   * Overrides the policy's `coverage_report_path`: where the istanbul report
   * is, relative to the root or absolute, with the lcov tracefile beside it.
   */
  readonly reportPath?: string | undefined;
  /** Pre-loaded policy. Loaded from the root when absent. */
  readonly policy?: KraggPolicy | undefined;
  /** Compiler used to map modules to files. Defaults to the project's own. */
  readonly api?: TypeScriptApi | undefined;
}

/** The one artifact this project's runner publishes. */
export interface CoverageSource {
  readonly runner: TestRunnerName;
  readonly format: "istanbul" | "lcov";
  /** Absolute path. */
  readonly path: string;
}

/**
 * Print criticality-ranked coverage gaps.
 *
 * `0` on data or on no data; `2` on a malformed `kragg.json`; `3` when a
 * report is present and unusable, or the project has no runner to publish
 * one — see the module header.
 */
export async function runCoverage(options: CoverageOptions = {}): Promise<number> {
  const root = options.root ?? process.cwd();
  let policy: KraggPolicy;
  try {
    policy = options.policy ?? loadPolicy(root);
  } catch (error) {
    if (error instanceof PolicyError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }
  const source = coverageSource(root, policy, options.reportPath);
  if (source === null) {
    process.stderr.write(NO_RUNNER_MESSAGE);
    return EXIT_ENVIRONMENT;
  }
  const read = readPublished(source);
  if (!read.ok) {
    if (read.reason === "missing") {
      process.stdout.write(missingMessage(root, source));
      return EXIT_OK;
    }
    process.stderr.write(`coverage report unusable: ${read.message}\n`);
    return EXIT_ENVIRONMENT;
  }
  const gateOptions: CriticalCoverageOptions = {
    root,
    sourcePaths: policy.sourcePaths,
    ...read.document,
    api: options.api,
  };
  const problem = evidenceProblem(gateOptions);
  if (problem !== null) {
    process.stderr.write(`coverage report unusable: ${relative(root, source.path)} — ${problem}\n`);
    return EXIT_ENVIRONMENT;
  }
  process.stdout.write(`${renderGaps(criticalCoverageGaps(gateOptions)).join("\n")}\n`);
  return EXIT_OK;
}

const NO_RUNNER_MESSAGE =
  "no test runner detected, so `kragg check` publishes no coverage for this project " +
  "(set `test_runner`, or see `kragg doctor`)\n";

/** cmd_coverage's line, then the path this project's runner would have written. */
function missingMessage(root: string, source: CoverageSource): string {
  return (
    `${NO_COVERAGE_DATA_MESSAGE}\n  expected ${relative(root, source.path)}, ` +
    `the ${source.format} report \`kragg check\` publishes for ${source.runner}\n`
  );
}

/** The gate's own verdict on whether the document can serve as evidence. */
function evidenceProblem(options: CriticalCoverageOptions): string | null {
  const model = coverageModel(options);
  return model === null ? null : coverageEvidenceProblem(model, options.sourcePaths);
}

/** The published artifact as the gate takes it, or why it could not be read. */
type PublishedRead =
  | { readonly ok: true; readonly document: Pick<CriticalCoverageOptions, "report" | "lcov"> }
  | CoverageReadFailure;

/** Read the one artifact `source` names, in that runner's format. */
function readPublished(source: CoverageSource): PublishedRead {
  if (source.format === "istanbul") {
    const read = readCoverageReport(source.path);
    return read.ok ? { ok: true, document: { report: read.report.raw } } : read;
  }
  const read = readLcov(source.path);
  return read.ok ? { ok: true, document: { report: null, lcov: read.report } } : read;
}

/**
 * Which published artifact to read, decided by the runner — never by which
 * file happens to exist. `null` when no runner is configured or detected.
 */
export function coverageSource(
  root: string,
  policy: KraggPolicy,
  reportPath?: string | undefined,
): CoverageSource | null {
  const runner = detectTestRunner(root, policy.testRunner).runner;
  if (runner === undefined) {
    return null;
  }
  const paths = publishedPaths(root, reportPath ?? policy.coverageReportPath);
  return runner === "vitest"
    ? { runner, format: "istanbul", path: paths.publishedIstanbulFile }
    : { runner, format: "lcov", path: paths.publishedLcovFile };
}

/**
 * Render gaps as token-efficient lines: a summary, then only the actionable
 * rows.
 *
 * CLEAN FUNCTIONS ARE COUNTED AND NOT LISTED. That is the whole economy of
 * this output — a repo with 40 critical functions and 3 gaps prints four
 * lines, not forty. Python makes the same choice, and it is why this fits in
 * an agent's context where a coverage table would not.
 */
export function renderGaps(gaps: readonly CriticalCoverageGap[]): string[] {
  if (gaps.length === 0) {
    return ["no critical functions (run `kragg criticality --write`)"];
  }
  const withGaps = gaps.filter((row) => row.measured && row.missingLines.length > 0);
  const unmeasured = gaps.filter((row) => !row.measured);
  const clean = gaps.length - withGaps.length - unmeasured.length;
  const lines = [
    `critical coverage: ${gaps.length} functions, ${withGaps.length} with gaps, ` +
      `${clean} clean, ${unmeasured.length} unmeasured`,
  ];
  lines.push(...withGaps.map(gapLine));
  lines.push(...unmeasured.map(unmeasuredLine));
  return lines;
}

/**
 * One gap, as a `file:line` pointer.
 *
 * The FIRST uncovered line is put in the `file:line` position because that is
 * the one an editor jumps to; the rest follow as a list. Python prints the
 * bare filename and then the lines, which makes the most useful line number
 * un-clickable.
 */
function gapLine(row: CriticalCoverageGap): string {
  const first = row.missingLines[0] ?? 1;
  return (
    `  ${row.file}:${first} ${row.qualname} (fan-in ${row.fanIn}) ` +
    `— uncovered: ${formatLines(row.missingLines)}`
  );
}

/** An unmeasured row names its cause; Python prints "no test imports it". */
function unmeasuredLine(row: CriticalCoverageGap): string {
  const where = row.line === undefined ? row.file : `${row.file}:${row.line}`;
  return `  ${where} ${row.qualname} (fan-in ${row.fanIn}) — unmeasured: ${row.reason ?? ""}`;
}

/** `3, 4, 9, +7 more` — capped, because a 200-line list is not a pointer. */
function formatLines(lines: readonly number[]): string {
  const shown = lines.slice(0, LINE_CAP).join(", ");
  return lines.length > LINE_CAP ? `${shown}, +${lines.length - LINE_CAP} more` : shown;
}
