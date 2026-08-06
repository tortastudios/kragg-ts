/**
 * Reader for lcov tracefiles — the ONLY machine-readable coverage format
 * `node --test` and `bun test` can produce.
 *
 * WHY THIS FILE EXISTS, stated plainly, because the alternative was to fake it:
 *
 *  - `node --test` has five built-in reporters — `spec`, `dot`, `tap`,
 *    `junit`, `lcov`. There is no JSON reporter and no way to make it write
 *    istanbul's `coverage-final.json`. Its only other machine-readable
 *    coverage channel is the `test:coverage` event, which needs a custom
 *    reporter module loaded into the run.
 *  - `bun test` accepts exactly two coverage reporters, `text` and `lcov`
 *    (bun's own arg parser: "invalid coverage reporter '…'. Available
 *    options: 'text' (console output), 'lcov' (code coverage file)"). There is
 *    no istanbul JSON output, and `--reporter` for test RESULTS accepts only
 *    `junit` and `dots`.
 *
 * So two of the three supported runners cannot emit the format the third one
 * does. Writing this reader is what makes `coverage_fail_under` mean the same
 * thing under all three; the alternative was to claim a JSON path that does
 * not exist, or to leave coverage silently unmeasured under two runners.
 *
 * FORMAT. lcov is line-oriented, one record per source file, and four of its
 * directives are read:
 *
 *     SF:<path to source file>
 *     DA:<line number>,<execution count>[,<checksum>]
 *     FN:<line>,<name>            // where a function starts
 *     FN:<start>,<end>,<name>     // the lcov 2.x form, which also states the end
 *     FNDA:<execution count>,<name>
 *     LF:<lines found>      LH:<lines hit>       // summary — IGNORED, see below
 *     end_of_record
 *
 * `LF`/`LH` (and `FNF`/`FNH`) are deliberately NOT read. They are the writer's
 * own summary, they disagree with the records in tracefiles produced by
 * merging several runs, and counting the records directly is exactly what
 * istanbul does with its statement map. Trusting a self-reported total over
 * the records it summarizes would make kragg's percentage differ from every
 * other tool reading the same file.
 *
 * `BRDA`/`BRF`/`BRH` — branch data — are ignored outright. This is a LINE
 * model; folding branch facts into it would make a line number mean two
 * things. `coverage/model.ts` states that blind spot in full.
 *
 * WHY `FN`/`FNDA` ARE READ AT ALL. They are what lets `critical-coverage` and
 * `kragg coverage` run under `node --test` and `bun test`: `coverage/lcov.ts`
 * turns them into the same `FunctionSpan` shape istanbul's `fnMap` produces.
 * Nothing is invented on the way — a two-field `FN:` states no end line, so
 * the span carries `null` and the consumer takes the extent from the source.
 */

import { readReportFile } from "./coverage.ts";
import type {
  CoverageReadResult,
  MeasuredFile,
  FunctionRecord,
  LineCoverageReport,
} from "./coverage.ts";

export type LcovReadResult =
  | { readonly ok: true; readonly report: LineCoverageReport }
  | Extract<CoverageReadResult, { ok: false }>;

/** Read and parse an lcov tracefile. Never throws. */
export function readLcov(reportPath: string): LcovReadResult {
  const read = readReportFile(reportPath);
  if (!read.ok) {
    return read;
  }
  const report = parseLcov(read.text, reportPath);
  if (report.files.length === 0) {
    return {
      ok: false,
      reason: "malformed",
      message:
        `${reportPath} contains no lcov records ` +
        "(expected `SF:` / `DA:` lines; the file may be truncated or empty)",
    };
  }
  return { ok: true, report };
}

/**
 * Parse lcov text into the shared line-coverage shape.
 *
 * Total: unknown directives are ignored, a `DA:` outside any record is
 * dropped, and a malformed count is treated as absent rather than as zero — a
 * corrupt line must not manufacture an uncovered line and drag the percentage
 * down into a failure the project cannot reproduce.
 *
 * A file appearing in more than one record (separate runs merged into one
 * tracefile, which both node and bun do across test files) has its counts
 * SUMMED, which is what every lcov consumer does: the line was hit in one run
 * or the other, so it is covered.
 */
export function parseLcov(text: string, reportPath: string): LineCoverageReport {
  const perFile = new Map<string, FileRecord>();
  let current: FileRecord | undefined;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "end_of_record") {
      current = undefined;
      continue;
    }
    const sourceFile = directive(line, "SF:");
    if (sourceFile !== undefined) {
      current = perFile.get(sourceFile) ?? newRecord();
      perFile.set(sourceFile, current);
      continue;
    }
    if (current === undefined) {
      continue;
    }
    apply(current, line);
  }

  return { reportPath, files: toFiles(perFile) };
}

/** Everything accumulated for one `SF:` path, across every record naming it. */
interface FileRecord {
  readonly hits: Map<number, number>;
  /** Function name -> the start lines it was declared at, in file order. */
  readonly starts: Map<string, Map<number, number | null>>;
  /** Function name -> summed `FNDA:` count. */
  readonly entered: Map<string, number>;
}

function newRecord(): FileRecord {
  return { hits: new Map(), starts: new Map(), entered: new Map() };
}

