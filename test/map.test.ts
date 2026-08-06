/**
 * Tests for `kragg map`.
 *
 * Three things have to hold, and each has a section below:
 *
 *  - PUBLIC MEANS EXPORTED. This is the divergence from `mapping.py` that the
 *    whole command rests on, so both directions are pinned: an unexported
 *    declaration never appears no matter how public its name looks, and one
 *    reached only through an `export { ... }` clause always does.
 *  - THE SIGNATURE IS THE PRODUCT. Parameters, optionality, rest, type
 *    parameters and annotated returns are all rendered, and anything long is
 *    elided rather than allowed to eat the reader's context window.
 *  - RISK FLAGS COME FROM THE GRAPH, keyed by `<module>#<qualname>` so two
 *    modules with a same-named function cannot borrow each other's flag.
 *    That collision is the specific failure a name-only lookup would have.
 *
 * Everything runs against a temporary project with the bundled compiler
 * passed in explicitly, so no test depends on what is installed in kragg-ts
 * itself.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import ts from "typescript";

import { buildMap, criticalityFlags, MAP_RELATIVE, writeMap } from "../src/commands/map.ts";
import { clamp, compact } from "../src/commands/map/render.ts";
import { DEFAULT_POLICY, type KraggPolicy } from "../src/policy/policy.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-map-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

const POLICY: KraggPolicy = { ...DEFAULT_POLICY, sourcePaths: ["src"] };

function mapOf(files: Readonly<Record<string, string>>): string[] {
  return buildMap(project(files), POLICY, ts);
}

/** The body lines, i.e. everything after the count header. */
function body(files: Readonly<Record<string, string>>): string[] {
  return mapOf(files).slice(1);
}

describe("map: what counts as public", () => {
  it("lists an exported function and omits an unexported one", () => {
    const lines = body({
      "src/a.ts": "export function shown(): void {}\nfunction hidden(): void {}\n",
    });
    assert.deepEqual(lines, ["src/a", "  fn shown(): void"]);
  });

  it("lists a declaration reached only through an export clause", () => {
    const lines = body({
      "src/a.ts": "function late(): void {}\nexport { late };\n",
    });
    assert.deepEqual(lines, ["src/a", "  fn late(): void"]);
  });

  it("follows a renaming export clause by its LOCAL name", () => {
    // `export { local as public }` binds the declaration named `local`, which
    // is what the criticality graph records, so that is what must match.
    const lines = body({
      "src/a.ts": "function local(): void {}\nexport { local as publicName };\n",
    });
    assert.deepEqual(lines, ["src/a", "  fn local(): void"]);
  });

  it("omits a module with no exports entirely, heading included", () => {
    const lines = body({
      "src/quiet.ts": "function hidden(): void {}\n",
      "src/loud.ts": "export const value = 1;\n",
    });
    assert.deepEqual(lines, ["src/loud", "  const value"]);
  });

  it("returns nothing at all when no module exports anything", () => {
    assert.deepEqual(mapOf({ "src/a.ts": "const hidden = 1;\n" }), []);
  });

  it("counts modules and symbols in the header", () => {
    const lines = mapOf({
      "src/a.ts": "export const one = 1;\nexport const two = 2;\n",
      "src/b.ts": "export const three = 3;\n",
    });
    assert.equal(lines[0], "map: 3 exported symbols across 2 modules");
  });
});

describe("map: signatures", () => {
  it("renders parameters with their annotations and the return type", () => {
    const lines = body({
      "src/a.ts": "export function run(path: string, depth: number): boolean {\n  return true;\n}\n",
    });
    assert.deepEqual(lines, ["src/a", "  fn run(path: string, depth: number): boolean"]);
  });

  it("marks optional and defaulted parameters with `?` and rest with `...`", () => {
    const lines = body({
      "src/a.ts":
        "export function run(a?: string, b: number = 1, ...rest: string[]): void {}\n",
    });
    assert.deepEqual(lines, [
      "src/a",
      "  fn run(a?: string, b?: number, ...rest: string[]): void",
    ]);
  });

  it("renders type parameters", () => {
    const lines = body({ "src/a.ts": "export function pick<T>(value: T): T {\n  return value;\n}\n" });
    assert.deepEqual(lines, ["src/a", "  fn pick<T>(value: T): T"]);
  });

  it("omits a return type that was never annotated rather than inferring one", () => {
    // No `ts.Program` here by design — see the module header of map/symbols.ts.
    const lines = body({ "src/a.ts": "export function guess() {\n  return 1;\n}\n" });
    assert.deepEqual(lines, ["src/a", "  fn guess()"]);
  });

  it("renders an exported arrow constant as a function", () => {
    const lines = body({ "src/a.ts": "export const run = (a: string): void => {};\n" });
    assert.deepEqual(lines, ["src/a", "  fn run(a: string): void"]);
  });

  it("summarises a destructured parameter instead of reproducing the pattern", () => {
    const lines = body({
      "src/a.ts": "export function run({ a, b }: { a: string; b: number }): void {}\n",
    });
    assert.deepEqual(lines, ["src/a", "  fn run({…}: { a: string; b: number }): void"]);
  });

  it("indents class methods under their class and drops non-public members", () => {
    const lines = body({
      "src/a.ts": [
        "export class Client {",
        "  constructor(readonly url: string) {}",
        "  send(body: string): void {}",
        "  private secret(): void {}",
        "  protected hook(): void {}",
        "  #hidden(): void {}",
        "  _internal(): void {}",
        "}",
        "",
      ].join("\n"),
    });
    assert.deepEqual(lines, ["src/a", "  class Client", "    Client.send(body: string): void"]);
  });

  it("lists interface members and caps the list", () => {
    const lines = body({
      "src/a.ts": `export interface Wide {\n${"abcdefghij"
        .split("")
        .map((name) => `  ${name}: string;`)
        .join("\n")}\n}\n`,
    });
    assert.deepEqual(lines, [
      "src/a",
      "  interface Wide { a, b, c, d, e, f, g, h, +2 more }",
    ]);
  });

  it("inlines a short type alias and drops a long one", () => {
    const long = Array.from({ length: 12 }, (_, index) => `"option${index}"`).join(" | ");
    const lines = body({
      "src/a.ts": `export type Small = "a" | "b";\nexport type Big = ${long};\n`,
    });
    assert.deepEqual(lines, [
      "src/a",
      '  type Small = "a" | "b"',
      "  type Big",
    ]);
  });

  it("elides a signature longer than the cap", () => {
    const parameters = Array.from(
      { length: 12 },
      (_, index) => `parameterNumber${index}: string`,
    ).join(", ");
    const lines = body({ "src/a.ts": `export function wide(${parameters}): void {}\n` });
    const entry = lines[1] ?? "";
    assert.ok(entry.endsWith("…"), entry);
    assert.ok(entry.trimStart().length <= 96, entry);
  });
});

