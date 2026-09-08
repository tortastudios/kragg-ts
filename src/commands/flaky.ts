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
 * approach. This is a CRON/CI SURFACE AND NEVER AN INNER-LOOP GATE, and that
 * is a design boundary rather than a default that could be flipped later:
 * running the suite N times is N times the latency, and a gate whose verdict
 * depends on a sampling process is not a deterministic gate. `kragg check`
 * must never invoke this, and the command says so in its own output so nobody
 * wires it into a pre-commit hook by accident.
 *
 * A test that fails in EVERY run is not flaky, it is broken; only
 * `0 < failures < runs` is reported. That distinction is why this mode is
 * useful at all — a broken test is already visible from one run.
 */

import type { Violation } from "../engine/models.ts";
import type { JournalEntry } from "../engine/journal.ts";
import { readRuns } from "../engine/journal.ts";
import { EXIT_ENVIRONMENT, EXIT_GATE_FAILURES, EXIT_OK } from "../engine/report.ts";
import { resolveProjectEnvironment } from "../environment/project.ts";
import { loadPolicy } from "../policy/policy.ts";
import { runTests } from "../adapters/testRunner.ts";

/** Journal entries scanned by default, matching Python's `--last`. */
export const DEFAULT_LAST = 50;

/** A gate that flipped pass/fail on an unchanged commit. */
export interface FlakyGate {
  readonly name: string;
  readonly sha: string;
  readonly passed: number;
  readonly failed: number;
}

/** A test that failed intermittently across repeated runs. */
export interface FlakyTest {
  /** `file::test name` — see {@link testIdentity} for how it is derived. */
  readonly testId: string;
  readonly failures: number;
  readonly runs: number;
}

/** Failure ratio in `[0, 1]`; `0` when no runs were recorded. */
export function failureRatio(test: FlakyTest): number {
  return test.runs === 0 ? 0 : test.failures / test.runs;
}

/* --- Passive mode -------------------------------------------------------- */

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

/* --- Active mode --------------------------------------------------------- */

/**
 * A stable identity for one failed test, across runs.
 *
 * The test-runner adapters do not expose test IDs; they expose `Violation`s
 * whose message `support/testReport.ts` builds as `` `${name} — ${detail}` ``
 * (or `` `${name} failed` `` when there is no detail). The DETAIL is exactly
 * what differs between two runs of the same flaky test — a different timeout,
 * a different received value — so it must be stripped or every run would look
 * like a different test and nothing would ever be counted twice.
 *
 * COUPLING, stated rather than hidden: this reconstruction depends on that
 * message format. If the adapters ever expose a real test id, this should be
 * replaced by it rather than extended. The em-dash separator is used because
 * it is what the adapters emit and it is vanishingly rare inside a test name.
 *
 * A suite-level failure (`test file failed to run — …`) yields an identity of
 * that phrase against the file, which is correct: a file that intermittently
 * fails to load IS flaky, and there is no test name to attribute it to.
 */
export function testIdentity(violation: Violation): string {
  const name = stripDetail(violation.message);
  return violation.file === undefined ? name : `${violation.file}::${name}`;
}

const DETAIL_SEPARATOR = " — ";
const FAILED_SUFFIX = " failed";

function stripDetail(message: string): string {
  const index = message.indexOf(DETAIL_SEPARATOR);
  if (index >= 0) {
    return message.slice(0, index);
  }
  return message.endsWith(FAILED_SUFFIX)
    ? message.slice(0, message.length - FAILED_SUFFIX.length)
    : message;
}

/**
 * Flag tests that failed in SOME BUT NOT ALL runs.
 *
 * `failures === runs` is a deterministically broken test, which one ordinary
 * run already reports; surfacing it here would drown the intermittent ones.
 * Duplicate identities within a single run are collapsed, so a parameterised
 * test reported twice does not count as two failures of one run.
 */
export function aggregateReruns(failedPerRun: readonly (readonly string[])[]): readonly FlakyTest[] {
  const runs = failedPerRun.length;
  const counts = new Map<string, number>();
  for (const failed of failedPerRun) {
    for (const testId of new Set(failed)) {
      counts.set(testId, (counts.get(testId) ?? 0) + 1);
    }
  }
  const flaky: FlakyTest[] = [];
  for (const [testId, failures] of counts) {
    if (failures > 0 && failures < runs) {
      flaky.push({ testId, failures, runs });
    }
  }
  flaky.sort((a, b) => b.failures - a.failures || a.testId.localeCompare(b.testId));
  return flaky;
}

