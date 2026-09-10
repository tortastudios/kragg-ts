/**
 * Tests for the critical-coverage gate.
 *
 * Four things have to hold, and each has a section below:
 *
 *  - a MEASURED public critical function with an uncovered line fails, with
 *    the message, code, line and fix hint Python emits;
 *  - an UNMEASURED one fails too, under its own code and with the cause in
 *    the message. Python does not fail it, on the theory that a missing entry
 *    is a measurement-key mismatch; here the document is the one this run's
 *    own test gate wrote, so a missing file was never loaded — the function
 *    is untested, and silence would be the false green this gate exists to
 *    prevent;
 *  - ATTRIBUTION IS EXACT. Two classes with a same-named method, an arrow
 *    bound to a const beside an anonymous callback, an overloaded function,
 *    a class that is itself a node: each function answers only for its own
 *    lines, and no function is blamed for another's;
 *  - a missing input SKIPS VISIBLY and an unusable one is an ERROR. No
 *    criticality data, or no coverage report, must never read as a pass; a
 *    report that names no file under the source paths is a broken input, not
 *    a wall of findings.
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
  coverageModel,
  criticalCoverageGaps,
  CRITICAL_COVERAGE_CODE,
  CRITICAL_UNMEASURED_CODE,
  NO_COVERAGE_REASON,
  type CriticalCoverageOptions,
} from "../src/gates/criticalCoverage.ts";
import { functionSpans } from "../src/coverage/spans.ts";
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

type Statement = readonly [line: number, hits: number];
type Fn = readonly [name: string, start: number, end: number, hits: number];

/** One istanbul file entry with the given statements and functions. */
function fileEntry(statements: readonly Statement[], functions: readonly Fn[]): unknown {
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
  return { statementMap, s, fnMap, f };
}

/** A report with one entry, for `src/client.ts`. */
function coverageEntry(
  root: string,
  statements: readonly Statement[],
  functions: readonly Fn[],
  file = "src/client.ts",
): Record<string, unknown> {
  return { [join(root, file)]: fileEntry(statements, functions) };
}

function options(root: string, report: unknown): CriticalCoverageOptions {
  return { root, sourcePaths: ["src"], report, api: ts };
}

