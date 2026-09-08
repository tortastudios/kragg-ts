/**
 * `kragg init` — add guardrails to a project that already exists.
 *
 * Ported from `initialize_project`. The distinguishing property is that it is
 * NON-DESTRUCTIVE, and non-destructive here means more than "does not
 * overwrite a file". A project that already works has already answered the
 * questions the scaffold answers — which module system, which package manager,
 * which policy — and an *addition* that answers one of them differently is a
 * rewrite wearing an additive diff. So an existing file is left exactly as it
 * is, `package.json` gains only keys that cannot redefine the project, and
 * `kragg.json` is created only when there is no policy to shadow.
 *
 * That restraint is the whole reason the command is usable. `init` runs
 * against somebody's repository; the first time it replaces a hand-tuned
 * config, nobody runs it again. `--dry-run` exists so nobody has to take that
 * on faith: it prints the same plan the real run applies, and writes nothing.
 */

import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { EXIT_OK, EXIT_USAGE } from "../engine/report.ts";
import type { InitPlan, InitSkip } from "../scaffold/initPlan.ts";
import { initializeProject, planInitialization, ScaffoldError } from "../scaffold/project.ts";

/** Usage text, printed on `--help` and on every usage error. */
export const INIT_USAGE = `Usage: kragg init [directory] [--dry-run]

Adds kragg guardrail files to an existing project. No skeleton code is
generated and no existing file is overwritten.

package.json is merged additively, minus the keys that would redefine a
project that already works: type, engines, packageManager and private are
never added to a manifest that already exists. kragg.json is created only when
the project states no policy yet — an existing kragg.json or package.json#kragg
is left alone, because a generated kragg.json would shadow it outright rather
than add to it.

Options:
      --dry-run   print the changes init would make, and write nothing
  -h, --help      show this help and exit`;

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
      options: {
        help: { type: "boolean", short: "h", default: false },
        "dry-run": { type: "boolean", default: false },
      },
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
    if (parsed.values["dry-run"] === true) {
      process.stdout.write(`${dryRun(planInitialization(root))}\n`);
      return EXIT_OK;
    }
    const result = initializeProject(root);
    process.stdout.write(`${report(result.written, result.skipped)}\n`);
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
 * bury the two or three lines that matter under a wall of no-ops. The skips
 * that ARE listed are the ones that change what the user got — a policy left
 * where it was, a manifest key withheld — because those are decisions made on
 * the user's behalf, and a decision nobody is told about is indistinguishable
 * from the tool not working.
 */
export function report(written: readonly string[], skipped: readonly InitSkip[]): string {
  const notes = skipped.filter((skip) => skip.notable).map(preserved);
  const created = written.map((path) => `created ${path}`);
  if (created.length === 0) {
    return ["Already initialized: every guardrail file was already present.", ...notes].join("\n");
  }
  return [
    ...created,
    ...notes,
    "",
    "Existing files were left untouched. Review AGENTS.md, adjust kragg.json",
    "(`layers` is unset until your layout is decided), then run:",
    "",
    "  pnpm exec kragg check",
  ].join("\n");
}

/**
 * The plan, rendered for review, with nothing written.
 *
 * Every skip is listed here, including the routine "that file is already
 * there" ones: this is the output somebody reads precisely because they want
 * the whole picture before letting the command near their repository.
 */
export function dryRun(plan: InitPlan): string {
  const lines = [`Dry run for ${plan.root}. Nothing was written.`, ""];
  for (const file of plan.writes) {
    lines.push(`would create ${file.path}`);
  }
  for (const merge of plan.merges) {
    lines.push(`would add to ${merge.path}: ${merge.keys.join(", ")}`);
  }
  for (const skip of plan.skipped) {
    lines.push(`${skip.notable ? "preserved" : "skipped"} ${skip.path}: ${skip.reason}`);
  }
  if (plan.writes.length === 0 && plan.merges.length === 0) {
    lines.push("", "Nothing to do: this project is already initialized.");
    return lines.join("\n");
  }
  lines.push("", "Re-run without --dry-run to apply.");
  return lines.join("\n");
}

/** One preserved-as-is note, in the same shape as a `created` line. */
function preserved(skip: InitSkip): string {
  return `preserved ${skip.path}: ${skip.reason}`;
}

/** Print a usage error with the usage text, and return exit code 2. */
function usageError(message: string): number {
  process.stderr.write(`${message}\n\n${INIT_USAGE}\n`);
  return EXIT_USAGE;
}