/** Dispatch one directive line. Anything unrecognized is ignored. */
function apply(record: FileRecord, line: string): void {
  const data = directive(line, "DA:");
  if (data !== undefined) {
    applyData(record.hits, data);
    return;
  }
  // `FNDA:` is tested before `FN:` — `directive` is a prefix match, and `FN:`
  // is not a prefix of `FNDA:` only because of the colon. Keeping this order
  // makes the pair robust to that punctuation rather than dependent on it.
  const entered = directive(line, "FNDA:");
  if (entered !== undefined) {
    applyFunctionData(record, entered);
    return;
  }
  const declared = directive(line, "FN:");
  if (declared !== undefined) {
    applyFunctionName(record, declared);
  }
}

/** The value of `line` when it starts with `prefix`, else `undefined`. */
function directive(line: string, prefix: string): string | undefined {
  return line.startsWith(prefix) ? line.slice(prefix.length).trim() : undefined;
}

/** Apply one `DA:<line>,<count>[,<checksum>]` record. */
function applyData(hits: Map<number, number>, value: string): void {
  const parts = value.split(",");
  const line = toCount(parts[0]);
  const count = toCount(parts[1]);
  if (line === undefined || line <= 0 || count === undefined) {
    return;
  }
  hits.set(line, (hits.get(line) ?? 0) + count);
}

function toCount(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  // `Number` rather than `parseInt`: `parseInt("12abc")` silently yields 12,
  // which would accept a corrupt field as a valid count.
  const parsed = Number(trimmed);
  return trimmed !== "" && Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** One `FN:` record's fields, once the two spellings have been told apart. */
interface Declaration {
  readonly name: string;
  readonly startLine: number;
  /** Only the lcov 2.x three-field form states one. */
  readonly endLine: number | null;
}

/** Record one `FN:<line>,<name>` or `FN:<start>,<end>,<name>` declaration. */
function applyFunctionName(record: FileRecord, value: string): void {
  const declared = parseDeclaration(value);
  if (declared === null) {
    return;
  }
  const starts = record.starts.get(declared.name) ?? new Map<number, number | null>();
  // The first STATED end line wins: a merged tracefile repeats the same
  // declaration, and an extent already read must not be dropped by a later
  // two-field form of the same record.
  if ((starts.get(declared.startLine) ?? null) === null) {
    starts.set(declared.startLine, declared.endLine);
  }
  record.starts.set(declared.name, starts);
}

/**
 * Split an `FN:` payload into a name, a start line and maybe an end line.
 *
 * The name is whatever is left after the numbers, joined back with commas,
 * since nothing in lcov escapes a comma inside a function name.
 *
 * `null` for a record with no usable start line or no name. Neither is
 * defaulted: a function placed at line 0, or one called "", would send a
 * reviewer nowhere.
 */
function parseDeclaration(value: string): Declaration | null {
  const parts = value.split(",");
  const startLine = toCount(parts[0]);
  if (startLine === undefined || startLine <= 0 || parts.length < 2) {
    return null;
  }
  const endLine = statedEnd(parts, startLine);
  const name = parts.slice(endLine === null ? 1 : 2).join(",").trim();
  return name === "" ? null : { name, startLine, endLine };
}

/**
 * The end line of the lcov 2.x `FN:<start>,<end>,<name>` form, else `null`.
 *
 * The two forms are told apart by whether a THIRD field exists and the second
 * is an integer at or after the start. A name that is itself a bare number is
 * the one ambiguous case (`FN:12,20,3` could be "function `20,3` at line 12"),
 * and it is resolved in favour of the lcov 2.x reading; no real emitter
 * produces the other.
 */
function statedEnd(parts: readonly string[], startLine: number): number | null {
  if (parts.length < 3) {
    return null;
  }
  const second = toCount(parts[1]);
  return second !== undefined && second >= startLine ? second : null;
}

/**
 * Apply one `FNDA:<count>,<name>` record.
 *
 * SUMMED across records, for the same reason `DA:` is: node and bun write one
 * record per source file per TEST file, and a function entered by any test was
 * entered. A malformed count is treated as absent rather than as zero — a
 * corrupt field must not manufacture a never-called function.
 */
function applyFunctionData(record: FileRecord, value: string): void {
  const comma = value.indexOf(",");
  if (comma < 0) {
    return;
  }
  const count = toCount(value.slice(0, comma));
  const name = value.slice(comma + 1).trim();
  if (count === undefined || name === "") {
    return;
  }
  record.entered.set(name, (record.entered.get(name) ?? 0) + count);
}

function toFiles(perFile: ReadonlyMap<string, FileRecord>): readonly MeasuredFile[] {
  const files: MeasuredFile[] = [];
  for (const [path, record] of perFile) {
    files.push({ key: path, path, lineHits: record.hits, functions: toFunctions(record) });
  }
  return files;
}

/**
 * Pair every declared function with its entry count.
 *
 * `FNDA:` names a function and not a line, so a name declared at two lines in
 * one file gets the same count attributed to BOTH spans. That is the honest
 * reading of what lcov states, and it is safe downstream: a consumer that
 * finds two spans for one name declines to attribute coverage at all rather
 * than picking one — see `gates/criticalCoverage.ts`.
 */
function toFunctions(record: FileRecord): readonly FunctionRecord[] {
  const functions: FunctionRecord[] = [];
  for (const [name, starts] of record.starts) {
    const hits = record.entered.get(name) ?? 0;
    for (const [startLine, endLine] of starts) {
      functions.push({ name, startLine, endLine, hits });
    }
  }
  return functions.sort((left, right) => left.startLine - right.startLine);
}
