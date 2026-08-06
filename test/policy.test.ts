/**
 * Tests for policy loading.
 *
 * The load path parses untrusted JSON, so most of what is worth testing is
 * what happens when the JSON is WRONG. The rule this file pins down is the
 * fail-closed one: a malformed value may never make the resulting policy more
 * permissive than what the project asked for. In particular, a broken fix
 * hint must never remove a forbidden-call ban — that is the failure mode where
 * a project reads its own config, believes a call is banned, and it is not.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  DEFAULT_POLICY,
  loadPolicy,
  policyAsDict,
  PolicyError,
  type ForbiddenCall,
} from "../src/policy/policy.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A throwaway project root. `files` maps a filename to its raw contents. */
function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-policy-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, name), contents);
  }
  return root;
}

/** A project whose only config is a `kragg.json` holding this table. */
function configured(table: Readonly<Record<string, unknown>>): string {
  return project({ "kragg.json": JSON.stringify(table) });
}

describe("loadPolicy: defaults", () => {
  it("returns the defaults for a project with no config at all", () => {
    assert.deepEqual(loadPolicy(project({})), DEFAULT_POLICY);
  });

  it("returns the defaults for a package.json with no kragg key", () => {
    const root = project({ "package.json": JSON.stringify({ name: "app" }) });
    assert.deepEqual(loadPolicy(root), DEFAULT_POLICY);
  });

  it("does not read a config value through Object.prototype", () => {
    // A bare index read would resolve `constructor`/`toString` to inherited
    // functions. Nothing inherited may ever become policy.
    const root = project({ "package.json": JSON.stringify({ name: "app" }) });
    const policy = loadPolicy(root);
    assert.equal(typeof policy.profile, "string");
    assert.deepEqual(policy.layers, []);
  });

  it("defaults testPaths to both JS conventions", () => {
    assert.deepEqual(DEFAULT_POLICY.testPaths, ["test", "tests"]);
    assert.deepEqual(DEFAULT_POLICY.sourcePaths, ["src"]);
  });

  it("keeps the Python numeric budgets unchanged", () => {
    assert.equal(DEFAULT_POLICY.coverageFailUnder, 80);
    assert.equal(DEFAULT_POLICY.typeMaxNestingDepth, 2);
    assert.equal(DEFAULT_POLICY.typeMaxLength, 40);
    assert.equal(DEFAULT_POLICY.maxViolationsPerGate, 25);
    assert.equal(DEFAULT_POLICY.maxFileLines, 500);
    assert.equal(DEFAULT_POLICY.maxPublicSymbols, 20);
  });

  it("excludes a bare key suffix from the secret suffixes", () => {
    // Preserved from the Python original: `sortKey` and `cacheKey` are not
    // secrets, and flagging them trains everyone to suppress the gate.
    assert.equal(DEFAULT_POLICY.secretNameSuffixes.includes("Key"), false);
    assert.equal(DEFAULT_POLICY.secretNameSuffixes.includes("ApiKey"), true);
    assert.equal(DEFAULT_POLICY.secretNameSuffixes.length, 10);
  });

  it("includes ServiceKey, which the Python default list lacks", () => {
    // Measured, not guessed: a production repo defaulted three
    // `*_SERVICE_KEY` reads to "" and the gate reported none of them.
    assert.equal(DEFAULT_POLICY.secretNameSuffixes.includes("ServiceKey"), true);
  });

  it("defaults every tool selection to auto-detection", () => {
    assert.equal(DEFAULT_POLICY.lintTool, "auto");
    assert.equal(DEFAULT_POLICY.testRunner, "auto");
    assert.equal(DEFAULT_POLICY.secretScanner, "auto");
    assert.equal(DEFAULT_POLICY.secretBaseline, undefined);
    assert.equal(DEFAULT_POLICY.auditSeverity, "high");
    assert.equal(DEFAULT_POLICY.coverageReportPath, "coverage/coverage-final.json");
  });
});

