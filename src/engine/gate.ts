/**
 * Gate pipeline engine: run gate specs, collecting structured results.
 *
 * Ported from `kragg/src/kragg/check.py`:
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
 * A SKIP IS NOT A FAILURE, and this is the one place that has to be taught it.
 * A visible skip is spelled `passed: false, skipped: true` (see
 * `catalog/results.ts`), so the obvious `!result.passed` test counts one as a
 * failure — and a gate that decides to skip from INSIDE its own run, which no
 * `skipReason` on the spec could have predicted, then silences the whole slow
 * tier. On this very repo that was the case that matters: no secret scanner
 * installed, so `detect-secrets` skipped, so `test-coverage`,
 * `critical-coverage` and `audit` all skipped with "static gates failed" — 14
 * green gates, exit 0, and the test suite never run. SPEC.md §2.3 and §4.1
 * make the three states a contract and count `gates_failed` as
 * "not passed and not skipped", so only a gate that RAN and did not pass may
 * halt anything here. `error: true` is neither, so it still counts.
 *
 * A GATE THAT THROWS IS AN ERRORED GATE, not a dead process. `run` is
 * arbitrary code over an untrusted project tree; before, an exception
 * propagated out of `runGates` and `cli.ts` turned it into a bare stderr line
 * and exit 3, throwing away every other gate's result and the consolidated
 * report with them. SPEC.md §4.3 already names the honest outcome for a gate
 * that could not run — `error: true`, `passed: false`, remediation in
 * `raw_output`, exit 3 — and that is what the catch produces, so the rest of
 * the pipeline still runs and still reports. The exception is not swallowed:
 * its message is the gate's output and reaches both renderers.
 *
 * The concrete pipelines are assembled in `catalog.ts`.
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
    const result = await timed(spec);
    results.push(result);
    // `skipped` is the guard, not `passed` alone: a gate that stepped aside
    // found nothing wrong, so it must not cost the slow tier its run nor halt
    // the pipeline. A gate that errored — including one that threw — is
    // neither passed nor skipped, so it still counts, which is the
    // fail-closed reading: nothing was learned about the code, so the slow
    // tier's results would be built on the same broken environment. Exit 3
    // outranks either way. See the module header.
    if (!result.passed && !result.skipped) {
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

async function timed(spec: GateSpec): Promise<GateResult> {
  // performance.now() is monotonic: immune to wall-clock adjustments mid-run,
  // matching Python's time.monotonic().
  const start = performance.now();
  const result = await ranOrThrew(spec);
  return { ...result, durationMs: Math.trunc(performance.now() - start) };
}

/**
 * Run one gate, turning an exception into the errored result it really is.
 *
 * The MESSAGE ONLY, deliberately, and no stack: `processGate` keeps the TAIL
 * of an over-long `raw_output`, so a stack appended here would be the part
 * that survives and the message the part that gets cut. The `Fix:` line is
 * what `next_actions` surfaces for an errored gate (`reportPayload.ts`), and
 * it says the honest thing — this is not a finding about the project's code.
 */
async function ranOrThrew(spec: GateSpec): Promise<GateResult> {
  try {
    return await spec.run();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return gateResult({
      name: spec.name,
      passed: false,
      error: true,
      output:
        `the ${spec.name} gate threw and produced no result: ${message}\n` +
        "Fix: this is a failure inside the gate, not a finding about your " +
        "code — re-run to confirm it reproduces, then report it with the " +
        "message above.",
    });
  }
}
