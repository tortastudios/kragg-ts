/**
 * Tests for the Halstead gate.
 *
 * Uses Node's built-in `node:test` + `node:assert/strict` — no test framework
 * dependency (see docs/dependency-policy.md).
 *
 * The metrics are asserted on HAND-COMPUTED examples, not on golden values
 * captured from the implementation. A Halstead gate that silently drifts in
 * what it counts still produces plausible-looking numbers, so the only useful
 * assertion is one a human derived independently: `return a + b` has exactly
 * two operators and two operands, and everything downstream follows from
 * that.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type ts from "typescript";

import {
  resolveTypeScript,
  type ParsedSource,
  type TypeScriptApi,
} from "../src/analysis/sourceFile.ts";
import {
  checkSource,
  fileHalstead,
  formatHalsteadFailure,
  functionBlockLabel,
  halsteadMetrics,
  halsteadViolations,
  isFunctionBlock,
  MAX_BUGS,
  MAX_DIFFICULTY,
  MAX_EFFORT,
  type HalsteadBlock,
} from "../src/gates/halstead.ts";

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

function blocks(code: string): readonly HalsteadBlock[] {
  return fileHalstead(parse(code), api).functions;
}

function block(code: string, name: string): HalsteadBlock {
  const found = blocks(code).find((candidate) => candidate.name === name);
  assert.ok(found !== undefined, `expected a block named ${name}`);
  return found;
}

/** Two floats are equal to within floating-point noise. */
function close(actual: number, expected: number, message: string): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${message}: expected ${expected}, got ${actual}`,
  );
}

describe("halsteadMetrics", () => {
  it("derives every metric from the raw counts", () => {
    // n1 = n2 = N1 = N2 = 2 -> vocabulary 4, length 4, volume 4*log2(4) = 8.
    const metrics = halsteadMetrics({
      distinctOperators: 2,
      distinctOperands: 2,
      totalOperators: 2,
      totalOperands: 2,
    });
    assert.equal(metrics.vocabulary, 4);
    assert.equal(metrics.length, 4);
    close(metrics.calculatedLength, 4, "calculated length");
    close(metrics.volume, 8, "volume");
    close(metrics.difficulty, 1, "difficulty");
    close(metrics.effort, 8, "effort");
    close(metrics.time, 8 / 18, "time");
    close(metrics.bugs, 8 / 3000, "bugs");
  });

  it("does not divide by zero on an empty block", () => {
    const metrics = halsteadMetrics({
      distinctOperators: 0,
      distinctOperands: 0,
      totalOperators: 0,
      totalOperands: 0,
    });
    assert.equal(metrics.volume, 0);
    assert.equal(metrics.difficulty, 0);
    assert.equal(metrics.effort, 0);
  });
});

describe("fileHalstead", () => {
  it("counts a hand-computed function exactly", () => {
    // Body is `return a + b`: operators {return, +}, operands {a, b}.
    // Type annotations must contribute NOTHING, which is what makes this
    // assertion exact rather than approximate.
    const measured = block("function add(a: number, b: number): number { return a + b; }", "add");
    assert.equal(measured.metrics.distinctOperators, 2);
    assert.equal(measured.metrics.distinctOperands, 2);
    assert.equal(measured.metrics.totalOperators, 2);
    assert.equal(measured.metrics.totalOperands, 2);
    close(measured.metrics.volume, 8, "volume");
    close(measured.metrics.difficulty, 1, "difficulty");
    close(measured.metrics.effort, 8, "effort");
    assert.equal(measured.line, 1);
  });

  it("counts an arrow body and the file around it", () => {
    // Block `twice` sees only `x * 2`: operators {*}, operands {x, 2}.
    const code = "const twice = (x: number): number => x * 2;\n";
    const measured = block(code, "twice");
    assert.equal(measured.metrics.distinctOperators, 1);
    assert.equal(measured.metrics.distinctOperands, 2);
    close(measured.metrics.volume, 3 * Math.log2(3), "block volume");
    close(measured.metrics.difficulty, 0.5, "block difficulty");

    // The file adds `const`, `=` and the operand `twice`. Parameters and the
    // `=>` itself are excluded, matching radon's body-only accounting.
    const total = fileHalstead(parse(code), api).total;
    assert.equal(total.distinctOperators, 3);
    assert.equal(total.distinctOperands, 3);
    assert.equal(total.totalOperators, 3);
    assert.equal(total.totalOperands, 3);
  });

  it("repeats raise the totals but not the distinct counts", () => {
    const measured = block("function f(a: number) { return a + a + a; }", "f");
    assert.equal(measured.metrics.distinctOperators, 2, "return and +");
    assert.equal(measured.metrics.totalOperators, 3, "return and two +");
    assert.equal(measured.metrics.distinctOperands, 1, "just a");
    assert.equal(measured.metrics.totalOperands, 3, "a three times");
  });

  it("ignores type-only syntax entirely", () => {
    const total = fileHalstead(
      parse(
        [
          'import type { A } from "./a.ts";',
          "interface Shape { readonly kind: string; }",
          "type Alias = Shape | null;",
        ].join("\n"),
      ),
      api,
    ).total;
    assert.equal(total.totalOperators, 0);
    assert.equal(total.totalOperands, 0);
    assert.equal(total.volume, 0);
  });

  it("counts a nested function inside its parent, and reports it separately", () => {
    // Radon's HalsteadVisitor recurses into nested definitions, so the outer
    // block's counts include the inner body. The inner block is reported too,
    // which radon does not do — see the doc comment on `fileHalstead`.
    const code = "function outer() { const inner = (x: number) => x * 2; return inner(1); }";
    const outer = block(code, "outer");
    const inner = block(code, "outer.inner");
    assert.equal(inner.metrics.distinctOperators, 1, "just *");
    assert.ok(
      outer.metrics.totalOperators > inner.metrics.totalOperators,
      "the parent must include the child's operators",
    );
  });

  it("names methods, accessors, bindings and callbacks", () => {
    const code = [
      "class Widget {",
      "  render(): string { return this.label; }",
      "  get label(): string { return 'x'; }",
      "  constructor() { this.n = 1; }",
      "}",
      "const doubled = [1].map((n) => n + 1);",
    ].join("\n");
    const names = blocks(code).map((candidate) => candidate.name);
    assert.ok(names.includes("Widget.render"), names.join(","));
    assert.ok(names.includes("Widget.get label"), names.join(","));
    assert.ok(names.includes("Widget.constructor"), names.join(","));
    assert.ok(names.includes("<anonymous>"), names.join(","));
  });

  it("skips a declaration with no body", () => {
    assert.equal(blocks("declare function ambient(a: number): void;").length, 0);
  });
});

describe("checkSource thresholds", () => {
  it("uses the ported defaults", () => {
    assert.equal(MAX_EFFORT, 50_000);
    assert.equal(MAX_DIFFICULTY, 30);
    assert.equal(MAX_BUGS, 0.4);
  });

  it("reports one failure per breached metric, located as file::function", () => {
    const source = sourceFor("function add(a: number, b: number) { return a + b; }");
    const failures = checkSource(source, api, { maxEffort: 1, maxDifficulty: 0.5, maxBugs: 0 });
    assert.deepEqual(
      failures.map((failure) => failure.metric),
      ["effort", "difficulty", "estimated bugs"],
    );
    assert.equal(failures[0]?.location, "src/a.ts::add");
    assert.equal(failures[0]?.maximum, 1);
    close(failures[0]?.actual ?? 0, 8, "effort");
  });

  it("passes a simple function at the ported thresholds", () => {
    const source = sourceFor("function add(a: number, b: number) { return a + b; }");
    assert.deepEqual(checkSource(source, api), []);
  });
});

/** A `ParsedSource` around a snippet, without touching the filesystem. */
function sourceFor(code: string): ParsedSource {
  return {
    path: "/repo/src/a.ts",
    relative: "src/a.ts",
    module: "src/a",
    sourceFile: parse(code),
    lines: code.split("\n"),
    imports: new Map<string, string>(),
  };
}

describe("formatHalsteadFailure", () => {
  it("matches the Python CLI line", () => {
    assert.equal(
      formatHalsteadFailure({
        location: "src/a.ts::add",
        metric: "effort",
        actual: 51234.567,
        maximum: 50_000,
      }),
      "  src/a.ts::add - effort 51234.6 exceeds max 50000.0",
    );
  });
});

describe("halsteadViolations", () => {
  it("produces the catalog's violation shape", () => {
    const root = mkdtempSync(join(tmpdir(), "kragg-halstead-"));
    temporaryRoots.push(root);
    writeFileSync(join(root, "package.json"), "{}");
    const sourceDir = join(root, "src");
    mkdirSync(sourceDir);
    writeFileSync(
      join(sourceDir, "a.ts"),
      "export function add(a: number, b: number): number { return a + b; }\n",
    );

    const violations = halsteadViolations(root, ["src"], { api, maxEffort: 1 });
    assert.equal(violations.length, 1);
    const violation = violations[0];
    assert.ok(violation !== undefined);
    assert.equal(violation.file, "src/a.ts");
    assert.equal(violation.code, "halstead");
    assert.equal(violation.fixHint, "reduce operators/operands; split the function");
    assert.equal(violation.message, "add: effort 8.0000 exceeds max 1.0000");
    assert.equal(violation.line, 1);
  });

  it("stays legible when the one-decimal-rounded value ties the threshold", () => {
    // A real function whose estimated-bugs value (0.4331...) rounds to
    // exactly the default MAX_BUGS ceiling (0.4) at one decimal place — 27
    // distinctly-named locals combined by a spread of operators give enough
    // vocabulary to push volume, and so bugs = volume / 3000, just past that
    // tie. Before the precision fix this printed the identical number on
    // both sides: "add: estimated bugs 0.4 exceeds max 0.4", with no visible
    // margin between the offending value and the ceiling it broke.
    const root = mkdtempSync(join(tmpdir(), "kragg-halstead-"));
    temporaryRoots.push(root);
    writeFileSync(join(root, "package.json"), "{}");
    const sourceDir = join(root, "src");
    mkdirSync(sourceDir);
    writeFileSync(join(sourceDir, "a.ts"), `${tieBugsSource()}\n`);

    const violations = halsteadViolations(root, ["src"], { api });
    assert.equal(violations.length, 1);
    const violation = violations[0];
    assert.ok(violation !== undefined);
    // Assert the tie actually exists at one decimal place before checking
    // that the four-decimal message tells the two numbers apart.
    assert.match(violation.message, /^tie: estimated bugs 0\.4331 exceeds max 0\.4000$/);
    assert.notEqual(violation.message, "tie: estimated bugs 0.4 exceeds max 0.4");
  });
});

/** A function whose estimated bugs ties MAX_BUGS (0.4) at one decimal place. */
function tieBugsSource(): string {
  const names = Array.from({ length: 27 }, (_, i) => `v${i}`);
  const decls = names.map((n, i) => `let ${n}: number = ${i + 1};`).join(" ");
  const ops = ["+", "-", "*", "/", "%", "&&", "||", "===", "!==", "<", ">", "<=", ">="];
  const terms = names.slice(0, -1).map((n, i) => `${n} ${ops[i % ops.length]} ${names[i + 1]}`);
  return `function tie() { ${decls} return (${terms.join(" + ")}) as unknown as number; }`;
}

/**
 * The block predicate and the block name, called on the nodes themselves.
 *
 * These two are shared with the complexity gate so the two can never disagree
 * about what a function IS or what it is CALLED — a disagreement that would
 * show up as two gates reporting different identifiers for the same code.
 * `fileHalstead` above only ever observes them through a finished report, so
 * the accessor prefixes, the computed name and the anonymous fallback are
 * pinned here on the node.
 */
describe("isFunctionBlock / functionBlockLabel", () => {
  /** Every measurable block in the snippet, in source order, by its label. */
  function labels(code: string): readonly string[] {
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (isFunctionBlock(node, api)) {
        found.push(functionBlockLabel(node, api));
      }
      api.forEachChild(node, visit);
    };
    api.forEachChild(parse(code), visit);
    return found;
  }

  it("accepts every function-like form that has a body", () => {
    assert.deepEqual(
      labels(
        "function decl() {}\n" +
          "const expr = function named() {};\n" +
          "const arrow = () => {};\n" +
          "class C { constructor() {} method() {} }\n",
      ),
      ["decl", "named", "arrow", "constructor", "method"],
    );
  });

  it("rejects nodes that are not function-like at all", () => {
    const sourceFile = parse("const x = 1;\n");
    assert.equal(isFunctionBlock(sourceFile, api), false);
    const statement = sourceFile.statements[0];
    assert.ok(statement !== undefined);
    assert.equal(isFunctionBlock(statement, api), false);
  });

  it("prefixes an accessor so a getter and a setter stay distinct", () => {
    assert.deepEqual(
      labels("class C { get size() { return 1; } set size(v: number) { this.n = v; } }\n"),
      ["get size", "set size"],
    );
  });

  it("reads a quoted or numeric member name, and says `<computed>` for the rest", () => {
    assert.deepEqual(
      labels('const o = { "a b"() {}, 7() {}, [Symbol.iterator]() {} };\n'),
      ["a b", "7", "<computed>"],
    );
  });

  it("infers a name from the binding an anonymous function is attached to", () => {
    assert.deepEqual(
      labels(
        "const bound = () => {};\n" +
          "const obj = { prop: () => {} };\n" +
          "class C { field = () => {}; }\n" +
          "let assigned;\n" +
          "assigned = () => {};\n" +
          "obj.member = () => {};\n",
      ),
      ["bound", "prop", "field", "assigned", "member"],
    );
  });

  it("says `<anonymous>` for a callback with no binding to borrow", () => {
    assert.deepEqual(labels("run(() => {});\n"), ["<anonymous>"]);
  });
});
