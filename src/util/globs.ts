/**
 * Shared glob matching for repo-relative POSIX paths.
 *
 * Ported from `kragg/src/kragg/globs.py`, which delegates to Python's
 * `fnmatch.fnmatchcase`. Node has no `fnmatch`, so the pattern is translated
 * to a `RegExp` here. The semantics that matter, and that this module
 * guarantees:
 *
 * - **Case-sensitive.** `fnmatchcase` deliberately does not case-fold, so a
 *   pattern behaves identically on macOS, Linux and Windows. `fnmatch` (the
 *   OS-sensitive one) is NOT what is being ported.
 * - **`*` spans `/`.** This is fnmatch, not shell globbing: `src/*.ts` matches
 *   `src/a/b/c.ts`. There is no separate `**`; a run of `*` collapses to one.
 * - **`?` matches exactly one character**, including `/`.
 * - **`[...]` character classes**, with `!` for negation, `]` as the first
 *   member taken literally, and ranges (`[a-z]`).
 * - **No backslash escaping.** fnmatch has none; `\` is an ordinary character.
 * - **The whole string must match** (fnmatch anchors with `\Z`).
 *
 * WHY THIS MUST BE RIGHT: this gates `structure_exclude` and the
 * `mutation_include` / `mutation_exclude` scope knobs. A matcher that is too
 * eager silently exempts files from their budgets — the failure mode where a
 * project believes it is measured and is not. Prefer failing to match over
 * matching by accident; every ambiguous case below resolves that way.
 */

/** Regex syntax characters that must be escaped to stand for themselves. */
const SYNTAX_CHARACTERS = new Set([
  "^",
  "$",
  "\\",
  ".",
  "*",
  "+",
  "?",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "|",
]);

/**
 * Characters that must be escaped INSIDE a character class.
 *
 * `-` is deliberately absent: it has to stay live for ranges (`[a-z]`) to
 * work, and a leading or trailing `-` is already literal in both Python's and
 * JavaScript's regex engines, so leaving it alone is correct in every case.
 */
const CLASS_SYNTAX_CHARACTERS = new Set(["\\", "]", "^", "["]);

/** A pattern that can never match anything, for degenerate/invalid classes. */
const NEVER_MATCHES = "(?!)";

/**
 * Translated patterns are cached because gates call `matchesAny` once per
 * candidate file per pattern. The cap bounds memory if a caller ever feeds
 * unbounded generated patterns; clearing wholesale is fine because a rebuild
 * is cheap and correctness does not depend on the cache.
 */
const MAX_CACHED_PATTERNS = 512;
const cache = new Map<string, RegExp>();

/** True if the repo-relative POSIX path matches any of the fnmatch patterns. */
export function matchesAny(
  relative: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((pattern) => matchesGlob(relative, pattern));
}

/** True if the repo-relative POSIX path matches this one fnmatch pattern. */
export function matchesGlob(relative: string, pattern: string): boolean {
  return compile(pattern).test(relative);
}

/**
 * Compile a pattern, memoized.
 *
 * An invalid class such as `[z-a]` (a reversed range) produces a regex the
 * engine rejects. We degrade to "never matches" rather than throwing, which
 * is the same observable outcome as Python: `fnmatch.translate` collapses a
 * reversed range to its own never-matching `(?!)`, poisoning the whole
 * pattern. A typo in `structure_exclude` therefore exempts nothing — the
 * fail-closed direction.
 */
function compile(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached !== undefined) {
    return cached;
  }
  const compiled = build(pattern);
  if (cache.size >= MAX_CACHED_PATTERNS) {
    cache.clear();
  }
  cache.set(pattern, compiled);
  return compiled;
}

function build(pattern: string): RegExp {
  // The `u` flag makes `[\s\S]` consume a whole code point rather than a lone
  // UTF-16 surrogate, so `?` counts characters the way Python does.
  try {
    return new RegExp(`^(?:${translate(pattern)})$`, "u");
  } catch {
    return new RegExp(`^(?:${NEVER_MATCHES})$`, "u");
  }
}

/**
 * Translate an fnmatch pattern into regex source (unanchored).
 *
 * Mirrors the structure of CPython's `fnmatch.translate` so the two can be
 * diffed. Indexing uses `charAt`, which yields `""` past the end, so the
 * bounds checks read the same as the Python original.
 */
function translate(pattern: string): string {
  const parts: string[] = [];
  const length = pattern.length;
  let i = 0;

  while (i < length) {
    const char = pattern.charAt(i);
    i += 1;

    if (char === "*") {
      i = skipExtraStars(pattern, i);
      parts.push("[\\s\\S]*");
      continue;
    }
    if (char === "?") {
      parts.push("[\\s\\S]");
      continue;
    }
    if (char !== "[") {
      parts.push(escapeLiteral(char));
      continue;
    }

    const close = closingBracket(pattern, i);
    if (close === null) {
      // Unterminated `[` is a literal `[`, exactly as in fnmatch.
      parts.push("\\[");
      continue;
    }
    parts.push(translateClass(pattern.slice(i, close)));
    i = close + 1;
  }

  return parts.join("");
}

/**
 * Index of the first character after a run of `*`.
 *
 * Collapse `**`, `***`, ... into one star. fnmatch has no recursive glob, and
 * collapsing also removes the nested-quantifier shape that makes a regex
 * backtrack catastrophically on a long non-match.
 */
function skipExtraStars(pattern: string, start: number): number {
  let i = start;
  while (i < pattern.length && pattern.charAt(i) === "*") {
    i += 1;
  }
  return i;
}

/**
 * Index of the `]` that closes a class opened just before `start`, or `null`
 * when the pattern has none.
 *
 * A `!` may lead, and a `]` in the first member position is a literal member
 * rather than the terminator.
 */
function closingBracket(pattern: string, start: number): number | null {
  const length = pattern.length;
  let j = start;
  if (pattern.charAt(j) === "!") {
    j += 1;
  }
  if (pattern.charAt(j) === "]") {
    j += 1;
  }
  while (j < length && pattern.charAt(j) !== "]") {
    j += 1;
  }
  return j >= length ? null : j;
}

/** Translate the inside of a `[...]` class (without the brackets). */
function translateClass(raw: string): string {
  const negated = raw.startsWith("!");
  const body = negated ? raw.slice(1) : raw;
  if (body === "") {
    // Degenerate forms the scanner above cannot actually produce, kept for
    // parity with CPython: an empty class matches nothing, and a negated
    // empty class matches anything.
    return negated ? "[\\s\\S]" : NEVER_MATCHES;
  }

  let escaped = "";
  // Iterating with `for..of` walks code points, so an astral character is
  // copied whole instead of being split into surrogates.
  for (const char of body) {
    escaped += CLASS_SYNTAX_CHARACTERS.has(char) ? `\\${char}` : char;
  }
  return `${negated ? "[^" : "["}${escaped}]`;
}

/** Escape one character so it matches only itself. */
function escapeLiteral(char: string): string {
  return SYNTAX_CHARACTERS.has(char) ? `\\${char}` : char;
}