describe("loadPolicy: closed vocabularies fail closed", () => {
  it("throws on a typo'd tool name rather than degrading to auto", () => {
    // `oxlnt` silently becoming `auto` is the failure this rejects: the
    // project believes it named a linter and no error ever says otherwise.
    assert.throws(() => loadPolicy(configured({ lint_tool: "oxlnt" })), PolicyError);
    assert.throws(() => loadPolicy(configured({ test_runner: "jest" })), PolicyError);
    assert.throws(() => loadPolicy(configured({ secret_scanner: "gitlaeks" })), PolicyError);
    assert.throws(() => loadPolicy(configured({ audit_severity: "info" })), PolicyError);
  });

  it("names the accepted values in the error", () => {
    assert.throws(() => loadPolicy(configured({ lint_tool: "oxlnt" })), {
      message: /must be one of: auto, oxlint, biome, eslint, off/,
    });
  });

  it("throws on a non-string too, rather than falling back", () => {
    assert.throws(() => loadPolicy(configured({ lint_tool: 3 })), PolicyError);
  });

  it("accepts every documented value", () => {
    assert.equal(loadPolicy(configured({ lint_tool: "biome" })).lintTool, "biome");
    assert.equal(loadPolicy(configured({ test_runner: "off" })).testRunner, "off");
    assert.equal(
      loadPolicy(configured({ secret_scanner: "secretlint" })).secretScanner,
      "secretlint",
    );
    assert.equal(loadPolicy(configured({ audit_severity: "low" })).auditSeverity, "low");
  });

  it("degrades a wrong-typed secret_baseline to none", () => {
    // The strict direction: no baseline means nothing is suppressed.
    assert.equal(loadPolicy(configured({ secret_baseline: 7 })).secretBaseline, undefined);
    assert.equal(loadPolicy(configured({ secret_baseline: ".gl" })).secretBaseline, ".gl");
  });
});

describe("loadPolicy: source precedence", () => {
  it("reads package.json#kragg when there is no kragg.json", () => {
    const root = project({
      "package.json": JSON.stringify({ name: "app", kragg: { max_file_lines: 120 } }),
    });
    assert.equal(loadPolicy(root).maxFileLines, 120);
  });

  it("lets kragg.json win outright, with no merging", () => {
    const root = project({
      "kragg.json": JSON.stringify({ max_file_lines: 120 }),
      "package.json": JSON.stringify({
        kragg: { max_file_lines: 999, max_public_symbols: 999 },
      }),
    });
    const policy = loadPolicy(root);
    assert.equal(policy.maxFileLines, 120);
    // Not merged: the package.json value is not consulted at all.
    assert.equal(policy.maxPublicSymbols, DEFAULT_POLICY.maxPublicSymbols);
  });

  it("ignores a kragg key of the wrong shape", () => {
    const root = project({ "package.json": JSON.stringify({ kragg: ["nope"] }) });
    assert.deepEqual(loadPolicy(root), DEFAULT_POLICY);
  });
});

describe("loadPolicy: malformed config files", () => {
  it("throws PolicyError on unparseable JSON rather than using defaults", () => {
    // Degrading to defaults here would run a permissive policy over a project
    // that configured a stricter one, and say nothing about it.
    const root = project({ "kragg.json": "{ not json" });
    assert.throws(() => loadPolicy(root), PolicyError);
  });

  it("throws PolicyError when the config is not a JSON object", () => {
    assert.throws(() => loadPolicy(project({ "kragg.json": "[1, 2]" })), PolicyError);
    assert.throws(() => loadPolicy(project({ "kragg.json": '"hi"' })), PolicyError);
    assert.throws(() => loadPolicy(project({ "kragg.json": "null" })), PolicyError);
  });

  it("throws PolicyError on an unparseable package.json", () => {
    const root = project({ "package.json": "{ oops" });
    assert.throws(() => loadPolicy(root), PolicyError);
  });

  it("names the offending file in the message", () => {
    const root = project({ "kragg.json": "{ not json" });
    assert.throws(() => loadPolicy(root), /kragg\.json/u);
  });
});

