/**
 * Tests for the nullable-default gate.
 *
 * This gate is a redesign rather than a port, so the tests carry more of the
 * burden than usual: they are the executable statement of the precision rules
 * in the module doc comment. Almost every case here is a MUST-NOT-MATCH,
 * because the failure mode that kills this gate is noise — a `||` linter that
 * fires on every file gets switched off, and a switched-off gate protects
 * nothing.
 *
 * The type-level cases are the interesting ones. `config.mode || 1` where
 * `mode` is `1 | 2 | undefined` must stay silent, and `config.port || 3000`
 * where `port` is `number | undefined` must not: the difference is invisible
 * to a syntactic matcher and obvious to the checker.
 *
 * Everything runs against ONE fixture project and ONE `ts.Program`, with each
 * test narrowed to its own file via `paths` — which keeps the suite to a
 * single program build and exercises the `--changed` narrowing throughout.
 * Line numbers are asserted on, so editing a fixture source means editing the
 * test that reads it.
 *
 * The fixture deliberately contains `any` (that is the hole rule 2 exists to
 * find); it is fixture text, never part of kragg's own compiled surface.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import ts from "typescript";

import { analysisProgram, type AnalysisProgram } from "../src/analysis/program.ts";
import type { Violation } from "../src/engine/models.ts";
import {
  checkNullableDefaults,
  NULLABLE_DEFAULT_CODE,
} from "../src/gates/nullableDefault.ts";
import { MAX_DEPTH, unwrap } from "../src/gates/nullableDefault/finding.ts";

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "es2023",
    lib: ["es2023"],
    module: "preserve",
    moduleResolution: "bundler",
    allowImportingTsExtensions: true,
    noEmit: true,
    strict: true,
    types: [],
    skipLibCheck: true,
  },
  include: ["src/**/*.ts"],
});

const FIXTURE: Readonly<Record<string, string>> = {
  "tsconfig.json": TSCONFIG,

  "src/shared.ts": [
    "export interface Config {",
    "  port?: number;",
    "  retries?: number;",
    "  enabled?: boolean;",
    "  name?: string;",
    "  mode?: 1 | 2;",
    "  ratio: number;",
    "}",
    "export declare const config: Config;",
    "export declare const loose: any;",
    "export declare function fallbackPort(): number;",
  ].join("\n"),

  // Rule 1 — the true positives.
  "src/coalesce.ts": [
    'import { config } from "./shared.ts";',
    "",
    "export const port = config.port || 3000;",
    "export const retries = config.retries || -1;",
    "export const enabled = config.enabled || true;",
    "export function pick(): number {",
    "  return config.port || 8080;",
    "}",
    "export const wrapped = (config.port) || 8080;",
    "export const nested = { timeout: config.port || 30 };",
    "export function apply(): number {",
    "  let value = config.port;",
    "  value ||= 8080;",
    "  return value;",
    "}",
  ].join("\n"),

  // Rule 1 — everything that must stay silent.
  "src/coalesceQuiet.ts": [
    'import { config, loose, fallbackPort } from "./shared.ts";',
    "",
    "export const correct = config.port ?? 3000;",
    "export const falsyDefault = config.port || 0;",
    "export const stringDefault = config.name || 'Anonymous';",
    "export const computed = config.port || fallbackPort();",
    "export const literalUnion = config.mode || 1;",
    "export const nonNullable = config.ratio || 5;",
    "export const untyped = loose || 5;",
    "export function condition(): boolean {",
    "  if (config.port || 3000) {",
    "    return true;",
    "  }",
    "  return !(config.enabled || true);",
    "}",
    "export const suppressed = config.port || 3000; // kragg: ignore",
  ].join("\n"),

  // Rule 2 — arithmetic on untyped payloads.
  "src/payload.ts": [
    "declare const body: string;",
    "declare function fetchJson(): Promise<{ json: () => any }>;",
    "",
    "export function totals(): number {",
    "  const data = JSON.parse(body);",
    "  return data.count + 1;",
    "}",
    "export function scaled(): number {",
    "  return JSON.parse(body).amount * 2;",
    "}",
    "export function nestedRead(): number {",
    "  const data = JSON.parse(body);",
    "  const rows = data.rows;",
    "  return rows.length - 1;",
    "}",
    "export async function fromResponse(): Promise<number> {",
    "  const res = await fetchJson();",
    "  const payload = await res.json();",
    "  return payload.total - 1;",
    "}",
  ].join("\n"),

  // Rule 2 — everything that must stay silent.
  "src/payloadQuiet.ts": [
    "declare const body: string;",
    "declare const count: number;",
    "",
    "export function labeled(): string {",
    "  const data = JSON.parse(body);",
    "  return data.name + ' (new)';",
    "}",
    "export function typed(): number {",
    "  const data = JSON.parse(body) as { count: number };",
    "  return data.count + 1;",
    "}",
    "export function local(a: number, b: number): number {",
    "  return a + b - count;",
    "}",
    "export function compared(): boolean {",
    "  const data = JSON.parse(body);",
    "  return data.count > 10;",
    "}",
    "export function ignored(): number {",
    "  const data = JSON.parse(body);",
    "  return data.count * 2; // kragg: ignore",
    "}",
  ].join("\n"),
};

const root = mkdtempSync(join(tmpdir(), "kragg-nullable-"));
let program: AnalysisProgram;

