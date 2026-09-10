/**
 * The end-to-end regression harness: real fixture PROJECTS, the BUILT CLI.
 *
 * ── WHY THIS EXISTS BESIDE THE UNIT SUITE ──────────────────────────────────
 * Every false-green defect this repository closed in M1/M2 was reproduced, at
 * the time, by a unit-level fake: a stashed source diff, an injected runner, a
 * temp git repo built inside one `it()`. Those reproductions are gone the
 * moment their issue is merged, and a future refactor can reopen the hole
 * without a single unit test noticing — because no unit test was ever written
 * ABOUT the hole, only about the code that happened to have it.
 *
 * What is pinned here instead is the OBSERVABLE BEHAVIOUR of a whole run over
 * a real project on disk: the process exit status, the JSON payload the
 * contract defines, the files left behind in `.kragg/` and `coverage/`. A
 * refactor that reopens any of these defects changes one of those, and one CI
 * job goes red without anyone having to remember the original bug.
 *
 * ── THE BUILT CLI, NEVER THE SOURCE ────────────────────────────────────────
 * `CLI` is `dist/cli.js`, not `src/cli.ts`. `pnpm test` runs the sources under
 * Node's type stripping; the artifact a consumer installs is compiled
 * JavaScript, and a release gate that tests the sources is a release gate that
 * has never seen what ships. {@link ensureBuilt} compiles the project once per
 * suite, so the binary under test is always this working tree's, and a stale
 * `dist/` cannot turn a red regression green.
 *
 * ── NO SNAPSHOTS ───────────────────────────────────────────────────────────
 * Nothing here records or compares a golden. A golden proves output has not
 * changed since it was captured, which is not the same claim as "the defect is
 * still fixed" — and a golden that goes red is routinely re-recorded. Every
 * case asserts the INVARIANT its issue restored, in the terms the issue used:
 * an exit code, a named gate's three-state verdict, a violation code, a file
 * on disk with the right content in it.
 *
 * ── WHERE A FIXTURE PROJECT LIVES, AND WHY IT IS COPIED OUT ────────────────
 * `test/fixtures/regressions/<name>/project/` is the committed tree; a run
 * copies it to a fresh directory under the system temp directory, for the same
 * reason `test/conformance.test.ts` does. `resolveBin` walks the ancestor
 * chain looking for `node_modules/.bin`, so a fixture executed from inside
 * this checkout would silently find kragg-ts's own toolchain — and every case
 * about a missing tool would stop being about a missing tool. `git_sha` would
 * come from this repository too.
 *
 * A fixture that needs a compiler gets its OWN, by {@link installToolchain}:
 * this repository's already-installed, pinned `typescript` copied into the
 * fixture's `node_modules`. That is not a fake — it is the same package a
 * `pnpm add -D typescript` would put there — and it needs no network and no
 * new dependency.
 *
 * ── FIXTURE SUITES ARE NAMED `*.suite.*`, NOT `*.test.*` OR `*.spec.*` ─────
 * A fixture's own test files live in the repository, and this repository's own
 * discovery would otherwise find them. `pnpm test` globs `test/**\/*.test.ts`,
 * but `kragg check --all` on THIS repo globs `test/**\/*.{test,spec}.*` from
 * `test_paths`, which reaches every fixture. A fixture suite picked up there
 * is executed as if it were kragg's own — and `crashed-runner`'s suite takes
 * its runner down on purpose, which is a fact about that fixture and must not
 * become a fact about this repository. So every fixture suite is named
 * `*.suite.js` / `*.suite.ts` and each fixture's `kragg.json` names that
 * pattern in `test_paths` (an entry may be a pattern; see
 * `src/util/testPaths.ts`), which is how the project under test still
 * discovers its own suite while this one does not.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCommand } from "../src/engine/runner.ts";

/** The repository root, as an absolute path with no trailing separator. */
export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[/\\]$/u, "");

/** The committed fixture projects. */
const FIXTURES = join(REPO_ROOT, "test", "fixtures", "regressions");

