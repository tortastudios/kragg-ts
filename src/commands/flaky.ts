/**
 * `kragg flaky` — nondeterminism detection, kept OUT of the inner loop.
 *
 * Ported from `kragg/src/kragg/flaky.py` plus the `cmd_flaky` / `_flaky_rerun`
 * halves of `commands.py`. Two modes, and they are not variations on one idea:
 *
 * ── PASSIVE (default) ──────────────────────────────────────────────────────
 * Mines `.kragg/history.jsonl`, the journal `kragg check` already writes, for
 * a gate that both PASSED and FAILED at the SAME git sha. Same input, two
 * different outputs, is the definition of nondeterminism, and it costs nothing
 * to find because the data is already on disk. No re-running, no subprocess,
 * no wall-clock.
 *
 * THE PRECISION RULE IS THE WHOLE SURFACE. Only CLEAN-TREE runs are compared
 * (`git_dirty === false`). A sha names a commit and says nothing about
 * uncommitted edits, so a dirty run that failed and a dirty run that passed at
 * the same sha is the ordinary edit-and-rerun cycle — every developer's whole
 * day — not flakiness. Counting those would bury the real signal under noise
 * and the surface would be switched off within a week. Entries whose
 * `git_dirty` is anything other than the boolean `false` (missing, null, a
 * pre-schema entry) are DROPPED rather than assumed clean: "we do not know
 * whether the tree was dirty" is not evidence of nondeterminism.
 *
 * ── ACTIVE (`--rerun N`) ───────────────────────────────────────────────────
 * Re-runs the suite N times and ranks tests by failure ratio, the Meta-style
 * approach. It lives in `flaky/reruns.ts`; read that file for the rule it
 * turns on — every sample must be a COMPLETED run of the same suite
 * `kragg check` would have run, or the sweep is an error rather than a verdict.
 *
 * This is a CRON/CI SURFACE AND NEVER AN INNER-LOOP GATE, and that is a design
 * boundary rather than a default that could be flipped later: running the
 * suite N times is N times the latency, and a gate whose verdict depends on a
 * sampling process is not a deterministic gate. `kragg check` must never
 * invoke this, and the command says so in its own output so nobody wires it
 * into a pre-commit hook by accident.
 */

import type { JournalEntry } from "../engine/journal.ts";
import { readRuns } from "../engine/journal.ts";
import { EXIT_ENVIRONMENT, EXIT_GATE_FAILURES, EXIT_OK } from "../engine/report.ts";
import { renderReruns, runReruns } from "./flaky/reruns.ts";
import type { RunSuite } from "./flaky/reruns.ts";

export type {
  FlakyTest,
  RerunOptions,
  RerunOutcome,
  RerunTally,
  RunSuite,
} from "./flaky/reruns.ts";
export {
  aggregateReruns,
  failureRatio,
  renderReruns,
  runReruns,
  testIdentity,
} from "./flaky/reruns.ts";

/** Journal entries scanned by default, matching Python's `--last`. */
export const DEFAULT_LAST = 50;

/** A gate that flipped pass/fail on an unchanged commit. */
export interface FlakyGate {
  readonly name: string;
  readonly sha: string;
  readonly passed: number;
  readonly failed: number;
}

interface Tally {
  readonly sha: string;
  readonly name: string;
  passed: number;
  failed: number;
}

/**
 * Gates that both passed and failed at the same sha across the journal.
 *
 * Sorted by failure count, descending — the gate that failed most often is the
 * one worth chasing first.
 *
 * Takes the journal's own entry type but validates every field at runtime.
 * That is not belt-and-braces: `readRuns` narrows a parsed JSON value to
 * `JournalEntry` WITHOUT checking it, because the file may have been written
 * by an older kragg, by the Python sibling, or half-written by an interrupted
 * run. The static type describes the contract; the guards below describe what
 * is actually on disk.
 */
export function passiveFlaky(runs: readonly JournalEntry[]): readonly FlakyGate[] {
  const flaky: FlakyGate[] = [];
  for (const tally of tallyRuns(runs).values()) {
    if (tally.passed > 0 && tally.failed > 0) {
      flaky.push({
        name: tally.name,
        sha: tally.sha,
        passed: tally.passed,
        failed: tally.failed,
      });
    }
  }
  flaky.sort((a, b) => b.failed - a.failed);
  return flaky;
}

