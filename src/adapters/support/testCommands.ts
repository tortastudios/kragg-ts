/**
 * Where each test runner's binary comes from, and exactly what it is invoked
 * with.
 *
 * Split out of `adapters/testRunner.ts` so the orchestration there stays
 * readable: every flag below carries a reason, and several of them are
 * non-obvious enough that burying them inside the control flow would get one
 * of them "cleaned up" eventually. They are all load-bearing.
 */

import { dirname, isAbsolute, join, resolve } from "node:path";

import { missingToolMessage, resolveBin } from "../../environment/project.ts";
import type { ProjectEnvironment } from "../../environment/project.ts";
import type { TestRunnerName } from "./detect.ts";
import { missingTool } from "./outcome.ts";
import type { Unavailable } from "./outcome.ts";

/** Default location of the istanbul report — vitest's own default path. */
export const DEFAULT_COVERAGE_REPORT = "coverage/coverage-final.json";

/** Where kragg writes its own run artifacts, mirroring Python's `.kragg/`. */
export const ARTIFACTS_DIR = ".kragg";

/** Absolute paths for everything a run reads or writes. */
export interface Artifacts {
  readonly root: string;
  /** vitest's `--outputFile` target. */
  readonly reportFile: string;
  /** Directory holding the coverage artifact. */
  readonly coverageDir: string;
  /** istanbul `coverage-final.json`, written by vitest. */
  readonly istanbulFile: string;
  /** lcov tracefile, written by `node --test` and `bun test`. */
  readonly lcovFile: string;
}

/**
 * Resolve every path from the ONE configured value.
 *
 * `coverage_report_path` names the istanbul report; the directory holding it
 * is then also where the runner is told to write, so the place kragg looks and
 * the place the runner writes cannot drift apart. Configuring one and
 * defaulting the other is how a coverage gate ends up reading last week's
 * report.
 */
export function artifacts(root: string, coverageReportPath: string | undefined): Artifacts {
  const configured = coverageReportPath ?? DEFAULT_COVERAGE_REPORT;
  const istanbulFile = isAbsolute(configured) ? configured : resolve(root, configured);
  const coverageDir = dirname(istanbulFile);
  return {
    root,
    reportFile: join(root, ARTIFACTS_DIR, "test-report.json"),
    coverageDir,
    istanbulFile,
    lcovFile: join(coverageDir, "lcov.info"),
  };
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

/** The argv for one run. Always an array; never a shell string. */
export function buildCommand(
  bin: string,
  runner: TestRunnerName,
  layout: Artifacts,
  withCoverage: boolean,
  testPatterns: readonly string[],
): readonly string[] {
  if (runner === "vitest") {
    return vitestCommand(bin, layout, withCoverage);
  }
  if (runner === "node") {
    return nodeCommand(bin, layout, withCoverage, testPatterns);
  }
  return bunCommand(bin, layout, withCoverage);
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
  patterns: readonly string[],
): readonly string[] {
  const command = [bin, "--test", "--test-reporter=tap", "--test-reporter-destination=stdout"];
  if (withCoverage) {
    command.push(
      "--experimental-test-coverage",
      "--test-reporter=lcov",
      `--test-reporter-destination=${layout.lcovFile}`,
    );
  }
  command.push(...patterns);
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
