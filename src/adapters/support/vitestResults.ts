/**
 * Everything a vitest run leaves for the gate: its json report, and the errors
 * it caught outside any test, which the json report has no field for.
 *
 * ── AN UNHANDLED ERROR IS THE RUNNER'S FINDING, NOT MISSING EVIDENCE ──────
 * vitest fails a run on an unhandled error (`process.exitCode = 1`) as surely
 * as on a failing test; it just records the verdict nowhere the json report
 * reaches. kragg's own reporter (`vitestReporter.ts`) writes the list into the
 * run directory, and this module turns each entry into a violation under
 * `RUNNER_UNHANDLED_ERROR`, after the test failures, with the report's verdict
 * set to failed. The gate FAILS on it — exit 1, not 3: vitest ran to the end
 * and said what went wrong, so this is a finding, and it holds with coverage
 * off too, where a non-zero exit over a passing report used to read as a pass.
 *
 * Only a run vitest FAILED is read. vitest still hands reporters the list when
 * the project sets `dangerouslyIgnoreUnhandledErrors`, and then exits 0; that
 * is the project's own, explicit opt-out, and kragg keeps the runner's verdict.
 *
 * ── WHERE IT POINTS ────────────────────────────────────────────────────────
 * The violation's location is the first stack frame inside `source_paths`:
 * the project's own code that threw — in clavis, `captureFocus` reading a
 * `document` the test had already unstubbed — rather than the timer machinery
 * or the test that happened to be running. A stack with no frame there falls
 * back to its first frame outside `node_modules`, and then to the test file
 * vitest named. That test is quoted in the message as what it is: the one
 * running when vitest caught the error, which need not be the one that
 * started the timer.
 */

import type { CompletedCommand, Violation } from "../../engine/models.ts";
import { asArray, asBoolean, asString, isJsonObject, objectsIn, parseJson } from "./json.ts";
import { readTextFile } from "./manifest.ts";
import type { Artifacts } from "./testCommands.ts";
import { condense, relativeToRoot, stackFrames } from "./testReport.ts";
import type { StackLocation, TestReport } from "./testReport.ts";
import { parseVitestJson } from "./vitestReport.ts";
import type { UnhandledErrorRecord } from "./vitestReporter.ts";

/** `code` for an error vitest caught outside any test and failed the run on. */
export const RUNNER_UNHANDLED_ERROR = "runner-unhandled-error";

/**
 * This run's vitest verdict: the json report, plus every unhandled error the
 * process failed on. `undefined` when there is no readable json report.
 */
export function readVitestResults(
  result: CompletedCommand,
  layout: Artifacts,
  sourcePaths: readonly string[],
): TestReport | undefined {
  // The report file is authoritative; stdout is the fallback for a vitest
  // whose `--outputFile` handling differs. Both are this run's: the file
  // lives in the run directory and stdout came from the process just run.
  const fromFile = readTextFile(layout.reportFile);
  const report =
    (fromFile === undefined ? undefined : parseVitestJson(fromFile, layout.root)) ??
    parseVitestJson(result.stdout, layout.root);
  if (report === undefined || result.returncode === 0) {
    return report;
  }
  const unhandled = readUnhandledErrors(layout.unhandledErrorsFile).map((error) =>
    unhandledErrorViolation(error, layout.root, sourcePaths),
  );
  return unhandled.length === 0
    ? report
    : { ...report, violations: [...report.violations, ...unhandled], success: false };
}

/**
 * What kragg's reporter wrote, or nothing.
 *
 * An absent or unreadable file is NO ENTRIES rather than an error: the
 * reporter runs inside vitest and is built never to throw, so a missing file
 * means it could not write, and the non-zero exit is still there for
 * `runnerReportedFailure` (`testEvidence.ts`) to read. Fields are read one by
 * one, so an entry missing one loses that detail and keeps the finding.
 */
function readUnhandledErrors(path: string): readonly UnhandledErrorRecord[] {
  const text = readTextFile(path);
  const parsed = text === undefined ? undefined : parseJson(text);
  if (!isJsonObject(parsed)) {
    return [];
  }
  return objectsIn(asArray(parsed, "errors")).map((entry) => ({
    name: asString(entry, "name") ?? "",
    message: asString(entry, "message") ?? "",
    stack: asString(entry, "stack") ?? "",
    type: asString(entry, "type") ?? "",
    testPath: asString(entry, "testPath") ?? "",
    testName: asString(entry, "testName") ?? "",
    afterTeardown: asBoolean(entry, "afterTeardown") ?? false,
  }));
}

/** One unhandled error -> a pointer at the code that threw, and what to do. */
function unhandledErrorViolation(
  error: UnhandledErrorRecord,
  root: string,
  sourcePaths: readonly string[],
): Violation {
  const testFile = error.testPath === "" ? undefined : relativeToRoot(error.testPath, root);
  const where = throwSite(error.stack, root, sourcePaths);
  const kind = error.type === "" ? "an unhandled error" : `an unhandled error (${error.type})`;
  const thrown = condense([error.name, error.message].filter((part) => part !== "").join(": "));
  return {
    message:
      `vitest failed the run on ${kind} it caught outside any test: ` +
      `${thrown === "" ? "no message" : thrown}${caughtWhile(error, testFile)}`,
    file: where?.file ?? testFile,
    line: where?.line,
    column: where?.column,
    code: RUNNER_UNHANDLED_ERROR,
    fixHint:
      "something a test started — a timer, a promise, a listener — outlived it and threw: " +
      "await or cancel it before the test ends (fake timers flushed with " +
      "`vi.advanceTimersByTimeAsync`, or cleanup in `afterEach`)" +
      (testFile === undefined
        ? ""
        : `. The test named is the one vitest was running, not necessarily the one that ` +
          `started it; re-run alone: vitest run ${testFile}`),
  };
}

/** Where vitest was when it caught the error, in vitest's own terms. */
function caughtWhile(error: UnhandledErrorRecord, testFile: string | undefined): string {
  if (testFile === undefined) {
    return "";
  }
  if (error.afterTeardown) {
    return ` — caught after the test environment of ${testFile} was torn down`;
  }
  return error.testName === ""
    ? ` — caught while ${testFile} was running`
    : ` — caught while "${error.testName}" in ${testFile} was running`;
}

/**
 * The first frame inside `source_paths`, else the first outside `node_modules`.
 *
 * Paths are compared project-relative with `/` separators, the way
 * `source_paths` is written, so a Windows stack matches too.
 */
function throwSite(
  stack: string,
  root: string,
  sourcePaths: readonly string[],
): StackLocation | undefined {
  const prefixes = sourcePaths.map((path) => `${path.replace(/[/\\]+$/u, "")}/`);
  const frames = stackFrames(stack)
    .filter((frame) => !frame.file.includes("node_modules"))
    .map((frame) => ({ ...frame, file: relativeToRoot(frame.file, root) }));
  const inSource = frames.find((frame) => {
    const file = frame.file.replaceAll("\\", "/");
    return prefixes.some((prefix) => file.startsWith(prefix));
  });
  return inSource ?? frames[0];
}
