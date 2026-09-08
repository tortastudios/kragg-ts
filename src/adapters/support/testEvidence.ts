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
import {
  missingTool as missingToolName,
  missingToolMessage,
  remediation,
} from "../../environment/project.ts";
import type { ProjectEnvironment } from "../../environment/project.ts";
import type { ProjectTotals } from "./coverage.ts";
import type { RunnerDetection, TestRunnerName } from "./detect.ts";
import { missingTool } from "./outcome.ts";
import type { Unavailable } from "./outcome.ts";
import type { Artifacts } from "./testCommands.ts";

/** `code` for the coverage threshold, distinct from any test failure. */
export const COVERAGE_BELOW_THRESHOLD = "coverage-below-threshold";

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

/**
 * Was the RUNNER ITSELF missing?
 *
 * The `_is_tool_module` twin. `missingToolName` reports whatever name the
 * output said could not be found; only when that name IS the runner does this
 * become an environment failure. A test file that cannot import
 * `./helpers.ts` produces the same class of message and is a test failure —
 * reported through the normal parse path, against the file that failed.
 */
export function runnerMissing(
  gate: string,
  env: ProjectEnvironment,
  runner: TestRunnerName,
  stdout: string,
  stderr: string,
): Unavailable | undefined {
  const missing = missingToolName({
    name: gate,
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

/** Why no runner ran, with the commands that would make one available. */
export function skipReason(detection: RunnerDetection, env: ProjectEnvironment): string {
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
