/**
 * Reading istanbul's `coverage-final.json`, and the ONE number the coverage
 * threshold is compared against.
 *
 * `coverage-final.json` is the interchange format of the whole JavaScript
 * coverage ecosystem: vitest writes it from either the v8 or the istanbul
 * provider (its `json` coverage reporter is on by default — see
 * `adapters/testRunner.ts`), nyc/jest write it, and any tool that consumes
 * coverage reads it. Its per-file shape is `FileCoverageData` from
 * `istanbul-lib-coverage`, verified against
 * `@types/istanbul-lib-coverage@2.0.6`:
 *
 *     { "<absolute file path>": {
 *         path: string,
 *         statementMap: { "0": { start: {line, column}, end: {line, column} } },
 *         fnMap: {...}, branchMap: {...},
 *         s: { "0": <hit count> }, f: {...}, b: {...} } }
 *
 * WHY THIS MODULE COMPUTES THE PERCENTAGE ITSELF rather than letting the test
 * runner enforce its own threshold: vitest signals a coverage-threshold miss
 * by setting `process.exitCode = 1` — the SAME exit code as a failing test
 * (verified in vitest 3.2.7, `checkThresholds`). A gate that delegated the
 * threshold could not tell "your tests fail" from "your tests pass but
 * coverage slipped", and those need different responses from whoever reads the
 * report. Computing it here keeps the two facts separate by construction, and
 * as a bonus makes `coverage_fail_under` mean the same thing under every
 * runner. It does not silence the runner's own threshold: the number here is
 * kragg's floor, and a threshold the runner enforced from the project's own
 * config is reported separately by `runnerReportedFailure` in
 * `testEvidence.ts`, never merged into this percentage.
 *
 * DIVISION OF LABOUR WITH `src/coverage/istanbul.ts`: that module turns a
 * report into per-file uncovered LINES and function spans — the actionable
 * gap list. This one produces the single aggregate PERCENTAGE the threshold
 * compares against, and hands the raw document over via `normalizedCoverage`.
 * The percentage is the weak, gameable signal; the gaps are the useful one.
 * They stay in separate modules so the second never gets rewritten in terms
 * of the first.
 */

import { readFileSync } from "node:fs";

import type { SourceFileEntry } from "../../coverage/inventory.ts";
import { normalizeIstanbul } from "../../coverage/istanbul.ts";
import { relativeKey } from "../../coverage/model.ts";
import type {
  LineCoverageReport,
  MeasuredFile,
  NormalizedCoverage,
} from "../../coverage/model.ts";
import { asNumber, asObject, asString, isJsonObject, parseJson, prop } from "./json.ts";
import type { JsonObject } from "./json.ts";

/**
 * The reader's output shape is DECLARED IN `coverage/`, not here.
 *
 * `src/coverage` sits BELOW `src/adapters` in the layer contract — adapters
 * consume the normalizers, never the reverse — so `coverage/lcov.ts` cannot
 * import a type declared in this module without inverting that. The types are
 * re-exported here because this is still where the readers live and where a
 * caller expects to find them; ownership is what moved, not the entry point.
 */
export type {
  FunctionRecord,
  LineCoverageReport,
  MeasuredFile,
} from "../../coverage/model.ts";

/** A validated `coverage-final.json`, one entry per measured file. */
export interface CoverageReport extends LineCoverageReport {
  /**
   * The parsed document, unmodified, for `src/coverage/istanbul.ts` to
   * normalize. Kept as `unknown`-derived JSON rather than a typed shape so
   * this module never becomes the place that decides what "uncovered" means.
   */
  readonly raw: JsonObject;
}

/** Line totals, computed the way istanbul computes them. */
export interface CoverageTotals {
  readonly totalLines: number;
  readonly coveredLines: number;
  /** Percentage, floored to two decimals. 100 when nothing is measurable. */
  readonly pct: number;
}

/**
 * Hand a validated report to the line-level normalizer.
 *
 * `src/coverage/istanbul.ts` owns what "uncovered" means per file and per
 * function — the analogue of `coverage.py`'s `critical_gaps`. This module owns
 * only the ONE aggregate number the threshold compares against. Keeping the
 * split means the gameable dashboard percentage and the actionable gap list
 * never end up computed by the same code, which is the distinction the Python
 * module's own docstring insists on.
 */
