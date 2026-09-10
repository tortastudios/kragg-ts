/**
 * How the test gate describes evidence it refuses.
 *
 * Two situations leave `adapters/testRunner.ts` with nothing it may believe,
 * and both are reported as ERROR (exit 3) rather than as a failed or — worse —
 * a passed gate:
 *
 *  - kragg KILLED the runner (`CompletedCommand.killed`): the timeout elapsed
 *    or the output buffer overflowed. Whatever the runner wrote before that is
 *    not a complete report, even when it parses, so it is not read at all.
 *  - the runner exited on its own without a complete report in this run's
 *    directory (`support/testCommands.ts`, `RUNS_DIR`). Since that directory
 *    is empty until the runner writes to it, "no report" cannot be confused
 *    with "an older report".
 *
 * Each message says what was EXPECTED and what was FOUND, in the runner's own
 * terms, because the reader's next step depends on the difference: no file at
 * all points at a crash before the reporter fired, a truncated file at a
 * crash during it, and a TAP stream without its summary at a process that died
 * mid-suite. Then the tail of the runner's own output, which is where the
 * actual cause is.
 *
 * The coverage headline lives here too, because it has the same job: it says
 * what was COUNTED. A file the run never loaded is in the denominator with
 * every statement line uncovered (`support/coverage.ts`, `projectTotals`),
 * and a number that moved because of that must name the files, or a reader
 * is left hunting for a regression in code that was never the problem.
 */

import { statSync } from "node:fs";

import type { CompletedCommand, Violation } from "../../engine/models.ts";
import { testRunnerPatterns } from "../../util/testPaths.ts";
import type { ProjectTotals } from "./coverage.ts";
import type { TestRunnerName } from "./detect.ts";
import type { Artifacts } from "./testCommands.ts";
import type { TestReport } from "./testReport.ts";

/** `code` for the coverage threshold, distinct from any test failure. */
export const COVERAGE_BELOW_THRESHOLD = "coverage-below-threshold";

/**
 * `code` for a failure the RUNNER decided, which its own report does not carry.
 *
 * Deliberately its own code, never merged into `COVERAGE_BELOW_THRESHOLD`: one
 * is kragg's line-coverage floor (`coverage_fail_under`, computed here from the
 * coverage artifact) and the other is a verdict the tool being driven reached
 * on its own configuration, over dimensions kragg does not compute. Reporting
 * them as one number would say a single, ambiguous thing about two independent
 * checks.
 */
export const RUNNER_REPORTED_FAILURE = "runner-reported-failure";

/** How each runner is made to write its coverage artifact, for the error arm. */
export const COVERAGE_ADVICE: Readonly<Record<TestRunnerName, string>> = {
  vitest:
    "vitest writes it via its `json` coverage reporter; check that " +
    "`coverage.provider` is installed (@vitest/coverage-v8 or -istanbul).",
  node: "node --test writes lcov via `--test-reporter=lcov`; coverage needs Node 20.1+.",
  bun: "bun test writes lcov via `--coverage-reporter=lcov`.",
};

/** How many never-loaded files the headline names before `+N more`. */
const UNLOADED_PREVIEW = 5;

/** The coverage headline: the number, then what was counted to reach it. */
export function coverageLine(totals: ProjectTotals): string {
  return (
    `line coverage ${totals.pct}% ` +
    `(${totals.coveredLines}/${totals.totalLines} lines${unloadedNote(totals)})`
  );
}

/** The floor was not met. Line coverage only: no branch is claimed or checked. */
export function belowThreshold(totals: ProjectTotals, failUnder: number): Violation {
  return {
    message:
      `line coverage ${totals.pct}% is below the required ${failUnder}% ` +
      `(${totals.coveredLines}/${totals.totalLines} lines${unloadedNote(totals)})`,
    code: COVERAGE_BELOW_THRESHOLD,
    fixHint: "run `kragg coverage` for the uncovered lines of the highest-fan-in functions",
  };
}

/** A line where a runner announces its own coverage-threshold verdict. */
const THRESHOLD_LINE = /coverage.*threshold/iu;

/** How many of the runner's own lines the violation quotes. */
const THRESHOLD_PREVIEW = 4;

