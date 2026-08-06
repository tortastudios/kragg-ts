/**
 * Locating the two scanners.
 *
 * The asymmetry here is the whole content of the module, and it is deliberate.
 *
 * secretlint IS an npm package, so it is resolved by `resolveBin` from the
 * PROJECT's `node_modules/.bin`, exactly like `tsc` and every other
 * project tool. `environment/project.ts` explains why that rule exists and why
 * it never falls back to `PATH`.
 *
 * gitleaks is NOT an npm package — it is a single static Go binary, installed
 * by homebrew or downloaded from GitHub releases. It cannot appear in
 * `node_modules/.bin` under any layout, it has no entry in the project's
 * dependency graph, and there is no "project version" of it for a global one
 * to disagree with. The invariant `resolveBin` protects therefore does not
 * apply to it, and `PATH` is the only place it can be found. This is the ONE
 * exception in the codebase, and it is confined to this file so it stays
 * greppable.
 *
 * The exception is hardened rather than merely taken:
 *
 *  - only ABSOLUTE `PATH` entries are searched. POSIX reads an empty entry as
 *    the current directory, and a `.` entry is explicit about it; either would
 *    let a checked-out repository ship its own `./gitleaks` and have kragg
 *    execute it *while scanning that repository*. A tool that runs untrusted
 *    code from the tree it is auditing has audited nothing;
 *  - the candidate must be a regular file, not a directory that happens to be
 *    named `gitleaks`, and it must be executable.
 *
 * `findGitleaksOnPath` takes the `PATH` string as a parameter so this is
 * testable without mutating the process environment.
 */

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import { resolveBin, type ProjectEnvironment } from "../../environment/project.ts";

/**
 * How the scanners are located.
 *
 * Injectable so resolution is testable without installing either tool — which
 * this package must never do, and which the gate's own supply-chain policy
 * forbids.
 */
export interface SecretScannerLookup {
  /** Absolute path to a gitleaks on `PATH`, or `null`. */
  readonly findGitleaks: () => string | null;
  /** Absolute path to the project's secretlint, or `null`. */
  readonly findSecretlint: () => string | null;
}

/** Locate both scanners the real way. */
export function defaultLookup(env: ProjectEnvironment): SecretScannerLookup {
  return {
    findGitleaks: () => findGitleaksOnPath(),
    findSecretlint: () => resolveBin(env, "secretlint"),
  };
}

/**
 * Find gitleaks on `PATH` — the one documented exception to "never `PATH`".
 *
 * See the module header for why the exception is sound here and nowhere else,
 * and for what the absolute-entry filter is defending against.
 */
export function findGitleaksOnPath(
  pathValue: string | undefined = process.env["PATH"],
): string | null {
  if (pathValue === undefined || pathValue === "") {
    return null;
  }
  const names =
    process.platform === "win32" ? ["gitleaks.exe", "gitleaks.cmd", "gitleaks"] : ["gitleaks"];
  for (const entry of pathValue.split(delimiter)) {
    if (entry === "" || !isAbsolute(entry)) {
      continue;
    }
    for (const name of names) {
      const candidate = join(entry, name);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    // X_OK is meaningless on Windows; `findGitleaksOnPath` discriminates by
    // extension there instead, exactly as `resolveBin` does.
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
