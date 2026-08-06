/**
 * Gate catalog: assembles the concrete `check` and `security` pipelines.
 *
 * The analogue of `kragg/src/kragg/catalog.py`, and the one place that knows
 * which gates exist, in what order, and in which tier. Everything below it is
 * a gate that answers one question; everything above it is a command that
 * renders results. Nothing else may assemble a pipeline — a second assembly
 * point is how `check` and a hook start enforcing different rules.
 *
 * Three semantics come from Python unchanged, and they are the design:
 *
 *  1. A policy-driven gate with nothing configured SKIPS VISIBLY. See
 *     `unconfigured` in `catalog/context.ts`.
 *  2. A gate needing criticality data skips with "run `kragg criticality
 *     --write`" when `.kragg/criticality.json` is absent, rather than passing
 *     on an empty set. See `noCriticalityReason`.
 *  3. SLOW gates skip once any FAST gate has failed. `runGates` owns that, so
 *     the catalog only has to assign tiers correctly.
 *
 * The fourth is TypeScript-specific and is in `catalog/context.ts`: ONE
 * `ts.Program` per run, created lazily and shared by every type-aware gate.
 */

import type { GateSpec } from "./engine/gate.ts";
import { checkPipeline } from "./catalog/check.ts";
import { catalogContext, type CatalogOptions } from "./catalog/context.ts";
import { auditGate, forbiddenCallsGate, secretGates } from "./catalog/security.ts";

export type { CatalogOptions, CatalogContext } from "./catalog/context.ts";

/** Assemble the full `kragg check` pipeline. */
export function buildCheckGates(options: CatalogOptions): GateSpec[] {
  return checkPipeline(catalogContext(options));
}

/**
 * Assemble the `kragg security` pipeline.
 *
 * A strict subset of `check`, built from the same factories so the two cannot
 * drift. Everything here is also in `check`; the point of the shorter pipeline
 * is that it is cheap enough to run on every push, not that it is different.
 */
export function buildSecurityGates(options: CatalogOptions): GateSpec[] {
  const ctx = catalogContext(options);
  return [forbiddenCallsGate(ctx), ...secretGates(ctx), auditGate(ctx)];
}
