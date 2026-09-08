/**
 * The `kragg check` pipeline, gate for gate.
 *
 * Ported from `build_check_gates` in `catalog.py`. The ORDER is part of the
 * contract, not a detail: an agent reading the output top to bottom should hit
 * the cheapest, most localized findings first (a lint rule, a type error) and
 * the expensive whole-suite ones last, so the first thing it fixes is the
 * thing most likely to make the rest disappear.
 *
 * TIERS. Every FAST gate runs even after one fails, so a single invocation
 * reveals every problem — an agent must never have to run the pipeline N times
 * to discover N issues. SLOW gates skip once any FAST gate failed, because
 * their results would be invalidated by the fixes anyway; `runGates` implements
 * that, so the only thing this module has to get right is the tier.
 *
 * NAME MAPPING from the Python sibling, since the tools differ but the roles
 * do not: `ruff` -> `lint`, `mypy` -> `tsc`, `radon-cc` -> `complexity`,
 * `radon-mi` -> `maintainability`, `pytest-coverage` -> `test-coverage`,
 * `pip-audit` -> `audit`. `detect-secrets` keeps its Python name because it
 * names the ROLE, not the tool, and the tool underneath is chosen at runtime.
 */

import { runLint } from "../adapters/lint.ts";
import { runTests, TEST_GATE } from "../adapters/testRunner.ts";
import { readTextFile } from "../adapters/support/manifest.ts";
import { artifacts } from "../adapters/support/testCommands.ts";
import { runTypeCheck } from "../adapters/tsc.ts";
import { readIstanbulReport } from "../coverage/istanbul.ts";
import { FAST, SLOW, type GateSpec } from "../engine/gate.ts";
import { checkLayers, checkStructure } from "../gates/architecture.ts";
import { cyclomaticViolations, maintainabilityViolations } from "../gates/complexity.ts";
import { checkCriticalCoverage } from "../gates/criticalCoverage.ts";
import { checkCriticalTests } from "../gates/criticalTests.ts";
import { halsteadViolations } from "../gates/halstead.ts";
import { checkNullableDefaults } from "../gates/nullableDefault.ts";
import { checkTestQuality } from "../gates/testQuality.ts";
import { checkTypeComplexity } from "../gates/typeComplexity.ts";
import { checkTypingStrictness } from "../gates/typingStrictness.ts";
import { unconfigured, type CatalogContext } from "./context.ts";
import {
  errorGate,
  fromLint,
  fromReport,
  fromSimple,
  fromTestDepth,
  fromTypingStrictness,
  nativeGate,
} from "./results.ts";
import { auditGate, forbiddenCallsGate, secretGates } from "./security.ts";

/** Assemble the full `kragg check` pipeline, in order. */
export function checkPipeline(ctx: CatalogContext): GateSpec[] {
  return [
    ...toolGates(ctx),
    ...metricGates(ctx),
    ...structureGates(ctx),
    forbiddenCallsGate(ctx),
    ...dataAndTestGates(ctx),
    ...secretGates(ctx),
    ...slowGates(ctx),
  ];
}

/** The two external checkers: the project's linter and its own compiler. */
function toolGates(ctx: CatalogContext): readonly GateSpec[] {
  return [
    {
      name: "lint",
      tier: FAST,
      run: async () =>
        fromLint(
          "lint",
          await runLint({
            env: ctx.env,
            setting: ctx.policy.lintTool,
            // A linter is per-file and can be scoped without changing what it
            // computes, so `--changed` narrows the invocation itself.
            paths: ctx.targets,
          }),
        ),
    },
    {
      name: "tsc",
      tier: FAST,
      run: async () => {
        // The mirror image of `lint` above: a type checker is NOT per-file,
        // so `ctx.paths` is an ORDER and never a scope. The whole project is
        // checked through its own tsconfig on every run and every diagnostic
        // is reported — the error a change causes is usually in a file that
        // did not change. See `orderByPaths` in `adapters/tsc.ts`.
        const outcome = await runTypeCheck({ env: ctx.env, paths: ctx.paths });
        // A project with no TypeScript compiler is a broken environment, not
        // an unconfigured gate: exit 3 and an install command, never a skip.
        return outcome.ok
          ? nativeGate("tsc", outcome.violations, outcome.command)
          : errorGate("tsc", outcome.message, outcome.command);
      },
    },
    {
      name: "typing-strictness",
      tier: FAST,
      run: () =>
        fromTypingStrictness(
          "typing-strictness",
          checkTypingStrictness({
            root: ctx.root,
            sourcePaths: ctx.policy.sourcePaths,
            api: ctx.api,
            paths: ctx.paths,
          }),
        ),
    },
  ];
}

