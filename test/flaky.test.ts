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
 * The active half is not driven end-to-end here: re-running a real suite N
 * times inside a unit test would be slow, and the interesting logic
 * (identity extraction, intermittent-vs-broken) is separable and is tested as
 * such.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { JournalEntry } from "../src/engine/journal.ts";
import { EXIT_OK } from "../src/engine/report.ts";
import {
  aggregateReruns,
  DEFAULT_LAST,
  failureRatio,
  flakyCommand,
  passiveFlaky,
  renderPassive,
  renderReruns,
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
    const flaky = aggregateReruns([["a"], [], ["a"], []]);
    assert.deepEqual(flaky, [{ testId: "a", failures: 2, runs: 4 }]);
    assert.equal(failureRatio({ testId: "a", failures: 2, runs: 4 }), 0.5);
    assert.equal(failureRatio({ testId: "a", failures: 0, runs: 0 }), 0);
  });

  it("does NOT flag a test that failed in every run — that is just broken", () => {
    assert.deepEqual(aggregateReruns([["a"], ["a"], ["a"]]), []);
  });

  it("counts a duplicate identity within one run only once", () => {
    const flaky = aggregateReruns([["a", "a", "a"], []]);
    assert.deepEqual(flaky, [{ testId: "a", failures: 1, runs: 2 }]);
  });

  it("reports nothing when every run was green", () => {
    assert.deepEqual(aggregateReruns([[], [], []]), []);
  });

  it("orders by failure count, then by id for a stable tie-break", () => {
    const flaky = aggregateReruns([["b", "z"], ["b"], ["a"], []]);
    assert.deepEqual(
      flaky.map((test) => test.testId),
      ["b", "a", "z"],
    );
  });

  it("treats a single run as having nothing intermittent to say", () => {
    assert.deepEqual(aggregateReruns([["a"]]), []);
  });
});

describe("renderReruns", () => {
  it("names the run count when nothing was intermittent", () => {
    assert.deepEqual(renderReruns([], 5), ["no flaky tests across 5 runs"]);
  });

  it("renders the ratio as a percentage", () => {
    const lines = renderReruns([{ testId: "test/a.test.ts::x", failures: 1, runs: 4 }], 4);
    assert.equal(lines[1], "  test/a.test.ts::x: 1/4 failed (25%)");
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

  it("scans a sensible default window", () => {
    assert.equal(DEFAULT_LAST, 50);
  });
});