describe("loadPolicy: scalar readers", () => {
  it("reads a well-formed string and integer", () => {
    const root = configured({ profile: "house-style", max_file_lines: 250 });
    assert.equal(loadPolicy(root).profile, "house-style");
    assert.equal(loadPolicy(root).maxFileLines, 250);
  });

  it("falls back to the default for a wrong-typed scalar", () => {
    const root = configured({
      profile: 42,
      max_file_lines: "500",
      max_public_symbols: null,
    });
    const policy = loadPolicy(root);
    assert.equal(policy.profile, DEFAULT_POLICY.profile);
    assert.equal(policy.maxFileLines, DEFAULT_POLICY.maxFileLines);
    assert.equal(policy.maxPublicSymbols, DEFAULT_POLICY.maxPublicSymbols);
  });

  it("rejects a boolean where an integer is expected", () => {
    // Python's isinstance(True, int) is true, so TOML `true` would silently
    // become 1. JSON booleans are not numbers here; we take the default.
    const root = configured({ max_file_lines: true });
    assert.equal(loadPolicy(root).maxFileLines, DEFAULT_POLICY.maxFileLines);
  });

  it("rejects a non-integer number rather than rounding it", () => {
    const root = configured({ coverage_fail_under: 82.5 });
    assert.equal(
      loadPolicy(root).coverageFailUnder,
      DEFAULT_POLICY.coverageFailUnder,
    );
  });

  it("accepts an integer-valued JSON number written with a fraction", () => {
    const root = project({ "kragg.json": '{ "coverage_fail_under": 90.0 }' });
    assert.equal(loadPolicy(root).coverageFailUnder, 90);
  });

  it("accepts zero and negative integers verbatim", () => {
    const root = configured({ coverage_fail_under: 0, max_file_lines: -1 });
    assert.equal(loadPolicy(root).coverageFailUnder, 0);
    assert.equal(loadPolicy(root).maxFileLines, -1);
  });
});

describe("loadPolicy: string lists", () => {
  it("accepts a list of strings", () => {
    const root = configured({ source_paths: ["src", "lib"] });
    assert.deepEqual(loadPolicy(root).sourcePaths, ["src", "lib"]);
  });

  it("accepts a bare string as a one-element list", () => {
    const root = configured({ test_paths: "spec" });
    assert.deepEqual(loadPolicy(root).testPaths, ["spec"]);
  });

  it("accepts an empty list, which really means empty", () => {
    const root = configured({ layers: [] });
    assert.deepEqual(loadPolicy(root).layers, []);
  });

  it("falls back when any element is not a string", () => {
    const root = configured({ source_paths: ["src", 7] });
    assert.deepEqual(loadPolicy(root).sourcePaths, DEFAULT_POLICY.sourcePaths);
  });

  it("falls back for a non-list, non-string value", () => {
    const root = configured({ structure_exclude: { a: 1 } });
    assert.deepEqual(
      loadPolicy(root).structureExclude,
      DEFAULT_POLICY.structureExclude,
    );
  });

  it("reads the mutation scope knobs independently", () => {
    const root = configured({
      mutation_include: ["src/core/*"],
      mutation_exclude: ["src/core/generated/*"],
    });
    const policy = loadPolicy(root);
    assert.deepEqual(policy.mutationInclude, ["src/core/*"]);
    assert.deepEqual(policy.mutationExclude, ["src/core/generated/*"]);
  });

  it("returns the default paths when the key is absent", () => {
    const policy = loadPolicy(configured({ profile: "house" }));
    assert.deepEqual(policy.sourcePaths, DEFAULT_POLICY.sourcePaths);
    assert.deepEqual(policy.testPaths, DEFAULT_POLICY.testPaths);
  });
});

