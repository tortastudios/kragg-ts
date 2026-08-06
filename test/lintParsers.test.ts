/**
 * Tests for the three linter output parsers.
 *
 * Every payload comes from `fixtures/linterOutput.ts`, which carries the
 * provenance of each shape; nothing here is invented to match the parser.
 *
 * The cases are weighted toward the failure these parsers exist to prevent: a
 * linter that could not run reported as a PASSING GATE. Both Rust linters map
 * "found errors" and "your config is broken" to the same exit code
 * (`apps/oxlint/src/result.rs`; `crates/biome_cli/src/diagnostics.rs`), so for
 * them the shape of stdout is the ONLY discriminator — which is why malformed,
 * truncated, empty, banner-prefixed and merely wrong-shaped output all get
 * explicit coverage, and why all of them must degrade to an error outcome
 * without throwing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseBiomeJson } from "../src/adapters/linters/biome.ts";
import { parseEslintJson, PARSE_ERROR_CODE } from "../src/adapters/linters/eslint.ts";
import type { LintParse } from "../src/adapters/linters/json.ts";
import { parseOxlintJson } from "../src/adapters/linters/oxlint.ts";
import {
  BIOME_CLEAN,
  BIOME_FOUND,
  BIOME_SUMMARY,
  ESLINT_FATAL_MESSAGE,
  ESLINT_FOUND,
  OXLINT_CLEAN,
  OXLINT_FOUND,
  ROOT,
} from "./fixtures/linterOutput.ts";

function assertOk(parse: LintParse): asserts parse is Extract<LintParse, { ok: true }> {
  assert.equal(parse.ok, true, parse.ok ? "" : parse.message);
}

describe("parseOxlintJson", () => {
  it("reads a clean run as zero violations", () => {
    const parse = parseOxlintJson(OXLINT_CLEAN, ROOT);
    assertOk(parse);
    assert.deepEqual(parse.violations, []);
  });

  it("maps every field the schema promises", () => {
    const parse = parseOxlintJson(OXLINT_FOUND, ROOT);
    assertOk(parse);
    assert.equal(parse.violations.length, 3);
    assert.deepEqual(parse.violations[0], {
      message: "`debugger` statement is not allowed",
      file: "src/a.ts",
      line: 3,
      column: 1,
      code: "eslint(no-debugger)",
      fixHint: "Remove the debugger statement",
    });
    // No `help` on this rule, so no fix hint is invented.
    assert.equal(parse.violations[1]?.fixHint, undefined);
    assert.equal(parse.violations[1]?.code, "eslint(no-unused-vars)");
  });

  it("drops a null line/column rather than reporting file:0:0", () => {
    const parse = parseOxlintJson(OXLINT_FOUND, ROOT);
    assertOk(parse);
    assert.equal(parse.violations[2]?.file, "src/c.ts");
    assert.equal(parse.violations[2]?.line, undefined);
    assert.equal(parse.violations[2]?.column, undefined);
  });

  it("makes an absolute filename repo-relative", () => {
    const payload = JSON.stringify({
      diagnostics: [
        {
          message: "m",
          severity: "error",
          causes: [],
          filename: `${ROOT}/src/a.ts`,
          labels: [],
          related: [],
        },
      ],
      number_of_files: 1,
    });
    const parse = parseOxlintJson(payload, ROOT);
    assertOk(parse);
    assert.equal(parse.violations[0]?.file, "src/a.ts");
  });

  it("keeps a path outside the root absolute instead of growing ../..", () => {
    const payload = JSON.stringify({
      diagnostics: [
        {
          message: "m",
          severity: "error",
          causes: [],
          filename: "/elsewhere/a.ts",
          labels: [],
          related: [],
        },
      ],
      number_of_files: 1,
    });
    const parse = parseOxlintJson(payload, ROOT);
    assertOk(parse);
    assert.equal(parse.violations[0]?.file, "/elsewhere/a.ts");
  });

  it("errors on empty, malformed and truncated output without throwing", () => {
    for (const bad of ["", "   ", "oxlint: unknown option `--nope`", "not json at all"]) {
      assert.equal(parseOxlintJson(bad, ROOT).ok, false, `expected failure for ${JSON.stringify(bad)}`);
    }
    // A payload cut off mid-write: the crash case the envelope check exists
    // for. It has no closing brace, so the banner-tolerant retry in
    // `parseJsonPayload` cannot rescue it into a false success.
    assert.equal(parseOxlintJson(OXLINT_FOUND.slice(0, 160), ROOT).ok, false);
  });

  it("errors on valid JSON that is not oxlint's envelope", () => {
    for (const bad of ["{}", "[]", '{"diagnostics": null}', '{"errors": []}', "null", "42"]) {
      assert.equal(parseOxlintJson(bad, ROOT).ok, false, bad);
    }
  });
});

describe("parseBiomeJson", () => {
  it("reads a clean run as zero violations", () => {
    const parse = parseBiomeJson(BIOME_CLEAN, ROOT);
    assertOk(parse);
    assert.deepEqual(parse.violations, []);
  });

  it("maps category to code and advices to a fix hint", () => {
    const parse = parseBiomeJson(BIOME_FOUND, ROOT);
    assertOk(parse);
    assert.deepEqual(parse.violations[0], {
      message: "This import is unused.",
      file: "index.ts",
      line: 1,
      column: 8,
      code: "lint/correctness/noUnusedImports",
      fixHint: "auto-fixable: run `biome check --write`",
    });
    assert.equal(parse.violations[1]?.fixHint, undefined);
  });

  it("drops biome's 0,0 no-span fallback", () => {
    const parse = parseBiomeJson(BIOME_FOUND, ROOT);
    assertOk(parse);
    assert.equal(parse.violations[2]?.file, "huge.ts");
    assert.equal(parse.violations[2]?.line, undefined);
    assert.equal(parse.violations[2]?.column, undefined);
  });

  it("treats a configuration diagnostic as a tool failure, not a finding", () => {
    // Biome routes config errors through the SAME diagnostics array as lint
    // findings and exits with the same status. Reporting this as a code
    // violation would send someone to fix their source over a broken
    // biome.json.
    const payload = JSON.stringify({
      summary: BIOME_SUMMARY,
      diagnostics: [
        {
          severity: "error",
          message: "Found an unknown key `linterr`.",
          category: "configuration",
          location: {
            path: "biome.json",
            start: { line: 3, column: 3 },
            end: { line: 3, column: 11 },
          },
          advices: [],
        },
      ],
      command: "check",
    });
    const parse = parseBiomeJson(payload, ROOT);
    assert.equal(parse.ok, false);
    if (!parse.ok) {
      assert.match(parse.message, /could not complete the check \[configuration\]/);
    }
  });

  it("treats a fatal severity as a tool failure whatever its category", () => {
    const payload = JSON.stringify({
      summary: BIOME_SUMMARY,
      diagnostics: [{ severity: "fatal", message: "the scanner died", advices: [] }],
      command: "check",
    });
    assert.equal(parseBiomeJson(payload, ROOT).ok, false);
  });

  it("does not mistake a lint category for a configuration one", () => {
    // `configuration` is matched as a whole segment; a rule whose category
    // merely starts with the same letters is a finding.
    const payload = JSON.stringify({
      summary: BIOME_SUMMARY,
      diagnostics: [
        {
          severity: "error",
          message: "Avoid this.",
          category: "lint/nursery/useConfigurationFile",
          location: { path: "a.ts", start: { line: 2, column: 1 }, end: { line: 2, column: 4 } },
          advices: [],
        },
      ],
      command: "check",
    });
    const parse = parseBiomeJson(payload, ROOT);
    assertOk(parse);
    assert.equal(parse.violations.length, 1);
  });

  it("tolerates the experimental-reporter banner on the same stream", () => {
    // Biome prints it to stderr today, but a linter that emits one extra line
    // must not read as a crashed linter.
    const banner =
      "The `json` and `json-pretty` reporters are experimental and may change in patch releases.\n";
    const parse = parseBiomeJson(banner + BIOME_FOUND, ROOT);
    assertOk(parse);
    assert.equal(parse.violations.length, 3);
  });

  it("errors on empty, malformed and truncated output without throwing", () => {
    for (const bad of ["", "error: biome.json is not valid JSON", "{", BIOME_FOUND.slice(0, 200)]) {
      assert.equal(parseBiomeJson(bad, ROOT).ok, false);
    }
  });
});

describe("parseEslintJson", () => {
  it("reads a clean run as zero violations", () => {
    const parse = parseEslintJson("[]", ROOT);
    assertOk(parse);
    assert.deepEqual(parse.violations, []);
  });

  it("flattens results to violations and makes filePath repo-relative", () => {
    const parse = parseEslintJson(ESLINT_FOUND, ROOT);
    assertOk(parse);
    assert.equal(parse.violations.length, 2);
    assert.deepEqual(parse.violations[0], {
      message: "'x' is defined but never used.",
      file: "src/a.ts",
      line: 3,
      column: 7,
      code: "no-unused-vars",
      fixHint: "auto-fixable: run `eslint --fix`",
    });
  });

  it("prefers `fix` over `suggestions`, and never promises --fix for a suggestion", () => {
    // `--fix` never applies suggestions, by ESLint's design, so naming it for
    // a suggestion-only message would promise a fix that never arrives.
    const parse = parseEslintJson(ESLINT_FOUND, ROOT);
    assertOk(parse);
    assert.equal(parse.violations[1]?.fixHint, "suggested fix: Replace 'let' with 'const'");
  });

  it("ignores suppressedMessages", () => {
    const parse = parseEslintJson(ESLINT_FOUND, ROOT);
    assertOk(parse);
    assert.equal(
      parse.violations.some((item) => item.code === "no-console"),
      false,
    );
  });

  it("keeps a fatal parse error as a violation, not a tool failure", () => {
    // A `fatal` message is a syntax error in one FILE. ESLint counts it,
    // keeps going, and exits 1. Only exit 2 means ESLint itself did not run.
    const parse = parseEslintJson(ESLINT_FATAL_MESSAGE, ROOT);
    assertOk(parse);
    assert.equal(parse.violations[0]?.code, PARSE_ERROR_CODE);
    assert.equal(parse.violations[0]?.file, "src/broken.ts");
  });

  it("errors on empty, malformed and non-array output without throwing", () => {
    const cases = [
      "",
      "Oops! Something went wrong! :(",
      "{}",
      '{"results": []}',
      ESLINT_FOUND.slice(0, 90),
    ];
    for (const bad of cases) {
      assert.equal(parseEslintJson(bad, ROOT).ok, false, bad);
    }
  });
});
