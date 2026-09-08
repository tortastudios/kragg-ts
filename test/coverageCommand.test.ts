/**
 * Tests for `kragg coverage`.
 *
 * Five things have to hold:
 *
 *  - NO DATA IS NOT A FAILURE. Python's `cmd_coverage` prints one line and
 *    exits 0, because this is a report and not a gate. A non-zero here would
 *    make a repo that has simply never run its tests look broken, and the
 *    gate that DOES fail on this data is `critical-coverage`. The line names
 *    the path that was expected, so "no data" is never a mystery.
 *  - A REPORT THAT IS THERE AND UNUSABLE IS AN ERROR, exit 3, naming the
 *    file. Printing "no coverage data" for a truncated tracefile would send
 *    the reader to re-run a suite that already ran.
 *  - IT READS THE RUNNER'S OWN ARTIFACT, at `coverage_report_path` (istanbul,
 *    vitest) or the `lcov.info` beside it (node, bun) — never "whichever
 *    report exists", which after a runner switch is the other runner's.
 *  - THE RANK IS THE PRODUCT. Rows come back highest-fan-in first, so the
 *    truncation the renderer applies removes the least important rows.
 *  - CLEAN FUNCTIONS ARE COUNTED, NOT LISTED, and UNMEASURED is its own
 *    category with its cause, never folded into "covered".
 *
 * The istanbul report is a literal, exactly as `criticalCoverage.test.ts`
 * does it — no vitest, no c8. `runCoverage` is driven directly with stdout and
 * stderr captured: it performs no asynchronous work before it returns, so a
 * synchronous capture around the call sees every write.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import ts from "typescript";

import {
  coverageSource,
  NO_COVERAGE_DATA_MESSAGE,
  renderGaps,
  runCoverage,
} from "../src/commands/coverage.ts";
import { EXIT_ENVIRONMENT, EXIT_OK } from "../src/engine/report.ts";
import { criticalCoverageGaps } from "../src/gates/criticalCoverage.ts";
import type { CriticalCoverageGap } from "../src/gates/criticalCoverage.ts";
import { writeStamp } from "../src/gates/criticality.ts";
import { loadPolicy } from "../src/policy/policy.ts";

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
const CRITICALITY = JSON.stringify([
  { name: "src/a#run", fan_in: 9, is_critical: true, risk: "HIGH" },
]);
const NODE_MANIFEST = JSON.stringify({ scripts: { test: "node --test" } });
const VITEST_MANIFEST = JSON.stringify({ scripts: { test: "vitest run" } });

/** lcov for `src/a.ts` with line 3 never run. */
const LCOV_LINE_3_UNCOVERED = [
  "SF:src/a.ts", "FN:1,run", "FNDA:1,run", "DA:2,1", "DA:3,0", "end_of_record", "",
].join("\n");