/** THE ARTIFACT UNDER TEST. Compiled JavaScript, exactly what `bin` points at. */
export const CLI = join(REPO_ROOT, "dist", "cli.js");

/** Every directory a case materialized, removed by the suite's `after` hook. */
const roots: string[] = [];

/** Remove every materialized project. Call from the suite's `after` hook. */
export function cleanupRoots(): void {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}

let building: Promise<void> | null = null;

/**
 * Compile `src/` into `dist/` before anything runs the CLI.
 *
 * Unconditional rather than mtime-guarded, and memoized so it happens once per
 * process. A staleness heuristic that guesses wrong in the "actually stale"
 * direction would run the whole suite against yesterday's binary and report
 * green, which is the failure mode this file exists to prevent; the build is
 * incremental (`tsBuildInfoFile`) and costs well under a second when there is
 * nothing to do.
 */
export function ensureBuilt(): Promise<void> {
  building ??= (async (): Promise<void> => {
    const tsc = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
    if (!existsSync(tsc)) {
      throw new Error(
        `the regression suite compiles this project with ${tsc}, which is not installed. ` +
          "Run `pnpm install --ignore-scripts` first.",
      );
    }
    const done = await runCommand(
      "tsc",
      [process.execPath, tsc, "-p", join(REPO_ROOT, "tsconfig.build.json")],
      REPO_ROOT,
    );
    if (done.returncode !== 0) {
      throw new Error(`building dist/ failed (exit ${done.returncode}):\n${done.stdout}${done.stderr}`);
    }
    if (!existsSync(CLI)) {
      throw new Error(`the build succeeded but ${CLI} does not exist`);
    }
  })();
  return building;
}

/** How one case wants its project set up before the first command runs. */
export interface FixtureSetup {
  /** Directory name under `test/fixtures/regressions`. */
  readonly fixture: string;
  /** Initialise a git repository and commit the tree, for `--changed`/`--since`. */
  readonly git?: boolean;
  /** Give the project its own `node_modules` TypeScript, so the `tsc` gate can run. */
  readonly typescript?: boolean;
}

/** Copy a fixture project somewhere outside this checkout and set it up. */
export async function materialize(setup: FixtureSetup): Promise<string> {
  await ensureBuilt();
  const source = join(FIXTURES, setup.fixture, "project");
  if (!existsSync(source)) {
    throw new Error(`no fixture project at ${source}`);
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), `kragg-regression-${setup.fixture}-`)));
  roots.push(root);
  cpSync(source, root, { recursive: true });
  if (setup.typescript === true) {
    installToolchain(root);
  }
  if (setup.git === true) {
    await initGit(root);
  }
  return root;
}

/**
 * Give the fixture the compiler a real project would have installed.
 *
 * Copied, not symlinked: `resolveBin` rejects a `.bin` entry whose real path
 * escapes the tree that owns the `node_modules`, precisely so a project cannot
 * be checked with someone else's toolchain. A symlink into this repository
 * would be rejected — correctly — and the fixture would report `tsc` missing.
 */
