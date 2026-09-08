/**
 * What a scan target IS on disk — and why the answer changes the argv.
 *
 * kragg hands the scanners whatever the caller scoped the run to: the project
 * root (`.`), a directory from `source_paths`, or a single FILE from
 * `--file`, from `--changed`, or from the Claude hook, which reports the one
 * path that was just edited. Those are not interchangeable inputs:
 *
 *  - gitleaks' `dir` takes a filesystem path and walks it, so a file and a
 *    directory both work as written;
 *  - secretlint's positional is a file path OR a picomatch GLOB, and a bare
 *    directory matches the directory ENTRY rather than the files under it.
 *    `globFor` therefore appends `/**` + `/*` — which is right for a
 *    directory and CATASTROPHIC for a file: `src/a.ts/**` + `/*` matches
 *    nothing, secretlint exits 0 having read no file at all, and the gate
 *    reports a clean scan of the very file the caller asked about. A green
 *    gate about nothing is the failure this whole codebase exists to prevent.
 *
 * So the translation has to know which one it is looking at, and that is a
 * filesystem question. It lives here rather than in either adapter because
 * both the orchestration in `../secrets.ts` and the secretlint argv builder
 * need the same answer, and because the two must not drift.
 *
 * A target that EXISTS AS NEITHER is the third case and it is not benign. A
 * path that is gone (a `--file` typo, a stale path) currently becomes a glob
 * that matches nothing, which is again a clean scan of nothing. It is
 * reported instead: kragg does not certify a repository it did not read.
 */

import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Characters that make a target a picomatch PATTERN rather than a path.
 *
 * Shared with `secretlint.globFor` so "is this already a glob?" has exactly
 * one definition. A pattern is passed through untouched and is never checked
 * against the filesystem: it is not supposed to name an existing entry.
 */
export const GLOB_CHARACTERS = /[*?[\]{}]/u;

/** What a target turned out to be. See the module docs for why it matters. */
export type TargetKind = "glob" | "file" | "directory" | "missing";

/** Classify one target, relative to the project root unless it is absolute. */
export function classifyTarget(root: string, target: string): TargetKind {
  if (GLOB_CHARACTERS.test(target)) {
    return "glob";
  }
  const path = isAbsolute(target) ? target : join(root, target);
  try {
    const stats = statSync(path, { throwIfNoEntry: false });
    if (stats === undefined) {
      return "missing";
    }
    return stats.isDirectory() ? "directory" : "file";
  } catch {
    // An unreadable parent directory: we cannot say the path is there, and
    // "cannot tell" is treated as "cannot scan", never as "nothing to scan".
    return "missing";
  }
}

/**
 * The message for targets that cannot be scanned, or `null` when all can.
 *
 * The caller turns a message into an ERROR (exit 3), not a skip: a scope the
 * scanner could not read has cleared nothing, and the alternative — the glob
 * that matches nothing — reads exactly like a clean repository.
 */
export function unreadableTargets(
  root: string,
  targets: readonly string[],
): string | null {
  const missing = targets.filter((target) => classifyTarget(root, target) === "missing");
  if (missing.length === 0) {
    return null;
  }
  return (
    `the secret scan was scoped to ${missing.length === 1 ? "a path that does not" : "paths that do not"} ` +
    `exist under ${root}: ${missing.join(", ")}. ` +
    "kragg will not report a clean scan of a path it could not read — check " +
    "the `--file` argument, or re-run without it to scan the project."
  );
}
