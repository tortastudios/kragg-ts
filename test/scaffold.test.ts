/**
 * Tests for the scaffold surface: `kragg new`, `kragg init`, `kragg gen`.
 *
 * ONE TEST MATTERS MORE THAN THE REST. A scaffold that fails the project's own
 * `typing-strictness` gate is the most embarrassing bug available here: the
 * tool would generate a project and then immediately refuse it. So every kind
 * is scaffolded into a temp directory and run through `checkTypingStrictness`,
 * and the assertion is zero violations AND zero advisories — the advisory
 * bucket included, because a scaffold has no excuse for the flags that are
 * merely "good practice" either.
 *
 * The second-order check is `loadPolicy`: the generated `kragg.json` has to
 * parse under the loader that will read it in anger, with the layers actually
 * set, or the `boundaries` gate is decoration.
 */

import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import ts from "typescript";

import { checkTypingStrictness } from "../src/gates/typingStrictness.ts";
import { DEFAULT_POLICY, loadPolicy } from "../src/policy/policy.ts";
import { KINDS, type Kind } from "../src/scaffold/kinds.ts";
import {
  createNewProject,
  generateModule,
  initializeProject,
  mergeJson,
  planInitialization,
  ScaffoldError,
  writeFiles,
} from "../src/scaffold/project.ts";
import {
  normalizePackageName,
  shadowConflict,
  validatePackageName,
} from "../src/scaffold/naming.ts";

const temporaryRoots: string[] = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** An empty temp directory that is removed when the suite finishes. */
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-scaffold-"));
  temporaryRoots.push(root);
  return root;
}

/** Write a JSON file into `root`, the way a real project would have one. */
function writeJson(root: string, relative: string, value: unknown): void {
  writeFileSync(join(root, relative), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Read a JSON object back out of `root`. */
function readJson(root: string, relative: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(root, relative), "utf8"));
  assert.equal(typeof parsed === "object" && parsed !== null, true, relative);
  return parsed as Record<string, unknown>;
}

/**
 * Every file under `root`, with its contents — the evidence that a dry run
 * wrote nothing. A listing alone would miss a file rewritten in place.
 */
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const relative = prefix === "" ? entry : `${prefix}/${entry}`;
      if (statSync(path).isDirectory()) {
        walk(path, relative);
        continue;
      }
      files[relative] = readFileSync(path, "utf8");
    }
  };
  walk(root, "");
  return files;
}

/** Scaffold `kind` into a fresh temp directory and return its path. */
function scaffolded(kind: Kind, mcpSdk: "fastmcp" | "official" = "fastmcp"): string {
  const root = join(temporaryRoot(), "demo-app");
  createNewProject({ root, projectName: "demo-app", kind, mcpSdk });
  return root;
}

