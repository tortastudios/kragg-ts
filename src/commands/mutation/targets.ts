/**
 * Choosing WHICH files Stryker mutates — the planning half of `kragg mutation`.
 *
 * The port of `select_targets` in `kragg/src/kragg/mutation.py`, with one
 * mechanism deliberately dropped and one deliberately kept. Both decisions are
 * argued in `../mutation.ts`; the short version:
 *
 *  - CRITICALITY SCOPING IS KEPT. It answers "where would an undetected
 *    regression hurt most", which is a question about RISK. Stryker has no
 *    equivalent, and without some scope the first run on a real repo mutates
 *    the whole tree and never finishes.
 *  - CHANGE SCOPING IS DEMOTED to an opt-in (`changedSince`). Stryker's
 *    `--incremental` supersedes it at mutant granularity, but only once an
 *    incremental report exists — on a cold cache (a fresh clone, the first CI
 *    run) it narrows nothing, and the git intersection is the only lever that
 *    still works there.
 *
 * SCOPE PRECEDENCE, unchanged from Python: an explicit `--path` override, else
 * `mutation_include`, else the files defining a critical function. Include
 * globs REPLACE criticality rather than intersecting with it — they exist to
 * reach high-value code that modest fan-in keeps out of the graph, and an
 * intersection would make them unable to do that. `mutation_exclude` is then
 * subtracted from whichever won, because fail-safe glue (telemetry, logging
 * shims) produces mostly-equivalent mutants regardless of how it was selected.
 */

import { readdirSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

import { changedFiles } from "../../git/changes.ts";
import { criticalFunctions } from "../../gates/testDepth/criticalFunctions.ts";
import type { KraggPolicy } from "../../policy/policy.ts";
import { matchesAny } from "../../util/globs.ts";

/**
 * Extensions considered mutable source.
 *
 * Narrower than `SOURCE_EXTENSIONS` in `git/changes.ts` on purpose: `.d.ts` is
 * excluded below, and plain `.js`/`.jsx` in a TypeScript project is nearly
 * always build output or vendored code, which is not ours to mutate.
 */
export const MUTABLE_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
];

/** Suffixes that are declarations, not code — nothing to mutate in them. */
const DECLARATION_SUFFIXES: readonly string[] = [".d.ts", ".d.mts", ".d.cts"];

/** Directories never worth walking, matching `analysis/sourceFile.ts`. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".git",
]);

/** Test-file name shapes, excluded from mutation targets. */
const TEST_PATTERNS: readonly RegExp[] = [
  /\.(?:test|spec)\.[cm]?[jt]sx?$/u,
  /(?:^|\/)__tests__\//u,
];

/** Where a target list came from, for the command's own output. */
export type TargetSource = "path-override" | "mutation_include" | "criticality";

/** Targets were selected, or they could not be. */
export type TargetSelection =
  | {
      readonly ok: true;
      /** Repo-relative POSIX paths, sorted, de-duplicated. */
      readonly files: readonly string[];
      readonly source: TargetSource;
      /** True when a git intersection was applied. */
      readonly narrowedToChanges: boolean;
    }
  | { readonly ok: false; readonly message: string };

export interface TargetOptions {
  readonly root: string;
  readonly policy: KraggPolicy;
  /** `--path` globs, which REPLACE both `mutation_include` and criticality. */
  readonly includeOverride?: readonly string[] | undefined;
  /**
   * Intersect with the git change set. `undefined` means "do not narrow";
   * `null` means "narrow against HEAD"; a string is a ref to merge-base from.
   */
  readonly changedSince?: string | null | undefined;
}

/**
 * Files to mutate: the scope set, optionally narrowed to the change set.
 *
 * Fails — rather than returning an empty list — when a change-set narrowing
 * was asked for and git could not answer. An empty list and "I could not
 * compute the change set" would otherwise both render as "nothing to mutate",
 * and the second one is a silent no-op check, the exact failure mode this
 * codebase exists to prevent.
 */
