/**
 * Total, non-throwing readers for JSON emitted by external tools.
 *
 * Every adapter in `src/adapters/` parses output from a program kragg does not
 * control, at a version kragg did not pin, in a format that has changed across
 * that program's majors. Three failure modes follow from that, and all three
 * are NORMAL rather than exceptional:
 *
 *  1. The JSON is truncated — the tool was killed, or its buffer was cut.
 *  2. The JSON is fine but the SHAPE is not what this version of kragg knows.
 *  3. The JSON is preceded or followed by human-readable noise (a deprecation
 *     warning, a pnpm banner, a "JSON report written to …" line).
 *
 * A parser that throws on any of those turns a reportable finding into a stack
 * trace, and a parser that casts (`as SomeShape`) turns it into a confidently
 * wrong result — the worse outcome, because a gate that reports "no
 * vulnerabilities" from a document it failed to understand is a false green.
 *
 * So: no casts, no assertions. Everything arrives as `unknown`, is narrowed
 * explicitly, and every reader has a total signature — it returns `undefined`
 * for "not that shape" and never throws. This mirrors the discipline in
 * `src/policy/policy.ts`, which parses the other untrusted document kragg
 * reads.
 */

/** A parsed JSON object. Values stay `unknown` until narrowed. */
export type JsonObject = Readonly<Record<string, unknown>>;

/** True for a non-null, non-array object. Arrays are handled by `asArray`. */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `JSON.parse` that reports failure instead of throwing.
 *
 * Returns `undefined` for malformed, truncated or empty input. Callers
 * distinguish "the tool produced nothing parseable" from "the tool produced a
 * document with no findings", because only the second is a passing gate.
 */
