/**
 * Tests for the typing-strictness gate.
 *
 * Two failure modes are worth more than all the others, and the suite is
 * weighted at them:
 *
 *  1. A CONFIG THAT LOOKS STRICT AND IS NOT. The root `tsconfig.json` says
 *     `"strict": true` and a base config four directories away says
 *     `"strictNullChecks": false`. If the audit reads the root file instead of
 *     the resolved options, it reports green on a project with no null
 *     checking at all — the exact fail-open this gate exists to prevent.
 *
 *  2. A DIRECTIVE INSIDE A STRING LITERAL. Python's sibling uses `tokenize`
 *     specifically so that documenting `# type: ignore` does not flag it. The
 *     equivalent here is reading comments from the parser's token stream, and
 *     the test for it is a file that contains the directives as DATA.
 *
 * The rest pins the floor flag by flag, the advisory/violation split, and the
 * `// kragg: ignore` escape valve.
 *
 * These tests import `typescript` directly, which production gate code must
 * NOT do (see `resolveTypeScript`): here it is the compiler under test, passed
 * in explicitly so the shared handle cache stays clean.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import ts from "typescript";

import type { Violation } from "../src/engine/models.ts";
import {
  checkTypingStrictness,
  ADVISORY_CODES,
  TYPING_STRICTNESS_CODES as CODE,
  type TypingStrictnessOutcome,
} from "../src/gates/typingStrictness.ts";

const temporaryRoots: string[] = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A config that meets the floor exactly, for tests about something else. */
const STRICT_TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    noEmit: true,
  },
});

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-strictness-"));
  temporaryRoots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

function run(files: Readonly<Record<string, string>>): TypingStrictnessOutcome {
  return checkTypingStrictness({
    root: project(files),
    sourcePaths: ["src"],
    api: ts,
  });
}

/** The `ok: true` arm, or a failed assertion naming why it was not. */
function ok(outcome: TypingStrictnessOutcome): {
  readonly violations: readonly Violation[];
  readonly advisories: readonly Violation[];
} {
  assert.ok(outcome.ok, outcome.ok ? "" : `gate could not run: ${outcome.message}`);
  return outcome;
}

function codes(violations: readonly Violation[]): readonly string[] {
  return violations.map((violation) => violation.code ?? "");
}

/** Audit a config with no sources to scan. */
function config(tsconfig: string, extra: Readonly<Record<string, string>> = {}): {
  readonly violations: readonly Violation[];
  readonly advisories: readonly Violation[];
} {
  return ok(run({ "tsconfig.json": tsconfig, ...extra }));
}

/**
 * Scan sources against a config that is already at the floor, keeping only the
 * findings that came from the SOURCE — `STRICT_TSCONFIG` is minimal, so it
 * still earns the two build-hygiene advisories, and they are not what these
 * tests are about.
 */
function sources(source: string): {
  readonly violations: readonly Violation[];
  readonly advisories: readonly Violation[];
} {
  const found = ok(run({ "tsconfig.json": STRICT_TSCONFIG, "src/a.ts": source }));
  const fromSource = (violation: Violation): boolean => violation.file !== "tsconfig.json";
  return {
    violations: found.violations.filter(fromSource),
    advisories: found.advisories.filter(fromSource),
  };
}