export async function selectTargets(options: TargetOptions): Promise<TargetSelection> {
  const { root, policy } = options;
  const override = options.includeOverride ?? [];
  const include = override.length > 0 ? override : policy.mutationInclude;
  const source: TargetSource =
    override.length > 0
      ? "path-override"
      : include.length > 0
        ? "mutation_include"
        : "criticality";

  const base =
    include.length > 0
      ? expandGlobs(root, policy.sourcePaths, include)
      : criticalSourceFiles(root, policy.sourcePaths);
  const scoped = base.filter((file) => !matchesAny(file, policy.mutationExclude));

  if (options.changedSince === undefined) {
    return { ok: true, files: scoped, source, narrowedToChanges: false };
  }
  const changed = await changedFiles(root, options.changedSince, policy.sourcePaths);
  if (changed === null) {
    return {
      ok: false,
      message:
        "cannot narrow to changed files: this is not a git repository, or git " +
        "could not resolve the requested ref. Drop the change-set narrowing to " +
        "mutate the whole scope, or run inside a repository.",
    };
  }
  const changedSet = new Set(changed);
  return {
    ok: true,
    files: scoped.filter((file) => changedSet.has(file)),
    source,
    narrowedToChanges: true,
  };
}

/**
 * Files that define at least one critical function.
 *
 * `includePrivate: true` mirrors Python: mutation operates on whole MODULES,
 * so a module earns a place in the target set as soon as anything critical
 * lives in it, regardless of whether a test could import that thing by name.
 */
export function criticalSourceFiles(
  root: string,
  sourcePaths: readonly string[],
): readonly string[] {
  const files = new Set<string>();
  for (const critical of criticalFunctions(root, sourcePaths, { includePrivate: true })) {
    if (isMutable(critical.file)) {
      files.add(critical.file);
    }
  }
  return [...files].sort();
}

/**
 * Resolve include globs to concrete repo-relative source files.
 *
 * The analogue of Python's `_expand`. Globs are matched with `util/globs.ts`
 * (fnmatch semantics, where `*` spans `/`), so `src/*payments*.ts` reaches
 * nested files the way the policy documentation says it does.
 */
export function expandGlobs(
  root: string,
  sourcePaths: readonly string[],
  patterns: readonly string[],
): readonly string[] {
  const files: string[] = [];
  for (const source of sourcePaths) {
    for (const file of walk(root, join(root, source))) {
      if (matchesAny(file, patterns)) {
        files.push(file);
      }
    }
  }
  return [...new Set(files)].sort();
}

/** Recursive walk yielding repo-relative POSIX paths of mutable files. */
function* walk(root: string, dir: string): Generator<string> {
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // A source path the policy lists but the repo does not have. Python skips
    // these silently too (`if not base.is_dir(): continue`).
    return;
  }
  for (const name of [...entries].sort()) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) {
      continue;
    }
    const full = join(dir, name);
    let directory = false;
    try {
      directory = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (directory) {
      yield* walk(root, full);
      continue;
    }
    const rel = toPosix(relative(root, full));
    if (isMutable(rel)) {
      yield rel;
    }
  }
}

/**
 * Whether a repo-relative path is worth mutating.
 *
 * Test files are excluded even when they sit under a source path. Mutating a
 * test produces a mutant that only the test itself could kill, which is
 * circular; Stryker's own default `mutate` patterns exclude them for the same
 * reason, and passing one explicitly would override that default.
 */
export function isMutable(file: string): boolean {
  if (DECLARATION_SUFFIXES.some((suffix) => file.endsWith(suffix))) {
    return false;
  }
  if (!MUTABLE_EXTENSIONS.some((extension) => file.endsWith(extension))) {
    return false;
  }
  return !TEST_PATTERNS.some((pattern) => pattern.test(file));
}

function toPosix(path: string): string {
  return sep === posix.sep ? path : path.split(sep).join(posix.sep);
}
