/**
 * Test-runner adapter: the analogue of the Python `pytest-coverage` gate.
 *
 * `catalog.py` has one runner and one command:
 *
 *     pytest --cov=src --cov-report=json:.kragg/coverage.json
 *            --cov-fail-under=<policy> -q
 *
 * JavaScript has three, none of which agrees with the others about anything —
 * not the result format, not the coverage format, not the flags. This module
 * detects which one a project uses (`support/detect.ts`), drives it, and
 * normalizes the outcome so a `GateResult` looks the same whichever ran.
 *
 * ── THE DISTINCTION THIS GATE MUST NOT GET WRONG ───────────────────────────
 * `_is_tool_module` in `catalog.py` guards one subtlety, and it has an exact
 * JavaScript twin:
 *
 *   > A user-code import failing inside pytest also prints "No module named
 *   > X"; that is a test failure, not a broken environment.
 *
 * Here, a test file with a bad import produces `Cannot find module
 * './helpers.ts'` — the same words `environment/project.ts` uses to detect a
 * missing TOOL. The two are told apart the same way Python tells them apart:
 * by comparing the missing NAME against the tool we tried to run. Only
 * `vitest`/`node`/`bun` itself missing is an environment failure (exit 3);
 * anything else the runner could not import is a TEST failure the project can
 * fix, and is reported as a violation against the test file. Getting this
 * backwards tells someone to reinstall their toolchain when they have a typo
 * in an import.
 *
 * ── EVIDENCE MUST BE THIS RUN'S, AND COMPLETE ──────────────────────────────
 * Every report is read from a directory that did not exist before this
 * invocation (`support/testCommands.ts`, `RUNS_DIR`), so a runner that crashes
 * cannot be credited with the report a previous run left behind, and a runner
 * switch cannot pick up the other runner's format. Three things are then
 * treated as UNUSABLE evidence — `error: true`, exit 3, never a pass and never
 * a plain failure: kragg killed the runner (timeout), the runner exited
 * without a complete report, or coverage was asked for and no complete
 * coverage artifact came back. A complete report that says tests FAILED is the
 * opposite case — a genuine finding, exit 1 — and the two are kept apart so a
 * reader is never sent to fix tests that never ran.
 *
 * ── COVERAGE: WHY kragg COMPUTES THE PERCENTAGE ITSELF ─────────────────────
 * All three runners can enforce a coverage threshold, and all three signal it
 * with **exit code 1 — the same code as a failing test**:
 *
 *  - vitest sets `process.exitCode = 1` in `checkThresholds` and prints
 *    `ERROR: Coverage for lines (x%) does not meet global threshold (y%)`.
 *  - node's `--test-coverage-lines` sets `process.exitCode = 1` with a
 *    diagnostic line, alongside the same code for test failures.
 *  - bun ORs the two conditions into one exit-code assignment and prints no
 *    distinguishing message at all.
 *
 * A gate that delegated the threshold could not tell "your tests fail" from
 * "your tests pass but coverage slipped" — different problems needing
 * different work. So kragg passes no threshold to any runner, reads the
 * coverage artifact, and computes the number itself. Coverage failure is its
 * own violation with its own code, and it can be reported alongside green
 * tests.
 *
 * ── …AND WHY THE RUNNER'S OWN THRESHOLD IS STILL REPORTED ──────────────────
 * Passing no threshold is not the same as there being none: `--coverage` leaves
 * the project's own `vitest.config.ts` in force, so vitest checks its own
 * `coverage.thresholds` over its own dimensions and signals a miss with that
 * same exit code — while the json report, written first, still says `success:
 * true`. Reading the report alone turned a failure the tool had already
 * computed into a kragg pass. `runnerReportedFailure`
 * (`support/testEvidence.ts`) reads it back off the exit code as a violation of
 * its own, beside kragg's line-coverage floor and never merged into it.
 *
 * THE NUMBER IS THE PROJECT'S, NOT THE REPORT'S. Every runner reports only
 * the files the run loaded, so a percentage over the report alone is a
 * percentage over whichever files happened to load. `projectTotals`
 * (`support/coverage.ts`) restricts the count to `source_paths` and adds
 * every source file the report does not mention with all of its statement
 * lines uncovered; the headline names those files. See
 * `coverage/inventory.ts` for where the line count comes from.
 *
 * ── COVERAGE ARTIFACTS, PER RUNNER ─────────────────────────────────────────
 *  - **vitest**: istanbul `coverage-final.json`. Its `json` coverage reporter
 *    is in the DEFAULT reporter set, and kragg names it explicitly anyway.
 *    Note `coverage.reportOnFailure` defaults to FALSE, so a failing run
 *    writes no coverage at all unless asked — kragg asks.
 *  - **node --test**: lcov. Node's five built-in reporters are `spec`, `dot`,
 *    `tap`, `junit`, `lcov`; there is no JSON one and no way to get istanbul
 *    JSON out of it. kragg pairs a `tap` reporter (results, to stdout) with an
 *    `lcov` reporter (coverage, to a file) in one run.
 *  - **bun test**: lcov. bun's coverage reporters are `text` and `lcov`, full
 *    stop.
 *
 * `support/lcov.ts` exists because of the last two. Nothing here pretends a
 * JSON coverage path exists where it does not.
 */

