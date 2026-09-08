/**
 * `kragg coverage` — the uncovered lines that actually matter, ranked.
 *
 * The port of `kragg/src/kragg/coverage.py` and its `cmd_coverage`. The
 * Python module's docstring is the design brief and it is worth restating,
 * because every decision below follows from it: THE PERCENTAGE IS THE WEAK,
 * GAMEABLE SIGNAL KRAGG DELIBERATELY DEMOTES. A repo at 92% can have its
 * highest-fan-in function entirely untested; a repo at 71% can be defended
 * exactly where it matters. So this command never prints a dashboard number.
 * It prints the GAP — uncovered lines inside critical functions, ranked by
 * fan-in, as `file:line` pointers an agent can act on without asking a
 * follow-up question.
 *
 * ── IT IS A REPORT, NOT A GATE ─────────────────────────────────────────────
 * Exit code is always `0`, including the "no coverage data" case, where it
 * prints `no coverage data (run \`kragg check\` first)` and stops — byte for
 * byte what `cmd_coverage` prints. The gating equivalent is
 * `gates/criticalCoverage.ts`, which fails the build on the same data. Two
 * surfaces, one computation: this command calls `criticalCoverageGaps`, the
 * function that gate already exports, so the report and the gate can never
 * disagree about what is uncovered.
 *
 * ── WHERE THE DATA COMES FROM ──────────────────────────────────────────────
 * coverage.py hands Python a per-function `missing_lines` list. The
 * JavaScript ecosystem has nothing equivalent — it has istanbul's raw
 * `coverage-final.json` from vitest and lcov tracefiles from `node --test` and
 * `bun test`. `coverage/istanbul.ts` and `coverage/lcov.ts` normalise both
 * into the one line model. Nothing here re-parses a report; this command
 * only decides which artifact to look for.
 *
 * ── THE UNMEASURED ROW IS NOT A ZERO ───────────────────────────────────────
 * A critical function with no unambiguous entry in the report is reported
 * separately, as `no coverage entry`, and is NOT counted as covered or
 * uncovered. Python calls this `measured=False` and prints "no test imports
 * it"; the TypeScript phrasing is deliberately weaker, because in this
 * ecosystem the likelier cause is a name collision inside `fnMap` (two
 * same-named functions in one file, which istanbul cannot tell apart) or a
 * path-key mismatch, not an untested function. Saying "no test imports it"
 * here would be a confident claim about something that was never measured.
 */

import { isAbsolute, join } from "node:path";

import { readTextFile } from "../adapters/support/manifest.ts";
import type { TypeScriptApi } from "../analysis/sourceFile.ts";
import { readIstanbulReport } from "../coverage/istanbul.ts";
import { EXIT_OK, EXIT_USAGE } from "../engine/report.ts";
import {
  criticalCoverageGaps,
  type CriticalCoverageGap,
} from "../gates/criticalCoverage.ts";
import { loadPolicy, PolicyError, type KraggPolicy } from "../policy/policy.ts";

/** What `cmd_coverage` prints when the report is missing. Exit code stays 0. */
export const NO_COVERAGE_DATA_MESSAGE = "no coverage data (run `kragg check` first)";

/**
 * Where the istanbul report is looked for, in order.
 *
 * vitest's own default first, then `.kragg/`, which is where a runner that
 * had to be pointed somewhere (node:test, or a converted Bun report) is told
 * to write. Both are checked because the alternative — one hard-coded path —
 * makes the command print "no coverage data" on a project that has plenty.
 */
export const DEFAULT_REPORT_PATHS: readonly string[] = [
  join("coverage", "coverage-final.json"),
  join(".kragg", "coverage-final.json"),
];

/**
 * Where the lcov tracefile is looked for, in order.
 *
 * `node --test` and `bun test` cannot write istanbul JSON at all — node's
 * reporters are `spec`/`dot`/`tap`/`junit`/`lcov` and bun's coverage reporters
 * are `text` and `lcov`. Without these paths this command printed "no coverage
 * data" on two of the three runners kragg drives, however much coverage the
 * project had.
 */
export const DEFAULT_LCOV_PATHS: readonly string[] = [
  join("coverage", "lcov.info"),
  join(".kragg", "lcov.info"),
];

/** How many uncovered lines are listed before `+N more`, as in Python. */
export const LINE_CAP = 12;

/** Inputs for {@link runCoverage}. Everything optional so the CLI can pass a subset. */
export interface CoverageOptions {
  /** Project root. Defaults to the current working directory. */
  readonly root?: string | undefined;
  /**
   * Explicit istanbul report path, relative to the root or absolute. When
   * absent, {@link DEFAULT_REPORT_PATHS} are tried in order.
   */
  readonly reportPath?: string | undefined;
  /** Pre-loaded policy. Loaded from the root when absent. */
  readonly policy?: KraggPolicy | undefined;
  /** Compiler used to map modules to files. Defaults to the project's own. */
  readonly api?: TypeScriptApi | undefined;
}

