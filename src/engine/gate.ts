/**
 * Gate pipeline engine: run gate specs, collecting structured results.
 *
 * Ported from `kragg/src/kragg/check.py`, preserving its semantics exactly:
 *
 * - Fast gates (static analysis) ALL run, even after one fails, so a single
 *   invocation reveals every failure. An agent should never have to run the
 *   pipeline N times to discover N problems.
 * - Slow gates (test suites, audits) are skipped once any fast gate has
 *   failed, since their results would be invalidated by the fixes anyway.
 *   `forceSlow` overrides this.
 * - `failFast` halts the pipeline after the first failure of any tier; every
 *   remaining gate is reported as skipped with reason "fail-fast" rather than
 *   omitted, so the report still accounts for the whole pipeline.
 *
 * The concrete pipelines will be assembled in a future `catalog.ts`.
 */

import { gateResult, type GateResult } from "./models.ts";

export const FAST = "fast";
export const SLOW = "slow";

export type Tier = typeof FAST | typeof SLOW;

/** One gate in the pipeline: a name, a tier, and how to run it. */
export interface GateSpec {
  readonly name: string;
  readonly tier: Tier;
  readonly run: () => GateResult | Promise<GateResult>;
  /**
   * Set to skip this gate unconditionally, with this reason shown to the
   * user (e.g. "no TypeScript files changed"). Takes precedence over the
   * tier rules but not over fail-fast.
   */
  readonly skipReason?: string | undefined;
}

export interface RunGatesOptions {
  readonly failFast?: boolean;
  readonly forceSlow?: boolean;
}

/**
 * Run gates in order, timing each; slow gates skip when fast gates failed.
 *
 * TODO(concurrency): gates backed by subprocesses are independent and should
 * run concurrently within a tier — run all FAST gates with `Promise.all`,
 * then decide on the SLOW tier from the collected results. The Python
 * implementation is sequential and this port matches it deliberately so the
 * two can be diffed; changing it is a behaviour change, not a refactor,
 * because it affects `durationMs` and output interleaving. Do it as its own
 * commit, with the ordering of `results` still matching `specs`.
 */
export async function runGates(
  specs: readonly GateSpec[],
  options: RunGatesOptions = {},
): Promise<GateResult[]> {
  const failFast = options.failFast ?? false;
  const forceSlow = options.forceSlow ?? false;

  const results: GateResult[] = [];
  let fastFailed = false;
  let halted = false;

  for (const spec of specs) {
    const reason = skipReasonFor(spec, { fastFailed, halted, forceSlow });
    if (reason !== null) {
      results.push(
        gateResult({
          name: spec.name,
          passed: false,
          skipped: true,
          skipReason: reason,
        }),
      );
      continue;
    }
    const result = await timed(spec.run);
    results.push(result);
    if (!result.passed) {
      fastFailed = fastFailed || spec.tier === FAST;
      halted = halted || failFast;
    }
  }
  return results;
}

interface SkipState {
  readonly fastFailed: boolean;
  readonly halted: boolean;
  readonly forceSlow: boolean;
}

/** Why this gate should not run, or `null` if it should. Order matters. */
function skipReasonFor(spec: GateSpec, state: SkipState): string | null {
  if (state.halted) {
    return "fail-fast";
  }
  if (spec.skipReason !== undefined) {
    return spec.skipReason;
  }
  if (spec.tier === SLOW && state.fastFailed && !state.forceSlow) {
    return "static gates failed";
  }
  return null;
}

async function timed(run: GateSpec["run"]): Promise<GateResult> {
  // performance.now() is monotonic: immune to wall-clock adjustments mid-run,
  // matching Python's time.monotonic().
  const start = performance.now();
  const result = await run();
  return { ...result, durationMs: Math.trunc(performance.now() - start) };
}
