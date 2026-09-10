/**
 * Tests for project-environment resolution.
 *
 * Uses Node's built-in `node:test` + `node:assert/strict` — no test framework
 * dependency (see docs/dependency-policy.md).
 *
 * The behaviours covered here are the ones where being wrong is worse than
 * failing: package-manager precedence (a wrong answer runs the wrong install
 * command against a user's repo), project-local binary resolution (a global
 * binary produces results that do not reproduce in CI), and missing-tool
 * detection (which decides exit 3 vs exit 1).
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { CompletedCommand } from "../src/engine/models.ts";
import { readJsonObject } from "../src/environment/manifest.ts";
import {
  describe as describeEnvironment,
  detectPackageManager,
  detectWorkspaces,
  environmentFound,
  missingTool,
  missingToolMessage,
  PACKAGE_MANAGER_ENV_VAR,
  remediation,
  resolveBin,
  resolveProjectEnvironment,
  toolCommand,
} from "../src/environment/project.ts";

const temporaryRoots: string[] = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A throwaway project directory.
 *
 * Always carries a `.git`, which is also the boundary `binSearchDirs` stops
 * at — without it the walk would climb out of the temp directory and could,
 * in principle, find a `node_modules` that belongs to someone else. That is
 * the exact failure mode under test, so the fixture must not depend on luck.
 */
