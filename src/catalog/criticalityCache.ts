/**
 * DERIVE-WITH-CACHE for `.kragg/criticality.json`.
 *
 * `freshness.ts` makes a stale file harmless: `readJson` refuses it, so no
 * gate can report on functions that no longer exist. That alone would leave
 * the criticality-dependent gates SKIPPING on every run in which anyone
 * touched a source file — which, in an agent's inner loop, is every run. A
 * gate that never runs enforces nothing, so refusing the cache is only half
 * the answer; this module is the other half. When the data is missing or
 * stale, COMPUTE IT rather than step aside.
 *
 * ── WHY THAT IS AFFORDABLE HERE ────────────────────────────────────────────
 * The call graph is expensive because a `ts.Program` is expensive, and this
 * pipeline has already built one: `CatalogContext` carries the single shared
 * handle every type-aware gate uses (see `context.ts` for why that sharing is
 * structural and not an optimization). Deriving on top of an existing program
 * is a graph walk plus a betweenness computation, not a compile.
 *
 * ── LAZY, AND MEASURABLY SO ────────────────────────────────────────────────
 * `ensure` is called from the RUN closures of the three gates that read the
 * data, never while the pipeline is being assembled. A run in which none of
 * them executes — every one skipped, `--changed` with nothing to check, a
 * different command entirely — pays nothing, and the program handle is never
 * even loaded. The memo means the three gates that do run share one
 * derivation.
 *
 * ── WHAT IT WRITES, AND WHAT IT DOES NOT ───────────────────────────────────
 * The JSON and its stamp, and nothing else. Both live under `.kragg/`, which
 * is gitignored, so a `check` never dirties the working tree. `CRITICALITY.md`
 * is NOT written: it is a tracked, human-facing document, and silently
 * rewriting it during an unrelated `check` would put a diff in front of a user
 * who asked for a gate result. `kragg criticality --write` remains the command
 * that regenerates the prose.
 *
 * A derivation that FAILS — an unusable tsconfig, a program that will not
 * build — writes nothing and reports nothing. It does not need to: the stale
 * file is still stale, so `readJson` still refuses it and the gates still skip
 * with the reason they already have. Fail-closed by construction, with no
 * second code path to keep in agreement.
 */

import {
  analyze,
  criticalityPath,
  writeJson,
  writeStamp,
  criticalityFreshness,
} from "../gates/criticality.ts";
import type { AnalysisProgram } from "../analysis/program.ts";

/** What {@link criticalityCache} needs, all of it already on the context. */
export interface CriticalityCacheInput {
  readonly root: string;
  /**
   * The paths whose contents the data is a function of: the policy's sources
   * AND its tests. Both are in the program and both contribute call-graph
   * nodes, so a test-only edit really can change the answer.
   */
  readonly scanPaths: readonly string[];
  /** The run's ONE shared program handle. Still lazy; `ensure` may load it. */
  readonly analysis: AnalysisProgram;
}

/** A lazy, memoized promise that the criticality data on disk is current. */
export interface CriticalityCache {
  /**
   * Make `.kragg/criticality.json` describe the current tree, if it does not
   * already. Idempotent, and at most one derivation per run.
   */
  readonly ensure: () => void;
}

/** Build the handle. Does no work; `ensure` does. */
export function criticalityCache(input: CriticalityCacheInput): CriticalityCache {
  let attempted = false;
  return {
    ensure: (): void => {
      if (attempted) {
        return;
      }
      // Set BEFORE the work, not after: a failed derivation must not be
      // retried by the next gate in the same run. The failure is a broken
      // environment, and it will fail again identically.
      attempted = true;
      if (criticalityFreshness(input.root) === "fresh") {
        return;
      }
      const result = analyze({ analysis: input.analysis });
      if (!result.ok) {
        return;
      }
      try {
        writeJson(result.profiles, criticalityPath(input.root));
      } catch {
        // A read-only checkout still gets to run every gate that does not
        // write. Nothing is stamped, so nothing claims to be fresh.
        return;
      }
      // Stamped only after the data it describes is on disk. The reverse order
      // would, on a write failure, leave a stamp asserting freshness about a
      // file that was never regenerated.
      writeStamp(input.root, input.scanPaths);
    },
  };
}