describe("loadPolicy: forbidden_calls is fail-closed", () => {
  function forbidden(value: unknown): readonly ForbiddenCall[] {
    return loadPolicy(configured({ forbidden_calls: value })).forbiddenCalls;
  }

  it("reads entry/hint pairs from an object", () => {
    assert.deepEqual(
      forbidden({ "child_process.exec": "use engine/runner.ts" }),
      [["child_process.exec", "use engine/runner.ts"]],
    );
  });

  it("KEEPS the ban when the hint is not a string", () => {
    // The whole point. A typo in the advice must not un-ban the call.
    for (const badHint of [42, null, true, ["a"], { why: "x" }]) {
      assert.deepEqual(
        forbidden({ "child_process.exec": badHint }),
        [["child_process.exec", ""]],
        `hint ${JSON.stringify(badHint)} must degrade, not drop`,
      );
    }
  });

  it("keeps every ban when only some hints are malformed", () => {
    assert.deepEqual(forbidden({ "a.b": "fine", "c.d": 0, "e.f": null }), [
      ["a.b", "fine"],
      ["c.d", ""],
      ["e.f", ""],
    ]);
  });

  it("accepts a bare list of entries, with empty hints", () => {
    assert.deepEqual(forbidden(["z.z", "a.a"]), [
      ["a.a", ""],
      ["z.z", ""],
    ]);
  });

  it("sorts by entry so output is stable across config key order", () => {
    const one = forbidden({ b: "1", a: "2", c: "3" });
    const two = forbidden({ c: "3", a: "2", b: "1" });
    assert.deepEqual(one, two);
    assert.deepEqual(
      one.map(([entry]) => entry),
      ["a", "b", "c"],
    );
  });

  it("treats an empty object as an explicit empty ban list", () => {
    assert.deepEqual(forbidden({}), []);
  });

  it("falls back only when there is no entry to preserve", () => {
    // A scalar or a mixed array carries no recoverable entry, so there is
    // nothing to keep; Python does the same.
    assert.deepEqual(forbidden("child_process.exec"), DEFAULT_POLICY.forbiddenCalls);
    assert.deepEqual(forbidden(42), DEFAULT_POLICY.forbiddenCalls);
    assert.deepEqual(forbidden(["a.a", 7]), DEFAULT_POLICY.forbiddenCalls);
    assert.deepEqual(forbidden(null), DEFAULT_POLICY.forbiddenCalls);
  });

  it("keeps a ban whose key collides with an Object.prototype member", () => {
    assert.deepEqual(forbidden({ constructor: "banned", toString: 5 }), [
      ["constructor", "banned"],
      ["toString", ""],
    ]);
  });
});

describe("policyAsDict", () => {
  it("emits snake_case keys in the Python dataclass field order", () => {
    assert.deepEqual(Object.keys(policyAsDict(DEFAULT_POLICY)), [
      "profile",
      "source_paths",
      "test_paths",
      "coverage_fail_under",
      "type_max_nesting_depth",
      "type_max_length",
      "max_violations_per_gate",
      "layers",
      "max_file_lines",
      "max_public_symbols",
      "structure_exclude",
      "mutation_include",
      "mutation_exclude",
      "forbidden_calls",
      "secret_name_suffixes",
      // TypeScript-only tail: no Python counterpart, so it sorts last and the
      // shared prefix above still diffs key-for-key against `as_dict()`.
      "lint_tool",
      "test_runner",
      "secret_scanner",
      "secret_baseline",
      "audit_severity",
      "coverage_report_path",
    ]);
  });

  it("serializes pairs as two-element arrays", () => {
    const root = configured({ forbidden_calls: { "a.b": "hint" } });
    assert.deepEqual(policyAsDict(loadPolicy(root))["forbidden_calls"], [
      ["a.b", "hint"],
    ]);
  });

  it("round-trips through JSON without loss", () => {
    const root = configured({
      profile: "house",
      layers: ["cli", "core"],
      forbidden_calls: { "a.b": "hint" },
    });
    const dict = policyAsDict(loadPolicy(root));
    assert.deepEqual(JSON.parse(JSON.stringify(dict)), dict);
  });

  it("copies arrays so a caller cannot mutate DEFAULT_POLICY through it", () => {
    const dict = policyAsDict(DEFAULT_POLICY);
    const paths = dict["source_paths"];
    assert.ok(Array.isArray(paths));
    paths.push("injected");
    assert.deepEqual(DEFAULT_POLICY.sourcePaths, ["src"]);
  });
});
