/**
 * Parser for `knip --reporter json`.
 *
 * SCHEMA PROVENANCE. Read from knip's own source and its own CLI tests at tags
 * `knip@6.32.0` (current) and `knip@5.88.1` (last 5.x) —
 * `packages/knip/src/reporters/json.ts`, `reporters/util/util.ts`,
 * `constants.ts`, and `test/cli/cli-reporter-json.test.ts`. Not executed here;
 * kragg installs nothing. Both majors are handled, because a project pins its
 * own knip and kragg does not get to choose which.
 *
 *     { "files": ["a.ts"],            // v5 ONLY, absent in v6
 *       "issues": [ { "file": "src/x.ts",
 *                     "owners": [{ "name": "@team" }],   // only with CODEOWNERS
 *                     "exports": [{ "name": "unused", "line": 3, "col": 14,
 *                                   "pos": 42 }],
 *                     "dependencies": [...], "unlisted": [...], … } ] }
 *
 * SHAPE FACTS THAT DRIVE THE CODE BELOW:
 *
 *  - The issue TYPE is the row KEY, not a field on the item. There is no
 *    `type`/`symbolType` property to read.
 *  - Every included type is initialized to an EMPTY ARRAY on every row, so a
 *    row is mostly empty arrays and presence of a key means nothing.
 *  - `duplicates` and (v6) `cycles` are arrays OF ARRAYS of items.
 *  - `enumMembers` is `Record<parentSymbol, Item[]>` in v5 and `Item[]` in v6.
 *    Both are read.
 *  - `classMembers` (v5) was renamed `namespaceMembers` (v6).
 *  - `line`/`col` are frequently ABSENT: never on `binaries` or `files`,
 *    conditionally on `unlisted`/`unresolved`, best-effort on the dependency
 *    types (they point into package.json and are dropped when knip cannot
 *    string-match the entry). A violation without a line is still useful; a
 *    fabricated line 1 is not.
 *
 * WHY ONE TOOL REPLACES TWO. `kragg audit` in Python runs vulture (dead code)
 * then deptry (dependency hygiene). knip covers both, so the CATEGORY has to
 * survive into the report: "this export is unused" and "this import is not in
 * package.json" are both findings, but one is a cleanup and the other is a
 * build that will break on a fresh install. Every type below carries its own
 * `code`, so the two never blur together.
 */

import type { Violation } from "../../engine/models.ts";
import { asCount, asString, extractJson, isJsonObject, objectsIn, prop } from "./json.ts";
import type { JsonObject } from "./json.ts";

/** Which half of the Python `audit` command a finding belongs to. */
export type KnipCategory = "dead-code" | "dependencies";

/** How one knip issue type is reported. */
export interface KnipIssueType {
  /** `Violation.code`. Stable, kragg-owned, and never knip's raw key. */
  readonly code: string;
  readonly category: KnipCategory;
  /** Phrase completing "<name> …". */
  readonly describe: (name: string) => string;
  readonly fixHint: string;
}

/**
 * Every issue type knip 5 or 6 can emit, keyed by its JSON row key.
 *
 * Types absent from a given knip version simply never appear in its output;
 * listing both majors' keys costs nothing and means a project that upgrades
 * knip does not silently start dropping findings. An UNKNOWN key — a type a
 * future knip adds — is still reported, under a generic code, by
 * `unknownType`: dropping a finding because kragg has not been taught its name
 * is the fail-open behaviour this codebase rejects.
 */