import { mkdirSync } from "node:fs";

import type { LineCoverageReport } from "../coverage/model.ts";
import type { CompletedCommand, Violation } from "../engine/models.ts";
import { runCommand } from "../engine/runner.ts";
import type { ProjectEnvironment } from "../environment/project.ts";
import type { TypeScriptApi } from "../analysis/sourceFile.ts";
import { sourceInventory } from "../coverage/inventory.ts";
import { projectTotals, readCoverageReport } from "./support/coverage.ts";
import type { ProjectTotals } from "./support/coverage.ts";
import type { TestRunnerChoice, TestRunnerName } from "./support/detect.ts";
import type { JsonObject } from "./support/json.ts";
import { readLcov } from "./support/lcov.ts";
import { parseBunTest } from "./support/bunTestReport.ts";
import { parseNodeTap } from "./support/nodeTestReport.ts";
import { parseVitestJson } from "./support/vitestReport.ts";
import { readTextFile } from "./support/manifest.ts";
import { EMPTY_SUMMARY } from "./support/testReport.ts";
import type { TestReport, TestSummary } from "./support/testReport.ts";
import { capped, crashed } from "./support/outcome.ts";
import type { Unavailable } from "./support/outcome.ts";
import { runOptions } from "./support/run.ts";
import {
  artifacts,
  buildCommand,
  createRunDir,
  discardRunDir,
  publishCoverage,
} from "./support/testCommands.ts";
import type { Artifacts } from "./support/testCommands.ts";
import {
  belowThreshold,
  COVERAGE_ADVICE,
  coverageLine,
  crashMessage,
  killedMessage,
  noTestsMessage,
  runnerReportedFailure,
} from "./support/testEvidence.ts";
import { invocationNote, resolveInvocation, runnerMissing } from "./support/testInvocation.ts";
import type { Invocation } from "./support/testInvocation.ts";

/** Gate name, matching the Python gate this replaces. */
export const TEST_GATE = "test-coverage";

/** `code` for the coverage threshold, distinct from any test failure. */
export { COVERAGE_BELOW_THRESHOLD, RUNNER_REPORTED_FAILURE } from "./support/testEvidence.ts";

/**
 * Everything one invocation of the suite needs.
 *
 * `choice` and `testPaths` are REQUIRED, and that is the point: they are the
 * two settings that decide WHICH runner runs WHICH files, and an optional
 * field is a field a caller can forget. `kragg flaky --rerun` forgot both —
 * it re-ran the suite under whatever runner inference happened to pick, over
 * a selection `node --test` cannot expand — and then reported the resulting
 * non-suite as evidence that nothing was flaky. Every caller now has to say
 * what it is running, in the same words the policy uses.
 */