function project(files: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-env-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, ".git"), { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

function fakeBin(root: string, relativeDir: string, name: string): string {
  const dir = join(root, relativeDir, "node_modules", ".bin");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

/** Run `body` with the override env var set to `value` (or unset). */
function withOverride(value: string | undefined, body: () => void): void {
  const previous = process.env[PACKAGE_MANAGER_ENV_VAR];
  if (value === undefined) {
    delete process.env[PACKAGE_MANAGER_ENV_VAR];
  } else {
    process.env[PACKAGE_MANAGER_ENV_VAR] = value;
  }
  try {
    body();
  } finally {
    if (previous === undefined) {
      delete process.env[PACKAGE_MANAGER_ENV_VAR];
    } else {
      process.env[PACKAGE_MANAGER_ENV_VAR] = previous;
    }
  }
}

function command(stdout: string, stderr: string, returncode = 1): CompletedCommand {
  return { name: "t", command: ["tsc"], cwd: "/tmp", returncode, stdout, stderr };
}

/**
 * What Node ACTUALLY prints when a binary's entry point does not resolve —
 * both loaders, captured from `node` 24 and trimmed only in the middle of the
 * stack. `missingTool` keys off the `node:internal/modules/` frames, so these
 * are the fixtures that say what "keys off" means.
 */
const CJS_RESOLUTION_FAILURE = [
  "node:internal/modules/cjs/loader:1459",
  "  throw err;",
  "  ^",
  "",
  "Error: Cannot find module 'vitest/node'",
  "Require stack:",
  "- /repo/node_modules/.bin/vitest",
  "    at Module._resolveFilename (node:internal/modules/cjs/loader:1456:15)",
  "    at Module._load (node:internal/modules/cjs/loader:1242:25)",
  "    at Object.<anonymous> (/repo/node_modules/.bin/vitest:2:1) {",
  "  code: 'MODULE_NOT_FOUND'",
  "}",
  "",
].join("\n");

const ESM_RESOLUTION_FAILURE = [
  "node:internal/modules/package_json_reader:301",
  "  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);",
  "        ^",
  "",
  "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'vitest' imported from /repo/run.mjs",
  "    at packageResolve (node:internal/modules/esm/resolve:768:81)",
  "    at moduleResolve (node:internal/modules/esm/resolve:859:18) {",
  "  code: 'ERR_MODULE_NOT_FOUND'",
  "}",
  "",
].join("\n");

describe("detectPackageManager", () => {
  it("reads each lockfile", () => {
    withOverride(undefined, () => {
      const cases: readonly (readonly [string, string])[] = [
        ["pnpm-lock.yaml", "pnpm"],
        ["bun.lock", "bun"],
        ["bun.lockb", "bun"],
        ["yarn.lock", "yarn"],
        ["package-lock.json", "npm"],
      ];
      for (const [file, expected] of cases) {
        const root = project({ [file]: "" });
        const detected = detectPackageManager(root);
        assert.equal(detected.packageManager, expected, file);
        assert.equal(detected.source, file);
      }
    });
  });

  it("prefers the stronger lockfile when a migration left two behind", () => {
    withOverride(undefined, () => {
      const root = project({ "pnpm-lock.yaml": "", "package-lock.json": "{}" });
      assert.equal(detectPackageManager(root).packageManager, "pnpm");

      const bunny = project({ "bun.lock": "", "yarn.lock": "" });
      assert.equal(detectPackageManager(bunny).packageManager, "bun");
    });
  });

  it("lets package.json#packageManager beat the lockfile", () => {
    // An explicit declaration says what the project IS; a lockfile only shows
    // what some tool once did. A repo that migrated has both.
    withOverride(undefined, () => {
      const root = project({
        "pnpm-lock.yaml": "",
        "package.json": JSON.stringify({ packageManager: "yarn@4.1.0" }),
      });
      const detected = detectPackageManager(root);
      assert.equal(detected.packageManager, "yarn");
      assert.equal(detected.source, "package.json#packageManager");
    });
  });

  it("strips the corepack integrity suffix", () => {
    withOverride(undefined, () => {
      const root = project({
        "package.json": JSON.stringify({ packageManager: "pnpm@11.9.0+sha512.beef" }),
      });
      assert.equal(detectPackageManager(root).packageManager, "pnpm");
    });
  });

  it("stops at an unsupported declared manager instead of guessing", () => {
    withOverride(undefined, () => {
      const root = project({
        "package-lock.json": "{}",
        "package.json": JSON.stringify({ packageManager: "deno@2.0.0" }),
      });
      const detected = detectPackageManager(root);
      assert.equal(detected.packageManager, "unknown");
      assert.equal(detected.source, "package.json#packageManager");
    });
  });

  it("returns unknown rather than defaulting to npm", () => {
    withOverride(undefined, () => {
      const detected = detectPackageManager(project());
      assert.equal(detected.packageManager, "unknown");
      assert.equal(detected.source, "unknown");
    });
  });

  it("lets the env override win over everything", () => {
    const root = project({ "pnpm-lock.yaml": "" });
    withOverride("npm", () => {
      const detected = detectPackageManager(root);
      assert.equal(detected.packageManager, "npm");
      assert.equal(detected.source, PACKAGE_MANAGER_ENV_VAR);
    });
  });

  it("throws on an override it cannot honour", () => {
    // Silently ignoring an explicit instruction is worse than failing: the
    // operator set it precisely because our inference was wrong.
    const root = project({ "pnpm-lock.yaml": "" });
    withOverride("deno", () => {
      assert.throws(
        () => detectPackageManager(root),
        /KRAGG_PACKAGE_MANAGER=deno names an unsupported package manager/,
      );
    });
  });
});

describe("resolveProjectEnvironment", () => {
  it("reports a non-JS directory as not found, without throwing", () => {
    withOverride(undefined, () => {
      const env = resolveProjectEnvironment(project());
      assert.equal(env.packageManager, "unknown");
      assert.equal(environmentFound(env), false);
      assert.equal(env.binDir, null);
    });
  });

  it("finds the nearest bin directory and describes itself", () => {
    withOverride(undefined, () => {
      const root = project({ "pnpm-lock.yaml": "" });
      fakeBin(root, ".", "tsc");
      const env = resolveProjectEnvironment(root);
      assert.equal(environmentFound(env), true);
      assert.equal(env.binDir, join(root, "node_modules", ".bin"));

      const text = describeEnvironment(env);
      assert.match(text, /package manager: pnpm \(via pnpm-lock\.yaml\)/);
      assert.match(text, /workspaces:\s+none \(single-package repo\)/);
    });
  });
});

describe("resolveBin", () => {
  it("finds a project-local binary", () => {
    withOverride(undefined, () => {
      const root = project({ "pnpm-lock.yaml": "" });
      const expected = fakeBin(root, ".", "vitest");
      const env = resolveProjectEnvironment(root);
      assert.equal(resolveBin(env, "vitest"), expected);
      assert.deepEqual(toolCommand(env, "vitest", "run"), [expected, "run"]);
    });
  });

  it("walks up to a workspace root, where pnpm hoists binaries", () => {
    withOverride(undefined, () => {
      const root = project({ "pnpm-lock.yaml": "" });
      const expected = fakeBin(root, ".", "tsc");
      const member = join(root, "packages", "a");
      mkdirSync(member, { recursive: true });
      writeFileSync(join(member, "package.json"), JSON.stringify({ name: "a" }));

      const env = resolveProjectEnvironment(member);
      assert.equal(resolveBin(env, "tsc"), expected);
    });
  });

  it("prefers the nearest binary over the hoisted one", () => {
    withOverride(undefined, () => {
      const root = project({ "pnpm-lock.yaml": "" });
      fakeBin(root, ".", "tsc");
      const member = join(root, "packages", "a");
      mkdirSync(member, { recursive: true });
      const nearest = fakeBin(root, join("packages", "a"), "tsc");

      const env = resolveProjectEnvironment(member);
      assert.equal(resolveBin(env, "tsc"), nearest);
    });
  });

  it("finds the .cmd shim on Windows, which is the only entry that runs there", () => {
    // The platform is INJECTED so this branch runs on every host. Read from
    // `process.platform` it would only ever execute on a machine nobody here
    // has, which is how "Windows support" ships having never run.
    withOverride(undefined, () => {
      const root = project({ "pnpm-lock.yaml": "" });
      const cmd = fakeBin(root, ".", "tsc.cmd");
      const env = resolveProjectEnvironment(root);

      assert.equal(resolveBin(env, "tsc", { platform: "win32" }), cmd);
      // The same lookup on POSIX must NOT find it: a `.cmd` is not runnable
      // there, and reporting one as the project's tsc would be a false pass.
      assert.equal(resolveBin(env, "tsc", { platform: "linux" }), null);
    });
  });

  it("prefers the .cmd over the extension-less shell shim on Windows", () => {
    // npm and pnpm write BOTH. The extension-less one is a shell script
    // `CreateProcess` cannot run, so preferring it would break every tool.
    withOverride(undefined, () => {
      const root = project({ "pnpm-lock.yaml": "" });
      const bare = fakeBin(root, ".", "tsc");
      const cmd = fakeBin(root, ".", "tsc.cmd");
      const env = resolveProjectEnvironment(root);

      assert.equal(resolveBin(env, "tsc", { platform: "win32" }), cmd);
      assert.equal(resolveBin(env, "tsc", { platform: "darwin" }), bare);
    });
  });

  it("returns null instead of falling back to a global install", () => {
    // `node` is certainly on PATH wherever these tests run. Finding it would
    // mean we resolved through the environment, which is the whole bug.
    withOverride(undefined, () => {
      const env = resolveProjectEnvironment(project({ "pnpm-lock.yaml": "" }));
      assert.equal(resolveBin(env, "node"), null);
      assert.equal(resolveBin(env, "tsc"), null);
      assert.equal(toolCommand(env, "tsc"), null);
    });
  });
});

describe("remediation", () => {
  it("gives a runnable command per manager", () => {
    assert.equal(
      remediation("pnpm", "vitest"),
      "Fix: pnpm add -D vitest (or run `pnpm install` if already declared)",
    );
    assert.match(remediation("npm", "vitest"), /^Fix: npm install --save-dev vitest /);
    assert.match(remediation("yarn", "vitest"), /^Fix: yarn add --dev vitest /);
    assert.match(remediation("bun", "vitest"), /^Fix: bun add --dev vitest /);
  });

  it("degrades to prose rather than a wrong command when unknown", () => {
    assert.match(remediation("unknown", "vitest"), /install vitest as a dev dependency/);
  });

  it("names the package, the search path, and the fix", () => {
    withOverride(undefined, () => {
      const root = project({ "pnpm-lock.yaml": "" });
      const message = missingToolMessage(resolveProjectEnvironment(root), "tsc", "typescript");
      assert.match(message, /tsc is not installed in this project/);
      assert.match(message, /node_modules/);
      assert.match(message, /pnpm add -D typescript/);
    });
  });
});

describe("missingTool", () => {
  it("detects a binary that could not be spawned", () => {
    assert.equal(missingTool(command("", "Error: spawn tsc ENOENT")), "tsc");
  });

  it("detects the shell variants", () => {
    assert.equal(missingTool(command("", "sh: tsc: command not found")), "tsc");
    assert.equal(missingTool(command("", "zsh: command not found: deptry")), "deptry");
    assert.equal(missingTool(command("", "sh: 1: knip: not found")), "knip");
  });

  it("detects an entry point that does not resolve, from the CJS loader's own crash", () => {
    // Copied from a real `node node_modules/.bin/vitest` whose package tree was
    // half-installed, trimmed to the frames Node always prints.
    assert.equal(missingTool(command("", CJS_RESOLUTION_FAILURE)), "vitest/node");
  });

  it("detects the ESM spelling of the same crash", () => {
    assert.equal(missingTool(command("", ESM_RESOLUTION_FAILURE)), "vitest");
  });

  it("does not read a COMPILER DIAGNOSTIC as a missing tool", () => {
    // TS2307 is worded exactly like Node's own resolution failure and lands on
    // tsc's stdout. Reading it as "tsc is not installed" reported the whole
    // type-check gate as exit 3 (environment) instead of exit 1 (findings) —
    // and named `node:fs` as the missing tool.
    const diagnostic =
      "src/a.ts(1,26): error TS2307: Cannot find module 'node:fs' or its " +
      "corresponding type declarations.\n" +
      "src/b.ts(4,10): error TS2307: Cannot find module './missing.ts' or its " +
      "corresponding type declarations.\n";
    assert.equal(missingTool(command(diagnostic, "")), null);
  });

  it("does not read another tool's report of the same words as a missing tool", () => {
    // The point of keying off the Node stack rather than tighter wording: a
    // linter, bundler or test runner quoting a resolution error it CAUGHT is
    // reporting on the project's code, not on its own installation.
    const bundler =
      "ERROR in ./src/app.ts\n" +
      "Module not found: Error: Cannot find module 'left-pad' from '/repo/src'\n" +
      "    at /repo/node_modules/bundler/lib/resolve.js:120:19\n";
    assert.equal(missingTool(command("", bundler)), null);
  });

  it("needs BOTH the uncaught header and the loader stack, never either alone", () => {
    const headerOnly = "Error: Cannot find module 'vitest/node'\n";
    assert.equal(missingTool(command("", headerOnly)), null);
    const stackOnly =
      "TypeError: x is not a function\n" +
      "    at Module._compile (node:internal/modules/cjs/loader:1812:14)\n";
    assert.equal(missingTool(command("", stackOnly)), null);
  });

  it("returns null for a tool that ran and found problems", () => {
    // The distinction decides the exit code: exit 3 (environment) vs exit 1
    // (findings). Getting it wrong sends the user to fix the wrong thing.
    const result = command("src/a.ts(3,1): error TS2322: Type 'string' is not assignable.", "");
    assert.equal(missingTool(result), null);
  });

  it("does not treat exit status 127 alone as a missing tool", () => {
    // `runner.ts` also returns 127 for a timeout and for a signal death.
    assert.equal(missingTool(command("", "", 127)), null);
  });
});

describe("readJsonObject", () => {
  // Three callers in `workspaces.ts` made this the member-recognition rule,
  // so every way it answers `null` is pinned: each one is a directory that is
  // NOT a member, and a throw here would abort a whole workspace expansion.
  it("returns the object, and null for a missing, malformed or non-object file", () => {
    const root = project({
      "ok.json": '{"name":"a"}',
      "bad.json": "{ not json",
      "list.json": "[1]",
    });
    assert.deepEqual(readJsonObject(join(root, "ok.json")), { name: "a" });
    assert.equal(readJsonObject(join(root, "missing.json")), null);
    assert.equal(readJsonObject(join(root, "bad.json")), null);
    assert.equal(readJsonObject(join(root, "list.json")), null);
  });
});

describe("detectWorkspaces", () => {
  it("reports a single-package repo as a successful detection", () => {
    const info = detectWorkspaces(project({ "package.json": "{}" }));
    assert.equal(info.kind, "none");
    assert.equal(info.note, null);
  });

  it("reads pnpm-workspace.yaml#packages and expands it to the members on disk", () => {
    const root = project({
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - \"apps/**\"\n  - '!packages/legacy'\n",
      "packages/a/package.json": '{"name":"@ws/a"}',
      "packages/b/package.json": "{}",
      "packages/legacy/package.json": '{"name":"@ws/legacy"}',
      "packages/README/notes.txt": "not a package: no manifest",
      "apps/site/deep/tool/package.json": '{"name":"tool"}',
      "node_modules/dep/package.json": '{"name":"dep"}',
    });
    const info = detectWorkspaces(root);
    assert.equal(info.kind, "pnpm");
    assert.equal(info.configPath, join(root, "pnpm-workspace.yaml"));
    assert.deepEqual(info.patterns, ["packages/*", "apps/**", "!packages/legacy"]);
    assert.equal(info.note, null);
    assert.deepEqual(
      info.packages.map((member) => [member.path, member.name]),
      [
        ["apps/site/deep/tool", "tool"],
        ["packages/a", "@ws/a"],
        ["packages/b", null],
      ],
    );
    assert.equal(info.packages[1]?.root, join(root, "packages", "a"));
  });

  it("treats a pnpm-workspace.yaml with no `packages` key as the root alone", () => {
    // kragg's own file: settings only. Not a note, not an error — a fact.
    const info = detectWorkspaces(project({ "pnpm-workspace.yaml": "ignoreScripts: true\n" }));
    assert.equal(info.kind, "pnpm");
    assert.deepEqual(info.packages, []);
    assert.equal(info.note, null);
  });

  it("REFUSES a pnpm-workspace.yaml it cannot read in full, naming the line", () => {
    // A member dropped by a lenient reader is one no root run would mention.
    // The list is complete or empty; never partial.
    for (const [text, reason] of [
      ["packages: [a, b]\n", /line 1 .*block sequence/],
      ["packages:\n  - packages/*\n  - *anchor\n", /line 3 .*not a plain or quoted/],
      ["packages:\n  - packages/*\n  nested: true\n", /line 3/],
      ["packages:\n  - |\n    packages/*\n", /line 2/],
    ] as const) {
      const info = detectWorkspaces(project({ "pnpm-workspace.yaml": text }));
      assert.equal(info.kind, "pnpm", text);
      assert.deepEqual(info.packages, [], text);
      assert.match(info.note ?? "", reason, text);
    }
  });

  it("expands package.json workspaces the same way, and refuses unknown glob syntax", () => {
    const root = project({
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "packages/a/package.json": '{"name":"a"}',
      "packages/a/nested/package.json": '{"name":"nested"}',
    });
    const info = detectWorkspaces(root);
    assert.deepEqual(info.packages.map((member) => member.path), ["packages/a"]);
    assert.equal(info.note, null);

    const braces = detectWorkspaces(
      project({
        "package.json": JSON.stringify({ workspaces: ["packages/{a,b}"] }),
        "packages/a/package.json": "{}",
      }),
    );
    assert.deepEqual(braces.packages, []);
    assert.match(braces.note ?? "", /packages\/\{a,b\}.*does not expand/);
  });

  it("reads package.json workspaces in both shapes", () => {
    const array = detectWorkspaces(
      project({ "package.json": JSON.stringify({ workspaces: ["packages/*", "apps/*"] }) }),
    );
    assert.equal(array.kind, "package-json");
    assert.deepEqual(array.patterns, ["packages/*", "apps/*"]);

    const object = detectWorkspaces(
      project({ "package.json": JSON.stringify({ workspaces: { packages: ["libs/*"] } }) }),
    );
    assert.deepEqual(object.patterns, ["libs/*"]);
  });

  it("treats a malformed workspaces field as no workspace", () => {
    const info = detectWorkspaces(
      project({ "package.json": JSON.stringify({ workspaces: 42 }) }),
    );
    assert.equal(info.kind, "none");
  });
});