function tallyRuns(runs: readonly JournalEntry[]): ReadonlyMap<string, Tally> {
  const tallies = new Map<string, Tally>();
  for (const run of runs) {
    if (!isRecord(run)) {
      continue;
    }
    // Strictly `false`. See the module docs: absent/null/true all mean the
    // comparison would not be apples to apples.
    if (run["git_dirty"] !== false) {
      continue;
    }
    const sha = run["git_sha"];
    const gates = run["gates"];
    if (typeof sha !== "string" || sha === "" || !Array.isArray(gates)) {
      continue;
    }
    for (const gate of gates) {
      recordGate(tallies, sha, gate);
    }
  }
  return tallies;
}

function recordGate(tallies: Map<string, Tally>, sha: string, gate: unknown): void {
  if (!isRecord(gate) || gate["skipped"] === true) {
    // A skipped gate produced no verdict, so it cannot have flipped one.
    return;
  }
  const name = gate["name"];
  if (typeof name !== "string" || name === "") {
    return;
  }
  const key = `${sha}::${name}`;
  const tally = tallies.get(key) ?? { sha, name, passed: 0, failed: 0 };
  if (gate["passed"] === true) {
    tally.passed += 1;
  } else {
    tally.failed += 1;
  }
  tallies.set(key, tally);
}

/** Render passive findings as token-efficient lines. */
export function renderPassive(flaky: readonly FlakyGate[]): string[] {
  if (flaky.length === 0) {
    return ["no flaky gates in recent history"];
  }
  const lines = [`flaky: ${flaky.length} gates flipped on an unchanged commit`];
  for (const gate of flaky) {
    lines.push(`  ${gate.name} @ ${gate.sha}: ${gate.passed} pass / ${gate.failed} fail`);
  }
  return lines;
}

/* --- Command ------------------------------------------------------------- */

export interface FlakyOptions {
  readonly root: string;
  /** Journal entries to scan in passive mode. Defaults to {@link DEFAULT_LAST}. */
  readonly last?: number | undefined;
  /** Re-run the suite this many times instead of mining the journal. */
  readonly rerun?: number | undefined;
  readonly log?: ((line: string) => void) | undefined;
  readonly logError?: ((line: string) => void) | undefined;
  /** The suite runner, injected for tests. See {@link RunSuite}. */
  readonly runSuite?: RunSuite | undefined;
}

/**
 * Handler for `kragg flaky`. Returns the process exit code.
 *
 * PASSIVE mode always exits 0. A flipped gate is a report about history, not a
 * verdict on the working tree, and failing the process on it would make the
 * command unusable in the very CI job that would benefit from running it.
 * Python's `cmd_flaky` does the same. "No journal to mine" and "a journal with
 * no flips in it" are printed as different sentences: the first means nothing
 * was measured, and reporting it as a clean bill of health would be the same
 * mistake `--rerun` used to make.
 *
 * ACTIVE mode exits 1 when tests failed — intermittently or every time — so a
 * nightly job can gate on it, and 3 when any of the N runs was not a completed
 * run of the intended suite.
 */
export async function flakyCommand(options: FlakyOptions): Promise<number> {
  const log = options.log ?? defaultLog;
  const rerun = options.rerun ?? 0;
  if (rerun > 0) {
    return await flakyRerun(options, rerun, log);
  }
  const runs = readRuns(options.root, options.last ?? DEFAULT_LAST);
  if (runs.length === 0) {
    log("no recorded runs to mine, so nothing was compared (run `kragg check` first)");
    return EXIT_OK;
  }
  for (const line of renderPassive(passiveFlaky(runs))) {
    log(line);
  }
  log(`(scanned ${runs.length} journal entries; only clean-tree runs are compared)`);
  return EXIT_OK;
}

async function flakyRerun(
  options: FlakyOptions,
  count: number,
  log: (line: string) => void,
): Promise<number> {
  const logError = options.logError ?? defaultLogError;
  log(
    `re-running the suite ${count} times — this is a cron/CI surface, ` +
      "never the inner loop, and `kragg check` never does this",
  );
  const outcome = await runReruns({
    root: options.root,
    count,
    onRun: log,
    runSuite: options.runSuite,
  });
  if (!outcome.ok) {
    logError(outcome.message);
    return EXIT_ENVIRONMENT;
  }
  for (const line of renderReruns(outcome.tally, outcome.runs)) {
    log(line);
  }
  // A stable failure is exit 1 too. It is not flakiness, and the output says
  // so in its own section, but a sweep that found failing tests has not found
  // a healthy suite and must not report one.
  const found = outcome.tally.flaky.length + outcome.tally.stable.length;
  return found > 0 ? EXIT_GATE_FAILURES : EXIT_OK;
}

/** A parsed JSON object, before any of its fields have been checked. */
type JsonObject = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultLog(line: string): void {
  console.log(line);
}

function defaultLogError(line: string): void {
  console.error(line);
}