export interface TestRunnerOptions {
  readonly env: ProjectEnvironment;
  /** `test_runner` policy setting; `"auto"` to infer. */
  readonly choice: TestRunnerChoice;
  /** `coverage_fail_under`. Zero or less disables coverage entirely. */
  readonly coverageFailUnder: number;
  /** `coverage_report_path`, relative to the project root. */
  readonly coverageReportPath?: string | undefined;
  /** `max_violations_per_gate`. */
  readonly maxViolations: number;
  /**
   * `test_paths` policy setting. Each entry is a directory or a pattern;
   * `util/testPaths.ts` turns both into what `node --test` discovers with,
   * and the other runners discover their own files and ignore it.
   */
  readonly testPaths: readonly string[];
  /**
   * `test_command`: the argv this project's suite is actually run with,
   * without file patterns. Empty (the default) means kragg infers the runner
   * and builds the argv itself — see `support/testInvocation.ts` for why the
   * two are not the same thing.
   */
  readonly testCommand?: readonly string[] | undefined;
  readonly timeoutMs?: number | undefined;
  /**
   * Policy `source_paths`: the files the coverage number is reconciled
   * against. Only files under them count, and a source file the run never
   * loaded counts as uncovered — see `support/coverage.ts`, `projectTotals`.
   */
  readonly sourcePaths: readonly string[];
  /** Compiler used to count a never-loaded file's lines. Defaults to the project's own. */
  readonly api?: TypeScriptApi | undefined;
}

/**
 * The coverage document THIS run produced, in the format its runner writes.
 *
 * Handed to the gates that depend on coverage (`critical-coverage`) so they
 * consume what this invocation measured and never re-read a path on disk —
 * which, after a runner switch, holds the other runner's older format.
 */
export type CoverageEvidence =
  | { readonly format: "istanbul"; readonly raw: JsonObject }
  | { readonly format: "lcov"; readonly report: LineCoverageReport };

/** Coverage was measured, or could not be. Never silently absent. */
export type CoverageOutcome =
  | {
      readonly ok: true;
      readonly totals: ProjectTotals;
      readonly reportPath: string;
      readonly violation: Violation | undefined;
      readonly evidence: CoverageEvidence;
    }
  | { readonly ok: false; readonly message: string };

/** The runner ran and produced a report we could read. */
export interface TestRunFindings {
  readonly ok: true;
  readonly runner: TestRunnerName;
  /** What decided the invocation: `test_command`, or what detection read. */
  readonly source: string;
  readonly command: readonly string[];
  readonly summary: TestSummary;
  /** Capped for display; test failures first, then coverage. */
  readonly violations: readonly Violation[];
  readonly violationCount: number;
  /** `null` when `coverageFailUnder <= 0` — coverage was not asked for. */
  readonly coverage: CoverageOutcome | null;
  readonly passed: boolean;
  /**
   * The runner ran, but what came back is not evidence. Exit 3, with any test
   * failures still listed. Two causes:
   *
   *  - coverage was asked for and no usable artifact came back. `passed:
   *    false` alone would say "coverage is below the floor" about a number
   *    that was never measured;
   *  - the run discovered NO TESTS. `passed: true` there is the false green
   *    this gate exists to prevent — nothing was executed, so nothing was
   *    verified, and "0 failed" is arithmetic rather than evidence.
   */
  readonly error: boolean;
  readonly output: string;
}

export type TestRunOutcome = TestRunFindings | Unavailable;

/** Detect, run, parse. See the module docs for every judgement call. */
export async function runTests(options: TestRunnerOptions): Promise<TestRunOutcome> {
  const { env } = options;
  const invocation = resolveInvocation({
    env,
    choice: options.choice,
    testCommand: options.testCommand ?? [],
  });
  if (!invocation.ok) {
    return invocation;
  }
  const runDir = createRunDir(env.root);
  if (!runDir.ok) {
    return runDir;
  }
  const layout = artifacts(env.root, options.coverageReportPath, runDir.dir);
  try {
    return await runInto(layout, invocation, options);
  } finally {
    discardRunDir(layout);
  }
}

