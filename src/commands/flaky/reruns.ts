/**
 * The ACTIVE half of `kragg flaky`: re-run the suite N times and rank tests by
 * how often they failed.
 *
 * ── THE INTENDED SUITE, OR NOTHING ─────────────────────────────────────────
 * Stability is a claim about a suite that RAN. Every sample here therefore has
 * to be a completed run of the same suite `kragg check` would have run, and
 * that is enforced in two places rather than assumed:
 *
 *  1. The invocation is the check pipeline's invocation. `runTests` is given
 *     the policy's `test_runner` and its `test_paths`, exactly as
 *     `catalog/check.ts` gives them, and `adapters/support/testCommands.ts` —
 *     the ONE builder — turns them into argv. This module does not assemble a
 *     command of its own. It used to: it dropped the runner override (so a
 *     project pinned to `node` was re-run under whatever inference guessed)
 *     and passed the bare directories as if they were file patterns (so
 *     `node --test test` died on `Cannot find module .../test` and the TAP
 *     reader turned that into "1 test, 1 failed"). Every run failed the same
 *     phantom test, `failures === runs` read as "not intermittent", and the
 *     command printed `no flaky tests` about a suite that had never executed.
 *
 *  2. Every run is checked before it counts as a SAMPLE — see
 *     {@link usableSample}. A run that could not start, was killed, produced
 *     no complete report, discovered zero tests, or failed without naming a
 *     test is not a data point. One unusable run aborts the sweep with an
 *     error (exit 3) naming what happened; nine good runs and one unknown is
 *     not a nine-sample dataset, and the ratio it would produce is wrong in
 *     the direction that HIDES flakiness.
 *
 * Runs are allowed to differ in size, deliberately. A suite whose file count
 * varies between runs is itself flaky, and erroring on it would suppress the
 * finding; the per-run totals are printed so the variation is visible.
 *
 * ── INTERMITTENT VS. BROKEN ────────────────────────────────────────────────
 * A test that fails in EVERY run is not flaky, it is broken — one ordinary run
 * already reports it. It is still reported here, in its own section and with
 * its own tally, because "we found nothing intermittent" and "everything is
 * fine" are different statements and the exit code is 1 either way.
 *
 * Runs are SEQUENTIAL, not parallel, and deliberately so: the shared state
 * that makes a suite flaky (a port, a temp directory, a database, a clock) is
 * exactly what concurrent runs would collide over, and a manufactured
 * collision is not the flakiness anyone is looking for.
 */

import { runTests } from "../../adapters/testRunner.ts";
import type { TestRunOutcome, TestRunnerOptions } from "../../adapters/testRunner.ts";
import type { TestSummary } from "../../adapters/support/testReport.ts";
import type { Violation } from "../../engine/models.ts";
import { resolveProjectEnvironment } from "../../environment/project.ts";
import { loadPolicy } from "../../policy/policy.ts";

/** A test's outcome tally across the reruns. */
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

/** Tests split by whether their outcome VARIED across the completed runs. */
export interface RerunTally {
  /** Failed in some runs and passed in others: nondeterministic. */
  readonly flaky: readonly FlakyTest[];
  /** Failed in every run: broken, and reported as such rather than dropped. */
  readonly stable: readonly FlakyTest[];
}

/**
 * Split the failures of N completed runs into intermittent and stable.
 *
 * Duplicate identities within a single run are collapsed, so a parameterised
 * test reported twice does not count as two failures of one run. Every input
 * list must come from a run that {@link usableSample} accepted; a run that did
 * not execute the suite contributes an empty list, which would read here as
 * "everything passed" and is exactly the mistake this command made before.
 */
export function aggregateReruns(failedPerRun: readonly (readonly string[])[]): RerunTally {
  const runs = failedPerRun.length;
  const counts = new Map<string, number>();
  for (const failed of failedPerRun) {
    for (const testId of new Set(failed)) {
      counts.set(testId, (counts.get(testId) ?? 0) + 1);
    }
  }
  const flaky: FlakyTest[] = [];
  const stable: FlakyTest[] = [];
  for (const [testId, failures] of counts) {
    (failures < runs ? flaky : stable).push({ testId, failures, runs });
  }
  flaky.sort(byFailuresThenId);
  stable.sort(byFailuresThenId);
  return { flaky, stable };
}

function byFailuresThenId(left: FlakyTest, right: FlakyTest): number {
  return right.failures - left.failures || left.testId.localeCompare(right.testId);
}

/**
 * Render active-rerun findings: the per-run totals, then the two verdicts.
 *
 * The totals come first and are never omitted. "No flaky tests" is only
 * meaningful next to the size of the suite it was measured on — that line is
 * what makes a discovery failure visible to a reader instead of silent.
 */
export function renderReruns(tally: RerunTally, runs: readonly TestSummary[]): string[] {
  const count = runs.length;
  const lines = [`${count} completed runs of the intended suite:`];
  for (const [index, summary] of runs.entries()) {
    lines.push(
      `  run ${index + 1}: ${summary.total} tests, ${summary.passed} passed, ` +
        `${summary.failed} failed`,
    );
  }
  if (tally.flaky.length === 0) {
    lines.push(`no flaky tests across ${count} runs`);
  } else {
    lines.push(`flaky: ${tally.flaky.length} tests failed intermittently across ${count} runs`);
    for (const test of tally.flaky) {
      const percent = Math.round(failureRatio(test) * 100);
      lines.push(
        `  ${test.testId}: ${test.failures}/${test.runs} failed, ` +
          `${test.runs - test.failures}/${test.runs} passed (${percent}%)`,
      );
    }
  }
  for (const line of renderStable(tally.stable, count)) {
    lines.push(line);
  }
  return lines;
}

