/**
 * The ONE line-coverage model every runner's report is normalized into.
 *
 * `kragg/src/kragg/coverage.py` never needed this file: coverage.py hands
 * Python a per-file, per-function `missing_lines` list and that is the end of
 * it. The JavaScript ecosystem has no such report and no agreement about
 * formats at all — vitest writes istanbul's `coverage-final.json`, `node
 * --test` and `bun test` write lcov, and neither can produce the other. So the
 * shape below is the meeting point: whatever a runner emitted, the gate and
 * the `kragg coverage` command see this.
 *
 * ── THE LINE RULE ──────────────────────────────────────────────────────────
 * A line is UNCOVERED when the report says it is executable and says it never
 * ran. Lines the report says nothing about — blank lines, comments, the second
 * and later lines of a multi-line statement — are not in the model at all:
 * they are neither covered nor uncovered. Both readers honour that, because
 * both formats state it directly (istanbul's `statementMap` start lines, lcov's
 * `DA:` records), and it is what makes kragg's uncovered lines the same lines
 * the project's own coverage report shows.
 *
 * ── WHAT IS DELIBERATELY ABSENT ────────────────────────────────────────────
 * BRANCHES. istanbul's `branchMap`/`b` and lcov's `BRDA:` both carry
 * branch-level facts, and neither is read. `if (broken) fix();` reports as
 * covered when the `if` ran and `fix()` never did. That is a real blind spot
 * and it is stated rather than papered over: a branch signal is not a line
 * model, and folding one into the other would make every line number in a
 * violation mean two different things depending on where it came from.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

/** One function's span and hit count, as a coverage report records them. */
export interface FunctionSpan {
  /**
   * The name the report assigned. istanbul names a declared function, a
   * method, an object-literal method or a named `const` arrow after itself and
   * anything anonymous `(anonymous_N)`; lcov carries whatever its writer put in
   * an `FN:` record. Never qualified by its class in either format.
   */
  readonly name: string;
  /** 1-based first line of the function. */
  readonly startLine: number;
  /**
   * 1-based last line of the body, or `null` when the report states no extent.
   *
   * `null` IS NOT AN ERROR AND MUST NOT BE GUESSED AT. istanbul's `fnMap.loc`
   * always gives an end line; lcov's `FN:<line>,<name>` — the form `node
   * --test`, `bun test` and istanbul's own lcov writer all emit — gives only
   * where the function starts. Filling that in from the next `FN:` record
   * would be an inference, and a wrong one the moment a function nests inside
   * another. Consumers that need an extent take it from the SOURCE, which is a
   * fact; see `coverage/spans.ts`.
   */
  readonly endLine: number | null;
  /** Times the function was entered; `0` means never called. */
  readonly hits: number;
}

/** Line-level coverage for one file. */
export interface FileCoverage {
  /** Repo-relative POSIX path when the report's key resolved under the root. */
  readonly path: string;
  /** 1-based executable lines that never ran, ascending. */
  readonly uncoveredLines: readonly number[];
  /**
   * 1-based executable lines that ran at least once, ascending.
   *
   * Kept beside `uncoveredLines` so a consumer can tell "every line in this
   * span ran" from "this span holds no line the report knows about" — the
   * difference between a function that executed and one the report is silent
   * on, which `critical-coverage` must not confuse.
   */
  readonly coveredLines: readonly number[];
  /** Function spans, in the report's own order. */
  readonly functions: readonly FunctionSpan[];
}

/** A whole report, keyed by the same paths as {@link FileCoverage.path}. */
export interface NormalizedCoverage {
  readonly files: ReadonlyMap<string, FileCoverage>;
}

/* --- What a READER produces, before normalization ------------------------ */

/**
 * One function record, exactly as an lcov `FN:`/`FNDA:` pair states it.
 *
 * Only the lcov reader fills these in. istanbul JSON carries the same facts in
 * `fnMap`/`f`, but with a full body span and richer structure, and
 * `istanbul.ts` reads them straight from the raw document — routing them
 * through this thinner shape would lose the end line for nothing.
 */