/** Spawn the runner into `layout.runDir` and read back only what it wrote there. */
async function runInto(
  layout: Artifacts,
  invocation: Invocation,
  options: TestRunnerOptions,
): Promise<TestRunOutcome> {
  const { runner } = invocation;
  const withCoverage = options.coverageFailUnder > 0;
  if (withCoverage) {
    mkdirIgnoringErrors(layout.coverageDir);
  }
  const command = buildCommand(
    invocation.prefix,
    runner,
    layout,
    withCoverage,
    options.testPaths,
  );
  const result = await runCommand(TEST_GATE, command, layout.root, runOptions(options.timeoutMs));

  const environmentFailure = runnerMissing(options.env, TEST_GATE, runner, result);
  if (environmentFailure !== undefined) {
    return environmentFailure;
  }
  if (result.killed === true) {
    return crashed(killedMessage(runner, options.timeoutMs, result));
  }
  const report = parseResults(runner, result, layout);
  if (report === undefined) {
    return crashed(crashMessage(runner, result, layout));
  }

  const coverage = withCoverage ? readCoverage(runner, layout, options) : null;
  const published = coverage?.ok === true ? publishCoverage(layout, runner) : undefined;
  // The runner's own verdict, which its report does not carry: see
  // `runnerReportedFailure`. kragg asked for no threshold, but the runner still
  // read the project's own configuration and may have failed the run on it.
  const runnerFailure = runnerReportedFailure(runner, result, report, coverage?.ok === true);
  return assemble({ invocation, command, report, coverage, published, runnerFailure, options });
}

/** Parse whichever format the runner produced. `undefined` means unreadable. */
function parseResults(
  runner: TestRunnerName,
  result: CompletedCommand,
  layout: Artifacts,
): TestReport | undefined {
  if (runner === "vitest") {
    // The report file is authoritative; stdout is the fallback for a vitest
    // whose `--outputFile` handling differs. Both are this run's: the file
    // lives in the run directory and stdout came from the process just run.
    const fromFile = readTextFile(layout.reportFile);
    return (
      (fromFile === undefined ? undefined : parseVitestJson(fromFile, layout.root)) ??
      parseVitestJson(result.stdout, layout.root)
    );
  }
  if (runner === "node") {
    return parseNodeTap(result.stdout, layout.root) ?? parseNodeTap(result.stderr, layout.root);
  }
  return parseBunTest(`${result.stdout}\n${result.stderr}`, result.returncode);
}

/** What a coverage read yields: the line model plus the document to share. */
type CoverageRead =
  | {
      readonly ok: true;
      readonly report: LineCoverageReport;
      readonly evidence: CoverageEvidence;
    }
  | { readonly ok: false; readonly message: string };

/** Read the artifact this runner writes, from this run's directory only. */
function readCoverageArtifact(runner: TestRunnerName, layout: Artifacts): CoverageRead {
  if (runner === "vitest") {
    const read = readCoverageReport(layout.istanbulFile);
    return read.ok
      ? { ok: true, report: read.report, evidence: { format: "istanbul", raw: read.report.raw } }
      : read;
  }
  const read = readLcov(layout.lcovFile);
  return read.ok
    ? { ok: true, report: read.report, evidence: { format: "lcov", report: read.report } }
    : read;
}

/**
 * Read whichever coverage artifact this runner writes, and apply the floor.
 *
 * The number is the PROJECT's, not the report's: `projectTotals` restricts
 * it to `source_paths` and adds every source file the run never loaded with
 * all of its statement lines uncovered. A report that leaves no line to count
 * under the source paths is not 100%; it is coverage that was not collected
 * for this project, and it is reported as such — `percent()`'s 100 here would
 * be the most misleading number this gate could produce.
 */
function readCoverage(
  runner: TestRunnerName,
  layout: Artifacts,
  options: TestRunnerOptions,
): CoverageOutcome {
  const read = readCoverageArtifact(runner, layout);
  if (!read.ok) {
    return {
      ok: false,
      message:
        `no complete coverage report for this run — ${read.message}\n` +
        `${COVERAGE_ADVICE[runner]}`,
    };
  }
  const inventory = sourceInventory(layout.root, options.sourcePaths, options.api);
  const totals = projectTotals(read.report, layout.root, options.sourcePaths, inventory);
  if (totals.totalLines === 0) {
    return {
      ok: false,
      message:
        `${read.report.reportPath} measured no executable lines under ` +
        `${options.sourcePaths.join(", ")} (${totals.reportFiles} files in the report, ` +
        `${totals.measuredFiles} of them under the source paths; ${totals.sourceFiles} ` +
        `source files on disk). ${COVERAGE_ADVICE[runner]}`,
    };
  }
  const failUnder = options.coverageFailUnder;
  return {
    ok: true,
    totals,
    reportPath: read.report.reportPath,
    violation: totals.pct < failUnder ? belowThreshold(totals, failUnder) : undefined,
    evidence: read.evidence,
  };
}

