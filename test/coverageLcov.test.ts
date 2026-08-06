/**
 * Tests for the lcov half of the coverage pipeline.
 *
 * WHY THIS FILE EXISTS. `critical-coverage` used to need istanbul's
 * `coverage-final.json`, which two of the three runners kragg drives cannot
 * produce — so on every `node --test` and `bun test` project the strictest gate
 * in the suite reported SKIP, run after run, and a reader saw that as "fine".
 * The lcov path is what closes that, and these tests pin the three ways it
 * could go wrong:
 *
 *  1. FABRICATION. lcov's two-field `FN:<line>,<name>` states where a function
 *     STARTS and nothing about where it ends. Nothing may invent that end
 *     line; the span carries `null` and the extent comes from the source.
 *  2. MIS-ATTRIBUTION. An uncovered line outside a function's body must never
 *     be blamed on it — the failure that sends a reviewer to the wrong place.
 *  3. A FALSE GREEN. A critical function the tests never entered must fail,
 *     and a function nothing can bound must come back UNMEASURED rather than
 *     clean.
 *
 * Tracefiles are written as literals rather than produced by a real run: the
 * pipeline has to be testable without invoking a runner, and a recorded
 * artifact would pin these tests to one Node version's reporter.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import ts from "typescript";

import { parseLcov } from "../src/adapters/support/lcov.ts";
import { writeStamp } from "../src/gates/criticality/freshness.ts";
import { normalizeLcov } from "../src/coverage/lcov.ts";
import type { FileCoverage } from "../src/coverage/model.ts";
import { functionSpans, uniqueSpan } from "../src/coverage/spans.ts";
import {
  checkCriticalCoverage,
  criticalCoverageGaps,
  NO_COVERAGE_REASON,
  type CriticalCoverageOptions,
} from "../src/gates/criticalCoverage.ts";
import type { Violation } from "../src/engine/models.ts";

const ROOT = "/repo";

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-lcov-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  // Vouch for the fixture's `.kragg/criticality.json` once every file it
  // describes is on disk: the gate refuses criticality data nothing says is
  // current. See `gates/criticality/freshness.ts`.
  writeStamp(root, ["src", "test"]);
  return root;
}

/** `src/client.ts`: one multi-line critical method, plus a decoy below it. */
const SOURCE = [
  "export class Client {", //                 1
  "  send(flag: boolean): number {", //       2
  "    if (flag) {", //                       3
  "      return 1;", //                       4
  "    }", //                                 5
  "    return 2;", //                         6
  "  }", //                                   7
  "}", //                                     8
  "export const helper = (): number => 3;", // 9
  "",
].join("\n");

const CRITICALITY = JSON.stringify([
  { name: "src/client#Client.send", fan_in: 9, is_critical: true },
]);

function measuredProject(source: string = SOURCE): string {
  return project({ ".kragg/criticality.json": CRITICALITY, "src/client.ts": source });
}

function tracefile(body: readonly string[]): string {
  return ["TN:", "SF:src/client.ts", ...body, "end_of_record", ""].join("\n");
}

function options(root: string, lcov: string): CriticalCoverageOptions {
  return { root, sourcePaths: ["src"], report: null, lcov, api: ts };
}

function violationsFor(root: string, lcov: string): readonly Violation[] {
  const outcome = checkCriticalCoverage(options(root, lcov));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.skipped, false);
  return outcome.ok && !outcome.skipped ? outcome.violations : [];
}

function normalized(text: string, root = ROOT): FileCoverage {
  const model = normalizeLcov(parseLcov(text, "lcov.info"), root);
  const file = model.files.get("src/client.ts");
  assert.ok(file !== undefined, `no coverage for src/client.ts in ${[...model.files.keys()]}`);
  return file;
}

describe("lcov -> the line model", () => {
  it("maps `DA:` records onto uncovered lines, stating nothing else", () => {
    const file = normalized(tracefile(["DA:2,3", "DA:3,0", "DA:4,0", "DA:6,1"]));
    assert.deepEqual(file.uncoveredLines, [3, 4]);
  });

  it("leaves `endLine` null for the two-field `FN:` every runner writes", () => {
    const file = normalized(tracefile(["FN:2,send", "FNDA:3,send", "DA:2,3"]));
    assert.deepEqual(file.functions, [
      { name: "send", startLine: 2, endLine: null, hits: 3 },
    ]);
  });

  it("keeps the end line when lcov 2.x states one", () => {
    const file = normalized(tracefile(["FN:2,7,send", "FNDA:1,send"]));
    assert.deepEqual(file.functions, [
      { name: "send", startLine: 2, endLine: 7, hits: 1 },
    ]);
  });

  it("reads a function name that is itself a number", () => {
    const file = normalized(tracefile(["FN:2,404", "FNDA:1,404"]));
    assert.equal(file.functions[0]?.name, "404");
    assert.equal(file.functions[0]?.endLine, null);
  });

  it("sums hits across the repeated records node and bun emit", () => {
    // One record per source file PER TEST FILE: the same function appears
    // several times, and it was entered if any run entered it.
    const text = [
      "SF:src/client.ts",
      "FN:2,send",
      "FNDA:0,send",
      "DA:4,0",
      "end_of_record",
      "SF:src/client.ts",
      "FN:2,send",
      "FNDA:2,send",
      "DA:4,1",
      "end_of_record",
      "",
    ].join("\n");
    const file = normalized(text);
    assert.deepEqual(file.uncoveredLines, []);
    assert.deepEqual(file.functions, [
      { name: "send", startLine: 2, endLine: null, hits: 2 },
    ]);
  });

  it("keeps BOTH spans when one name is declared at two lines", () => {
    // `Reader.close` and `Writer.close` in one file. Keeping both is what lets
    // the gate notice the ambiguity instead of picking one.
    const file = normalized(tracefile(["FN:2,close", "FN:9,close", "FNDA:1,close"]));
    assert.deepEqual(
      file.functions.map((span) => span.startLine),
      [2, 9],
    );
  });

  it("ignores `BRDA:` and the writer's own `LF`/`FNF` summaries", () => {
    const file = normalized(
      tracefile(["FN:2,send", "FNDA:1,send", "DA:2,1", "BRDA:3,0,0,0", "LF:99", "LH:0", "FNF:7"]),
    );
    assert.deepEqual(file.uncoveredLines, []);
    assert.equal(file.functions.length, 1);
  });

  it("resolves an absolute `SF:` under the root to a repo-relative key", () => {
    const text = ["SF:/repo/src/client.ts", "DA:2,0", "end_of_record", ""].join("\n");
    assert.deepEqual(normalized(text).uncoveredLines, [2]);
  });

  it("drops a malformed record rather than manufacturing an uncovered line", () => {
    const file = normalized(tracefile(["DA:2,notanumber", "FN:zero,send", "FNDA:1,", "DA:3,0"]));
    assert.deepEqual(file.uncoveredLines, [3]);
    assert.deepEqual(file.functions, []);
  });
});