describe("generated projects satisfy the typing-strictness gate", () => {
  for (const kind of KINDS) {
    it(`passes for --kind ${kind}`, () => {
      const outcome = checkTypingStrictness({
        root: scaffolded(kind),
        sourcePaths: ["src"],
        api: ts,
      });
      assert.equal(outcome.ok, true);
      if (!outcome.ok) {
        return;
      }
      assert.deepEqual(
        outcome.violations.map((violation) => `${violation.code}: ${violation.message}`),
        [],
      );
      assert.deepEqual(
        outcome.advisories.map((violation) => `${violation.code}: ${violation.message}`),
        [],
      );
    });
  }

  it("passes for the official MCP SDK too", () => {
    const outcome = checkTypingStrictness({
      root: scaffolded("mcp", "official"),
      sourcePaths: ["src"],
      api: ts,
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.deepEqual(outcome.violations, []);
      assert.deepEqual(outcome.advisories, []);
    }
  });
});

describe("generated kragg.json", () => {
  it("loads through loadPolicy with the layers set", () => {
    const policy = loadPolicy(scaffolded("cli"));
    assert.equal(policy.profile, "strict-ai-typescript");
    assert.deepEqual(policy.sourcePaths, ["src"]);
    assert.deepEqual(policy.testPaths, ["test"]);
    assert.deepEqual(policy.layers, [
      "src/entrypoints",
      "src/services",
      "src/domain",
    ]);
    assert.equal(policy.coverageFailUnder, 80);
  });
});

describe("createNewProject", () => {
  it("writes every guardrail file", () => {
    const root = scaffolded("cli");
    for (const relative of [
      "README.md",
      ".gitignore",
      ".node-version",
      ".npmrc",
      "pnpm-workspace.yaml",
      "package.json",
      "tsconfig.json",
      "kragg.json",
      ".github/workflows/quality.yml",
      ".claude/settings.json",
      ".gemini/settings.json",
      "AGENTS.md",
      "CLAUDE.md",
      "CRITICALITY.md",
    ]) {
      assert.equal(existsSync(join(root, relative)), true, `missing ${relative}`);
    }
  });

  it("reproduces the supply-chain hardening", () => {
    const root = scaffolded("cli");
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    assert.match(workspace, /^ignoreScripts: true$/m);
    assert.match(workspace, /^allowBuilds: \{\}$/m);
    assert.match(workspace, /^minimumReleaseAge: 43200$/m);
    assert.match(readFileSync(join(root, ".npmrc"), "utf8"), /^ignore-scripts=true$/m);
  });

  /**
   * The cooldown exemption is the one setting that varies by kind, and the
   * only place the scaffold weakens its own floor. Two things are asserted
   * because either one alone is a different bug: that the mcp/fastmcp project
   * HAS the exemption (without it its very first `pnpm install` fails, since
   * no version of `@prefecthq/fastmcp-ts` is 30 days old), and that no other
   * kind has it — an exemption that leaked into `cli` would silently drop the
   * cooldown for a project that never needed it.
   */
  it("exempts the young MCP packages from the cooldown, for that kind only", () => {
    const workspace = (root: string): string =>
      readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");

    const mcp = workspace(scaffolded("mcp", "fastmcp"));
    assert.match(mcp, /^minimumReleaseAgeExclude:$/m);
    assert.match(mcp, /^ {2}- "@prefecthq\/fastmcp-ts"$/m);
    // The floor itself must survive intact: exempting names is the mechanism,
    // lowering the cooldown for everything is the mistake it exists to avoid.
    assert.match(mcp, /^minimumReleaseAge: 43200$/m);
    assert.match(mcp, /^minimumReleaseAgeStrict: true$/m);
    // The exemption has to say what it is and when it goes away.
    assert.match(mcp, /REMOVE/);
    assert.match(mcp, /30 days/);

    for (const root of [scaffolded("cli"), scaffolded("api"), scaffolded("mcp", "official")]) {
      const other = workspace(root);
      assert.match(other, /^minimumReleaseAgeExclude: \[\]$/m);
      assert.equal(other.includes("@prefecthq/fastmcp-ts"), false);
    }
  });

  it("warns in the README that the MCP dependency is young", () => {
    const readme = readFileSync(join(scaffolded("mcp", "fastmcp"), "README.md"), "utf8");
    assert.match(readme, /@prefecthq\/fastmcp-ts/);
    assert.match(readme, /minimumReleaseAgeExclude/);
    assert.equal(
      readFileSync(join(scaffolded("cli"), "README.md"), "utf8").includes("fastmcp"),
      false,
    );
  });

  it("creates the layered layout for every kind", () => {
    for (const kind of KINDS) {
      const root = scaffolded(kind);
      assert.equal(existsSync(join(root, "src/domain/messages.ts")), true);
      assert.equal(existsSync(join(root, "src/services/greeting.ts")), true);
      assert.equal(existsSync(join(root, "src/entrypoints/bin.ts")), true);
    }
  });

  it("refuses a non-empty target directory", () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "keep.txt"), "work in progress");
    assert.throws(
      () => createNewProject({ root, projectName: "demo", kind: "cli" }),
      ScaffoldError,
    );
  });

  it("refuses a package name that shadows a Node builtin", () => {
    const root = join(temporaryRoot(), "path");
    assert.throws(
      () => createNewProject({ root, projectName: "path", kind: "cli" }),
      /would shadow the Node builtin module 'path'/,
    );
  });

  it("--allow-shadowing downgrades the refusal to a warning", () => {
    const root = join(temporaryRoot(), "path");
    const result = createNewProject({
      root,
      projectName: "path",
      kind: "cli",
      allowShadowing: true,
    });
    assert.equal(result.written.length > 0, true);
    assert.equal(result.warnings.length, 1);
  });

  it("--package decouples the npm name from the directory name", () => {
    const root = join(temporaryRoot(), "path");
    createNewProject({
      root,
      projectName: "path",
      kind: "cli",
      packageName: "@acme/path-tools",
    });
    const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.equal(
      typeof manifest === "object" && manifest !== null && "name" in manifest
        ? manifest.name
        : null,
      "@acme/path-tools",
    );
  });

  it("rejects an invalid --package outright rather than normalizing it", () => {
    const root = join(temporaryRoot(), "demo");
    assert.throws(
      () =>
        createNewProject({
          root,
          projectName: "demo",
          kind: "cli",
          packageName: "Not Valid",
        }),
      /not a valid npm package name/,
    );
  });
});