/** Everything one completed run produced, before it becomes an outcome. */
interface Assembly {
  readonly invocation: Invocation;
  readonly command: readonly string[];
  readonly report: TestReport;
  readonly coverage: CoverageOutcome | null;
  readonly published: string | undefined;
  /** The runner failed the run on a threshold of its own. Usually `undefined`. */
  readonly runnerFailure: Violation | undefined;
  readonly options: TestRunnerOptions;
}

/**
 * Combine test failures, kragg's coverage floor and the runner's own verdict.
 *
 * The three stay SEPARATE VIOLATIONS with separate codes, in that order: a
 * reader has to be able to tell "your tests fail" from "kragg's line-coverage
 * floor was missed" from "the runner you drive failed its own thresholds",
 * because the three need different work. The last one can only exist when the
 * first two produced nothing (see `runnerReportedFailure`), so it is never
 * pushed out of a capped list.
 */
function assemble(parts: Assembly): TestRunFindings {
  const { invocation, report, coverage, options } = parts;
  const coverageViolation = coverage?.ok === true ? coverage.violation : undefined;
  const violations = [
    ...report.violations,
    ...(coverageViolation === undefined ? [] : [coverageViolation]),
    ...(parts.runnerFailure === undefined ? [] : [parts.runnerFailure]),
  ];
  // A coverage artifact kragg could not read is NOT a pass: the gate was asked
  // to enforce a floor and could not, which is the "reports green without
  // checking" failure the whole project exists to prevent. Nor is it a plain
  // failure — the tests ran and their verdict stands, and exit 1 would send
  // someone to raise a coverage number that was never measured. It is an
  // ERROR with the test results kept: see `TestRunFindings.error`.
  const coverageUsable = coverage === null || coverage.ok;
  // The same rule, applied to the suite itself: a run that discovered nothing
  // executed nothing, so its "0 failed" is not a finding about the code.
  const discoveredNothing = report.summary.total === 0;
  const note = invocationNote(invocation, parts.command);
  return {
    ok: true,
    runner: invocation.runner,
    source: invocation.source,
    command: parts.command,
    summary: report.summary,
    violations: capped(violations, options.maxViolations),
    violationCount: violations.length,
    coverage,
    passed: report.success && violations.length === 0 && coverageUsable && !discoveredNothing,
    error: !coverageUsable || discoveredNothing,
    output: describe(parts, note, discoveredNothing),
  };
}

/**
 * The headline: what ran, the counts, the coverage number, any publishing note.
 *
 * THE INVOCATION COMES FIRST and is never omitted. It is the difference
 * between "your tests fail" and "the command kragg assembled is not the
 * command your project runs", and a reader who cannot see the argv has no way
 * to tell those apart — see `support/testInvocation.ts`.
 *
 * The unavailable branches keep their messages WHOLE. Those branches are
 * ERRORS, and an error's remediation reaches the reader only through this
 * output.
 */
function describe(assembly: Assembly, note: string, discoveredNothing: boolean): string {
  const { report, coverage, published } = assembly;
  if (discoveredNothing) {
    return noTestsMessage(assembly.invocation.runner, note, assembly.options.testPaths);
  }
  const summary: TestSummary = report.summary;
  const parts = [
    note,
    `${summary.total} tests: ${summary.passed} passed, ${summary.failed} failed` +
      (summary.skipped > 0 ? `, ${summary.skipped} skipped` : "") +
      (summary.todo > 0 ? `, ${summary.todo} todo` : ""),
  ];
  if (coverage !== null) {
    parts.push(
      coverage.ok ? coverageLine(coverage.totals) : `coverage unavailable — ${coverage.message}`,
    );
  }
  if (published !== undefined) {
    parts.push(`note: ${published}`);
  }
  return parts.join("\n");
}

/** Best-effort mkdir. A failure surfaces later as a missing artifact. */
function mkdirIgnoringErrors(path: string): void {
  try {
    mkdirSync(path, { recursive: true });
  } catch {
    // The runner will fail to write there and the coverage read will report a
    // missing artifact, which is a better message than a raw EACCES here.
  }
}

/** Re-exported so a gate can render an empty summary for a skipped run. */
export { EMPTY_SUMMARY };
