/**
 * Telling "the tool is not installed" apart from "the tool ran and failed".
 *
 * Split out of `project.ts`, which re-exports both functions. The distinction
 * decides the process exit code — 3 (environment) versus 1 (findings) — so
 * the evidence required here is textual and deliberately strict.
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
  // A tool that exists but whose entry point does not resolve.
  /Cannot find module '([^']+)'/,
  /Cannot find package '([^']+)'/,
];

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
  return null;
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