export function normalizedCoverage(report: CoverageReport, root: string): NormalizedCoverage {
  return normalizeIstanbul(report.raw, root);
}

/** Why a coverage report could not be read. Never a thrown error. */
export type CoverageReadError = "missing" | "unreadable" | "malformed";

/**
 * The failure arm, named because both readers below return it unchanged.
 *
 * `readReportFile` classifies the disk failure and `readCoverageReport` passes
 * that classification straight through, so the two share one shape rather than
 * one of them re-deriving it.
 */
export interface CoverageReadFailure {
  readonly ok: false;
  readonly reason: CoverageReadError;
  readonly message: string;
}

export type CoverageReadResult =
  | { readonly ok: true; readonly report: CoverageReport }
  | CoverageReadFailure;

/** The bytes of a coverage artifact, or why they could not be read. */
export type FileReadResult =
  | { readonly ok: true; readonly text: string }
  | CoverageReadFailure;

/**
 * Read and validate `coverage-final.json`.
 *
 * "Missing" is kept distinct from "malformed" because they mean opposite
 * things about the run that just happened: missing usually means coverage was
 * never collected (the provider is not installed, or the run died before the
 * reporter fired), while malformed means it was collected and written badly.
 * Both are reported; neither throws, and neither is ever treated as 0% — an
 * unreadable report must not manufacture a coverage failure any more than it
 * may manufacture a pass.
 */
export function readCoverageReport(reportPath: string): CoverageReadResult {
  const read = readReportFile(reportPath);
  if (!read.ok) {
    return read;
  }

  const parsed = parseJson(read.text);
  if (!isJsonObject(parsed)) {
    return {
      ok: false,
      reason: "malformed",
      message: `${reportPath} is not a JSON object (truncated or not a coverage report)`,
    };
  }
  return { ok: true, report: buildReport(reportPath, parsed) };
}

/**
 * Read a coverage artifact off disk, classifying failure rather than throwing.
 *
 * Shared with `lcov.ts` so both formats report a missing report the same way.
 * "Missing" stays distinct from "unreadable" because they mean opposite things
 * about the run: missing usually means coverage was never collected, while
 * unreadable means it was collected and something went wrong writing it.
 */
export function readReportFile(reportPath: string): FileReadResult {
  try {
    return { ok: true, text: readFileSync(reportPath, "utf8") };
  } catch (error: unknown) {
    const missing = isMissingFile(error);
    return {
      ok: false,
      reason: missing ? "missing" : "unreadable",
      message: missing
        ? `no coverage report at ${reportPath}`
        : `could not read ${reportPath}: ${describe(error)}`,
    };
  }
}

/** Build the validated view. Entries that are not file coverage are dropped. */
function buildReport(reportPath: string, raw: JsonObject): CoverageReport {
  const files: MeasuredFile[] = [];
  for (const key of Object.keys(raw)) {
    const entry = prop(raw, key);
    if (!isJsonObject(entry)) {
      continue;
    }
    const statementMap = asObject(entry, "statementMap");
    const hits = asObject(entry, "s");
    if (statementMap === undefined || hits === undefined) {
      continue;
    }
    files.push({
      key,
      path: asString(entry, "path") ?? key,
      lineHits: lineHits(statementMap, hits),
      // `fnMap`/`f` are read by `coverage/istanbul.ts` off the raw document,
      // which keeps their body spans; see `FunctionRecord`.
      functions: [],
    });
  }
  return { reportPath, files, raw };
}

/**
 * Statement coverage -> line coverage, mirroring istanbul-lib-coverage's
 * `MeasuredFile#getLineCoverage()`.
 *
 * Each statement is attributed to its START line, and when several statements
 * share a line the HIGHEST hit count wins. The max — not the sum, and not the
 * min — is what istanbul does, and it is what makes `a && b()` on one line
 * count as covered once the line runs. Reimplementing this with `+=` would
 * quietly disagree with every other tool reading the same file.
 */
function lineHits(statementMap: JsonObject, hits: JsonObject): ReadonlyMap<number, number> {
  const perLine = new Map<number, number>();
  for (const id of Object.keys(statementMap)) {
    const line = statementStartLine(statementMap, id);
    if (line === undefined) {
      continue;
    }
    // A statement present in the map but absent from `s` was never
    // instrumented for hits; counting it as 0 is what istanbul does.
    const count = asNumber(hits, id) ?? 0;
    const previous = perLine.get(line);
    if (previous === undefined || previous < count) {
      perLine.set(line, count);
    }
  }
  return perLine;
}