describe("function extents read from the source", () => {
  it("spans a method from its own first token to its closing brace", () => {
    const root = measuredProject();
    const spans = functionSpans(join(root, "src/client.ts"), root, ts);
    assert.deepEqual(uniqueSpan(spans, "send"), { startLine: 2, endLine: 7 });
  });

  it("names an arrow bound to a const, as a coverage report does", () => {
    const root = measuredProject();
    const spans = functionSpans(join(root, "src/client.ts"), root, ts);
    assert.deepEqual(uniqueSpan(spans, "helper"), { startLine: 9, endLine: 9 });
  });

  it("refuses to pick between two functions sharing a simple name", () => {
    const root = measuredProject(
      "export class Reader {\n  close(): void {}\n}\nexport class Writer {\n  close(): void {}\n}\n",
    );
    const spans = functionSpans(join(root, "src/client.ts"), root, ts);
    assert.equal(spans.get("close")?.length, 2);
    assert.equal(uniqueSpan(spans, "close"), null);
  });

  it("returns an empty index for a file that is not there", () => {
    const root = measuredProject();
    assert.equal(functionSpans(join(root, "src/absent.ts"), root, ts).size, 0);
  });
});

describe("critical-coverage under lcov", () => {
  it("reports an uncovered line INSIDE the function and ignores one outside", () => {
    // Line 4 is inside `send`; line 9 is `helper`, below it. Without a real
    // extent the two are indistinguishable — this is the whole reason the span
    // comes from the source rather than from the next `FN:` record.
    const root = measuredProject();
    const violations = violationsFor(
      root,
      tracefile(["FN:2,send", "FNDA:3,send", "DA:2,3", "DA:4,0", "DA:6,3", "DA:9,0"]),
    );
    assert.equal(violations.length, 1);
    const violation = violations[0];
    assert.ok(violation !== undefined);
    assert.equal(violation.message, "critical function src/client#Client.send has 1 uncovered lines");
    assert.equal(violation.file, "src/client.ts");
    assert.equal(violation.line, 4);
    assert.equal(violation.fixHint, "add a test exercising send (uncovered: 4)");
  });

  it("passes a critical function whose body is fully covered", () => {
    const root = measuredProject();
    assert.deepEqual(
      violationsFor(root, tracefile(["FN:2,send", "FNDA:3,send", "DA:2,3", "DA:4,1", "DA:9,0"])),
      [],
    );
  });

  it("fails a critical function no test ever entered", () => {
    const root = measuredProject();
    const violations = violationsFor(root, tracefile(["FN:2,send", "FNDA:0,send"]));
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.line, 2);
  });

  it("treats a name the source binds twice as UNMEASURED, never as clean", () => {
    const root = measuredProject(
      "export class Client {\n  send(): void {}\n}\nexport class Other {\n  send(): void {}\n}\n",
    );
    // The tracefile is unambiguous; the SOURCE is not, so no extent can be
    // attributed and the gate declines rather than blaming the wrong method.
    const lcov = tracefile(["FN:2,send", "FNDA:1,send", "DA:2,1", "DA:5,0"]);
    assert.deepEqual(violationsFor(root, lcov), []);
    assert.deepEqual(
      criticalCoverageGaps(options(root, lcov)).map((gap) => gap.measured),
      [false],
    );
  });

  it("skips visibly when neither a report nor a tracefile was supplied", () => {
    const outcome = checkCriticalCoverage({
      root: measuredProject(),
      sourcePaths: ["src"],
      report: null,
      api: ts,
    });
    assert.equal(outcome.ok && outcome.skipped && outcome.reason, NO_COVERAGE_REASON);
  });

  it("prefers the istanbul document when both are present", () => {
    // istanbul states the body span outright, so it produces the better
    // attribution; the lcov beside it is usually the older artifact.
    const root = measuredProject();
    const outcome = checkCriticalCoverage({
      root,
      sourcePaths: ["src"],
      report: {
        [join(root, "src/client.ts")]: {
          statementMap: { "0": { start: { line: 4 }, end: { line: 4 } } },
          s: { "0": 1 },
          fnMap: { "0": { name: "send", loc: { start: { line: 2 }, end: { line: 7 } } } },
          f: { "0": 1 },
        },
      },
      // Says line 4 never ran. If this were read, the gate would fail.
      lcov: tracefile(["FN:2,send", "FNDA:1,send", "DA:4,0"]),
      api: ts,
    });
    assert.equal(outcome.ok && !outcome.skipped && outcome.violations.length, 0);
  });
});
