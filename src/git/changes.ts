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
 * nothing outside a repo and report a confident pass. `scanChanges` is the
 * same distinction with the reason kept: `{ ok: false, message }` carries what
 * git actually said, so the CLI can print it instead of guessing at "not a git
 * repository" for a bad ref.
 *
 * EVERY PLUMBING CALL IS `-z`. With `core.quotePath` on — the default — git
 * renders a non-ASCII name as `"src/caf\303\251.ts"`, quotes and octal escapes
 * included. That path matched nothing on disk, so `src/café.ts` was dropped
 * from the selection and `--changed` reported a confident pass over a file it
 * had never looked at. `-z` turns off the quoting and separates records with
 * NUL, which no path may contain, so the parse is exact for every byte
 * sequence a filesystem accepts.
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

/** {@link selectSourceFiles} options. */
export interface SourceSelectOptions extends ChangedFilesOptions {
  /**
   * Drop a name that is not present under `root`. Default `true`.
   *
   * `false` is for the paths a change set REMOVES: a deleted file is a real
   * part of what changed and must be classified as source or not, but it is
   * gone from disk by definition, so an existence test would erase it.
   */
  readonly mustExist?: boolean | undefined;
}

/** Repo-relative paths a change set touches, split by what is left on disk. */
export interface ChangedPaths {
  /**
   * Paths the change set leaves in place: added, copied, modified, a rename's
   * DESTINATION, and untracked files.
   */
  readonly present: readonly string[];
  /**
   * Paths the change set takes away: deletions, and a rename's SOURCE.
   *
   * Never a target for a per-file tool — there is no file to hand it — but
   * still part of what changed, and callers must treat it as such. A commit
   * whose only source edit is a deletion is not a commit with nothing to
   * check: it is the one most likely to have broken an importer.
   */
  readonly removed: readonly string[];
}

/**
 * A change set, or the reason git could not produce one.
 *
 * The failure arm carries git's own message. "not a git repository" and "no
 * such ref `mian`" are different mistakes with different fixes, and a caller
 * that flattens both into one sentence sends the user looking in the wrong
 * place.
 */
export type ChangeScan =
  | { readonly ok: true; readonly paths: ChangedPaths }
  | { readonly ok: false; readonly message: string };

/**
 * Everything the working tree changed against `since` (or `HEAD`), unfiltered.
 *
 * Unfiltered on purpose: the caller decides what counts. `--changed` keeps the
 * source files, but a changed `tsconfig.json` or lockfile is not a source file
 * and still changes what every gate would conclude, so the filtering cannot
 * happen in here. See `commands/scope.ts`.
 *
 * Untracked files are included (`ls-files --others --exclude-standard`)
 * because a brand-new file is exactly the file most likely to be wrong, and
 * `git diff` alone would never see it.
 *
 * `--name-status` rather than `--name-only` so a deletion stays distinguishable
 * from an edit. Rename detection may or may not be on in a given repo, and it
 * does not matter here: a detected rename arrives as `R<score> old new` and an
 * undetected one as `D old` plus `A new`, and both land in the same two
 * buckets.
 */
export async function scanChanges(root: string, since: string | null): Promise<ChangeScan> {
  const inside = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) {
    return inside;
  }
  const base = await diffBase(root, since);
  if (!base.ok) {
    return base;
  }
  const plumbing = await gitAll(root, [
    ["diff", "--name-status", "-z", base.stdout.trim()],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ]);
  if (!plumbing.ok) {
    return plumbing;
  }
  const [diff = "", untracked = ""] = plumbing.outputs;
  const paths = parseNameStatus(diff);
  return {
    ok: true,
    paths: {
      present: dedupe([...paths.present, ...splitNul(untracked)]),
      removed: dedupe(paths.removed),
    },
  };
}