/** The four numeric budgets: complexity, maintainability, effort, types. */
function metricGates(ctx: CatalogContext): readonly GateSpec[] {
  const { root, api } = ctx;
  const sources = ctx.policy.sourcePaths;
  return [
    {
      name: "complexity",
      tier: FAST,
      run: () => nativeGate("complexity", cyclomaticViolations(root, sources, { api })),
    },
    {
      name: "maintainability",
      tier: FAST,
      run: () =>
        nativeGate("maintainability", maintainabilityViolations(root, sources, { api })),
    },
    {
      name: "halstead",
      tier: FAST,
      run: () => nativeGate("halstead", halsteadViolations(root, sources, { api })),
    },
    {
      name: "type-complexity",
      tier: FAST,
      run: () =>
        nativeGate(
          "type-complexity",
          checkTypeComplexity({
            root,
            sourcePaths: sources,
            maxDepth: ctx.policy.typeMaxNestingDepth,
            maxLength: ctx.policy.typeMaxLength,
            api,
            paths: ctx.paths,
          }),
        ),
    },
  ];
}

/** Layering contracts and per-file structural budgets. */
function structureGates(ctx: CatalogContext): readonly GateSpec[] {
  const { policy } = ctx;
  return [
    {
      name: "boundaries",
      tier: FAST,
      run: () =>
        nativeGate("boundaries", checkLayers(ctx.root, policy.sourcePaths, policy.layers)),
      // Fewer than two layers cannot express a direction, so there is nothing
      // to enforce and the gate says so instead of passing.
      skipReason: unconfigured("no layers configured", policy.layers.length >= 2),
    },
    {
      name: "structure",
      tier: FAST,
      run: () =>
        nativeGate(
          "structure",
          checkStructure(
            ctx.root,
            policy.sourcePaths,
            policy.maxFileLines,
            policy.maxPublicSymbols,
            policy.structureExclude,
          ),
        ),
    },
  ];
}

/** Nullable data handled concretely, and whether the tests are real. */
function dataAndTestGates(ctx: CatalogContext): readonly GateSpec[] {
  const { policy } = ctx;
  return [
    {
      name: "nullable-default",
      tier: FAST,
      run: () =>
        fromSimple(
          "nullable-default",
          checkNullableDefaults({ program: ctx.program, paths: ctx.paths }),
        ),
    },
    {
      name: "critical-tests",
      tier: FAST,
      // DERIVE, DON'T SKIP. Python declares a spec-level skip here so that a
      // repo with no criticality data never pays for the git diff the gate
      // would run first. We can do better than not paying: `ensure()` produces
      // the data from the program this pipeline has already built, so the gate
      // RUNS on a repo that has never executed `kragg criticality --write` and
      // on one whose data the last edit outran. It is called here, inside the
      // run closure, so a run that never reaches this gate never pays for it.
      //
      // When the derivation cannot happen at all — an unusable tsconfig — the
      // gate still short-circuits on its own `hasCriticalityData` check before
      // the diff, so the saving Python is after survives the case that needs
      // it. See `criticalityCache.ts`.
      run: async () => {
        ctx.criticality.ensure();
        return fromTestDepth(
          "critical-tests",
          await checkCriticalTests({
            root: ctx.root,
            sourcePaths: policy.sourcePaths,
            testPaths: policy.testPaths,
            since: ctx.since ?? null,
            api: ctx.api,
          }),
        );
      },
    },
    {
      name: "test-quality",
      tier: FAST,
      // THIS IS THE GATE THE STALE FILE BIT. Its `critical-untested` findings
      // are read out of `criticality.json`, so a file naming functions that
      // have since been renamed made it report 35 findings against a truth of
      // 2. `ensure()` regenerates; `readJson` refuses anything `ensure()`
      // could not regenerate. The gate's other checks are unaffected either
      // way, which is why it is never skipped wholesale over this.
      run: () => {
        ctx.criticality.ensure();
        return fromTestDepth(
          "test-quality",
          checkTestQuality({
            root: ctx.root,
            testPaths: policy.testPaths,
            sourcePaths: policy.sourcePaths,
            api: ctx.api,
          }),
        );
      },
    },
  ];
}

