/**
 * The narrowing readers `policy.ts` is built from.
 *
 * Split out of `policy.ts` for size; the reasoning that governs them lives in
 * that module's header and is not repeated. The one rule to keep in mind while
 * editing anything here: THIS CODE PARSES UNTRUSTED INPUT, and it FAILS CLOSED.
 * A malformed value degrades to the strict default or throws; it never widens
 * what a gate permits. `getStringPairs` goes furthest — it never drops a
 * configured restriction, however malformed the hint attached to it.
 *
 * Nothing here is part of kragg's public API. `policy.ts` re-exports
 * {@link PolicyError}, which is the only name a caller outside this directory
 * has any business knowing.
 */

import { readFileSync } from "node:fs";

import type { ForbiddenCall } from "./policy.ts";

/** A parsed JSON object. Values are `unknown` until narrowed. */
export type Table = Readonly<Record<string, unknown>>;

/**
 * Raised when a config file exists but cannot be used.
 *
 * Deliberately NOT degraded to defaults. Python crashes here (`tomllib`
 * raises), and silently running the permissive default policy over a project
 * that configured a stricter one is precisely the fail-open behaviour this
 * module rejects. The CLI should catch this and exit with the usage code and
 * the message below.
 */
export class PolicyError extends Error {
  override readonly name = "PolicyError";
}

/**
 * Read and parse a JSON object file.
 *
 * Returns `null` only when the file does not exist. Any other outcome — an
 * unreadable file, invalid JSON, or valid JSON that is not an object — throws
 * `PolicyError`, because the file was clearly meant to configure kragg and
 * running as if it were absent would apply the wrong rules under the
 * project's nose.
 */
export function readTable(path: string): Table | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw new PolicyError(`could not read ${path}: ${describe(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new PolicyError(`${path} is not valid JSON: ${describe(error)}`);
  }
  if (!isTable(parsed)) {
    throw new PolicyError(`${path} must contain a JSON object at the top level`);
  }
  return parsed;
}

/** True for ENOENT/ENOTDIR — the file genuinely is not there. */
function isMissingFileError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code: unknown = error.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Read an OWN property.
 *
 * `Object.hasOwn` is not decoration: a plain index read would resolve
 * `"constructor"` or `"toString"` through `Object.prototype` and hand a
 * function to a narrowing helper. Config keys are attacker-influenced input.
 */
export function own(table: Table, key: string): unknown {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

export function getString(table: Table, key: string, fallback: string): string {
  const value = own(table, key);
  return typeof value === "string" ? value : fallback;
}

/**
 * Read an integer setting.
 *
 * DIVERGES from Python in two harmless directions, both stricter or equal:
 *
 * - Python's `isinstance(value, int)` is true for `True`, so `max_file_lines
 *   = true` silently becomes 1. JSON booleans are not numbers here, so the
 *   value falls back to the default instead. Ours is the safer reading.
 * - JSON has one number type, so `500.0` and `500` are indistinguishable and
 *   both are accepted; TOML would reject the float. Nothing is lost — the
 *   value is still an exact integer.
 *
 * Non-integers (`1.5`, `NaN`) fall back rather than being rounded: a rounded
 * budget is a budget the project did not ask for.
 */
export function getInt(table: Table, key: string, fallback: number): number {
  const value = own(table, key);
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

/**
 * Read an optional string; a wrong type degrades to the fallback.
 *
 * Safe to degrade, unlike `getEnum`: the only optional string is
 * `secret_baseline`, and losing a baseline SUPPRESSES nothing — the scanner
 * reports more, not less. Falling back is the strict direction.
 */
export function getOptionalString(
  table: Table,
  key: string,
  fallback: string | undefined,
): string | undefined {
  const value = own(table, key);
  return typeof value === "string" ? value : fallback;
}

/**
 * Read a closed-vocabulary setting, or THROW.
 *
 * The one reader here that does not degrade to its default, and the asymmetry
 * is the point. A malformed number cannot flip the meaning of a gate — a
 * broken `max_file_lines` still checks file length. These choose WHICH TOOL
 * RUNS and every one has an `"off"`, so a typo has a plausible path to
 * disabling a gate outright: `secret_scanner: "gitlaeks"` silently becoming
 * `"auto"` on a machine with no scanner is a repo that believes it scans for
 * credentials and does not. `PolicyError` reaches the CLI as exit 2.
 */
export function getEnum<T extends string>(
  table: Table,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = own(table, key);
  if (value === undefined) {
    return fallback;
  }
  if (isMember(value, allowed)) {
    return value;
  }
  throw new PolicyError(
    `${key} must be one of: ${allowed.join(", ")} (got ${JSON.stringify(value)})`,
  );
}

function isMember<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  if (typeof value !== "string") {
    return false;
  }
  return allowed.some((candidate): boolean => candidate === value);
}

/** A bare string is accepted as a one-element list, as in the Python version. */
export function getStringList(
  table: Table,
  key: string,
  fallback: readonly string[],
): readonly string[] {
  const value = own(table, key);
  if (typeof value === "string") {
    return [value];
  }
  if (isStringArray(value)) {
    return [...value];
  }
  return fallback;
}

/**
 * Read `[entry, hint]` pairs from an object, or a bare list of entries.
 *
 * FAIL CLOSED, and this is the single most important behaviour in the file.
 * Once the value is recognisably a pairs-object, EVERY key in it becomes an
 * enforced ban. A hint that is not a string degrades to `""` — the ban stands,
 * it just loses its advice. Dropping the entry instead would mean a typo in a
 * fix hint silently un-bans `child_process.exec`, and the project would keep
 * reporting green while the ban it wrote down does nothing.
 *
 * Only a value that is neither an object nor an all-strings array falls back
 * to the default, because in that case there is no entry to preserve.
 *
 * Sorted by entry, then hint, so `kragg policy show` and the gate's output are
 * stable regardless of key order in the config file. Comparison is by code
 * unit (`<`), matching Python's `sorted()` on tuples of `str`.
 */
export function getStringPairs(
  table: Table,
  key: string,
  fallback: readonly ForbiddenCall[],
): readonly ForbiddenCall[] {
  const value = own(table, key);
  if (isTable(value)) {
    return sortPairs(
      Object.entries(value).map(([entry, hint]): ForbiddenCall => [
        entry,
        typeof hint === "string" ? hint : "",
      ]),
    );
  }
  if (isStringArray(value)) {
    return sortPairs(value.map((entry): ForbiddenCall => [entry, ""]));
  }
  return fallback;
}

function sortPairs(pairs: readonly ForbiddenCall[]): readonly ForbiddenCall[] {
  return [...pairs].sort((left, right) => compare(left, right));
}

function compare(left: ForbiddenCall, right: ForbiddenCall): number {
  const [leftEntry, leftHint] = left;
  const [rightEntry, rightHint] = right;
  if (leftEntry !== rightEntry) {
    return leftEntry < rightEntry ? -1 : 1;
  }
  if (leftHint === rightHint) {
    return 0;
  }
  return leftHint < rightHint ? -1 : 1;
}
