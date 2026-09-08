/**
 * Tests for the cyclomatic-complexity and maintainability-index gates.
 *
 * Uses Node's built-in `node:test` + `node:assert/strict` — no test framework
 * dependency (see docs/dependency-policy.md).
 *
 * Two kinds of assertion carry the weight here. Complexity is checked against
 * snippets whose score a reader can count by hand — straight-line code is 1,
 * one `if` is 2 — including the constructs that must NOT count, since a gate
 * that over-counts `else` is indistinguishable from one that is merely
 * strict. The MI numbers are checked against values produced by radon's own
 * `mi_compute`, so a drift in the formula fails the suite instead of quietly
 * re-grading every file in the repo.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type ts from "typescript";

import { resolveTypeScript, type TypeScriptApi } from "../src/analysis/sourceFile.ts";
import {
  CC_MAX_GRADE,
  ccExceeds,
  ccRank,
  cyclomaticViolations,
  fileComplexity,
  fileMaintainability,
  lineMetrics,
  logicalLines,
  maintainabilityIndex,
  maintainabilityViolations,
  miExceeds,
  miRank,
  MI_MIN_GRADE,
} from "../src/gates/complexity.ts";

const repoRoot = new URL("..", import.meta.url).pathname;
const api: TypeScriptApi = resolveTypeScript(repoRoot).api;

const temporaryRoots: string[] = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function parse(code: string): ts.SourceFile {
  return api.createSourceFile("snippet.ts", code, api.ScriptTarget.Latest, true, api.ScriptKind.TS);
}

/** The complexity of the single block in a snippet. */
function complexityOf(body: string, name = "f"): number {
  const blocks = fileComplexity(parse(body), api).blocks;
  const found = blocks.find((block) => block.name === name);
  assert.ok(found !== undefined, `expected a block named ${name} in: ${body}`);
  return found.complexity;
}

