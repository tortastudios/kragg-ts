/**
 * Changed-file detection for incremental checks (`kragg check --changed`).
 *
 * Ported from `kragg/src/kragg/changes.py`. Every git invocation goes through
 * `runCommand`, the single approved subprocess wrapper: argv array, never a
 * shell string. `since` is user input that lands in an argv slot, so a value
 * like `main; rm -rf ~` is one argument that git rejects, not two commands.
 * Do not rewrite any of this to build a command string.
 *
 * NULL IS NOT EMPTY. `changedFiles` returns `null` for "this is not a git
 * repository / git could not answer" and `[]` for "it is a repository and
 * nothing changed". Collapsing the two would make `--changed` silently check
 * nothing outside a repo and report a confident pass. The CLI must print a
 * specific error for `null`, matching the Python implementation.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { runCommand } from "../engine/runner.ts";

/**
 * Extensions kragg treats as TypeScript/JavaScript source.
 *
 * Exported so every gate scopes itself identically — a gate that invents its
 * own list will drift from `--changed` and check a different set of files
 * than the incremental run believes it checked. This replaces the Python
 * version's single `.py` check.
 */
export const SOURCE_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/**
 * Ambient declaration suffixes, excluded by default.
 *
 * A `.d.ts` is generated build output in the overwhelming majority of repos
 * (`tsc --declaration` writes them), it contains no executable statements for
 * a gate to analyse, and re-checking it double-counts the source it was
 * generated from. Hand-written declarations do exist, so
 * `includeDeclarations` opts back in rather than this being hard-coded.
 *
 * Ordering matters at the call site: `.d.ts` also ends with `.ts`, so the
 * declaration test must run before the extension test, not after.
 */
export const DECLARATION_SUFFIXES: readonly string[] = [
  ".d.ts",
  ".d.mts",
  ".d.cts",
];

export interface ChangedFilesOptions {
  /** Include `.d.ts`-style ambient declarations. Default `false`. */
  readonly includeDeclarations?: boolean | undefined;
}

/**
 * Return changed + untracked source files under the allowed paths.
 *
 * Resolves to `null` when git is unavailable or `root` is not a repository.
 *
 * Untracked files are included (`ls-files --others --exclude-standard`)
 * because a brand-new file is exactly the file most likely to be wrong, and
 * `git diff` alone would never see it. `--diff-filter=ACMR` keeps added,
 * copied, modified and renamed paths and drops deletions — a deleted file
 * cannot be checked.
 *
 * Paths are returned repo-relative with `/` separators, in git's order,
 * de-duplicated, and only if they still exist on disk.
 *
 * KNOWN LIMITATION (shared with the Python original): git quotes paths
 * containing non-ASCII or control characters when `core.quotePath` is on (the
 * default), e.g. `"src/caf\303\251.ts"`. Such a name fails the existence check
 * and is silently dropped, so `--changed` under-reports rather than
 * mis-reports. TODO: pass `-z` and split on NUL in both implementations at
 * once, so the two stay conformant.
 */
export async function changedFiles(
  root: string,
  since: string | null,
  allowed: readonly string[],
  options: ChangedFilesOptions = {},
): Promise<string[] | null> {
  if (!(await isGitRepository(root))) {
    return null;
  }
  const base = await resolveBase(root, since);
  if (base === null) {
    return null;
  }
  const changed = (await git(root, ["diff", "--name-only", "--diff-filter=ACMR", base])) ?? "";
  const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard"])) ?? "";
  const names = [...splitLines(changed), ...splitLines(untracked)];
  return filterSourceFiles(root, names, allowed, options.includeDeclarations ?? false);
}

/** Short HEAD sha, or `null` outside a git repository (or on an empty one). */
export async function gitSha(root: string): Promise<string | null> {
  const output = await git(root, ["rev-parse", "--short", "HEAD"]);
  return output === null ? null : output.trim();
}

/** Whether the working tree has uncommitted changes (`false` off a repo). */
export async function gitDirty(root: string): Promise<boolean> {
  const output = await git(root, ["status", "--porcelain"]);
  return output === null ? false : output.trim() !== "";
}

/**
 * Resolve what to diff against.
 *
 * With no `since`, `HEAD` diffs the working tree against the last commit.
 * With a `since` ref, `merge-base` finds where this branch diverged, so
 * `--changed --since main` reports what this branch changed and not what main
 * gained underneath it. An unknown ref makes `merge-base` fail, which
 * propagates as `null` — better than silently diffing against everything.
 */
async function resolveBase(root: string, since: string | null): Promise<string | null> {
  if (since === null) {
    return "HEAD";
  }
  const mergeBase = await git(root, ["merge-base", since, "HEAD"]);
  return mergeBase === null ? null : mergeBase.trim();
}

function filterSourceFiles(
  root: string,
  names: readonly string[],
  allowed: readonly string[],
  includeDeclarations: boolean,
): string[] {
  const files: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name === "" || files.includes(name)) {
      continue;
    }
    if (!includeDeclarations && isDeclaration(name)) {
      continue;
    }
    if (!hasSourceExtension(name)) {
      continue;
    }
    if (isAllowed(name, allowed) && existsSync(join(root, name))) {
      files.push(name);
    }
  }
  return files;
}

function isDeclaration(name: string): boolean {
  return DECLARATION_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function hasSourceExtension(name: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/**
 * Whether a repo-relative path sits at, or under, one of the allowed prefixes.
 *
 * Segment-aware: `src` allows `src/a.ts` but not `srcfoo/a.ts`, which a bare
 * `startsWith` would wrongly admit. An empty `allowed` list allows nothing,
 * matching Python's `any()` over an empty sequence — a caller that means
 * "everywhere" must say so by passing `["."]` or the actual roots.
 */
function isAllowed(name: string, allowed: readonly string[]): boolean {
  const path = normalize(name);
  return allowed.some((prefix) => {
    const base = normalize(prefix);
    if (base === "" || base === ".") {
      return true;
    }
    return path === base || path.startsWith(`${base}/`);
  });
}

/** Repo-relative POSIX normalisation: drop a `./` prefix and trailing `/`. */
function normalize(value: string): string {
  let path = value.replaceAll("\\", "/");
  while (path.startsWith("./")) {
    path = path.slice(2);
  }
  while (path.endsWith("/") && path.length > 1) {
    path = path.slice(0, -1);
  }
  return path;
}

function splitLines(output: string): string[] {
  return output.split("\n");
}

async function isGitRepository(root: string): Promise<boolean> {
  return (await git(root, ["rev-parse", "--is-inside-work-tree"])) !== null;
}

/**
 * Run a git subcommand, returning stdout, or `null` if git failed.
 *
 * `runCommand` never rejects — a missing binary surfaces as exit 127 — so a
 * machine without git behaves the same as a directory without a repository.
 * Both mean "cannot answer", which is what `null` says.
 */
async function git(root: string, args: readonly string[]): Promise<string | null> {
  const result = await runCommand("git", ["git", ...args], root);
  return result.returncode === 0 ? result.stdout : null;
}
