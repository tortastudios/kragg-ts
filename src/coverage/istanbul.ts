/**
 * Normalize an istanbul coverage report into the shared line model.
 *
 * THE PROBLEM THIS SOLVES. `kragg/src/kragg/coverage.py` reads coverage.py's
 * JSON, which hands it exactly what the `critical-coverage` gate wants: per
 * file, per function, a list of `missing_lines`. The JavaScript ecosystem has
 * no such report. What it has is `coverage-final.json` — istanbul's raw
 * instrumentation dump, written by `vitest --coverage --coverage.reporter=json`,
 * by `c8 --reporter=json` and by `nyc --reporter=json`:
 *
 *     { "/abs/path/src/a.ts": {
 *         "path": "/abs/path/src/a.ts",
 *         "statementMap": { "0": { "start": {"line":3,...}, "end": {...} } },
 *         "s":            { "0": 2 },
 *         "fnMap":        { "0": { "name": "run", "decl": {...}, "loc": {...} } },
 *         "f":            { "0": 2 },
 *         "branchMap": {...}, "b": {...} } }
 *
 * This module turns that into `coverage/model.ts`'s shape. Its lcov sibling,
 * `coverage/lcov.ts`, produces the same shape from the tracefiles `node --test`
 * and `bun test` write, so `critical-coverage` and `kragg coverage` work under
 * every supported runner off one model.
 *
 * ── THE LINE RULE, AND WHY ─────────────────────────────────────────────────
 * A line's hit count is the MAXIMUM count over the statements that START on
 * it. A line is uncovered when at least one statement starts there and every
 * such statement has a count of zero. Lines that no statement starts on — a
 * blank line, a comment, or the second and later lines of a statement that
 * spans several — are NOT part of the model at all: they are neither covered
 * nor uncovered.
 *
 * That is not a choice, it is istanbul's own definition: `FileCoverage.
 * getLineCoverage()` keys on `statementMap[id].start.line` and keeps the max
 * count, and everything downstream (the lcov writer, the text reporter, the
 * summary percentages) is built on it. Adopting it means kragg's uncovered
 * lines are the same lines the project's own coverage report shows, which is
 * the whole point of a `file:line` pointer.
 *
 * The tempting alternative — marking every line from `start.line` to
 * `end.line` — is WRONG and was rejected. It would report the middle of a
 * multi-line call as an uncovered line, sending an agent to a line holding a
 * lone argument. It also double-counts: an uncovered statement nested inside a
 * covered multi-line block would flip the whole block's lines to "covered"
 * or "uncovered" depending on iteration order.
 *
 * KNOWN BLIND SPOT, stated rather than papered over: because the rule is
 * per-line and takes the max, a branch that never ran but shares a line with
 * one that did is invisible. `if (broken) fix();` reports as covered when the
 * `if` executed and `fix()` never did — `branchMap`/`b` hold that fact and
 * this model drops it. See `coverage/model.ts` for why that stays dropped.
 *
 * ── PRODUCERS ──────────────────────────────────────────────────────────────
 * Any tool writing istanbul JSON: `vitest --coverage` with either the `v8`
 * provider (which remaps V8 ranges into this shape) or the `istanbul`
 * provider, plus `c8` and `nyc` with `--reporter=json`. Runners that emit lcov
 * instead go through `coverage/lcov.ts`; nothing here parses lcov.
 *
 * EVERYTHING HERE IS UNTRUSTED INPUT. The report is a file on disk written by
 * another tool at an unknown version; every field arrives as `unknown` and is
 * narrowed explicitly. A malformed entry contributes nothing and never throws.
 */

import { readFileSync } from "node:fs";

import { relativeKey } from "./model.ts";
import type { FileCoverage, FunctionSpan, NormalizedCoverage } from "./model.ts";

/**
 * Convert a parsed `coverage-final.json` into the line model.
 *
 * `report` is the PARSED object, not a path: the gate is then testable with a
 * literal and never has to run a coverage tool. Anything that is not an object
 * yields an empty result, which callers must treat as "not measured" rather
 * than "nothing uncovered" — see the gate for how that distinction is kept.
 *
 * Two report keys that normalize to the same path are MERGED rather than
 * clobbering each other, since dropping one would silently discard real
 * coverage data.
 */