export const KNIP_ISSUE_TYPES: Readonly<Record<string, KnipIssueType>> = {
  files: {
    code: "unused-file",
    category: "dead-code",
    describe: () => "file is not imported by anything reachable from an entry point",
    fixHint: "delete it, or add it to knip's `entry` if it is a real entry point",
  },
  exports: {
    code: "unused-export",
    category: "dead-code",
    describe: (name) => `export \`${name}\` is never imported`,
    fixHint: "stop exporting it (keep it module-private), or delete it",
  },
  types: {
    code: "unused-export-type",
    category: "dead-code",
    describe: (name) => `exported type \`${name}\` is never imported`,
    fixHint: "stop exporting it, or delete it",
  },
  nsExports: {
    code: "unused-namespace-export",
    category: "dead-code",
    describe: (name) => `export \`${name}\` is only reached through a namespace import`,
    fixHint: "import it by name at the call site, then delete it if unused",
  },
  nsTypes: {
    code: "unused-namespace-type",
    category: "dead-code",
    describe: (name) => `type \`${name}\` is only reached through a namespace import`,
    fixHint: "import it by name at the call site, then delete it if unused",
  },
  enumMembers: {
    code: "unused-enum-member",
    category: "dead-code",
    describe: (name) => `enum member \`${name}\` is never used`,
    fixHint: "delete the member, or the whole enum if none of it is used",
  },
  classMembers: {
    code: "unused-class-member",
    category: "dead-code",
    describe: (name) => `class member \`${name}\` is never used`,
    fixHint: "delete it, or make it private if it is an implementation detail",
  },
  namespaceMembers: {
    code: "unused-namespace-member",
    category: "dead-code",
    describe: (name) => `namespace member \`${name}\` is never used`,
    fixHint: "delete it, or import it by name at the call site",
  },
  duplicates: {
    code: "duplicate-export",
    category: "dead-code",
    describe: (name) => `\`${name}\` is exported more than once from this module`,
    fixHint: "keep one name for it; two spellings of one symbol split its call sites",
  },
  cycles: {
    code: "import-cycle",
    category: "dead-code",
    describe: (name) => `import cycle through \`${name}\``,
    fixHint: "break the cycle by moving the shared symbol into its own module",
  },
  dependencies: {
    code: "unused-dependency",
    category: "dependencies",
    describe: (name) => `dependency \`${name}\` is declared but never imported`,
    fixHint: "remove it from package.json#dependencies",
  },
  devDependencies: {
    code: "unused-dev-dependency",
    category: "dependencies",
    describe: (name) => `devDependency \`${name}\` is declared but never used`,
    fixHint: "remove it from package.json#devDependencies",
  },
  optionalPeerDependencies: {
    code: "unused-optional-peer-dependency",
    category: "dependencies",
    describe: (name) => `optional peer dependency \`${name}\` is never used`,
    fixHint: "remove it from package.json#peerDependencies",
  },
  unlisted: {
    code: "unlisted-dependency",
    category: "dependencies",
    describe: (name) => `\`${name}\` is imported but not declared in package.json`,
    fixHint: "declare it — this build works only because something else hoisted it",
  },
  binaries: {
    code: "unlisted-binary",
    category: "dependencies",
    describe: (name) => `\`${name}\` is run as a binary but its package is not declared`,
    fixHint: "declare the package that provides it, or the script breaks on a clean install",
  },
  unresolved: {
    code: "unresolved-import",
    category: "dependencies",
    describe: (name) => `import \`${name}\` does not resolve to anything`,
    fixHint: "fix the specifier, or install what provides it",
  },
  catalog: {
    code: "unused-catalog-entry",
    category: "dependencies",
    describe: (name) => `catalog entry \`${name}\` is not referenced by any workspace`,
    fixHint: "remove it from the workspace catalog",
  },
  catalogReferences: {
    code: "unlisted-catalog-reference",
    category: "dependencies",
    describe: (name) => `\`${name}\` references a catalog entry that does not exist`,
    fixHint: "add the entry to the workspace catalog, or pin the version directly",
  },
};

/**
 * Row keys that are NOT issue types and must never become violations.
 *
 * `file` is the row's own path. `owners` is CODEOWNERS metadata that knip
 * attaches when `.github/CODEOWNERS` exists — reporting every code owner as an
 * unused symbol would bury the real findings under noise.
 */
const NON_ISSUE_KEYS: ReadonlySet<string> = new Set(["file", "owners"]);

/** Descriptor for a row key kragg has not been taught. */
function unknownType(key: string): KnipIssueType {
  return {
    code: `knip-${key}`,
    category: "dead-code",
    describe: (name) => `${key}: \`${name}\``,
    fixHint: `reported by knip under \`${key}\`; see https://knip.dev for what it means`,
  };
}

/** Per-category counts, for the gate's one-line summary. */
export interface KnipCounts {
  readonly deadCode: number;
  readonly dependencies: number;
}

/** A parsed knip report. */
export interface KnipReport {
  readonly violations: readonly Violation[];
  readonly counts: KnipCounts;
}

/**
 * Parse knip's JSON report.
 *
 * Returns `undefined` — never throws — for malformed, truncated, empty or
 * foreign JSON. Requiring a top-level `issues` ARRAY is what stops an
 * unrelated document from parsing into "no issues found", which would be a
 * green gate produced by a failed read.
 */
