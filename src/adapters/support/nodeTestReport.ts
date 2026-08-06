/**
 * Parser for `node --test --test-reporter=tap`.
 *
 * WHY TAP AND NOT JSON. Node's test runner has exactly five built-in
 * reporters — `spec`, `dot`, `tap`, `junit`, `lcov` — and **none of them is
 * JSON**. Node's own documentation says so and then says why it matters:
 *
 *   "The exact output of these reporters is subject to change between versions
 *    of Node.js, and should not be relied on programmatically. If programmatic
 *    access to the test runner's output is required, use the events emitted by
 *    the TestsStream."
 *
 * Using those events would mean loading a custom reporter module into the
 * project's test process — kragg injecting its own code into the run it is
 * meant to observe. TAP is the least-bad machine-readable option that keeps
 * kragg outside the process, and it is a documented format rather than a
 * pretty-printer's whim. This parser is therefore written DEFENSIVELY: it
 * takes what it recognises and reports honestly when it recognises nothing,
 * rather than assuming a layout.
 *
 * SHAPE (Node 20+ TAP 13 output):
 *
 *     TAP version 13
 *     # Subtest: adds numbers
 *     ok 1 - adds numbers
 *     # Subtest: fails
 *     not ok 2 - fails
 *       ---
 *       duration_ms: 1.2
 *       location: '/abs/test/math.test.js:12:1'
 *       failureType: 'testCodeFailure'
 *       error: 'Expected values to be strictly equal'
 *       code: 'ERR_ASSERTION'
 *       stack: |-
 *         TestContext.<anonymous> (/abs/test/math.test.js:13:3)
 *       ...
 *     1..2
 *     # tests 2
 *     # suites 0
 *     # pass 1
 *     # fail 1
 *     # cancelled 0
 *     # skipped 0
 *     # todo 0
 *
 * TWO THINGS THIS GETS RIGHT AND A NAIVE `not ok` GREP DOES NOT:
 *
 *  1. ROLLUPS ARE NOT FAILURES. A file whose subtests failed is itself
 *     reported `not ok`, with `failureType: 'subtestsFailed'`. Counting it
 *     would report every failure twice — once as itself and once as its
 *     parent — and the duplicate carries no location a reader can act on.
 *  2. `# SKIP` AND `# TODO` DIRECTIVES ARE NOT FAILURES. TAP spells a skipped
 *     test `not ok 3 - name # SKIP reason`. Treating the `not ok` as a failure
 *     turns every skipped test into a violation.
 */

import type { Violation } from "../../engine/models.ts";
import { condense, relativeToRoot, stackLocation } from "./testReport.ts";
import type { StackLocation, TestReport, TestSummary } from "./testReport.ts";

/** `code` for a test that ran and failed. Shared with the vitest parser. */
export const TEST_FAILED = "test-failed";

/** A `not ok` line plus the YAML diagnostic block that follows it. */
interface TapFailure {
  readonly name: string;
  readonly fields: ReadonlyMap<string, string>;
}

const NOT_OK = /^(\s*)not ok\s+\d+\s*-?\s*(.*)$/u;
const COUNT_LINE = /^#\s*(tests|pass|fail|skipped|todo|suites)\s+(\d+)\s*$/u;
const YAML_FIELD = /^\s*([A-Za-z_][\w]*):\s*(.*)$/u;
/** TAP directives: `# SKIP …`, `# TODO …`, case-insensitive per the spec. */
const DIRECTIVE = /#\s*(skip|todo)\b/iu;

/**
 * Parse node's TAP output.
 *
 * Returns `undefined` when the text is not TAP at all — no `TAP version` line
 * and no plan/count lines. That is the tool-crash signal: node printed
 * something else (a syntax error, a bad-option message), and a parser that
 * returned "zero failures" for it would report a green gate for a run that
 * never happened.
 */
