/**
 * Parser for `vitest run --reporter=json`.
 *
 * SCHEMA PROVENANCE — verified, not assumed. Read directly out of an installed
 * vitest **3.2.7** (`dist/chunks/reporters.d.*.d.ts` for the types and the
 * `JsonReporter` class in `dist/chunks/index.*.js` for what actually gets
 * written). The reporter's own comment states its contract:
 *
 *   "for compatibility reasons, the reporter produces a JSON similar to the
 *    one produced by the Jest JSON reporter"
 *
 * so this parser also handles jest's output, and is stable across vitest
 * majors precisely because the format is frozen by that compatibility promise.
 *
 *     interface JsonTestResults {
 *       numFailedTests, numFailedTestSuites, numPassedTests,
 *       numPassedTestSuites, numPendingTests, numPendingTestSuites,
 *       numTodoTests, numTotalTests, numTotalTestSuites: number
 *       startTime: number
 *       success: boolean
 *       testResults: JsonTestResult[]
 *       snapshot: SnapshotSummary
 *       coverageMap?: CoverageMap | null
 *     }
 *     interface JsonTestResult {
 *       message: string          // file-level error, "" when there is none
 *       name: string             // ABSOLUTE path — `file.filepath`
 *       status: "failed" | "passed"
 *       startTime, endTime: number
 *       assertionResults: JsonAssertionResult[]
 *     }
 *     interface JsonAssertionResult {
 *       ancestorTitles: string[]
 *       fullName, title: string
 *       status: "passed"|"failed"|"skipped"|"pending"|"todo"|"disabled"
 *       meta: TaskMeta
 *       duration?: number | null
 *       failureMessages: string[] | null   // each is `error.stack ?? error.message`
 *       location?: { line, column } | null
 *     }
 *
 * TWO NON-OBVIOUS FACTS, both verified in the same source and both acted on by
 * `adapters/testRunner.ts`:
 *
 *  1. `location` is only populated when `includeTaskLocation` is on, and the
 *     JSON reporter does NOT turn it on — only the UI/html reporters and
 *     line-number filters do. The runner passes `--includeTaskLocation`
 *     explicitly, and this parser falls back to the stack trace when it is
 *     absent anyway.
 *  2. `writeReport` logs the document through vitest's normal logger when no
 *     `--outputFile` is set, interleaved with everything else on stdout. The
 *     runner always passes `--outputFile`; `extractJson` is the belt-and-
 *     braces fallback for a stdout read.
 */

import type { Violation } from "../../engine/models.ts";
import {
  asArray,
  asCount,
  asNumber,
  asObject,
  asString,
  extractJson,
  isJsonObject,
  objectsIn,
  stringsIn,
} from "./json.ts";
import type { JsonObject } from "./json.ts";
import { condense, relativeToRoot, stackLocation } from "./testReport.ts";
import type { TestReport, TestSummary } from "./testReport.ts";

/** `code` for a test that ran and failed its assertions. */
export const TEST_FAILED = "test-failed";

/**
 * `code` for a whole test FILE that failed outside any test — most often a
 * failed import.
 *
 * This is the JavaScript analogue of the subtlety `_is_tool_module` guards in
 * `catalog.py`: a module that will not import inside the test runner is a TEST
 * failure, not a broken environment, and it must be reported as a finding the
 * project can fix rather than as "kragg could not run". Keeping it under its
 * own code makes the two visibly different in the report.
 */
export const SUITE_ERROR = "test-suite-error";

/**
 * Parse vitest's JSON report.
 *
 * Returns `undefined` — never throws — when the text is not a vitest report:
 * malformed, truncated, empty, or valid JSON of some other shape. The caller
 * turns that into a tool-crash message carrying the runner's raw output,
 * because a report we cannot read tells us nothing about whether the tests
 * passed.
 */
export function parseVitestJson(text: string, root: string): TestReport | undefined {
  const parsed = extractJson(text);
  if (!isJsonObject(parsed) || !looksLikeVitestReport(parsed)) {
    return undefined;
  }
  const violations: Violation[] = [];
  let failedFiles = 0;
  for (const file of objectsIn(asArray(parsed, "testResults"))) {
    const before = violations.length;
    collectFileViolations(file, root, violations);
    if (violations.length > before) {
      failedFiles += 1;
    }
  }
  return {
    summary: summarize(parsed, failedFiles),
    violations,
    success: successOf(parsed, violations.length),
  };
}

/**
 * Reject a JSON document that is merely JSON.
 *
 * Requires the two fields no other tool's output carries together. Without
 * this a `{}` — or some unrelated tool's report — would parse into a summary
 * of zero tests, zero failures and `success: true`: a green gate built from a
 * document that never described a test run.
 */
function looksLikeVitestReport(parsed: JsonObject): boolean {
  return asNumber(parsed, "numTotalTests") !== undefined && Array.isArray(parsed["testResults"]);
}

/**
 * The run's verdict.
 *
 * `success` is authoritative when present — vitest computes it as
 * `(files.length > 0 || passWithNoTests) && no failed suites && no failed
 * tests`, which correctly fails a run that matched NO TEST FILES even though
 * its failure count is zero. A report missing the field falls back to "no
 * violations", which is the conservative reading of a document we only
 * partly understand.
 */