export interface FunctionRecord {
  readonly name: string;
  /** 1-based line the function starts on. */
  readonly startLine: number;
  /**
   * 1-based last line, or `null` when the tracefile states none. The two-field
   * `FN:<line>,<name>` form that node, bun and istanbul all write states none;
   * lcov 2.x's `FN:<start>,<end>,<name>` does. It is never inferred.
   */
  readonly endLine: number | null;
  /** Times the function was entered, summed across merged records. */
  readonly hits: number;
}

/**
 * One file as a READER measured it, before any normalization.
 *
 * Distinct from {@link FileCoverage}, which is what a GATE consumes: this
 * carries raw hit counts and the report's own key; that one carries the
 * uncovered lines derived from them.
 */
export interface MeasuredFile {
  /** Key from the report — normally an absolute path. */
  readonly key: string;
  /** `data.path` when present, else `key`. */
  readonly path: string;
  /** Executable line -> hit count, istanbul's `getLineCoverage()`. */
  readonly lineHits: ReadonlyMap<number, number>;
  /** Function records; empty from formats that state none through this shape. */
  readonly functions: readonly FunctionRecord[];
}

/**
 * Line coverage for a whole run, whatever format it arrived in.
 *
 * Both readers in `adapters/support/` produce this: `readCoverageReport` from
 * istanbul JSON and `parseLcov` from the lcov that `node --test` and `bun
 * test` emit. Everything downstream — totals, thresholds, gap reporting —
 * works off this one shape, so the coverage NUMBER means the same thing under
 * every runner even though no two of them agree on a file format.
 *
 * IT LIVES HERE, NOT IN THE ADAPTER, and that is an architectural fact rather
 * than a filing preference: `src/coverage` sits BELOW `src/adapters` in the
 * layer contract, because adapters consume the normalizers and not the other
 * way round. Declaring this type in the adapter and importing it back down
 * inverted that — the `boundaries` gate caught exactly that edge in
 * `coverage/lcov.ts` the first time it ran on this repo. Adapters PRODUCE the
 * shape; `coverage/` OWNS it.
 */
export interface LineCoverageReport {
  /** Absolute path the report was read from, for error messages. */
  readonly reportPath: string;
  readonly files: readonly MeasuredFile[];
}

/** The uncovered lines inside a 1-based inclusive span, ascending. */
export function uncoveredWithin(
  file: FileCoverage,
  startLine: number,
  endLine: number,
): readonly number[] {
  return file.uncoveredLines.filter((line) => line >= startLine && line <= endLine);
}

/** Whether any executable line inside the span ran. */
export function ranWithin(file: FileCoverage, startLine: number, endLine: number): boolean {
  return file.coveredLines.some((line) => line >= startLine && line <= endLine);
}

/**
 * Function spans whose reported name equals `name`.
 *
 * Returns every match, because the caller — not this module — decides what to
 * do about an ambiguous name. Neither format records a class for a method, so
 * two classes in one file with a same-named method are indistinguishable here.
 */
export function functionsNamed(
  file: FileCoverage,
  name: string,
): readonly FunctionSpan[] {
  return file.functions.filter((span) => span.name === name);
}

/**
 * A report key as a repo-relative POSIX path.
 *
 * istanbul writes absolute keys; c8, lcov writers and some CI rewrites produce
 * relative ones. Both are accepted. A key that resolves OUTSIDE the root keeps
 * its original spelling rather than growing a `../../` prefix — it will simply
 * never match a first-party file, which is the honest outcome for coverage
 * data about someone else's tree.
 */
export function relativeKey(key: string, root: string): string {
  if (!isAbsolute(key)) {
    return stripDotSlash(toPosix(key));
  }
  const rel = relative(resolve(root), resolve(key));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return toPosix(key);
  }
  return toPosix(rel);
}

function stripDotSlash(path: string): string {
  let out = path;
  while (out.startsWith("./")) {
    out = out.slice(2);
  }
  return out;
}

function toPosix(path: string): string {
  const slashed = path.includes("\\") ? path.split("\\").join("/") : path;
  return sep === "/" ? slashed : slashed.split(sep).join("/");
}
