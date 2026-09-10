/**
 * Tests for policy loading.
 *
 * The load path parses untrusted JSON, so most of what is worth testing is
 * what happens when the JSON is WRONG. The rule this file pins down is the
 * fail-closed one: a malformed value may never make the resulting policy more
 * permissive than what the project asked for — and since kragg cannot know
 * what a malformed value meant, it REJECTS it by name rather than guessing a
 * default. In particular, a broken fix hint must never remove a forbidden-call
 * ban — that is the failure mode where a project reads its own config,
 * believes a call is banned, and it is not. `test/policyValidation.test.ts`
 * covers unknown keys, ranges and the documented valid configurations.
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
  type CriticalDeclaration,
  type ForbiddenCall,
} from "../src/policy/policy.ts";
import { isTable, own } from "../src/policy/readers.ts";

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

  it("rejects a wrong-typed secret_baseline; null is the explicit none", () => {
    // Reading `7` as "no baseline" would be the strict direction, but it is
    // still a guess about what the project meant; the setting is named instead.
    assert.throws(() => loadPolicy(configured({ secret_baseline: 7 })), {
      name: "PolicyError",
      message: /kragg\.json#secret_baseline must be a string or null \(got 7\)/u,
    });
    assert.equal(loadPolicy(configured({ secret_baseline: null })).secretBaseline, undefined);
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

  it("rejects a kragg key of the wrong shape, naming package.json#kragg", () => {
    // The project wrote a policy block; running the defaults in its place
    // is the silent fall-back the loader refuses everywhere else.
    for (const kragg of [["nope"], "nope", 7, null, true]) {
      const root = project({ "package.json": JSON.stringify({ kragg }) });
      assert.throws(() => loadPolicy(root), {
        name: "PolicyError",
        message: /package\.json#kragg must be a JSON object/u,
      });
    }
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

  it("rejects a wrong-typed scalar, naming the setting and what was found", () => {
    // `max_file_lines: "100"` used to silently read as the 500 default: a
    // budget the project tightened, quietly loosened again.
    assert.throws(() => loadPolicy(configured({ profile: 42 })), {
      message: /kragg\.json#profile must be a string \(got 42\)/u,
    });
    assert.throws(() => loadPolicy(configured({ max_file_lines: "100" })), {
      message: /kragg\.json#max_file_lines must be an integer of at least 0 \(got "100"\)/u,
    });
    assert.throws(() => loadPolicy(configured({ max_public_symbols: null })), {
      message: /kragg\.json#max_public_symbols must be an integer/u,
    });
  });

  it("rejects a boolean where an integer is expected", () => {
    // Python's isinstance(True, int) is true, so TOML `true` would silently
    // become 1. JSON booleans are not numbers here, and are named as such.
    assert.throws(() => loadPolicy(configured({ max_file_lines: true })), {
      name: "PolicyError",
      message: /max_file_lines must be an integer of at least 0 \(got true\)/u,
    });
  });

  it("rejects a non-integer number rather than rounding it", () => {
    assert.throws(() => loadPolicy(configured({ coverage_fail_under: 82.5 })), {
      name: "PolicyError",
      message: /coverage_fail_under must be an integer from 0 to 100 \(got 82\.5\)/u,
    });
  });

  it("accepts an integer-valued JSON number written with a fraction", () => {
    const root = project({ "kragg.json": '{ "coverage_fail_under": 90.0 }' });
    assert.equal(loadPolicy(root).coverageFailUnder, 90);
  });

  it("accepts zero verbatim: it is the documented opt-out, not a default", () => {
    const root = configured({ coverage_fail_under: 0, max_violations_per_gate: 0 });
    assert.equal(loadPolicy(root).coverageFailUnder, 0);
    assert.equal(loadPolicy(root).maxViolationsPerGate, 0);
  });

  it("rejects a negative count and a percentage above 100", () => {
    assert.throws(() => loadPolicy(configured({ max_file_lines: -1 })), {
      message: /max_file_lines must be an integer of at least 0 \(got -1\)/u,
    });
    assert.throws(() => loadPolicy(configured({ coverage_fail_under: 250 })), {
      message: /coverage_fail_under must be an integer from 0 to 100 \(got 250\)/u,
    });
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

  it("rejects a non-string element by index rather than dropping the list", () => {
    // `layers: ["src/cli", 3]` used to read as "no layers", which switched
    // the boundaries gate off with no error anywhere.
    assert.throws(() => loadPolicy(configured({ source_paths: ["src", 7] })), {
      name: "PolicyError",
      message: /kragg\.json#source_paths\[1\] must be a string \(got 7\)/u,
    });
    assert.throws(() => loadPolicy(configured({ layers: ["src/cli", 3] })), {
      message: /kragg\.json#layers\[1\] must be a string \(got 3\)/u,
    });
  });

  it("rejects a non-list, non-string value, naming the setting", () => {
    assert.throws(() => loadPolicy(configured({ structure_exclude: { a: 1 } })), {
      name: "PolicyError",
      message: /kragg\.json#structure_exclude must be a string or a list of strings \(got \{"a":1\}\)/u,
    });
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

  it("REJECTS a malformed hint by entry; the ban is never silently altered", () => {
    // The whole point. A typo in the advice must not un-ban the call, and it
    // must not be quietly repaired either: the load stops (exit 2, no report)
    // with the entry named, so the project fixes the hint and keeps the ban.
    for (const badHint of [42, null, true, ["a"], { why: "x" }]) {
      assert.throws(
        () => forbidden({ "child_process.exec": badHint }),
        {
          name: "PolicyError",
          message: /kragg\.json#forbidden_calls\["child_process\.exec"\] must be a string/u,
        },
        `hint ${JSON.stringify(badHint)} must be rejected by name`,
      );
    }
  });

  it("names the one malformed hint when the others are fine", () => {
    assert.throws(() => forbidden({ "a.b": "fine", "c.d": 0, "e.f": "fine" }), {
      message: /forbidden_calls\["c\.d"\] must be a string \(got 0\)/u,
    });
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

  it("rejects a mixed list by index instead of dropping every ban", () => {
    // `["node:child_process", 7]` used to fall back to the EMPTY default,
    // un-banning child_process with no error anywhere. Python still does.
    assert.throws(() => forbidden(["a.a", 7]), {
      name: "PolicyError",
      message: /kragg\.json#forbidden_calls\[1\] must be a string \(got 7\)/u,
    });
  });

  it("rejects a value of the wrong shape, naming the setting", () => {
    for (const value of ["child_process.exec", 42, null, true]) {
      assert.throws(
        () => forbidden(value),
        {
          name: "PolicyError",
          message: /kragg\.json#forbidden_calls must be an object of banned call to fix hint, or a list of strings/u,
        },
        `value ${JSON.stringify(value)}`,
      );
    }
  });

  it("keeps a ban whose key collides with an Object.prototype member", () => {
    assert.deepEqual(forbidden({ constructor: "banned", toString: "also" }), [
      ["constructor", "banned"],
      ["toString", "also"],
    ]);
    assert.throws(() => forbidden({ toString: 5 }), {
      message: /forbidden_calls\["toString"\] must be a string \(got 5\)/u,
    });
  });
});

describe("loadPolicy: critical_functions requires a reviewed reason", () => {
  function declared(value: unknown): readonly CriticalDeclaration[] {
    return loadPolicy(configured({ critical_functions: value })).criticalFunctions;
  }

  it("reads name/reason pairs, sorted by name", () => {
    assert.deepEqual(
      declared({
        "src/billing/charge#capture": "moves money",
        "src/auth/login#verifyPassword": "authorization entrypoint",
      }),
      [
        ["src/auth/login#verifyPassword", "authorization entrypoint"],
        ["src/billing/charge#capture", "moves money"],
      ],
    );
  });

  it("treats an empty object as an explicit empty list", () => {
    assert.deepEqual(declared({}), []);
    assert.deepEqual(loadPolicy(project({})).criticalFunctions, []);
  });

  it("REJECTS a declaration with no usable reason", () => {
    // A declaration says a HUMAN decided this function is high-consequence.
    // Without the reason there is nothing for the next reviewer to check, so
    // an empty or non-string reason is rejected by name rather than repaired
    // to "" the way a `forbidden_calls` hint may be omitted.
    for (const reason of ["", "   ", 1, null, true, ["why"], {}]) {
      assert.throws(
        () => declared({ "src/a#f": reason }),
        {
          name: "PolicyError",
          message:
            /kragg\.json#critical_functions\["src\/a#f"\] must be a non-empty string saying why/u,
        },
        `reason ${JSON.stringify(reason)} must be rejected`,
      );
    }
  });

  it("REJECTS a name that is not in `module#function` form", () => {
    // A bare name can never match a call-graph node, so it would be reported
    // as a stale declaration on every run. Catch the typo at load time.
    for (const name of ["verifyPassword", "#verifyPassword", "src/auth/login#"]) {
      assert.throws(
        () => declared({ [name]: "authorization" }),
        {
          name: "PolicyError",
          message: /must be named "<module>#<function>"/u,
        },
        `name ${JSON.stringify(name)} must be rejected`,
      );
    }
  });

  it("rejects a list: there is nowhere in one to put the reason", () => {
    for (const value of [["src/a#f"], "src/a#f", 42, null, true]) {
      assert.throws(
        () => declared(value),
        {
          name: "PolicyError",
          message:
            /kragg\.json#critical_functions must be an object of "module#function" to the reason/u,
        },
        `value ${JSON.stringify(value)}`,
      );
    }
  });

  it("keeps a declaration whose key collides with an Object.prototype member", () => {
    assert.deepEqual(declared({ "src/a#constructor": "builds it" }), [
      ["src/a#constructor", "builds it"],
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
      "critical_functions",
      "lint_tool",
      "test_runner",
      "secret_scanner",
      "secret_baseline",
      "audit_severity",
      "coverage_report_path",
      "baseline",
    ]);
  });

  it("reads the legacy-debt baseline path, with null as the explicit none", () => {
    // TOR-1377: absent and null both mean "no baseline"; a wrong type is
    // rejected by name rather than read as none.
    assert.equal(loadPolicy(configured({})).baseline, undefined);
    assert.equal(loadPolicy(configured({ baseline: null })).baseline, undefined);
    assert.equal(loadPolicy(configured({ baseline: ".kragg/baseline.json" })).baseline, ".kragg/baseline.json");
    assert.equal(policyAsDict(loadPolicy(configured({})))["baseline"], null);
    assert.throws(() => loadPolicy(configured({ baseline: true })), {
      message: /kragg\.json#baseline must be a string or null \(got true\)/u,
    });
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

/**
 * The two readers every policy key goes through. `own` is the reason a
 * config key named `constructor` cannot hand a function to a narrowing
 * helper: config is attacker-influenced input.
 */
describe("readers: isTable / own", () => {
  it("accepts only a plain object as a table", () => {
    assert.equal(isTable({}), true);
    assert.equal(isTable({ source_paths: ["src"] }), true);
    assert.equal(isTable([]), false);
    assert.equal(isTable(null), false);
    assert.equal(isTable("src"), false);
  });

  it("reads own properties only, never the prototype", () => {
    assert.equal(own({ profile: "strict" }, "profile"), "strict");
    assert.equal(own({ profile: "strict" }, "missing"), undefined);
    assert.equal(own({}, "constructor"), undefined);
    assert.equal(own({}, "toString"), undefined);
  });
});
