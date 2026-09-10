/**
 * The throwaway project the `tools` lane points each real tool at.
 *
 * Split out of `tools.ts` to keep both files inside the repository's 500-line
 * budget, and because they answer different questions: this one is "what does
 * a project configured for vitest + biome look like on disk", `tools.ts` is
 * "what did kragg make of the output".
 *
 * ── PINS, AND WHAT UPDATING THEM MEANS ─────────────────────────────────────
 * `VERSIONS` is exact — no ranges, per the repository's standing dependency
 * policy — even though these packages are NOT dependencies of kragg: they are
 * installed into a fixture under the OS temp directory and never enter
 * `package.json` or `pnpm-lock.yaml`. Pinning them is what makes a red row
 * mean "the tool changed" rather than "today's `latest` differs from
 * yesterday's". Bumping a pin is the entire maintenance ritual of the lane,
 * and a bump that turns a row red is the lane doing its job.
 *
 * `bun` cannot be pinned here: its npm package installs the binary from a
 * lifecycle script, which this repository forbids running. bun rows use a bun
 * already on PATH and SKIP with a reason when there is none.
 */

import { tarballSpecifier } from "./support.ts";

/** A test runner `src/adapters/support/detect.ts` claims to support. */
export type Runner = "vitest" | "node" | "bun";

/** A linter `src/adapters/lint.ts` claims to support. */
export type Linter = "oxlint" | "biome" | "eslint";

/** One matrix row: which tools the fixture is configured for. */
export interface RowSpec {
  readonly row: string;
  readonly runner: Runner;
  readonly linter: Linter;
  /** Whether to install secretlint and plant a credential for it to find. */
  readonly scanner: boolean;
}

/** Exact pins. See the header: bumping one is the maintenance ritual. */
const VERSIONS: Readonly<Record<string, string>> = {
  "@biomejs/biome": "2.5.12",
  "@secretlint/secretlint-rule-preset-recommend": "13.0.5",
  "@types/node": "24.12.4",
  "@vitest/coverage-v8": "5.0.0",
  eslint: "10.10.0",
  oxlint: "1.73.0",
  secretlint: "13.0.5",
  typescript: "6.0.3",
  "typescript-eslint": "8.70.0",
  vitest: "5.0.0",
};


/**
 * The fixture: one clean function with a test, one file with one lint finding.
 *
 * The finding is a `debugger` statement, which every one of the three linters
 * reports by default under a rule this fixture also names explicitly, so a row
 * that goes green did so because the linter found the thing it was pointed at
 * — not because a formatting preference happened to differ.
 */
export function toolFixtureFiles(tarball: string, spec: RowSpec): Readonly<Record<string, string>> {
  const files: Record<string, string> = {
    "package.json": manifest(tarball, spec),
    "tsconfig.json": TSCONFIG,
    "kragg.json": `${JSON.stringify({ source_paths: ["src"], test_paths: ["test"] }, null, 2)}\n`,
    "src/greet.ts": "export function greet(name: string): string {\n  return `hello, ${name}`;\n}\n",
    "src/bad.ts": "export function bad(): void {\n  debugger;\n}\n",
    ...linterConfig(spec.linter),
    ...testFiles(spec.runner),
  };
  if (spec.scanner) {
    Object.assign(files, scannerFiles());
  }
  return files;
}

function manifest(tarball: string, spec: RowSpec): string {
  const devDependencies: Record<string, string> = {
    "@types/node": pin("@types/node"),
    "kragg-ts": tarballSpecifier(tarball),
    typescript: pin("typescript"),
  };
  if (spec.runner === "vitest") {
    devDependencies["vitest"] = pin("vitest");
    devDependencies["@vitest/coverage-v8"] = pin("@vitest/coverage-v8");
  }
  if (spec.linter === "oxlint") {
    devDependencies["oxlint"] = pin("oxlint");
  }
  if (spec.linter === "biome") {
    devDependencies["@biomejs/biome"] = pin("@biomejs/biome");
  }
  if (spec.linter === "eslint") {
    devDependencies["eslint"] = pin("eslint");
    devDependencies["typescript-eslint"] = pin("typescript-eslint");
  }
  if (spec.scanner) {
    devDependencies["secretlint"] = pin("secretlint");
    devDependencies["@secretlint/secretlint-rule-preset-recommend"] = pin(
      "@secretlint/secretlint-rule-preset-recommend",
    );
  }
  const test =
    spec.runner === "vitest" ? "vitest run" : spec.runner === "bun" ? "bun test" : "node --test";
  return `${JSON.stringify(
    {
      name: `kragg-tools-fixture-${spec.row.replace("+", "-")}`,
      version: "0.0.0",
      private: true,
      type: "module",
      scripts: { test },
      devDependencies,
    },
    null,
    2,
  )}\n`;
}

function pin(name: string): string {
  const version = VERSIONS[name];
  if (version === undefined) {
    throw new Error(`no pinned version for ${name}`);
  }
  return version;
}