export function parseNodeTap(text: string, root: string): TestReport | undefined {
  const lines = text.split("\n");
  if (!looksLikeTap(lines)) {
    return undefined;
  }
  const counts = readCounts(lines);
  const violations = readFailures(lines, root);
  return {
    summary: summarize(counts, violations.length),
    violations,
    success: verdict(counts, violations.length),
  };
}

/**
 * Recognise TAP without demanding a perfect document.
 *
 * Either the version header or a summary count line is enough: a run killed
 * partway through has the header and no counts, and a reporter that omits the
 * header still emits counts. Requiring both would discard usable output.
 */
function looksLikeTap(lines: readonly string[]): boolean {
  return lines.some(
    (line) => /^TAP version \d+/u.test(line.trim()) || COUNT_LINE.test(line.trim()),
  );
}

function readCounts(lines: readonly string[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const match = COUNT_LINE.exec(line.trim());
    const key = match?.[1];
    const value = match?.[2];
    if (key !== undefined && value !== undefined) {
      counts.set(key, Number.parseInt(value, 10));
    }
  }
  return counts;
}

/** Every real failure, in document order. */
function readFailures(lines: readonly string[], root: string): readonly Violation[] {
  const violations: Violation[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const failure = failureAt(lines, index);
    if (failure !== undefined && isRealFailure(failure)) {
      violations.push(toViolation(failure, root));
    }
  }
  return violations;
}

/** The `not ok` at `index` with its diagnostic block, if there is one. */
function failureAt(lines: readonly string[], index: number): TapFailure | undefined {
  const line = lines[index];
  if (line === undefined) {
    return undefined;
  }
  const match = NOT_OK.exec(line);
  const indent = match?.[1];
  const rest = match?.[2];
  if (indent === undefined || rest === undefined) {
    return undefined;
  }
  if (DIRECTIVE.test(rest)) {
    // `not ok N - name # SKIP` is a skip, not a failure.
    return undefined;
  }
  return { name: rest.trim(), fields: readBlock(lines, index + 1, indent.length) };
}

/**
 * Read the YAML diagnostic block belonging to a `not ok` at `indent`.
 *
 * Bounded by the block's own indentation: it ends at the first line indented
 * no more than the `not ok` that owns it. That is what keeps a failure from
 * absorbing the NEXT test's diagnostics, which would attach one test's
 * location to another's name — a pointer that sends the reader to the wrong
 * line is worse than no pointer.
 */
function readBlock(
  lines: readonly string[],
  start: number,
  indent: number,
): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim() === "") {
      continue;
    }
    if (indentOf(line) <= indent) {
      break;
    }
    index = readField(lines, index, fields);
  }
  return fields;
}

/**
 * Read the one field starting at `index`, returning its LAST line.
 *
 * The return value is what lets the caller stay a plain line loop: a literal
 * block spans several lines, and handing back its end is how those lines get
 * skipped instead of being re-read as fields of their own. A line that is not
 * a field at all returns `index` unchanged and contributes nothing.
 */
function readField(
  lines: readonly string[],
  index: number,
  fields: Map<string, string>,
): number {
  const line = lines[index] ?? "";
  const match = YAML_FIELD.exec(line);
  const key = match?.[1];
  const value = match?.[2];
  if (key === undefined || value === undefined) {
    return index;
  }
  if (isBlockScalar(value)) {
    // `stack: |-` opens a literal block; its body is the following, more
    // deeply indented lines. Reading it as the scalar `"|-"` and then treating
    // each body line as another `key: value` pair would invent fields out of
    // stack frames.
    const body = literalBlock(lines, index + 1, indentOf(line));
    keepFirst(fields, key, body.text);
    return body.end;
  }
  keepFirst(fields, key, unquote(value));
  return index;
}

/**
 * First writer wins.
 *
 * A repeated key inside one diagnostic block is node repeating itself, and the
 * first spelling is the one that belongs to the `not ok` this block opened
 * under. Overwriting would let a nested frame's `location` replace the test's.
 */
