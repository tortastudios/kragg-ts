/**
 * Test-quality gate: coverage is gameable, assertions are not.
 *
 * The port of `kragg/src/kragg/gates/test_quality.py`, keeping both of its
 * checks and both of its violation codes:
 *
 *  - **`no-assert`** — every test case must contain at least one assertion. A
 *    test that cannot fail verifies nothing, yet it still lights up a coverage
 *    report, which is precisely why coverage alone is not evidence;
 *  - **`critical-untested`** — every PUBLIC CRITICAL function (from
 *    `.kragg/criticality.json`) must be REFERENCED by the test suite: some
 *    identifier in a test file, outside any skipped or todo test, must bind
 *    to the function through the type checker. Python does a substring
 *    search over the test corpus, which a comment, a string literal or an
 *    unrelated same-named symbol satisfies; a bound identifier is satisfied
 *    only by code that reaches the function. It is still a floor. A bound
 *    reference says a test EXERCISES the function, not that its assertions
 *    would catch a wrong answer — see `testDepth/references.ts`.
 *
 * ── WHAT CHANGED IN THE PORT ───────────────────────────────────────────────
 * Python collects `def test_*` from files named `test_*.py`. Here a test is a
 * CALL (`it(...)`, `test(...)`) — see `testDepth/testCases.ts` for the runner
 * detection and `testDepth/assertions.ts` for what counts as an assertion, both
 * of which document their rules and their known gaps in full.
 *
 * FILE SELECTION IS BROADER THAN PYTHON'S, on purpose. Every TypeScript file
 * under the policy's `testPaths` is scanned, not only ones matching a
 * `*.test.ts` naming convention, and every one of them is part of the corpus
 * for the reference check. A shared `test/helpers.ts` IS part of the test
 * suite: a function it binds is a function the suite reaches, and excluding
 * it would flag critical functions that the suite genuinely exercises through
 * a wrapper. Files holding no test calls contribute nothing to the first
 * check, so the wider net costs nothing but a parse. The one cost is a
 * test-tree FIXTURE that deliberately contains a broken test — mark it with
 * `// kragg: ignore -- <reason>`, which this gate honours per site.
 *
 * THE REFERENCE CHECK NEEDS THE PROGRAM. Binding an identifier to a
 * declaration is the checker's job, so the run's shared program is loaded —
 * only when there is a critical function to look for — and a program that
 * will not build makes the gate `error: true` rather than fall back to text.
 * A test file the `tsconfig.json` does not include has no checker view and
 * yields no evidence; the finding says so and names the files.
 *
 * ── WHEN THIS GATE DOES NOT RUN ────────────────────────────────────────────
 * No parsable file under any test path means the gate SKIPS with that reason.
 * Python returns no violations there, which reads as a pass — a repo with no
 * tests at all reporting green on a test-quality gate is the exact fail-open
 * behaviour AGENTS.md forbids, so this one says so instead.
 */

import type { AnalysisProgram } from "../analysis/program.ts";
import {
  parsedSources,
  resolveTypeScript,
  type ParsedSource,
  type TypeScriptApi,
} from "../analysis/sourceFile.ts";
import type { Violation } from "../engine/models.ts";
import { suppression, unhonouredMessage } from "../util/suppress.ts";
import { assertionContext, hasAssertion } from "./testDepth/assertions.ts";
import {
  criticalFunctions,
  declarationProblem,
  hasCriticalityData,
  simpleName,
  type CriticalFunction,
} from "./testDepth/criticalFunctions.ts";
import { failed, ran, skipped, type TestDepthOutcome } from "./testDepth/outcome.ts";
import {
  fileEvidence,
  mergeReferences,
  OUTSIDE_PROGRAM_NOTE,
  referenceResolver,
  type BoundReferences,
} from "./testDepth/references.ts";
import { findTestCases } from "./testDepth/testCases.ts";

/** `Violation.code` for a test case with no assertion. */
export const NO_ASSERT_CODE = "no-assert";

/** `Violation.code` for a critical function no test binds. */
export const CRITICAL_UNTESTED_CODE = "critical-untested";

/** Fix hint for `no-assert`, worded exactly as the Python original. */
export const NO_ASSERT_FIX_HINT =
  "assert on behavior; a test that cannot fail verifies nothing";

/** Note appended when the only references sit in tests that do not run. */
export const SKIPPED_ONLY_NOTE =
  "referenced only inside skipped or todo tests, which do not count";

export interface TestQualityOptions {
  readonly root: string;
  /** Policy `testPaths` — `["test", "tests"]` by default. */
  readonly testPaths: readonly string[];
  /**
   * Policy `sourcePaths`. Python's gate does not take these; this one must,
   * because deciding whether a critical function is PUBLIC means reading its
   * module's exports — see `testDepth/criticalFunctions.ts`. Omit them and the
   * reference check is skipped rather than run against a wrong answer.
   */
  readonly sourcePaths?: readonly string[] | undefined;
  /**
   * The run's shared program, for binding test identifiers to critical
   * functions. Loaded only when there is a critical function to look for.
   */
  readonly program: AnalysisProgram;
  /** Compiler to parse with. Defaults to the project's own. */
  readonly api?: TypeScriptApi | undefined;
}