/** Per-linter config, each naming the rule the fixture's finding trips. */
function linterConfig(linter: Linter): Readonly<Record<string, string>> {
  if (linter === "oxlint") {
    return {
      ".oxlintrc.json": `${JSON.stringify(
        { categories: { correctness: "error" }, rules: { "no-debugger": "error" } },
        null,
        2,
      )}\n`,
    };
  }
  if (linter === "biome") {
    return {
      "biome.json": `${JSON.stringify(
        {
          $schema: `https://biomejs.dev/schemas/${pin("@biomejs/biome")}/schema.json`,
          formatter: { enabled: false },
          linter: { enabled: true, rules: { suspicious: { noDebugger: "error" } } },
        },
        null,
        2,
      )}\n`,
    };
  }
  return {
    "eslint.config.mjs": [
      'import tseslint from "typescript-eslint";',
      "",
      "export default tseslint.config({",
      '  files: ["src/**/*.ts"],',
      "  languageOptions: { parser: tseslint.parser },",
      '  rules: { "no-debugger": "error" },',
      "});",
      "",
    ].join("\n"),
  };
}

/** One passing test per runner, in that runner's own dialect. */
function testFiles(runner: Runner): Readonly<Record<string, string>> {
  if (runner === "vitest") {
    return {
      "test/greet.test.ts": [
        'import { expect, test } from "vitest";',
        "",
        'import { bad } from "../src/bad.ts";',
        'import { greet } from "../src/greet.ts";',
        "",
        'test("greet", () => {',
        '  expect(greet("x")).toBe("hello, x");',
        "  bad();",
        "});",
        "",
      ].join("\n"),
    };
  }
  if (runner === "bun") {
    return {
      "bunfig.toml": "[test]\n",
      "test/greet.test.ts": [
        'import { expect, test } from "bun:test";',
        "",
        'import { bad } from "../src/bad.ts";',
        'import { greet } from "../src/greet.ts";',
        "",
        'test("greet", () => {',
        '  expect(greet("x")).toBe("hello, x");',
        "  bad();",
        "});",
        "",
      ].join("\n"),
    };
  }
  return {
    "test/greet.test.ts": [
      'import assert from "node:assert/strict";',
      'import { test } from "node:test";',
      "",
      'import { bad } from "../src/bad.ts";',
      'import { greet } from "../src/greet.ts";',
      "",
      'test("greet", () => {',
      '  assert.equal(greet("x"), "hello, x");',
      "  bad();",
      "});",
      "",
    ].join("\n"),
  };
}

/**
 * The scanner fixture: one planted credential, outside `src`.
 *
 * OUTSIDE `src` on purpose. `detect-secrets` scans the whole project (secrets
 * hide in `.env` files and CI workflows, not only in source), while the
 * coverage gate judges `source_paths` — so a planted secret under `src/` would
 * fail the row for being uncovered, which says nothing about the scanner.
 *
 * SPLIT INTO PIECES on purpose, too. The value is synthetic, but it is shaped
 * exactly like the thing scanners look for, and kragg runs `detect-secrets`
 * over its own tree: a 40-character literal here would be a finding in THIS
 * repository the moment anyone installs a scanner. Neither half matches the
 * rule's pattern on its own; only the concatenation does. AWS's published
 * example key (`AKIAIOSFODNN7EXAMPLE`) was tried first and is deliberately
 * allowlisted by `@secretlint/secretlint-rule-aws`, so it proves nothing.
 */
function scannerFiles(): Readonly<Record<string, string>> {
  const keyId = `AKIA${"ZQ3XN7T4QK6HL2VB"}`;
  const secret = `${"kR7pLxQ2mNvT5wZ8"}${"aCeF1gHj4KdSb0Yu"}${"Xi3OpQrW"}`;
  return {
    ".secretlintrc.json": `${JSON.stringify(
      { rules: [{ id: "@secretlint/secretlint-rule-preset-recommend" }] },
      null,
      2,
    )}\n`,
    "leaked.env": `AWS_ACCESS_KEY_ID=${keyId}\nAWS_SECRET_ACCESS_KEY=${secret}\n`,
  };
}

/** Strict enough that `typing-strictness` passes; `src` only, so test dialects vary freely. */
const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: "es2023",
      lib: ["es2023"],
      module: "nodenext",
      moduleResolution: "nodenext",
      types: ["node"],
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noImplicitOverride: true,
      noFallthroughCasesInSwitch: true,
      noImplicitReturns: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noPropertyAccessFromIndexSignature: true,
      useUnknownInCatchVariables: true,
      allowUnusedLabels: false,
      allowUnreachableCode: false,
      verbatimModuleSyntax: true,
      isolatedModules: true,
      erasableSyntaxOnly: true,
      forceConsistentCasingInFileNames: true,
      allowImportingTsExtensions: true,
      rewriteRelativeImportExtensions: true,
      skipLibCheck: false,
      noEmit: true,
    },
    include: ["src/**/*.ts"],
  },
  null,
  2,
)}\n`;
