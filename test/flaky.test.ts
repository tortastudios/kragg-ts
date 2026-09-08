/**
 * Tests for `kragg flaky`.
 *
 * The passive half is pure — it is a fold over journal records — so it is
 * tested directly against hand-written journal entries, including the
 * malformed ones a real `.kragg/history.jsonl` accumulates (an interrupted
 * write, an entry from an older schema, an entry from the Python sibling).
 *
 * THE TEST THAT MATTERS MOST is the dirty-tree exclusion. That single rule is
 * what separates "this gate is nondeterministic" from "someone edited a file
 * between two runs", and getting it wrong turns the surface into noise. It is
 * asserted from both directions: a dirty flip is NOT reported, and the same
 * flip with a clean tree IS.
 *
 * THE ACTIVE HALF has a second rule of the same kind: a rerun only counts as a
 * sample if it COMPLETED the intended suite. It is asserted from both
 * directions too — a sweep whose runs discovered nothing is an error naming
 * the argv, and a sweep of real runs reports the tests by name. The
 * sample-validation and tally logic is driven through the injected `runSuite`
 * seam; one end-to-end case runs a real `node --test` suite twice, because the
 * bug this file guards against was in the invocation itself and no fake can
 * see it.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type {
  TestRunFindings,
  TestRunOutcome,
  TestRunnerOptions,
} from "../src/adapters/testRunner.ts";
import type { TestSummary } from "../src/adapters/support/testReport.ts";
import type { JournalEntry } from "../src/engine/journal.ts";
import { EXIT_ENVIRONMENT, EXIT_GATE_FAILURES, EXIT_OK } from "../src/engine/report.ts";
import {
  aggregateReruns,
  DEFAULT_LAST,
  failureRatio,
  flakyCommand,
  passiveFlaky,
  renderPassive,
  renderReruns,
  runReruns,
  testIdentity,
} from "../src/commands/flaky.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-flaky-"));
  roots.push(root);
  return root;
}

interface GateInput {
  readonly name: string;
  readonly passed: boolean;
  readonly skipped?: boolean;
}

/** One journal entry with only the fields `passiveFlaky` reads. */
function entry(sha: string, dirty: boolean, gates: readonly GateInput[]): JournalEntry {
  return {
    schema_version: 1,
    ts: "2026-01-01T00:00:00Z",
    command: "check",
    mode: "full",
    git_sha: sha,
    git_dirty: dirty,
    passed: gates.every((gate) => gate.passed),
    exit_code: 0,
    duration_ms: 10,
    gates: gates.map((gate) => ({
      name: gate.name,
      passed: gate.passed,
      skipped: gate.skipped ?? false,
      duration_ms: 1,
      violation_count: gate.passed ? 0 : 1,
    })),
  };
}

