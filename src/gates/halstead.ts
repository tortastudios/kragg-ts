/**
 * Halstead complexity gate: operator/operand volume, difficulty and effort.
 *
 * Ported from `kragg/src/kragg/gates/halstead.py`, which delegates the actual
 * counting to `radon.metrics.h_visit`. There is no radon for TypeScript and
 * kragg-ts takes no dependencies, so the counting is native here: one walk of
 * the TypeScript AST per file, partitioning nodes into operators and operands
 * and applying the standard Halstead definitions.
 *
 * WHAT IS PORTED VERBATIM. The thresholds (`MAX_EFFORT`, `MAX_DIFFICULTY`,
 * `MAX_BUGS`), the `HalsteadFailure` shape, the `file::function` location
 * form, and the rule that only FUNCTIONS are checked — file-level code is
 * measured (the MI gate needs the file volume) but never fails the gate.
 *
 * WHAT COULD NOT BE PORTED. Radon's operator/operand partition is defined
 * over the Python AST and is deliberately narrow: it counts operators for
 * `BinOp`, `UnaryOp`, `BoolOp`, `AugAssign` and `Compare` and nothing else —
 * a call, an attribute access and a plain assignment contribute no operator at
 * all. Reproducing that literally in TypeScript would measure almost nothing,
 * so `halstead/partition.ts` uses the CLASSIC Halstead partition instead. It
 * counts strictly more than radon does, which means volume, difficulty and
 * effort all read HIGHER here than radon would report for equivalent Python.
 * The thresholds are radon's, unchanged; see the calibration note on
 * `MAX_EFFORT`.
 *
 * TYPE SYNTAX IS NOT CODE. Type annotations, type parameters, interfaces,
 * type aliases and type-only imports are skipped entirely (`isTypeOnlyNode`).
 * They are erased before anything runs, so counting them would make a
 * well-annotated function look mentally harder than an unannotated one — the
 * exact opposite of the truth.
 *
 * THIS FILE IS THE PUBLIC ENTRY POINT and nothing else. The gate lives in four
 * single-concern modules:
 *
 *  - `halstead/metrics.ts` — the counts, the derived metrics, the ceilings;
 *  - `halstead/blocks.ts` — what a function block is and what it is called,
 *    shared with the complexity gate so the two never disagree;
 *  - `halstead/partition.ts` — which nodes are operators, which are operands,
 *    and which are type syntax that must not be counted at all;
 *  - `halstead/walk.ts` — the single AST walk that applies the partition;
 *  - `halstead/report.ts` — thresholds to failures, violations and text.
 */

export type {
  HalsteadBlock,
  HalsteadCounts,
  HalsteadFailure,
  HalsteadFileReport,
  HalsteadMetrics,
  HalsteadOptions,
  HalsteadThresholds,
} from "./halstead/metrics.ts";
export {
  halsteadMetrics,
  MAX_BUGS,
  MAX_DIFFICULTY,
  MAX_EFFORT,
} from "./halstead/metrics.ts";

export type { FunctionBlockNode } from "./halstead/blocks.ts";
export { functionBlockLabel, isFunctionBlock } from "./halstead/blocks.ts";

export { fileHalstead } from "./halstead/walk.ts";

export {
  checkSource,
  formatHalsteadFailure,
  halsteadFailures,
  halsteadViolations,
} from "./halstead/report.ts";
