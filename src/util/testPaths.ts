/**
 * What `test_paths` selects — the ONE answer, shared by everything that has to
 * know where a project's tests are.
 *
 * `test_paths` used to mean "directories", full stop. That is wrong for half
 * the TypeScript ecosystem: a colocated suite lives at `src/foo.test.ts`, and
 * the only honest way to name it is a pattern. So an entry is now one of two
 * things, told apart by whether it contains a glob metacharacter:
 *
 *  - a DIRECTORY (`test`, `packages/api/test`) — everything under it is part
 *    of the suite, exactly as before;
 *  - a PATTERN (`src/**\/*.test.ts`, `src/**\/*.{test,spec}.ts`) — the files it
 *    matches are the suite, and nothing else under that directory is.
 *
 * THREE CONSUMERS, ONE ANSWER, and that is the whole point of this module:
 *
 *  - {@link testRunnerPatterns} — what `node --test` is handed, and therefore
 *    what `kragg check`'s test gate and `kragg flaky --rerun` execute;
 *  - {@link testScanDirectories} — what the analysis walk is pointed at, since
 *    a walk takes a directory and a pattern is not one;
 *  - {@link isTestPath} — whether one repo-relative file belongs to the suite,
 *    which is what narrows that walk back down to the pattern, and what
 *    `critical-tests` asks about a changed file.
 *
 * A gate that answered any of these differently from the runner would report
 * on a file set the runner never executed, or miss one it did. That already
 * happened: with `test_paths: ["test"]` and a colocated suite, the runner
 * discovered nothing, `test-quality` found no test files, and the gate that
 * ran the suite reported a green "0 tests".
 *
 * ── THE PATTERN DIALECT, AND WHY IT IS NOT `util/globs.ts` ─────────────────
 * `util/globs.ts` is fnmatch, ported from Python, where `*` spans `/` and
 * there is no `**`. That is the right dialect for `structure_exclude` and the
 * mutation scopes, which are shared settings with the Python sibling. It is
 * the WRONG dialect here, because these patterns are also handed to
 * `node --test`, which uses the shell/minimatch convention. Matching a file
 * with one dialect and running it with another is precisely the inconsistency
 * this module exists to remove, so the dialect below is node's:
 *
 *  - `**` matches zero or more whole path segments (`src/**\/*.test.ts`
 *    matches `src/a.test.ts` AND `src/deep/a.test.ts`);
 *  - `*` and `?` match within one segment and never cross `/`;
 *  - `{a,b}` alternates, non-nested — the form Node's glob supports on every
 *    version this package targets, and the form kragg itself generates below;
 *  - `[abc]`, `[a-z]`, `[!abc]` are character classes;
 *  - there is no escaping. A path containing a literal `*` is not addressable,
 *    which is a limitation and not a bug worth a backslash syntax nobody would
 *    get right. SPACES need nothing: every consumer passes argv arrays, so a
 *    pattern is one element and quoting never enters into it.
 */

/**
 * The file-name convention a bare DIRECTORY entry expands to.
 *
 * Exported because it is what the runner is told to discover, and a caller
 * explaining an empty discovery has to be able to print it.
 */
export const TEST_FILE_GLOB = "**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";