describe("passiveFlaky", () => {
  it("reports a gate that flipped at one sha on a clean tree", () => {
    const flaky = passiveFlaky([
      entry("abc123", false, [{ name: "test-coverage", passed: true }]),
      entry("abc123", false, [{ name: "test-coverage", passed: false }]),
    ]);
    assert.equal(flaky.length, 1);
    assert.deepEqual(flaky[0], {
      name: "test-coverage",
      sha: "abc123",
      passed: 1,
      failed: 1,
    });
  });

  it("IGNORES a flip on a dirty tree — an edit explains it legitimately", () => {
    const flaky = passiveFlaky([
      entry("abc123", true, [{ name: "test-coverage", passed: true }]),
      entry("abc123", true, [{ name: "test-coverage", passed: false }]),
    ]);
    assert.deepEqual(flaky, []);
  });

  it("does not pair a clean run with a dirty run at the same sha", () => {
    const flaky = passiveFlaky([
      entry("abc123", false, [{ name: "test-coverage", passed: true }]),
      entry("abc123", true, [{ name: "test-coverage", passed: false }]),
    ]);
    assert.deepEqual(flaky, []);
  });

  it("does not flag a gate that only ever failed, or only ever passed", () => {
    const flaky = passiveFlaky([
      entry("abc123", false, [{ name: "tsc", passed: false }]),
      entry("abc123", false, [{ name: "tsc", passed: false }]),
      entry("def456", false, [{ name: "lint", passed: true }]),
      entry("def456", false, [{ name: "lint", passed: true }]),
    ]);
    assert.deepEqual(flaky, []);
  });

  it("keeps shas apart: pass at one sha and fail at another is not a flip", () => {
    const flaky = passiveFlaky([
      entry("abc123", false, [{ name: "tsc", passed: true }]),
      entry("def456", false, [{ name: "tsc", passed: false }]),
    ]);
    assert.deepEqual(flaky, []);
  });

  it("ignores skipped gates, which produced no verdict to flip", () => {
    const flaky = passiveFlaky([
      entry("abc123", false, [{ name: "audit", passed: true }]),
      entry("abc123", false, [{ name: "audit", passed: false, skipped: true }]),
    ]);
    assert.deepEqual(flaky, []);
  });

  it("sorts by failure count, descending", () => {
    const runs: JournalEntry[] = [
      entry("s", false, [{ name: "a", passed: true }, { name: "b", passed: true }]),
      entry("s", false, [{ name: "a", passed: false }, { name: "b", passed: false }]),
      entry("s", false, [{ name: "b", passed: false }]),
      entry("s", false, [{ name: "b", passed: false }]),
    ];
    const flaky = passiveFlaky(runs);
    assert.deepEqual(
      flaky.map((gate) => gate.name),
      ["b", "a"],
    );
    assert.equal(flaky[0]?.failed, 3);
  });

  it("drops entries whose git_dirty is missing rather than assuming clean", () => {
    // A pre-`git_dirty` journal entry. "Unknown" is not evidence.
    const legacy = { ...entry("abc123", false, [{ name: "tsc", passed: false }]) };
    const { git_dirty: _dropped, ...withoutDirty } = legacy;
    const flaky = passiveFlaky([
      entry("abc123", false, [{ name: "tsc", passed: true }]),
      withoutDirty as JournalEntry,
    ]);
    assert.deepEqual(flaky, []);
  });

  it("survives malformed records without throwing", () => {
    const junk = [
      null,
      "not an object",
      42,
      { git_dirty: false },
      { git_dirty: false, git_sha: "abc", gates: "not a list" },
      { git_dirty: false, git_sha: "abc", gates: [null, 7, { passed: true }] },
      { git_dirty: false, git_sha: "", gates: [] },
    ] as unknown as JournalEntry[];
    assert.deepEqual(passiveFlaky(junk), []);
  });
});

describe("renderPassive", () => {
  it("says nothing was found rather than printing an empty header", () => {
    assert.deepEqual(renderPassive([]), ["no flaky gates in recent history"]);
  });

  it("renders one line per gate with both counts", () => {
    const lines = renderPassive([{ name: "test-coverage", sha: "abc123", passed: 2, failed: 3 }]);
    assert.equal(lines[0], "flaky: 1 gates flipped on an unchanged commit");
    assert.equal(lines[1], "  test-coverage @ abc123: 2 pass / 3 fail");
  });
});

describe("testIdentity", () => {
  it("strips the assertion detail, which differs between runs", () => {
    const first = testIdentity({
      message: "adds numbers — expected 3 to equal 4",
      file: "test/math.test.ts",
    });
    const second = testIdentity({
      message: "adds numbers — expected 3 to equal 5",
      file: "test/math.test.ts",
    });
    assert.equal(first, second);
    assert.equal(first, "test/math.test.ts::adds numbers");
  });

  it("handles the detail-free `<name> failed` form", () => {
    assert.equal(
      testIdentity({ message: "adds numbers failed", file: "test/math.test.ts" }),
      "test/math.test.ts::adds numbers",
    );
  });

  it("keeps a file-less violation identifiable", () => {
    assert.equal(testIdentity({ message: "adds numbers failed" }), "adds numbers");
  });

  it("attributes a suite-level failure to its file", () => {
    assert.equal(
      testIdentity({
        message: "test file failed to run — Cannot find module './helpers.ts'",
        file: "test/math.test.ts",
      }),
      "test/math.test.ts::test file failed to run",
    );
  });
});

