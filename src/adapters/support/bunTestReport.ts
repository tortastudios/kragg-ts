/**
 * Parser for `bun test`'s console output.
 *
 * ⚠️ THIS IS THE ONE PARSER IN `src/adapters/` THAT IS NOT READING A
 * MACHINE-READABLE FORMAT, and it says so loudly because the alternative was
 * to pretend otherwise.
 *
 * `bun test` has exactly two result reporters. From bun's own argument parser:
 *
 *     unsupported reporter format '{}'. Available options:
 *     'junit' (for XML test results), 'dots'
 *
 * `junit` writes XML and requires `--reporter-outfile`. **There is no JSON
 * reporter.** Parsing the XML would need an XML parser, and this project has
 * zero runtime dependencies (`docs/dependency-policy.md`), so the options were:
 * regex-scrape XML, regex-scrape the console output, or refuse to support bun.
 *
 * Console output was chosen over XML-by-regex because it degrades honestly: a
 * format change makes the counts stop matching and the run falls back to
 * "exit code decides", whereas a regex over XML that stops matching looks
 * exactly like a passing suite. The EXIT CODE remains authoritative for
 * pass/fail — bun exits non-zero on any failure — and this parser only adds
 * the detail on top of it.
 *
 * FORMAT (bun 1.3.x, from the docs and release notes; not executed here):
 *
 *     bun test v1.3.14 (abcdef01)
 *
 *     test/math.test.ts:
 *     (pass) math > adds [0.05ms]
 *     (fail) math > subtracts [0.10ms]
 *       error: expect(received).toBe(expected)
 *
 *      1 pass
 *      0 skip
 *      1 fail
 *      2 expect() calls
 *     Ran 2 tests across 1 files. [12.00ms]
 *
 * A TTY renders `✓`/`✗` in place of `(pass)`/`(fail)`; both spellings are
 * matched, since kragg captures a pipe but a user may paste TTY output into a
 * bug report.
 *
 * COVERAGE IS NOT HERE. `bun test --coverage` writes `text` or `lcov` and
 * nothing else — bun's parser again: "invalid coverage reporter '…'. Available
 * options: 'text' (console output), 'lcov' (code coverage file)". kragg reads
 * the lcov through `support/lcov.ts`; there is no istanbul JSON to read and
 * this module does not invent one.
 */

import type { Violation } from "../../engine/models.ts";
import { condense } from "./testReport.ts";
import type { TestReport, TestSummary } from "./testReport.ts";

/** `code` for a failed test. Shared with the other runners' parsers. */
export const TEST_FAILED = "test-failed";

/** `(fail) name [1.23ms]` or `✗ name [1.23ms]`. */
const FAIL_LINE = /^\s*(?:\(fail\)|[✗✘×])\s+(.+?)(?:\s+\[[\d.]+m?s\])?\s*$/u;
/** A bare `path/to/file.test.ts:` header introducing that file's results. */
const FILE_HEADER = /^\s*(\S+\.(?:[cm]?[jt]sx?))\s*:\s*$/u;
/** ` 3 pass`, ` 1 fail`, ` 0 skip`, ` 2 todo`. */
const COUNT_LINE = /^\s*(\d+)\s+(pass|fail|skip|todo)\b/u;
/** `Ran 12 tests across 3 files.` — the only whole-run total bun prints. */
const RAN_LINE = /^\s*Ran\s+(\d+)\s+tests?\s+across\s+(\d+)\s+files?/u;

/**
 * Parse `bun test` output.
 *
 * Returns `undefined` when the text carries no recognisable bun structure at
 * all, which the caller reports as a tool crash. Note the asymmetry with the
 * other parsers, and it is deliberate: because this format is not a contract,
 * a SUCCESSFUL parse here is weaker evidence than a successful JSON parse, so
 * `TestReport.success` is left for the caller to combine with the exit code.
 */
export function parseBunTest(text: string, exitCode: number): TestReport | undefined {
  const lines = text.split("\n");
  const scan = newScan();
  for (let index = 0; index < lines.length; index += 1) {
    scanLine(scan, lines, index);
  }
  if (!scan.recognised) {
    return undefined;
  }
  const summary = summarize(scan.counts, scan.total, scan.violations.length, scan.files.size);
  return {
    summary,
    violations: scan.violations,
    success: exitCode === 0 && summary.failed === 0,
  };
}