/**
 * The runner FAILED THE RUN for a reason its own report does not record.
 *
 * kragg passes no coverage threshold to any runner (see `testCommands.ts`), but
 * it does not run the runner in a vacuum: `vitest run --coverage` still reads
 * the project's own `vitest.config.ts`, so a `coverage.thresholds` block there
 * is checked by vitest, on vitest's own dimensions, and signalled the only way
 * vitest has — `process.exitCode = 1`. The json report is written BEFORE that
 * check and still says `success: true`, so reading the report alone turns a
 * genuine, already-computed failure into a kragg pass. That is precisely the
 * signal this project must never swallow, so the exit code is consulted too.
 *
 * The trigger is STRUCTURAL, not textual: the runner's own report says the run
 * passed, every test in it passed, a complete coverage artifact came back — and
 * the process still exited non-zero. Nothing kragg asked for can produce that
 * combination, so the verdict is the runner's own. The runner's threshold lines
 * are quoted when it printed any, because that is where the dimension and the
 * numbers are; a wording change in a future release costs the detail, never the
 * signal.
 *
 * Scope is deliberately narrow, so a project with no runner-native thresholds
 * behaves exactly as before:
 *
 *  - only when coverage was asked for AND a complete artifact was read. Without
 *    `--coverage` no runner checks a coverage threshold, and an unreadable
 *    artifact is already an ERROR with its own message;
 *  - only when the runner's own report is a PASS with no violations parsed. A
 *    failing suite, a suite that would not import and a run that matched no
 *    files each exit non-zero already and are each reported as themselves;
 *  - never when the report is empty of tests — that is the "discovered nothing"
 *    error, and it must not be re-labelled as a threshold miss.
 */
export function runnerReportedFailure(
  runner: TestRunnerName,
  result: CompletedCommand,
  report: TestReport,
  coverageComplete: boolean,
): Violation | undefined {
  if (!coverageComplete || result.returncode === 0) {
    return undefined;
  }
  if (!report.success || report.violations.length > 0 || report.summary.total === 0) {
    return undefined;
  }
  const quoted = thresholdLines(result);
  const ran = `${runner} exited ${result.returncode} with all ${report.summary.total} tests passing`;
  return {
    message:
      quoted === undefined
        ? `${ran} and a complete coverage report, so the run was failed by the runner ` +
          "itself. kragg passes no threshold to any runner and enforces only its own " +
          "line-coverage floor (`coverage_fail_under`), which this run met — the usual " +
          "cause is a coverage threshold in the runner's own configuration, on a " +
          "dimension kragg does not compute."
        : `${ran}: the run was failed by the runner's OWN configured coverage threshold, ` +
          `not by kragg's line-coverage floor. ${runner} reported: ${quoted}`,
    code: RUNNER_REPORTED_FAILURE,
    fixHint:
      "this is the runner's own threshold on its own coverage dimensions, not " +
      "`coverage_fail_under` — run the project's own coverage command (or this gate's " +
      `command: ${result.command.join(" ")}) to see which dimension failed`,
  };
}

/**
 * The runner's own threshold lines, on one line, or `undefined` for none.
 *
 * stderr first — vitest prints `ERROR: Coverage for branches (60%) does not
 * meet global threshold (80%)` there — then stdout, where `node --test` puts
 * its `# Error: 66.67% line coverage does not meet threshold of 90%.` as a TAP
 * diagnostic. Matching on "coverage … threshold" rather than on one tool's
 * exact sentence covers both without kragg having to know which ran, and a
 * leading TAP `#` is dropped so the quote reads as the sentence it is. This is
 * DETAIL attached to a signal that already stands on the exit code: a wording
 * change in some future release loses the numbers, never the finding.
 */