function installToolchain(root: string): void {
  const packaged = realpathSync(join(REPO_ROOT, "node_modules", "typescript"));
  const target = join(root, "node_modules", "typescript");
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  cpSync(packaged, target, { recursive: true, dereference: true });
  const shim = join(root, "node_modules", ".bin", "tsc");
  try {
    // The relative link npm and pnpm both write. Its real path stays inside
    // the fixture, which is what `resolveBin`'s containment check requires.
    symlinkSync(join("..", "typescript", "bin", "tsc"), shim);
  } catch (error: unknown) {
    // Reported, never worked around. A fixture without a `.bin/tsc` is a
    // fixture whose `tsc` gate reports "not installed", and three cases would
    // then pass for the wrong reason.
    throw new Error(
      `could not create ${shim}, so the fixture has no compiler to run: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        "On Windows this needs Developer Mode or an elevated shell; the " +
        "regression suite is run on ubuntu in CI (ci.yml, `release-gate`).",
    );
  }
}

/** `git init` plus one commit, with an identity that does not touch the user's. */
async function initGit(root: string): Promise<void> {
  const identity = [
    "-c",
    "user.name=kragg-regressions",
    "-c",
    "user.email=regressions@kragg.invalid",
    "-c",
    "commit.gpgsign=false",
  ];
  for (const argv of [
    ["git", "init", "-q", "."],
    ["git", ...identity, "add", "-A"],
    ["git", ...identity, "commit", "-q", "-m", "fixture baseline"],
  ]) {
    const done = await runCommand("git", argv, root);
    if (done.returncode !== 0) {
      throw new Error(`git setup failed in ${root}: ${done.stderr}`);
    }
  }
}

/** Rewrite files in a materialized project — the edit a case's scenario makes. */
export function edit(root: string, files: Readonly<Record<string, string>>): void {
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

/**
 * Delete a path from a materialized project — the other half of {@link edit}.
 *
 * A project is broken by things that are ABSENT at least as often as by things
 * that are wrong, and "half-installed dependency" is exactly that shape: the
 * `.bin` shim still there, the entry point it points at gone. Loud when the
 * path does not exist, because a case that quietly removed nothing would then
 * assert against a perfectly healthy project and pass for the wrong reason.
 */
export function remove(root: string, relative: string): void {
  const path = join(root, relative);
  if (!existsSync(path)) {
    throw new Error(`the case removes ${relative}, and the fixture has no such path`);
  }
  rmSync(path, { recursive: true, force: true });
}

/** One invocation of the built CLI, with its real streams and exit status. */
export interface CliRun {
  readonly argv: readonly string[];
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Variables Node's OWN test runner sets on this process, removed before the
 * fixture is run.
 *
 * `NODE_TEST_CONTEXT` tells a `node --test` process that it is a child of
 * another test run and switches it to the internal reporting protocol. It is
 * inherited all the way down — this suite, to the kragg CLI, to the `node
 * --test` the fixture's test gate spawns — and it makes that innermost runner
 * emit nothing kragg can read. The gate then reports, correctly, that it has
 * no complete report; the fixture is fine, and the measurement is an artefact
 * of the harness. A project under test must not inherit the harness's own
 * test-runner context, so it does not. `NODE_V8_COVERAGE` is removed for the
 * same reason: it redirects a child's coverage output to the parent's
 * directory.
 */
const HARNESS_ONLY_ENV: NodeJS.ProcessEnv = {
  // `undefined` removes the variable: `child_process` skips env entries whose
  // value is undefined rather than stringifying them.
  NODE_TEST_CONTEXT: undefined,
  NODE_V8_COVERAGE: undefined,
};

/** Run the BUILT CLI in a materialized project. */
export async function runCli(root: string, argv: readonly string[]): Promise<CliRun> {
  await ensureBuilt();
  const done = await runCommand("kragg", [process.execPath, CLI, ...argv], root, {
    env: HARNESS_ONLY_ENV,
  });
  return { argv, exit: done.returncode, stdout: done.stdout, stderr: done.stderr };
}

/** Does this artifact exist in the project? */
export function hasArtifact(root: string, relative: string): boolean {
  return existsSync(join(root, relative));
}

/** Read an artifact the run left behind, failing loudly when it is absent. */
export function artifactText(root: string, relative: string): string {
  const path = join(root, relative);
  if (!existsSync(path)) {
    throw new Error(`expected the run to write ${relative}, and it did not`);
  }
  return readFileSync(path, "utf8");
}

/** Read an artifact as JSON. */
export function artifactJson(root: string, relative: string): unknown {
  const parsed: unknown = JSON.parse(artifactText(root, relative));
  return parsed;
}

/** The non-empty lines of `.kragg/history.jsonl`, parsed. */
export function journalEntries(root: string): readonly unknown[] {
  return artifactText(root, join(".kragg", "history.jsonl"))
    .split("\n")
    .filter((line) => line !== "")
    .map((line): unknown => JSON.parse(line));
}
