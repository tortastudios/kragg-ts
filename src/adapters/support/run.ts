/**
 * Small shared helpers for driving `src/engine/runner.ts` from an adapter.
 *
 * `RunCommandOptions` declares `timeoutMs?: number`, and the project compiles
 * with `exactOptionalPropertyTypes`, so an explicit `undefined` is NOT the same
 * as an absent key and will not typecheck. Every adapter takes an optional
 * timeout from its caller, so every adapter would otherwise repeat the same
 * conditional spread. It lives here once.
 */

import type { RunCommandOptions } from "../../engine/runner.ts";

/** Build run options, omitting the timeout key entirely when unset. */
export function runOptions(timeoutMs: number | undefined): RunCommandOptions {
  return timeoutMs === undefined ? {} : { timeoutMs };
}
