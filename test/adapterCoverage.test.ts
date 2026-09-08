/**
 * Tests for the two coverage formats the test-runner adapter reads.
 *
 * istanbul `coverage-final.json` (what vitest writes) and lcov (the only
 * machine-readable coverage `node --test` and `bun test` can produce). Split
 * out of `testRunner.test.ts` to keep both files under the 500-line budget.
 *
 * The point of every case here: a coverage report that could not be read must
 * never turn into a number. Not 0%, which would fail a project for a tooling
 * problem, and above all not 100%, which would pass one that measured nothing.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { coverageTotals, readCoverageReport } from "../src/adapters/support/coverage.ts";
import { parseLcov, readLcov } from "../src/adapters/support/lcov.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-coverage-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents, "utf8");
  }
  return root;
}

// ── coverage ───────────────────────────────────────────────────────────────

/** Two files: 3/4 lines covered overall = 75%. */
const ISTANBUL = JSON.stringify({
  "/repo/src/a.ts": {
    path: "/repo/src/a.ts",
    statementMap: {
      "0": { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
      "1": { start: { line: 2, column: 0 }, end: { line: 2, column: 10 } },
      // Two statements on one line: istanbul takes the MAX, so the line is
      // covered once either of them runs.
      "2": { start: { line: 2, column: 12 }, end: { line: 2, column: 20 } },
    },
    fnMap: {},
    branchMap: {},
    s: { "0": 4, "1": 0, "2": 7 },
    f: {},
    b: {},
  },
  "/repo/src/b.ts": {
    path: "/repo/src/b.ts",
    statementMap: {
      "0": { start: { line: 5, column: 0 }, end: { line: 5, column: 4 } },
      "1": { start: { line: 6, column: 0 }, end: { line: 6, column: 4 } },
    },
    fnMap: {},
    branchMap: {},
    s: { "0": 1, "1": 0 },
    f: {},
    b: {},
  },
});

test("istanbul: line coverage takes the max hit count per line", () => {
  const root = project({ "coverage/coverage-final.json": ISTANBUL });
  const read = readCoverageReport(join(root, "coverage/coverage-final.json"));
  assert.equal(read.ok, true);
  const totals = coverageTotals(read.report);
  // a.ts has 2 executable lines (1 and 2), both covered; b.ts has 2, one
  // covered. 3/4 = 75%.
  assert.equal(totals.totalLines, 4);
  assert.equal(totals.coveredLines, 3);
  assert.equal(totals.pct, 75);
});

test("istanbul: the percentage is floored, so 79.99% cannot clear 80%", () => {
  const statementMap: Record<string, unknown> = {};
  const hits: Record<string, number> = {};
  for (let line = 1; line <= 10_000; line += 1) {
    statementMap[String(line)] = {
      start: { line, column: 0 },
      end: { line, column: 1 },
    };
    hits[String(line)] = line <= 7_999 ? 1 : 0;
  }
  const root = project({
    "coverage/coverage-final.json": JSON.stringify({
      "/repo/src/big.ts": {
        path: "/repo/src/big.ts",
        statementMap,
        fnMap: {},
        branchMap: {},
        s: hits,
        f: {},
        b: {},
      },
    }),
  });
  const read = readCoverageReport(join(root, "coverage/coverage-final.json"));
  assert.equal(read.ok, true);
  assert.equal(coverageTotals(read.report).pct, 79.99);
});

test("istanbul: missing and malformed reports are distinguished, never zero", () => {
  const root = project({ "coverage/broken.json": "{ not json" });
  const missing = readCoverageReport(join(root, "coverage/nope.json"));
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "missing");

  const malformed = readCoverageReport(join(root, "coverage/broken.json"));
  assert.equal(malformed.ok, false);
  assert.equal(malformed.reason, "malformed");
});

test("lcov: DA records become line coverage, and duplicate records merge", () => {
  const tracefile = `TN:
SF:/repo/src/a.ts
DA:1,4
DA:2,0
DA:3,1
LF:3
LH:2
end_of_record
SF:/repo/src/a.ts
DA:2,3
end_of_record
SF:/repo/src/b.ts
DA:10,0
end_of_record
`;
  const report = parseLcov(tracefile, "lcov.info");
  assert.equal(report.files.length, 2);
  const totals = coverageTotals(report);
  // a.ts: lines 1,2,3 — line 2 was 0 in one record and 3 in another, and the
  // counts SUM, so it is covered. b.ts: line 10 uncovered. 3/4 = 75%.
  assert.equal(totals.totalLines, 4);
  assert.equal(totals.coveredLines, 3);
  assert.equal(totals.pct, 75);
});

test("lcov: a corrupt count is dropped, not read as zero coverage", () => {
  const report = parseLcov("SF:/repo/src/a.ts\nDA:1,notanumber\nDA:2,1\nend_of_record\n", "l");
  const totals = coverageTotals(report);
  assert.equal(totals.totalLines, 1);
  assert.equal(totals.coveredLines, 1);
});

test("lcov: an empty or record-less file is a failure, not 100%", () => {
  const root = project({ "coverage/lcov.info": "", "coverage/junk.info": "hello\nworld\n" });
  assert.equal(readLcov(join(root, "coverage/lcov.info")).ok, false);
  assert.equal(readLcov(join(root, "coverage/junk.info")).ok, false);
  assert.equal(readLcov(join(root, "coverage/absent.info")).ok, false);
});

test("lcov: a tracefile that ends inside a record is truncated, not partial coverage", () => {
  // The writer was killed after the first record: reading the one complete
  // record would report coverage over fewer files than the suite touched.
  const root = project({
    "coverage/lcov.info": "SF:/repo/src/a.ts\nDA:1,1\nend_of_record\nSF:/repo/src/b.ts\nDA:1,0\n",
    "coverage/whole.info": "SF:/repo/src/a.ts\nDA:1,1\nend_of_record\n\n",
  });
  const truncated = readLcov(join(root, "coverage/lcov.info"));
  assert.equal(truncated.ok, false);
  assert.match(truncated.ok ? "" : truncated.message, /truncated: it ends inside a record/u);
  // Trailing blank lines are not a truncation.
  assert.equal(readLcov(join(root, "coverage/whole.info")).ok, true);
});

