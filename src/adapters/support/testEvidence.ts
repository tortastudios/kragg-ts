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
 */

import { statSync } from "node:fs";

import type { CompletedCommand } from "../../engine/models.ts";
import { testRunnerPatterns } from "../../util/testPaths.ts";
import type { TestRunnerName } from "./detect.ts";
import type { Artifacts } from "./testCommands.ts";

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
