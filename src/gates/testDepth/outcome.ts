/**
 * The outcome type the three test-depth gates share.
 *
 * `forbiddenCalls.ts` needs two states — findings, or "I could not run". These
 * three need a THIRD, and it is the one AGENTS.md's hard rule is about: a gate
 * whose input is missing must SKIP VISIBLY, never pass. `critical-tests` and
 * `critical-coverage` both depend on `.kragg/criticality.json`, which a repo
 * that has never run `kragg criticality --write` simply does not have; the
 * Python sibling handles that in the catalog, via
 * `catalog._no_criticality_reason` on the `GateSpec`, so its gate functions
 * only ever return violations. Here the gates own the check, because the
 * reason must travel with the gate that knows why it could not run.
 *
 * The three states are distinguishable without a `kind` tag: `ok: false` is a
 * failure to run at all, and `skipped` separates the two `ok: true` cases.
 */

import type { Violation } from "../../engine/models.ts";

/** Findings, a visible skip, or a failure to run. */
export type TestDepthOutcome =
  | {
      readonly ok: true;
      readonly skipped: false;
      readonly violations: readonly Violation[];
    }
  | { readonly ok: true; readonly skipped: true; readonly reason: string }
  | { readonly ok: false; readonly message: string };

/**
 * The skip reason for a repo with no criticality data.
 *
 * Byte-identical to Python's `_no_criticality_reason`, so the two tools tell a
 * user the same thing to type.
 */
export const NO_CRITICALITY_REASON =
  "no criticality data (run `kragg criticality --write`)";

/** The gate ran; these are its findings (possibly none). */
export function ran(violations: readonly Violation[]): TestDepthOutcome {
  return { ok: true, skipped: false, violations };
}

/** The gate did not run, and this is the remediation. */
export function skipped(reason: string): TestDepthOutcome {
  return { ok: true, skipped: true, reason };
}

/**
 * The gate could not run because something is broken.
 *
 * NO CURRENT PATH RETURNS THIS, and that is worth stating rather than leaving
 * a reader to discover it: all three gates are syntax-tier, so there is no
 * program to fail to build the way `forbiddenCalls` can. The variant exists so
 * a caller can handle every gate through one shape, and so a future
 * type-aware check here has somewhere honest to report from.
 */
export function failed(message: string): TestDepthOutcome {
  return { ok: false, message };
}
