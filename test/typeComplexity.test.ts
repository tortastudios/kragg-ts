/**
 * Tests for the type-complexity gate.
 *
 * The depth rule is the gate's whole contract with a project, so most of this
 * file pins it one type shape at a time — including the three judgement calls
 * that a reader is entitled to disagree with, and which must therefore be
 * written down as executable facts rather than prose:
 *
 *  - a union or intersection does NOT add depth (alternatives, not nesting);
 *  - a bare type reference is depth 0 however complicated its definition is
 *    (naming a type is the fix this gate asks for, so it cannot be penalised);
 *  - a function type DOES add depth, over its parameters and its return.
 *
 * The rest is the reporting contract: the Python message shape, the
 * exemptions (`type` aliases, `.d.ts`, `// kragg: ignore`) and the rule that
 * one annotation is one violation no matter how much is nested inside it.
 *
 * These tests import `typescript` directly, which production gate code must
 * NOT do (see `resolveTypeScript`): here it is the compiler under test, passed
 * in explicitly so the shared handle cache stays clean.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import ts from "typescript";

import type { Violation } from "../src/engine/models.ts";
import {
  checkTypeComplexity,
  suggestFix,
  typeDepth,
  TYPE_COMPLEXITY_CODE,
} from "../src/gates/typeComplexity.ts";

const temporaryRoots: string[] = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-typecomplexity-"));
  temporaryRoots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

/** Run the gate over a one-file project with the default policy budgets. */
function check(
  files: Readonly<Record<string, string>>,
  budgets: { maxDepth?: number; maxLength?: number } = {},
): readonly Violation[] {
  return checkTypeComplexity({
    root: project(files),
    sourcePaths: ["src"],
    maxDepth: budgets.maxDepth ?? 2,
    maxLength: budgets.maxLength ?? 40,
    api: ts,
  });
}

/** The depth of a type, written as it would appear in an annotation. */
function depth(annotation: string): number {
  const file = ts.createSourceFile(
    "probe.ts",
    `let probe: ${annotation};`,
    ts.ScriptTarget.Latest,
    true,
  );
  const statement = file.statements[0];
  assert.ok(statement !== undefined && ts.isVariableStatement(statement));
  const declared = statement.declarationList.declarations[0]?.type;
  assert.ok(declared !== undefined, `no annotation parsed from \`${annotation}\``);
  return typeDepth(declared, ts);
}

describe("typeDepth", () => {
  it("counts a leaf as zero, named or not", () => {
    assert.equal(depth("string"), 0);
    assert.equal(depth("unknown"), 0);
    assert.equal(depth('"literal"'), 0);
    assert.equal(depth("typeof globalThis"), 0);
    // The whole point: a named type is a leaf. Extracting one is the fix.
    assert.equal(depth("DeeplyNestedThing"), 0);
  });

  it("counts one level per generic application", () => {
    assert.equal(depth("Foo<Bar>"), 1);
    assert.equal(depth("Record<string, string>"), 1);
    assert.equal(depth("Record<string, Record<string, string>>"), 2);
    assert.equal(depth("Record<string, Record<string, Foo<Bar>>>"), 3);
    assert.equal(depth("Awaited<ReturnType<typeof handler>>"), 2);
  });

  it("counts arrays and tuples as containers", () => {
    assert.equal(depth("string[]"), 1);
    assert.equal(depth("string[][]"), 2);
    assert.equal(depth("[string, number]"), 1);
    assert.equal(depth("Array<Map<string, number>>"), 2);
  });

  it("does NOT count union or intersection members as nesting", () => {
    // Alternatives at one level. A wide union is caught by the LENGTH budget,
    // which is the budget that describes what is actually wrong with it.
    assert.equal(depth("string | number | null | undefined"), 0);
    assert.equal(depth("Foo & Bar"), 0);
    assert.equal(depth("Foo<Bar> | Baz"), 1);
    assert.equal(depth("(Foo)"), 0);
  });

  it("counts a function type over both its parameters and its return", () => {
    assert.equal(depth("() => void"), 1);
    assert.equal(depth("(a: Foo<Bar>) => void"), 2);
    assert.equal(depth("() => Foo<Bar>"), 2);
    assert.equal(depth("new (a: string) => Foo"), 1);
  });

  it("counts inline object, mapped, conditional and indexed types", () => {
    assert.equal(depth("{ a: string }"), 1);
    assert.equal(depth("{ a: { b: string } }"), 2);
    assert.equal(depth("{ [K in Keys]: Foo<Bar> }"), 2);
    assert.equal(depth("A extends B ? C : D"), 1);
    assert.equal(depth("A extends B ? Foo<Bar> : D"), 2);
    assert.equal(depth('Config["server"]'), 1);
    assert.equal(depth("`prefix-${string}`"), 1);
  });

  it("treats operators and markers as transparent", () => {
    assert.equal(depth("keyof Config"), 0);
    assert.equal(depth("readonly string[]"), 1);
    // The `?` and `...` markers add nothing; the tuple itself is the one
    // level, and the rest element's own `number[]` is the second.
    assert.equal(depth("[a?: Foo]"), 1);
    assert.equal(depth("[...rest: number[]]"), 2);
  });
});

