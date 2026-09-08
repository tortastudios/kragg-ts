/**
 * The narrowing readers `policy.ts` is built from.
 *
 * Split out of `policy.ts` for size; the reasoning that governs them lives in
 * that module's header and is not repeated. The one rule to keep in mind while
 * editing anything here: THIS CODE PARSES UNTRUSTED INPUT, and it FAILS CLOSED.
 * Every reader distinguishes three states of a setting —
 *
 *   absent      → the default applies;
 *   configured  → the value is honoured EXACTLY, including deliberate opt-outs
 *                 such as `[]`, `{}`, `0`, `null` and `"off"`;
 *   invalid     → `PolicyError`, naming the file, the setting and what was
 *                 found, and NEVER a default.
 *
 * Degrading an invalid value to its default is fail-OPEN, not fail-closed: a
 * ban list written as a string, a budget written as `"100"`, or a misspelled
 * key all read as "nothing configured", and the project keeps reporting green
 * with a restriction it wrote down doing nothing. A `PolicyError` reaches the
 * CLI as exit 2 with no report, which cannot be mistaken for a pass.
 *
 * Nothing here is part of kragg's public API. `policy.ts` re-exports
 * {@link PolicyError}, which is the only name a caller outside this directory
 * has any business knowing.
 */

import { readFileSync } from "node:fs";

import type { CriticalDeclaration, CriticalDeclarations, ForbiddenCall } from "./policy.ts";

/** A parsed JSON object. Values are `unknown` until narrowed. */
export type Table = Readonly<Record<string, unknown>>;

/**
 * A config table together with where it came from.
 *
 * `label` is the prefix every error message names a setting with —
 * `<path>#` for `kragg.json` and `<path>#kragg.` for `package.json` — so
 * `kragg.json#forbidden_calls[1]` points at exactly one place to fix.
 * `consumed` records every key a reader asked for; whatever the table holds
 * beyond that is unknown, and {@link rejectUnknownKeys} reports it.
 */
export interface Source {
  readonly table: Table;
  readonly label: string;
  readonly consumed: Set<string>;
}

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

/**
 * Read an OWN property and record the key as consumed.
 *
 * `Object.hasOwn` is not decoration: a plain index read would resolve
 * `"constructor"` or `"toString"` through `Object.prototype` and hand a
 * function to a narrowing helper. Config keys are attacker-influenced input.
 */
export function own(table: Table, key: string): unknown {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

function take(source: Source, key: string): unknown {
  source.consumed.add(key);
  return own(source.table, key);
}

/** Render a found value for an error message, kept to one line. */
function shown(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** The one error shape: `<file>#<setting> must be <expected> (got <value>)`. */
function reject(source: Source, setting: string, expected: string, value: unknown): never {
  throw new PolicyError(`${source.label}${setting} must be ${expected} (got ${shown(value)})`);
}

export function getString(source: Source, key: string, fallback: string): string {
  const value = take(source, key);
  if (value === undefined) {
    return fallback;
  }
  return typeof value === "string" ? value : reject(source, key, "a string", value);
}

/** The accepted interval of an integer setting; `max` is unbounded when absent. */
export interface IntRange {
  readonly min: number;
  readonly max?: number;
}

/**
 * Read an integer setting within a range.
 *
 * DIVERGES from Python, which accepts any `int` (including `True`, which is
 * an `int` there) and falls back to the default for anything else. Here a
 * JSON boolean, a string such as `"100"`, a non-integer such as `82.5` (never
 * rounded: a rounded budget is a budget the project did not ask for) and an
 * out-of-range value such as `-1` or a coverage floor of `250` are all
 * rejected by name. `500.0` and `500` are indistinguishable in JSON and both
 * are accepted; nothing is lost, the value is still an exact integer.
 */
export function getInt(source: Source, key: string, fallback: number, range: IntRange): number {
  const value = take(source, key);
  if (value === undefined) {
    return fallback;
  }
  const expected =
    range.max === undefined
      ? `an integer of at least ${range.min}`
      : `an integer from ${range.min} to ${range.max}`;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return reject(source, key, expected, value);
  }
  if (value < range.min || (range.max !== undefined && value > range.max)) {
    return reject(source, key, expected, value);
  }
  return value;
}

/**
 * Read an optional string. `null` is the explicit "none", matching what
 * `kragg policy show` prints for the setting; any other non-string is
 * rejected rather than quietly read as "none".
 */
export function getOptionalString(
  source: Source,
  key: string,
  fallback: string | undefined,
): string | undefined {
  const value = take(source, key);
  if (value === undefined) {
    return fallback;
  }
  if (value === null) {
    return undefined;
  }
  return typeof value === "string" ? value : reject(source, key, "a string or null", value);
}

/**
 * Read a closed-vocabulary setting, or THROW.
 *
 * These choose WHICH TOOL RUNS and every one has an `"off"`, so a typo has a
 * plausible path to disabling a gate outright: `secret_scanner: "gitlaeks"`
 * silently becoming `"auto"` on a machine with no scanner is a repo that
 * believes it scans for credentials and does not. `PolicyError` reaches the
 * CLI as exit 2.
 */
export function getEnum<T extends string>(
  source: Source,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = take(source, key);
  if (value === undefined) {
    return fallback;
  }
  if (isMember(value, allowed)) {
    return value;
  }
  return reject(source, key, `one of: ${allowed.join(", ")}`, value);
}

function isMember<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  if (typeof value !== "string") {
    return false;
  }
  return allowed.some((candidate): boolean => candidate === value);
}

