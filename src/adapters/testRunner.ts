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
import { dirname } from "node:path";

import type { Violation } from "../engine/models.ts";
import { runCommand } from "../engine/runner.ts";
import {
  missingTool as missingToolName,
  missingToolMessage,
  remediation,
} from "../environment/project.ts";
import type { ProjectEnvironment } from "../environment/project.ts";
import { coverageTotals, readCoverageReport } from "./support/coverage.ts";
import type { CoverageTotals } from "./support/coverage.ts";
import { detectTestRunner } from "./support/detect.ts";
import type { RunnerDetection, TestRunnerChoice, TestRunnerName } from "./support/detect.ts";
import { readLcov } from "./support/lcov.ts";
import { parseBunTest } from "./support/bunTestReport.ts";
import { parseNodeTap } from "./support/nodeTestReport.ts";
import { parseVitestJson } from "./support/vitestReport.ts";
import { readTextFile } from "./support/manifest.ts";
import { EMPTY_SUMMARY } from "./support/testReport.ts";
import type { TestReport, TestSummary } from "./support/testReport.ts";
import { capped, crashed, missingTool, notConfigured } from "./support/outcome.ts";
import type { Unavailable } from "./support/outcome.ts";
import { runOptions } from "./support/run.ts";
import { artifacts, buildCommand, resolveRunner } from "./support/testCommands.ts";
import type { Artifacts } from "./support/testCommands.ts";

/** Gate name, matching the Python gate this replaces. */
export const TEST_GATE = "test-coverage";

/** `code` for the coverage threshold, distinct from any test failure. */
export const COVERAGE_BELOW_THRESHOLD = "coverage-below-threshold";

export interface TestRunnerOptions {
  readonly env: ProjectEnvironment;
  /** `test_runner` policy setting. Defaults to `"auto"`. */
  readonly choice?: TestRunnerChoice | undefined;
  /** `coverage_fail_under`. Zero or less disables coverage entirely. */
  readonly coverageFailUnder: number;
  /** `coverage_report_path`, relative to the project root. */
  readonly coverageReportPath?: string | undefined;
  /** `max_violations_per_gate`. */
  readonly maxViolations: number;
  /** Paths passed to `node --test`; ignored by the other runners. */
  readonly testPatterns?: readonly string[] | undefined;
  readonly timeoutMs?: number | undefined;
}

/** Coverage was measured, or could not be. Never silently absent. */
export type CoverageOutcome =
  | {
      readonly ok: true;
      readonly totals: CoverageTotals;
      readonly reportPath: string;
      readonly violation: Violation | undefined;
    }
  | { readonly ok: false; readonly message: string };

/** The runner ran and produced a report we could read. */
export interface TestRunFindings {
  readonly ok: true;
  readonly runner: TestRunnerName;
  /** What decided the runner, from `detectTestRunner`. */
  readonly source: string;
  readonly command: readonly string[];
  readonly summary: TestSummary;
  /** Capped for display; test failures first, then coverage. */
  readonly violations: readonly Violation[];
  readonly violationCount: number;
  /** `null` when `coverageFailUnder <= 0` — coverage was not asked for. */
  readonly coverage: CoverageOutcome | null;
  readonly passed: boolean;
  readonly output: string;
}

export type TestRunOutcome = TestRunFindings | Unavailable;

/** Detect, run, parse. See the module docs for every judgement call. */
export async function runTests(options: TestRunnerOptions): Promise<TestRunOutcome> {
  const { env } = options;
  const detection = detectTestRunner(env.root, options.choice ?? "auto");
  if (detection.runner === undefined) {
    return notConfigured(skipReason(detection, env));
  }

  const layout = artifacts(env.root, options.coverageReportPath);
  const withCoverage = options.coverageFailUnder > 0;
  const resolved = resolveRunner(env, detection.runner);
  if (!resolved.ok) {
    return resolved;
  }

  mkdirIgnoringErrors(dirname(layout.reportFile));
  if (withCoverage) {
    mkdirIgnoringErrors(layout.coverageDir);
  }

  const command = buildCommand(
    resolved.bin,
    detection.runner,
    layout,
    withCoverage,
    options.testPatterns ?? [],
  );
  const result = await runCommand(TEST_GATE, command, env.root, runOptions(options.timeoutMs));

  const environmentFailure = runnerMissing(env, detection.runner, result.stdout, result.stderr);
  if (environmentFailure !== undefined) {
    return environmentFailure;
  }

  const report = parseResults(
    detection.runner,
    result.stdout,
    result.stderr,
    layout,
    env.root,
    result.returncode,
  );
  if (report === undefined) {
    return crashed(
      crashMessage(detection.runner, command, result.returncode, result.stdout, result.stderr),
    );
  }

  const coverage = withCoverage
    ? readCoverage(detection.runner, layout, options.coverageFailUnder)
    : null;
  return assemble(detection, command, report, coverage, options.maxViolations);
}

