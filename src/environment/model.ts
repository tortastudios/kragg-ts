/**
 * What "the target project's environment" is, as data.
 *
 * Split out of `project.ts`, which re-exports all of it. The types live in
 * their own module so the detection modules (`packageManager.ts`,
 * `workspaces.ts`, `bin.ts`, `missing.ts`) can share them without importing
 * the entry point that assembles them — that would be a cycle.
 */

/** Package managers we can detect. `unknown` is a real, reportable answer. */
export type PackageManager = "pnpm" | "npm" | "yarn" | "bun" | "unknown";

/** Every manager `remediation` can produce a real command for. */
export const KNOWN_MANAGERS: readonly PackageManager[] = ["pnpm", "npm", "yarn", "bun"];

/** Whether a string names a manager we support — `unknown` deliberately not. */
export function isKnownManager(value: string): value is PackageManager {
  return (KNOWN_MANAGERS as readonly string[]).includes(value);
}

/** One member package of a workspace. */
export interface WorkspacePackage {
  /** `package.json#name`, or `null` when the manifest declares none. */
  readonly name: string | null;
  /** The package directory, workspace-root-relative, `/`-separated. */
  readonly path: string;
  /** The package directory, absolute — the `root` of a package-level run. */
  readonly root: string;
}

/**
 * How workspaces were detected, what they expand to, and what could not be
 * read.
 *
 * `packages` is the member list the declared patterns expand to, and it is
 * COMPLETE OR EMPTY, never partial: `workspaces.ts` reads
 * `pnpm-workspace.yaml#packages` and `package.json#workspaces` with a
 * deliberately small grammar and refuses anything outside it, because a list
 * with a member missing is exactly what a root run would then report as
 * "every package was accounted for". When the list could not be trusted,
 * `packages` is empty and `note` says why — and a root run prints the note
 * instead of a member list, so the omission is visible either way.
 */
export interface WorkspaceInfo {
  /** `"none"` is a successful detection: a single-package repo. */
  readonly kind: "none" | "pnpm" | "package-json";
  /** Absolute path to the file that declared the workspace, if any. */
  readonly configPath: string | null;
  /** Raw patterns as declared, negations included. */
  readonly patterns: readonly string[];
  /** The members, sorted by path; empty when `note` says the list is unusable. */
  readonly packages: readonly WorkspacePackage[];
  /** Why `packages` could not be expanded, or `null` when it is complete. */
  readonly note: string | null;
}

/** Resolved toolchain for the target project. */
export interface ProjectEnvironment {
  /** Absolute path to the project root (the directory holding package.json). */
  readonly root: string;
  readonly packageManager: PackageManager;
  /**
   * How we decided. One of: `KRAGG_PACKAGE_MANAGER`,
   * `package.json#packageManager`, a lockfile name from `LOCKFILES`, or
   * `"unknown"`. Reported verbatim by `describe` so a surprising answer is
   * traceable to the file that caused it.
   */
  readonly source: string;
  /**
   * Absolute path to the nearest existing `node_modules/.bin`, for `doctor`
   * output. Binary lookup does NOT go through this field — `resolveBin`
   * walks the ancestor chain per binary, because in a pnpm workspace some
   * tools are hoisted to the workspace root and some are not.
   */
  readonly binDir: string | null;
  readonly workspaces: WorkspaceInfo;
}

/**
 * Whether we know enough to run environment-dependent gates.
 *
 * Keyed on the manager, not on `source`: a repo that declares a manager we do
 * not support has a `source` but still no usable answer, and reporting that
 * as "found" would let a gate build an install command it cannot run.
 */
export function environmentFound(env: ProjectEnvironment): boolean {
  return env.packageManager !== "unknown";
}