function violationsFor(root: string, report: unknown): readonly Violation[] {
  const outcome = checkCriticalCoverage(options(root, report));
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.message);
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
    // The report's span for `retry` (4-5) overreaches into `idle` on line 5.
    // The source bounds `retry` to line 4, so line 5 is not blamed on it.
    const violations = violationsFor(root, report);
    assert.equal(violations.length, 1);
    const violation = violations[0];
    assert.ok(violation !== undefined);
    assert.equal(
      violation.message,
      "critical function src/client#Client.retry has 1 uncovered lines",
    );
    assert.equal(violation.file, "src/client.ts");
    assert.equal(violation.line, 4);
    assert.equal(violation.code, CRITICAL_COVERAGE_CODE);
    assert.equal(violation.fixHint, "add a test exercising retry (uncovered: 4)");
  });

  it("still reports an unexercised TypeScript-private method as uncovered", () => {
    // TOR-1417: `test-quality` stopped demanding that a test NAME a `private`
    // member. This gate never asked for a name — it asks whether the lines
    // ran — and must keep asking, or a private method could be exported from
    // scrutiny by the keyword alone. `unlock` runs when `open` runs; `orphan`
    // never runs, and line coverage is what says so.
    const root = project({
      ".kragg/criticality.json": JSON.stringify([
        { name: "src/vault#Vault.unlock", fan_in: 1, is_critical: true },
        { name: "src/vault#Vault.orphan", fan_in: 0, is_critical: true },
      ]),
      "src/vault.ts": [
        "export class Vault {",
        "  open(): string {",
        "    return this.unlock();",
        "  }",
        "  private unlock(): string {",
        '    return "k";',
        "  }",
        "  private orphan(): string {",
        '    return "never";',
        "  }",
        "}",
        "",
      ].join("\n"),
    });
    const report = coverageEntry(
      root,
      [[3, 1], [6, 1], [9, 0]],
      [["open", 2, 4, 1], ["unlock", 5, 7, 1], ["orphan", 8, 10, 0]],
      "src/vault.ts",
    );
    const violations = violationsFor(root, report);
    assert.equal(violations.length, 1);
    assert.equal(
      violations[0]?.message,
      "critical function src/vault#Vault.orphan has 1 uncovered lines",
    );
    assert.equal(violations[0]?.code, CRITICAL_COVERAGE_CODE);
    assert.equal(violations[0]?.file, "src/vault.ts");
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
    assert.equal(violations[0]?.code, CRITICAL_COVERAGE_CODE);
  });

  it("ignores lines outside the function's own span", () => {
    const root = measuredProject();
    const report = coverageEntry(root, [[9, 0]], [["send", 3, 4, 1], ["retry", 4, 4, 1]]);
    assert.deepEqual(violationsFor(root, report), []);
  });

  it("previews at most six uncovered lines in the fix hint", () => {
    const root = project({
      ".kragg/criticality.json": JSON.stringify([
        { name: "src/client#send", fan_in: 9, is_critical: true },
      ]),
      "src/client.ts": `export function send(): void {\n${"  run();\n".repeat(10)}}\n`,
    });
    const lines: Statement[] = [];
    for (let line = 2; line <= 11; line += 1) {
      lines.push([line, 0]);
    }
    const report = coverageEntry(root, lines, [["send", 1, 12, 0]]);
    const violation = violationsFor(root, report)[0];
    assert.ok(violation !== undefined);
    assert.match(violation.message, /has 10 uncovered lines/);
    assert.equal(violation.fixHint, "add a test exercising send (uncovered: 2, 3, 4, 5, 6, 7)");
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

describe("critical-coverage: unmeasured is a finding, never a pass", () => {
  it("fails, under its own code, a function whose file the run never loaded", () => {
    const root = measuredProject();
    const report = coverageEntry(root, [[1, 1]], [], "src/other.ts");
    const violations = violationsFor(root, report);
    assert.deepEqual(
      violations.map((violation) => violation.code),
      [CRITICAL_UNMEASURED_CODE, CRITICAL_UNMEASURED_CODE],
    );
    const send = violations[0];
    assert.ok(send !== undefined);
    assert.equal(
      send.message,
      "critical function src/client#Client.send has no coverage data: the test run " +
        "never loaded src/client.ts (no entry in the coverage report)",
    );
    assert.equal(send.file, "src/client.ts");
    assert.equal(send.line, 3);
    assert.equal(send.fixHint, "add a test that imports src/client.ts and exercises send");
    const gaps = criticalCoverageGaps(options(root, report));
    assert.deepEqual(gaps.map((gap) => gap.measured), [false, false]);
    assert.match(gaps[0]?.reason ?? "", /never loaded src\/client\.ts/u);
  });

  it("keeps the measured file measured when another is missing from a partial report", () => {
    const root = project({
      ".kragg/criticality.json": JSON.stringify([
        { name: "src/client#Client.send", fan_in: 9, is_critical: true },
        { name: "src/b#other", fan_in: 4, is_critical: true },
      ]),
      "src/client.ts": SOURCE,
      "src/b.ts": "export function other(): number {\n  return 1;\n}\n",
    });
    const report = coverageEntry(root, [[3, 1]], [["send", 3, 3, 1]]);
    const violations = violationsFor(root, report);
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.code, CRITICAL_UNMEASURED_CODE);
    assert.equal(violations[0]?.file, "src/b.ts");
    assert.equal(violations[0]?.line, 1);
    assert.deepEqual(
      criticalCoverageGaps(options(root, report)).map((gap) => [gap.qualname, gap.measured]),
      [["src/client#Client.send", true], ["src/b#other", false]],
    );
  });

  it("reports a function whose body neither the report nor the source can bound", () => {
    // The tracefile form states no end line, and the source binds `send`
    // twice at the same qualification (a duplicate implementation — a type
    // error, but it parses), so no extent can be attributed. The function
    // WAS entered, so "never ran" cannot be stated either. Nothing was
    // checked, and the gate says so instead of passing.
    const root = project({
      ".kragg/criticality.json": JSON.stringify([
        { name: "src/client#send", fan_in: 9, is_critical: true },
      ]),
      "src/client.ts": "export function send(): void {\n  run();\n}\nfunction send(): void {}\n",
    });
    assert.equal(functionSpans(join(root, "src/client.ts"), root, ts).get("send")?.length, 2);
    const lcov = ["SF:src/client.ts", "FN:1,send", "FNDA:2,send", "DA:2,2", "end_of_record", ""].join("\n");
    const outcome = checkCriticalCoverage({ root, sourcePaths: ["src"], report: null, lcov, api: ts });
    assert.ok(outcome.ok && !outcome.skipped);
    assert.equal(outcome.violations.length, 1);
    assert.equal(outcome.violations[0]?.code, CRITICAL_UNMEASURED_CODE);
    assert.match(outcome.violations[0]?.message ?? "", /entered 2 times, but neither the source nor the tracefile/u);
  });

  it("exempts a private critical function", () => {
    const root = measuredProject();
    const report = coverageEntry(root, [[3, 1], [4, 1], [7, 0]], [["send", 3, 3, 1], ["retry", 4, 4, 1], ["_internal", 7, 7, 0]]);
    assert.deepEqual(violationsFor(root, report), []);
  });

  it("exempts a function that is not marked critical", () => {
    const root = measuredProject();
    const report = coverageEntry(root, [[3, 1], [4, 1], [5, 0]], [["send", 3, 3, 1], ["retry", 4, 4, 1], ["idle", 5, 5, 0]]);
    assert.deepEqual(violationsFor(root, report), []);
  });

  it("drops an entry whose module is not under the source paths", () => {
    const root = project({
      ".kragg/criticality.json": JSON.stringify([
        { name: "deleted/gone#run", fan_in: 9, is_critical: true },
      ]),
      "src/client.ts": SOURCE,
    });
    assert.deepEqual(violationsFor(root, coverageEntry(root, [[3, 1]], [["send", 3, 3, 1]])), []);
  });
});

describe("critical-coverage: attribution", () => {
  it("blames each same-named method only for its own lines", () => {
    const root = project({
      ".kragg/criticality.json": JSON.stringify([
        { name: "src/client#Reader.close", fan_in: 5, is_critical: true },
        { name: "src/client#Writer.close", fan_in: 3, is_critical: true },
      ]),
      "src/client.ts": [
        "export class Reader {", //  1
        "  close(): void {", //      2
        "    this.open = false;", // 3
        "  }", //                    4
        "}", //                      5
        "export class Writer {", //  6
        "  close(): void {", //      7
        "    this.flush();", //      8
        "  }", //                    9
        "}", //                      10
        "",
      ].join("\n"),
    });
    // Both records are `close`; the report cannot tell them apart. The source can.
    const report = coverageEntry(
      root,
      [[3, 4], [8, 0]],
      [["close", 2, 4, 4], ["close", 7, 9, 0]],
    );
    const violations = violationsFor(root, report);
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.message, "critical function src/client#Writer.close has 1 uncovered lines");
    assert.equal(violations[0]?.line, 8);
    const gaps = criticalCoverageGaps(options(root, report));
    assert.deepEqual(
      gaps.map((gap) => [gap.qualname, gap.measured, gap.missingLines]),
      [["src/client#Reader.close", true, []], ["src/client#Writer.close", true, [8]]],
    );
  });

  it("measures an arrow bound to a const, and never by its anonymous callback", () => {
    const root = project({
      ".kragg/criticality.json": JSON.stringify([
        { name: "src/client#send", fan_in: 9, is_critical: true },
      ]),
      "src/client.ts": "export const send = (xs: number[]): number[] =>\n  xs.map((x) => x + 1);\n",
    });
    // `send` ran; the callback never did (empty input). That is not a gap in `send`.
    const clean = coverageEntry(root, [[2, 1]], [["send", 1, 2, 1], ["(anonymous_1)", 2, 2, 0]]);
    assert.deepEqual(violationsFor(root, clean), []);
    // And a `send` no test ever called is a gap, with no statement line to show for it.
    const untested = coverageEntry(root, [], [["send", 1, 2, 0], ["(anonymous_1)", 2, 2, 0]]);
    const violations = violationsFor(root, untested);
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.code, CRITICAL_COVERAGE_CODE);
    assert.equal(violations[0]?.line, 1);
  });

  it("does not mistake overload signatures for a name bound twice", () => {
    const source = [
      "export function parse(value: string): string;", // 1
      "export function parse(value: number): number;", // 2
      "export function parse(value: unknown): unknown {", // 3
      "  if (typeof value === 'string') {", // 4
      "    return value.trim();", // 5
      "  }", // 6
      "  return value;", // 7
      "}", // 8
      "",
    ].join("\n");
    const root = project({
      ".kragg/criticality.json": JSON.stringify([
        { name: "src/client#parse", fan_in: 6, is_critical: true },
      ]),
      "src/client.ts": source,
    });
    assert.equal(functionSpans(join(root, "src/client.ts"), root, ts).get("parse")?.length, 1);
    // lcov: the tracefile states no extent, so the source's is the one used.
    const lcov = ["SF:src/client.ts", "FN:3,parse", "FNDA:2,parse", "DA:4,2", "DA:5,0", "DA:7,2", "end_of_record", ""].join("\n");
    const outcome = checkCriticalCoverage({ root, sourcePaths: ["src"], report: null, lcov, api: ts });
    assert.ok(outcome.ok && !outcome.skipped);
    assert.equal(outcome.violations.length, 1);
    assert.equal(outcome.violations[0]?.code, CRITICAL_COVERAGE_CODE);
    assert.equal(outcome.violations[0]?.line, 5);
  });

  it("measures a class node by its own lines, never by its members'", () => {
    // `new Job()` on a class without a constructor points at the CLASS node.
    const root = project({
      ".kragg/criticality.json": JSON.stringify([
        { name: "src/client#Job", fan_in: 3, is_critical: true },
        { name: "src/client#Job.run", fan_in: 2, is_critical: true },
      ]),
      "src/client.ts": [
        "export class Job {", //             1
        '  readonly name = "job";', //        2
        "  run(): void {", //                 3
        '    throw new Error("x");', //       4
        "  }", //                             5
        "}", //                               6
        "",
      ].join("\n"),
    });
    // The class was constructed (its field initializer ran); `run` never was.
    const report = coverageEntry(root, [[2, 3], [4, 0]], [["run", 3, 5, 0]]);
    const violations = violationsFor(root, report);
    assert.deepEqual(
      violations.map((violation) => [violation.message, violation.line]),
      [["critical function src/client#Job.run has 1 uncovered lines", 4]],
    );
    // And a class nothing ever constructed: V8 records its field initializer
    // as a function inside the class's own lines, with zero hits.
    const never = coverageEntry(root, [[4, 0]], [["<instance_members_initializer>", 2, 2, 0], ["run", 3, 5, 0]]);
    assert.deepEqual(
      violationsFor(root, never).map((violation) => [violation.message, violation.line]),
      [
        ["critical function src/client#Job has 1 uncovered lines", 1],
        ["critical function src/client#Job.run has 1 uncovered lines", 4],
      ],
    );
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

  it("builds one model from either document, and none from neither", () => {
    const root = measuredProject();
    assert.equal(coverageModel(options(root, null)), null);
    assert.equal(coverageModel({ ...options(root, null), lcov: "" }), null);
    const fromIstanbul = coverageModel(options(root, coverageEntry(root, [[3, 1]], [["send", 3, 3, 1]])));
    assert.deepEqual([...(fromIstanbul?.files.keys() ?? [])], ["src/client.ts"]);
    const fromLcov = coverageModel({
      ...options(root, null),
      lcov: "SF:src/client.ts\nDA:3,1\nend_of_record\n",
    });
    assert.deepEqual(fromLcov?.files.get("src/client.ts")?.coveredLines, [3]);
  });

  it("errors — not a pass, not a wall of findings — on a report naming no files", () => {
    const outcome = checkCriticalCoverage(options(measuredProject(), {}));
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? "" : outcome.message, /names no files/u);
    assert.match(outcome.ok ? "" : outcome.message, /every file under src/u);
  });

  it("errors on a report whose files all lie outside the source paths", () => {
    const outcome = checkCriticalCoverage(
      options(measuredProject(), { "/elsewhere/other.ts": fileEntry([[1, 1]], []) }),
    );
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? "" : outcome.message, /names 1 files but none under src/u);
    assert.match(outcome.ok ? "" : outcome.message, /first: \/elsewhere\/other\.ts/u);
  });
});
