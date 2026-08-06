/**
 * Tests for lint-tool detection and the run/report path.
 *
 * The parsers are tested separately in `lintParsers.test.ts`; what is under
 * test here is the decision layer — WHICH linter runs, and what a non-zero
 * exit is allowed to mean.
 *
 * Two behaviours carry the weight:
 *
 *  1. DETECTION MUST NOT SUBSTITUTE. A policy that names biome and gets eslint
 *     is worse than no gate, and "eslint is in node_modules" is not evidence
 *     that the project lints with eslint — half the ecosystem pulls it in
 *     transitively.
 *  2. A NON-ZERO EXIT IS NOT AUTOMATICALLY A FINDING. oxlint and biome return
 *     the same status for "found errors" and "your config is invalid"
 *     (verified in their sources), so the run path has to reach the same
 *     verdict from the output shape instead. ESLint alone separates them by
 *     exit code, the way ruff's `error_codes=(2,)` does.
 *
 * Stand-in linters are shell scripts with a fixed stdout and exit status, so
 * no real linter is installed or invoked (kragg bundles none).
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { detectLintTool, runLint, type LintTool } from "../src/adapters/lint.ts";
import { resolveProjectEnvironment } from "../src/environment/project.ts";
import {
  BIOME_CLEAN,
  ESLINT_FOUND,
  OXLINT_CLEAN,
  OXLINT_FOUND,
} from "./fixtures/linterOutput.ts";

const temporaryRoots: string[] = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A throwaway project.
 *
 * `.git` is not decoration: it is the boundary `binSearchDirs` stops its
 * ancestor walk at, so without it a lookup could climb out of the temp
 * directory and find a `node_modules` belonging to someone else — the exact
 * failure `resolveBin` exists to prevent, and one that would make these tests
 * pass for the wrong reason.
 */
function project(files: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-lint-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@11.0.0" }));
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

/** A stand-in linter: fixed stdout, fixed exit status. */
function fakeLinter(root: string, name: string, stdout: string, status: number): void {
  const dir = join(root, "node_modules", ".bin");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\ncat <<'KRAGG_EOF'\n${stdout}\nKRAGG_EOF\nexit ${status}\n`);
  chmodSync(path, 0o755);
}

/** An installed-but-never-invoked linter, for detection tests. */
function installed(root: string, name: string): void {
  fakeLinter(root, name, "{}", 0);
}

describe("detectLintTool", () => {
  it("skips when nothing is installed, naming every option and its install command", () => {
    const env = resolveProjectEnvironment(project());
    const detected = detectLintTool(env, "auto");
    assert.equal(detected.ok, false);
    if (!detected.ok) {
      assert.equal(detected.reason, "skipped");
      for (const fragment of ["oxlint", "@biomejs/biome", "eslint", "pnpm add -D"]) {
        assert.ok(detected.message.includes(fragment), `missing ${fragment}`);
      }
    }
  });

  it("calls out a config file whose linter is not installed", () => {
    const env = resolveProjectEnvironment(project({ "biome.json": "{}" }));
    const detected = detectLintTool(env, "auto");
    assert.equal(detected.ok, false);
    if (!detected.ok) {
      assert.match(detected.message, /biome\.json found, but biome is not installed/);
    }
  });

  it("prefers a CONFIGURED tool over a merely installed faster one", () => {
    // A config file is the project saying what it lints with; a node_modules
    // entry is often a transitive dependency of something else.
    const root = project({ "eslint.config.js": "export default [];" });
    installed(root, "oxlint");
    installed(root, "eslint");
    const detected = detectLintTool(resolveProjectEnvironment(root), "auto");
    assert.equal(detected.ok, true);
    if (detected.ok) {
      assert.equal(detected.tool, "eslint");
    }
  });

  it("breaks a two-config tie toward the cheaper tool", () => {
    const root = project({ "biome.json": "{}", ".eslintrc.json": "{}" });
    installed(root, "biome");
    installed(root, "eslint");
    const detected = detectLintTool(resolveProjectEnvironment(root), "auto");
    assert.equal(detected.ok, true);
    if (detected.ok) {
      assert.equal(detected.tool, "biome");
    }
  });

  it("falls back to any installed linter when no config is in the root", () => {
    // Covers `package.json#eslintConfig` and a workspace member's own config,
    // neither of which the root-only config scan sees.
    const root = project();
    installed(root, "eslint");
    const detected = detectLintTool(resolveProjectEnvironment(root), "auto");
    assert.equal(detected.ok, true);
    if (detected.ok) {
      assert.equal(detected.tool, "eslint");
    }
  });

  it("honours an explicit tool and never downgrades to another one", () => {
    const root = project();
    installed(root, "oxlint");
    installed(root, "eslint");
    for (const tool of ["oxlint", "eslint"] as const) {
      const detected = detectLintTool(resolveProjectEnvironment(root), tool);
      assert.equal(detected.ok, true);
      if (detected.ok) {
        assert.equal(detected.tool, tool);
      }
    }
  });

  it("ERRORS, not skips, when the policy names a linter that is not installed", () => {
    // The fail-open case this split exists for: the project asked for biome,
    // so quietly running eslint — or quietly running nothing — leaves it
    // believing it is linted when it is not.
    const root = project();
    installed(root, "eslint");
    const detected = detectLintTool(resolveProjectEnvironment(root), "biome");
    assert.equal(detected.ok, false);
    if (!detected.ok) {
      assert.equal(detected.reason, "error");
      assert.match(detected.message, /lint_tool = biome/);
      assert.match(detected.message, /pnpm add -D @biomejs\/biome/);
    }
  });

  it("skips on an explicit off", () => {
    const root = project();
    installed(root, "oxlint");
    const detected = detectLintTool(resolveProjectEnvironment(root), "off");
    assert.equal(detected.ok, false);
    if (!detected.ok) {
      assert.equal(detected.reason, "skipped");
    }
  });
});