/**
 * Return changed + untracked source files under the allowed paths.
 *
 * Resolves to `null` when git is unavailable or `root` is not a repository —
 * NOT `[]`, which means "a repository, and nothing changed". Deletions are
 * absent from the result because a deleted file cannot be checked; callers
 * that must not mistake "only deletions" for "nothing changed" use
 * {@link scanChanges} and read `removed` as well.
 *
 * Paths are returned repo-relative with `/` separators, in git's order,
 * de-duplicated, and only if they still exist on disk.
 */
export async function changedFiles(
  root: string,
  since: string | null,
  allowed: readonly string[],
  options: ChangedFilesOptions = {},
): Promise<string[] | null> {
  const scan = await scanChanges(root, since);
  if (!scan.ok) {
    return null;
  }
  return selectSourceFiles(root, scan.paths.present, allowed, options);
}

/** Short HEAD sha, or `null` outside a git repository (or on an empty one). */
export async function gitSha(root: string): Promise<string | null> {
  const output = await git(root, ["rev-parse", "--short", "HEAD"]);
  return output.ok ? output.stdout.trim() : null;
}

/** Whether the working tree has uncommitted changes (`false` off a repo). */
export async function gitDirty(root: string): Promise<boolean> {
  const output = await git(root, ["status", "--porcelain"]);
  return output.ok && output.stdout.trim() !== "";
}

/**
 * Resolve what to diff against.
 *
 * With no `since`, `HEAD` diffs the working tree against the last commit.
 * With a `since` ref, `merge-base` finds where this branch diverged, so
 * `--changed --since main` reports what this branch changed and not what main
 * gained underneath it. An unknown ref makes `merge-base` fail, and the
 * failure propagates with git's message rather than becoming an empty diff.
 *
 * Exported for `kragg brief`, which reads the base revision of a file with
 * {@link showAtRef} and must use the SAME base the change set was derived
 * from, or the two halves of one brief describe different change sets.
 */
export async function diffBase(root: string, since: string | null): Promise<GitResult> {
  if (since === null) {
    return { ok: true, stdout: "HEAD" };
  }
  return await git(root, ["merge-base", since, "HEAD"]);
}

/**
 * The contents of a repo-relative `path` at `ref`, or `null` when the file did
 * not exist there (or git could not answer). `ref` comes from
 * {@link diffBase} and `path` from a change set; each lands in one argv slot.
 *
 * `null` and `""` are both "nothing to compare against" for the callers of
 * this — a file that is new in the change set, and an empty one, contain the
 * same zero markers and the same zero baseline entries — so the failure arm
 * is flattened here rather than carried.
 */
export async function showAtRef(root: string, ref: string, path: string): Promise<string | null> {
  const result = await git(root, ["show", `${ref}:${normalize(path)}`]);
  return result.ok ? result.stdout : null;
}

/**
 * Keep the JavaScript/TypeScript source files among `names`.
 *
 * Order is preserved, duplicates are dropped, and by default a name that is
 * not on disk is dropped too — a file git staged and the working tree then
 * removed cannot be handed to a per-file tool. `mustExist: false` turns that
 * off for the removed half of a change set.
 */
export function selectSourceFiles(
  root: string,
  names: readonly string[],
  allowed: readonly string[],
  options: SourceSelectOptions = {},
): string[] {
  const files: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name !== "" && !files.includes(name) && isSelectable(root, name, allowed, options)) {
      files.push(name);
    }
  }
  return files;
}

/** Whether one non-empty name survives every filter `selectSourceFiles` applies. */
function isSelectable(
  root: string,
  name: string,
  allowed: readonly string[],
  options: SourceSelectOptions,
): boolean {
  if (!(options.includeDeclarations ?? false) && isDeclaration(name)) {
    return false;
  }
  if (!hasSourceExtension(name) || !isAllowed(name, allowed)) {
    return false;
  }
  return (options.mustExist ?? true) ? existsSync(join(root, name)) : true;
}