/**
 * Read a list of strings. A bare string is accepted as a one-element list, as
 * in the Python version, and `[]` is an explicit, honoured empty. An element
 * of the wrong type is rejected BY INDEX rather than collapsing the whole
 * list to its default: `layers: ["src/cli", 3]` used to read as "no layers",
 * which silently switched the boundaries gate off.
 */
export function getStringList(
  source: Source,
  key: string,
  fallback: readonly string[],
): readonly string[] {
  const value = take(source, key);
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "string") {
    return [value];
  }
  if (!Array.isArray(value)) {
    return reject(source, key, "a string or a list of strings", value);
  }
  return value.map((item, index): string =>
    typeof item === "string" ? item : reject(source, `${key}[${index}]`, "a string", item),
  );
}

/**
 * Read `[entry, hint]` pairs from an object, or a bare list of entries.
 *
 * FAIL CLOSED, and this is the single most important behaviour in the file.
 * Once the value is recognisably a pairs-object, EVERY key in it is a ban. A
 * hint that is not a string is REJECTED by name — not degraded to `""` as
 * Python does, and never dropped. Rejecting rather than repairing is the
 * fail-closed choice: exit 2 before any gate runs means no report can claim
 * green with the ban silently altered, and the project learns about the
 * mistake at the only moment it can fix it; a silent repair is exactly the
 * "malformed value quietly becomes something else" that this module exists
 * to prevent. `{}` is an explicit, honoured empty ban list.
 *
 * A bare list with a non-string element is rejected by index for the same
 * reason. It used to fall back to the default, so `["node:child_process", 7]`
 * un-banned `child_process` with no error anywhere.
 *
 * Sorted by entry, then hint, so `kragg policy show` and the gate's output are
 * stable regardless of key order in the config file. Comparison is by code
 * unit (`<`), matching Python's `sorted()` on tuples of `str`.
 */
export function getStringPairs(
  source: Source,
  key: string,
  fallback: readonly ForbiddenCall[],
): readonly ForbiddenCall[] {
  const value = take(source, key);
  if (value === undefined) {
    return fallback;
  }
  if (isTable(value)) {
    return sortPairs(
      Object.entries(value).map(([entry, hint]): ForbiddenCall => [
        entry,
        typeof hint === "string"
          ? hint
          : reject(source, `${key}[${JSON.stringify(entry)}]`, "a string", hint),
      ]),
    );
  }
  if (Array.isArray(value)) {
    return sortPairs(
      value.map((entry, index): ForbiddenCall =>
        typeof entry === "string"
          ? [entry, ""]
          : reject(source, `${key}[${index}]`, "a string", entry),
      ),
    );
  }
  return reject(source, key, "an object of banned call to fix hint, or a list of strings", value);
}

/**
 * Read `{ "<module>#<name>": "<why it is critical>" }` — reviewed critical
 * function declarations.
 *
 * AN OBJECT, AND ONLY AN OBJECT. `getStringPairs` accepts a bare list because
 * a `forbidden_calls` entry means something without a hint: the ban stands and
 * the hint is a courtesy. A declaration without a reason means nothing anybody
 * can review — the whole point of the setting is that a HUMAN decided this
 * low-fan-in function is high-consequence, and the reason is that decision.
 * So a list is rejected with the shape that carries one, and an empty or
 * non-string reason is rejected by name rather than repaired to `""`.
 *
 * THE NAME IS CHECKED FOR SHAPE, not for existence. `criticality.ts` names
 * every node `"<module>#<qualified.name>"`, so a name with no `#`, or with an
 * empty half, can never match anything and is a typo worth catching at load
 * time. Whether the function EXISTS is a question about the analysed program,
 * not about the config, and `gates/criticality/declared.ts` answers it — a
 * declaration that matches no function is an error there, so a rename cannot
 * silently drop the protection.
 *
 * Sorted by name, then reason, exactly like {@link getStringPairs}, so
 * `kragg policy show` is stable regardless of key order in the file.
 */
