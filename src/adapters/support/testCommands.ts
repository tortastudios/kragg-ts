/**
 * Where each test runner's binary comes from, and exactly what it is invoked
 * with.
 *
 * Split out of `adapters/testRunner.ts` so the orchestration there stays
 * readable: every flag below carries a reason, and several of them are
 * non-obvious enough that burying them inside the control flow would get one
 * of them "cleaned up" eventually. They are all load-bearing.
 */

import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { missingToolMessage, resolveBin } from "../../environment/project.ts";
import type { ProjectEnvironment } from "../../environment/project.ts";
import type { TestRunnerName } from "./detect.ts";
import { crashed, missingTool } from "./outcome.ts";
import type { Unavailable } from "./outcome.ts";

/** Default location of the istanbul report — vitest's own default path. */
export const DEFAULT_COVERAGE_REPORT = "coverage/coverage-final.json";

/** Where kragg writes its own run artifacts, mirroring Python's `.kragg/`. */
export const ARTIFACTS_DIR = ".kragg";

/**
 * Where each invocation gets a private directory for what its runner writes.
 *
 * EVIDENCE IS ATTRIBUTABLE TO THIS RUN BY CONSTRUCTION, not by timestamp. The
 * runner is told to write every report into a directory that did not exist
 * before this invocation created it (`mkdtemp`: unique, atomic, empty), so
 * anything found there afterwards was written by the process kragg just
 * spawned. A runner that crashes leaves the directory empty and the gate
 * errors; it cannot pick up the report a previous run — or a previous RUNNER,
 * writing a different format — left at the shared location. Two concurrent
 * invocations in one project get two directories and never read each other's.
 * The directory is removed once read; see `discardRunDir`.
 */
export const RUNS_DIR = join(ARTIFACTS_DIR, "runs");

/** Absolute paths for everything a run reads or writes. */
export interface Artifacts {
  readonly root: string;
  /** This invocation's private directory. Every path the runner writes is inside it. */
  readonly runDir: string;
  /** vitest's `--outputFile` target. */
  readonly reportFile: string;
  /** Directory the runner is told to write coverage into. */
  readonly coverageDir: string;
  /** istanbul `coverage-final.json`, written by vitest. */
  readonly istanbulFile: string;
  /** lcov tracefile, written by `node --test` and `bun test`. */
  readonly lcovFile: string;
  /**
   * `coverage_report_path`: where this run's istanbul report is PUBLISHED once
   * it has been read, for `kragg coverage` and anything else that reads it
   * there. No gate reads from this path.
   */
  readonly publishedIstanbulFile: string;
  /** `lcov.info` beside it: where this run's lcov tracefile is published. */
  readonly publishedLcovFile: string;
}

/**
 * Resolve every path from the ONE configured value and this run's directory.
 *
 * `coverage_report_path` names the istanbul report and, through its directory,
 * the lcov tracefile beside it. Those are where a run's coverage ends up; the
 * runner itself is pointed at `runDir`, so the place a gate reads and the
 * place the runner just wrote are the same directory and cannot hold anything
 * older than this invocation.
 */
export function artifacts(
  root: string,
  coverageReportPath: string | undefined,
  runDir: string,
): Artifacts {
  const configured = coverageReportPath ?? DEFAULT_COVERAGE_REPORT;
  const publishedIstanbulFile = isAbsolute(configured) ? configured : resolve(root, configured);
  const coverageDir = join(runDir, "coverage");
  return {
    root,
    runDir,
    reportFile: join(runDir, "test-report.json"),
    coverageDir,
    istanbulFile: join(coverageDir, "coverage-final.json"),
    lcovFile: join(coverageDir, "lcov.info"),
    publishedIstanbulFile,
    publishedLcovFile: join(dirname(publishedIstanbulFile), "lcov.info"),
  };
}

/** A fresh, empty, uniquely named run directory — or why there is none. */
export type RunDir = { readonly ok: true; readonly dir: string } | Unavailable;

/**
 * Create this invocation's directory under `.kragg/runs`.
 *
 * Failure is an ERROR outcome rather than a fallback to the shared location:
 * without a directory of its own, this run could not tell its report from an
 * earlier one, and that is the situation this module exists to make
 * impossible.
 */