describe("map: docs and risk flags", () => {
  it("appends the first prose line of the JSDoc, truncated", () => {
    const lines = body({
      "src/a.ts": "/** Does the thing. */\nexport function run(): void {}\n",
    });
    assert.deepEqual(lines, ["src/a", "  fn run(): void — Does the thing."]);
  });

  it("skips a tag-only JSDoc and a non-doc comment", () => {
    const lines = body({
      "src/a.ts":
        "/** @internal */\nexport function tagged(): void {}\n// plain\nexport function plain(): void {}\n",
    });
    assert.deepEqual(lines, ["src/a", "  fn tagged(): void", "  fn plain(): void"]);
  });

  it("does not attribute a file header comment to the first declaration", () => {
    const lines = body({
      "src/a.ts": "/**\n * File header.\n */\n\nimport { join } from \"node:path\";\n\nexport function run(): void {\n  void join;\n}\n",
    });
    assert.deepEqual(lines, ["src/a", "  fn run(): void"]);
  });

  it("flags a critical symbol with its risk band", () => {
    const root = project({
      "src/a.ts": "export function run(): void {}\n",
      ".kragg/criticality.json": JSON.stringify([
        { name: "src/a#run", fan_in: 9, is_critical: true, risk: "HIGH" },
      ]),
    });
    assert.deepEqual(buildMap(root, POLICY, ts), [
      "map: 1 exported symbols across 1 modules",
      "src/a",
      "  fn run(): void  [HIGH]",
    ]);
  });

  it("does not let a same-named function in another module borrow the flag", () => {
    const root = project({
      "src/a.ts": "export function run(): void {}\n",
      "src/b.ts": "export function run(): void {}\n",
      ".kragg/criticality.json": JSON.stringify([
        { name: "src/a#run", fan_in: 9, is_critical: true, risk: "HIGH" },
      ]),
    });
    assert.deepEqual(buildMap(root, POLICY, ts).slice(1), [
      "src/a",
      "  fn run(): void  [HIGH]",
      "src/b",
      "  fn run(): void",
    ]);
  });

  it("ignores non-critical entries and defaults a missing risk to MED", () => {
    const root = project({
      ".kragg/criticality.json": JSON.stringify([
        { name: "src/a#quiet", fan_in: 1, is_critical: false, risk: "LOW" },
        { name: "src/a#loud", fan_in: 9, is_critical: true },
      ]),
    });
    const flags = criticalityFlags(root);
    assert.equal(flags.get("src/a#quiet"), undefined);
    assert.equal(flags.get("src/a#loud"), "MED");
  });

  it("yields no flags when there is no criticality file", () => {
    assert.equal(criticalityFlags(project({})).size, 0);
  });
});

describe("map: writing", () => {
  it("writes the lines with a trailing newline, creating .kragg", () => {
    const root = project({});
    const output = join(root, MAP_RELATIVE);
    writeMap(["one", "two"], output);
    assert.equal(readFileSync(output, "utf8"), "one\ntwo\n");
  });
});

describe("map: text helpers", () => {
  it("collapses wrapped whitespace onto one line", () => {
    assert.equal(compact("a\n   b\t c "), "a b c");
  });

  it("truncates with an ellipsis only past the limit", () => {
    assert.equal(clamp("abcde", 5), "abcde");
    assert.equal(clamp("abcdef", 5), "abcd…");
  });
});
