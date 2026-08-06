/**
 * The grade bands both complexity metrics are scored against.
 *
 * Split out of `gates/complexity.ts` so the two metrics that consume them —
 * the cyclomatic walk and the maintainability formula — can live in modules of
 * their own without either owning the vocabulary the other reads.
 *
 * CALIBRATION IS NOT PORTED, BECAUSE IT CANNOT BE. Radon's bands were drawn
 * against Python. TypeScript spends more tokens per unit of logic and, in the
 * MI formula, that lands on both the volume term and the line-count term. The
 * measured effect on real code is documented on `MI_MIN_GRADE`. The ported
 * numbers are left exactly as they are; re-tuning them is a policy decision.
 */

import type { TypeScriptApi } from "../../analysis/sourceFile.ts";

/**
 * Cyclomatic grade bands, from `radon.complexity.cc_rank`: A 1-5, B 6-10,
 * C 11-20, D 21-30, E 31-40, F 41+.
 */
export const CC_GRADES = ["A", "B", "C", "D", "E", "F"] as const;

/** One of radon's six cyclomatic grades. */
export type CcGrade = (typeof CC_GRADES)[number];

/**
 * The worst grade a block may carry. `catalog.py` runs `radon cc -n C`, i.e.
 * it asks radon to print blocks graded C or worse and fails on any output, so
 * B is the ceiling and C is the first failing grade.
 *
 * Hardcoded because `KraggPolicy` has no field for it in either language. If
 * one is ever added, `cyclomaticViolations` already accepts an override.
 *
 * MEASURED (kragg-ts `src/`, 351 blocks, 2026-08): A 269, B 64, C 15, D 3 —
 * 18 blocks, 5%, fail. The Python sibling's `src/` (419 blocks) has NOTHING
 * worse than B, so this threshold is silent there and noisy here. Two causes,
 * both idiomatic TypeScript rather than real complexity: exhaustive `switch`
 * dispatch over `SyntaxKind` (the two worst blocks are 25 and 22 `case`
 * clauses and nothing else), and the `||`/`??` default-value idiom, which
 * accounts for 272 of the 967 decision points measured. Optional chaining, the
 * one judgement call in the list above, accounts for 18 and changes no grade
 * at all. Excluding `case` clauses would drop the failures from 18 to 14.
 */
export const CC_MAX_GRADE: CcGrade = "B";

/** Maintainability grades, from `radon.metrics.mi_rank`. */
export type MiGrade = "A" | "B" | "C";

/**
 * The worst maintainability grade a FILE may carry.
 *
 * `parse_radon_mi` emits a violation for every file whose grade is not A, so
 * the effective threshold is MI > 19.
 *
 * MEASURED (kragg-ts `src/`, 20 files, 2026-08): every file grades A, with the
 * minimum at 23.0 and the median at 55.4. The Python sibling's own `src/`
 * measures the same way — all A, minimum 19.8 — so this threshold ports
 * ACROSS the language boundary better than one would expect. The wider
 * Halstead partition (see `halstead.ts`) pushes the `-5.2*ln(volume)` term
 * down, and TypeScript's heavier line count pushes `-16.2*ln(lloc)` down with
 * it, but both are logarithmic and this codebase's comment density earns the
 * `+50*sin(...)` term back. Do not read that as headroom: the two worst files
 * sit 4 points above failing.
 */
export const MI_MIN_GRADE: MiGrade = "A";

/** Options for the path-walking entry points. */
export interface ComplexityOptions {
  /** Compiler to analyze with. Defaults to `resolveTypeScript(root).api`. */
  readonly api?: TypeScriptApi | undefined;
  /** Worst permitted cyclomatic grade. Defaults to `CC_MAX_GRADE`. */
  readonly maxGrade?: CcGrade | undefined;
  /** Worst permitted maintainability grade. Defaults to `MI_MIN_GRADE`. */
  readonly minGrade?: MiGrade | undefined;
}

/** Grade a score with radon's bands. Negative scores are impossible. */
export function ccRank(score: number): CcGrade {
  // `radon.complexity.cc_rank`: ceil(score / 10), floored at 1, minus one
  // more band for the 1-5 range, capped at F.
  const band = (Math.ceil(score / 10) || 1) - (score <= 5 ? 1 : 0);
  return CC_GRADES[Math.min(Math.max(band, 0), 5)] ?? "F";
}

/** Whether `grade` is worse than `limit` (later letter = worse). */
export function ccExceeds(grade: CcGrade, limit: CcGrade): boolean {
  return CC_GRADES.indexOf(grade) > CC_GRADES.indexOf(limit);
}

/** Radon's `mi_rank`: A above 19, B above 9, C at or below 9. */
export function miRank(score: number): MiGrade {
  if (score > 19) {
    return "A";
  }
  return score > 9 ? "B" : "C";
}

/** Whether `grade` is worse than `limit` (later letter = worse). */
export function miExceeds(grade: MiGrade, limit: MiGrade): boolean {
  const order: readonly MiGrade[] = ["A", "B", "C"];
  return order.indexOf(grade) > order.indexOf(limit);
}