/** A test that failed every time is broken, not flaky — and still reported. */
function renderStable(stable: readonly FlakyTest[], count: number): string[] {
  if (stable.length === 0) {
    return [];
  }
  const lines = [
    `stable failures: ${stable.length} tests failed in all ${count} runs ` +
      "(broken, not flaky — fix them before reading the ratios above)",
  ];
  for (const test of stable) {
    lines.push(`  ${test.testId}: ${test.failures}/${test.runs} failed`);
  }
  return lines;
}

/** The suite ran `count` times, or it could not be run `count` times. */
export type RerunOutcome =
  | { readonly ok: true; readonly tally: RerunTally; readonly runs: readonly TestSummary[] }
  | { readonly ok: false; readonly message: string };

/**
 * One invocation of the suite: `runTests`, or a stand-in for it in a test.
 *
 * Injected rather than imported directly so the tally and the sample rules can
 * be driven without spawning a runner. The default is the real adapter, so
 * production takes exactly the path `kragg check` takes.
 */
export type RunSuite = (options: TestRunnerOptions) => Promise<TestRunOutcome>;

export interface RerunOptions {
  readonly root: string;
  /** How many times to run the whole suite. */
  readonly count: number;
  /** Progress sink, one line per completed run. Silent when omitted. */
  readonly onRun?: ((line: string) => void) | undefined;
  /** The suite runner. See {@link RunSuite}. */
  readonly runSuite?: RunSuite | undefined;
}

/**
 * Run the suite `count` times and tally each test's outcomes.
 *
 * Coverage is switched off (`coverageFailUnder: 0`) — it is pure cost here and
 * its threshold verdict is not a test outcome. The violation cap is lifted
 * (`maxViolations: 0`, which `capped()` reads as "no cap") because a truncated
 * failure list would silently under-count a run. Everything that decides WHAT
 * runs — the runner and the test paths — is the policy's, unchanged.
 */
export async function runReruns(options: RerunOptions): Promise<RerunOutcome> {
  const env = resolveProjectEnvironment(options.root);
  const policy = loadPolicy(options.root);
  const runSuite = options.runSuite ?? runTests;
  const failedPerRun: (readonly string[])[] = [];
  const runs: TestSummary[] = [];
  for (let index = 0; index < options.count; index += 1) {
    const sample = usableSample(
      await runSuite({
        env,
        choice: policy.testRunner,
        coverageFailUnder: 0,
        maxViolations: 0,
        testPaths: policy.testPaths,
        sourcePaths: policy.sourcePaths,
      }),
    );
    if (!sample.ok) {
      return { ok: false, message: unusableMessage(index + 1, options.count, sample.reason) };
    }
    failedPerRun.push(sample.failed);
    runs.push(sample.summary);
    // Live progress only: a sweep of twenty runs must not look hung. The
    // authoritative per-run totals are `renderReruns`'s, printed at the end.
    options.onRun?.(
      `  [${index + 1}/${options.count}] ${sample.summary.failed} of ` +
        `${sample.summary.total} failed`,
    );
  }
  return { ok: true, tally: aggregateReruns(failedPerRun), runs };
}

/** One completed run of the intended suite, or why this run is not one. */
type Sample =
  | { readonly ok: true; readonly summary: TestSummary; readonly failed: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Is this outcome a sample?
 *
 * Each arm below is a run that produced no usable evidence about stability,
 * and the reason each is REJECTED rather than counted as a green run is the
 * same: an empty failure list from a suite that did not execute is
 * indistinguishable, downstream, from an empty failure list from a suite that
 * passed. The zero-test arm names the argv, because a discovery mistake is
 * only diagnosable from the command that made it.
 */
function usableSample(outcome: TestRunOutcome): Sample {
  if (!outcome.ok) {
    return { ok: false, reason: `did not run the suite (${outcome.kind}):\n${outcome.message}` };
  }
  if (outcome.error) {
    return { ok: false, reason: `ran but left incomplete evidence:\n${outcome.output}` };
  }
  if (outcome.summary.total === 0) {
    return {
      ok: false,
      reason:
        `discovered no tests at all (${outcome.runner}, chosen by ${outcome.source}), ` +
        `so it is not a sample of anything:\n  ${outcome.command.join(" ")}\n` +
        "Check `test_paths` and `test_runner` in kragg.json.",
    };
  }
  if (!outcome.passed && outcome.violations.length === 0) {
    return {
      ok: false,
      reason:
        "reported a failure it could not attribute to any test, so its result " +
        `cannot be tallied:\n${outcome.output}`,
    };
  }
  return { ok: true, summary: outcome.summary, failed: outcome.violations.map(testIdentity) };
}

function unusableMessage(run: number, count: number, reason: string): string {
  return (
    `run ${run} of ${count} ${reason}\n` +
    "A suite that did not run is not evidence that it is stable, so no failure " +
    "ratio is reported."
  );
}
