/**
 * The shared "could not run" half of every adapter result.
 *
 * Adapters follow the `{ ok: true, … } | { ok: false, message }` pattern used
 * by `src/gates/forbiddenCalls.ts`, with ONE addition: a `kind` that says
 * which of three genuinely different things went wrong. The gate layer needs
 * that distinction because the three map to different `GateResult` fields and
 * therefore to different process exit codes:
 *
 *  - `not-configured` -> `skipped: true` with a reason. The analogue of
 *    `_unconfigured` in `catalog.py`: "Unconfigured policy-driven gates SKIP
 *    visibly, never PASS silently." Exit 0, but the skip is printed.
 *  - `missing-tool`   -> `error: true`. The analogue of `_project_tool_gate`'s
 *    missing-module branch: the check could not run, so the project is
 *    UNCHECKED, and reporting that as a pass is the exact failure this whole
 *    codebase exists to prevent. Exit 3.
 *  - `crashed`        -> `error: true`. The tool WAS there and ran, and
 *    produced nothing we could read. Kept apart from `missing-tool` because
 *    the fixes have nothing in common: one is an install command, the other is
 *    a bug report with the tool's own output attached. Telling someone to
 *    reinstall a tool that is plainly installed wastes the cycle that message
 *    was supposed to save. Exit 3.
 *  - `offline`        -> `error: true`. Only the auditor can produce this. A
 *    network failure is an environment condition; a vulnerability scan that
 *    could not reach the advisory database has found nothing and knows
 *    nothing, and those are not the same. Exit 3.
 *
 * Collapsing these into a single "failed" would let a missing test runner
 * render identically to a passing test suite, which is the one outcome that
 * must never be possible.
 */

/** Why an adapter produced no result. See the module docs for the mapping. */
export type UnavailableKind = "not-configured" | "missing-tool" | "crashed" | "offline";

/**
 * The `ok: false` arm shared by every adapter outcome.
 *
 * `message` is the whole human-facing explanation and, for `missing-tool`,
 * ALWAYS ends with a copy-pasteable install command from
 * `remediation()` — a skip that does not say how to un-skip itself trains
 * people to ignore skips.
 */
export interface Unavailable {
  readonly ok: false;
  readonly kind: UnavailableKind;
  readonly message: string;
}

/** Build a `not-configured` outcome: the policy turned this adapter off. */
export function notConfigured(message: string): Unavailable {
  return { ok: false, kind: "not-configured", message };
}

/** Build a `missing-tool` outcome. `message` must carry the install command. */
export function missingTool(message: string): Unavailable {
  return { ok: false, kind: "missing-tool", message };
}

/**
 * Build a `crashed` outcome: the tool ran and produced nothing readable.
 *
 * `message` should carry the command and an excerpt of the tool's own output.
 * That excerpt is the entire value of this outcome — kragg cannot diagnose an
 * unrecognised failure, and pretending to would send the reader somewhere
 * wrong. Handing them what the tool actually said is the honest maximum.
 */
export function crashed(message: string): Unavailable {
  return { ok: false, kind: "crashed", message };
}

/** Build an `offline` outcome: the tool ran but could not reach the network. */
export function offline(message: string): Unavailable {
  return { ok: false, kind: "offline", message };
}

/**
 * Cap a violation list, reporting the total separately.
 *
 * Mirrors `max_violations_per_gate`. kragg's output is read by an agent with a
 * finite context window, so a thousand-line dump costs more than it informs;
 * `GateResult.violationCount` keeps the true total while `violations` stays
 * readable. A cap of zero or less is treated as "no cap" rather than
 * "report nothing", because silently showing no findings would read as clean.
 */
export function capped<T>(items: readonly T[], limit: number): readonly T[] {
  return limit > 0 && items.length > limit ? items.slice(0, limit) : items;
}