/**
 * What the scan carries from line to line.
 *
 * Mutable on purpose: bun's output is a stream of lines whose meaning depends
 * on the ones before them — a `(fail)` belongs to the file header above it —
 * so the reading is a state machine, and threading the state through explicit
 * parameters and return values would obscure that rather than reveal it.
 */
interface BunScan {
  /** Label (`pass`, `fail`, `skip`, `todo`) -> count, as bun printed it. */
  readonly counts: Map<string, number>;
  readonly violations: Violation[];
  /** Test files that carried at least one failure. */
  readonly files: Set<string>;
  /** The file header most recently seen; failures below it belong to it. */
  currentFile: string | undefined;
  /** From `Ran N tests`, the only whole-run total bun prints. */
  total: number | undefined;
  /**
   * Whether ANY line was recognisably bun's. The tool-crash signal: false here
   * means the text was never bun output, and reporting zero failures for it
   * would be a green gate over a run that did not happen.
   */
  recognised: boolean;
}

function newScan(): BunScan {
  return {
    counts: new Map<string, number>(),
    violations: [],
    files: new Set<string>(),
    currentFile: undefined,
    total: undefined,
    recognised: false,
  };
}

/** Fold one line into the scan. Unrecognised lines change nothing. */
function scanLine(scan: BunScan, lines: readonly string[], index: number): void {
  const line = lines[index] ?? "";
  if (readStructure(scan, line)) {
    return;
  }
  const name = FAIL_LINE.exec(line)?.[1];
  if (name !== undefined) {
    scan.recognised = true;
    recordFailure(scan, name.trim(), detail(lines, index + 1));
  }
}

/**
 * A file header, the `Ran N tests` line, or a count line. True when the line
 * was one of them and so cannot also be a failure.
 */
function readStructure(scan: BunScan, line: string): boolean {
  const header = FILE_HEADER.exec(line)?.[1];
  if (header !== undefined) {
    scan.currentFile = header;
    return true;
  }
  const ran = RAN_LINE.exec(line)?.[1];
  if (ran !== undefined) {
    scan.total = Number.parseInt(ran, 10);
    scan.recognised = true;
    return true;
  }
  return readCount(scan, line);
}

/** ` 3 pass` and friends. True when the line was a count. */
function readCount(scan: BunScan, line: string): boolean {
  const match = COUNT_LINE.exec(line);
  const value = match?.[1];
  const label = match?.[2];
  if (value === undefined || label === undefined) {
    return false;
  }
  scan.counts.set(label, Number.parseInt(value, 10));
  scan.recognised = true;
  return true;
}

/** Record a failed test against the file header it appeared under. */
function recordFailure(scan: BunScan, name: string, message: string): void {
  scan.violations.push(toViolation(name, scan.currentFile, message));
  if (scan.currentFile !== undefined) {
    scan.files.add(scan.currentFile);
  }
}

/**
 * The first indented line after a failure — bun's `error: …` line.
 *
 * Only one line is taken. bun prints a full diff and stack under each failure,
 * and the whole point of this gate's output shape is that a reader gets
 * pointers rather than a transcript.
 */
function detail(lines: readonly string[], start: number): string {
  for (let index = start; index < lines.length && index < start + 4; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      continue;
    }
    if (!/^\s/u.test(line)) {
      return "";
    }
    return condense(line);
  }
  return "";
}

function toViolation(name: string, file: string | undefined, message: string): Violation {
  return {
    message: message === "" ? `${name} failed` : `${name} — ${message}`,
    file,
    code: TEST_FAILED,
    fixHint:
      file === undefined
        ? `re-run alone: bun test -t ${quote(name)}`
        : `re-run alone: bun test ${file} -t ${quote(name)}`,
  };
}

function summarize(
  counts: ReadonlyMap<string, number>,
  total: number | undefined,
  parsedFailures: number,
  failedFiles: number,
): TestSummary {
  const failed = counts.get("fail") ?? parsedFailures;
  const passed = counts.get("pass") ?? 0;
  const skipped = counts.get("skip") ?? 0;
  const todo = counts.get("todo") ?? 0;
  return {
    total: total ?? passed + failed + skipped + todo,
    passed,
    failed,
    skipped,
    todo,
    failedFiles,
  };
}

/** Single-quote a test name for a shell a human will paste it into. */
function quote(name: string): string {
  return `'${name.replaceAll("'", "'\\''")}'`;
}
