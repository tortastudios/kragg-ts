/**
 * Finding a tool binary inside the PROJECT's `node_modules/.bin`.
 *
 * Split out of `project.ts`, which re-exports `resolveBin` and
 * `toolCommand`. Everything here exists to keep one promise: kragg runs the
 * project's toolchain or it runs nothing.
 */

import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import type { ProjectEnvironment } from "./model.ts";

/**
 * Resolve a tool binary from the PROJECT's `node_modules/.bin`.
 *
 * MUST NOT fall back to `PATH` or to a global install. A globally-installed
 * `tsc` of a different major silently type-checks the project against the
 * wrong compiler and reports pass/fail that does not reproduce in CI. The
 * caller turns `null` into an `error: true` gate result carrying
 * `remediation(...)` — exit code 3, not a false pass.
 *
 * Walks the ancestor chain rather than looking only in `env.root`, because
 * pnpm and npm workspaces hoist most binaries to the workspace root while
 * leaving version-pinned ones in the member package. First match wins, which
 * is the same precedence Node itself uses.
 *
 * A resolved path that escapes its owning directory tree is REJECTED, not
 * returned: `.bin` entries are symlinks under most layouts, and the check
 * that a binary belongs to the project has to be made on the real path or it
 * checks nothing. Containment is tested against the ancestor that owned the
 * `node_modules`, not against `env.root`, since a hoisted workspace binary
 * legitimately lives above the member package.
 *
 * TODO(win32): the `.cmd` shim this returns on Windows cannot be spawned by
 * `execFile` without a shell, and `src/engine/runner.ts` will not use one.
 * Windows support needs the shim's target resolved to a `node <script>`
 * argv instead. Returning the path is still correct for reporting.
 */
export function resolveBin(env: ProjectEnvironment, name: string): string | null {
  for (const base of binSearchDirs(env.root)) {
    const binDir = join(base, "node_modules", ".bin");
    for (const candidate of binCandidates(binDir, name)) {
      if (!isExecutableFile(candidate)) {
        continue;
      }
      const real = realPathOrNull(candidate);
      if (real !== null && isInside(real, base)) {
        return candidate;
      }
    }
  }
  return null;
}

/** The argv for a project-local tool, or `null` when it is not installed. */
export function toolCommand(
  env: ProjectEnvironment,
  name: string,
  ...args: readonly string[]
): readonly string[] | null {
  const bin = resolveBin(env, name);
  return bin === null ? null : [bin, ...args];
}

/** The nearest existing `node_modules/.bin`, for `doctor` output. */
export function nearestBinDir(root: string): string | null {
  for (const base of binSearchDirs(root)) {
    const binDir = join(base, "node_modules", ".bin");
    if (existsSync(binDir)) {
      return binDir;
    }
  }
  return null;
}

/**
 * Directories to search for `node_modules`, nearest first.
 *
 * The walk is BOUNDED. Node resolution walks to the filesystem root, which
 * would let a stray `~/node_modules/.bin/tsc` satisfy a lookup — exactly the
 * "someone else's toolchain" failure this module exists to prevent. We stop
 * at (and include) the first ancestor that looks like the outer edge of the
 * project: a git root or a pnpm workspace root. We also never leave the home
 * directory, and never pass the filesystem root.
 */
function binSearchDirs(root: string): readonly string[] {
  const stop = resolve(homedir());
  const dirs: string[] = [];
  let current = resolve(root);
  for (;;) {
    dirs.push(current);
    if (existsSync(join(current, ".git")) || existsSync(join(current, "pnpm-workspace.yaml"))) {
      break;
    }
    const parent = dirname(current);
    if (parent === current || current === stop) {
      break;
    }
    current = parent;
  }
  return dirs;
}

/** Platform-specific shim names, most preferred first. */
function binCandidates(binDir: string, name: string): readonly string[] {
  const direct = join(binDir, name);
  if (process.platform !== "win32") {
    return [direct];
  }
  return [`${direct}.cmd`, `${direct}.exe`, `${direct}.ps1`, direct];
}

function isExecutableFile(path: string): boolean {
  try {
    // X_OK is meaningless on Windows (always true); existence is the real test
    // there, and `binCandidates` already discriminates by extension.
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function realPathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Containment test on real paths, `sep`-anchored so `/a/bc` is not in `/a/b`. */
function isInside(path: string, base: string): boolean {
  const realBase = realPathOrNull(base);
  if (realBase === null) {
    return false;
  }
  return path === realBase || path.startsWith(realBase.endsWith(sep) ? realBase : realBase + sep);
}
