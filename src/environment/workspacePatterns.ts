/**
 * The two small grammars workspace expansion is built on, both FAIL-CLOSED.
 *
 * Split out of `workspaces.ts`, which is the only importer. Neither function
 * here is a general parser, and neither pretends to be:
 *
 *  - {@link readPnpmPackages} reads ONE key of `pnpm-workspace.yaml`,
 *    `packages`, in the one shape pnpm's own documentation writes it — a block
 *    sequence of plain or quoted scalars. This file also carries a project's
 *    supply-chain settings, so a hand-rolled reader that guessed at YAML would
 *    be wrong in exactly the cases that matter (`docs/dependency-policy.md`
 *    is why there is no YAML dependency to lean on). The answer is a reader
 *    that REFUSES: a flow sequence, an anchor, a block scalar, a nested map or
 *    any line it does not recognise is reported as unreadable with the reason,
 *    never read as "these are the packages".
 *  - {@link compilePattern} turns one workspace glob into a matcher over
 *    root-relative directory paths. Literal segments, `*` within a segment and
 *    a whole-segment `**` are the entire supported vocabulary — the same
 *    subset every real `packages/*` / `apps/**` declaration uses. `?`,
 *    character classes, braces and escapes are refused by name. This is NOT
 *    `util/globs.ts`, and must not be: that module is fnmatch, where `*`
 *    spans `/`, which is the wrong rule for `packages/*` and would expand a
 *    workspace to every nested `package.json` it contains.
 *
 * The refusals matter more than the acceptances. A root run prints the member
 * list as "the packages this run did NOT check"; a member silently dropped by
 * a lenient parser is one nobody is told about, which is the failure mode the
 * whole feature exists to close.
 */

/** A list of patterns, or the reason the file could not be read as one. */
export type PatternRead =
  | { readonly ok: true; readonly patterns: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** A YAML top-level key line, e.g. `packages:` or `ignoreScripts: true`. */
const TOP_LEVEL_KEY = /^([A-Za-z_][\w.-]*):(?:\s+(.*?))?\s*$/u;

/** A block-sequence item: two or more spaces, a dash, a space, a scalar. */
const SEQUENCE_ITEM = /^\s+-\s+(.+?)\s*$/u;

/** A blank line, or a comment line. Neither carries data. */
const IGNORABLE = /^\s*(?:#.*)?$/u;

/**
 * Read `packages:` out of `pnpm-workspace.yaml`.
 *
 * `ok: true` with an empty list is a real answer — pnpm treats a file with no
 * `packages` key as a workspace containing only the root — and it is what
 * kragg's own `pnpm-workspace.yaml` produces, since that file exists for
 * settings. `ok: false` is every other departure from the grammar in the
 * module header, each with the line that caused it.
 */
export function readPnpmPackages(text: string): PatternRead {
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => TOP_LEVEL_KEY.exec(line)?.[1] === "packages");
  if (start === -1) {
    return { ok: true, patterns: [] };
  }
  const inline = inlineValue(lines[start] ?? "");
  if (inline === "[]") {
    return { ok: true, patterns: [] };
  }
  if (inline !== null) {
    return refuse(start, lines[start], "`packages` must be a block sequence (one `- pattern` per line)");
  }
  return sequenceAfter(lines, start);
}

/** The value written on the key's own line, or `null` when there is none. */
function inlineValue(line: string): string | null {
  const value = TOP_LEVEL_KEY.exec(line)?.[2];
  return value === undefined || value === "" || value.startsWith("#") ? null : value;
}

/** The block sequence under line `start`, up to the next top-level key. */
function sequenceAfter(lines: readonly string[], start: number): PatternRead {
  const patterns: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (IGNORABLE.test(line)) {
      continue;
    }
    if (TOP_LEVEL_KEY.test(line)) {
      break;
    }
    const item = SEQUENCE_ITEM.exec(line)?.[1];
    const scalar = item === undefined ? null : plainScalar(item);
    if (scalar === null) {
      return refuse(index, line, "not a plain or quoted `- pattern` entry");
    }
    patterns.push(scalar);
  }
  return { ok: true, patterns };
}