export function parseKnipJson(text: string): KnipReport | undefined {
  // knip writes exactly one JSON document to stdout followed by a newline, but
  // a wrapper script or a package-manager banner can precede it, so scan for
  // the document rather than parsing the whole stream.
  const parsed = extractJson(text);
  if (!isJsonObject(parsed)) {
    return undefined;
  }
  const rows = prop(parsed, "issues");
  if (!Array.isArray(rows)) {
    return undefined;
  }
  const violations: Violation[] = [];
  const unusedFiles = new Set<string>();
  for (const row of objectsIn(rows)) {
    collectRow(row, violations, unusedFiles);
  }
  collectV5UnusedFiles(parsed, violations, unusedFiles);
  return { violations, counts: count(violations) };
}

/**
 * knip 5's top-level `files: string[]` — the unused-file list.
 *
 * v6 moved this onto the per-file rows as `files: [{ name }]`, so both places
 * are read and the set de-duplicates a report that somehow carries both.
 * Skipping this branch would make the unused-file check silently find nothing
 * on knip 5, which is exactly the vulture-equivalent half of this gate.
 */
function collectV5UnusedFiles(
  parsed: JsonObject,
  into: Violation[],
  seen: Set<string>,
): void {
  const files = prop(parsed, "files");
  if (!Array.isArray(files)) {
    return;
  }
  const type = KNIP_ISSUE_TYPES["files"];
  if (type === undefined) {
    return;
  }
  for (const path of files) {
    if (typeof path === "string" && path !== "" && !seen.has(path)) {
      seen.add(path);
      into.push({
        message: type.describe(path),
        file: path,
        code: type.code,
        fixHint: type.fixHint,
      });
    }
  }
}

/** Every issue on one file row. */
function collectRow(row: JsonObject, into: Violation[], unusedFiles: Set<string>): void {
  const file = asString(row, "file");
  for (const key of Object.keys(row)) {
    if (NON_ISSUE_KEYS.has(key)) {
      continue;
    }
    const type = KNIP_ISSUE_TYPES[key] ?? unknownType(key);
    for (const item of itemsFor(prop(row, key))) {
      if (key === "files") {
        const path = asString(item, "name") ?? file;
        if (path === undefined || unusedFiles.has(path)) {
          continue;
        }
        unusedFiles.add(path);
      }
      into.push(violation(type, item, file));
    }
  }
}

/**
 * Flatten one row value into items, whichever of knip's three shapes it is.
 *
 * `Item[]` is the common case; `Item[][]` is `duplicates` and `cycles`;
 * `Record<string, Item[]>` is v5's `enumMembers`. Handling all three in one
 * place is what lets the type table above stay a flat lookup.
 */
function itemsFor(value: unknown): readonly JsonObject[] {
  if (isJsonObject(value)) {
    // An object carrying `name` IS an item; anything else is v5's
    // parentSymbol -> items map and needs one more level of flattening.
    return typeof prop(value, "name") === "string"
      ? [value]
      : Object.keys(value).flatMap((key) => itemsFor(prop(value, key)));
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const items: JsonObject[] = [];
  for (const entry of value) {
    if (isJsonObject(entry)) {
      items.push(entry);
    } else if (Array.isArray(entry)) {
      items.push(...objectsIn(entry));
    }
  }
  return items;
}

function violation(type: KnipIssueType, item: JsonObject, file: string | undefined): Violation {
  const name = asString(item, "name") ?? "";
  const namespace = asString(item, "namespace");
  const qualified = namespace === undefined || namespace === "" ? name : `${namespace}.${name}`;
  return {
    message: type.describe(qualified === "" ? "(unnamed)" : qualified),
    file,
    line: asCount(item, "line"),
    column: asCount(item, "col"),
    code: type.code,
    fixHint: type.fixHint,
  };
}

function count(violations: readonly Violation[]): KnipCounts {
  let dependencies = 0;
  for (const found of violations) {
    if (categoryOf(found.code) === "dependencies") {
      dependencies += 1;
    }
  }
  return { deadCode: violations.length - dependencies, dependencies };
}

/** Reverse the code back to its category, for counting. */
function categoryOf(code: string | undefined): KnipCategory {
  for (const type of Object.values(KNIP_ISSUE_TYPES)) {
    if (type.code === code) {
      return type.category;
    }
  }
  return "dead-code";
}
