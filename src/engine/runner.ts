/**
 * External command execution wrapper.
 *
 * Ported from `kragg/src/kragg/runner.py`. This module is the ONLY approved
 * place in the codebase to spawn a subprocess; a future `forbidden-calls`
 * gate will ban `child_process` imports everywhere else.
 *
 * SECURITY INVARIANT — do not weaken:
 *   Commands are ALWAYS passed as an argv array and NEVER as a shell string.
 *   `execFile` with `shell: false` does no word-splitting, no glob expansion
 *   and no metacharacter interpretation, so a filename like
 *   `foo; rm -rf ~` is one argument, not two commands. Never switch this to
 *   `exec`/`execSync`, never set `shell: true`, and never build the command
 *   by string concatenation.
 */

import { execFile } from "node:child_process";

import type { CompletedCommand } from "./models.ts";

/**
 * Gate output can be large (a failing type-check over a big project). 1 MiB —
 * Node's default — truncates and rejects; 32 MiB is past any realistic gate
 * while still bounding memory if a tool goes haywire.
 */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** No single gate may hang the pipeline. 10 minutes is a generous ceiling. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface RunCommandOptions {
  readonly timeoutMs?: number;
  /**
   * Extra environment variables merged over `process.env`. The parent
   * environment is inherited so tools find their own config; pass explicit
   * overrides here rather than mutating `process.env`.
   */
  readonly env?: NodeJS.ProcessEnv | undefined;
}

/**
 * Run an external tool and capture its result.
 *
 * Never rejects: a non-zero exit, a missing binary and a timeout are all
 * normal outcomes for a gate and are reported through `returncode`/`stderr`.
 * A gate that cannot distinguish "tool found problems" from "tool is missing"
 * would produce the wrong exit code, so callers must inspect `stderr` (see
 * `environment/project.ts`) rather than relying on a thrown error.
 */
export function runCommand(
  name: string,
  command: readonly string[],
  cwd: string,
  options: RunCommandOptions = {},
): Promise<CompletedCommand> {
  const [file, ...args] = command;
  if (file === undefined) {
    throw new TypeError(`runCommand(${name}): command must not be empty`);
  }

  return new Promise<CompletedCommand>((resolve) => {
    // THE one sanctioned subprocess call in the codebase. `kragg.json` bans
    // `node:child_process` outright; this is the wrapper that ban points at,
    // so its own call site carries the exemption — visible in review rather
    // than hidden in a config allowlist. `execFile` with `shell: false` is
    // what makes it safe: no word-splitting, no globbing, no interpolation.
    execFile( // kragg: ignore
      file,
      args,
      {
        cwd,
        // Explicit, not defaulted: see the SECURITY INVARIANT above.
        shell: false,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        windowsHide: true,
        ...(options.env === undefined
          ? {}
          : { env: { ...process.env, ...options.env } }),
      },
      (error, stdout, stderr) => {
        resolve({
          name,
          command: [...command],
          cwd,
          returncode: exitCodeOf(error),
          stdout,
          stderr: stderr === "" && error !== null ? String(error.message) : stderr,
        });
      },
    );
  });
}

/**
 * Recover a POSIX-ish exit code from execFile's error.
 *
 * `error.code` is the numeric exit status for a normal non-zero exit, but a
 * string errno (`"ENOENT"`) when the binary is missing and `null` when the
 * process was killed by a signal. Collapsing all of those to a single
 * non-zero sentinel would lose the distinction gates rely on, so failures we
 * cannot attribute to an exit status become 127 — the conventional
 * "command not executable" status.
 */
function exitCodeOf(error: unknown): number {
  if (error === null || error === undefined) {
    return 0;
  }
  if (typeof error === "object" && "code" in error) {
    const code: unknown = (error as { code: unknown }).code;
    if (typeof code === "number") {
      return code;
    }
  }
  return 127;
}
