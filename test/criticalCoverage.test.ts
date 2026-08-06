/**
 * Tests for the critical-coverage gate.
 *
 * Three things have to hold, and each has a section below:
 *
 *  - a MEASURED public critical function with an uncovered line fails, with
 *    the message, code, line and fix hint Python emits;
 *  - an UNMEASURED one does not fail. That is not laziness — Python's gate
 *    says so explicitly, because the likeliest cause of a missing entry is a
 *    coverage-key mismatch, and a wall of false failures from a misconfigured
 *    tool is how a gate gets disabled. The ambiguous case (two functions in a
 *    file sharing a simple name) is treated the same way and tested here, so
 *    the recall gap is pinned down rather than assumed;
 *  - a missing input SKIPS VISIBLY. No criticality data, or no coverage
 *    report, must never read as a pass.
 *
 * The coverage report is passed in as a literal, which is the whole point of
 * the parsed-object interface: no vitest, no c8, no fixture artifact.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import ts from "typescript";

import {
  checkCriticalCoverage,
  criticalCoverageGaps,
  CRITICAL_COVERAGE_CODE,
  NO_COVERAGE_REASON,
  type CriticalCoverageOptions,
} from "../src/gates/criticalCoverage.ts";
import type { Violation } from "../src/engine/models.ts";
import { writeStamp } from "../src/gates/criticality.ts";
import { NO_CRITICALITY_REASON } from "../src/gates/testDepth/outcome.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-critical-coverage-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  // Vouch for the fixture's `.kragg/criticality.json` once every file it
  // describes is on disk. The gate refuses criticality data that nothing says
  // is current, and a fixture writing the data BEFORE its sources is the exact
  // shape of the bug that check exists for. The real pipeline gets here by
  // deriving; see `gates/criticality/freshness.ts`.
  writeStamp(root, ["src", "test"]);
  return root;
}

const CRITICALITY = JSON.stringify([
  { name: "src/client#Client.send", fan_in: 9, is_critical: true },
  { name: "src/client#Client.retry", fan_in: 2, is_critical: true },
  { name: "src/client#_internal", fan_in: 8, is_critical: true },
  { name: "src/client#Client.idle", fan_in: 1, is_critical: false },
]);

const SOURCE = `
export class Client {
  send() {}
  retry() {}
  idle() {}
}
export function _internal() {}
`;

/** A file entry with the given `[startLine, endLine, hits]` statements. */
function coverageEntry(
  root: string,
  statements: readonly (readonly [number, number])[],
  functions: readonly (readonly [string, number, number, number])[],
): Record<string, unknown> {
  const statementMap: Record<string, unknown> = {};
  const s: Record<string, number> = {};
  statements.forEach(([line, hits], index) => {
    statementMap[String(index)] = { start: { line }, end: { line } };
    s[String(index)] = hits;
  });
  const fnMap: Record<string, unknown> = {};
  const f: Record<string, number> = {};
  functions.forEach(([name, start, end, hits], index) => {
    fnMap[String(index)] = { name, loc: { start: { line: start }, end: { line: end } } };
    f[String(index)] = hits;
  });
  return { [join(root, "src/client.ts")]: { statementMap, s, fnMap, f } };
}

function options(root: string, report: unknown): CriticalCoverageOptions {
  return { root, sourcePaths: ["src"], report, api: ts };
}

function violationsFor(root: string, report: unknown): readonly Violation[] {
  const outcome = checkCriticalCoverage(options(root, report));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.skipped, false);
  return outcome.ok && !outcome.skipped ? outcome.violations : [];
}

function measuredProject(): string {
  return project({ ".kragg/criticality.json": CRITICALITY, "src/client.ts": SOURCE });
}