/**
 * Report weak tests and unreferenced critical functions.
 *
 * Assertion violations come first, in file order then line order, followed by
 * the reference violations in criticality-file order — the same arrangement
 * Python produces, so two runs over an unchanged tree diff cleanly.
 */
export function checkTestQuality(options: TestQualityOptions): TestDepthOutcome {
  const api = options.api ?? resolveTypeScript(options.root).api;
  const sources = [...parsedSources(options.root, options.testPaths, { api })];
  if (sources.length === 0) {
    return skipped(
      `no test files found (looked in ${options.testPaths.join(", ")})`,
    );
  }
  // Same rule as `critical-tests`: a `critical_functions` entry that matches
  // no analysed function is a lost protection, and this gate is one of the
  // three that would otherwise quietly stop enforcing it.
  const stale = hasCriticalityData(options.root) ? declarationProblem(options.root) : null;
  if (stale !== null) {
    return failed(stale);
  }
  const references = referenceViolations(options, sources, api);
  if (!references.ok) {
    return references;
  }
  return ran([...assertionViolations(sources, api), ...references.violations]);
}

/** One violation per test case whose body cannot fail. */
function assertionViolations(
  sources: readonly ParsedSource[],
  api: TypeScriptApi,
): readonly Violation[] {
  const violations: Violation[] = [];
  for (const source of sources) {
    const cases = findTestCases(source.sourceFile, api);
    if (cases.length === 0) {
      continue;
    }
    const context = assertionContext(source, api);
    for (const testCase of cases) {
      if (testCase.skipped || hasAssertion(testCase.body, context)) {
        continue;
      }
      const marker = suppression(source.lines, testCase.line, testCase.endLine);
      if (marker.kind === "honoured") {
        continue;
      }
      violations.push({
        message: unhonouredMessage(`${testCase.title} has no assertions`, marker),
        file: source.relative,
        line: testCase.line,
        code: NO_ASSERT_CODE,
        fixHint: NO_ASSERT_FIX_HINT,
      });
    }
  }
  return violations;
}

/** The reference check's findings, or the program failure that stopped it. */
type ReferenceOutcome =
  | { readonly ok: true; readonly violations: readonly Violation[] }
  | { readonly ok: false; readonly message: string };

/**
 * One violation per public critical function no running test binds.
 *
 * The corpus is every scanned file's checker view, merged: a function bound
 * anywhere in the test tree, outside a skipped or todo test, is referenced.
 * The program is loaded only once there is a critical function to look for,
 * so a repo without criticality data never pays for it here.
 */
function referenceViolations(
  options: TestQualityOptions,
  sources: readonly ParsedSource[],
  api: TypeScriptApi,
): ReferenceOutcome {
  const sourcePaths = options.sourcePaths ?? [];
  if (sourcePaths.length === 0) {
    return { ok: true, violations: [] };
  }
  const critical = criticalFunctions(options.root, sourcePaths, { api });
  if (critical.length === 0) {
    return { ok: true, violations: [] };
  }
  const loaded = referenceResolver(options.program, sourcePaths);
  if (!loaded.ok) {
    return { ok: false, message: loaded.message };
  }
  const outside: string[] = [];
  const parts: BoundReferences[] = [];
  for (const source of sources) {
    const evidence = fileEvidence(loaded.resolver, source.relative);
    if (evidence.kind === "resolved") {
      parts.push(evidence.references);
    } else {
      outside.push(source.relative);
    }
  }
  return {
    ok: true,
    violations: unreferenced(critical, mergeReferences(parts), outside),
  };
}

/**
 * The critical functions the merged evidence does not bind, as findings.
 *
 * The message distinguishes the three ways a function ends up here — nothing
 * binds it, only a skipped test binds it, or the test files that might have
 * are outside the program — because each has a different fix. No file or
 * line: the finding is about the test suite as a whole, and there is no
 * honest place to point at.
 */
function unreferenced(
  critical: readonly CriticalFunction[],
  bound: BoundReferences,
  outside: readonly string[],
): readonly Violation[] {
  const violations: Violation[] = [];
  for (const { qualname, declaredReason } of critical) {
    if (bound.functions.has(qualname)) {
      continue;
    }
    // A declared function is named with the reviewer's reason: this gate's
    // finding is "nobody tests the authorization entrypoint", and saying so
    // is the difference between a fix and a suppression.
    const why = declaredReason === undefined ? "" : ` (declared: ${declaredReason})`;
    const note = bound.skippedFunctions.has(qualname)
      ? ` (${SKIPPED_ONLY_NOTE})`
      : outsideNote(outside);
    const simple = simpleName(qualname);
    violations.push({
      message: `no test references critical function ${qualname}${why}${note}`,
      code: CRITICAL_UNTESTED_CODE,
      fixHint: `add a test that exercises ${simple}, directly or through a helper`,
    });
  }
  return violations;
}

/** ` (2 test files are outside …: test/a.ts, test/b.ts)`, or nothing. */
function outsideNote(outside: readonly string[]): string {
  if (outside.length === 0) {
    return "";
  }
  const noun = outside.length === 1 ? "test file is" : "test files are";
  return ` (${outside.length} ${noun} ${OUTSIDE_PROGRAM_NOTE}: ${outside.join(", ")})`;
}
