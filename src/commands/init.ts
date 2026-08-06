/**
 * `kragg init` — add guardrails to a project that already exists.
 *
 * Ported from `initialize_project`. The distinguishing property is that it is
 * NON-DESTRUCTIVE: an existing file is left exactly as it is, and the two
 * files most likely to already hold real work — `package.json` and
 * `kragg.json` — are merged key by key rather than written.
 *
 * That restraint is the whole reason the command is usable. `init` runs
 * against somebody's repository; the first time it replaces a hand-tuned
 * config, nobody runs it again.
 */

import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { EXIT_OK, EXIT_USAGE } from "../engine/report.ts";
import { initializeProject, ScaffoldError } from "../scaffold/project.ts";

/** Usage text, printed on `--help` and on every usage error. */
export const INIT_USAGE = `Usage: kragg init [directory]

Adds kragg guardrail files to an existing project. No skeleton code is
generated and no existing file is overwritten; package.json and kragg.json are
merged additively.

Options:
  -h, --help   show this help and exit`;

/**
 * Add guardrails to an existing project and report what changed.
 *
 * Returns `0` even when nothing was written — a project that already has every
 * guardrail file is the success case, not an error, and saying so is more
 * useful than inventing a failure.
 */
export function runInit(argv: readonly string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { help: { type: "boolean", short: "h", default: false } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error: unknown) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.values.help === true) {
    process.stdout.write(`${INIT_USAGE}\n`);
    return EXIT_OK;
  }
  if (parsed.positionals.length > 1) {
    return usageError("kragg init takes at most one directory");
  }
  const root = resolve(parsed.positionals[0] ?? process.cwd());
  try {
    const result = initializeProject(root);
    process.stdout.write(`${report(result.written)}\n`);
    return EXIT_OK;
  } catch (error: unknown) {
    if (error instanceof ScaffoldError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }
}

/**
 * What `init` did, phrased so "nothing changed" reads as a result.
 *
 * Files that already existed are deliberately NOT listed. Listing them would
 * bury the two or three lines that matter under a wall of no-ops.
 */
export function report(written: readonly string[]): string {
  if (written.length === 0) {
    return "Already initialized: every guardrail file was already present.";
  }
  const lines = written.map((path) => `created ${path}`);
  return [
    ...lines,
    "",
    "Existing files were left untouched. Review AGENTS.md, adjust kragg.json",
    "(`layers` is unset until your layout is decided), then run:",
    "",
    "  pnpm exec kragg check",
  ].join("\n");
}

/** Print a usage error with the usage text, and return exit code 2. */
function usageError(message: string): number {
  process.stderr.write(`${message}\n\n${INIT_USAGE}\n`);
  return EXIT_USAGE;
}