describe("aggregateReruns", () => {
  it("flags a test that failed in some but not all runs", () => {
    const tally = aggregateReruns([["a"], [], ["a"], []]);
    assert.deepEqual(tally.flaky, [{ testId: "a", failures: 2, runs: 4 }]);
    assert.deepEqual(tally.stable, []);
    assert.equal(failureRatio({ testId: "a", failures: 2, runs: 4 }), 0.5);
    assert.equal(failureRatio({ testId: "a", failures: 0, runs: 0 }), 0);
  });

  it("reports a test that failed in EVERY run as stable, not flaky", () => {
    const tally = aggregateReruns([["a"], ["a"], ["a"]]);
    assert.deepEqual(tally.flaky, []);
    assert.deepEqual(tally.stable, [{ testId: "a", failures: 3, runs: 3 }]);
  });

  it("counts a duplicate identity within one run only once", () => {
    const tally = aggregateReruns([["a", "a", "a"], []]);
    assert.deepEqual(tally.flaky, [{ testId: "a", failures: 1, runs: 2 }]);
  });

  it("reports nothing when every run was green", () => {
    assert.deepEqual(aggregateReruns([[], [], []]), { flaky: [], stable: [] });
  });

  it("orders by failure count, then by id for a stable tie-break", () => {
    const tally = aggregateReruns([["b", "z"], ["b"], ["a"], []]);
    assert.deepEqual(
      tally.flaky.map((test) => test.testId),
      ["b", "a", "z"],
    );
  });

  it("calls a failure in a single run stable — one sample cannot vary", () => {
    assert.deepEqual(aggregateReruns([["a"]]), {
      flaky: [],
      stable: [{ testId: "a", failures: 1, runs: 1 }],
    });
  });
});

describe("renderReruns", () => {
  /** `TestSummary`, with only the counts this renderer prints. */
  function summary(total: number, failed: number): TestSummary {
    return { total, passed: total - failed, failed, skipped: 0, todo: 0, failedFiles: failed };
  }

  it("always names the per-run totals, so `no flaky tests` has a size", () => {
    const lines = renderReruns({ flaky: [], stable: [] }, [summary(12, 0), summary(12, 0)]);
    assert.deepEqual(lines, [
      "2 completed runs of the intended suite:",
      "  run 1: 12 tests, 12 passed, 0 failed",
      "  run 2: 12 tests, 12 passed, 0 failed",
      "no flaky tests across 2 runs",
    ]);
  });

  it("renders both the failed and the passed side of the tally", () => {
    const lines = renderReruns(
      { flaky: [{ testId: "test/a.test.ts::x", failures: 1, runs: 4 }], stable: [] },
      [summary(4, 1), summary(4, 0), summary(4, 0), summary(4, 0)],
    );
    assert.equal(lines[5], "flaky: 1 tests failed intermittently across 4 runs");
    assert.equal(lines[6], "  test/a.test.ts::x: 1/4 failed, 3/4 passed (25%)");
  });

  it("names stable failures in their own section", () => {
    const lines = renderReruns(
      { flaky: [], stable: [{ testId: "test/a.test.ts::broken", failures: 3, runs: 3 }] },
      [summary(2, 1), summary(2, 1), summary(2, 1)],
    );
    const output = lines.join("\n");
    assert.match(output, /stable failures: 1 tests failed in all 3 runs/u);
    assert.match(output, /broken, not flaky/u);
    assert.match(output, /test\/a\.test\.ts::broken: 3\/3 failed/u);
  });
});

