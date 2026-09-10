/**
 * Tests for formatter detection and the `kragg fix` format pass.
 *
 * `kragg fix` is advertised as "format and safely fix lint findings", and for
 * most of this project's life only one of the three linters it drives — biome
 * — formatted anything. A project on oxlint (the linter this repository
 * itself uses) or eslint got the fix pass and a note saying no formatting
 * happened, however much Prettier it had installed.
 *
 * What is under test here is the decision layer, and three properties of it:
 *
 *  1. FORMATTING IS DETECTED INDEPENDENTLY OF LINTING. oxlint-for-lint plus
 *     Prettier-for-format is an ordinary pairing, so the formatter may not be
 *     derived from `lint_tool`.
 *  2. A FORMATTER IS NEVER IMPOSED. Prettier arrives transitively in plenty of
 *     dependency trees; running it on a project that configured no style would
 *     rewrite every file to a style the project never chose, on disk, in one
 *     command. Installed-without-config is a visible skip, not a run.
 *  3. THE `formats` REPORTING STAYS HONEST. The "does not format" note is
 *     printed exactly when the run really did not format, for every
 *     combination of linter and formatter.
 *
 * Stand-in tools are shell scripts that record their argv, so no real linter
 * or formatter is installed or invoked (kragg bundles none). The `kragg fix`
 * cases drive the CLI as a child process, the way `cli.test.ts` does, so the
 * process exit status and both streams are the real ones.
 */

import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { detectFormatter } from "../src/adapters/format.ts";
import { resolveProjectEnvironment } from "../src/environment/project.ts";
import { runCommand } from "../src/engine/runner.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const temporaryRoots: string[] = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A throwaway project.
 *
 * `.git` is the boundary `binSearchDirs` stops its ancestor walk at; without
 * it a lookup could climb out of the temp directory and find someone else's
 * `node_modules`, which is exactly what `resolveBin` exists to prevent.
 */
function project(files: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-format-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@11.0.0" }));
  writeFileSync(join(root, "kragg.json"), JSON.stringify({ source_paths: ["src"] }));
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

/** Where a stand-in tool records the argv it was called with. */
function argvPath(root: string, name: string): string {
  return join(root, `${name}.argv`);
}

/** A stand-in tool that records its argv and exits 0. */
function installed(root: string, name: string): void {
  const dir = join(root, "node_modules", ".bin");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvPath(root, name)}'\nexit 0\n`);
  chmodSync(path, 0o755);
}

/** The argv a stand-in tool recorded, or `null` when it never ran. */
function argvOf(root: string, name: string): readonly string[] | null {
  const path = argvPath(root, name);
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path, "utf8").trimEnd().split("\n");
}

interface Captured {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** Run `kragg fix` in a throwaway project and capture everything it produced. */
async function fix(root: string, ...argv: readonly string[]): Promise<Captured> {
  const result = await runCommand("kragg", [process.execPath, CLI, "fix", ...argv], root);
  return { code: result.returncode, out: result.stdout, err: result.stderr };
}

describe("detectFormatter", () => {
  it("skips when nothing is there, naming both options and their install commands", () => {
    const detected = detectFormatter(resolveProjectEnvironment(project()));
    assert.equal(detected.ok, false);
    if (!detected.ok) {
      for (const fragment of ["prettier", "@biomejs/biome", "pnpm add -D", ".prettierrc.json"]) {
        assert.ok(detected.message.includes(fragment), `missing ${fragment}`);
      }
    }
  });

  it("runs prettier when the project both installed and configured it", () => {
    const root = project({ ".prettierrc.json": "{}" });
    installed(root, "prettier");
    const detected = detectFormatter(resolveProjectEnvironment(root));
    assert.equal(detected.ok, true);
    if (detected.ok) {
      assert.equal(detected.tool, "prettier");
      assert.deepEqual([...detected.args], ["--write"]);
    }
  });

  it("accepts package.json#prettier as the project's declaration", () => {
    // Prettier's own resolver reads it, and plenty of repos configure it there
    // instead of adding a dotfile.
    const root = project();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "pnpm@11.0.0", prettier: { semi: false } }),
    );
    installed(root, "prettier");
    const detected = detectFormatter(resolveProjectEnvironment(root));
    assert.equal(detected.ok, true);
    if (detected.ok) {
      assert.equal(detected.tool, "prettier");
    }
  });

  it("REFUSES to format a project that installed a formatter and configured none", () => {
    // The whole point: `node_modules/prettier` is not consent to have every
    // file rewritten to Prettier's defaults.
    const root = project();
    installed(root, "prettier");
    const detected = detectFormatter(resolveProjectEnvironment(root));
    assert.equal(detected.ok, false);
    if (!detected.ok) {
      assert.match(detected.message, /prettier is installed, but this project declares no/);
      assert.match(detected.message, /add \.prettierrc\.json/);
    }
  });

  it("calls out a config file whose formatter is not installed, with the install command", () => {
    const detected = detectFormatter(resolveProjectEnvironment(project({ ".prettierrc": "{}" })));
    assert.equal(detected.ok, false);
    if (!detected.ok) {
      assert.match(detected.message, /\.prettierrc found, but prettier is not installed/);
      assert.match(detected.message, /pnpm add -D prettier/);
    }
  });

  it("drives biome as a formatter, not as a linter, when it is the one configured", () => {
    // `format --write`, not `check --write`: reaching detection at all means
    // biome is not this project's linter, so its rule set was not chosen here.
    const root = project({ "biome.json": "{}" });
    installed(root, "biome");
    const detected = detectFormatter(resolveProjectEnvironment(root));
    assert.equal(detected.ok, true);
    if (detected.ok) {
      assert.equal(detected.tool, "biome");
      assert.deepEqual([...detected.args], ["format", "--write"]);
    }
  });

  it("prefers prettier when a repo carries both formatter configs", () => {
    const root = project({ ".prettierrc.json": "{}", "biome.json": "{}" });
    installed(root, "prettier");
    installed(root, "biome");
    const detected = detectFormatter(resolveProjectEnvironment(root));
    assert.equal(detected.ok, true);
    if (detected.ok) {
      assert.equal(detected.tool, "prettier");
    }
  });
});