describe("initializeProject", () => {
  it("never overwrites an existing file", () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "AGENTS.md"), "MINE\n");
    writeFileSync(join(root, "README.md"), "MINE\n");
    initializeProject(root);
    assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), "MINE\n");
    assert.equal(readFileSync(join(root, "README.md"), "utf8"), "MINE\n");
    assert.equal(existsSync(join(root, "CLAUDE.md")), true);
  });

  it("generates no skeleton code", () => {
    const root = temporaryRoot();
    initializeProject(root);
    assert.equal(existsSync(join(root, "src")), false);
    assert.equal(existsSync(join(root, "test")), false);
  });

  it("leaves layers unset, because the layout is not ours to assume", () => {
    const root = temporaryRoot();
    initializeProject(root);
    assert.deepEqual(loadPolicy(root).layers, []);
  });

  it("merges into an existing package.json instead of clobbering it", () => {
    const root = temporaryRoot();
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify(
        {
          name: "existing",
          version: "3.1.4",
          scripts: { test: "mocha", lint: "eslint ." },
        },
        null,
        2,
      )}\n`,
    );
    initializeProject(root);
    const merged: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.equal(typeof merged === "object" && merged !== null, true);
    const record = merged as Record<string, unknown>;
    assert.equal(record["name"], "existing");
    assert.equal(record["version"], "3.1.4");
    // The four keys that redefine a project rather than adding to it. `type`
    // is the one with teeth: absent means CommonJS, so ADDING it is what
    // breaks the project — see PRESERVED_MANIFEST_KEYS in initPlan.ts.
    assert.equal(record["type"], undefined);
    assert.equal(record["engines"], undefined);
    assert.equal(record["packageManager"], undefined);
    assert.equal(record["private"], undefined);
    const scripts = record["scripts"] as Record<string, unknown>;
    assert.equal(scripts["test"], "mocha", "existing script must survive");
    assert.equal(scripts["lint"], "eslint .");
    assert.equal(scripts["check"], "pnpm exec kragg check");
  });

  it("is idempotent: a second run writes nothing", () => {
    const root = temporaryRoot();
    initializeProject(root);
    assert.deepEqual(initializeProject(root).written, []);
  });

  it("preserves an explicitly declared module mode and toolchain", () => {
    const root = temporaryRoot();
    writeJson(root, "package.json", {
      name: "existing",
      type: "commonjs",
      engines: { node: ">=18" },
      packageManager: "yarn@4.5.0",
      private: false,
    });
    initializeProject(root);
    const record = readJson(root, "package.json");
    assert.equal(record["type"], "commonjs");
    assert.deepEqual(record["engines"], { node: ">=18" });
    assert.equal(record["packageManager"], "yarn@4.5.0");
    assert.equal(record["private"], false);
  });

  it("reports each manifest key it withheld, rather than withholding it silently", () => {
    const root = temporaryRoot();
    writeJson(root, "package.json", { name: "existing" });
    const withheld = initializeProject(root)
      .skipped.filter((skip) => skip.notable)
      .map((skip) => skip.path.replace(`${root}/`, ""));
    assert.deepEqual(withheld.filter((path) => path.startsWith("package.json#")).sort(), [
      "package.json#engines",
      "package.json#packageManager",
      "package.json#private",
      "package.json#type",
    ]);
  });

  it("never shadows a policy embedded in package.json", () => {
    // The reported bug: `kragg.json` wins outright over `package.json#kragg`,
    // so writing a default one replaces every threshold this project tightened.
    const root = temporaryRoot();
    mkdirSync(join(root, "lib"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeJson(root, "package.json", {
      name: "legacy-cjs-app",
      kragg: {
        source_paths: ["lib"],
        test_paths: ["tests"],
        coverage_fail_under: 95,
        type_max_length: 20,
        forbidden_calls: { eval: "never eval" },
      },
    });
    const before = loadPolicy(root);
    const result = initializeProject(root);
    assert.equal(existsSync(join(root, "kragg.json")), false);
    assert.deepEqual(loadPolicy(root), before);
    assert.equal(before.coverageFailUnder, 95);
    assert.match(
      result.skipped.map((skip) => skip.reason).join("\n"),
      /package\.json#kragg/,
    );
  });

  it("leaves an existing kragg.json byte-identical", () => {
    // Merging defaults into a partial config is additive in the file and NOT
    // additive in the effective policy: `test_paths` would go from the loader's
    // ["test", "tests"] down to ["test"].
    const root = temporaryRoot();
    const contents = `{ "coverage_fail_under": 95 }\n`;
    writeFileSync(join(root, "kragg.json"), contents);
    const before = loadPolicy(root);
    initializeProject(root);
    assert.equal(readFileSync(join(root, "kragg.json"), "utf8"), contents);
    assert.deepEqual(loadPolicy(root), before);
    assert.deepEqual(loadPolicy(root).testPaths, ["test", "tests"]);
  });

  it("writes a policy that resolves to the defaults it replaced", () => {
    // A project with no policy at all had the loader's defaults. The generated
    // kragg.json has to mean the same thing, or init weakened something.
    const root = temporaryRoot();
    initializeProject(root);
    assert.deepEqual(loadPolicy(root), DEFAULT_POLICY);
  });

  it("does not assert a layout the project does not have", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "lib"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    const result = initializeProject(root);
    const config = readJson(root, "kragg.json");
    assert.equal(config["source_paths"], undefined, "src/ does not exist here");
    assert.deepEqual(config["test_paths"], ["tests"], "test/ does not exist here");
    assert.deepEqual(loadPolicy(root).testPaths, ["tests"]);
    assert.match(
      result.skipped.map((skip) => `${skip.path}: ${skip.reason}`).join("\n"),
      /source_paths/,
    );
  });

  it("preserves existing hooks, workflows and agent contracts", () => {
    const root = temporaryRoot();
    const existing = {
      ".claude/settings.json": `{ "hooks": { "Stop": [] } }\n`,
      ".github/workflows/quality.yml": "name: mine\n",
      "AGENTS.md": "MINE\n",
    };
    for (const [relative, contents] of Object.entries(existing)) {
      mkdirSync(dirname(join(root, relative)), { recursive: true });
      writeFileSync(join(root, relative), contents);
    }
    const result = initializeProject(root);
    for (const [relative, contents] of Object.entries(existing)) {
      assert.equal(readFileSync(join(root, relative), "utf8"), contents, relative);
      assert.ok(
        result.skipped.some((skip) => skip.path === join(root, relative)),
        `${relative} was not reported as left alone`,
      );
    }
  });

  it("refuses a read-only target instead of half-applying", (t) => {
    if (process.getuid?.() === 0) {
      t.skip("root ignores the write bit");
      return;
    }
    const root = temporaryRoot();
    chmodSync(root, 0o555);
    try {
      assert.throws(() => initializeProject(root), /cannot write to/);
      assert.deepEqual(readdirSync(root), [], "a refused init must write nothing");
    } finally {
      chmodSync(root, 0o755);
    }
  });
});

