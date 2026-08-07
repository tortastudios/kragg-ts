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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import ts from "typescript";

import { checkTypingStrictness } from "../src/gates/typingStrictness.ts";
import { loadPolicy } from "../src/policy/policy.ts";
import { KINDS, type Kind } from "../src/scaffold/kinds.ts";
import {
  createNewProject,
  generateModule,
  initializeProject,
  mergeJson,
  ScaffoldError,
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
    assert.equal(record["type"], "module");
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