/** Parse whichever format the runner produced. `undefined` means unreadable. */
function parseResults(
  runner: TestRunnerName,
  stdout: string,
  stderr: string,
  layout: Artifacts,
  root: string,
  exitCode: number,
): TestReport | undefined {
  if (runner === "vitest") {
    // The report file is authoritative; stdout is the fallback for a vitest
    // whose `--outputFile` handling differs (or a run killed before it wrote).
    const fromFile = readTextFile(layout.reportFile);
    return (
      (fromFile === undefined ? undefined : parseVitestJson(fromFile, root)) ??
      parseVitestJson(stdout, root)
    );
  }
  if (runner === "node") {
    return parseNodeTap(stdout, root) ?? parseNodeTap(stderr, root);
  }
  return parseBunTest(`${stdout}\n${stderr}`, exitCode);
}

/**
 * Was the RUNNER ITSELF missing?
 *
 * The `_is_tool_module` twin. `missingToolName` reports whatever name the
 * output said could not be found; only when that name IS the runner does this
 * become an environment failure. A test file that cannot import
 * `./helpers.ts` produces the same class of message and is a test failure —
 * reported through the normal parse path, against the file that failed.
 */
function runnerMissing(
  env: ProjectEnvironment,
  runner: TestRunnerName,
  stdout: string,
  stderr: string,
): Unavailable | undefined {
  const missing = missingToolName({
    name: TEST_GATE,
    command: [],
    cwd: env.root,
    returncode: 127,
    stdout,
    stderr,
  });
  if (missing === null) {
    return undefined;
  }
  const binName = runner === "vitest" ? "vitest" : runner;
  if (missing !== binName && !missing.endsWith(`/${binName}`)) {
    return undefined;
  }
  if (runner === "vitest") {
    return missingTool(missingToolMessage(env, "vitest", "vitest"));
  }
  return missingTool(
    `${binName} could not be started, so no tests ran.\n` +
      (runner === "bun"
        ? "Install bun (https://bun.com) or set `test_runner` to a runner this project has."
        : "kragg runs `node --test` on its own interpreter; this should not happen.") +
      `\n${remediation(env.packageManager, binName)}`,
  );
}

/** Read whichever coverage artifact this runner writes, and apply the floor. */
function readCoverage(
  runner: TestRunnerName,
  layout: Artifacts,
  failUnder: number,
): CoverageOutcome {
  const read =
    runner === "vitest"
      ? readCoverageReport(layout.istanbulFile)
      : readLcov(layout.lcovFile);
  if (!read.ok) {
    return { ok: false, message: `${read.message}\n${COVERAGE_ADVICE[runner]}` };
  }
  const totals = coverageTotals(read.report);
  if (totals.totalLines === 0) {
    // A report with no measurable lines is not 100% coverage; it is coverage
    // that was not collected. Reporting `percent()`'s 100 here would be the
    // most misleading number this gate could produce.
    return {
      ok: false,
      message:
        `${read.report.reportPath} measured no executable lines. ` +
        `${COVERAGE_ADVICE[runner]}`,
    };
  }
  return {
    ok: true,
    totals,
    reportPath: read.report.reportPath,
    violation: totals.pct < failUnder ? belowThreshold(totals, failUnder) : undefined,
  };
}