describe("planInitialization", () => {
  it("writes nothing at all, not even the target directory", () => {
    const root = join(temporaryRoot(), "absent");
    const plan = planInitialization(root);
    assert.equal(existsSync(root), false);
    assert.ok(plan.writes.length > 0, "the plan must still say what it would do");
  });

  it("leaves a populated project byte-for-byte unchanged", () => {
    const root = temporaryRoot();
    writeJson(root, "package.json", { name: "existing", kragg: { coverage_fail_under: 95 } });
    writeFileSync(join(root, "AGENTS.md"), "MINE\n");
    const before = snapshot(root);
    planInitialization(root);
    assert.deepEqual(snapshot(root), before);
  });

  it("plans exactly what a real run then does", () => {
    const root = temporaryRoot();
    writeJson(root, "package.json", { name: "existing" });
    const planned = planInitialization(root);
    const written = initializeProject(root).written;
    assert.deepEqual(
      written.slice().sort(),
      [...planned.writes.map((file) => file.path), ...planned.merges.map((merge) => merge.path)]
        .slice()
        .sort(),
    );
  });
});

describe("mergeJson", () => {
  it("fails loudly on an unparseable file rather than replacing it", () => {
    const root = temporaryRoot();
    const path = join(root, "kragg.json");
    writeFileSync(path, "{ not json");
    assert.throws(() => mergeJson(path, { profile: "x" }), ScaffoldError);
    assert.equal(readFileSync(path, "utf8"), "{ not json");
  });
});