function statementStartLine(statementMap: JsonObject, id: string): number | undefined {
  const range = asObject(statementMap, id);
  const start = range === undefined ? undefined : asObject(range, "start");
  const line = start === undefined ? undefined : asNumber(start, "line");
  return line !== undefined && Number.isInteger(line) && line > 0 ? line : undefined;
}

/** Executable lines with zero hits, ascending. */
export function uncoveredLines(file: MeasuredFile): readonly number[] {
  const lines: number[] = [];
  for (const [line, count] of file.lineHits) {
    if (count === 0) {
      lines.push(line);
    }
  }
  return lines.sort((left, right) => left - right);
}

/**
 * Overall line totals across every measured file.
 *
 * This is the number `coverage_fail_under` is compared against, and it is
 * deliberately the same aggregate istanbul's `CoverageMap#getCoverageSummary()`
 * produces, so kragg and a `vitest --coverage` text report agree to the digit.
 */
export function coverageTotals(report: LineCoverageReport): CoverageTotals {
  let total = 0;
  let covered = 0;
  for (const file of report.files) {
    for (const count of file.lineHits.values()) {
      total += 1;
      if (count > 0) {
        covered += 1;
      }
    }
  }
  return { totalLines: total, coveredLines: covered, pct: percent(covered, total) };
}

/**
 * Totals reconciled against the PROJECT: the number `coverage_fail_under` is
 * a floor for.
 *
 * Two corrections to the raw aggregate, both stated in the result so the
 * gate's output can say what was counted:
 *
 *  - only files under `sourcePaths` count. A runner that instruments the test
 *    files, or a vendored tree, must not move the project's number;
 *  - every source file the report does NOT mention counts with all of its
 *    statement lines uncovered. Every runner reports only what the test run
 *    loaded, so a file no test imports is absent — not 0% — and a percentage
 *    over the present files alone is a percentage over whichever files
 *    happened to load. `coverage/inventory.ts` says where the line count
 *    for such a file comes from and why that is the honest choice.
 */
export interface ProjectTotals extends CoverageTotals {
  /** Files in the report that lie under the source paths; only these count. */
  readonly measuredFiles: number;
  /** Files in the report altogether, for the message when none counts. */
  readonly reportFiles: number;
  /** Source files the report does not mention, in inventory order. */
  readonly unloaded: readonly SourceFileEntry[];
  /** Source files in the inventory. */
  readonly sourceFiles: number;
}

export function projectTotals(
  report: LineCoverageReport,
  root: string,
  sourcePaths: readonly string[],
  inventory: readonly SourceFileEntry[],
): ProjectTotals {
  const prefixes = sourcePaths.map((path) => `${path.replace(/\/+$/u, "")}/`);
  const measured = new Set<string>();
  let total = 0;
  let covered = 0;
  for (const file of report.files) {
    const key = relativeKey(file.path, root);
    if (!prefixes.some((prefix) => key.startsWith(prefix))) {
      continue;
    }
    measured.add(key);
    for (const count of file.lineHits.values()) {
      total += 1;
      if (count > 0) {
        covered += 1;
      }
    }
  }
  const unloaded = inventory.filter((entry) => !measured.has(entry.path));
  for (const entry of unloaded) {
    total += entry.statementLines;
  }
  return {
    totalLines: total,
    coveredLines: covered,
    pct: percent(covered, total),
    measuredFiles: measured.size,
    reportFiles: report.files.length,
    unloaded,
    sourceFiles: inventory.length,
  };
}

/**
 * istanbul's `percent()`, reproduced exactly.
 *
 * FLOORED to two decimals, not rounded: 79.999% must not display as 80.00% and
 * pass an 80% threshold. And `total === 0` yields 100, not 0 — a file with no
 * executable lines is fully covered, and dividing by zero into a failure would
 * fail every project whose coverage run measured nothing measurable. The
 * caller is responsible for noticing that an EMPTY report means coverage was
 * not collected; see `coverageUnavailable` in `adapters/testRunner.ts`.
 */
function percent(covered: number, total: number): number {
  if (total <= 0) {
    return 100;
  }
  return Math.floor((1000 * 100 * covered) / total / 10) / 100;
}

function isMissingFile(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code: unknown = error.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