/** Render active-rerun findings as token-efficient lines. */
export function renderReruns(tests: readonly FlakyTest[], count: number): string[] {
  if (tests.length === 0) {
    return [`no flaky tests across ${count} runs`];
  }
  const lines = [`flaky: ${tests.length} tests failed intermittently across ${count} runs`];
  for (const test of tests) {
    const percent = Math.round(failureRatio(test) * 100);
    lines.push(`  ${test.testId}: ${test.failures}/${test.runs} failed (${percent}%)`);
  }
  return lines;
}

/** The suite ran `count` times, or it could not be run at all. */
export type RerunOutcome =
  | { readonly ok: true; readonly tests: readonly FlakyTest[] }
  | { readonly ok: false; readonly message: string };

export interface RerunOptions {
  readonly root: string;
  /** How many times to run the whole suite. */
  readonly count: number;
  /** Progress sink, one line per completed run. Silent when omitted. */
  readonly onRun?: ((line: string) => void) | undefined;
}

/**
 * Run the suite `count` times and rank tests by failure ratio.
 *
 * Runs are SEQUENTIAL, not parallel, and deliberately so: the shared state
 * that makes a suite flaky (a port, a temp directory, a database, a clock) is
 * exactly what concurrent runs would collide over, and a manufactured
 * collision is not the flakiness anyone is looking for.
 *
 * Coverage is switched off (`coverageFailUnder: 0`) — it is pure cost here and
 * its threshold verdict is not a test outcome. The violation cap is lifted
 * (`maxViolationsPerGate: 0`, which `capped()` reads as "no cap") because a
 * truncated failure list would silently under-count a run.
 *
 * A run that could not produce a readable report aborts the whole sweep. Nine
 * good runs and one unknown is not a nine-sample dataset; the ratio it would
 * produce is wrong in the direction that hides flakiness.
 */
export async function runReruns(options: RerunOptions): Promise<RerunOutcome> {
  const env = resolveProjectEnvironment(options.root);
  const policy = loadPolicy(options.root);
  const failedPerRun: string[][] = [];
  for (let index = 0; index < options.count; index += 1) {
    const outcome = await runTests({
      env,
      coverageFailUnder: 0,
      maxViolations: 0,
      testPatterns: policy.testPaths,
      sourcePaths: policy.sourcePaths,
    });
    if (!outcome.ok) {
      return {
        ok: false,
        message:
          `run ${index + 1} of ${options.count} could not complete ` +
          `(${outcome.kind}), so no failure ratio is trustworthy:\n${outcome.message}`,
      };
    }
    const failed = outcome.violations.map(testIdentity);
    failedPerRun.push(failed);
    options.onRun?.(
      `  run ${index + 1}/${options.count}: ${outcome.summary.failed} failed ` +
        `of ${outcome.summary.total}`,
    );
  }
  return { ok: true, tests: aggregateReruns(failedPerRun) };
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
}

/**
 * Handler for `kragg flaky`. Returns the process exit code.
 *
 * PASSIVE mode always exits 0. A flipped gate is a report about history, not a
 * verdict on the working tree, and failing the process on it would make the
 * command unusable in the very CI job that would benefit from running it.
 * Python's `cmd_flaky` does the same.
 *
 * ACTIVE mode exits 1 when intermittent tests were found, so a nightly job can
 * gate on it, and 3 when the suite could not be run.
 */
export async function flakyCommand(options: FlakyOptions): Promise<number> {
  const log = options.log ?? defaultLog;
  const rerun = options.rerun ?? 0;
  if (rerun > 0) {
    return await flakyRerun(options, rerun, log);
  }
  const runs = readRuns(options.root, options.last ?? DEFAULT_LAST);
  if (runs.length === 0) {
    log("no recorded runs to mine (run `kragg check` first)");
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
  const outcome = await runReruns({ root: options.root, count, onRun: log });
  if (!outcome.ok) {
    logError(outcome.message);
    return EXIT_ENVIRONMENT;
  }
  for (const line of renderReruns(outcome.tests, count)) {
    log(line);
  }
  return outcome.tests.length > 0 ? EXIT_GATE_FAILURES : EXIT_OK;
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