function thresholdLines(result: CompletedCommand): string | undefined {
  const seen = new Set<string>();
  for (const line of `${result.stderr}\n${result.stdout}`.split("\n")) {
    const trimmed = line.trim().replace(/^#\s*/u, "");
    if (trimmed !== "" && THRESHOLD_LINE.test(trimmed)) {
      seen.add(trimmed);
    }
  }
  const lines = [...seen].slice(0, THRESHOLD_PREVIEW);
  return lines.length === 0 ? undefined : lines.map((line) => `"${line}"`).join("; ");
}

/** The files in the denominator that no test loaded, by name. */
function unloadedNote(totals: ProjectTotals): string {
  if (totals.unloaded.length === 0) {
    return "";
  }
  const lines = totals.unloaded.reduce((sum, entry) => sum + entry.statementLines, 0);
  const shown = totals.unloaded.slice(0, UNLOADED_PREVIEW).map((entry) => entry.path);
  const more = totals.unloaded.length - shown.length;
  return (
    `; ${totals.unloaded.length} of ${totals.sourceFiles} source files never loaded by ` +
    `the test run, counted as uncovered (${lines} statement lines read from the source): ` +
    `${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}`
  );
}

/**
 * The runner completed and found NOTHING to run.
 *
 * A third refusal, and the one that hid in plain sight the longest: a report
 * saying "0 tests, 0 failed" parses cleanly, so the gate passed and the run
 * was green. It is not a pass. Nothing was executed, nothing was verified, and
 * the two ordinary causes are both configuration a reader can fix in one line
 * — the tests are colocated and `test_paths` names only `test/`, or the suite
 * needs a loader the reconstructed argv does not carry. The message therefore
 * shows the argv that searched, what it searched for, and the three settings
 * that change the answer, INCLUDING the one that says "I meant it, skip this
 * gate" — a refusal with no way to opt out gets suppressed some other way.
 */
export function noTestsMessage(
  runner: TestRunnerName,
  note: string,
  testPaths: readonly string[],
): string {
  return (
    "the run completed and discovered NO TESTS, so it is evidence of nothing: " +
    "kragg will not report a gate green because zero tests failed.\n" +
    `${note}\n` +
    `${searched(runner, testPaths)}\n` +
    "Fix one of: point `test_paths` at the tests (an entry may be a directory or a " +
    "pattern, so `src/**/*.test.ts` selects a colocated suite); set `test_command` to the " +
    "argv that runs them, if the suite needs a loader, a setup file or a config flag; or " +
    'set `test_runner` to "off" to skip this gate deliberately.'
  );
}

/** What the runner was actually pointed at, in its own terms. */
function searched(runner: TestRunnerName, testPaths: readonly string[]): string {
  if (runner === "node") {
    return `searched: ${testRunnerPatterns(testPaths).join(", ")}`;
  }
  return (
    `searched: whatever ${runner} discovers from its own config — kragg does not pass ` +
    "`test_paths` to it, so an empty result is that config's file selection"
  );
}

/** kragg terminated the runner: nothing it wrote can be a complete report. */
export function killedMessage(
  runner: TestRunnerName,
  timeoutMs: number | undefined,
  result: CompletedCommand,
): string {
  const limit = timeoutMs === undefined ? "the gate's timeout elapsed" : `${timeoutMs} ms`;
  return (
    `${runner} did not finish: kragg terminated it after ${limit} (or because its ` +
    "output exceeded the buffer), so nothing it wrote is a complete report and kragg " +
    "cannot say whether the tests passed.\n" +
    `command: ${result.command.join(" ")}\n` +
    tail(`${result.stderr}\n${result.stdout}`.trim())
  );
}

/** The runner exited on its own without a report. Never reported as a pass. */
export function crashMessage(
  runner: TestRunnerName,
  result: CompletedCommand,
  layout: Artifacts,
): string {
  return (
    `${runner} exited ${result.returncode} without a complete test report for this run, ` +
    "so kragg cannot say whether the tests passed.\n" +
    `expected: ${expectedReport(runner, layout)}\n` +
    `found: ${foundReport(runner, result, layout)}\n` +
    `command: ${result.command.join(" ")}\n` +
    tail(`${result.stderr}\n${result.stdout}`.trim())
  );
}

function expectedReport(runner: TestRunnerName, layout: Artifacts): string {
  switch (runner) {
    case "vitest":
      return `${layout.reportFile}, written by vitest's json reporter`;
    case "node":
      return "a TAP document on stdout ending in node's `# tests` / `# fail` summary";
    case "bun":
      return "bun's console summary (`N pass` / `N fail`) on stdout";
  }
}

function foundReport(runner: TestRunnerName, result: CompletedCommand, layout: Artifacts): string {
  if (runner === "vitest") {
    const size = fileSize(layout.reportFile);
    return size === undefined
      ? `no file at ${layout.reportFile}, and no JSON report on stdout`
      : `${size} bytes there that are not a complete vitest report`;
  }
  return (
    `${result.stdout.length} bytes on stdout and ${result.stderr.length} on stderr, ` +
    "with no complete summary"
  );
}

function fileSize(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

/** The LAST lines of a crash: the cause is at the end, not the start. */
function tail(text: string, maxLines = 20): string {
  const lines = text.split("\n");
  return lines.length <= maxLines
    ? text
    : [`… ${lines.length - maxLines} earlier lines`, ...lines.slice(-maxLines)].join("\n");
}