export function createRunDir(root: string): RunDir {
  const parent = join(root, RUNS_DIR);
  try {
    mkdirSync(parent, { recursive: true });
    return { ok: true, dir: mkdtempSync(join(parent, "test-")) };
  } catch (error: unknown) {
    return crashed(
      `kragg could not create a private directory for this run's test artifacts under ` +
        `${parent} (${describeError(error)}), so no tests ran. Without one, a report ` +
        "left by an earlier run could be mistaken for this run's.",
    );
  }
}

/**
 * Move the coverage artifact this run READ to the configured location.
 *
 * Only the one file the runner just wrote moves, by rename where the two paths
 * share a filesystem; nothing else at the destination is touched or removed.
 * Returns a message on failure. It is not a gate failure — the evidence was
 * already read — but it is not swallowed either: the caller shows it, because
 * a `kragg coverage` reading the old file afterwards would otherwise be a
 * mystery.
 */
export function publishCoverage(layout: Artifacts, runner: TestRunnerName): string | undefined {
  const [from, to] =
    runner === "vitest"
      ? [layout.istanbulFile, layout.publishedIstanbulFile]
      : [layout.lcovFile, layout.publishedLcovFile];
  try {
    mkdirSync(dirname(to), { recursive: true });
    try {
      renameSync(from, to);
    } catch {
      copyFileSync(from, to);
    }
    return undefined;
  } catch (error: unknown) {
    return `could not publish ${from} to ${to}: ${describeError(error)}`;
  }
}

