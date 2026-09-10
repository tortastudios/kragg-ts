/**
 * Argument validation shared across `cli.ts`'s commands.
 *
 * Split out of `cli.ts` to keep it under the file-budget gate; the reasoning
 * these functions embody is documented in `cli.ts`'s own module header under
 * "AN ACCEPTED ARGUMENT MUST BE AN ARGUMENT THAT ACTS."
 */

import type { Values } from "../cli.ts";

/**
 * The first flag whose VALUE is outside its domain, as a message, or `null`.
 *
 * Every one of these used to fall back to a default. That is the same bug as
 * a flag the command ignores, one level down: `--format yaml` printed text and
 * exited 0, so a caller parsing stdout as JSON got a parse error with no way
 * to tell a bad flag from a broken run, and `--max-violations abc` silently
 * restored the policy's cap over the one the caller asked for. Neither can
 * make a failing project look passing, which is why it was survivable — but a
 * machine surface that quietly does something else is not one anybody can
 * build on. Checked once, here, whichever command was invoked.
 */
export function invalidValue(values: Values): string | null {
  if (values.format !== undefined && values.format !== "text" && values.format !== "json") {
    return `--format must be 'text' or 'json', not '${values.format}'`;
  }
  return (
    notACount("max-violations", values["max-violations"]) ??
    notACount("last", values.last) ??
    notACount("limit", values.limit) ??
    notACount("rerun", values.rerun)
  );
}

/** Digits only, matching Python's `type=int`: no `1e3`, no sign, no padding. */
export function notACount(name: string, raw: string | undefined): string | null {
  if (raw === undefined || /^[0-9]+$/.test(raw)) {
    return null;
  }
  return `--${name} must be a non-negative integer, not '${raw}'`;
}

/**
 * Flags the command accepts individually that cannot both apply, or `null`.
 *
 * `--changed`/`--since` hand the file set to git, and `resolveScope` in
 * `commands/check.ts` then DISCARDS an explicit `--file` list. Running the
 * caller's second choice without saying so is how a scope gets believed;
 * asking which one they meant costs one re-run and no trust.
 */
export function conflict(values: Values): string | null {
  const fromGit = values.changed === true || values.since !== undefined;
  if (fromGit && values.file !== undefined) {
    return "--file cannot be combined with --changed or --since; git decides the file set";
  }
  // A package run is a FULL run of that package: git reports paths relative
  // to the repository root, not the member, and a `--file` would be relative
  // to whichever root the reader had in mind. Neither can be honoured yet.
  if (values.package !== undefined && (fromGit || values.file !== undefined)) {
    return "--package cannot be combined with --file, --changed or --since; a package run checks the whole package";
  }
  // Same class, one level down: `--all` is the inventories' spelling of
  // `--limit 0`, so accepting both means silently honouring one.
  if (values.all === true && values.limit !== undefined) {
    return "--all cannot be combined with --limit; --all IS the full export (--limit 0)";
  }
  return null;
}

/** `--format`, defaulting to text. `invalidValue` has already vetted it. */
export function format(values: Values): "text" | "json" {
  return values.format === "json" ? "json" : "text";
}

/**
 * A non-negative integer flag, or the fallback when the flag is absent.
 *
 * The guard is not the validation — `invalidValue` rejects a non-count before
 * any command runs — it is what keeps that true for a future caller that does
 * not come through `dispatch`.
 */
export function integer(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
