/**
 * Resolution of the target project's JavaScript/TypeScript environment.
 *
 * The analogue of `kragg/src/kragg/environment.py`. kragg may be installed
 * globally (`pnpm add -g kragg`) while the project under check has its own
 * `node_modules`. Environment-dependent tools (tsc, the test runner, an
 * auditor) must run from the PROJECT's `node_modules/.bin`, never from
 * kragg's own and never from a global install, or they see the wrong
 * versions and the wrong config and report confidently wrong results.
 *
 * The Python module encodes three rules; this is the same three, translated:
 *
 *  1. The project's toolchain, or nothing. Python refuses to run pytest on
 *     kragg's interpreter; we refuse to run `tsc` from `PATH`.
 *  2. An explicit override outranks inference. `KRAGG_PROJECT_PYTHON` there,
 *     `KRAGG_PACKAGE_MANAGER` here — and an override we cannot honour is an
 *     error, never a silent fall-through.
 *  3. Missing tooling fails LOUDLY with a copy-pasteable fix
 *     (`remediation`), never as a passing gate.
 *
 * THROW vs. RETURN, deliberately split:
 *
 *  - Detection functions RETURN an explicit `"unknown"`. "This repo has no
 *    lockfile and declares no package manager" is a fact about the repo, and
 *    the caller renders it as an environment error with a fix. Throwing would
 *    turn a reportable finding into a stack trace.
 *  - An *unusable explicit instruction* THROWS: an unrecognised
 *    `KRAGG_PACKAGE_MANAGER` means the operator asked for something we cannot
 *    do, and continuing would run the wrong install commands against their
 *    repo. This mirrors Python raising when `KRAGG_PROJECT_PYTHON` points at
 *    a missing path.
 *
 * THIS MODULE IS THE ENTRY POINT for everything above, and re-exports the
 * parts it is assembled from so no caller needs to know which one a symbol
 * lives in:
 *
 *  - `model.ts`          — the resolved-environment data types,
 *  - `packageManager.ts` — which manager owns the repo, and how to install,
 *  - `workspaces.ts`     — workspace declarations, read but not expanded,
 *  - `bin.ts`            — finding a binary inside the project,
 *  - `missing.ts`        — "not installed" versus "ran and failed",
 *  - `manifest.ts`       — defensive `package.json` reads.
 */

import { resolve } from "node:path";

import { nearestBinDir } from "./bin.ts";
import type { ProjectEnvironment } from "./model.ts";
import { detectPackageManager } from "./packageManager.ts";
import { describeWorkspaces, detectWorkspaces } from "./workspaces.ts";

export type { PackageManager, ProjectEnvironment, WorkspaceInfo } from "./model.ts";
export { environmentFound } from "./model.ts";
export type { LockfileSignal, ManagerDetection } from "./packageManager.ts";
export {
  detectPackageManager,
  LOCKFILES,
  PACKAGE_MANAGER_ENV_VAR,
  remediation,
} from "./packageManager.ts";
export { detectWorkspaces } from "./workspaces.ts";
export { resolveBin, toolCommand } from "./bin.ts";
export { missingTool, missingToolMessage } from "./missing.ts";

/**
 * Resolve the full project environment.
 *
 * Never throws for a directory that simply is not a JS project: that returns
 * `packageManager: "unknown"` so the CLI can render a clean environment error
 * with a fix. It DOES propagate the throw from an unusable
 * `KRAGG_PACKAGE_MANAGER`, which is an operator mistake, not a repo state.
 */
export function resolveProjectEnvironment(root: string): ProjectEnvironment {
  const absolute = resolve(root);
  const { packageManager, source } = detectPackageManager(absolute);
  return {
    root: absolute,
    packageManager,
    source,
    binDir: nearestBinDir(absolute),
    workspaces: detectWorkspaces(absolute),
  };
}

/** Multi-line environment summary for `kragg doctor`. */
export function describe(env: ProjectEnvironment): string {
  const lines: string[] = [
    `root:            ${env.root}`,
    env.packageManager === "unknown"
      ? "package manager: unknown (no lockfile, no package.json#packageManager)"
      : `package manager: ${env.packageManager} (via ${env.source})`,
    `bin:             ${env.binDir ?? "missing — dependencies are not installed"}`,
    `workspaces:      ${describeWorkspaces(env.workspaces)}`,
  ];
  if (env.workspaces.note !== null) {
    lines.push(`                 note: ${env.workspaces.note}`);
  }
  return lines.join("\n");
}