/** Remove the run directory. kragg created it; nothing else lives in it. */
export function discardRunDir(layout: Artifacts): void {
  try {
    rmSync(layout.runDir, { recursive: true, force: true });
  } catch {
    // A directory that will not delete is a leftover under `.kragg/runs`, and
    // never evidence: no later run can be handed this name again.
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The runner's executable, or the reason there is not one.
 *
 * `Unavailable` rather than a thrown error, so a missing runner reaches the
 * caller as a value it has to handle — see `support/outcome.ts`.
 */
export type ResolvedRunner = { readonly ok: true; readonly bin: string } | Unavailable;

/**
 * Locate the runner's executable.
 *
 * vitest MUST come from the project's `node_modules/.bin`. A globally
 * installed vitest of a different major reads a different config schema and
 * reports results that do not reproduce in CI — the exact failure
 * `environment/project.ts` exists to prevent.
 *
 * `node` and `bun` are different IN KIND: they are runtimes, not project
 * dependencies, and no project puts them in `node_modules/.bin`. For node,
 * `process.execPath` is used rather than a `PATH` lookup — it is the precise
 * interpreter kragg is already running on, a stronger guarantee than `PATH`
 * gives. **Caveat, stated because it can bite:** that may not be the Node the
 * project pins in `.node-version`, so a suite depending on a newer Node's
 * behaviour can fail here and pass in CI. For bun there is no equivalent —
 * kragg does not run on bun — so `bun` comes from the environment, exactly as
 * the package managers do in `adapters/audit.ts`.
 */
export function resolveRunner(env: ProjectEnvironment, runner: TestRunnerName): ResolvedRunner {
  if (runner === "node") {
    return { ok: true, bin: process.execPath };
  }
  if (runner === "bun") {
    return { ok: true, bin: "bun" };
  }
  const bin = resolveBin(env, "vitest");
  return bin === null
    ? missingTool(missingToolMessage(env, "vitest", "vitest"))
    : { ok: true, bin };
}

/**
 * The argv for one run. Always an array; never a shell string.
 *
 * `testPaths` is the policy's `test_paths` verbatim — the DIRECTORIES, not
 * globs. Turning them into something a runner can consume is this module's
 * job and nobody else's: every caller that built the selection itself was one
 * edit away from handing `node --test` a bare directory, which is the one
 * argument shape that silently runs nothing (see `testFileGlobs`).
 */
export function buildCommand(
  bin: string,
  runner: TestRunnerName,
  layout: Artifacts,
  withCoverage: boolean,
  testPaths: readonly string[],
): readonly string[] {
  if (runner === "vitest") {
    return vitestCommand(bin, layout, withCoverage);
  }
  if (runner === "node") {
    return nodeCommand(bin, layout, withCoverage, testFileGlobs(testPaths));
  }
  return bunCommand(bin, layout, withCoverage);
}

/**
 * `test_paths` -> globs `node --test` can actually consume.
 *
 * A BARE DIRECTORY DOES NOT WORK, and it fails in the worst available way.
 * `node --test test` treats the argument as a module specifier and dies with
 * `Cannot find module .../test` before running anything, which the TAP reader
 * then parses as one failed test named after the directory. The caller sees a
 * complete report saying "1 test, 1 failed" — a plausible number, attached to
 * a suite that never ran. Node's runner does take globs, so each configured
 * directory becomes one.
 *
 * Brace expansion only, deliberately: `{a,b}` works on every Node this package
 * supports, while extglob (`@(a|b)`) is not guaranteed to. A glob that matches
 * nothing costs nothing here — the runner reports zero tests for it, and a
 * zero-test run is evidence of nothing, which the callers check for.
 *
 * vitest and bun ignore this list entirely and discover their own files.
 */
const TEST_FILE_GLOB = "**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";

function testFileGlobs(testPaths: readonly string[]): readonly string[] {
  return testPaths.map((path) => `${path.replace(/\/+$/u, "")}/${TEST_FILE_GLOB}`);
}

/**
 * vitest.
 *
 * `--outputFile` is not politeness: without it the JSON reporter logs the
 * document through vitest's ordinary logger, interleaved on stdout with
 * everything else — and vitest 5 flips the default the other way, to a file
 * under `.vitest/`. Naming the file makes the read correct under both.
 *
 * `--includeTaskLocation` is what populates `location` on each assertion.
 * vitest force-enables it for the UI and html reporters but NOT for json, so
 * without this flag every failure loses its definition-site line number.
 *
 * `--coverage.reportOnFailure` matters more than it looks: it defaults to
 * false, and `reportCoverage()` returns early when any test failed. Without
 * it, the run that most needs a coverage number produces none.
 *
 * NO `--coverage.thresholds.*` IS PASSED, deliberately. vitest signals a
 * threshold miss with `process.exitCode = 1` — the same code as a failing
 * test — so delegating the threshold would destroy the distinction between
 * "tests fail" and "coverage slipped". kragg computes the percentage itself.
 */
function vitestCommand(bin: string, layout: Artifacts, withCoverage: boolean): readonly string[] {
  const command = [
    bin,
    "run",
    "--reporter=json",
    `--outputFile=${layout.reportFile}`,
    "--includeTaskLocation",
  ];
  if (withCoverage) {
    command.push(
      "--coverage",
      "--coverage.reporter=json",
      `--coverage.reportsDirectory=${layout.coverageDir}`,
      "--coverage.reportOnFailure",
    );
  }
  return command;
}

/**
 * `node --test`, with TWO reporters in one run.
 *
 * Node pairs each `--test-reporter` with the `--test-reporter-destination`
 * that FOLLOWS it, so results go to stdout as TAP while coverage goes to a
 * file as lcov. The order is load-bearing; do not reorder these four flags.
 *
 * No `--test-coverage-lines` is passed. It exists (Node 22.8+) and it works,
 * but it collapses a coverage miss into the same exit 1 as a test failure —
 * and on Node 20 it is an unknown flag that aborts the run outright.
 */
function nodeCommand(
  bin: string,
  layout: Artifacts,
  withCoverage: boolean,
  globs: readonly string[],
): readonly string[] {
  const command = [bin, "--test", "--test-reporter=tap", "--test-reporter-destination=stdout"];
  if (withCoverage) {
    command.push(
      "--experimental-test-coverage",
      "--test-reporter=lcov",
      `--test-reporter-destination=${layout.lcovFile}`,
    );
  }
  command.push(...globs);
  return command;
}

/**
 * `bun test`.
 *
 * No result reporter is requested: bun's only machine-readable one is JUnit
 * XML, which needs an XML parser this project will not add
 * (`docs/dependency-policy.md`). The console output is scraped for detail in
 * `bunTestReport.ts` and the exit code decides pass/fail.
 */
function bunCommand(bin: string, layout: Artifacts, withCoverage: boolean): readonly string[] {
  const command = [bin, "test"];
  if (withCoverage) {
    command.push("--coverage", "--coverage-reporter=lcov", `--coverage-dir=${layout.coverageDir}`);
  }
  return command;
}
