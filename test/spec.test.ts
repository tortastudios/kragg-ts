/**
 * Tests for `kragg spec`.
 *
 * Four things have to hold:
 *
 *  - THE TREE IS THE DOCUMENT. Nesting comes from `describe` containment, not
 *    from the order calls happen to appear in, and a skipped case is marked
 *    rather than dropped — a suite that quietly hides its skips is exactly the
 *    green checkmark kragg exists to look past.
 *  - DETECTION IS NOT REIMPLEMENTED. The cases come from
 *    `gates/testDepth/testCases.ts`, so the spellings that module handles
 *    (`it.each`, `test.skip`, node:test's `{ skip: true }`) are asserted here
 *    to catch a regression in the wiring, not to re-test the detector.
 *  - ABSENT IS NOT ZERO. The property-coverage section must report
 *    "unavailable" on a project without fast-check and must never render
 *    `0/N`. That is the single most important assertion in this file; see the
 *    header of `commands/spec/property.ts` for why.
 *  - A PROJECT THAT HAS fast-check GETS A REAL MEASUREMENT, including the
 *    `test.prop` binding whose arbitraries never appear in the test body.
 *
 * fast-check is NOT installed to run these — kragg does not depend on it. The
 * fixtures declare it in a temporary `package.json` and write the idioms as
 * source text, which is exactly what the detector reads.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import ts from "typescript";

import { buildSpec, renderPropertyReport, renderSpec } from "../src/commands/spec.ts";
import {
  propertyCoverage,
  usesFastCheck,
  type PropertyReport,
} from "../src/commands/spec/property.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-spec-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

function specLines(files: Readonly<Record<string, string>>): string[] {
  return renderSpec(buildSpec(project(files), ["test"], ts));
}

describe("spec: the documentation tree", () => {
  it("renders nested describes as indentation and cases as bullets", () => {
    const lines = specLines({
      "test/a.test.ts": [
        'describe("outer", () => {',
        '  describe("inner", () => {',
        '    it("does the thing", () => {});',
        "  });",
        '  it("does another thing", () => {});',
        "});",
        "",
      ].join("\n"),
    });
    assert.deepEqual(lines, [
      "spec: 2 tests across 1 files",
      "test/a.test.ts",
      "  outer",
      "    inner",
      "      - does the thing",
      "    - does another thing",
    ]);
  });

  it("keeps a top-level case at the first indent level", () => {
    const lines = specLines({ "test/a.test.ts": 'it("stands alone", () => {});\n' });
    assert.deepEqual(lines, [
      "spec: 1 tests across 1 files",
      "test/a.test.ts",
      "  - stands alone",
    ]);
  });

  it("marks a skipped case rather than hiding it, and counts it", () => {
    const lines = specLines({
      "test/a.test.ts": 'it("runs", () => {});\nit.skip("does not run", () => {});\n',
    });
    assert.deepEqual(lines, [
      "spec: 2 tests across 1 files (1 skipped)",
      "test/a.test.ts",
      "  - runs",
      "  - does not run  [skip]",
    ]);
  });

  it("inherits a skip from an enclosing describe", () => {
    const lines = specLines({
      "test/a.test.ts": 'describe.skip("group", () => {\n  it("inside", () => {});\n});\n',
    });
    assert.deepEqual(lines.at(-1), "    - inside  [skip]");
  });

  it("keeps two sibling describes with the same title distinct", () => {
    const lines = specLines({
      "test/a.test.ts": [
        'describe("cases", () => {',
        '  it("first", () => {});',
        "});",
        'describe("cases", () => {',
        '  it("second", () => {});',
        "});",
        "",
      ].join("\n"),
    });
    assert.deepEqual(lines.slice(2), [
      "  cases",
      "    - first",
      "  cases",
      "    - second",
    ]);
  });

  it("drops a describe that contains no case", () => {
    const lines = specLines({
      "test/a.test.ts": 'describe("empty", () => {});\nit("real", () => {});\n',
    });
    assert.deepEqual(lines.slice(2), ["  - real"]);
  });

  it("omits a test-directory file that holds no test", () => {
    const lines = specLines({
      "test/helpers.ts": "export const fixture = 1;\n",
      "test/a.test.ts": 'it("real", () => {});\n',
    });
    assert.equal(lines[0], "spec: 1 tests across 1 files");
    assert.ok(!lines.includes("test/helpers.ts"));
  });

  it("says so when there are no tests at all", () => {
    assert.deepEqual(specLines({}), ["no tests found"]);
  });

  it("picks up the spellings testCases.ts handles", () => {
    const lines = specLines({
      "test/a.test.ts": [
        'test.each([1, 2])("each %i", () => {});',
        'test("options skip", { skip: true }, () => {});',
        'it.concurrent("concurrent", () => {});',
        "",
      ].join("\n"),
    });
    assert.deepEqual(lines, [
      "spec: 3 tests across 1 files (1 skipped)",
      "test/a.test.ts",
      "  - each %i",
      "  - options skip  [skip]",
      "  - concurrent",
    ]);
  });
});

describe("spec: property coverage is unavailable, not zero", () => {
  const CRITICALITY = JSON.stringify([
    { name: "src/a#run", fan_in: 9, is_critical: true, risk: "HIGH" },
  ]);

  it("reports unavailable when the project has no fast-check", () => {
    const root = project({
      "package.json": JSON.stringify({ name: "x", devDependencies: { vitest: "1" } }),
      "src/a.ts": "export function run(): void {}\n",
      "test/a.test.ts": 'it("calls run", () => {\n  run();\n});\n',
      ".kragg/criticality.json": CRITICALITY,
    });
    const report = propertyCoverage({
      root,
      sourcePaths: ["src"],
      testPaths: ["test"],
      api: ts,
    });
    assert.equal(report.available, false);
    const rendered = renderPropertyReport(report, 25).join("\n");
    assert.ok(rendered.startsWith("property-based coverage: unavailable —"), rendered);
    assert.ok(rendered.includes("fast-check"), rendered);
    // The whole point: no fraction is ever printed for an unmeasured project.
    assert.ok(!/\d+\/\d+/.test(rendered), rendered);
  });

  it("measures when fast-check is a declared dependency", () => {
    const root = project({
      "package.json": JSON.stringify({ name: "x", devDependencies: { "fast-check": "3" } }),
      "src/a.ts": "export function run(): void {}\nexport function other(): void {}\n",
      "test/a.test.ts": [
        'import fc from "fast-check";',
        'it("run holds for all inputs", () => {',
        "  fc.assert(fc.property(fc.string(), (value) => run(value)));",
        "});",
        "",
      ].join("\n"),
      ".kragg/criticality.json": JSON.stringify([
        { name: "src/a#run", fan_in: 9, is_critical: true, risk: "HIGH" },
        { name: "src/a#other", fan_in: 4, is_critical: true, risk: "MED" },
      ]),
    });
    const report = propertyCoverage({
      root,
      sourcePaths: ["src"],
      testPaths: ["test"],
      api: ts,
    });
    assert.equal(report.available, true);
    assert.deepEqual(
      available(report).map((row) => [row.qualname, row.hasPropertyTest]),
      [
        ["src/a#run", true],
        ["src/a#other", false],
      ],
    );
    assert.deepEqual(renderPropertyReport(report, 25), [
      "property-based coverage: 1/2 critical functions " +
        "(property tests kill more mutants than example tests)",
      "  src/a#other (fan-in 4) — only example-based",
    ]);
  });

  it("credits the @fast-check/vitest `test.prop` binding", () => {
    // The arbitraries sit on the CALLEE, so a body-only scan would miss this.
    const root = project({
      "package.json": JSON.stringify({
        name: "x",
        devDependencies: { "@fast-check/vitest": "0.1" },
      }),
      "src/a.ts": "export function run(): void {}\n",
      "test/a.test.ts": [
        'import { test, fc } from "@fast-check/vitest";',
        'test.prop([fc.string()])("run", (value) => {',
        "  run(value);",
        "});",
        "",
      ].join("\n"),
      ".kragg/criticality.json": CRITICALITY,
    });
    const report = propertyCoverage({
      root,
      sourcePaths: ["src"],
      testPaths: ["test"],
      api: ts,
    });
    assert.deepEqual(available(report).map((row) => row.hasPropertyTest), [true]);
  });

  it("measures a zero when fast-check is present but no property test is", () => {
    // Distinct from "unavailable": this project CAN be measured and scored 0.
    const root = project({
      "package.json": JSON.stringify({ name: "x", devDependencies: { "fast-check": "3" } }),
      "src/a.ts": "export function run(): void {}\n",
      "test/a.test.ts": 'it("calls run", () => {\n  run();\n});\n',
      ".kragg/criticality.json": CRITICALITY,
    });
    const report = propertyCoverage({
      root,
      sourcePaths: ["src"],
      testPaths: ["test"],
      api: ts,
    });
    assert.equal(report.available, true);
    assert.ok(
      renderPropertyReport(report, 25)[0]?.startsWith(
        "property-based coverage: 0/1 critical functions",
      ),
    );
  });

  it("does not credit a name that merely shares a prefix", () => {
    const root = project({
      "package.json": JSON.stringify({ name: "x", devDependencies: { "fast-check": "3" } }),
      "src/a.ts": "export function run(): void {}\n",
      "test/a.test.ts": [
        'import fc from "fast-check";',
        'it("runner", () => {',
        "  fc.assert(fc.property(fc.string(), (value) => runner(value)));",
        "});",
        "",
      ].join("\n"),
      ".kragg/criticality.json": CRITICALITY,
    });
    const report = propertyCoverage({
      root,
      sourcePaths: ["src"],
      testPaths: ["test"],
      api: ts,
    });
    assert.deepEqual(available(report).map((row) => row.hasPropertyTest), [false]);
  });

  it("detects an import even when the manifest does not declare it", () => {
    // A hoisted workspace dependency lives in a package.json we never read.
    const root = project({
      "package.json": JSON.stringify({ name: "x" }),
      "test/a.test.ts": 'import fc from "fast-check";\nit("x", () => {\n  fc.assert(fc.property());\n});\n',
    });
    assert.equal(usesFastCheck(root, ["test"], ts), true);
  });

  it("does not mistake a quoted mention of the idiom for a dependency", () => {
    // Caught by dogfooding against kragg-ts itself, whose own test fixtures
    // write `fc.assert(` inside string literals. A text scan concluded the
    // repo used fast-check and printed a fabricated score.
    const root = project({
      "package.json": JSON.stringify({ name: "x" }),
      "test/a.test.ts":
        'it("writes a fixture", () => {\n  const source = "fc.assert(fc.property());";\n  void source;\n});\n',
    });
    assert.equal(usesFastCheck(root, ["test"], ts), false);
  });

  it("reports missing criticality data separately from missing fast-check", () => {
    const root = project({
      "package.json": JSON.stringify({ name: "x", devDependencies: { "fast-check": "3" } }),
      "src/a.ts": "export function run(): void {}\n",
      "test/a.test.ts": 'import fc from "fast-check";\nit("x", () => {\n  fc.assert(fc.property());\n});\n',
    });
    const report = propertyCoverage({
      root,
      sourcePaths: ["src"],
      testPaths: ["test"],
      api: ts,
    });
    assert.deepEqual(renderPropertyReport(report, 25), [
      "property-based coverage: no critical functions (run `kragg criticality --write`)",
    ]);
  });

  it("caps the gap list and says how many were withheld", () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      qualname: `src/a#fn${index}`,
      fanIn: 10 - index,
      hasPropertyTest: false,
    }));
    const lines = renderPropertyReport({ available: true, rows }, 2);
    assert.deepEqual(lines.slice(1), [
      "  src/a#fn0 (fan-in 10) — only example-based",
      "  src/a#fn1 (fan-in 9) — only example-based",
      "  +3 more, ranked by fan-in",
    ]);
  });
});

/** Narrow an available report, failing the test rather than silently passing. */
function available(
  report: PropertyReport,
): readonly { readonly qualname: string; readonly fanIn: number; readonly hasPropertyTest: boolean }[] {
  assert.ok(report.available, "expected a measurable project");
  return report.rows;
}