describe("suggestFix", () => {
  it("ports Python's branches with TypeScript vocabulary", () => {
    assert.match(suggestFix("Record<string, Foo[]>", 2, 2), /interface/);
    assert.match(suggestFix("Record<string, Record<string, X>>", 3, 2), /interface/);
    assert.equal(suggestFix("Foo | Bar | Baz | Qux", 1, 2), "define a named `type` alias for this shape");
    assert.match(suggestFix("A extends B ? C : D", 3, 2), /simplify/);
  });
});

describe("checkTypeComplexity", () => {
  it("reports depth in Python's message shape", () => {
    const violations = check({
      "src/a.ts": "export function load(input: Record<string, Record<string, string[]>>): void {}\n",
    });
    assert.equal(violations.length, 1);
    const [only] = violations;
    assert.ok(only !== undefined);
    assert.equal(only.code, TYPE_COMPLEXITY_CODE);
    assert.equal(only.file, "src/a.ts");
    assert.equal(only.line, 1);
    assert.match(
      only.message,
      /^parameter 'input' in load\(\): annotation `Record<string, Record<string, string\[\]>>` \(depth=3, length=\d+\)$/,
    );
    assert.ok((only.fixHint ?? "").length > 0);
  });

  it("reports a type that is shallow but too long", () => {
    const violations = check({
      "src/a.ts": "export const mode: 'alpha' | 'beta' | 'gamma' | 'delta' | 'epsilon' = 'alpha';\n",
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0]?.message ?? "", /depth=0, length=48\)$/);
  });

  it("stays silent inside both budgets", () => {
    const violations = check({
      "src/a.ts": [
        "export function ok(a: string, b: Record<string, number>): Foo<Bar> {",
        "  return null as unknown as Foo<Bar>;",
        "}",
        "interface Foo<T> { value: T }",
        "interface Bar { name: string }",
        "",
      ].join("\n"),
    });
    assert.deepEqual(violations, []);
  });

  it("reports every site Python reports", () => {
    const wide = "Record<string, Record<string, string[]>>";
    const violations = check({
      "src/a.ts": [
        `export function f(a: ${wide}): ${wide} {`,
        `  const local: ${wide} = a;`,
        "  return local;",
        "}",
        "export class Holder {",
        `  field: ${wide} = {};`,
        `  method(b: ${wide}): void {}`,
        "}",
        "export interface Shape {",
        `  prop: ${wide};`,
        `  call(c: ${wide}): void;`,
        "}",
        "",
      ].join("\n"),
    });
    const contexts = violations.map((violation) => violation.message.split(":")[0]);
    assert.deepEqual(contexts, [
      "parameter 'a' in f()",
      "return type of f()",
      "variable 'local'",
      "property 'Holder.field'",
      "parameter 'b' in method()",
      "property 'Shape.prop'",
      "parameter 'c' in call()",
    ]);
  });

  it("never reports a `type` alias — the alias IS the fix", () => {
    const violations = check({
      "src/a.ts": "export type Deep = Record<string, Record<string, Record<string, string>>>;\n",
    });
    assert.deepEqual(violations, []);
  });

  it("reports one violation per annotation, not one per nested type", () => {
    const violations = check({
      "src/a.ts":
        "export const handlers: { run(a: Record<string, Record<string, string[]>>): void }[] = [];\n",
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0]?.message ?? "", /^variable 'handlers'/);
  });

  it("exempts declaration files", () => {
    const violations = check({
      "src/a.d.ts": "export declare function f(a: Record<string, Record<string, string[]>>): void;\n",
    });
    assert.deepEqual(violations, []);
  });

  it("honours `// kragg: ignore -- <reason>` on any line the annotation spans", () => {
    const violations = check({
      "src/a.ts": [
        "export function f(",
        "  a: Record<", // the marker is on the next line, inside the span
        "    string,",
        "    Record<string, string[]> // kragg: ignore -- mirrors the wire format; a named type would lie",
        "  >,",
        "): void {}",
        "",
      ].join("\n"),
    });
    assert.deepEqual(violations, []);
  });

  it("does not honour a bare marker, and names it in the finding", () => {
    const violations = check({
      "src/a.ts": ["export function f(a: Record<string, Record<string, string[]>>): void {} // kragg: ignore", ""].join("\n"),
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0]?.message ?? "", /\(the `\/\/ kragg: ignore` on line 1 names no reason and is not honoured; write `\/\/ kragg: ignore -- <why this site is safe>`\)$/u);
  });

  it("measures the type, not the formatter", () => {
    const violations = check({
      "src/a.ts": ["export const x: Record<", "  string,", "  number", "> = {};", ""].join("\n"),
    });
    // Whitespace-normalized to `Record< string, number >`-without-padding, so
    // a multi-line spelling is not charged for its own indentation.
    assert.deepEqual(violations, []);
  });

  it("narrows to the caller's changed files", () => {
    const wide = "export const x: Record<string, Record<string, string[]>> = {};\n";
    const root = project({ "src/a.ts": wide, "src/b.ts": wide });
    const violations = checkTypeComplexity({
      root,
      sourcePaths: ["src"],
      maxDepth: 2,
      maxLength: 40,
      api: ts,
      paths: ["src/b.ts"],
    });
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.file, "src/b.ts");
  });

  it("skips a file that does not parse rather than crashing", () => {
    const violations = check({ "src/broken.ts": "export function ( {{{ \n" });
    assert.deepEqual(violations, []);
  });
});
