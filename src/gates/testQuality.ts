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
 *    `.kragg/criticality.json`) must be referenced by name somewhere in the
 *    test suite. This is a deliberately weak, deliberately cheap check: a
 *    substring search over the test corpus, exactly as Python does it. It
 *    cannot tell a real exercise from a mention in a comment, and it is not
 *    meant to. It catches the case that matters — the highest-fan-in function
 *    in the codebase appearing NOWHERE in the tests.
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
 * suite: excluding it would flag critical functions that the suite genuinely
 * exercises. Files holding no test calls contribute nothing to the first check,
 * so the wider net costs nothing but a parse. The one cost is a test-tree
 * FIXTURE that deliberately contains a broken test — mark it with
 * `// kragg: ignore -- <reason>`, which this gate honours per site.
 *
 * ── WHEN THIS GATE DOES NOT RUN ────────────────────────────────────────────
 * No parsable file under any test path means the gate SKIPS with that reason.
 * Python returns no violations there, which reads as a pass — a repo with no
 * tests at all reporting green on a test-quality gate is the exact fail-open
 * behaviour AGENTS.md forbids, so this one says so instead.
 */

import {
  parsedSources,
  resolveTypeScript,
  type ParsedSource,
  type TypeScriptApi,
} from "../analysis/sourceFile.ts";
import type { Violation } from "../engine/models.ts";
import { suppression, unhonouredMessage } from "../util/suppress.ts";
import { assertionContext, hasAssertion } from "./testDepth/assertions.ts";
import { publicCriticalNames, simpleName } from "./testDepth/criticalFunctions.ts";
import { ran, skipped, type TestDepthOutcome } from "./testDepth/outcome.ts";
import { findTestCases } from "./testDepth/testCases.ts";

/** `Violation.code` for a test case with no assertion. */
export const NO_ASSERT_CODE = "no-assert";

/** `Violation.code` for a critical function no test mentions. */
export const CRITICAL_UNTESTED_CODE = "critical-untested";

/** Fix hint for `no-assert`, worded exactly as the Python original. */
export const NO_ASSERT_FIX_HINT =
  "assert on behavior; a test that cannot fail verifies nothing";

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
  return ran([
    ...assertionViolations(sources, api),
    ...referenceViolations(options.root, options.sourcePaths ?? [], sources, api),
  ]);
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

/**
 * One violation per public critical function the test corpus never mentions.
 *
 * The corpus is the raw text of every scanned file, and the search is a plain
 * SUBSTRING match on the function's simple name, matching Python's
 * `if simple not in corpus`. Substring rather than a word boundary is the
 * lenient reading — `send` is satisfied by `sendAll` — and lenient is right for
 * a check whose only job is to catch the total absence of a name.
 *
 * No file or line: the finding is about the test suite as a whole, and there is
 * no honest place to point at.
 */
function referenceViolations(
  root: string,
  sourcePaths: readonly string[],
  sources: readonly ParsedSource[],
  api: TypeScriptApi,
): readonly Violation[] {
  if (sourcePaths.length === 0) {
    return [];
  }
  const critical = publicCriticalNames(root, sourcePaths, api);
  if (critical.length === 0) {
    return [];
  }
  const corpus = sources.map((source) => source.lines.join("\n")).join("\n");
  const violations: Violation[] = [];
  for (const qualname of critical) {
    const simple = simpleName(qualname);
    if (simple !== "" && !corpus.includes(simple)) {
      violations.push({
        message: `no test references critical function ${qualname}`,
        code: CRITICAL_UNTESTED_CODE,
        fixHint: `add a test exercising ${simple} directly`,
      });
    }
  }
  return violations;
}