function close(actual: number, expected: number, message: string): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${message}: expected ${expected}, got ${actual}`,
  );
}

describe("ccRank", () => {
  it("uses radon's bands", () => {
    const bands: readonly (readonly [number, string])[] = [
      [1, "A"],
      [5, "A"],
      [6, "B"],
      [10, "B"],
      [11, "C"],
      [20, "C"],
      [21, "D"],
      [30, "D"],
      [31, "E"],
      [40, "E"],
      [41, "F"],
      [400, "F"],
    ];
    for (const [score, grade] of bands) {
      assert.equal(ccRank(score), grade, `score ${score}`);
    }
  });

  it("orders grades so C is worse than the B ceiling", () => {
    assert.equal(CC_MAX_GRADE, "B");
    assert.equal(ccExceeds("B", CC_MAX_GRADE), false);
    assert.equal(ccExceeds("C", CC_MAX_GRADE), true);
    assert.equal(ccExceeds("F", CC_MAX_GRADE), true);
  });
});

describe("miRank / miExceeds", () => {
  it("uses radon's mi_rank bands", () => {
    const bands: readonly (readonly [number, string])[] = [
      [100, "A"],
      [19.01, "A"],
      [19, "B"],
      [9.01, "B"],
      [9, "C"],
      [0, "C"],
    ];
    for (const [score, grade] of bands) {
      assert.equal(miRank(score), grade, `score ${score}`);
    }
  });

  it("orders grades so B and C are worse than the A floor, and a grade never exceeds itself", () => {
    assert.equal(MI_MIN_GRADE, "A");
    assert.equal(miExceeds("A", MI_MIN_GRADE), false);
    assert.equal(miExceeds("B", MI_MIN_GRADE), true);
    assert.equal(miExceeds("C", MI_MIN_GRADE), true);
    assert.equal(miExceeds("B", "B"), false);
    assert.equal(miExceeds("C", "B"), true);
    assert.equal(miExceeds("A", "C"), false);
  });
});

describe("cyclomatic complexity", () => {
  it("scores straight-line code as 1", () => {
    assert.equal(complexityOf("function f(a: number) { const b = a + 1; return b; }"), 1);
  });

  it("adds one per decision point", () => {
    const cases: readonly (readonly [string, number])[] = [
      ["function f(a: number) { if (a) { return 1; } return 0; }", 2],
      ["function f(a: number) { if (a) { return 1; } else { return 0; } }", 2],
      ["function f(a: number) { if (a) { return 1; } else if (a > 1) { return 2; } return 0; }", 3],
      ["function f(a: number[]) { for (const x of a) { void x; } }", 2],
      ["function f(a: number[]) { for (const x in a) { void x; } }", 2],
      ["function f(a: number) { for (let i = 0; i < a; i += 1) { void i; } }", 2],
      ["function f(a: number) { while (a > 0) { a -= 1; } }", 2],
      ["function f(a: number) { do { a -= 1; } while (a > 0); }", 2],
      ["function f(a: number) { return a ? 1 : 0; }", 2],
      ["function f(a: number, b: number) { return a && b; }", 2],
      ["function f(a: number, b: number) { return a || b; }", 2],
      ["function f(a: number, b: number) { return a ?? b; }", 2],
      ["function f(a: number, b: number, c: number) { return (a && b) || c; }", 3],
      ["function f(a: { b?: { c?: number } }) { return a.b?.c; }", 2],
      ["function f(a: { b?: () => number }) { return a.b?.(); }", 2],
      ["function f(a: number) { try { return a; } catch { return 0; } }", 2],
      ["function f(a: number) { try { return a; } catch { return 0; } finally { void a; } }", 2],
      // A `switch` counts ONCE, not once per `case` — a deliberate divergence
      // from McCabe/radon/the Python sibling. See `decisionPoints`.
      ["function f(a: number) { switch (a) { case 1: return 1; case 2: return 2; } return 0; }", 2],
      ["function f(a: number) { switch (a) { case 1: return 1; default: return 0; } }", 2],
    ];
    for (const [code, expected] of cases) {
      assert.equal(complexityOf(code), expected, code);
    }
  });

  it("scores a switch by its presence, not its breadth", () => {
    // The property the divergence exists to buy: a flat dispatch table costs
    // the same whether it has 2 arms or 25. Adding a case adds no interaction
    // a reader has to hold in their head, so it adds no complexity here.
    // Breadth is bounded by the `structure` gate's budgets, not by this one.
    const arms = (n: number): string =>
      Array.from({ length: n }, (_, i) => `case ${String(i)}: return ${String(i)};`).join(" ");
    const two = complexityOf(`function f(a: number) { switch (a) { ${arms(2)} } return -1; }`);
    const many = complexityOf(`function f(a: number) { switch (a) { ${arms(25)} } return -1; }`);
    assert.equal(two, 2);
    assert.equal(many, two);
  });

  it("still counts decisions nested inside a switch arm", () => {
    // Flattening the dispatch must not hide real branching inside an arm.
    const code =
      "function f(a: number, b: number) { switch (a) { case 1: return b > 0 ? 1 : 2; case 2: return b && a; } return 0; }";
    assert.equal(complexityOf(code), 4); // 1 base + 1 switch + 1 ternary + 1 &&
  });

  it("counts logical assignment operators, which short-circuit", () => {
    assert.equal(complexityOf("function f(a: { b: number }) { a.b ||= 1; a.b ??= 2; return a; }"), 3);
  });

  it("keeps a nested function's decisions out of its parent", () => {
    // Radon does exactly this: a closure's complexity belongs to the closure.
    const code =
      "function outer(a: number) {" +
      "  const inner = (b: number) => (b > 1 ? (b > 2 ? 2 : 1) : 0);" +
      "  if (a) { return inner(a); }" +
      "  return 0;" +
      "}";
    assert.equal(complexityOf(code, "outer"), 2);
    assert.equal(complexityOf(code, "outer.inner"), 3);
  });

  it("grades methods and arrows as blocks of their own", () => {
    const code = [
      "class Widget {",
      "  render(a: number): number { return a ? 1 : 0; }",
      "}",
      "const pick = (a: number): number => (a ? 1 : 0);",
    ].join("\n");
    const blocks = fileComplexity(parse(code), api).blocks;
    assert.deepEqual(
      blocks.map((block) => `${block.name}=${block.complexity}`),
      ["Widget.render=2", "pick=2"],
    );
    assert.equal(blocks[0]?.line, 2);
  });

  it("folds top-level decisions into the file total but grades no block for them", () => {
    const report = fileComplexity(parse("if (globalThis) { console.log(1); }"), api);
    assert.deepEqual(report.blocks, []);
    assert.equal(report.total, 2, "1 + one top-level if");
  });

  it("totals every decision point in the file, nested ones included", () => {
    const code = "function f(a: number) { if (a) { return () => (a ? 1 : 0); } return null; }";
    assert.equal(fileComplexity(parse(code), api).total, 3, "1 + if + ternary");
  });
});

describe("cyclomaticViolations", () => {
  it("flags a block graded C with the Python message and code", () => {
    const root = temporaryProject({
      "noisy.ts": [
        "export function noisy(a: number): number {",
        ...Array.from({ length: 12 }, (_, index) => `  if (a === ${index}) { return ${index}; }`),
        "  return -1;",
        "}",
      ].join("\n"),
      "calm.ts": "export const calm = (a: number): number => a + 1;\n",
    });

    const violations = cyclomaticViolations(root, ["src"], { api });
    assert.equal(violations.length, 1);
    const violation = violations[0];
    assert.ok(violation !== undefined);
    assert.equal(violation.message, "noisy has cyclomatic complexity grade C (max allowed: B)");
    assert.equal(violation.file, "src/noisy.ts");
    assert.equal(violation.line, 1);
    assert.equal(violation.code, "CC-C");
    assert.equal(violation.fixHint, "split into smaller functions or use early returns");
    assert.equal(violation.column, undefined, "the Python side reports no column");
  });
});

describe("maintainabilityIndex", () => {
  it("matches radon's mi_compute", () => {
    // Reference values from radon 6.x:
    //   mi_compute(100, 5, 20, 0)         -> 56.94283754461242
    //   mi_compute(8, 1, 1, 0)            -> 93.54204911302038
    //   mi_compute(1000, 20, 150, 25.0)   -> 53.992400928658135
    //   mi_compute(4000, 60, 300, 50.0)   -> 41.74915747636664
    close(maintainabilityIndex(100, 5, 20, 0), 56.94283754461242, "mi(100,5,20,0)");
    close(maintainabilityIndex(8, 1, 1, 0), 93.54204911302038, "mi(8,1,1,0)");
    close(maintainabilityIndex(1000, 20, 150, 25), 53.992400928658135, "mi(1000,20,150,25)");
    close(maintainabilityIndex(4000, 60, 300, 50), 41.74915747636664, "mi(4000,60,300,50)");
  });

  it("returns 100 when there is nothing to maintain", () => {
    assert.equal(maintainabilityIndex(0, 1, 10, 0), 100);
    assert.equal(maintainabilityIndex(100, 1, 0, 0), 100);
  });

  it("credits comments, up to a point", () => {
    const none = maintainabilityIndex(1000, 20, 150, 0);
    const some = maintainabilityIndex(1000, 20, 150, 25);
    assert.ok(some > none, "comments must raise the index");
  });

  it("ranks with radon's bands", () => {
    assert.equal(miRank(19.0001), "A");
    assert.equal(miRank(19), "B");
    assert.equal(miRank(9.0001), "B");
    assert.equal(miRank(9), "C");
    assert.equal(MI_MIN_GRADE, "A");
  });
});

describe("line accounting", () => {
  it("separates code, comment and blank lines", () => {
    const code = [
      "// a leading comment",
      "const a = 1;",
      "",
      "/* block",
      "   comment */",
      "const b = a; // trailing",
      "const url = 'https://example.com'; // not a comment inside the string",
    ].join("\n");
    const metrics = lineMetrics(parse(code), api);
    assert.equal(metrics.loc, 7);
    assert.equal(metrics.sloc, 3, "three lines carry code");
    assert.equal(metrics.commentLines, 5, "one leading, two block, two trailing");
    assert.equal(metrics.blank, 1);
  });

  it("does not mistake a comment inside a string for a comment", () => {
    const metrics = lineMetrics(parse('const s = "// not a comment";\n'), api);
    assert.equal(metrics.commentLines, 0);
    assert.equal(metrics.sloc, 1);
  });

  it("counts one logical line per statement and per declaration header", () => {
    // 1 import + 1 function header + 1 if + 1 return + 1 return = 5.
    const code = [
      'import { join } from "node:path";',
      "function f(a: number): number {",
      "  if (a) { return 1; }",
      "  return join(0, 0);",
      "}",
    ].join("\n");
    assert.equal(logicalLines(parse(code), api), 5);
  });

  it("counts a multi-declarator statement once", () => {
    assert.equal(logicalLines(parse("const a = 1, b = 2;\n"), api), 1);
  });
});

describe("fileMaintainability", () => {
  it("grades a small, commented file as A", () => {
    const report = fileMaintainability(
      parse("// double a number\nexport const twice = (x: number): number => x * 2;\n"),
      api,
    );
    assert.equal(report.grade, "A");
    assert.ok(report.mi > 19, `mi was ${report.mi}`);
    assert.equal(report.lines.sloc, 1);
    assert.equal(report.complexity, 1);
  });

  it("grades a long, dense, uncommented file below A", () => {
    const report = fileMaintainability(parse(denseModule(400)), api);
    assert.notEqual(report.grade, "A");
    assert.ok(report.mi <= 19, `mi was ${report.mi}`);
  });
});

describe("maintainabilityViolations", () => {
  it("reports one file-level violation with the Python message and code", () => {
    const root = temporaryProject({ "dense.ts": denseModule(400), "small.ts": "export const a = 1;\n" });
    const violations = maintainabilityViolations(root, ["src"], { api });
    assert.equal(violations.length, 1);
    const violation = violations[0];
    assert.ok(violation !== undefined);
    assert.equal(violation.file, "src/dense.ts");
    assert.equal(violation.message, `maintainability index grade ${violation.code?.slice(3) ?? ""} (minimum: A)`);
    assert.ok(violation.code?.startsWith("MI-"), violation.code);
    assert.equal(violation.line, undefined, "the finding is about the file, not a line");
  });
});

/** A module with many dense, uncommented statements — deliberately unpleasant. */
function denseModule(statements: number): string {
  return Array.from(
    { length: statements },
    (_, index) => `export const value${index} = base${index} + factor${index} * offset${index};`,
  ).join("\n");
}

/** Write `files` into a fresh temporary project's `src/`, and return its root. */
function temporaryProject(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-complexity-"));
  temporaryRoots.push(root);
  writeFileSync(join(root, "package.json"), "{}");
  mkdirSync(join(root, "src"));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, "src", name), contents);
  }
  return root;
}

/**
 * The blocks `fileComplexity` refuses to report.
 *
 * An overload signature and an ambient declaration are function-like nodes
 * with NO body. There is nothing in them to measure, and reporting them at
 * complexity 1 would pad the block list with entries a reader cannot act on —
 * and would make an overloaded function's real implementation harder to find
 * in the report, not easier.
 */
describe("fileComplexity / declarations with no body", () => {
  it("skips overload signatures and reports only the implementation", () => {
    const result = fileComplexity(
      parse(
        "export function pick(value: string): string;\n" +
          "export function pick(value: number): number;\n" +
          "export function pick(value: string | number): string | number {\n" +
          "  return typeof value === 'string' ? value.trim() : value;\n" +
          "}\n",
      ),
      api,
    );
    assert.deepEqual(
      result.blocks.map((block) => block.name),
      ["pick"],
    );
    const only = result.blocks[0];
    assert.ok(only !== undefined);
    assert.equal(only.line, 3, "the implementation, not the first signature");
    // One conditional expression on top of the base of 1.
    assert.equal(only.complexity, 2);
  });

  it("skips an ambient declaration and a bodyless class method", () => {
    const result = fileComplexity(
      parse(
        "declare function ambient(a: number): void;\n" +
          "declare class Remote { call(a: number): void; }\n" +
          "export function real(): number { return 1; }\n",
      ),
      api,
    );
    assert.deepEqual(
      result.blocks.map((block) => block.name),
      ["real"],
    );
  });
});