export function getCriticalDeclarations(
  source: Source,
  key: string,
  fallback: CriticalDeclarations,
): CriticalDeclarations {
  const value = take(source, key);
  if (value === undefined) {
    return fallback;
  }
  if (!isTable(value)) {
    return reject(source, key, "an object of \"module#function\" to the reason it is critical", value);
  }
  const declarations = Object.entries(value).map(([name, reason]): CriticalDeclaration => {
    const at = `${key}[${JSON.stringify(name)}]`;
    if (typeof reason !== "string" || reason.trim() === "") {
      return reject(source, at, "a non-empty string saying why the function is critical", reason);
    }
    if (!isQualifiedName(name)) {
      return reject(source, at, "named \"<module>#<function>\", e.g. \"src/auth/login#verifyPassword\"", name);
    }
    return [name, reason];
  });
  return [...declarations].sort((left, right) => comparePair(left, right));
}

/** `"<module>#<name>"` with both halves non-empty, and exactly one `#` split. */
function isQualifiedName(name: string): boolean {
  const index = name.indexOf("#");
  return index > 0 && index < name.length - 1;
}

function sortPairs(pairs: readonly ForbiddenCall[]): readonly ForbiddenCall[] {
  return [...pairs].sort((left, right) => comparePair(left, right));
}

/** Order two `[entry, text]` pairs by entry, then by text; code-unit order. */
function comparePair(
  left: readonly [string, string],
  right: readonly [string, string],
): number {
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

/**
 * Reject every key no reader consumed, naming each and suggesting the nearest
 * setting when one is obvious.
 *
 * Call this AFTER every reader has run, so `consumed` is complete. An ignored
 * key is the quietest failure available: `forbiden_calls` configures nothing
 * and nothing says so. `extra` lists keys that are legitimately present but
 * not settings (`$schema`, for editor validation).
 */
export function rejectUnknownKeys(source: Source, extra: readonly string[]): void {
  const known = [...source.consumed];
  const problems = Object.keys(source.table)
    .filter((key) => !source.consumed.has(key) && !extra.includes(key))
    .map((key) => {
      const nearest = nearestName(key, known);
      const hint = nearest === undefined ? "" : ` (did you mean ${nearest}?)`;
      return `${source.label}${key} is not a kragg setting${hint}`;
    });
  if (problems.length > 0) {
    throw new PolicyError(problems.join("; "));
  }
}

/**
 * The closest known name, or `undefined` when nothing is close enough to be
 * obvious.
 *
 * Shared with `gates/criticality/declared.ts`, which asks the same question
 * about a different vocabulary: a `critical_functions` entry that names no
 * function in the analysed program is the same typo in a different place, and
 * a reader should get the same "did you mean" out of both.
 *
 * `maxDistance` is what that second vocabulary needs. A config key is a dozen
 * characters, so three edits is already a different word; a qualified function
 * name is thirty, and renaming `verifyPassword` to `verifyPasswordHash` is
 * four edits away from a name that is obviously the same function. The
 * proportional guard below (`bestDistance * 2 < key.length`) is what keeps a
 * larger budget from producing nonsense, and it applies either way.
 */
export function nearestName(
  key: string,
  known: readonly string[],
  maxDistance = 3,
): string | undefined {
  const flat = (name: string): string => name.toLowerCase().replaceAll(/[-_]/gu, "");
  const sameLetters = known.find((candidate) => flat(candidate) === flat(key));
  if (sameLetters !== undefined) {
    return sameLetters;
  }
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of known) {
    const distance = editDistance(key, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= maxDistance && bestDistance * 2 < key.length ? best : undefined;
}

/** Levenshtein distance; the inputs are short config keys, so O(n·m) is fine. */
function editDistance(left: string, right: string): number {
  let row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (const [i, char] of [...left].entries()) {
    row = nextRow(row, i + 1, char, right);
  }
  return row[right.length] ?? 0;
}

/** One row of the Levenshtein table: the distances after consuming `char`. */
function nextRow(row: readonly number[], first: number, char: string, right: string): number[] {
  const next = [first];
  for (const [j, other] of [...right].entries()) {
    const substitution = (row[j] ?? 0) + (char === other ? 0 : 1);
    next.push(Math.min((row[j + 1] ?? 0) + 1, (next[j] ?? 0) + 1, substitution));
  }
  return next;
}