describe("generateModule", () => {
  it("creates domain, service and test slots", () => {
    const root = scaffolded("cli");
    const written = generateModule(root, "user-account").written;
    assert.equal(written.length, 3);
    assert.equal(existsSync(join(root, "src/domain/user-account.ts")), true);
    assert.equal(existsSync(join(root, "src/services/user-account.ts")), true);
    assert.equal(existsSync(join(root, "test/user-account.test.ts")), true);
  });

  it("refuses when the module already exists", () => {
    const root = scaffolded("cli");
    generateModule(root, "billing");
    assert.throws(() => generateModule(root, "billing"), /already exists/);
  });

  it("refuses outside a project root", () => {
    assert.throws(() => generateModule(temporaryRoot(), "billing"), /no src\//);
  });

  it("leaves a generated module passing the typing gate", () => {
    const root = scaffolded("cli");
    generateModule(root, "billing");
    const outcome = checkTypingStrictness({ root, sourcePaths: ["src"], api: ts });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.deepEqual(outcome.violations, []);
    }
  });
});

describe("naming guard", () => {
  it("normalizes a free-form project name", () => {
    assert.equal(normalizePackageName("My Cool App"), "my-cool-app");
    assert.equal(normalizePackageName("_leading"), "leading");
    assert.equal(normalizePackageName("!!!"), "app");
    assert.equal(normalizePackageName("@Acme/My App"), "@acme/my-app");
  });

  it("flags Node builtins in both spellings", () => {
    assert.notEqual(shadowConflict("fs"), null);
    assert.notEqual(shadowConflict("node:fs"), null);
    assert.notEqual(shadowConflict("hono"), null);
    assert.equal(shadowConflict("demo-app"), null);
  });

  it("flags kragg's own published names, both the tool and the npm package", () => {
    assert.notEqual(shadowConflict("kragg"), null);
    assert.notEqual(shadowConflict("kragg-ts"), null);
  });

  it("does not flag a scoped name, which can never shadow", () => {
    assert.equal(shadowConflict("@acme/fs"), null);
  });

  it("enforces npm's name rules", () => {
    assert.equal(validatePackageName("demo-app"), null);
    assert.equal(validatePackageName("@acme/demo"), null);
    assert.notEqual(validatePackageName("Demo"), null);
    assert.notEqual(validatePackageName(".demo"), null);
    assert.notEqual(validatePackageName("_demo"), null);
    assert.notEqual(validatePackageName("demo app"), null);
    assert.notEqual(validatePackageName("@acme"), null);
    assert.notEqual(validatePackageName("a".repeat(215)), null);
  });
});

describe("temp fixtures", () => {
  it("does not leave the scaffold root behind between runs", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "nested"), { recursive: true });
    assert.equal(existsSync(root), true);
  });
});

/**
 * The writer under every scaffold command.
 *
 * It writes what it is handed, and only that: a template slot with nothing in
 * it is skipped rather than written as the string `undefined`, and the
 * decision whether a file may be written at all is made BEFORE this function
 * (`initPlan.ts` for `init`, the empty-directory check for `new`). Both halves
 * are pinned here, because "we replaced your file" is the failure that loses
 * work.
 */
describe("writeFiles", () => {
  it("creates parent directories and returns the paths in sorted order", () => {
    const root = temporaryRoot();
    const written = writeFiles(
      root,
      {
        "src/deep/nested/mod.ts": "export const a = 1;\n",
        "README.md": "# demo\n",
      },
    );
    assert.deepEqual(written, [join(root, "README.md"), join(root, "src/deep/nested/mod.ts")]);
    assert.equal(readFileSync(join(root, "src/deep/nested/mod.ts"), "utf8"), "export const a = 1;\n");
  });

  it("writes exactly what it is handed, so the caller decides what reaches it", () => {
    // `writeFiles` has no overwrite switch any more: `init` plans around
    // existing files before anything is written (see `initPlan.ts`), and
    // `new` refuses a non-empty directory, so by the time a record reaches
    // this function every entry in it is meant to land on disk.
    const root = temporaryRoot();
    writeFileSync(join(root, "keep.txt"), "mine");

    assert.deepEqual(writeFiles(root, { "keep.txt": "theirs" }), [join(root, "keep.txt")]);
    assert.equal(readFileSync(join(root, "keep.txt"), "utf8"), "theirs");
  });

  it("skips a slot with no contents instead of writing the word `undefined`", () => {
    const root = temporaryRoot();
    // The record reaching this function is assembled from template parts, so a
    // key really can survive with nothing behind it. `Object.assign` is how
    // that shape is produced here without weakening the parameter's type.
    const files: Record<string, string> = { "keep.ts": "export const a = 1;\n" };
    Object.assign(files, { "gap.ts": undefined });
    assert.deepEqual(Object.keys(files).sort(), ["gap.ts", "keep.ts"]);

    assert.deepEqual(writeFiles(root, files), [join(root, "keep.ts")]);
    assert.equal(existsSync(join(root, "gap.ts")), false, "an empty slot must not become a file");
  });
});
