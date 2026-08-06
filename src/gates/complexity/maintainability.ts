/**
 * Maintainability index — the `radon-mi` half of the complexity gate.
 *
 * The formula, the grade bands and the `MI-x` codes are ported unchanged from
 * `parse_radon_mi`; only the inputs are computed natively, because there is no
 * radon for TypeScript.
 */

import type ts from "typescript";

import { parsedSources, resolveTypeScript, type TypeScriptApi } from "../../analysis/sourceFile.ts";
import type { Violation } from "../../engine/models.ts";
import { fileHalstead } from "../halstead/walk.ts";
import { fileComplexity } from "./cyclomatic.ts";
import { miExceeds, miRank, MI_MIN_GRADE, type ComplexityOptions, type MiGrade } from "./grades.ts";
import { lineMetrics, type LineMetrics } from "./lines.ts";

/** Everything the MI formula consumed, kept for reporting and tests. */
export interface MaintainabilityReport {
  readonly mi: number;
  readonly grade: MiGrade;
  readonly volume: number;
  readonly complexity: number;
  readonly lines: LineMetrics;
  /** Comment lines as a percentage of SLOC. */
  readonly commentPercent: number;
}

/**
 * Radon's maintainability index — the normalized 0-100 variant, NOT the raw
 * SEI formula.
 *
 * Source: `radon.metrics.mi_compute` (radon 6.x), which computes
 *
 *   nn_mi = 171
 *         - 5.2  * ln(V)
 *         - 0.23 * G
 *         - 16.2 * ln(L)
 *         + 50   * sin(sqrt(2.46 * radians(C)))
 *   MI    = clamp(nn_mi * 100 / 171, 0, 100)
 *
 * where V is the Halstead volume of the whole file, G its total cyclomatic
 * complexity, L its LOGICAL lines of code and C the percentage of comment
 * lines. The comment term IS part of radon's default — `radon mi` runs with
 * `multi=True`, and `mi_parameters` always passes the comment percentage —
 * and it matters enormously: it is worth up to +50 points before normalizing,
 * peaking near 57% comments.
 *
 * Two details are easy to get wrong and are called out because they change
 * the number by a lot:
 *
 *  - `mi_compute`'s third parameter is NAMED `sloc` and is CALLED with
 *    `raw.lloc`. It is logical lines, not source lines. This port passes
 *    logical lines to match.
 *  - the comment percentage is fed through `math.radians` before the sqrt, so
 *    the term is `sin(sqrt(2.46 * C * pi / 180))`, not `sin(sqrt(2.46 * C))`.
 *
 * A file with no volume or no logical lines scores 100 — radon's own guard
 * against `ln(0)`, and the right answer for an empty or declaration-only file.
 */
export function maintainabilityIndex(
  volume: number,
  complexity: number,
  logicalLines: number,
  commentPercent: number,
): number {
  if (volume <= 0 || logicalLines <= 0) {
    return 100;
  }
  const commentsScale = Math.sqrt(2.46 * ((commentPercent * Math.PI) / 180));
  const raw =
    171 -
    5.2 * Math.log(volume) -
    0.23 * complexity -
    16.2 * Math.log(logicalLines) +
    50 * Math.sin(commentsScale);
  return Math.min(Math.max(0, (raw * 100) / 171), 100);
}

/** Everything `radon mi` computes for one file, with the inputs kept. */
export function fileMaintainability(
  sourceFile: ts.SourceFile,
  api: TypeScriptApi,
): MaintainabilityReport {
  const lines = lineMetrics(sourceFile, api);
  const volume = fileHalstead(sourceFile, api).total.volume;
  const complexity = fileComplexity(sourceFile, api).total;
  const commentPercent = lines.sloc === 0 ? 0 : (lines.commentLines / lines.sloc) * 100;
  const mi = maintainabilityIndex(volume, complexity, lines.lloc, commentPercent);
  return { mi, grade: miRank(mi), volume, complexity, lines, commentPercent };
}

/**
 * Maintainability violations, in the shape `parse_radon_mi` produces: one per
 * FILE graded below the minimum, with no line and no fix hint — the finding
 * is about the file as a whole, and pointing at a line would be a lie.
 */
export function maintainabilityViolations(
  root: string,
  sourcePaths: readonly string[],
  options: ComplexityOptions = {},
): Violation[] {
  const api = options.api ?? resolveTypeScript(root).api;
  const limit = options.minGrade ?? MI_MIN_GRADE;
  const violations: Violation[] = [];
  for (const source of parsedSources(root, sourcePaths, { api })) {
    const report = fileMaintainability(source.sourceFile, api);
    if (miExceeds(report.grade, limit)) {
      violations.push({
        message: `maintainability index grade ${report.grade} (minimum: ${limit})`,
        file: source.relative,
        code: `MI-${report.grade}`,
      });
    }
  }
  return violations;
}