/**
 * Split `git diff --name-status -z` into the present and removed halves.
 *
 * The `-z` record format is a status field, then one path — or, for a rename
 * or a copy, TWO paths, source first. A copy leaves its source in place, so
 * only a rename contributes to `removed`.
 */
function parseNameStatus(output: string): ChangedPaths {
  const fields = output.split("\0");
  const present: string[] = [];
  const removed: string[] = [];
  let index = 0;
  while (index < fields.length) {
    const status = fields[index] ?? "";
    if (status === "") {
      index += 1;
      continue;
    }
    const record = readRecord(status, fields[index + 1], fields[index + 2]);
    if (record === null) {
      break;
    }
    present.push(...record.present);
    removed.push(...record.removed);
    index += record.width;
  }
  return { present, removed };
}

/** What one `--name-status -z` record contributes, and how many fields it ate. */
interface StatusRecord extends ChangedPaths {
  /** NUL-separated fields this record occupies: 2, or 3 for a rename/copy. */
  readonly width: number;
}

/** One `--name-status -z` record, or `null` when its fields are truncated. */
function readRecord(
  status: string,
  source: string | undefined,
  destination: string | undefined,
): StatusRecord | null {
  if (source === undefined) {
    return null;
  }
  if (status.startsWith("R") || status.startsWith("C")) {
    if (destination === undefined) {
      return null;
    }
    // A COPY leaves its source in place; only a rename takes one away.
    const removed = status.startsWith("R") ? [source] : [];
    return { present: [destination], removed, width: 3 };
  }
  if (status.startsWith("D")) {
    return { present: [], removed: [source], width: 2 };
  }
  return { present: [source], removed: [], width: 2 };
}

function splitNul(output: string): string[] {
  return output.split("\0").filter((name) => name !== "");
}

function dedupe(names: readonly string[]): string[] {
  return [...new Set(names.filter((name) => name !== ""))];
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

/** Stdout, or the reason git could not answer. */
export type GitResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly message: string };

/**
 * Run a git subcommand.
 *
 * `runCommand` never rejects — a missing binary surfaces as exit 127 — so a
 * machine without git behaves the same as a directory without a repository.
 * Both mean "cannot answer", and both now say WHICH: git's own diagnostic is
 * carried out rather than flattened to a bare `null`, because "fatal: not a
 * git repository" and "fatal: Not a valid object name mian" send a reader to
 * two different places.
 */
async function git(root: string, args: readonly string[]): Promise<GitResult> {
  const result = await runCommand("git", ["git", ...args], root);
  if (result.returncode === 0) {
    return { ok: true, stdout: result.stdout };
  }
  return { ok: false, message: gitFailureMessage(args, result.stderr, result.returncode) };
}

/** Every command's stdout in order, or the first failure's message. */
type BatchResult =
  | { readonly ok: true; readonly outputs: readonly string[] }
  | { readonly ok: false; readonly message: string };

/**
 * Run several git subcommands in order, stopping at the first failure.
 *
 * One failure path for the whole batch, deliberately: every one of these
 * commands answers part of the same question, and a caller that swallowed any
 * of them would be reporting a change set assembled from an unknown fraction
 * of the repository. A repository with no commit yet is the reachable case —
 * `git diff HEAD` has no HEAD to diff against — and it arrives here as the
 * error it is, rather than as "nothing changed".
 */
async function gitAll(root: string, commands: readonly (readonly string[])[]): Promise<BatchResult> {
  const outputs: string[] = [];
  for (const args of commands) {
    const result = await git(root, args);
    if (!result.ok) {
      return result;
    }
    outputs.push(result.stdout);
  }
  return { ok: true, outputs };
}

/** `git <subcommand>: <what git said>`, or an exit status when it said nothing. */
function gitFailureMessage(
  args: readonly string[],
  stderr: string,
  returncode: number,
): string {
  const said = stderr
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  const subcommand = args[0] ?? "git";
  return `git ${subcommand}: ${said ?? `exited ${returncode}`}`;
}