interface Captured {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** Run the command with both streams captured. See the module docs. */
async function run(root: string): Promise<Captured> {
  let out = "";
  let err = "";
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    out += String(chunk);
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    err += String(chunk);
    return true;
  };
  try {
    const code = await runCoverage({ root, api: ts });
    return { code, out, err };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

/** A project whose criticality names `run`, stamped as current. */
function ranked(files: Readonly<Record<string, string>>): string {
  const root = project({ "src/a.ts": SOURCE, ".kragg/criticality.json": CRITICALITY, ...files });
  writeStamp(root, ["src", "test"]);
  return root;
}

describe("coverage: no data is a state, not a failure", () => {
  it("uses the message cmd_coverage prints, verbatim", () => {
    assert.equal(NO_COVERAGE_DATA_MESSAGE, "no coverage data (run `kragg check` first)");
  });

  it("prints that line, and the path it expected, when the runner's artifact is missing", async () => {
    const result = await run(project({ "package.json": NODE_MANIFEST }));
    assert.equal(result.code, EXIT_OK);
    assert.equal(
      result.out,
      `${NO_COVERAGE_DATA_MESSAGE}\n  expected coverage/lcov.info, the lcov report ` +
        "`kragg check` publishes for node\n",
    );
    assert.equal(result.err, "");
  });

  it("names the configured coverage_report_path when that is what is missing", async () => {
    const root = project({
      "package.json": VITEST_MANIFEST,
      "kragg.json": '{"coverage_report_path": "reports/cov.json"}',
    });
    const result = await run(root);
    assert.equal(result.code, EXIT_OK);
    assert.match(result.out, /expected reports\/cov\.json, the istanbul report/u);
  });

  it("is an error when no runner is configured or detected, since nothing publishes coverage", async () => {
    const result = await run(project({ "package.json": "{}" }));
    assert.equal(result.code, EXIT_ENVIRONMENT);
    assert.match(result.err, /no test runner detected/u);
    assert.equal(result.out, "");
  });
});

describe("coverage: an unusable report is an error, never 'no data'", () => {
  it("rejects a tracefile that ends inside a record, naming the file", async () => {
    const root = ranked({ "package.json": NODE_MANIFEST, "coverage/lcov.info": "SF:src/a.ts\nDA:1,1\n" });
    const result = await run(root);
    assert.equal(result.code, EXIT_ENVIRONMENT);
    assert.match(result.err, /coverage report unusable: .*coverage\/lcov\.info/u);
    assert.equal(result.out, "");
  });

  it("rejects an istanbul file that is not a JSON object", async () => {
    const root = ranked({ "package.json": VITEST_MANIFEST, "coverage/coverage-final.json": "[]" });
    const result = await run(root);
    assert.equal(result.code, EXIT_ENVIRONMENT);
    assert.match(result.err, /not a JSON object/u);
  });

  it("rejects a report that names no file under the source paths", async () => {
    const root = ranked({
      "package.json": VITEST_MANIFEST,
      "coverage/coverage-final.json": JSON.stringify(report("/elsewhere", { "0": 1, "1": 1 })),
    });
    const result = await run(root);
    assert.equal(result.code, EXIT_ENVIRONMENT);
    assert.match(result.err, /coverage\/coverage-final\.json — the coverage report names 1 files but none under src/u);
  });
});

describe("coverage: reads the runner's own artifact", () => {
  it("reads the lcov beside coverage_report_path for node, not the istanbul file a previous runner left", async () => {
    const root = ranked({
      "package.json": NODE_MANIFEST,
      "kragg.json": '{"coverage_report_path": "reports/cov.json"}',
      "reports/lcov.info": LCOV_LINE_3_UNCOVERED,
    });
    // The stale istanbul report says everything is covered. It must not be read.
    writeFileSync(join(root, "reports/cov.json"), JSON.stringify(report(root, { "0": 1, "1": 1 })));
    const source = coverageSource(root, loadPolicy(root));
    assert.deepEqual(source, { runner: "node", format: "lcov", path: join(root, "reports/lcov.info") });
    const result = await run(root);
    assert.equal(result.code, EXIT_OK);
    assert.equal(
      result.out,
      "critical coverage: 1 functions, 1 with gaps, 0 clean, 0 unmeasured\n" +
        "  src/a.ts:3 src/a#run (fan-in 9) — uncovered: 3\n",
    );
  });

  it("reads coverage_report_path itself for vitest, ignoring the lcov beside it", async () => {
    const root = ranked({
      "package.json": VITEST_MANIFEST,
      "kragg.json": '{"coverage_report_path": "reports/cov.json"}',
      "reports/lcov.info": LCOV_LINE_3_UNCOVERED,
    });
    writeFileSync(join(root, "reports/cov.json"), JSON.stringify(report(root, { "0": 1, "1": 1 })));
    assert.equal(coverageSource(root, loadPolicy(root))?.format, "istanbul");
    const result = await run(root);
    assert.equal(result.code, EXIT_OK);
    assert.equal(result.out, "critical coverage: 1 functions, 0 with gaps, 1 clean, 0 unmeasured\n");
  });

  it("follows `test_runner` over the manifest when the policy names the runner", () => {
    const root = project({ "package.json": VITEST_MANIFEST, "kragg.json": '{"test_runner": "node"}' });
    assert.equal(coverageSource(root, loadPolicy(root))?.format, "lcov");
  });
});

describe("coverage: ranked gaps", () => {
  it("reports the uncovered lines of a critical function as a file:line pointer", () => {
    const root = ranked({});
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
    const root = ranked({});
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

  it("keeps unmeasured functions in their own category, with the cause", () => {
    const root = project({
      "src/a.ts": SOURCE,
      "src/b.ts": "export function other(): void {}\n",
      ".kragg/criticality.json": JSON.stringify([
        { name: "src/a#run", fan_in: 9, is_critical: true, risk: "HIGH" },
        { name: "src/b#other", fan_in: 4, is_critical: true, risk: "MED" },
      ]),
    });
    writeStamp(root, ["src", "test"]);
    const gaps = criticalCoverageGaps({
      root,
      sourcePaths: ["src"],
      report: report(root, { "0": 1, "1": 1 }),
      api: ts,
    });
    assert.deepEqual(renderGaps(gaps), [
      "critical coverage: 2 functions, 0 with gaps, 1 clean, 1 unmeasured",
      "  src/b.ts:1 src/b#other (fan-in 4) — unmeasured: the test run never loaded " +
        "src/b.ts (no entry in the coverage report)",
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
