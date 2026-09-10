/**
 * Tests for policy VALIDATION: the three states of a setting.
 *
 *   absent     → the default;
 *   configured → honoured exactly, explicit opt-outs included;
 *   invalid    → `PolicyError` naming the file and the setting, never a default.
 *
 * `test/policy.test.ts` covers the per-reader type rules. This file covers
 * what sits above them: unknown keys (the quietest failure — a misspelled key
 * configures nothing and nothing says so), the embedded `package.json#kragg`
 * shape, the explicit opt-outs that must keep loading, and every documented
 * valid configuration in the repo — its own `kragg.json`, the README example
 * and the scaffold's generated config — which must all still load.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import {
  DEFAULT_POLICY,
  declaresPolicy,
  loadPolicy,
  policyAsDict,
  PolicyError,
} from "../src/policy/policy.ts";
import { readTable } from "../src/policy/readers.ts";
import { kraggConfig } from "../src/scaffold/guardrails.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-policy-validation-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, name), contents);
  }
  return root;
}

function configured(table: Readonly<Record<string, unknown>>): string {
  return project({ "kragg.json": JSON.stringify(table) });
}

function embedded(kragg: unknown): string {
  return project({ "package.json": JSON.stringify({ name: "app", kragg }) });
}

describe("loadPolicy: unknown keys are rejected, not ignored", () => {
  it("names the key and suggests the nearest setting when one is obvious", () => {
    // `forbiden_calls` used to configure nothing, silently: the project
    // wrote down a ban and kept reporting green with it doing nothing.
    assert.throws(() => loadPolicy(configured({ forbiden_calls: { "a.b": "x" } })), {
      name: "PolicyError",
      message: /kragg\.json#forbiden_calls is not a kragg setting \(did you mean forbidden_calls\?\)/u,
    });
    assert.throws(() => loadPolicy(configured({ maxFileLines: 100 })), {
      message: /maxFileLines is not a kragg setting \(did you mean max_file_lines\?\)/u,
    });
  });

  it("lists every unknown key in one error", () => {
    assert.throws(() => loadPolicy(configured({ layres: ["a"], profil: "x" })), {
      message: /layres is not a kragg setting \(did you mean layers\?\); .*profil is not a kragg setting \(did you mean profile\?\)/u,
    });
  });

  it("offers no suggestion when nothing is close", () => {
    assert.throws(() => loadPolicy(configured({ banned_imports: ["a"] })), (error: unknown) => {
      assert.ok(error instanceof PolicyError);
      assert.match(error.message, /kragg\.json#banned_imports is not a kragg setting$/u);
      return true;
    });
  });

  it("rejects an unknown key under package.json#kragg with that path", () => {
    assert.throws(() => loadPolicy(embedded({ max_file_lnes: 100 })), {
      message: /package\.json#kragg\.max_file_lnes is not a kragg setting \(did you mean max_file_lines\?\)/u,
    });
  });

  it("rejects an unknown key even when every other setting is valid", () => {
    assert.throws(() => loadPolicy(configured({ layers: ["a"], extra: 1 })), {
      message: /#extra is not a kragg setting/u,
    });
  });

  it("allows $schema, which configures nothing", () => {
    const policy = loadPolicy(
      configured({ $schema: "./node_modules/kragg/kragg.schema.json", layers: ["a"] }),
    );
    assert.deepEqual(policy.layers, ["a"]);
  });

  it("does not consider a prototype member a known key", () => {
    // `constructor` is not a setting; `Object.hasOwn` keeps it from resolving
    // to a function, and the unknown-key check reports it like any other.
    assert.throws(() => loadPolicy(configured({ constructor: "x" })), {
      message: /#constructor is not a kragg setting/u,
    });
  });
});

describe("loadPolicy: the embedded policy shape", () => {
  it("reads defaults when package.json has no kragg key at all", () => {
    const root = project({ "package.json": JSON.stringify({ name: "app" }) });
    assert.deepEqual(loadPolicy(root), DEFAULT_POLICY);
  });

  it("accepts an empty kragg object as explicitly unconfigured", () => {
    assert.deepEqual(loadPolicy(embedded({})), DEFAULT_POLICY);
  });

  it("rejects a kragg key that is not an object, naming the file", () => {
    assert.throws(() => loadPolicy(embedded(["nope"])), {
      name: "PolicyError",
      message: /package\.json#kragg must be a JSON object of kragg settings \(got \["nope"\]\)/u,
    });
    assert.throws(() => loadPolicy(embedded(null)), { message: /\(got null\)/u });
  });

  it("validates values under package.json#kragg exactly as in kragg.json", () => {
    assert.throws(() => loadPolicy(embedded({ forbidden_calls: ["a", 1] })), {
      message: /package\.json#kragg\.forbidden_calls\[1\] must be a string \(got 1\)/u,
    });
  });
});

describe("loadPolicy: deliberate opt-outs load exactly as written", () => {
  it("honours every documented empty, zero, null and off", () => {
    const policy = loadPolicy(
      configured({
        layers: [],
        structure_exclude: [],
        mutation_include: [],
        forbidden_calls: {},
        secret_name_suffixes: [],
        coverage_fail_under: 0,
        max_violations_per_gate: 0,
        type_max_nesting_depth: 0,
        secret_baseline: null,
        lint_tool: "off",
        test_runner: "off",
        secret_scanner: "off",
      }),
    );
    assert.deepEqual(policy.layers, []);
    assert.deepEqual(policy.structureExclude, []);
    assert.deepEqual(policy.mutationInclude, []);
    assert.deepEqual(policy.forbiddenCalls, []);
    assert.deepEqual(policy.secretNameSuffixes, []);
    assert.equal(policy.coverageFailUnder, 0);
    assert.equal(policy.maxViolationsPerGate, 0);
    assert.equal(policy.typeMaxNestingDepth, 0);
    assert.equal(policy.secretBaseline, undefined);
    assert.equal(policy.lintTool, "off");
    assert.equal(policy.testRunner, "off");
    assert.equal(policy.secretScanner, "off");
  });

  it("honours a bare list of bans as an empty-hint ban list", () => {
    assert.deepEqual(loadPolicy(configured({ forbidden_calls: ["b.b", "a.a"] })).forbiddenCalls, [
      ["a.a", ""],
      ["b.b", ""],
    ]);
  });
});

describe("loadPolicy: every documented valid configuration still loads", () => {
  it("loads this repository's own kragg.json, $schema included", () => {
    const policy = loadPolicy(REPO);
    assert.equal(policy.profile, "strict-ai-typescript");
    assert.ok(policy.layers.length > 0);
    assert.deepEqual(policy.forbiddenCalls.map(([entry]) => entry), ["node:child_process"]);
  });

  it("loads the README's configuration example verbatim", () => {
    const readme = readFileSync(join(REPO, "README.md"), "utf8");
    const section = readme.slice(readme.indexOf("## Configuration"));
    const block = /```json\n([\s\S]*?)```/u.exec(section);
    assert.ok(block?.[1] !== undefined, "README has no json block under Configuration");
    const root = project({ "kragg.json": block[1] });
    const dict = policyAsDict(loadPolicy(root));
    assert.deepEqual(dict["layers"], ["src/cli", "src/commands", "src/gates", "src/engine"]);
    assert.deepEqual(dict["forbidden_calls"], [
      ["node:child_process", "use runCommand in src/engine/runner.ts"],
    ]);
  });

  it("loads the scaffold's generated config for every project kind", () => {
    for (const kind of ["cli", "api", "mcp", null] as const) {
      const policy = loadPolicy(configured(kraggConfig(kind)));
      assert.equal(policy.coverageFailUnder, 80, String(kind));
      assert.deepEqual(policy.layers, kind === null ? [] : ["src/entrypoints", "src/services", "src/domain"]);
    }
  });
});

describe("loadPolicy: the error names the file", () => {
  it("prefixes the setting with the absolute path of the file that holds it", () => {
    const root = configured({ max_file_lines: "500" });
    assert.throws(() => loadPolicy(root), {
      message: new RegExp(`^${join(root, "kragg.json").replaceAll(/[.\\/]/gu, "\\$&")}#max_file_lines `, "u"),
    });
  });
});

describe("loadPolicy: test_command is an argv array kragg can read the output of", () => {
  it("accepts the argv form and keeps every element separate", () => {
    const policy = loadPolicy(
      configured({ test_command: ["node", "--import", "tsx", "--test"] }),
    );
    assert.deepEqual(policy.testCommand, ["node", "--import", "tsx", "--test"]);
    assert.deepEqual(policyAsDict(policy)["test_command"], [
      "node",
      "--import",
      "tsx",
      "--test",
    ]);
  });

  it("rejects a shell string, and says why an argv array is required", () => {
    assert.throws(
      () => loadPolicy(configured({ test_command: "node --import tsx --test" })),
      (error: unknown) => {
        assert.ok(error instanceof PolicyError);
        assert.match(error.message, /test_command must be a list of strings/u);
        // The reason, not just the rule: kragg spawns with `shell: false`, so
        // a string is one program name with spaces in it.
        assert.match(error.message, /never a single shell string/u);
        assert.match(error.message, /spawns without a shell/u);
        return true;
      },
    );
  });

  it("rejects a non-string element by index rather than dropping it", () => {
    assert.throws(
      () => loadPolicy(configured({ test_command: ["node", 7] })),
      /test_command\[1\] must be a string/u,
    );
  });

  it("rejects an empty program name", () => {
    assert.throws(
      () => loadPolicy(configured({ test_command: ["", "--test"] })),
      /test_command\[0\] must be the program to run/u,
    );
  });

  it("honours `[]` as the explicit `kragg builds the argv itself`", () => {
    assert.deepEqual(loadPolicy(configured({ test_command: [] })).testCommand, []);
    assert.deepEqual(DEFAULT_POLICY.testCommand, []);
  });

  it("refuses a command whose report format it could not read, naming test_runner", () => {
    // kragg parses the runner's report, and the three formats are unrelated.
    // Exit 2 at load beats discovering it after a suite has run.
    assert.throws(
      () => loadPolicy(configured({ test_command: ["tsx", "--test"] })),
      (error: unknown) => {
        assert.ok(error instanceof PolicyError);
        assert.match(error.message, /test_command runs "tsx"/u);
        assert.match(error.message, /Set `test_runner`/u);
        return true;
      },
    );
    // …and accepts it once the project says which format it produces.
    assert.deepEqual(
      loadPolicy(configured({ test_command: ["tsx", "--test"], test_runner: "node" }))
        .testCommand,
      ["tsx", "--test"],
    );
  });
});

describe("readTable: absent is the ONLY silent outcome", () => {
  // The one file-reading primitive under every policy source, and the one
  // place "the project did not configure kragg" is distinguished from "the
  // project configured kragg and I could not read it". `declaresPolicy` and
  // `loadSource` both lean on that distinction — a workspace member whose
  // malformed `kragg.json` read as `null` would silently inherit the root's
  // rules — so it is asserted directly rather than through a loader.

  it("returns null for a file that is not there, and the parsed object when it is", () => {
    const root = project({ "kragg.json": '{"profile":"strict"}' });
    assert.equal(readTable(join(root, "nope.json")), null);
    // ENOTDIR, not ENOENT: a path THROUGH a file is still "not there".
    assert.equal(readTable(join(root, "kragg.json", "deeper.json")), null);
    assert.deepEqual(readTable(join(root, "kragg.json")), { profile: "strict" });
  });

  it("throws PolicyError for invalid JSON and for a non-object top level", () => {
    const broken = project({ "kragg.json": "{not json" });
    assert.throws(
      () => readTable(join(broken, "kragg.json")),
      (error: unknown) => {
        assert.ok(error instanceof PolicyError);
        assert.match(error.message, /kragg\.json is not valid JSON/u);
        return true;
      },
    );
    const array = project({ "kragg.json": "[1, 2]" });
    assert.throws(
      () => readTable(join(array, "kragg.json")),
      (error: unknown) => {
        assert.ok(error instanceof PolicyError);
        assert.match(error.message, /must contain a JSON object at the top level/u);
        return true;
      },
    );
  });

  it("is what declaresPolicy asks, so a member's own config is never missed", () => {
    // TOR-1371 + TOR-1372: `--package` inherits the root's policy only when
    // the member declares NONE. Both spellings count, and neither is read
    // through a defaulting path.
    assert.equal(declaresPolicy(project({ "kragg.json": "{}" })), true);
    assert.equal(declaresPolicy(project({ "package.json": '{"kragg":{}}' })), true);
    assert.equal(declaresPolicy(project({ "package.json": '{"name":"m"}' })), false);
    assert.equal(declaresPolicy(project({})), false);
  });
});
