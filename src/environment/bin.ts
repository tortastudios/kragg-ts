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
 * Which platform's `node_modules/.bin` layout to assume.
 *
 * INJECTED rather than read inline from `process.platform`, because the
 * Windows branch of this module cannot be reached on the machines this
 * project is developed and tested on. A branch only reachable on a host
 * nobody runs the suite on is a branch nobody has ever executed; taking the
 * platform as an argument makes it an ordinary test. Production callers omit
 * it and get `process.platform`.
 */
export interface BinLookupOptions {
  readonly platform?: NodeJS.Platform;
}

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
 * WINDOWS: what comes back here is a `.cmd` shim, which `execFile` refuses
 * to spawn without a shell (Node rejects batch files outright since the
 * CVE-2024-27980 fix) and `src/engine/runner.ts` will not use one. Returning
 * the shim path is still the right answer for this function — it is the
 * project's entry for that tool, and `doctor` should print it. Turning it
 * into a spawnable argv is `runner.ts`'s job, at the single sanctioned
 * subprocess call; see `launchPlan` there.
 */
export function resolveBin(
  env: ProjectEnvironment,
  name: string,
  options: BinLookupOptions = {},
): string | null {
  const platform = options.platform ?? process.platform;
  for (const base of binSearchDirs(env.root)) {
    const binDir = join(base, "node_modules", ".bin");
    for (const candidate of binCandidates(binDir, name, platform)) {
      if (!isExecutableFile(candidate, platform)) {
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

/**
 * Extensions Windows shims use, lowercase, in the order `resolveBin` prefers.
 *
 * `.cmd` first because that is what npm, pnpm and yarn all write and what a
 * Windows user would run by hand. `.exe` next: a real executable needs no
 * shim rewriting at all. `.ps1` is listed so it is FOUND rather than reported
 * missing, but it is the least preferred — PowerShell brings its own
 * argument parsing, which is the problem, not the fix.
 */
const WINDOWS_BIN_EXTENSIONS: readonly string[] = [".cmd", ".exe", ".ps1"];

/**
 * Platform-specific shim names, most preferred first.
 *
 * The extension-less entry is tried LAST on Windows and is the only entry
 * anywhere else. On Windows it is the Cygwin/Git-Bash shell script npm and
 * pnpm write alongside the `.cmd`; `CreateProcess` cannot run it, so it is a
 * last resort there — but `runner.ts` can still read the target path out of
 * it, which is better than reporting the tool as missing.
 */
function binCandidates(
  binDir: string,
  name: string,
  platform: NodeJS.Platform,
): readonly string[] {
  const direct = join(binDir, name);
  if (platform !== "win32") {
    return [direct];
  }
  return [...WINDOWS_BIN_EXTENSIONS.map((extension) => `${direct}${extension}`), direct];
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    // X_OK is meaningless on Windows (always true); existence is the real test
    // there, and `binCandidates` already discriminates by extension.
    accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
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