/**
 * One scalar as pnpm writes it: `'a'`, `"a"` or bare `a`, optionally followed
 * by a comment. `null` for anything with YAML meaning this reader does not
 * implement (anchors, tags, block scalars, flow collections, empty values).
 */
function plainScalar(item: string): string | null {
  const quoted = /^(['"])(.*)\1(?:\s+#.*)?$/u.exec(item);
  if (quoted?.[2] !== undefined) {
    return quoted[2] === "" ? null : quoted[2];
  }
  const bare = item.split(/\s+#/u, 1)[0] ?? "";
  if (bare === "" || /^[&*!|>[{'"]/u.test(bare) || /[{}[\],]/u.test(bare)) {
    return null;
  }
  return bare;
}

function refuse(index: number, line: string | undefined, why: string): PatternRead {
  return {
    ok: false,
    reason: `pnpm-workspace.yaml line ${index + 1} (\`${(line ?? "").trim()}\`): ${why}`,
  };
}

/** A compiled workspace pattern: what it matches, and whether it subtracts. */
export interface WorkspacePattern {
  readonly source: string;
  readonly negated: boolean;
  readonly matches: (relativeDir: string) => boolean;
  /**
   * How many directory levels below the root a match can sit at, or `null`
   * for a pattern with `**`, which is unbounded. Bounds the directory walk.
   */
  readonly depth: number | null;
}

/** A compiled pattern, or the reason the pattern is outside the grammar. */
export type PatternCompile =
  | { readonly ok: true; readonly pattern: WorkspacePattern }
  | { readonly ok: false; readonly reason: string };

/** Characters that mean something in a fuller glob dialect and nothing here. */
const REFUSED_GLOB_SYNTAX = /[?[\]{}()\\]/u;

/**
 * Compile one workspace glob.
 *
 * `./` and a trailing `/` are stripped, as every package manager strips them;
 * a leading `!` negates. Each remaining segment is a literal, a `*`-bearing
 * name (`pkg-*`) or exactly `**`. Anything else is refused with the pattern
 * named, so the caller can say which declaration it could not expand.
 */
export function compilePattern(source: string): PatternCompile {
  const negated = source.startsWith("!");
  const body = trimPath(negated ? source.slice(1) : source);
  if (body === "" || body === "." || REFUSED_GLOB_SYNTAX.test(body)) {
    return unsupported(source);
  }
  const segments = body.split("/");
  const parts = segments.map(segmentSource);
  if (parts.some((part) => part === null)) {
    return unsupported(source);
  }
  const expression = new RegExp(`^${parts.join("")}$`, "u");
  const unbounded = segments.includes("**");
  return {
    ok: true,
    pattern: {
      source,
      negated,
      matches: (relativeDir: string): boolean => expression.test(`${relativeDir}/`),
      depth: unbounded ? null : segments.length,
    },
  };
}

/** Regex source for one segment (with its trailing `/`), or `null` if refused. */
function segmentSource(segment: string): string | null {
  if (segment === "**") {
    return "(?:[^/]+/)*";
  }
  if (segment === "" || segment === "." || segment === ".." || segment.includes("**")) {
    return null;
  }
  return `${segment.split("*").map(escapeRegExp).join("[^/]*")}/`;
}

/** Drop a `./` prefix and a trailing `/`, the way the package managers do. */
function trimPath(value: string): string {
  let path = value;
  while (path.startsWith("./")) {
    path = path.slice(2);
  }
  while (path.endsWith("/") && path.length > 1) {
    path = path.slice(0, -1);
  }
  return path;
}

function unsupported(source: string): PatternCompile {
  return {
    ok: false,
    reason:
      `workspace pattern \`${source}\` uses syntax kragg does not expand ` +
      "(supported: literal segments, `*` within a segment, a whole `**` segment, " +
      "and a leading `!`)",
  };
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