const COVERAGE_ADVICE: Readonly<Record<TestRunnerName, string>> = {
  vitest:
    "vitest writes it via its `json` coverage reporter; check that " +
    "`coverage.provider` is installed (@vitest/coverage-v8 or -istanbul).",
  node: "node --test writes lcov via `--test-reporter=lcov`; coverage needs Node 20.1+.",
  bun: "bun test writes lcov via `--coverage-reporter=lcov`.",
};

function belowThreshold(totals: CoverageTotals, failUnder: number): Violation {
  return {
    message:
      `line coverage ${totals.pct}% is below the required ${failUnder}% ` +
      `(${totals.coveredLines}/${totals.totalLines} lines)`,
    code: COVERAGE_BELOW_THRESHOLD,
    fixHint: "run `kragg coverage` for the uncovered lines of the highest-fan-in functions",
  };
}

/** Combine test failures and coverage into one outcome. */
function assemble(
  detection: RunnerDetection,
  command: readonly string[],
  report: TestReport,
  coverage: CoverageOutcome | null,
  maxViolations: number,
): TestRunFindings {
  const coverageViolation = coverage?.ok === true ? coverage.violation : undefined;
  const violations = [
    ...report.violations,
    ...(coverageViolation === undefined ? [] : [coverageViolation]),
  ];
  // A coverage artifact kragg could not read is NOT a pass: the gate was asked
  // to enforce a floor and could not, which is the "reports green without
  // checking" failure the whole project exists to prevent.
  const coverageUsable = coverage === null || coverage.ok;
  return {
    ok: true,
    runner: detection.runner ?? "vitest",
    source: detection.source,
    command,
    summary: report.summary,
    violations: capped(violations, maxViolations),
    violationCount: violations.length,
    coverage,
    passed: report.success && violations.length === 0 && coverageUsable,
    output: describe(report.summary, coverage),
  };
}

/** The headline: counts, then the coverage number, on one line each. */
function describe(summary: TestSummary, coverage: CoverageOutcome | null): string {
  const parts = [
    `${summary.total} tests: ${summary.passed} passed, ${summary.failed} failed` +
      (summary.skipped > 0 ? `, ${summary.skipped} skipped` : "") +
      (summary.todo > 0 ? `, ${summary.todo} todo` : ""),
  ];
  if (coverage !== null) {
    parts.push(
      coverage.ok
        ? `line coverage ${coverage.totals.pct}% ` +
          `(${coverage.totals.coveredLines}/${coverage.totals.totalLines} lines)`
        : `coverage unavailable — ${coverage.message.split("\n")[0] ?? ""}`,
    );
  }
  return parts.join("\n");
}

/** Why no runner ran, with the commands that would make one available. */
function skipReason(detection: RunnerDetection, env: ProjectEnvironment): string {
  if (detection.source.startsWith("policy:")) {
    return `${detection.source} — the test gate is switched off in kragg.json`;
  }
  if (detection.unsupported !== undefined) {
    return (
      `this project's test script runs ${detection.unsupported}, which kragg does not ` +
      "drive yet. Nothing was checked — set `test_runner` explicitly if one of " +
      "vitest / node / bun can run this suite."
    );
  }
  return (
    "no test runner detected (looked at package.json#scripts.test, vitest.config.*, " +
    "a vitest dependency, and bunfig.toml). No tests were run, so nothing was verified.\n" +
    `${remediation(env.packageManager, "vitest @vitest/coverage-v8")}\n` +
    "or use Node's built-in runner: set `\"test\": \"node --test\"` in package.json."
  );
}

/** A runner that produced nothing readable. Never reported as a pass. */
function crashMessage(
  runner: TestRunnerName,
  command: readonly string[],
  returncode: number,
  stdout: string,
  stderr: string,
): string {
  return (
    `${runner} exited ${returncode} without a readable test report, so kragg ` +
    "cannot say whether the tests passed.\n" +
    `command: ${command.join(" ")}\n` +
    tail(`${stderr}\n${stdout}`.trim())
  );
}

/** The LAST lines of a crash: the cause is at the end, not the start. */
function tail(text: string, maxLines = 20): string {
  const lines = text.split("\n");
  return lines.length <= maxLines
    ? text
    : [`… ${lines.length - maxLines} earlier lines`, ...lines.slice(-maxLines)].join("\n");
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