describe("typing-strictness: tsconfig floor", () => {
  it("reports a missing config, as Python reports a missing [tool.mypy]", () => {
    const found = ok(run({ "src/a.ts": "export const a = 1;\n" }));
    assert.deepEqual(codes(found.violations), [CODE.tsconfigMissing]);
    assert.equal(found.violations[0]?.file, "tsconfig.json");
  });

  it("passes a config at the floor", () => {
    assert.deepEqual(config(STRICT_TSCONFIG).violations, []);
  });

  it("accepts the implied flags in place of `strict`, as Python does", () => {
    const found = config(
      JSON.stringify({
        compilerOptions: {
          strictNullChecks: true,
          noImplicitAny: true,
          strictFunctionTypes: true,
          strictBindCallApply: true,
          strictPropertyInitialization: true,
          useUnknownInCatchVariables: true,
          alwaysStrict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          noEmit: true,
        },
      }),
    );
    assert.deepEqual(found.violations, []);
  });

  it("reports a config that is not strict", () => {
    const found = config(JSON.stringify({ compilerOptions: { noEmit: true } }));
    assert.ok(codes(found.violations).includes(CODE.tsconfigNotStrict));
  });

  it("reports an implied flag switched back off under `strict`", () => {
    const found = config(
      JSON.stringify({
        compilerOptions: {
          strict: true,
          strictNullChecks: false,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          noEmit: true,
        },
      }),
    );
    assert.deepEqual(codes(found.violations), [CODE.tsconfigLoosened]);
    assert.match(found.violations[0]?.message ?? "", /strictNullChecks/);
  });

  it("FOLLOWS `extends` — a base config cannot hide a downgrade", () => {
    const found = config(
      JSON.stringify({
        extends: "./config/base.json",
        compilerOptions: { noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true },
      }),
      {
        "config/base.json": JSON.stringify({
          compilerOptions: { strict: true, strictNullChecks: false, noEmit: true },
        }),
      },
    );
    assert.deepEqual(codes(found.violations), [CODE.tsconfigLoosened]);
    // ...and says WHERE, so the puzzle is solvable from the message alone.
    assert.match(found.violations[0]?.message ?? "", /set in \.\/config\/base\.json/);
  });

  it("inherits a floor met entirely by a base config", () => {
    const found = config(JSON.stringify({ extends: "./base.json" }), {
      "base.json": STRICT_TSCONFIG,
    });
    assert.deepEqual(found.violations, []);
  });

  it("requires noUncheckedIndexedAccess, and explains why in the hint", () => {
    const found = config(JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }));
    const missing = found.violations.filter((v) => v.code === CODE.tsconfigMissingFlag);
    assert.deepEqual(
      missing.map((v) => v.message.includes("noUncheckedIndexedAccess")),
      [true, false],
    );
    assert.match(missing[0]?.fixHint ?? "", /process\.env/);
    assert.match(missing[1]?.message ?? "", /exactOptionalPropertyTypes/);
  });

  it("requires noEmitOnError only when the config actually emits", () => {
    const emitting = config(
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
        },
      }),
    );
    assert.deepEqual(codes(emitting.violations), [CODE.tsconfigMissingFlag]);
    assert.match(emitting.violations[0]?.message ?? "", /noEmitOnError/);
    assert.deepEqual(config(STRICT_TSCONFIG).violations, []);
  });

  it("fails unchecked JavaScript and merely notes checked JavaScript", () => {
    const unchecked = config(
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          noEmit: true,
          allowJs: true,
        },
      }),
    );
    assert.deepEqual(codes(unchecked.violations), [CODE.tsconfigUncheckedJs]);

    const checked = config(
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          noEmit: true,
          allowJs: true,
          checkJs: true,
        },
      }),
    );
    assert.deepEqual(checked.violations, []);
    assert.ok(codes(checked.advisories).includes(CODE.tsconfigAllowJs));
  });

  it("treats skipLibCheck as advisory, never as a failure", () => {
    const found = config(
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          noEmit: true,
          skipLibCheck: true,
        },
      }),
    );
    assert.deepEqual(found.violations, []);
    assert.ok(codes(found.advisories).includes(CODE.tsconfigSkipLibCheck));
  });

  it("fails closed on a config it cannot resolve", () => {
    assert.deepEqual(codes(config("{ not json ]").violations), [CODE.tsconfigInvalid]);
    assert.deepEqual(
      codes(config(JSON.stringify({ extends: "./nowhere.json" })).violations),
      [CODE.tsconfigInvalid],
    );
  });

  it("every advisory code is declared advisory", () => {
    const found = config(JSON.stringify({ compilerOptions: {} }));
    for (const advisory of found.advisories) {
      assert.ok(ADVISORY_CODES.has(advisory.code ?? ""), `${advisory.code ?? "?"} not advisory`);
    }
    for (const violation of found.violations) {
      assert.ok(!ADVISORY_CODES.has(violation.code ?? ""));
    }
  });

  it("dogfoods: this repo's own tsconfig is at the floor", () => {
    const root = join(import.meta.dirname, "..");
    const outcome = checkTypingStrictness({ root, sourcePaths: [], api: ts });
    assert.ok(outcome.ok);
    assert.deepEqual(
      outcome.violations.map((violation) => `${violation.code ?? ""}: ${violation.message}`),
      [],
    );
  });
});

