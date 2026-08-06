/**
 * `kragg hook <protocol>` — the CLI entry point for harness hook adapters.
 *
 * Thin on purpose. All protocol knowledge lives in `src/hooks/`; this file
 * only resolves the protocol name, reads stdin, and hands over. Ported from
 * `cmd_hook` in `kragg/src/kragg/commands.py`, which is three lines.
 *
 * A NOTE ON THE EXIT CODE, because it is easy to get backwards. Once a hook
 * protocol is selected, EVERY outcome is exit 0 — success, gate failure and
 * internal crash alike. Claude Code only reads a hook's stdout JSON on exit
 * 0, and treats other non-zero codes as advisory notices the model never
 * sees, so a non-zero return would silently disable the feedback loop. See
 * the docstrings in `src/hooks/claude.ts` and `src/hooks/protocol.ts`.
 *
 * The one exception is an UNKNOWN PROTOCOL NAME, which is a CLI usage error
 * rather than a hook outcome: nothing is running yet, there is no model
 * waiting on stdout, and the only way to reach it is a mistyped
 * `.claude/settings.json`. That must be loud — a typo that silently ran the
 * Claude adapter under another harness's protocol would produce a hook that
 * appears installed and does nothing.
 */

import { readFileSync } from "node:fs";

import { EXIT_USAGE } from "../engine/report.ts";
import { runClaudeHook, type RunCheck } from "../hooks/claude.ts";

/** Harness protocols this command speaks. Only Claude Code exists today. */
export const HOOK_PROTOCOLS: readonly string[] = ["claude"];

/** Default protocol when the CLI dispatcher passes none. */
export const DEFAULT_HOOK_PROTOCOL = "claude";

/** Arguments for {@link cmdHook}. */
export interface HookCommandOptions {
  /** Protocol name from the command line. Defaults to `"claude"`. */
  readonly protocol?: string | undefined;
  /** Project root. Defaults to the process working directory. */
  readonly root?: string | undefined;
  /**
   * The check pipeline, injected. See `RunCheck` in `src/hooks/claude.ts`
   * for why this is a parameter and not an import.
   */
  readonly runCheck: RunCheck;
  /** Stdin reader. Defaults to a blocking read of fd 0. Injected by tests. */
  readonly readStdin?: (() => string) | undefined;
  /** Payload sink. Defaults to stdout. Injected by tests. */
  readonly emit?: ((line: string) => void) | undefined;
  /** Usage-error sink. Defaults to stderr. Injected by tests. */
  readonly emitError?: ((line: string) => void) | undefined;
}

/**
 * Run one hook invocation and return the process exit code.
 *
 * A plain handler: it takes its dependencies as arguments and returns a
 * number, so the CLI dispatcher decides how to exit and the tests never touch
 * the real process.
 */
export async function cmdHook(options: HookCommandOptions): Promise<number> {
  const protocol = options.protocol ?? DEFAULT_HOOK_PROTOCOL;
  if (!HOOK_PROTOCOLS.includes(protocol)) {
    const emitError = options.emitError ?? writeStderr;
    emitError(
      `kragg: unknown hook protocol '${protocol}' ` +
        `(expected one of: ${HOOK_PROTOCOLS.join(", ")})`,
    );
    return EXIT_USAGE;
  }
  return await runClaudeHook({
    root: options.root ?? process.cwd(),
    stdin: (options.readStdin ?? readStdinSync)(),
    runCheck: options.runCheck,
    emit: options.emit,
  });
}

/**
 * Read all of stdin, synchronously.
 *
 * `readFileSync(0)` is the simplest correct read of a piped stdin, which is
 * the only way a hook is ever invoked. Run interactively with a TTY on fd 0
 * it raises EAGAIN; that becomes `""`, which parses to an empty payload and
 * dispatches to a no-op — the same fail-open posture as everything else here.
 */
function readStdinSync(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function writeStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}
