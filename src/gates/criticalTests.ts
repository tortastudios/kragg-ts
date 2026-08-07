/**
 * Gate: critical functions must not change without test changes.
 *
 * The port of `kragg/src/kragg/gates/critical_tests.py`, rule for rule. It
 * intersects two cheap facts — what git says changed, and what
 * `.kragg/criticality.json` says is load-bearing — and fails when a public
 * critical function's file was edited while the test suite was not. It says
 * nothing about whether the test is GOOD; `test-quality` and
 * `critical-coverage` are the gates for that. This one closes the specific
 * hole where the highest-fan-in function in the codebase is quietly rewritten
 * in a commit that touches no test at all.
 *
 * ── THE RULE, EXACTLY ──────────────────────────────────────────────────────
 *  1. the change set is the WORKING TREE against `HEAD` (Python passes
 *     `since=None`), narrowed to `sourcePaths + testPaths`, untracked files
 *     included;
 *  2. an empty change set passes — nothing was touched;
 *  3. if ANY changed file is a test file, the whole gate passes. It is
 *     deliberately coarse: one test change anywhere is taken as evidence that
 *     the author was thinking about tests. Demanding a test change per changed
 *     function would need a mapping this data cannot support, and would be
 *     wrong the moment one test covers two functions;
 *  4. otherwise every PUBLIC critical function defined in a changed file is a
 *     violation. Private ones are exempt, as in Python.
 *
 * ── TWO DIVERGENCES, BOTH DELIBERATE ───────────────────────────────────────
 * COLOCATED TESTS COUNT. Python decides "is a test change" by path prefix
 * alone (`tests/`). Half the TypeScript ecosystem writes `src/foo.test.ts`
 * next to `src/foo.ts`, where a prefix rule sees a source change and no test
 * change — a systematic false positive on every such repo. So a changed file
 * is a test change if it sits under a test path OR its name matches the
 * `*.test.*` / `*.spec.*` convention.
 *
 * OUTSIDE A GIT REPOSITORY IT SKIPS, IT DOES NOT PASS. Python returns no
 * violations when `changed_python_files` comes back empty, and `changedFiles`
 * here returns `null` — not `[]` — precisely so the two situations stay
 * distinguishable (see `git/changes.ts`). "I could not look" is reported as a
 * visible skip; reporting it as a pass would be a green from a gate that never
 * ran.
 */

import { changedFiles } from "../git/changes.ts";
import type { Violation } from "../engine/models.ts";
import type { TypeScriptApi } from "../analysis/sourceFile.ts";
import {
  criticalFunctions,
  hasCriticalityData,
  type CriticalFunction,
} from "./testDepth/criticalFunctions.ts";
import {
  NO_CRITICALITY_REASON,
  ran,
  skipped,
  type TestDepthOutcome,
} from "./testDepth/outcome.ts";

/** `Violation.code` for every finding this gate produces. */
export const CRITICAL_TESTS_CODE = "critical-tests";

/** Skip reason when git cannot answer what changed. */
export const NOT_A_REPOSITORY_REASON =
  "not a git repository (nothing to diff a change set against)";

/** Filenames the ecosystem uses for a colocated test. */
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

export interface CriticalTestsOptions {
  readonly root: string;
  /** Policy `sourcePaths`. */
  readonly sourcePaths: readonly string[];
  /** Policy `testPaths`. */
  readonly testPaths: readonly string[];
  /**
   * Ref to diff against. `null` (the default) is Python's behaviour: the
   * working tree against `HEAD`. A branch name diffs from the merge base, so
   * `--since main` reports what this branch changed.
   */
  readonly since?: string | null | undefined;
  /** Compiler used to map modules to files. Defaults to the project's own. */
  readonly api?: TypeScriptApi | undefined;
}

/** Return violations for critical functions changed without test changes. */
export async function checkCriticalTests(
  options: CriticalTestsOptions,
): Promise<TestDepthOutcome> {
  if (!hasCriticalityData(options.root)) {
    return skipped(NO_CRITICALITY_REASON);
  }
  const changed = await changedFiles(options.root, options.since ?? null, [
    ...options.sourcePaths,
    ...options.testPaths,
  ]);
  if (changed === null) {
    return skipped(NOT_A_REPOSITORY_REASON);
  }
  if (changed.length === 0 || changed.some((file) => isTestChange(file, options.testPaths))) {
    return ran([]);
  }
  const changedSet = new Set(changed);
  // The conditional spread is the `exactOptionalPropertyTypes` idiom: passing
  // `api: undefined` explicitly is a type error, so an absent key and a
  // present-but-undefined one are different things. Here the wrapping object
  // literal genuinely was redundant, so it is gone; the spread is not.
  const violations = criticalFunctions(
    options.root,
    options.sourcePaths,
    options.api === undefined ? {} : { api: options.api },
  )
    .filter((critical) => changedSet.has(critical.file))
    .map(toViolation);
  return ran(violations);
}

function toViolation(critical: CriticalFunction): Violation {
  return {
    message:
      `critical function ${critical.qualname} (fan-in ${critical.fanIn}) ` +
      "changed without test changes",
    file: critical.file,
    code: CRITICAL_TESTS_CODE,
    fixHint:
      `add or update a test covering ${critical.name}, or revert the change`,
  };
}

/**
 * Whether a changed path counts as a test change.
 *
 * Prefix matching is segment-aware — `test` matches `test/a.ts` but not
 * `testing/a.ts` — mirroring `isAllowed` in `git/changes.ts`, which is what
 * produced this list in the first place.
 */
function isTestChange(file: string, testPaths: readonly string[]): boolean {
  const path = normalize(file);
  if (TEST_FILE_PATTERN.test(path)) {
    return true;
  }
  return testPaths.some((prefix) => {
    const base = normalize(prefix);
    if (base === "" || base === ".") {
      return true;
    }
    return path === base || path.startsWith(`${base}/`);
  });
}

function normalize(value: string): string {
  let path = value.replaceAll("\\", "/");
  while (path.startsWith("./")) {
    path = path.slice(2);
  }
  while (path.endsWith("/") && path.length > 1) {
    path = path.slice(0, -1);
  }
  return path;
}
