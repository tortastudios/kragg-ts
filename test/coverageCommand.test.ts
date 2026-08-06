/**
 * Tests for `kragg coverage`.
 *
 * Four things have to hold:
 *
 *  - NO DATA IS NOT A FAILURE. Python's `cmd_coverage` prints one line and
 *    exits 0, because this is a report and not a gate. A non-zero here would
 *    make a repo that has simply never run its tests look broken, and the
 *    gate that DOES fail on this data is `critical-coverage`.
 *  - THE RANK IS THE PRODUCT. Rows come back highest-fan-in first, so the
 *    truncation the renderer applies removes the least important rows and the
 *    reader can stop after the first line and still have acted correctly.
 *  - CLEAN FUNCTIONS ARE COUNTED, NOT LISTED. A repo with forty critical
 *    functions and three gaps prints four lines. That economy is the whole
 *    reason this fits in an agent's context window.
 *  - UNMEASURED IS ITS OWN CATEGORY, never folded into "covered".
 *
 * The istanbul report is a literal, exactly as `criticalCoverage.test.ts`
 * does it — no vitest, no c8, no fixture artifact on disk.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import ts from "typescript";

import {
  NO_COVERAGE_DATA_MESSAGE,
  readReport,
  renderGaps,
} from "../src/commands/coverage.ts";
import { criticalCoverageGaps } from "../src/gates/criticalCoverage.ts";
import type { CriticalCoverageGap } from "../src/gates/criticalCoverage.ts";

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
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

/** An istanbul entry for `src/a.ts` with one function and two statements. */
function report(root: string, hits: Readonly<Record<string, number>>): unknown {
  return {
    [join(root, "src/a.ts")]: {
      path: join(root, "src/a.ts"),
      statementMap: {
        "0": { start: { line: 2, column: 2 }, end: { line: 2, column: 20 } },
        "1": { start: { line: 3, column: 2 }, end: { line: 3, column: 20 } },
      },
      s: { "0": hits["0"] ?? 0, "1": hits["1"] ?? 0 },
      fnMap: {
        "0": {
          name: "run",
          decl: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
          loc: { start: { line: 1, column: 0 }, end: { line: 4, column: 1 } },
        },
      },
      f: { "0": 1 },
    },
  };
}

const SOURCE = "export function run(flag: boolean): number {\n  const a = 1;\n  return a;\n}\n";

describe("coverage: no data is a state, not a failure", () => {
  it("uses the message cmd_coverage prints, verbatim", () => {
    assert.equal(NO_COVERAGE_DATA_MESSAGE, "no coverage data (run `kragg check` first)");
  });

  it("returns null when no report exists at any default path", () => {
    assert.equal(readReport(project({})), null);
  });

  it("returns null for a file that is not JSON", () => {
    const root = project({ "coverage/coverage-final.json": "{ truncated" });
    assert.equal(readReport(root), null);
  });

  it("returns null for JSON that is not an object", () => {
    // An empty model would otherwise render as "everything is unmeasured",
    // which reads as a finding when it is really a broken input.
    const root = project({ "coverage/coverage-final.json": "[]" });
    assert.equal(readReport(root), null);
  });

  it("reads vitest's default path", () => {
    const root = project({ "coverage/coverage-final.json": '{"a":{}}' });
    assert.notEqual(readReport(root), null);
  });

  it("falls back to .kragg/coverage-final.json", () => {
    const root = project({ ".kragg/coverage-final.json": '{"a":{}}' });
    assert.notEqual(readReport(root), null);
  });

  it("honours an explicit path and does not fall back from it", () => {
    const root = project({
      "coverage/coverage-final.json": '{"a":{}}',
      "other/report.json": '{"b":{}}',
    });
    assert.notEqual(readReport(root, "other/report.json"), null);
    assert.equal(readReport(root, "missing/report.json"), null);
  });
});

describe("coverage: ranked gaps", () => {
  it("reports the uncovered lines of a critical function as a file:line pointer", () => {
    const root = project({
      "src/a.ts": SOURCE,
      ".kragg/criticality.json": JSON.stringify([
        { name: "src/a#run", fan_in: 9, is_critical: true, risk: "HIGH" },
      ]),
    });
    const gaps = criticalCoverageGaps({
      root,
      sourcePaths: ["src"],
      report: report(root, { "0": 1, "1": 0 }),
      api: ts,
    });
    assert.deepEqual(renderGaps(gaps), [
      "critical coverage: 1 functions, 1 with gaps, 0 clean, 0 unmeasured",
      "  src/a.ts:3 src/a#run (fan-in 9) — uncovered: 3",
    ]);
  });

  it("counts a fully covered function without listing it", () => {
    const root = project({
      "src/a.ts": SOURCE,
      ".kragg/criticality.json": JSON.stringify([
        { name: "src/a#run", fan_in: 9, is_critical: true, risk: "HIGH" },
      ]),
    });
    const gaps = criticalCoverageGaps({
      root,
      sourcePaths: ["src"],
      report: report(root, { "0": 1, "1": 1 }),
      api: ts,
    });
    assert.deepEqual(renderGaps(gaps), [
      "critical coverage: 1 functions, 0 with gaps, 1 clean, 0 unmeasured",
    ]);
  });

  it("keeps unmeasured functions in their own category", () => {
    const root = project({
      "src/a.ts": SOURCE,
      "src/b.ts": "export function other(): void {}\n",
      ".kragg/criticality.json": JSON.stringify([
        { name: "src/a#run", fan_in: 9, is_critical: true, risk: "HIGH" },
        { name: "src/b#other", fan_in: 4, is_critical: true, risk: "MED" },
      ]),
    });
    const gaps = criticalCoverageGaps({
      root,
      sourcePaths: ["src"],
      report: report(root, { "0": 1, "1": 1 }),
      api: ts,
    });
    assert.deepEqual(renderGaps(gaps), [
      "critical coverage: 2 functions, 0 with gaps, 1 clean, 1 unmeasured",
      "  src/b.ts src/b#other (fan-in 4) — no coverage entry",
    ]);
  });

  it("says so when there are no critical functions at all", () => {
    assert.deepEqual(renderGaps([]), [
      "no critical functions (run `kragg criticality --write`)",
    ]);
  });
});

describe("coverage: rendering economy", () => {
  function gap(
    qualname: string,
    fanIn: number,
    missingLines: readonly number[],
  ): CriticalCoverageGap {
    return { qualname, file: "src/a.ts", fanIn, missingLines, measured: true };
  }

  it("preserves the fan-in order it was given", () => {
    const lines = renderGaps([
      gap("src/a#high", 9, [3]),
      gap("src/a#low", 1, [4]),
    ]);
    assert.ok(lines[1]?.includes("src/a#high"), lines.join("\n"));
    assert.ok(lines[2]?.includes("src/a#low"), lines.join("\n"));
  });

  it("caps a long uncovered-line list rather than printing all of it", () => {
    const lines = Array.from({ length: 20 }, (_, index) => index + 1);
    const rendered = renderGaps([gap("src/a#run", 9, lines)])[1] ?? "";
    assert.ok(rendered.includes("uncovered: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, +8 more"), rendered);
  });

  it("points at the first uncovered line, which is the one to open", () => {
    const rendered = renderGaps([gap("src/a#run", 9, [17, 18, 19])])[1] ?? "";
    assert.ok(rendered.startsWith("  src/a.ts:17 "), rendered);
  });
});
