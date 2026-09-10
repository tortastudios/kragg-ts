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

import {
  buildSpec,
  renderPropertyReport,
  renderSpec,
  runSpec,
  type SpecOptions,
} from "../src/commands/spec.ts";
import {
  propertyCoverage,
  usesFastCheck,
  type PropertyReport,
} from "../src/commands/spec/property.ts";
import { DEFAULT_POLICY, type KraggPolicy } from "../src/policy/policy.ts";

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

const POLICY: KraggPolicy = { ...DEFAULT_POLICY, sourcePaths: ["src"], testPaths: ["test"] };

/** Exit code plus both streams from one in-process `runSpec`. */
interface SpecRun {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/**
 * Run `runSpec` with both streams captured.
 *
 * In-process: these cases are about the document, and `test/cli.test.ts`
 * drives the same flags through a real process for the exit codes.
 */
async function runSpecCapturing(options: SpecOptions): Promise<SpecRun> {
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    out.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    err.push(String(chunk));
    return true;
  };
  try {
    const code = await runSpec({ policy: POLICY, api: ts, ...options });
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
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

  it("credits a property test that names the function only in its title", () => {
    // The documented limit of the static signal: attribution is a word-bounded
    // name occurrence in the property test's TEXT, so a title suffices and no
    // call is required. `hasPropertyTest` therefore reads "a property test
    // names this function", never "a property exercises it" — the gates use
    // checker-bound references for that (see `testDepth/references.ts`).
    const root = project({
      "package.json": JSON.stringify({ name: "x", devDependencies: { "fast-check": "3" } }),
      "src/a.ts": "export function run(): void {}\nexport function other(): void {}\n",
      "test/a.test.ts": [
        'import fc from "fast-check";',
        'it("run: holds for every string", () => {',
        "  fc.assert(fc.property(fc.string(), (value) => other(value)));",
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

/**
 * Filters and the output budget.
 *
 * `spec` said outright that nothing here was capped, and on this repository
 * that came to 1,335 cases and ~86,000 characters — a document whose only
 * possible reader is one who never opens it. The cases below pin the three
 * properties that make a smaller answer safe: the header counts the
 * SELECTION, a trimmed tree says so on its own line, and an empty selection
 * is a sentence rather than a suite that looks like it has no tests.
 */
describe("spec: filters and the output budget", () => {
  const FILES: Readonly<Record<string, string>> = {
    "test/a.test.ts": [
      'describe("widgets", () => {',
      '  it("keeps the widget", () => {});',
      '  it("drops the widget", () => {});',
      "});",
      'it("unrelated", () => {});',
      "",
    ].join("\n"),
    "test/nested/b.test.ts": 'it.skip("lonely", () => {});\n',
  };

  /** Just the spec tree, without the always-present property section. */
  function tree(out: string): string[] {
    return out
      .trimEnd()
      .split("\n")
      .filter((line) => !line.startsWith("property-based coverage:"));
  }

  it("selects by --path, by directory or by file", async () => {
    const root = project(FILES);
    for (const path of ["test/nested", "test/nested/b.test.ts"]) {
      const result = await runSpecCapturing({ root, limit: 0, paths: [path] });
      assert.equal(result.code, 0, path);
      assert.deepEqual(
        tree(result.out),
        [
          "spec: 1 tests across 1 files (1 skipped)",
          "test/nested/b.test.ts",
          "  - lonely  [skip]",
        ],
        path,
      );
    }
  });

  it("matches --symbol as a case-insensitive substring of a case title", async () => {
    const root = project(FILES);
    const result = await runSpecCapturing({ root, limit: 0, symbols: ["KEEPS THE"] });
    assert.deepEqual(tree(result.out), [
      "spec: 1 tests across 1 files",
      "test/a.test.ts",
      "  widgets",
      "    - keeps the widget",
    ]);
  });

  it("matches --symbol against an enclosing describe, so a group comes back whole", async () => {
    const root = project(FILES);
    const result = await runSpecCapturing({ root, limit: 0, symbols: ["widgets"] });
    // Both cases inside `describe("widgets")`, and not the top-level one.
    assert.deepEqual(tree(result.out), [
      "spec: 2 tests across 1 files",
      "test/a.test.ts",
      "  widgets",
      "    - keeps the widget",
      "    - drops the widget",
    ]);
  });

  it("says nothing matched, and exits 0, without claiming the suite is empty", async () => {
    const root = project(FILES);
    const result = await runSpecCapturing({ root, symbols: ["nosuchtest"] });
    assert.equal(result.code, 0);
    assert.deepEqual(tree(result.out), ["no tests match the selection"]);
    // A project with no tests at all is a different sentence.
    assert.deepEqual(tree((await runSpecCapturing({ root: project({}) })).out), ["no tests found"]);
  });

  it("counts the selection in the header and names what it withheld", async () => {
    const root = project(FILES);
    const result = await runSpecCapturing({ root, limit: 1 });
    assert.deepEqual(tree(result.out), [
      "spec: 4 tests across 2 files (1 skipped)",
      "test/a.test.ts",
      "  widgets",
      "    - keeps the widget",
      "showing 1 of 4 tests — pass --limit 0 for everything",
    ]);
  });

  it("keeps the JSON entry order identical to the text order, run after run", async () => {
    const root = project(FILES);
    const text = await runSpecCapturing({ root, limit: 0 });
    const json = await runSpecCapturing({ root, limit: 0, format: "json" });
    const parsed = JSON.parse(json.out) as { entries: { file: string; title: string }[] };
    assert.deepEqual(
      parsed.entries.map((entry) => `${entry.file}: ${entry.title}`),
      [
        "test/a.test.ts: keeps the widget",
        "test/a.test.ts: drops the widget",
        "test/a.test.ts: unrelated",
        "test/nested/b.test.ts: lonely",
      ],
    );
    assert.equal((await runSpecCapturing({ root, limit: 0 })).out, text.out);
  });

  it("carries the totals, the suites and the property summary in JSON", async () => {
    const root = project(FILES);
    const result = await runSpecCapturing({ root, limit: 2, format: "json" });
    const parsed = JSON.parse(result.out) as {
      command: string;
      total: number;
      shown: number;
      truncated: boolean;
      files: number;
      skipped: number;
      entries: { suites: string[]; title: string; line: number; skipped: boolean }[];
      property: { available: boolean; reason: string };
    };
    assert.equal(parsed.command, "spec");
    assert.equal(parsed.total, 4);
    assert.equal(parsed.shown, 2);
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.files, 2);
    assert.equal(parsed.skipped, 1);
    assert.deepEqual(parsed.entries[0]?.suites, ["widgets"]);
    assert.equal(parsed.entries[0]?.line, 2);
    // Unavailable keeps its reason and reports no counts: absent is not zero.
    assert.equal(parsed.property.available, false);
    assert.match(parsed.property.reason, /fast-check/);
  });

  it("still answers in JSON when the selection is empty", async () => {
    const result = await runSpecCapturing({
      root: project(FILES),
      format: "json",
      symbols: ["nosuchtest"],
    });
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.out) as { total: number; shown: number; entries: unknown[] };
    assert.equal(parsed.total, 0);
    assert.equal(parsed.shown, 0);
    assert.deepEqual(parsed.entries, []);
  });
});
