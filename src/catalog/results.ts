/**
 * The translation layer: every gate's own outcome shape -> one `GateResult`.
 *
 * The gates and adapters in this codebase do NOT share a return type, and that
 * is deliberate — each one models exactly the states it can actually reach, so
 * a two-state gate cannot accidentally claim a third. The cost is paid here,
 * once, and this module is where the exit-code contract is actually decided.
 *
 * THREE OUTCOMES, NEVER TWO. `catalog.py` gets this right through
 * `_native_gate` plus an `error=True` branch, and everything downstream
 * depends on the distinction:
 *
 *  - FAIL  (`passed: false`)                  -> exit 1. The gate ran and the
 *    code is wrong. Fix the code.
 *  - ERROR (`passed: false, error: true`)     -> exit 3. The gate could NOT
 *    run. The findings do not exist, so nothing about the code was learned.
 *    Fix the environment. `reportExitCode` ranks this above exit 1 precisely
 *    because a failure list produced by a half-broken pipeline is not a
 *    failure list anyone should act on.
 *  - SKIP  (`skipped: true`)                  -> exit 0, but PRINTED. The gate
 *    had nothing to check or nothing to check with, and says so.
 *
 * Collapsing ERROR into FAIL makes "your tsconfig is broken" look like "you
 * have type errors". Collapsing SKIP into PASS is worse: it reports a green
 * gate for a check that never happened, which is the single failure mode this
 * whole project exists to prevent. Anything that reads kragg's exit code — a
 * hook, a CI job, an agent deciding whether to keep editing — branches on
 * these three and must never have to parse prose to tell them apart.
 *
 * A skipped gate is built as `passed: false, skipped: true`, matching what
 * `runGates` produces for its own skips and what Python writes on the wire.
 * `reportPassed` treats `skipped` as not-a-failure, so the run is still green;
 * the two spellings must simply not differ between a catalog skip and an
 * engine skip, or the JSON stops being diffable across the siblings.
 */

import type { LintOutcome } from "../adapters/lint.ts";
import type { Unavailable } from "../adapters/support/outcome.ts";
import { gateResult, type GateResult, type Violation } from "../engine/models.ts";
import type { SecretsOutcome } from "../gates/secrets.ts";
import type { TypingStrictnessOutcome } from "../gates/typingStrictness.ts";
import type { TestDepthOutcome } from "../gates/testDepth/outcome.ts";

/** Result for a built-in AST gate: violations are the whole story. */
export function nativeGate(
  name: string,
  violations: readonly Violation[],
  command?: readonly string[],
): GateResult {
  return gateResult({
    name,
    passed: violations.length === 0,
    violations,
    violationCount: violations.length,
    ...(command === undefined ? {} : { command }),
  });
}

/** The gate could not run. Exit 3, and `message` must carry the fix. */
export function errorGate(
  name: string,
  message: string,
  command?: readonly string[],
): GateResult {
  return gateResult({
    name,
    passed: false,
    error: true,
    output: message,
    ...(command === undefined ? {} : { command }),
  });
}

/** The gate did not run, visibly, and `reason` says why. */
export function skipGate(name: string, reason: string): GateResult {
  return gateResult({ name, passed: false, skipped: true, skipReason: reason });
}

/**
 * The two-state shape: findings, or a reason the gate could not run.
 *
 * Structurally matches `ForbiddenCallsOutcome`, `NullableDefaultsOutcome`,
 * `SecretDefaultsOutcome`, `TypeCheckOutcome` and the `ok: true` arm of
 * `TypingStrictnessOutcome`. Declared here rather than imported from any one
 * of them so no gate becomes the accidental owner of the shared contract.
 */
export type SimpleOutcome =
  | { readonly ok: true; readonly violations: readonly Violation[] }
  | { readonly ok: false; readonly message: string };

/** Map a two-state outcome. `ok: false` is ERROR (exit 3), never a failure. */
export function fromSimple(
  name: string,
  outcome: SimpleOutcome,
  command?: readonly string[],
): GateResult {
  if (!outcome.ok) {
    return errorGate(name, outcome.message, command);
  }
  return nativeGate(name, outcome.violations, command);
}

/**
 * Map the three-state test-depth shape.
 *
 * The middle arm is the one that matters: `ok: true, skipped: true` is a repo
 * with no `.kragg/criticality.json`, and it MUST reach the user as a printed
 * skip carrying "run `kragg criticality --write`". Rendering it as a pass
 * would tell a project its critical functions are tested when no one has ever
 * worked out which functions those are.
 */
export function fromTestDepth(name: string, outcome: TestDepthOutcome): GateResult {
  if (!outcome.ok) {
    return errorGate(name, outcome.message);
  }
  if (outcome.skipped) {
    return skipGate(name, outcome.reason);
  }
  return nativeGate(name, outcome.violations);
}

/**
 * Map the secret scanner's three arms.
 *
 * "No scanner is installed" is a SKIP with install commands attached, not a
 * pass: kragg bundles no scanner, and a security gate that reports clean
 * without having looked is worse than no gate. A scanner that ran and broke is
 * an ERROR, kept apart from the skip so the two cannot be confused.
 */