describe("typing-strictness: source escape hatches", () => {
  it("does NOT match a directive inside a string or template literal", () => {
    const found = sources(
      [
        'export const documented = "// @ts-ignore";',
        "export const templated = `// @ts-nocheck ${documented}`;",
        'export const also = "// @ts-expect-error";',
        "export const pattern = /\\/\\/ @ts-ignore/;",
        "",
      ].join("\n"),
    );
    assert.deepEqual(found.violations, []);
  });

  it("reports `@ts-ignore` and bare `@ts-expect-error`, not a described one", () => {
    const found = sources(
      [
        "// @ts-ignore",
        "export const a: string = 1 as unknown as string;",
        "// @ts-expect-error",
        "export const b = 2;",
        "// @ts-expect-error: the fixture is deliberately wrong",
        "export const c = 3;",
        "",
      ].join("\n"),
    );
    const directives = found.violations.filter(
      (violation) => violation.code === CODE.tsIgnore || violation.code === CODE.bareTsExpectError,
    );
    assert.deepEqual(codes(directives), [CODE.tsIgnore, CODE.bareTsExpectError]);
    assert.deepEqual(
      directives.map((violation) => violation.line),
      [1, 3],
    );
  });

  it("ignores a directive the compiler itself ignores", () => {
    const found = sources(
      ["/* @ts-ignore */", "export const a = 1;", "// @ts-nocheck", "export const b = 2;", ""].join(
        "\n",
      ),
    );
    assert.deepEqual(found.violations, []);
  });

  it("reports `@ts-nocheck` where the compiler honours it", () => {
    const found = sources("// @ts-nocheck\nexport const a = 1;\n");
    assert.deepEqual(codes(found.violations), [CODE.tsNocheck]);
  });

  it("separates `as any` from the double cast, and reports each once", () => {
    const found = sources(
      [
        "export function launder(value: unknown): string {",
        "  const loose = value as any;",
        "  return value as unknown as string;",
        "}",
        "",
      ].join("\n"),
    );
    assert.deepEqual(codes(found.violations), [CODE.asAny, CODE.doubleCast]);
  });

  it("grades explicit `any` by whether it is exported", () => {
    const found = sources(
      [
        "export function surface(input: any): void {",
        "  const internal: any = input;",
        "  void internal;",
        "}",
        "function hidden(input: any): void {",
        "  void input;",
        "}",
        "",
      ].join("\n"),
    );
    assert.deepEqual(codes(found.violations), [CODE.exportedAny]);
    assert.deepEqual(codes(found.advisories), [CODE.internalAny, CODE.internalAny]);
  });

  it("reports `Function` and merely notes `object`", () => {
    const found = sources(
      ["export interface Bad {", "  run: Function;", "  bag: object;", "}", ""].join("\n"),
    );
    assert.deepEqual(codes(found.violations), [CODE.unsafeFunctionType]);
    assert.deepEqual(codes(found.advisories), [CODE.weakObjectType]);
  });

  it("notes both spellings of a non-null assertion", () => {
    const found = sources(
      [
        "export class Holder {",
        "  value!: string;",
        "  read(input: string | null): string {",
        "    return input!;",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    assert.deepEqual(found.violations, []);
    assert.deepEqual(codes(found.advisories), [CODE.nonNullAssertion, CODE.nonNullAssertion]);
  });

  it("honours `// kragg: ignore`, on a directive comment too", () => {
    const found = sources(
      [
        "export function f(value: unknown): string {",
        "  return value as any; // kragg: ignore — reviewed",
        "}",
        "// @ts-ignore // kragg: ignore — reviewed",
        "export const a = 1;",
        "",
      ].join("\n"),
    );
    assert.deepEqual(found.violations, []);
  });

  it("narrows the source scan to changed files but always audits the config", () => {
    const root = project({
      "tsconfig.json": JSON.stringify({ compilerOptions: {} }),
      "src/a.ts": "export const a = 1 as any;\n",
      "src/b.ts": "export const b = 2 as any;\n",
    });
    const outcome = checkTypingStrictness({
      root,
      sourcePaths: ["src"],
      api: ts,
      paths: ["src/b.ts"],
    });
    assert.ok(outcome.ok);
    const asAny = outcome.violations.filter((violation) => violation.code === CODE.asAny);
    assert.deepEqual(
      asAny.map((violation) => violation.file),
      ["src/b.ts"],
    );
    assert.ok(codes(outcome.violations).includes(CODE.tsconfigNotStrict));
  });
});

/**
 * The include/exclude audit — the "reports green over code it never read"
 * blind spot.
 *
 * These are the tests that matter most in this file, because the failure they
 * pin is silent: every flag check passes, the gate says PASS, and an excluded
 * directory was never type-checked at all. The false-positive cases are tested
 * just as hard, since a config gate that cries wolf is one somebody switches
 * off — which costs more than the hole did.
 */
describe("typing-strictness: is the source actually type-checked?", () => {
  const source = "export const a = 1;\n";

  it("reports a source file no `include` entry covers", () => {
    const found = ok(
      run({
        "tsconfig.json": JSON.stringify({
          compilerOptions: { strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noEmit: true },
          include: ["src/kept/**/*.ts"],
        }),
        "src/kept/a.ts": source,
        "src/skipped/b.ts": source,
      }),
    );
    const unchecked = found.violations.filter(
      (violation) => violation.code === CODE.uncheckedSource,
    );
    assert.equal(unchecked.length, 1);
    assert.equal(unchecked[0]?.file, "src/skipped/b.ts");
    assert.match(unchecked[0]?.message ?? "", /is not type-checked/u);
    assert.match(unchecked[0]?.fixHint ?? "", /src\/skipped\/b\.ts/u);
  });

  it("reports a directory `exclude` removes, however strict the flags are", () => {
    const found = ok(
      run({
        "tsconfig.json": JSON.stringify({
          compilerOptions: { strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noEmit: true },
          exclude: ["src/generated"],
        }),
        "src/a.ts": source,
        "src/generated/g.ts": source,
      }),
    );
    assert.deepEqual(
      found.violations
        .filter((violation) => violation.code === CODE.uncheckedSource)
        .map((violation) => violation.file),
      ["src/generated/g.ts"],
    );
  });

  it("says nothing when the default include covers everything", () => {
    const found = config(STRICT_TSCONFIG, { "src/a.ts": source, "src/deep/b.ts": source });
    assert.deepEqual(
      found.violations.filter((violation) => violation.code === CODE.uncheckedSource),
      [],
    );
  });

  it("SKIPS VISIBLY on a solution-style config rather than flagging every file", () => {
    const found = ok(
      run({
        "tsconfig.json": JSON.stringify({
          compilerOptions: { strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noEmit: true },
          files: [],
          references: [{ path: "./packages/a" }],
        }),
        "src/a.ts": source,
      }),
    );
    assert.deepEqual(
      found.violations.filter((violation) => violation.code === CODE.uncheckedSource),
      [],
    );
    const advisory = found.advisories.find(
      (entry) => entry.code === CODE.uncheckedSourceUnaudited,
    );
    assert.ok(advisory !== undefined, "a solution-style build must skip with a stated reason");
    assert.match(advisory.message, /solution-style/u);
    assert.ok(ADVISORY_CODES.has(CODE.uncheckedSourceUnaudited));
  });

  it("names at most twenty files and counts the rest", () => {
    const files: Record<string, string> = {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noEmit: true },
        include: ["src/kept/**/*.ts"],
      }),
      "src/kept/a.ts": source,
    };
    for (let index = 0; index < 25; index += 1) {
      files[`src/skipped/f${index}.ts`] = source;
    }
    const unchecked = ok(run(files)).violations.filter(
      (violation) => violation.code === CODE.uncheckedSource,
    );
    assert.equal(unchecked.length, 21);
    assert.match(unchecked[20]?.message ?? "", /5 further source files/u);
  });

  it("does not double-report a config it already called invalid", () => {
    const found = config("{ not json", { "src/a.ts": source });
    assert.deepEqual(codes(found.violations), [CODE.tsconfigInvalid]);
  });

  it("dogfoods: every file under this repo's `src` is in its tsconfig", () => {
    const outcome = checkTypingStrictness({
      root: process.cwd(),
      sourcePaths: ["src"],
      api: ts,
    });
    assert.ok(outcome.ok);
    assert.deepEqual(
      outcome.ok
        ? outcome.violations.filter((violation) => violation.code === CODE.uncheckedSource)
        : [],
      [],
    );
  });
});