function keepFirst(fields: Map<string, string>, key: string, value: string): void {
  if (!fields.has(key)) {
    fields.set(key, value);
  }
}

function isBlockScalar(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === "|" || trimmed === "|-" || trimmed === ">" || trimmed === ">-";
}

/** A YAML literal block's body, and where it stopped. */
interface LiteralBlock {
  readonly text: string;
  /** Index of the block's LAST line, so the caller can resume after it. */
  readonly end: number;
}

/** Body of a YAML literal block, plus the index of its last line. */
function literalBlock(lines: readonly string[], start: number, indent: number): LiteralBlock {
  const body: string[] = [];
  let index = start;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      break;
    }
    if (line.trim() !== "" && indentOf(line) <= indent) {
      break;
    }
    body.push(line.trim());
  }
  return { text: body.join("\n"), end: index - 1 };
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Strip YAML scalar quoting, and nothing more.
 *
 * Deliberately not a YAML parser: the only escapes node emits inside these
 * single-quoted scalars are `\n` and `''`, and a real parser would be a
 * dependency this project does not have (docs/dependency-policy.md). A value
 * this mangles ends up slightly ugly in a message; it never ends up wrong in a
 * `file:line`, because those are matched separately.
 */
function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted =
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 1) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1);
  const inner = quoted ? trimmed.slice(1, -1) : trimmed;
  return inner.replaceAll("\\n", " ").replaceAll("''", "'").trim();
}

/** A rollup over failed subtests is not itself a finding. See the module doc. */
function isRealFailure(failure: TapFailure): boolean {
  return failure.fields.get("failureType") !== "subtestsFailed";
}

function toViolation(failure: TapFailure, root: string): Violation {
  const location = parseLocation(failure.fields.get("location"), root);
  const detail = condense(failure.fields.get("error") ?? "");
  const file = location?.file ?? fileFromStack(failure, root);
  return {
    message: detail === "" ? `${failure.name} failed` : `${failure.name} — ${detail}`,
    file,
    line: location?.line,
    column: location?.column,
    code: TEST_FAILED,
    fixHint:
      file === undefined
        ? "re-run this test alone with `node --test --test-name-pattern`"
        : `re-run alone: node --test ${file}`,
  };
}

/** `location: '/abs/path/file.test.js:12:1'` -> a project-relative pointer. */
function parseLocation(value: string | undefined, root: string): StackLocation | undefined {
  if (value === undefined) {
    return undefined;
  }
  const found = stackLocation(value, undefined);
  return found === undefined
    ? undefined
    : { file: relativeToRoot(found.file, root), line: found.line, column: found.column };
}

/** Fall back to the stack when `location` is absent. */
function fileFromStack(failure: TapFailure, root: string): string | undefined {
  const stack = failure.fields.get("stack");
  const found = stack === undefined ? undefined : stackLocation(stack, undefined);
  return found === undefined ? undefined : relativeToRoot(found.file, root);
}

function summarize(counts: ReadonlyMap<string, number>, parsedFailures: number): TestSummary {
  const total = counts.get("tests") ?? 0;
  const failed = counts.get("fail") ?? parsedFailures;
  return {
    total,
    passed: counts.get("pass") ?? Math.max(total - failed, 0),
    failed,
    skipped: counts.get("skipped") ?? 0,
    todo: counts.get("todo") ?? 0,
    failedFiles: 0,
  };
}

/**
 * Did the run pass?
 *
 * `# fail 0` from node's own summary is authoritative when present, because it
 * counts failures this parser might not have recognised. Only when the summary
 * is missing entirely — a run that died before printing it — does the parsed
 * failure count decide, and a truncated run with no counts and no failures is
 * NOT called a pass: `looksLikeTap` let it through, but a document with no
 * summary describes an incomplete run.
 */
function verdict(counts: ReadonlyMap<string, number>, parsedFailures: number): boolean {
  const failed = counts.get("fail");
  if (failed !== undefined) {
    return failed === 0 && parsedFailures === 0;
  }
  return false;
}
