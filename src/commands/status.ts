/**
 * `kragg status` — what the last few runs did.
 *
 * Ported from `cmd_status`. Reads `.kragg/history.jsonl` and nothing else: it
 * never runs a gate, so it is safe to call from a hook or a prompt without
 * paying for a check, and it never reports a verdict it did not witness.
 *
 * An empty history is reported as empty. It is not an error and it is
 * certainly not a pass — a project that has never run `check` has no evidence
 * either way, and saying so is the only honest answer.
 */

import { readRuns, renderStatusLines } from "../engine/journal.ts";
import { EXIT_OK } from "../engine/report.ts";

/** Print recent run history. Returns the process exit code. */
export function runStatus(root: string, format: "text" | "json", last: number): number {
  const runs = readRuns(root, last);
  if (format === "json") {
    // `last_run` is broken out because that is the field a hook branches on;
    // making a caller index `runs[-1]` themselves invites an off-by-one at the
    // exact moment the history is empty. `indent: 1` matches Python.
    const payload = { last_run: runs.at(-1) ?? null, runs };
    process.stdout.write(`${JSON.stringify(payload, null, 1)}\n`);
    return EXIT_OK;
  }
  if (runs.length === 0) {
    process.stdout.write("no recorded runs (run `kragg check` first)\n");
    return EXIT_OK;
  }
  process.stdout.write(`${renderStatusLines(runs).join("\n")}\n`);
  return EXIT_OK;
}