describe("flakyCommand (passive)", () => {
  it("exits 0 and says so when there is no journal at all", async () => {
    const lines: string[] = [];
    const code = await flakyCommand({ root: tempRoot(), log: (line) => lines.push(line) });
    assert.equal(code, EXIT_OK);
    assert.match(lines.join("\n"), /no recorded runs/);
  });

  it("reports a flip from a real .kragg/history.jsonl and still exits 0", async () => {
    const root = tempRoot();
    mkdirSync(join(root, ".kragg"), { recursive: true });
    writeFileSync(
      join(root, ".kragg", "history.jsonl"),
      [
        JSON.stringify(entry("abc123", false, [{ name: "test-coverage", passed: true }])),
        "{ this line is half-written",
        JSON.stringify(entry("abc123", false, [{ name: "test-coverage", passed: false }])),
        "",
      ].join("\n"),
      "utf8",
    );
    const lines: string[] = [];
    const code = await flakyCommand({ root, log: (line) => lines.push(line) });
    // A historical report, not a verdict on the working tree — see the handler docs.
    assert.equal(code, EXIT_OK);
    const output = lines.join("\n");
    assert.match(output, /test-coverage @ abc123: 1 pass \/ 1 fail/);
    assert.match(output, /only clean-tree runs are compared/);
  });

  it("distinguishes `nothing was measured` from `nothing flipped`", async () => {
    const root = tempRoot();
    mkdirSync(join(root, ".kragg"), { recursive: true });
    writeFileSync(
      join(root, ".kragg", "history.jsonl"),
      `${JSON.stringify(entry("abc123", false, [{ name: "tsc", passed: true }]))}\n`,
      "utf8",
    );
    const lines: string[] = [];
    assert.equal(await flakyCommand({ root, log: (line) => lines.push(line) }), EXIT_OK);
    const output = lines.join("\n");
    assert.match(output, /no flaky gates in recent history/u);
    assert.match(output, /scanned 1 journal entries/u);
    assert.doesNotMatch(output, /no recorded runs/u);
  });

  it("scans a sensible default window", () => {
    assert.equal(DEFAULT_LAST, 50);
  });
});

/* --- Active mode ---------------------------------------------------------
 *
 * `runSuite` is the seam: `runReruns` calls it exactly where it would call
 * `runTests`, so a scripted outcome exercises the sample validation and the
 * tally without spawning anything.
 */

/** A complete, readable run of `total` tests, with `failed` failing. */
function completedRun(total: number, failed: readonly string[]): TestRunFindings {
  return {
    ok: true,
    runner: "node",
    source: "policy:test_runner=node",
    command: ["/usr/bin/node", "--test", "test/**/*.{test,spec}.ts"],
    summary: {
      total,
      passed: total - failed.length,
      failed: failed.length,
      skipped: 0,
      todo: 0,
      failedFiles: failed.length === 0 ? 0 : 1,
    },
    violations: failed.map((name) => ({
      message: `${name} — expected 1 to equal 2`,
      file: "test/a.test.ts",
    })),
    violationCount: failed.length,
    coverage: null,
    passed: failed.length === 0,
    error: false,
    output: `${total} tests: ${total - failed.length} passed, ${failed.length} failed`,
  };
}

/** A runner that returns each scripted outcome in turn, repeating the last. */
function scripted(
  outcomes: readonly TestRunOutcome[],
  seen?: TestRunnerOptions[],
): (options: TestRunnerOptions) => Promise<TestRunOutcome> {
  let index = 0;
  return (options) => {
    seen?.push(options);
    const outcome = outcomes[Math.min(index, outcomes.length - 1)];
    index += 1;
    assert.ok(outcome !== undefined, "scripted runner ran out of outcomes");
    return Promise.resolve(outcome);
  };
}