/**
 * Print criticality-ranked coverage gaps.
 *
 * Always `0` except on a malformed `kragg.json`. Missing coverage data is a
 * state, not a failure — see the module header.
 */
export async function runCoverage(options: CoverageOptions = {}): Promise<number> {
  const root = options.root ?? process.cwd();
  let policy: KraggPolicy;
  try {
    policy = options.policy ?? loadPolicy(root);
  } catch (error) {
    if (error instanceof PolicyError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }
  const report = readReport(root, options.reportPath);
  const lcov = report === null ? readLcovText(root) : null;
  if (report === null && lcov === null) {
    process.stdout.write(`${NO_COVERAGE_DATA_MESSAGE}\n`);
    return EXIT_OK;
  }
  const gaps = criticalCoverageGaps({
    root,
    sourcePaths: policy.sourcePaths,
    report,
    ...(lcov === null ? {} : { lcov }),
    ...(options.api === undefined ? {} : { api: options.api }),
  });
  process.stdout.write(`${renderGaps(gaps).join("\n")}\n`);
  return EXIT_OK;
}

/**
 * Read the istanbul report from the first candidate path that parses.
 *
 * `null` means no usable report anywhere — missing, unreadable, or not JSON.
 * A file that parses to a non-object is also `null`: `normalizeIstanbul`
 * would return an empty model for it, and an empty model renders as "every
 * critical function is unmeasured", which reads as a finding when it is
 * really a broken input.
 */
export function readReport(root: string, reportPath?: string | undefined): unknown {
  const candidates = reportPath === undefined ? DEFAULT_REPORT_PATHS : [reportPath];
  for (const candidate of candidates) {
    const parsed = readIstanbulReport(
      isAbsolute(candidate) ? candidate : join(root, candidate),
    );
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
  }
  return null;
}

/**
 * The first lcov tracefile that has any content, or `null`.
 *
 * Tried only when no istanbul report was found: istanbul states each
 * function's full body span and lcov states only where it starts, so the
 * richer document wins when a project somehow has both.
 */
export function readLcovText(root: string): string | null {
  for (const candidate of DEFAULT_LCOV_PATHS) {
    const text = readTextFile(join(root, candidate));
    if (text !== undefined && text.trim() !== "") {
      return text;
    }
  }
  return null;
}

/**
 * Render gaps as token-efficient lines: a summary, then only the actionable
 * rows.
 *
 * CLEAN FUNCTIONS ARE COUNTED AND NOT LISTED. That is the whole economy of
 * this output — a repo with 40 critical functions and 3 gaps prints four
 * lines, not forty. Python makes the same choice, and it is why this fits in
 * an agent's context where a coverage table would not.
 */
export function renderGaps(gaps: readonly CriticalCoverageGap[]): string[] {
  if (gaps.length === 0) {
    return ["no critical functions (run `kragg criticality --write`)"];
  }
  const withGaps = gaps.filter((row) => row.measured && row.missingLines.length > 0);
  const unmeasured = gaps.filter((row) => !row.measured);
  const clean = gaps.length - withGaps.length - unmeasured.length;
  const lines = [
    `critical coverage: ${gaps.length} functions, ${withGaps.length} with gaps, ` +
      `${clean} clean, ${unmeasured.length} unmeasured`,
  ];
  lines.push(...withGaps.map(gapLine));
  lines.push(...unmeasured.map(unmeasuredLine));
  return lines;
}

/**
 * One gap, as a `file:line` pointer.
 *
 * The FIRST uncovered line is put in the `file:line` position because that is
 * the one an editor jumps to; the rest follow as a list. Python prints the
 * bare filename and then the lines, which makes the most useful line number
 * un-clickable.
 */
function gapLine(row: CriticalCoverageGap): string {
  const first = row.missingLines[0] ?? 1;
  return (
    `  ${row.file}:${first} ${row.qualname} (${why(row)}) ` +
    `— uncovered: ${formatLines(row.missingLines)}`
  );
}

function unmeasuredLine(row: CriticalCoverageGap): string {
  return `  ${row.file} ${row.qualname} (${why(row)}) — no coverage entry`;
}

/**
 * What makes this function worth the strictest bar in the tool.
 *
 * A reviewer's `critical_functions` reason where there is one, and the fan-in
 * otherwise. A declared authorization entrypoint printed as `(fan-in 1)` reads
 * as noise, which is how a report like this gets ignored.
 */
function why(row: CriticalCoverageGap): string {
  return row.declaredReason === undefined
    ? `fan-in ${String(row.fanIn)}`
    : `declared: ${row.declaredReason}`;
}

/** `3, 4, 9, +7 more` — capped, because a 200-line list is not a pointer. */
function formatLines(lines: readonly number[]): string {
  const shown = lines.slice(0, LINE_CAP).join(", ");
  return lines.length > LINE_CAP ? `${shown}, +${lines.length - LINE_CAP} more` : shown;
}