describe("kragg fix", () => {
  it("formats with prettier and drops the 'does not format' note for an oxlint project", async () => {
    const root = project({ ".oxlintrc.json": "{}", ".prettierrc.json": "{}" });
    installed(root, "oxlint");
    installed(root, "prettier");
    const run = await fix(root, "--file", "src");
    assert.equal(run.code, 0);
    assert.deepEqual([...(argvOf(root, "oxlint") ?? [])], ["--fix", "src"]);
    assert.deepEqual([...(argvOf(root, "prettier") ?? [])], ["--write", "src"]);
    assert.match(run.out, /oxlint --fix/);
    assert.match(run.out, /prettier --write/);
    assert.doesNotMatch(run.out, /does not format/);
  });

  it("leaves a biome project exactly as it was: one combined pass, no second formatter", async () => {
    // biome's `check --write` already formats. A prettier pass on top would
    // fight it over the same files, so it is not even detected.
    const root = project({ "biome.json": "{}", ".prettierrc.json": "{}" });
    installed(root, "biome");
    installed(root, "prettier");
    const run = await fix(root, "--file", "src");
    assert.equal(run.code, 0);
    assert.deepEqual([...(argvOf(root, "biome") ?? [])], ["check", "--write", "src"]);
    assert.equal(argvOf(root, "prettier"), null);
    assert.match(run.out, /biome check --write/);
    assert.doesNotMatch(run.out, /does not format/);
  });

  it("keeps the note honest, and says why, when no formatter is configured", async () => {
    const root = project({ ".oxlintrc.json": "{}" });
    installed(root, "oxlint");
    const run = await fix(root, "--file", "src");
    assert.equal(run.code, 0);
    assert.match(run.out, /note: oxlint fixes lint findings only; it does not format\./);
    assert.match(run.out, /no formatter ran/);
    assert.match(run.out, /pnpm add -D prettier/);
  });

  it("does not format a project that configured no style, and says so", async () => {
    const root = project({ ".oxlintrc.json": "{}" });
    installed(root, "oxlint");
    installed(root, "prettier");
    const run = await fix(root, "--file", "src");
    assert.equal(run.code, 0);
    assert.equal(argvOf(root, "prettier"), null);
    assert.match(run.out, /does not format/);
    assert.match(run.out, /prettier is installed, but this project declares no/);
  });

  it("formats a project that has a formatter and no linter, and names the missing linter", async () => {
    const root = project({ ".prettierrc.json": "{}" });
    installed(root, "prettier");
    const run = await fix(root, "--file", "src");
    assert.equal(run.code, 0);
    assert.deepEqual([...(argvOf(root, "prettier") ?? [])], ["--write", "src"]);
    assert.match(run.err, /no linter ran/);
    assert.match(run.err, /no JavaScript linter is installed/);
  });

  it("skips visibly, not silently, when the project has neither", async () => {
    const root = project();
    const run = await fix(root, "--file", "src");
    assert.equal(run.code, 0);
    assert.match(run.err, /kragg fix: nothing to run\./);
    assert.match(run.err, /no JavaScript linter is installed/);
    assert.match(run.err, /no formatter ran/);
  });

  it("refuses to format when a NAMED linter is missing: exit 3, nothing run", async () => {
    // An override kragg cannot honour is an error, and a run that formatted
    // anyway would have half-honoured it.
    const root = project({ ".prettierrc.json": "{}" });
    writeFileSync(
      join(root, "kragg.json"),
      JSON.stringify({ source_paths: ["src"], lint_tool: "eslint" }),
    );
    installed(root, "prettier");
    const run = await fix(root, "--file", "src");
    assert.equal(run.code, 3);
    assert.equal(argvOf(root, "prettier"), null);
    assert.match(run.err, /lint_tool = eslint, but eslint is not installed/);
  });
});