export function normalizeIstanbul(report: unknown, root: string): NormalizedCoverage {
  const files = new Map<string, Accumulator>();
  if (!isObject(report)) {
    return { files: new Map() };
  }
  for (const [key, value] of Object.entries(report)) {
    if (!isObject(value)) {
      continue;
    }
    const path = relativeKey(stringAt(value, "path") ?? key, root);
    const accumulator = files.get(path) ?? { counts: new Map(), functions: [] };
    collectStatements(value, accumulator);
    collectFunctions(value, accumulator);
    files.set(path, accumulator);
  }
  return { files: finalize(files) };
}

/** Read and parse a report file; `null` when missing or not valid JSON. */
export function readIstanbulReport(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/* --- Internals ----------------------------------------------------------- */

interface Accumulator {
  /** 1-based line -> highest hit count of any statement starting there. */
  readonly counts: Map<number, number>;
  readonly functions: FunctionSpan[];
}

function collectStatements(entry: JsonObject, into: Accumulator): void {
  const statements = objectAt(entry, "statementMap");
  const hits = objectAt(entry, "s");
  if (statements === null) {
    return;
  }
  for (const [id, location] of Object.entries(statements)) {
    const line = positionLine(location, "start");
    if (line === null) {
      continue;
    }
    const count = hits === null ? 0 : (numberAt(hits, id) ?? 0);
    const previous = into.counts.get(line);
    if (previous === undefined || previous < count) {
      into.counts.set(line, count);
    }
  }
}

/**
 * Read `fnMap`/`f`.
 *
 * The span is taken from `loc` (the whole function, header included in most
 * producers) and falls back to `decl` (the name/parameter list only) when a
 * producer omits `loc`. A function whose location cannot be read at all is
 * dropped rather than guessed at, since a wrong span would attribute another
 * function's uncovered lines to this one.
 */
function collectFunctions(entry: JsonObject, into: Accumulator): void {
  const functions = objectAt(entry, "fnMap");
  const hits = objectAt(entry, "f");
  if (functions === null) {
    return;
  }
  for (const [id, value] of Object.entries(functions)) {
    if (!isObject(value)) {
      continue;
    }
    const span = spanOf(value);
    if (span === null) {
      continue;
    }
    into.functions.push({
      name: stringAt(value, "name") ?? `(anonymous_${id})`,
      startLine: span.startLine,
      endLine: span.endLine,
      hits: hits === null ? 0 : (numberAt(hits, id) ?? 0),
    });
  }
}

/** The 1-based line range a coverage entry claims. */
interface LineSpan {
  startLine: number;
  endLine: number;
}

function spanOf(value: JsonObject): LineSpan | null {
  for (const key of ["loc", "decl"]) {
    const location = objectAt(value, key);
    if (location === null) {
      continue;
    }
    const startLine = positionLine(location, "start");
    if (startLine === null) {
      continue;
    }
    const endLine = positionLine(location, "end");
    return { startLine, endLine: endLine === null ? startLine : Math.max(startLine, endLine) };
  }
  return null;
}

function finalize(files: ReadonlyMap<string, Accumulator>): Map<string, FileCoverage> {
  const out = new Map<string, FileCoverage>();
  for (const [path, accumulator] of files) {
    const lines = [...accumulator.counts].sort(([left], [right]) => left - right);
    out.set(path, {
      path,
      uncoveredLines: lines.filter(([, count]) => count === 0).map(([line]) => line),
      coveredLines: lines.filter(([, count]) => count > 0).map(([line]) => line),
      functions: accumulator.functions,
    });
  }
  return out;
}

type JsonObject = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectAt(table: JsonObject, key: string): JsonObject | null {
  if (!Object.hasOwn(table, key)) {
    return null;
  }
  const value = table[key];
  return isObject(value) ? value : null;
}

function stringAt(table: JsonObject, key: string): string | null {
  if (!Object.hasOwn(table, key)) {
    return null;
  }
  const value = table[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function numberAt(table: JsonObject, key: string): number | null {
  if (!Object.hasOwn(table, key)) {
    return null;
  }
  const value = table[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The 1-based line of `location[edge]`, or `null`.
 *
 * istanbul lines are already 1-based (columns are 0-based, and are not used
 * here). A non-positive or non-integer line is treated as absent: it cannot
 * point at real source, and passing it through would produce a violation
 * addressed to line 0.
 */
function positionLine(location: unknown, edge: string): number | null {
  if (!isObject(location)) {
    return null;
  }
  const position = objectAt(location, edge);
  if (position === null) {
    return null;
  }
  const line = numberAt(position, "line");
  return line !== null && Number.isInteger(line) && line > 0 ? line : null;
}
