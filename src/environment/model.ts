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

/**
 * How workspaces were detected, and what we could and could not read.
 *
 * This is deliberately NOT a list of resolved package directories. Turning
 * `packages/*` into concrete paths needs a glob matcher, and turning
 * `pnpm-workspace.yaml` into patterns needs a YAML reader; this project has
 * zero runtime dependencies (docs/dependency-policy.md) and has neither.
 * Reporting the patterns we actually read, plus an honest `note` about what
 * we could not, is better than a half-expanded list a gate would then treat
 * as complete.
 */
export interface WorkspaceInfo {
  /** `"none"` is a successful detection: a single-package repo. */
  readonly kind: "none" | "pnpm" | "package-json";
  /** Absolute path to the file that declared the workspace, if any. */
  readonly configPath: string | null;
  /** Raw patterns as declared. Empty for pnpm — see `note`. */
  readonly patterns: readonly string[];
  /** What we could not determine, phrased for a human reading `doctor`. */
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
