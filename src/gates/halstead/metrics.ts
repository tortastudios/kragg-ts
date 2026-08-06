/**
 * The Halstead vocabulary: raw tallies, the derived metrics, and the ceilings
 * a project is measured against.
 *
 * Split out of `gates/halstead.ts` so the walk, the operator/operand partition
 * and the gate entry points can each be read on their own without carrying the
 * definitions along.
 */

import type { TypeScriptApi } from "../../analysis/sourceFile.ts";

/**
 * Effort ceiling, from `halstead.py`. NOT re-derived for TypeScript.
 *
 * CALIBRATION WARNING — THIS THRESHOLD DOES NOT MEAN WHAT IT MEANS IN PYTHON.
 * 50,000 is `halstead.py`'s own number, chosen against radon's narrow Python
 * partition. Measured on the Python sibling's `src/` (384 functions), radon's
 * worst effort score is 446 — a hundredfold below the limit, so the Python
 * gate CANNOT FIRE on that codebase and has never once been tested against a
 * real failure. Measured here (kragg-ts `src/`, 351 functions) with the wider
 * partition this module uses: median 651, p99 24k, worst 108k, and one
 * function over the line. The number is ported unchanged and it does
 * something useful in TypeScript, but it is not the same gate. Moving it is a
 * policy decision and is deliberately left to the user.
 */
export const MAX_EFFORT = 50_000;

/** Difficulty ceiling, from `halstead.py`. See the note on `MAX_EFFORT`. */
export const MAX_DIFFICULTY = 30;

/** Estimated-bugs ceiling, from `halstead.py`. See the note on `MAX_EFFORT`. */
export const MAX_BUGS = 0.4;

/** Raw operator/operand tallies for one block of code. */
export interface HalsteadCounts {
  /** n1: distinct operators. */
  readonly distinctOperators: number;
  /** n2: distinct operands. */
  readonly distinctOperands: number;
  /** N1: total operator occurrences. */
  readonly totalOperators: number;
  /** N2: total operand occurrences. */
  readonly totalOperands: number;
}

/** The derived Halstead metrics, named as in `radon.metrics.HalsteadReport`. */
export interface HalsteadMetrics extends HalsteadCounts {
  /** n = n1 + n2. */
  readonly vocabulary: number;
  /** N = N1 + N2. */
  readonly length: number;
  /** n1*log2(n1) + n2*log2(n2). */
  readonly calculatedLength: number;
  /** V = N * log2(n). */
  readonly volume: number;
  /** D = (n1/2) * (N2/n2). */
  readonly difficulty: number;
  /** E = D * V. */
  readonly effort: number;
  /** T = E / 18, in seconds. */
  readonly time: number;
  /** B = V / 3000. */
  readonly bugs: number;
}

/** One measured function, method, accessor or arrow. */
export interface HalsteadBlock {
  /** Qualified name, e.g. `Runner.run` or `loadPolicy.readTable`. */
  readonly name: string;
  /** 1-based line of the function's first token. */
  readonly line: number;
  readonly metrics: HalsteadMetrics;
}

/** Per-file result: the whole file, plus one entry per function block. */
export interface HalsteadFileReport {
  readonly total: HalsteadMetrics;
  readonly functions: readonly HalsteadBlock[];
}

/**
 * One threshold breach. Mirrors `HalsteadViolation` in `halstead.py`,
 * including its `file::function` location convention.
 */
export interface HalsteadFailure {
  /** `<repo-relative path>::<function name>`. */
  readonly location: string;
  /** `"effort"`, `"difficulty"` or `"estimated bugs"`. */
  readonly metric: string;
  readonly actual: number;
  readonly maximum: number;
  /** 1-based line of the offending function; absent for file-level failures. */
  readonly line?: number | undefined;
}

/** Overridable ceilings, for a future policy field to wire into. */
export interface HalsteadThresholds {
  readonly maxEffort?: number | undefined;
  readonly maxDifficulty?: number | undefined;
  readonly maxBugs?: number | undefined;
}

/** Options shared by the path-walking entry points. */
export interface HalsteadOptions extends HalsteadThresholds {
  /** Compiler to analyze with. Defaults to `resolveTypeScript(root).api`. */
  readonly api?: TypeScriptApi | undefined;
}

/**
 * Derive the Halstead metrics from raw counts.
 *
 * Every formula matches `radon.metrics.halstead_visitor_report`, including
 * its degenerate cases: a zero vocabulary yields zero volume, and a zero
 * operand count yields zero difficulty rather than a division by zero.
 */
export function halsteadMetrics(counts: HalsteadCounts): HalsteadMetrics {
  const n1 = counts.distinctOperators;
  const n2 = counts.distinctOperands;
  const bigN1 = counts.totalOperators;
  const bigN2 = counts.totalOperands;
  const vocabulary = n1 + n2;
  const length = bigN1 + bigN2;
  const calculatedLength =
    n1 > 0 && n2 > 0 ? n1 * Math.log2(n1) + n2 * Math.log2(n2) : 0;
  const volume = vocabulary > 0 ? length * Math.log2(vocabulary) : 0;
  const difficulty = n2 > 0 ? (n1 * bigN2) / (2 * n2) : 0;
  const effort = difficulty * volume;
  return {
    ...counts,
    vocabulary,
    length,
    calculatedLength,
    volume,
    difficulty,
    effort,
    time: effort / 18,
    bugs: volume / 3000,
  };
}