/**
 * `test_paths` -> globs `node --test` can actually consume.
 *
 * A BARE DIRECTORY DOES NOT WORK, and it fails in the worst available way.
 * `node --test test` treats the argument as a module specifier and dies with
 * `Cannot find module .../test` before running anything, which the TAP reader
 * then parses as one failed test named after the directory. The gate goes red
 * with a violation that says nothing about the code, and the real suite never
 * ran. Node's runner does take globs, so each configured directory becomes one.
 *
 * Brace expansion only, deliberately: `{a,b}` works on every Node this package
 * supports, while extglob (`@(a|b)`) is not guaranteed to. A glob that matches
 * nothing costs nothing — the runner reports zero tests for it and moves on.
 *
 * vitest and bun ignore this list entirely and discover their own files.
 */
const TEST_FILE_GLOB = "**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";

function testPatterns(testPaths: readonly string[]): readonly string[] {
  return testPaths.map((path) => `${path.replace(/\/+$/u, "")}/${TEST_FILE_GLOB}`);
}

/** The suite, the critical-path coverage it produced, and the audit. */
function slowGates(ctx: CatalogContext): readonly GateSpec[] {
  const { policy } = ctx;
  return [
    {
      name: TEST_GATE,
      tier: SLOW,
      run: async () =>
        fromReport(
          TEST_GATE,
          await runTests({
            env: ctx.env,
            choice: policy.testRunner,
            coverageFailUnder: policy.coverageFailUnder,
            coverageReportPath: policy.coverageReportPath,
            maxViolations: policy.maxViolationsPerGate,
            testPatterns: testPatterns(policy.testPaths),
          }),
        ),
      skipReason: ctx.slowSkip,
    },
    {
      name: "critical-coverage",
      tier: SLOW,
      // The report is read at RUN time, not at build time: `test-coverage`
      // runs first in this same pipeline and writes it, so reading it while
      // assembling the specs would always read the previous run's file. The
      // criticality data is now on the same footing — derived here rather
      // than skipped over at build time. See `critical-tests` above.
      run: () => {
        ctx.criticality.ensure();
        // BOTH artifacts, because which one exists depends on the runner:
        // vitest writes istanbul JSON, `node --test` and `bun test` write
        // lcov. Passing only the first is what made this gate skip on every
        // node/bun project — a permanent SKIP that reads as "fine".
        const layout = artifacts(ctx.root, policy.coverageReportPath);
        const lcov = readTextFile(layout.lcovFile);
        return fromTestDepth(
          "critical-coverage",
          checkCriticalCoverage({
            root: ctx.root,
            sourcePaths: policy.sourcePaths,
            report: readIstanbulReport(layout.istanbulFile),
            ...(lcov === undefined ? {} : { lcov }),
            api: ctx.api,
          }),
        );
      },
      skipReason: ctx.slowSkip,
    },
    auditGate(ctx),
  ];
}