export function fromSecrets(name: string, outcome: SecretsOutcome): GateResult {
  if (outcome.ok) {
    return nativeGate(name, outcome.violations, outcome.command);
  }
  if (outcome.skipped) {
    return skipGate(name, outcome.reason);
  }
  return errorGate(name, outcome.message, outcome.command);
}

/**
 * The shape shared by the adapters that RAN a tool and read its report.
 *
 * `AuditFindings` and `TestRunFindings` both satisfy this; each carries extra
 * fields (`belowFloor`, `coverage`) that are already folded into its own
 * `output`, so nothing is lost by widening to the common part.
 */
export interface RanReport {
  readonly ok: true;
  readonly command: readonly string[];
  readonly violations: readonly Violation[];
  readonly violationCount: number;
  readonly passed: boolean;
  readonly output: string;
  /**
   * Optional, because most adapters have nothing to advise about.
   *
   * `audit` does: everything under the severity floor is filtered out of
   * `violations` on purpose, and the count of what was filtered used to live
   * only in `output` — which is suppressed on a passing gate. "Clean at
   * `high`, with 3 below it" and "clean, full stop" are different facts and a
   * reader deciding whether the floor is set right needs to be told which one
   * they are looking at.
   */
  readonly advisories?: readonly Violation[] | undefined;
  /**
   * The tool ran and its findings stand, but its evidence is INCOMPLETE:
   * ERROR, exit 3, with the findings still listed.
   *
   * `test-coverage` sets it when the tests ran but the coverage floor could
   * not be checked. Neither a pass (the floor went unenforced) nor a plain
   * failure (the missing number is not a finding anyone can fix in the code),
   * and dropping the test failures that WERE found would hide real findings
   * behind the environment problem.
   */
  readonly error?: boolean | undefined;
}

/**
 * Map an adapter that either ran a tool or explained why it could not.
 *
 * The `Unavailable.kind` split is the whole point of that type: only
 * `not-configured` is a skip. `missing-tool`, `crashed` and `offline` are all
 * ERRORS, because in every one of them the project went UNCHECKED — a
 * vulnerability audit that could not reach the advisory database has cleared
 * nothing, and saying otherwise is a lie with a green checkmark on it.
 *
 * Raw output is suppressed when the run passed or when violations were parsed,
 * matching `_project_tool_gate`: showing a tool's own chatter next to parsed
 * findings is noise, and `processGate` only falls back to it when a failing
 * gate produced nothing structured. An ERROR always keeps it: the output is
 * where the adapter says what evidence was expected and what was found.
 */
export function fromReport(name: string, outcome: RanReport | Unavailable): GateResult {
  if (!outcome.ok) {
    return fromUnavailable(name, outcome);
  }
  const error = outcome.error === true;
  const parsed = outcome.violations.length > 0;
  return gateResult({
    name,
    passed: outcome.passed,
    output: outcome.passed || (parsed && !error) ? "" : outcome.output,
    command: outcome.command,
    violations: outcome.violations,
    violationCount: outcome.violationCount,
    advisories: outcome.advisories ?? [],
    error,
  });
}

/**
 * Map the linter's three arms.
 *
 * The adapter has already made the hard call and encoded it in `reason`, so
 * this is a lookup rather than a judgement: "no linter is installed anywhere"
 * is a skip, while "the project named `biome` and it is not installed" is an
 * error. An explicit instruction we cannot honour is never downgraded.
 */
export function fromLint(name: string, outcome: LintOutcome): GateResult {
  if (outcome.ok) {
    return nativeGate(name, outcome.violations, outcome.command);
  }
  return outcome.reason === "skipped"
    ? skipGate(name, outcome.message)
    : errorGate(name, outcome.message, outcome.command);
}

/**
 * Map the typing-strictness outcome, which carries a second severity.
 *
 * `advisories` are findings that should be SEEN but must not fail a build:
 * `skipLibCheck`, non-null assertions, module-internal `any`,
 * `isolatedModules`/`verbatimModuleSyntax`, and the solution-style-tsconfig
 * notice. They are NOT added to `violations`, because that would turn an
 * advisory into a build failure and that is exactly what the split exists to
 * prevent.
 *
 * THEY NOW HAVE THEIR OWN CHANNEL, and this is the gate that motivated it.
 * They used to ride in `output`, which `processGate` surfaces only for a gate
 * that FAILED and produced no structured violations — so on a green
 * `typing-strictness` a real, deliberate escape hatch in the project's config
 * was recorded and never printed. `GateResult.advisories` carries them
 * instead, `processGate` dedupes and caps them like violations, and both
 * renderers show them under the gate whatever its verdict. Nothing about the
 * verdict, the counts or the exit code reads that list; see
 * `engine/models.ts`.
 */
export function fromTypingStrictness(
  name: string,
  outcome: TypingStrictnessOutcome,
): GateResult {
  if (!outcome.ok) {
    return errorGate(name, outcome.message);
  }
  return gateResult({
    name,
    passed: outcome.violations.length === 0,
    violations: outcome.violations,
    violationCount: outcome.violations.length,
    advisories: outcome.advisories,
  });
}

/** Skip only for `not-configured`; every other kind is a broken environment. */
export function fromUnavailable(name: string, outcome: Unavailable): GateResult {
  return outcome.kind === "not-configured"
    ? skipGate(name, outcome.message)
    : errorGate(name, outcome.message);
}
