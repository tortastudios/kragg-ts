/**
 * Workspace detection and expansion, without inventing members we cannot
 * read.
 *
 * Split out of `project.ts`, which re-exports `detectWorkspaces` and
 * `selectWorkspacePackage`. The declared patterns are read by the two small,
 * fail-closed grammars in `workspacePatterns.ts` — see that module for why a
 * refusal beats a guess here — and expanded against the directories that
 * actually exist, so `packages` is what a package manager would link, not
 * what a regular expression thinks the patterns say.
 *
 * WHAT A MEMBER IS. A directory that matches a positive pattern, matches no
 * negated pattern, and holds a `package.json`. The last condition is the
 * package managers' own rule: pnpm and npm both skip a matching directory
 * with no manifest, so a `packages/README` directory is not a package here
 * either. The workspace root is never a member of itself.
 *
 * WHAT EXPANSION WILL NOT DO. It does not descend into `node_modules`, a
 * dot-directory, or below the deepest level any pattern can reach (`**` is
 * capped at {@link MAX_DEPTH}). It does not read a member's own workspace
 * declaration: a nested workspace is that member's business, and a package
 * run rooted there reports it. And it never returns a partial list — one
 * pattern outside the grammar empties `packages` and fills `note`, because a
 * root run prints the list as "the packages this run did not check".
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { isJsonObject, readJsonObject, stringItems } from "./manifest.ts";
import type { WorkspaceInfo, WorkspacePackage } from "./model.ts";
import {
  compilePattern,
  readPnpmPackages,
  type WorkspacePattern,
} from "./workspacePatterns.ts";

/** How far below the root a `**` pattern is followed. */
const MAX_DEPTH = 8;

/**
 * Detect and expand the workspace `root` declares.
 *
 * `pnpm-workspace.yaml` wins when present, because for a pnpm repo it is the
 * authoritative list even if package.json also carries a `workspaces` field —
 * pnpm ignores the latter. A pnpm file with no `packages` key is a workspace
 * of one, the root, which is what kragg's own file (settings only) declares.
 */
export function detectWorkspaces(root: string): WorkspaceInfo {
  const pnpmConfig = join(root, "pnpm-workspace.yaml");
  if (existsSync(pnpmConfig)) {
    return pnpmWorkspace(root, pnpmConfig);
  }
  const manifest = readJsonObject(join(root, "package.json"));
  const patterns = manifest === null ? null : workspacePatterns(manifest["workspaces"]);
  if (patterns === null) {
    return { kind: "none", configPath: null, patterns: [], packages: [], note: null };
  }
  return {
    kind: "package-json",
    configPath: join(root, "package.json"),
    patterns,
    ...expand(root, patterns, "package.json#workspaces"),
  };
}

function pnpmWorkspace(root: string, configPath: string): WorkspaceInfo {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: "pnpm", configPath, patterns: [], packages: [], note: `could not read pnpm-workspace.yaml: ${reason}` };
  }
  const read = readPnpmPackages(text);
  if (!read.ok) {
    return { kind: "pnpm", configPath, patterns: [], packages: [], note: read.reason };
  }
  return {
    kind: "pnpm",
    configPath,
    patterns: read.patterns,
    ...expand(root, read.patterns, "pnpm-workspace.yaml#packages"),
  };
}

/**
 * Accept both shapes npm/yarn/bun support: a bare array, or an object with a
 * `packages` array (yarn classic's form). Anything else is not a workspace
 * declaration we understand, and is reported as no workspace rather than as a
 * partially-read one.
 */
function workspacePatterns(value: unknown): readonly string[] | null {
  const direct = stringItems(value);
  if (direct !== null) {
    return direct;
  }
  return isJsonObject(value) ? stringItems(value["packages"]) : null;
}

/** The expanded members and the note, for either declaration source. */
type Expansion = Pick<WorkspaceInfo, "packages" | "note">;

/** Expand `patterns` against the directories under `root`. */
function expand(root: string, patterns: readonly string[], source: string): Expansion {
  const compiled: WorkspacePattern[] = [];
  for (const pattern of patterns) {
    const result = compilePattern(pattern);
    if (!result.ok) {
      return { packages: [], note: `${source}: ${result.reason}` };
    }
    compiled.push(result.pattern);
  }
  const positive = compiled.filter((pattern) => !pattern.negated);
  if (positive.length === 0) {
    return { packages: [], note: null };
  }
  const depth = positive.reduce<number>(
    (deepest, pattern) => Math.max(deepest, pattern.depth ?? MAX_DEPTH),
    0,
  );
  const packages: WorkspacePackage[] = [];
  for (const relativeDir of directories(root, depth)) {
    if (!isMember(relativeDir, compiled)) {
      continue;
    }
    const packageRoot = join(root, relativeDir);
    const manifest = readJsonObject(join(packageRoot, "package.json"));
    if (manifest === null) {
      continue;
    }
    const name = manifest["name"];
    packages.push({
      name: typeof name === "string" && name !== "" ? name : null,
      path: relativeDir,
      root: packageRoot,
    });
  }
  packages.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { packages, note: null };
}