describe("runReruns", () => {
  it("runs the suite with the policy's runner and test paths, not defaults", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "package.json"), '{"scripts":{"test":"vitest run"}}', "utf8");
    writeFileSync(
      join(root, "kragg.json"),
      JSON.stringify({ test_runner: "node", test_paths: ["suites", "tests"] }),
      "utf8",
    );
    const seen: TestRunnerOptions[] = [];
    const outcome = await runReruns({
      root,
      count: 2,
      runSuite: scripted([completedRun(3, [])], seen),
    });
    assert.ok(outcome.ok, outcome.ok ? "" : outcome.message);
    assert.equal(seen.length, 2);
    for (const options of seen) {
      // The explicit override wins over `scripts.test`, exactly as it does in
      // `check`; the selection is the policy's directories, which the adapter
      // turns into globs. Neither was passed before this fix.
      assert.equal(options.choice, "node");
      assert.deepEqual(options.testPaths, ["suites", "tests"]);
      // Coverage off, violation cap lifted: no run can be silently truncated.
      assert.equal(options.coverageFailUnder, 0);
      assert.equal(options.maxViolations, 0);
    }
  });

  it("refuses to call a zero-test run a sample, and names the argv", async () => {
    const outcome = await runReruns({
      root: tempRoot(),
      count: 3,
      runSuite: scripted([completedRun(0, [])]),
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /run 1 of 3 discovered no tests at all/u);
    assert.match(outcome.message, /--test test\/\*\*\/\*\.\{test,spec\}\.ts/u);
    assert.match(outcome.message, /not evidence that it is stable/u);
    assert.doesNotMatch(outcome.message, /no flaky tests/u);
  });

  it("aborts the sweep when a later run could not run at all", async () => {
    const crashedRun: TestRunOutcome = {
      ok: false,
      kind: "crashed",
      message: "node --test exited 7 without a complete TAP report",
    };
    const outcome = await runReruns({
      root: tempRoot(),
      count: 3,
      runSuite: scripted([completedRun(2, []), crashedRun]),
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /run 2 of 3 did not run the suite \(crashed\)/u);
  });

  it("refuses a failure the runner could not attribute to any test", async () => {
    const unattributed: TestRunOutcome = { ...completedRun(2, []), passed: false };
    const outcome = await runReruns({
      root: tempRoot(),
      count: 2,
      runSuite: scripted([unattributed]),
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /could not attribute to any test/u);
  });

  it("tallies an intermittent failure across completed runs", async () => {
    const outcome = await runReruns({
      root: tempRoot(),
      count: 3,
      runSuite: scripted([
        completedRun(2, ["flips"]),
        completedRun(2, []),
        completedRun(2, ["flips"]),
      ]),
    });
    assert.ok(outcome.ok, outcome.ok ? "" : outcome.message);
    assert.deepEqual(outcome.tally.flaky, [
      { testId: "test/a.test.ts::flips", failures: 2, runs: 3 },
    ]);
    assert.deepEqual(outcome.tally.stable, []);
    assert.deepEqual(
      outcome.runs.map((summary: TestSummary) => summary.total),
      [2, 2, 2],
    );
  });
});

describe("flakyCommand (active)", () => {
  it("exits 3 and never says `no flaky tests` when discovery found nothing", async () => {
    const lines: string[] = [];
    const errors: string[] = [];
    const code = await flakyCommand({
      root: tempRoot(),
      rerun: 2,
      log: (line) => lines.push(line),
      logError: (line) => errors.push(line),
      runSuite: scripted([completedRun(0, [])]),
    });
    assert.equal(code, EXIT_ENVIRONMENT);
    assert.match(errors.join("\n"), /discovered no tests at all/u);
    assert.doesNotMatch(lines.join("\n"), /no flaky tests/u);
  });

  it("exits 1 for a consistently failing test and calls it stable, not flaky", async () => {
    const lines: string[] = [];
    const code = await flakyCommand({
      root: tempRoot(),
      rerun: 3,
      log: (line) => lines.push(line),
      runSuite: scripted([completedRun(2, ["always broken"])]),
    });
    assert.equal(code, EXIT_GATE_FAILURES);
    const output = lines.join("\n");
    assert.match(output, /no flaky tests across 3 runs/u);
    assert.match(output, /stable failures: 1 tests failed in all 3 runs/u);
    assert.match(output, /test\/a\.test\.ts::always broken: 3\/3 failed/u);
    assert.match(output, /run 1: 2 tests, 1 passed, 1 failed/u);
  });

  it("exits 1 and names a genuinely intermittent test", async () => {
    const lines: string[] = [];
    const code = await flakyCommand({
      root: tempRoot(),
      rerun: 2,
      log: (line) => lines.push(line),
      runSuite: scripted([completedRun(2, ["flips"]), completedRun(2, [])]),
    });
    assert.equal(code, EXIT_GATE_FAILURES);
    const output = lines.join("\n");
    assert.match(output, /flaky: 1 tests failed intermittently across 2 runs/u);
    assert.match(output, /test\/a\.test\.ts::flips: 1\/2 failed, 1\/2 passed \(50%\)/u);
  });

  it("exits 0 only when completed runs of a real suite all passed", async () => {
    const lines: string[] = [];
    const code = await flakyCommand({
      root: tempRoot(),
      rerun: 2,
      log: (line) => lines.push(line),
      runSuite: scripted([completedRun(9, [])]),
    });
    assert.equal(code, EXIT_OK);
    const output = lines.join("\n");
    assert.match(output, /run 1: 9 tests, 9 passed, 0 failed/u);
    assert.match(output, /no flaky tests across 2 runs/u);
  });
});

/**
 * The one case a fake cannot cover: the argv itself.
 *
 * The project pins `test_runner: "node"` while `scripts.test` says vitest, so
 * honouring the override is the only way any test runs at all, and `test_paths`
 * is the bare `test` directory that `node --test` cannot take literally. Before
 * this fix both were dropped: the sweep asked for a vitest that is not
 * installed, and where it did reach node it reported "1 test, 1 failed" for the
 * directory it could not import — the same phantom every run, which read as
 * "not intermittent" and printed `no flaky tests`.
 */
describe("flakyCommand (active, end to end)", () => {
  it("runs the intended suite under the configured runner and counts its tests", async () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "e2e", type: "module", scripts: { test: "vitest run" } }),
      "utf8",
    );
    writeFileSync(
      join(root, "kragg.json"),
      JSON.stringify({ test_runner: "node", test_paths: ["test"] }),
      "utf8",
    );
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(
      join(root, "test", "suite.test.js"),
      'import assert from "node:assert/strict";\nimport { test } from "node:test";\n' +
        'test("green one", () => {\n  assert.equal(1, 1);\n});\n' +
        'test("green two", () => {\n  assert.equal(2, 2);\n});\n' +
        'test("always red", () => {\n  assert.equal(1, 2);\n});\n',
      "utf8",
    );
    // This suite itself runs under `node --test`, and a child `node --test`
    // that inherits NODE_TEST_CONTEXT refuses to run ("called recursively").
    const testContext = process.env["NODE_TEST_CONTEXT"];
    delete process.env["NODE_TEST_CONTEXT"];
    const lines: string[] = [];
    let code: number;
    try {
      code = await flakyCommand({ root, rerun: 2, log: (line) => lines.push(line) });
    } finally {
      if (testContext !== undefined) {
        process.env["NODE_TEST_CONTEXT"] = testContext;
      }
    }
    const output = lines.join("\n");
    // Three real tests were discovered and run, twice — not one phantom named
    // after the directory.
    assert.match(output, /run 1: 3 tests, 2 passed, 1 failed/u, output);
    assert.match(output, /run 2: 3 tests, 2 passed, 1 failed/u, output);
    // The one that always fails is a stable failure, named, and exit 1.
    assert.match(output, /no flaky tests across 2 runs/u, output);
    assert.match(output, /test\/suite\.test\.js::always red: 2\/2 failed/u, output);
    assert.equal(code, EXIT_GATE_FAILURES);
  });
});
