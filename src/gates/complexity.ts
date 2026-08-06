/**
 * Cyclomatic complexity and maintainability index — the `radon-cc` and
 * `radon-mi` gates, natively.
 *
 * Python kragg shells out to `radon cc -s -n C` and `radon mi -s` and parses
 * the text (`parse_radon_cc` / `parse_radon_mi` in `parsers.py`). There is no
 * radon for TypeScript and kragg-ts takes no dependencies, so both metrics are
 * computed here over the TypeScript AST. The GRADE BANDS, the failure
 * thresholds, the violation messages and the `CC-x` / `MI-x` codes are ported
 * unchanged, so a polyglot repo sees one vocabulary from both siblings.
 *
 * CALIBRATION IS NOT PORTED, BECAUSE IT CANNOT BE. Radon's bands were drawn
 * against Python. TypeScript spends more tokens per unit of logic and, in the
 * MI formula, that lands on both the volume term and the line-count term. The
 * measured effect on real code is documented on `MI_MIN_GRADE`. The ported
 * numbers are left exactly as they are; re-tuning them is a policy decision.
 *
 * THIS FILE IS THE PUBLIC ENTRY POINT and nothing else. The three concerns it
 * used to hold live in one module each:
 *
 *  - `complexity/grades.ts` — the grade bands both metrics are scored against;
 *  - `complexity/cyclomatic.ts` — the decision-point walk and its gate;
 *  - `complexity/lines.ts` — physical and logical line accounting;
 *  - `complexity/maintainability.ts` — the MI formula and its gate.
 */

export type { CcGrade, ComplexityOptions, MiGrade } from "./complexity/grades.ts";
export {
  ccExceeds,
  ccRank,
  CC_GRADES,
  CC_MAX_GRADE,
  miExceeds,
  miRank,
  MI_MIN_GRADE,
} from "./complexity/grades.ts";

export type { ComplexityBlock } from "./complexity/cyclomatic.ts";
export { cyclomaticViolations, fileComplexity } from "./complexity/cyclomatic.ts";

export type { LineMetrics } from "./complexity/lines.ts";
export { lineMetrics, logicalLines } from "./complexity/lines.ts";

export type { MaintainabilityReport } from "./complexity/maintainability.ts";
export {
  fileMaintainability,
  maintainabilityIndex,
  maintainabilityViolations,
} from "./complexity/maintainability.ts";