describe("critical-coverage: measured gaps", () => {
  it("fails on a critical function with uncovered lines", () => {
    const root = measuredProject();
    const report = coverageEntry(
      root,
      [[3, 1], [4, 0], [5, 0]],
      [["send", 3, 3, 1], ["retry", 4, 5, 0]],
    );
    const violations = violationsFor(root, report);
    assert.equal(violations.length, 1);
    const violation = violations[0];
    assert.ok(violation !== undefined);
    assert.equal(
      violation.message,
      "critical function src/client#Client.retry has 2 uncovered lines",
    );
    assert.equal(violation.file, "src/client.ts");
    assert.equal(violation.line, 4);
    assert.equal(violation.code, CRITICAL_COVERAGE_CODE);
    assert.equal(violation.fixHint, "add a test exercising retry (uncovered: 4, 5)");
  });

  it("passes a critical function with no uncovered line", () => {
    const root = measuredProject();
    const report = coverageEntry(root, [[3, 2], [4, 1]], [["send", 3, 3, 2], ["retry", 4, 4, 1]]);
    assert.deepEqual(violationsFor(root, report), []);
  });

  it("reports a never-entered function that has no statement lines", () => {
    // A one-expression arrow: istanbul records the function and no statement,
    // so without the hits check an untested critical function would pass.
    const root = measuredProject();
    const report = coverageEntry(root, [], [["send", 3, 3, 0], ["retry", 4, 4, 1]]);
    const violations = violationsFor(root, report);
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.line, 3);
  });

  it("ignores lines outside the function's own span", () => {
    const root = measuredProject();
    const report = coverageEntry(root, [[9, 0]], [["send", 3, 4, 1]]);
    assert.deepEqual(violationsFor(root, report), []);
  });

  it("previews at most six uncovered lines in the fix hint", () => {
    const root = measuredProject();
    const lines: (readonly [number, number])[] = [];
    for (let line = 3; line <= 12; line += 1) {
      lines.push([line, 0]);
    }
    const report = coverageEntry(root, lines, [["send", 3, 12, 0]]);
    const violation = violationsFor(root, report)[0];
    assert.ok(violation !== undefined);
    assert.match(violation.message, /has 10 uncovered lines/);
    assert.equal(violation.fixHint, "add a test exercising send (uncovered: 3, 4, 5, 6, 7, 8)");
  });

  it("ranks gaps by fan-in, highest first", () => {
    const root = measuredProject();
    const report = coverageEntry(
      root,
      [[3, 0], [4, 0]],
      [["send", 3, 3, 0], ["retry", 4, 4, 0]],
    );
    assert.deepEqual(
      criticalCoverageGaps(options(root, report)).map((gap) => gap.qualname),
      ["src/client#Client.send", "src/client#Client.retry"],
    );
  });
});

describe("critical-coverage: what it will not claim", () => {
  it("does not fail a function the report never mentions", () => {
    const root = measuredProject();
    const report = coverageEntry(root, [[3, 0]], [["idle", 3, 3, 0]]);
    assert.deepEqual(violationsFor(root, report), []);
    const gaps = criticalCoverageGaps(options(root, report));
    assert.deepEqual(
      gaps.map((gap) => gap.measured),
      [false, false],
    );
  });

  it("does not fail when the file has no coverage entry at all", () => {
    const root = measuredProject();
    assert.deepEqual(violationsFor(root, { "/elsewhere/other.ts": {} }), []);
  });

  it("treats a name shared by two functions in one file as unmeasured", () => {
    const root = measuredProject();
    const report = coverageEntry(
      root,
      [[3, 0], [9, 0]],
      [["send", 3, 3, 0], ["send", 9, 9, 0]],
    );
    assert.deepEqual(violationsFor(root, report), []);
  });

  it("exempts a private critical function", () => {
    const root = measuredProject();
    const report = coverageEntry(root, [[7, 0]], [["_internal", 7, 7, 0]]);
    assert.deepEqual(violationsFor(root, report), []);
  });

  it("exempts a function that is not marked critical", () => {
    const root = measuredProject();
    const report = coverageEntry(root, [[5, 0]], [["idle", 5, 5, 0]]);
    assert.deepEqual(violationsFor(root, report), []);
  });

  it("drops an entry whose module is not under the source paths", () => {
    const root = project({
      ".kragg/criticality.json": JSON.stringify([
        { name: "deleted/gone#run", fan_in: 9, is_critical: true },
      ]),
      "src/client.ts": SOURCE,
    });
    assert.deepEqual(violationsFor(root, {}), []);
  });
});

describe("critical-coverage: when it cannot run", () => {
  it("skips with the criticality remediation when there is no data", () => {
    const root = project({ "src/client.ts": SOURCE });
    const outcome = checkCriticalCoverage(options(root, {}));
    assert.equal(outcome.ok && outcome.skipped && outcome.reason, NO_CRITICALITY_REASON);
  });

  it("skips rather than passing when no coverage report was supplied", () => {
    const outcome = checkCriticalCoverage(options(measuredProject(), null));
    assert.equal(outcome.ok && outcome.skipped && outcome.reason, NO_COVERAGE_REASON);
  });
});
