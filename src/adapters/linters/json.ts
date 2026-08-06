/**
 * Narrowing helpers shared by the three linter parsers.
 *
 * PARSING UNTRUSTED JSON IS THE PRODUCT HERE. A linter is a subprocess whose
 * stdout we do not control: it can be truncated by a crash mid-write, it can
 * carry a banner the tool printed before the payload, and its schema can change
 * between majors. Every reader below therefore takes `unknown`, narrows
 * explicitly, and is TOTAL — nothing in this file throws, for any input.
 *
 * That totality is what lets `lint.ts` keep the distinction the Python sibling
 * encodes as ruff's `error_codes=(2,)`: "the linter found problems" (exit 1,
 * violations) versus "the linter itself could not run" (exit 3, environment
 * error). A parser that threw on malformed output would collapse the second
 * case into a stack trace, and a parser that returned "no violations" for it
 * would collapse it into a GREEN GATE — the fail-open outcome kragg exists to
 * prevent. So the contract is: a parse that cannot find the tool's envelope
 * returns `{ ok: false, message }`, and the caller turns that into `error:
 * true`.
 */

import { isAbsolute, relative, sep } from "node:path";

import type { Violation } from "../../engine/models.ts";

/**
 * Either the findings, or the reason the output could not be believed.
 *
 * The same union shape as `ForbiddenCallsOutcome` in
 * `src/gates/forbiddenCalls.ts`, and for the same reason: "I could not run" has
 * to be a value the caller must handle, not an exception the happy path has to
 * guard against.
 */
export type LintParse =
  | { readonly ok: true; readonly violations: readonly Violation[] }
  | { readonly ok: false; readonly message: string };

/** A parsed JSON object. Values stay `unknown` until narrowed. */
export type JsonObject = Readonly<Record<string, unknown>>;

/**
 * Parse a tool's stdout, returning `undefined` when it is not JSON.
 *
 * `undefined` is an unambiguous failure signal because JSON has no `undefined`
 * literal: any successful parse yields a value that is not `undefined`.
 *
 * TOLERATES A LEADING/TRAILING BANNER, deliberately and narrowly. Biome prints
 * "The `json` and `json-pretty` reporters are experimental..." on every run;
 * that goes to stderr today (verified in `biome_cli/src/runner/impls/
 * finalizers/default.rs`, which calls `console_reporter_writer.error`), but the
 * same file has moved output between streams before and a linter that prints
 * one extra line must not read as a crashed linter. So a direct parse is tried
 * first, and only if that fails do we retry the span from the first `{`/`[` to
 * the last `}`/`]`.
 *
 * The retry cannot manufacture a false success: it still has to parse as JSON
 * and the caller still has to find the tool's envelope inside it. A TRUNCATED
 * payload — the crash case that matters — has no closing brace to slice to, so
 * it stays a failure.
 */
export function parseJsonPayload(text: string): unknown {
  const direct = tryParse(text);
  if (direct !== undefined) {
    return direct;
  }
  const start = firstIndexOfAny(text, "{[");
  const end = lastIndexOfAny(text, "}]");
  if (start < 0 || end <= start) {
    return undefined;
  }
  return tryParse(text.slice(start, end + 1));
}

function tryParse(text: string): unknown {
  if (text.trim() === "") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}

function firstIndexOfAny(text: string, chars: string): number {
  for (let index = 0; index < text.length; index += 1) {
    if (chars.includes(text.charAt(index))) {
      return index;
    }
  }
  return -1;
}

function lastIndexOfAny(text: string, chars: string): number {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (chars.includes(text.charAt(index))) {
      return index;
    }
  }
  return -1;
}

/** True for a plain JSON object — arrays and `null` excluded. */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read an OWN property.
 *
 * Not decoration, exactly as in `policy.ts`: a bare index read resolves
 * `"constructor"` through `Object.prototype` and hands a function to a
 * narrowing helper. A linter's JSON is attacker-influenced input — it contains
 * source text from the repo being checked.
 */
export function readProp(object: JsonObject, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

/** A non-empty string property, or `undefined`. */
export function readString(object: JsonObject, key: string): string | undefined {
  const value = readProp(object, key);
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A nested object property, or `undefined`. */
export function readObject(object: JsonObject, key: string): JsonObject | undefined {
  const value = readProp(object, key);
  return isJsonObject(value) ? value : undefined;
}

/** An array property, or `[]` when absent or of the wrong shape. */
export function readArray(object: JsonObject, key: string): readonly unknown[] {
  const value = readProp(object, key);
  return Array.isArray(value) ? value : [];
}

/**
 * A 1-based line or column, or `undefined`.
 *
 * Rejects zero and negatives rather than passing them through, because both
 * Rust linters use an out-of-band zero for "no position": biome's JSON reporter
 * falls back to `{line: 0, column: 0}` for a diagnostic that has a file but no
 * span, and oxlint writes `null` when a label's span cannot be located. A
 * violation reported at `file:0:0` points a reader at nothing.
 */
export function readPosition(object: JsonObject, key: string): number | undefined {
  const value = readProp(object, key);
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/**
 * Make a tool-reported path repo-relative — the port of `_relative_to_root`.
 *
 * DELIBERATELY PURE: no `realpathSync`, no `existsSync`. The Python original
 * resolves symlinks, which means it can only run where the files still exist.
 * Keeping this a string operation is what lets every parser be tested against
 * recorded fixtures on a machine that has never seen the project they came
 * from, and a symlinked source root is not a case where reporting the absolute
 * path is wrong — just less pretty.
 *
 * A path that is already relative is passed through (normalized to `/`), which
 * is the common case: oxlint reports cwd-relative paths, biome reports the path
 * as traversed. ESLint reports absolute paths and is the reason this exists.
 * A path OUTSIDE the root keeps its absolute form rather than growing a
 * `../../..` prefix, matching Python's `is_relative_to` guard.
 */
export function relativeToRoot(file: string, root: string): string {
  if (!isAbsolute(file)) {
    return toPosix(file);
  }
  const rel = relative(root, file);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return toPosix(file);
  }
  return toPosix(rel);
}

/** Windows separators to `/`, so a report reads the same on every platform. */
export function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/**
 * What a parser recovered about one finding, before the keys it could not
 * recover are dropped.
 *
 * Deliberately NOT `Partial<Violation>`: the whole point of this shape is that
 * a caller may pass an explicit `undefined` for a field the tool did not
 * report, which under `exactOptionalPropertyTypes` is a different type from
 * omitting the key. `message` is the one field a finding cannot do without.
 */
export interface ViolationInit {
  readonly message: string;
  readonly file?: string | undefined;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
  readonly code?: string | undefined;
  readonly fixHint?: string | undefined;
}

/**
 * Build a `Violation` without emitting keys whose value is unknown.
 *
 * `exactOptionalPropertyTypes` makes `{ line: undefined }` and `{}` different
 * types, and the second is what `violationLocation` expects.
 */
export function violation(init: ViolationInit): Violation {
  return {
    message: init.message,
    ...(init.file === undefined ? {} : { file: init.file }),
    ...(init.line === undefined ? {} : { line: init.line }),
    ...(init.column === undefined ? {} : { column: init.column }),
    ...(init.code === undefined ? {} : { code: init.code }),
    ...(init.fixHint === undefined ? {} : { fixHint: init.fixHint }),
  };
}