/** The characters that make an entry a pattern rather than a directory. */
const META = /[*?[{]/u;

/** Regex syntax that must be escaped to stand for itself. */
const SYNTAX = new Set(["^", "$", "\\", ".", "*", "+", "?", "(", ")", "[", "]", "{", "}", "|", "/"]);

/**
 * Compiled patterns are cached: `isTestPath` is called once per walked file
 * per entry. Clearing wholesale when the cap is hit is fine — recompiling is
 * cheap and nothing about correctness depends on the cache.
 */
const MAX_CACHED_PATTERNS = 256;
const cache = new Map<string, RegExp>();

/** Is this `test_paths` entry a pattern (rather than a plain directory)? */
export function isTestPattern(entry: string): boolean {
  return META.test(entry);
}

/**
 * `test_paths` -> the patterns a runner is handed.
 *
 * A DIRECTORY BECOMES A PATTERN HERE, and it has to. `node --test test`
 * treats the argument as a module specifier, dies with `Cannot find module
 * .../test` before running anything, and the TAP reader parses that as one
 * failed test named after the directory — a complete report saying "1 test,
 * 1 failed" about a suite that never ran. A pattern entry is passed through
 * untouched: the project wrote what it meant.
 *
 * vitest and bun ignore this list and discover their own files from their own
 * config; see `adapters/support/testCommands.ts`.
 */
export function testRunnerPatterns(testPaths: readonly string[]): readonly string[] {
  return testPaths.map((entry) => {
    const path = normalize(entry);
    if (isTestPattern(path)) {
      return path;
    }
    return path === "" ? TEST_FILE_GLOB : `${path}/${TEST_FILE_GLOB}`;
  });
}

/**
 * `test_paths` -> the directories to walk, deduplicated, in order.
 *
 * A pattern contributes its longest leading run of literal segments, so
 * `src/**\/*.test.ts` walks `src` and `**\/*.test.ts` walks the repo root.
 * The walk is only half the answer — it is deliberately WIDER than the
 * pattern, and {@link isTestPath} narrows it back. Using the directory alone
 * would put every source file under `src/` into the test corpus, which would
 * make `test-quality`'s "is this critical function mentioned in any test"
 * check pass for every function in the codebase.
 */
export function testScanDirectories(testPaths: readonly string[]): readonly string[] {
  const directories: string[] = [];
  for (const entry of testPaths) {
    const base = patternBase(normalize(entry));
    if (!directories.includes(base)) {
      directories.push(base);
    }
  }
  return directories;
}

/**
 * Does this repo-relative path belong to the suite `test_paths` describes?
 *
 * Directory entries match by path SEGMENT — `test` matches `test/a.ts` but
 * not `testing/a.ts` — mirroring `isAllowed` in `git/changes.ts`. Pattern
 * entries match by the dialect documented at the top of this file.
 */
export function isTestPath(path: string, testPaths: readonly string[]): boolean {
  const target = normalize(path);
  return testPaths.some((entry) => {
    const spec = normalize(entry);
    if (isTestPattern(spec)) {
      return matchesTestPattern(target, spec);
    }
    if (spec === "" || spec === ".") {
      return true;
    }
    return target === spec || target.startsWith(`${spec}/`);
  });
}

/** Does one repo-relative path match one pattern? See the dialect above. */
export function matchesTestPattern(path: string, pattern: string): boolean {
  return compile(pattern).test(normalize(path));
}

/** Repo-relative POSIX form: no `./` prefix, no trailing slash, no `\`. */
function normalize(value: string): string {
  let path = value.replaceAll("\\", "/");
  while (path.startsWith("./")) {
    path = path.slice(2);
  }
  while (path.endsWith("/") && path.length > 1) {
    path = path.slice(0, -1);
  }
  return path === "." ? "" : path;
}

/** The longest leading run of literal segments in a pattern, or `.`. */
function patternBase(path: string): string {
  if (!isTestPattern(path)) {
    return path === "" ? "." : path;
  }
  const literal: string[] = [];
  for (const segment of path.split("/")) {
    if (isTestPattern(segment)) {
      break;
    }
    literal.push(segment);
  }
  return literal.length === 0 ? "." : literal.join("/");
}

function compile(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached !== undefined) {
    return cached;
  }
  const compiled = new RegExp(`^${translate([...pattern], 0, "").text}$`, "u");
  if (cache.size >= MAX_CACHED_PATTERNS) {
    cache.clear();
  }
  cache.set(pattern, compiled);
  return compiled;
}

/** How far a sub-translation consumed, and what it produced. */
interface Translated {
  readonly text: string;
  /** Index just past the last character consumed. */
  readonly next: number;
}

/**
 * Translate `chars` from `start` until `stop` (or the end) into regex source.
 *
 * `stop` is `"}"` when translating one alternative of a `{a,b}` group and the
 * empty string at the top level, which is what makes the group handling a
 * plain recursion rather than a second scanner.
 */
function translate(chars: readonly string[], start: number, stop: string): Translated {
  let text = "";
  let index = start;
  while (index < chars.length) {
    if (stop !== "" && (chars[index] === stop || chars[index] === ",")) {
      return { text, next: index };
    }
    const piece = token(chars, index);
    text += piece.text;
    index = piece.next;
  }
  return { text, next: index };
}

/** One pattern element — a wildcard, a group, a class, or a literal. */
function token(chars: readonly string[], index: number): Translated {
  const char = chars[index] ?? "";
  if (char === "*") {
    return stars(chars, index);
  }
  if (char === "?") {
    return { text: "[^/]", next: index + 1 };
  }
  if (char === "{") {
    return alternation(chars, index);
  }
  if (char === "[") {
    return characterClass(chars, index);
  }
  return { text: SYNTAX.has(char) ? `\\${char}` : char, next: index + 1 };
}

/**
 * A run of `*`.
 *
 * One star stays inside a segment. Two or more are a globstar and match zero
 * or more WHOLE segments — which is why `**\/` consumes its trailing slash:
 * without that, `src/**\/*.test.ts` could not match `src/a.test.ts`, and the
 * colocated suite this module exists for would be invisible again.
 */
function stars(chars: readonly string[], start: number): Translated {
  let index = start;
  while (chars[index] === "*") {
    index += 1;
  }
  if (index - start === 1) {
    return { text: "[^/]*", next: index };
  }
  if (chars[index] === "/") {
    return { text: "(?:[^/]+/)*", next: index + 1 };
  }
  return { text: ".*", next: index };
}

/** `{a,b}` -> `(?:a|b)`. An unterminated `{` is a literal brace. */
function alternation(chars: readonly string[], start: number): Translated {
  const parts: string[] = [];
  let index = start + 1;
  for (;;) {
    const part = translate(chars, index, "}");
    parts.push(part.text);
    index = part.next;
    if (chars[index] === ",") {
      index += 1;
      continue;
    }
    if (chars[index] === "}") {
      return { text: `(?:${parts.join("|")})`, next: index + 1 };
    }
    return { text: "\\{", next: start + 1 };
  }
}

/** Characters that must be escaped to stand for themselves inside `[...]`. */
const CLASS_SYNTAX = new Set(["\\", "[", "^"]);

/** `[abc]`, `[a-z]`, `[!abc]`. An unterminated `[` is a literal bracket. */
function characterClass(chars: readonly string[], start: number): Translated {
  const negated = chars[start + 1] === "!" || chars[start + 1] === "^";
  // A `]` immediately after the opener (or its `!`) is a literal member, as
  // it is in every fnmatch and shell implementation.
  const opened = start + (negated ? 2 : 1);
  const literalBracket = chars[opened] === "]";
  const scanned = classBody(chars, opened + (literalBracket ? 1 : 0));
  const body = (negated ? "^" : "") + (literalBracket ? "\\]" : "") + scanned.text;
  if (chars[scanned.next] !== "]" || body === "" || body === "^") {
    return { text: "\\[", next: start + 1 };
  }
  return { text: `[${body}]`, next: scanned.next + 1 };
}

/** The members of a class, up to the closing `]` or the end of the pattern. */
function classBody(chars: readonly string[], start: number): Translated {
  let text = "";
  let index = start;
  while (index < chars.length && chars[index] !== "]") {
    const char = chars[index] ?? "";
    text += CLASS_SYNTAX.has(char) ? `\\${char}` : char;
    index += 1;
  }
  return { text, next: index };
}