before(() => {
  for (const [name, contents] of Object.entries(FIXTURE)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  program = analysisProgram({ root, api: ts });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function scan(file: string): readonly Violation[] {
  const outcome = checkNullableDefaults({ program, paths: [file] });
  if (!outcome.ok) {
    assert.fail(`gate could not run: ${outcome.message}`);
  }
  return outcome.violations;
}

function lines(file: string): readonly number[] {
  return scan(file).map((violation) => violation.line ?? 0);
}

describe("nullable-default: `||` mis-coalescing", () => {
  it("flags a truthy numeric or boolean default over a falsy-capable type", () => {
    assert.deepEqual(lines("src/coalesce.ts"), [3, 4, 5, 7, 9, 10, 13]);
  });

  it("names the operand and its type, and points at the fix", () => {
    const first = scan("src/coalesce.ts")[0];
    assert.ok(first !== undefined);
    assert.equal(first.code, NULLABLE_DEFAULT_CODE);
    assert.equal(first.file, "src/coalesce.ts");
    assert.match(first.message, /`\|\|` also replaces a valid `0` here/);
    assert.match(first.message, /`config\.port` is `number \| undefined`/);
    assert.match(first.fixHint ?? "", /use `\?\?`/);
  });

  it("reports `false` swallowing in its own words", () => {
    const boolean = scan("src/coalesce.ts").find((violation) => violation.line === 5);
    assert.ok(boolean !== undefined);
    assert.match(boolean.message, /replaces a valid `false`/);
  });

  it("stays silent on every near-miss", () => {
    // `??`, a falsy default, a string default, a computed default, a literal
    // union with no `0`, a non-nullable type, `any`, a condition, and a
    // suppressed site. Nothing here is a bug this gate can prove.
    assert.deepEqual(lines("src/coalesceQuiet.ts"), []);
  });
});

describe("nullable-default: arithmetic on an untyped payload", () => {
  it("flags arithmetic reached from JSON.parse and from `.json()`", () => {
    assert.deepEqual(lines("src/payload.ts"), [6, 9, 14, 19]);
  });

  it("explains that the failure is silent, not an exception", () => {
    const first = scan("src/payload.ts")[0];
    assert.ok(first !== undefined);
    assert.equal(first.code, NULLABLE_DEFAULT_CODE);
    assert.match(first.message, /a null or missing field becomes `NaN`/);
    assert.match(first.fixHint ?? "", /defeats the checker/);
  });

  it("stays silent on concatenation, an asserted type, locals and comparison", () => {
    assert.deepEqual(lines("src/payloadQuiet.ts"), []);
  });
});

describe("nullable-default: outcome", () => {
  it("scans the whole project when no paths are given", () => {
    const outcome = checkNullableDefaults({ program });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) {
      return;
    }
    const files = new Set(outcome.violations.map((violation) => violation.file));
    assert.deepEqual([...files].sort(), ["src/coalesce.ts", "src/payload.ts"]);
  });

  it("FAILS CLOSED when the program cannot be built", () => {
    const broken = mkdtempSync(join(tmpdir(), "kragg-nullable-broken-"));
    const outcome = checkNullableDefaults({
      program: analysisProgram({ root: broken, api: ts }),
    });
    rmSync(broken, { recursive: true, force: true });
    assert.equal(outcome.ok, false);
    if (outcome.ok) {
      return;
    }
    assert.match(outcome.message, /tsconfig\.json/);
  });
});

/**
 * The wrapper stripper every rule in this gate starts from.
 *
 * `(value)!` and `value` are the same expression at runtime, so a gate that
 * judged the parentheses instead of the value inside them would miss the
 * finding entirely — a false PASS, which is the one outcome this codebase
 * refuses. The bound matters for the opposite reason: `unwrap` walks a
 * syntactic chain whose depth an author controls, and a gate that can be
 * hung by a pathological file stops reporting everything else.
 */
describe("unwrap", () => {
  function expressionOf(code: string): ts.Expression {
    const file = ts.createSourceFile(
      "snippet.ts",
      `${code};\n`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const statement = file.statements[0];
    assert.ok(statement !== undefined && ts.isExpressionStatement(statement));
    return statement.expression;
  }

  it("returns an unwrapped expression untouched", () => {
    const expression = expressionOf("value");
    assert.equal(unwrap(expression, ts), expression);
    assert.equal(ts.isIdentifier(unwrap(expressionOf("a.b"), ts)), false);
    assert.equal(ts.isPropertyAccessExpression(unwrap(expressionOf("a.b"), ts)), true);
  });

  it("strips parentheses and non-null assertions, in any mixture", () => {
    for (const code of ["(value)", "value!", "(value!)", "((value)!)!", "(((value)))"]) {
      const stripped = unwrap(expressionOf(code), ts);
      assert.ok(ts.isIdentifier(stripped), `${code} should reduce to an identifier`);
      assert.equal(stripped.text, "value");
    }
  });

  it("does not strip a cast, which is not one of the two forms it handles", () => {
    const stripped = unwrap(expressionOf("(value as string)"), ts);
    assert.equal(
      ts.isAsExpression(stripped),
      true,
      "the parentheses come off; the `as` inside them stays",
    );
  });

  it("stops at MAX_DEPTH rather than following an unbounded chain", () => {
    const depth = MAX_DEPTH + 1;
    const stripped = unwrap(
      expressionOf(`${"(".repeat(depth)}value${")".repeat(depth)}`),
      ts,
    );
    assert.equal(
      ts.isParenthesizedExpression(stripped),
      true,
      "one layer past the bound is left in place, not walked",
    );
    // ...and exactly at the bound the walk still finishes the job.
    const atBound = unwrap(
      expressionOf(`${"(".repeat(MAX_DEPTH)}value${")".repeat(MAX_DEPTH)}`),
      ts,
    );
    assert.equal(ts.isIdentifier(atBound), true);
  });
});
