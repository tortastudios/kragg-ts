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

  it("detects an entry point that does not resolve", () => {
    assert.equal(
      missingTool(command("", "Error: Cannot find module 'vitest/node'")),
      "vitest/node",
    );
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

describe("detectWorkspaces", () => {
  it("reports a single-package repo as a successful detection", () => {
    const info = detectWorkspaces(project({ "package.json": "{}" }));
    assert.equal(info.kind, "none");
    assert.equal(info.note, null);
  });

  it("detects pnpm-workspace.yaml without pretending to parse it", () => {
    const root = project({ "pnpm-workspace.yaml": "packages:\n  - packages/*\n" });
    const info = detectWorkspaces(root);
    assert.equal(info.kind, "pnpm");
    assert.equal(info.configPath, join(root, "pnpm-workspace.yaml"));
    assert.deepEqual(info.patterns, []);
    assert.match(info.note ?? "", /not parsed/);
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
