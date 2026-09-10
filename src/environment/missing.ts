/**
 * Telling "the tool is not installed" apart from "the tool ran and failed".
 *
 * Split out of `project.ts`, which re-exports both functions. The distinction
 * decides the process exit code — 3 (environment) versus 1 (findings) — so
 * the evidence required here is textual and deliberately strict.
 *
 * "Textual" is not the same as "these words appeared somewhere". Every pattern
 * below is a shape only a FAILED LAUNCH produces — a shell's own refusal, a
 * spawn ENOENT, Node's uncaught loader crash with its internal stack under it
 * — never a phrase a tool might use in a report ABOUT the project's code. See
 * {@link unresolvedEntryPoint} for the one that had to be re-derived.
 */

import { join } from "node:path";

import type { CompletedCommand } from "../engine/models.ts";
import type { ProjectEnvironment } from "./model.ts";
import { remediation } from "./packageManager.ts";

/**
 * Patterns that mean "the thing we tried to run does not exist here".
 *
 * The analogue of Python's `_NO_MODULE`. Ordered by specificity; the first
 * match names the tool. `spawn X ENOENT` is what `src/engine/runner.ts`
 * surfaces when the binary itself is absent, and is the common case.
 */
const MISSING_PATTERNS: readonly RegExp[] = [
  // Node's own failure to spawn: what `runner.ts` surfaces for an absent binary.
  /spawn ([^\s]+) ENOENT/,
  /ENOENT[^\n]*?no such file or directory,?\s+(?:spawn|open)\s+'?([^'\n]+?)'?$/m,
  // Windows cmd.exe.
  /'([^']+)' is not recognized as an internal or external command/,
  // Shells, which differ: `sh: tsc: command not found`, `sh: 1: tsc: not found`,
  // `zsh: command not found: tsc`. The token is captured WITHOUT `:` in its
  // character class so the shell's own name and line number are not mistaken
  // for the tool — and zsh's trailing form is tried FIRST, because the
  // leading-token pattern would otherwise capture `zsh` from it.
  /command not found: ([\w@./-]+)/,
  /([\w@./-]+): command not found/,
  /([\w@./-]+): not found/,
];

/**
 * The HEADER of an uncaught Node module-resolution error.
 *
 * Anchored to the start of a line and to Node's own error class, because the
 * words themselves are not evidence of anything: `Cannot find module 'x'` is
 * also how a TypeScript compiler diagnostic reads (TS2307, "Cannot find
 * module 'node:fs' or its corresponding type declarations"), and tsc writes
 * that to STDOUT of a run that worked perfectly. Matching it loose reported
 * the whole type-check gate as "tsc is not installed" — exit 3 — instead of
 * the compiler finding it actually was. The two spellings Node emits:
 *
 *   Error: Cannot find module 'foo'                      (CJS loader)
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'foo' imported from …
 */
const UNCAUGHT_RESOLUTION_ERROR =
  /^Error(?: \[ERR_[A-Z_]+\])?: Cannot find (?:module|package) '([^']+)'/mu;

/**
 * A stack frame inside Node's OWN module loader.
 *
 * This — not the wording of the message — is what makes the error above a
 * process that died before it could start, rather than a line of some tool's
 * report. Node prints its resolution failures as uncaught exceptions, and the
 * frames under `node:internal/modules/` are always there: the CJS path goes
 * through `Module._resolveFilename` / `Module._load` in
 * `node:internal/modules/cjs/loader`, the ESM path through `packageResolve` /
 * `moduleResolve` in `node:internal/modules/esm/resolve`. No diagnostic a
 * compiler, linter or test runner prints about the code it is analysing
 * carries them, so no such diagnostic can be mistaken for a missing tool.
 *
 * `[ \t]*` rather than `\s*`: with `m` the latter would match across the
 * newline and let a frame belonging to no line satisfy the anchor.
 */
const NODE_LOADER_FRAME = /^[ \t]*at (?:[^\n]*\()?node:internal\/modules\//mu;

/**
 * The name in a genuine Node module-resolution failure, or `null`.
 *
 * BOTH signals are required — the uncaught-error header AND the loader stack —
 * and the stack is the load-bearing one. Tightening the message pattern alone
 * would only move the coincidence somewhere else: the next tool whose
 * diagnostic happens to be worded like Node's would trip it just as the
 * compiler did.
 */
function unresolvedEntryPoint(haystack: string): string | null {
  if (!NODE_LOADER_FRAME.test(haystack)) {
    return null;
  }
  const captured = UNCAUGHT_RESOLUTION_ERROR.exec(haystack)?.[1];
  return captured === undefined || captured === "" ? null : captured;
}

/**
 * Detect "the tool is missing" from a command result — Python's
 * `missing_module()`.
 *
 * Returns the name of what could not be found, or `null` when the command
 * ran and merely failed. A gate that cannot tell those apart reports the
 * wrong exit code: a missing tool is exit 3 (environment), while findings
 * are exit 1.
 *
 * Requires TEXTUAL evidence and deliberately does NOT treat exit status 127
 * as sufficient. `runner.ts` also returns 127 for a timeout or a signal
 * death, and reporting a test suite that timed out as "vitest is not
 * installed" would send the user to fix the wrong thing.
 *
 * The unresolved-entry-point case is checked LAST and structurally, by
 * {@link unresolvedEntryPoint}, because the words a failed `require` prints
 * are also the words a compiler prints ABOUT the code it just analysed.
 */
export function missingTool(result: CompletedCommand): string | null {
  const haystack = `${result.stderr}\n${result.stdout}`;
  for (const pattern of MISSING_PATTERNS) {
    const match = pattern.exec(haystack);
    const captured = match?.[1];
    if (captured !== undefined && captured !== "") {
      return captured;
    }
  }
  return unresolvedEntryPoint(haystack);
}

/**
 * The message for a tool that is declared-or-not but definitely not runnable.
 *
 * The analogue of `missing_interpreter_message`: names what is missing, where
 * we looked, and the one command that fixes it. `packageName` is separate
 * from `binName` because they differ often enough to matter (`tsc` ships in
 * `typescript`).
 */
export function missingToolMessage(
  env: ProjectEnvironment,
  binName: string,
  packageName: string,
): string {
  const where = env.binDir ?? join(env.root, "node_modules", ".bin");
  return (
    `${binName} is not installed in this project (looked in ${where}).\n` +
    `kragg will not fall back to a global ${binName}: a different version ` +
    `would report results that do not reproduce in CI.\n` +
    remediation(env.packageManager, packageName)
  );
}