describe("runLint", () => {
  /** A project whose `tool` emits `stdout` and exits `status`. */
  function withLinter(tool: LintTool, stdout: string, status: number): string {
    const root = project();
    fakeLinter(root, tool, stdout, status);
    return root;
  }

  it("reports a clean run as zero violations", async () => {
    const root = withLinter("oxlint", OXLINT_CLEAN, 0);
    const outcome = await runLint({ env: resolveProjectEnvironment(root) });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.tool, "oxlint");
      assert.deepEqual(outcome.violations, []);
      assert.deepEqual(outcome.command.slice(1), ["--format=json", "."]);
    }
  });

  it("reports found problems as violations, not as an error", async () => {
    const root = withLinter("oxlint", OXLINT_FOUND, 1);
    const outcome = await runLint({ env: resolveProjectEnvironment(root) });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.violations.length, 3);
    }
  });

  it("reports a Rust linter's config failure as an error despite the shared exit code", async () => {
    // oxlint's `result.rs` maps LintFoundErrors AND InvalidOptionConfig to the
    // same ExitCode::FAILURE, so this is exit 1 in both cases and only the
    // absent envelope separates them.
    const root = withLinter("oxlint", "Failed to parse configuration file.", 1);
    const outcome = await runLint({ env: resolveProjectEnvironment(root) });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.reason, "error");
      assert.match(outcome.message, /did not produce a JSON report/);
      // The tool's own diagnosis has to survive into the report, or the user
      // is told the gate broke and nothing about why.
      assert.match(outcome.message, /Failed to parse configuration file/);
    }
  });

  it("treats eslint exit 2 as a tool failure and exit 1 as findings", async () => {
    // ESLint is the one tool with ruff's shape: 2 is "did not run".
    const fatal = withLinter("eslint", "", 2);
    const outcome = await runLint({ env: resolveProjectEnvironment(fatal), setting: "eslint" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.reason, "error");
      assert.match(outcome.message, /exited 2/);
    }

    const found = withLinter("eslint", ESLINT_FOUND, 1);
    const ok = await runLint({ env: resolveProjectEnvironment(found), setting: "eslint" });
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.violations.length, 2);
    }
  });

  it("errors when a linter fails without blaming anything", async () => {
    // Well-formed output, non-zero exit, no violations: the failure is the
    // linter's. Passing here would be the silent-green outcome.
    const root = withLinter("eslint", "[]", 1);
    const outcome = await runLint({ env: resolveProjectEnvironment(root), setting: "eslint" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.match(outcome.message, /reported no violations/);
    }
  });

  it("passes caller paths through to the tool", async () => {
    const root = withLinter("biome", BIOME_CLEAN, 0);
    const outcome = await runLint({
      env: resolveProjectEnvironment(root),
      paths: ["src/a.ts", "src/b.ts"],
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.deepEqual(outcome.command.slice(1), [
        "check",
        "--reporter=json",
        "src/a.ts",
        "src/b.ts",
      ]);
    }
  });

  it("surfaces detection failures unchanged", async () => {
    const outcome = await runLint({ env: resolveProjectEnvironment(project()) });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.reason, "skipped");
      assert.equal(outcome.command, undefined);
    }
  });
});
