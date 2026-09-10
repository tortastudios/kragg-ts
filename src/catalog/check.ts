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
import type { CoverageEvidence, TestRunOutcome } from "../adapters/testRunner.ts";
import { runTypeCheck } from "../adapters/tsc.ts";
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
  skipGate,
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

/** The suite, the critical-path coverage it produced, and the audit. */
function slowGates(ctx: CatalogContext): readonly GateSpec[] {
  const { policy } = ctx;
  return [
    {
      name: TEST_GATE,
      tier: SLOW,
      run: async () => {
        const outcome = await runTests({
          env: ctx.env,
          choice: policy.testRunner,
          coverageFailUnder: policy.coverageFailUnder,
          coverageReportPath: policy.coverageReportPath,
          maxViolations: policy.maxViolationsPerGate,
          testPaths: policy.testPaths,
          testCommand: policy.testCommand,
          sourcePaths: policy.sourcePaths,
          api: ctx.api,
        });
        // Recorded for `critical-coverage`, which reads THIS run's coverage
        // from here and never from disk. See `RunEvidence` in `context.ts`.
        ctx.evidence.testRun = outcome;
        return fromReport(TEST_GATE, outcome);
      },
      skipReason: ctx.slowSkip,
    },
    {
      name: "critical-coverage",
      tier: SLOW,
      // Consumes the evidence `test-coverage` produced in this same pipeline
      // — whichever format the runner wrote — and nothing else. Reading the
      // coverage files off disk here is what let a crashed runner's stale
      // report, or the previous runner's leftover istanbul JSON, decide this
      // gate. The criticality data is on the same footing: derived here
      // rather than skipped over at build time. See `critical-tests` above.
      run: () => {
        ctx.criticality.ensure();
        const coverage = currentCoverage(ctx.evidence.testRun);
        if (!coverage.ok) {
          return skipGate("critical-coverage", coverage.reason);
        }
        return fromTestDepth(
          "critical-coverage",
          checkCriticalCoverage({
            root: ctx.root,
            sourcePaths: policy.sourcePaths,
            report: coverage.evidence.format === "istanbul" ? coverage.evidence.raw : null,
            ...(coverage.evidence.format === "lcov" ? { lcov: coverage.evidence.report } : {}),
            api: ctx.api,
          }),
        );
      },
      skipReason: ctx.slowSkip,
    },
    auditGate(ctx),
  ];
}

/** This run's coverage document, or the reason there is none. */
type CurrentCoverage =
  | { readonly ok: true; readonly evidence: CoverageEvidence }
  | { readonly ok: false; readonly reason: string };

/**
 * What `critical-coverage` may believe: only coverage measured in this run.
 *
 * Every arm that is not evidence is a visible SKIP naming the cause. None is
 * an error here, because in every such arm `test-coverage` has already said
 * the same thing in its own result — an error there is exit 3 already, and a
 * skip there is a skip for the same reason. What this must never do is fall
 * back to a file on disk: a report nobody produced in this invocation is
 * exactly the evidence this gate must not accept.
 */
function currentCoverage(outcome: TestRunOutcome | undefined): CurrentCoverage {
  const prefix = "no coverage evidence from this run";
  if (outcome === undefined) {
    return { ok: false, reason: `${prefix}: test-coverage did not run in this invocation` };
  }
  if (!outcome.ok) {
    const what = outcome.kind === "not-configured" ? "was skipped" : "could not run";
    return { ok: false, reason: `${prefix}: test-coverage ${what} (${firstLine(outcome.message)})` };
  }
  if (outcome.coverage === null) {
    return {
      ok: false,
      reason:
        `${prefix}: coverage was not collected because \`coverage_fail_under\` is 0 or ` +
        "less; set it above 0 so test-coverage measures coverage for this gate",
    };
  }
  if (!outcome.coverage.ok) {
    return {
      ok: false,
      reason:
        `${prefix}: test-coverage could not read a complete coverage report ` +
        `(${firstLine(outcome.coverage.message)})`,
    };
  }
  return { ok: true, evidence: outcome.coverage.evidence };
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}