export function parseJson(text: string): unknown {
  if (text.trim() === "") {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Read an OWN property.
 *
 * Not decoration: a plain index read resolves `"constructor"` and `"toString"`
 * through `Object.prototype`, so a tool report containing a key by those names
 * would hand a function to a narrowing helper. Tool output is
 * attacker-influenced input — a vulnerability advisory's `title` comes from a
 * third-party registry.
 */
export function prop(object: JsonObject, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

/** The value at `key` when it is a string, else `undefined`. */
export function asString(object: JsonObject, key: string): string | undefined {
  const value = prop(object, key);
  return typeof value === "string" ? value : undefined;
}

/** The value at `key` when it is a finite number, else `undefined`. */
export function asNumber(object: JsonObject, key: string): number | undefined {
  const value = prop(object, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The value at `key` when it is a non-negative integer, else `undefined`.
 *
 * Counts and line numbers use this rather than `asNumber`: a line number of
 * `1.5` or `-1` is corrupt data, and passing it through would produce a
 * `file:line` pointer that resolves to nothing.
 */
export function asCount(object: JsonObject, key: string): number | undefined {
  const value = asNumber(object, key);
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** The value at `key` when it is a boolean, else `undefined`. */
export function asBoolean(object: JsonObject, key: string): boolean | undefined {
  const value = prop(object, key);
  return typeof value === "boolean" ? value : undefined;
}

/** The value at `key` when it is an array, else an empty array. */
export function asArray(object: JsonObject, key: string): readonly unknown[] {
  const value = prop(object, key);
  return Array.isArray(value) ? value : [];
}

/** The value at `key` when it is an object, else `undefined`. */
export function asObject(object: JsonObject, key: string): JsonObject | undefined {
  const value = prop(object, key);
  return isJsonObject(value) ? value : undefined;
}

/** Every element of `values` that is an object. Non-objects are dropped. */
export function objectsIn(values: readonly unknown[]): readonly JsonObject[] {
  return values.filter(isJsonObject);
}

/** Every element of `values` that is a string. Non-strings are dropped. */
export function stringsIn(values: readonly unknown[]): readonly string[] {
  return values.filter((value): value is string => typeof value === "string");
}

/** One `[key, value]` pair from a `{ "<name>": { … } }` report map. */
export type JsonEntry = readonly [key: string, value: JsonObject];

/**
 * Own `[key, value]` pairs whose value is an object.
 *
 * The `{ "<name>": { … } }` map is the dominant advisory-report shape — npm
 * keys by package name, pnpm and npm 6 key by advisory id — so this is the
 * entry point for those parsers. Entries whose value is not an object are
 * dropped rather than defaulted, because there is no finding to report.
 */
export function objectEntries(object: JsonObject): readonly JsonEntry[] {
  const entries: JsonEntry[] = [];
  for (const key of Object.keys(object)) {
    const value = prop(object, key);
    if (isJsonObject(value)) {
      entries.push([key, value]);
    }
  }
  return entries;
}

/**
 * Parse newline-delimited JSON, keeping only the objects.
 *
 * yarn's `--json` output is NDJSON, not JSON: one document per line, with no
 * enclosing array. Blank lines and lines that do not parse are SKIPPED rather
 * than aborting the read, because a single interleaved progress line must not
 * discard the advisories around it.
 */
export function parseNdjson(text: string): readonly JsonObject[] {
  const documents: JsonObject[] = [];
  for (const line of text.split("\n")) {
    const parsed = parseJson(line.trim());
    if (isJsonObject(parsed)) {
      documents.push(parsed);
    }
  }
  return documents;
}

/**
 * Extract the first complete top-level JSON value from noisy output.
 *
 * Necessary because several of these tools print human-readable text on the
 * same stream as their machine-readable report: npm emits `npm warn` lines,
 * pnpm prints a progress banner, and vitest's JSON reporter logs through the
 * same logger as everything else when no `--outputFile` is given. Feeding that
 * whole stream to `JSON.parse` fails on input that plainly contains a usable
 * document.
 *
 * Scans for the first `{` or `[` and walks forward tracking nesting depth,
 * with STRING AWARENESS: a brace inside a string literal (`"fix: use {} not
 * new Object"`) does not change depth, and `\"` inside a string does not end
 * it. Depth counting without that is the classic bug — it truncates any report
 * whose text contains a brace, which advisory titles routinely do.
 *
 * Returns `undefined` when no balanced value is present, including the
 * truncated case where the value opens and never closes.
 */
export function extractJson(text: string): unknown {
  const start = firstOpener(text);
  if (start < 0) {
    return undefined;
  }
  const end = matchingCloser(text, start);
  return end < 0 ? undefined : parseJson(text.slice(start, end + 1));
}

/** `{` or `[` — the two characters that can begin a JSON value. */
function isOpener(char: string | undefined): boolean {
  return char === "{" || char === "[";
}

/** `}` or `]`. Which one is not checked: JSON.parse re-validates the slice. */
function isCloser(char: string | undefined): boolean {
  return char === "}" || char === "]";
}

function firstOpener(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    if (isOpener(text[index])) {
      return index;
    }
  }
  return -1;
}

/**
 * Index of the closer matching the opener at `start`, or -1 if unbalanced.
 *
 * String literals are SKIPPED WHOLE rather than tracked with a flag, which is
 * what keeps the depth arithmetic and the quoting rules from being interleaved
 * in one loop. A brace inside a string must not move the depth, and that is
 * now `endOfString`'s single job.
 */
function matchingCloser(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      index = endOfString(text, index);
      continue;
    }
    if (isOpener(char)) {
      depth += 1;
      continue;
    }
    if (isCloser(char)) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/**
 * Index of the quote closing the string that opens at `start`.
 *
 * Returns `text.length` for an UNTERMINATED string — the truncated-output case
 * — which lands the caller past the end of the text and so leaves it
 * unbalanced, exactly as it should be. `\"` does not end the string; `\\"`
 * does, which is why the escape state is tracked rather than the previous
 * character being tested.
 */
function endOfString(text: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      return index;
    }
  }
  return text.length;
}