/** Matches some positive pattern and no negated one — npm's and pnpm's rule. */
function isMember(relativeDir: string, patterns: readonly WorkspacePattern[]): boolean {
  let included = false;
  for (const pattern of patterns) {
    if (!pattern.matches(relativeDir)) {
      continue;
    }
    if (pattern.negated) {
      return false;
    }
    included = true;
  }
  return included;
}

/**
 * Every directory below `root`, `/`-separated and root-relative, down to
 * `depth` levels. `node_modules` and dot-directories are never entered:
 * nothing a workspace declares lives there, and both can be enormous.
 */
function* directories(root: string, depth: number): Generator<string> {
  const pending: (readonly [string, number])[] = [["", 0]];
  while (pending.length > 0) {
    const [relativeDir, level] = pending.pop() ?? ["", 0];
    if (level >= depth) {
      continue;
    }
    let entries;
    try {
      entries = readdirSync(join(root, relativeDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      const child = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      yield child;
      pending.push([child, level + 1]);
    }
  }
}

/** A package chosen by `--package`, or why the selector names none. */
export type PackageSelection =
  | { readonly ok: true; readonly package: WorkspacePackage }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve one `--package` value: a member's `package.json#name`, or a
 * directory relative to the workspace root.
 *
 * A PATH IS CHECKED ON DISK, so `--package packages/x` works even when the
 * declaration could not be expanded — only the `package.json` has to be there.
 * A NAME needs the expanded list, and when that list is unusable the reason
 * is repeated here, because "unknown package" would send the reader hunting
 * for a typo that is not there.
 */
export function selectWorkspacePackage(
  root: string,
  info: WorkspaceInfo,
  selector: string,
): PackageSelection {
  const relativeDir = normalizeDir(selector);
  const declared = info.packages.find(
    (member) => member.name === selector || member.path === relativeDir,
  );
  const member = declared ?? directoryPackage(root, relativeDir);
  return member === null
    ? { ok: false, reason: unknownSelector(info, selector) }
    : { ok: true, package: member };
}

/** The package at `<root>/<relativeDir>`, or `null` when nothing is there. */
function directoryPackage(root: string, relativeDir: string): WorkspacePackage | null {
  const packageRoot = resolve(root, relativeDir);
  if (relativeDir === "" || packageRoot === resolve(root)) {
    return null;
  }
  const manifest = readJsonObject(join(packageRoot, "package.json"));
  if (manifest === null) {
    return null;
  }
  const name = manifest["name"];
  return {
    name: typeof name === "string" && name !== "" ? name : null,
    path: relativeDir,
    root: packageRoot,
  };
}

/** Why a selector names nothing — with the member list, or the reason there is none. */
function unknownSelector(info: WorkspaceInfo, selector: string): string {
  if (info.note !== null) {
    return `--package ${selector}: no such directory, and names cannot be resolved because ${info.note}`;
  }
  const known = info.packages.map((member) => member.name ?? member.path);
  const list =
    known.length === 0
      ? "this root declares no workspace packages"
      : `known packages: ${known.join(", ")}`;
  return `--package ${selector}: no such package name or directory (${list})`;
}

/** `./packages/a/` -> `packages/a`, in the spelling `WorkspacePackage.path` uses. */
function normalizeDir(value: string): string {
  let path = value.replaceAll("\\", "/");
  while (path.startsWith("./")) {
    path = path.slice(2);
  }
  while (path.endsWith("/") && path.length > 1) {
    path = path.slice(0, -1);
  }
  return path;
}

/** One-line workspace summary for `describe`. */
export function describeWorkspaces(info: WorkspaceInfo): string {
  if (info.kind === "none") {
    return "none (single-package repo)";
  }
  if (info.note !== null) {
    return `${info.kind} (${info.configPath ?? "?"}) — members not expanded`;
  }
  if (info.packages.length === 0) {
    return `${info.kind} (${info.configPath ?? "?"}) — no member packages; the root alone`;
  }
  const members = info.packages.map((member) =>
    member.name === null ? member.path : `${member.path} (${member.name})`,
  );
  return `${info.kind}, ${info.packages.length} packages: ${members.join(", ")}`;
}