function successOf(parsed: JsonObject, violationCount: number): boolean {
  const success = parsed["success"];
  return typeof success === "boolean" ? success : violationCount === 0;
}

function summarize(parsed: JsonObject, failedFiles: number): TestSummary {
  return {
    total: asCount(parsed, "numTotalTests") ?? 0,
    passed: asCount(parsed, "numPassedTests") ?? 0,
    failed: asCount(parsed, "numFailedTests") ?? 0,
    skipped: asCount(parsed, "numPendingTests") ?? 0,
    todo: asCount(parsed, "numTodoTests") ?? 0,
    failedFiles,
  };
}

/** Violations for one test file: its assertion failures, then its own error. */
function collectFileViolations(file: JsonObject, root: string, into: Violation[]): void {
  const absolute = asString(file, "name") ?? "";
  const relativePath = absolute === "" ? undefined : relativeToRoot(absolute, root);

  for (const assertion of objectsIn(asArray(file, "assertionResults"))) {
    if (asString(assertion, "status") !== "failed") {
      continue;
    }
    into.push(assertionViolation(assertion, relativePath));
  }

  const fileError = asString(file, "message") ?? "";
  const fileFailed = asString(file, "status") === "failed";
  if (fileFailed && fileError.trim() !== "" && !hasFailedAssertion(file)) {
    into.push(suiteViolation(fileError, relativePath, root));
  }
}

function hasFailedAssertion(file: JsonObject): boolean {
  return objectsIn(asArray(file, "assertionResults")).some(
    (assertion) => asString(assertion, "status") === "failed",
  );
}

/** One failed test -> one pointer plus the command that re-runs just it. */
function assertionViolation(assertion: JsonObject, file: string | undefined): Violation {
  const name = testName(assertion);
  const messages = stringsIn(asArray(assertion, "failureMessages"));
  const detail = condense(messages[0] ?? "");
  const where = position(assertion, messages[0] ?? "", file);
  return {
    message: detail === "" ? `${name} failed` : `${name} — ${detail}`,
    file,
    line: where?.line,
    column: where?.column,
    code: TEST_FAILED,
    fixHint:
      file === undefined
        ? undefined
        : `re-run alone: vitest run ${file} -t ${quote(name)}`,
  };
}

/**
 * A test file that failed before or outside its tests.
 *
 * Reported against the FILE with no test name, because there is no test to
 * name: the suite never got far enough to define one. The fix hint re-runs the
 * file rather than a test within it.
 */
function suiteViolation(message: string, file: string | undefined, root: string): Violation {
  const where = stackLocation(message, file);
  return {
    message: `test file failed to run — ${condense(message)}`,
    file: file ?? (where === undefined ? undefined : relativeToRoot(where.file, root)),
    line: where?.line,
    column: where?.column,
    code: SUITE_ERROR,
    fixHint:
      file === undefined
        ? "the test file itself failed; fix the import or top-level code it runs"
        : `re-run alone: vitest run ${file}`,
  };
}

/**
 * `fullName` when vitest set one, else the bare title, else a placeholder.
 *
 * TRIMMED, and that is not cosmetic. vitest builds `fullName` as
 * `[...ancestorTitles, title].join(" ")`, and the outermost ancestor of a
 * top-level suite is the empty string — so almost every `fullName` arrives
 * with a LEADING SPACE. Passing that straight into `-t '<name>'` produces a
 * re-run command that matches nothing, which is worse than offering no command
 * at all: it looks like the test cannot be reproduced.
 */
function testName(assertion: JsonObject): string {
  const full = (asString(assertion, "fullName") ?? "").trim();
  if (full !== "") {
    return full;
  }
  const title = (asString(assertion, "title") ?? "").trim();
  return title === "" ? "<unnamed test>" : title;
}

/** A `line:column` inside a file already known from elsewhere. */
interface SourcePosition {
  readonly line: number;
  readonly column: number;
}

/**
 * Where to point: vitest's own `location` first, the stack trace second.
 *
 * `location` is the DEFINITION site of the test, which is where someone edits;
 * the stack's top frame is the assertion that blew up, which is usually inside
 * it. Either is useful, the definition site is more stable, so it wins when
 * present — and it is only present with `--includeTaskLocation`.
 */
function position(
  assertion: JsonObject,
  failureMessage: string,
  file: string | undefined,
): SourcePosition | undefined {
  const location = asObject(assertion, "location");
  const line = location === undefined ? undefined : asCount(location, "line");
  const column = location === undefined ? undefined : asCount(location, "column");
  if (line !== undefined && line > 0) {
    return { line, column: column ?? 1 };
  }
  const fromStack = stackLocation(failureMessage, file);
  return fromStack === undefined
    ? undefined
    : { line: fromStack.line, column: fromStack.column };
}

/**
 * Quote a test name for a shell the reader will paste into.
 *
 * kragg never runs this string — `runCommand` takes an argv array and spawns
 * with `shell: false` — but a HUMAN or an agent will paste it, so an unquoted
 * name containing a space or a quote would produce a command that does the
 * wrong thing. Single quotes with the standard `'\''` escape are literal in
 * every POSIX shell.
 */
function quote(name: string): string {
  return `'${name.replaceAll("'", "'\\''")}'`;
}
