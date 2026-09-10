/**
 * Gate: critical functions must not change without relevant test changes.
 *
 * The port of `kragg/src/kragg/gates/critical_tests.py`, with one rule made
 * stricter. It intersects two cheap facts — what git says changed, and what
 * `.kragg/criticality.json` says is load-bearing — and fails when a public
 * critical function's file was edited while no test that reaches it was. It
 * says nothing about whether the test is GOOD; `test-quality` and
 * `critical-coverage` are the gates for that. This one closes the specific
 * hole where the highest-fan-in function in the codebase is quietly rewritten
 * in a commit whose only test change is somewhere else entirely.
 *
 * ── THE RULE, EXACTLY ──────────────────────────────────────────────────────
 *  1. the change set is the WORKING TREE against `HEAD` (Python passes
 *     `since=None`), narrowed to `sourcePaths + testPaths`, untracked files
 *     included;
 *  2. an empty change set passes — nothing was touched;
 *  3. every PUBLIC critical function defined in a changed file is a
 *     candidate. Private ones are exempt, as in Python. No candidate: pass;
 *  4. a candidate is SATISFIED by a changed test file that binds the
 *     function, or binds anything in the function's module — directly, or
 *     through the test-tree modules it imports (a shared `test/helpers.ts`),
 *     with aliases and re-exports followed by the type checker. See
 *     `testDepth/references.ts` for what a bound reference is and what it
 *     does and does not prove;
 *  5. every unsatisfied candidate is a violation. When test files DID change,
 *     the message lists the ones examined and why each did not qualify: it
 *     binds neither the function nor its module, it binds the function only
 *     inside a skipped or todo test, or it lies outside the `tsconfig.json`
 *     program and so could not be resolved at all.
 *
 * ── WHY "OR ITS MODULE" ────────────────────────────────────────────────────
 * The evidence asked for is that the author touched a test that exercises
 * the changed code, not that a test names the exact function: a module's
 * test file that constructs its class or calls its public entry point is
 * the test a reviewer would expect to see edited. Demanding the function by
 * name would reject that, and rejecting valid indirect tests is how a gate
 * gets switched off. The link is still a checker-resolved binding, never a
 * path or a name.
 *
 * ── THREE DIVERGENCES, ALL DELIBERATE ──────────────────────────────────────
 * A TEST CHANGE MUST BE RELEVANT. Python passes the whole gate when ANY
 * changed file sits under `tests/`. That let a whitespace edit in an
 * unrelated test file vouch for a rewrite of the authorization entry point.
 * Here the changed test must bind the function or its module.
 *
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
 *
 * ── WHEN THE PROGRAM IS NEEDED ─────────────────────────────────────────────
 * Only rule 4 needs the checker, so the run's shared program is loaded only
 * when a critical function changed AND a test file changed. A program that
 * will not build is then `error: true` (exit 3) rather than a pass or a
 * fall-back to text matching.
 */

import { changedFiles } from "../git/changes.ts";
import type { Violation } from "../engine/models.ts";
import type { AnalysisProgram } from "../analysis/program.ts";
import {
  absolutePath,
  parsedSources,
  parseSourceFile,
  resolveTypeScript,
  type ParsedSource,
  type TypeScriptApi,
} from "../analysis/sourceFile.ts";
import {
  criticalFunctions,
  declarationProblem,
  hasCriticalityData,
  type CriticalFunction,
} from "./testDepth/criticalFunctions.ts";
import {
  failed,
  NO_CRITICALITY_REASON,
  ran,
  skipped,
  type TestDepthOutcome,
} from "./testDepth/outcome.ts";
import {
  fileEvidence,
  isUnderAny,
  mergeReferences,
  normalizePath,
  OUTSIDE_PROGRAM_NOTE,
  referenceResolver,
  type BoundReferences,
  type ReferenceResolver,
} from "./testDepth/references.ts";

/** `Violation.code` for every finding this gate produces. */
export const CRITICAL_TESTS_CODE = "critical-tests";

/** Skip reason when git cannot answer what changed. */
export const NOT_A_REPOSITORY_REASON =
  "not a git repository (nothing to diff a change set against)";

/** Filenames the ecosystem uses for a colocated test. */
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** How many examined test files a message names before summarising. */
const EXAMINED_CAP = 5;

export interface CriticalTestsOptions {
  readonly root: string;
  /** Policy `sourcePaths`. */
  readonly sourcePaths: readonly string[];
  /** Policy `testPaths`. */
  readonly testPaths: readonly string[];
  /**
   * The run's shared program, for binding changed tests to changed functions.
   * Loaded only when both a critical function and a test file changed.
   */
  readonly program: AnalysisProgram;
  /**
   * Ref to diff against. `null` (the default) is Python's behaviour: the
   * working tree against `HEAD`. A branch name diffs from the merge base, so
   * `--since main` reports what this branch changed.
   */
  readonly since?: string | null | undefined;
  /** Compiler used to map modules to files. Defaults to the project's own. */
  readonly api?: TypeScriptApi | undefined;
}

/** Return violations for critical functions changed without relevant test changes. */
export async function checkCriticalTests(
  options: CriticalTestsOptions,
): Promise<TestDepthOutcome> {
  if (!hasCriticalityData(options.root)) {
    return skipped(NO_CRITICALITY_REASON);
  }
  // A reviewed declaration that names nothing is a protection that has gone
  // missing, not a finding about the code: `error: true`, exit 3, before any
  // conclusion is drawn from a population it should have been part of.
  const stale = declarationProblem(options.root);
  if (stale !== null) {
    return failed(stale);
  }
  const changed = await changedFiles(options.root, options.since ?? null, [
    ...options.sourcePaths,
    ...options.testPaths,
  ]);
  if (changed === null) {
    return skipped(NOT_A_REPOSITORY_REASON);
  }
  const changedSet = new Set(changed);
  // The conditional spread is the `exactOptionalPropertyTypes` idiom: passing
  // `api: undefined` explicitly is a type error, so an absent key and a
  // present-but-undefined one are different things.
  const candidates = criticalFunctions(
    options.root,
    options.sourcePaths,
    options.api === undefined ? {} : { api: options.api },
  ).filter((critical) => changedSet.has(critical.file));
  if (candidates.length === 0) {
    return ran([]);
  }
  const changedTests = changed.filter((file) => isTestChange(file, options.testPaths));
  if (changedTests.length === 0) {
    return ran(candidates.map((critical) => toViolation(critical, [])));
  }
  return evidenceOutcome(options, candidates, changedTests);
}

/**
 * Rule 4: bind the changed tests, and report the candidates none vouches for.
 *
 * The program is loaded here and nowhere earlier, so the three cheaper exits
 * above never pay for it. The test-tree index is built once for every
 * changed test file, not once per file.
 */
function evidenceOutcome(
  options: CriticalTestsOptions,
  candidates: readonly CriticalFunction[],
  changedTests: readonly string[],
): TestDepthOutcome {
  const loaded = referenceResolver(options.program, options.sourcePaths);
  if (!loaded.ok) {
    return failed(loaded.message);
  }
  const api = options.api ?? resolveTypeScript(options.root).api;
  const testModules = new Map<string, ParsedSource>();
  for (const source of parsedSources(options.root, options.testPaths, { api })) {
    testModules.set(source.module, source);
  }
  const examined = changedTests.map((file) =>
    examine(file, loaded.resolver, options.root, testModules, api),
  );
  const violations = candidates
    .filter((critical) => !examined.some((test) => supports(test, critical)))
    .map((critical) => toViolation(critical, examined));
  return ran(violations);
}

/** One changed test file, with everything its test-tree imports bind. */
interface ExaminedTest {
  readonly file: string;
  readonly references: BoundReferences;
  /** The file itself has no checker view; its helpers may still have one. */
  readonly outsideProgram: boolean;
}

/**
 * Resolve a changed test file plus the test-tree modules it imports.
 *
 * The closure follows `ParsedSource.imports` — the same table `assertions.ts`
 * reads — but only into modules under the test paths: a helper is part of the
 * suite, a source module is the thing under test. Every file in the closure
 * that the program contains contributes its bound references; the changed
 * file being outside the program is recorded so the message can say so.
 */
function examine(
  file: string,
  resolver: ReferenceResolver,
  root: string,
  testModules: ReadonlyMap<string, ParsedSource>,
  api: TypeScriptApi,
): ExaminedTest {
  const start = parseSourceFile(absolutePath(root, file), root, api);
  const queue: string[] = [];
  const visited = new Set<string>([normalizePath(file)]);
  const enqueueImports = (source: ParsedSource): void => {
    for (const target of source.imports.values()) {
      const module = target.slice(0, target.lastIndexOf("#"));
      const helper = testModules.get(module);
      if (helper !== undefined && !visited.has(helper.relative)) {
        visited.add(helper.relative);
        queue.push(helper.relative);
        enqueueImports(helper);
      }
    }
  };
  if (start !== null) {
    enqueueImports(start);
  }
  const parts: BoundReferences[] = [];
  let outsideProgram = false;
  for (const relative of [normalizePath(file), ...queue]) {
    const evidence = fileEvidence(resolver, relative);
    if (evidence.kind === "resolved") {
      parts.push(evidence.references);
    } else if (relative === normalizePath(file)) {
      outsideProgram = true;
    }
  }
  return { file, references: mergeReferences(parts), outsideProgram };
}

/** Whether one examined test vouches for a changed critical function. */
function supports(test: ExaminedTest, critical: CriticalFunction): boolean {
  return (
    test.references.functions.has(critical.qualname) ||
    test.references.modules.has(critical.module)
  );
}

/**
 * WHY IT IS CRITICAL travels with the finding, and so does WHAT WAS LOOKED AT.
 *
 * A violation about a function with fan-in 1 reads like a false positive
 * unless it says who asked for it, so a declared function is named with the
 * reviewer's reason instead of a metric nobody gated on. And a violation
 * raised while test files DID change must say which ones were examined and
 * why none qualified, or the author's next move is to edit one more
 * unrelated test.
 */
function toViolation(critical: CriticalFunction, examined: readonly ExaminedTest[]): Violation {
  const why =
    critical.declaredReason === undefined
      ? `fan-in ${critical.fanIn}`
      : `declared: ${critical.declaredReason}`;
  const message =
    examined.length === 0
      ? `critical function ${critical.qualname} (${why}) changed without test changes`
      : `critical function ${critical.qualname} (${why}) changed without a relevant ` +
        `test change: examined ${examinedSummary(examined, critical)}`;
  return {
    message,
    file: critical.file,
    code: CRITICAL_TESTS_CODE,
    fixHint:
      `add or update a test covering ${critical.name}, or revert the change`,
  };
}

/** `test/a.test.ts (no bound reference to send or module src/client), …`. */
function examinedSummary(
  examined: readonly ExaminedTest[],
  critical: CriticalFunction,
): string {
  const shown = examined.slice(0, EXAMINED_CAP).map(
    (test) => `${test.file} (${disqualification(test, critical)})`,
  );
  const more = examined.length - shown.length;
  return more > 0 ? `${shown.join(", ")}, and ${more} more` : shown.join(", ");
}

function disqualification(test: ExaminedTest, critical: CriticalFunction): string {
  const { references } = test;
  if (
    references.skippedFunctions.has(critical.qualname) ||
    references.skippedModules.has(critical.module)
  ) {
    return `binds ${critical.name} only inside a skipped or todo test`;
  }
  if (test.outsideProgram) {
    return OUTSIDE_PROGRAM_NOTE;
  }
  return `no bound reference to ${critical.name} or module ${critical.module}`;
}

/**
 * Whether a changed path counts as a test change.
 *
 * Prefix matching is segment-aware — `test` matches `test/a.ts` but not
 * `testing/a.ts` — mirroring `isAllowed` in `git/changes.ts`, which is what
 * produced this list in the first place.
 */
function isTestChange(file: string, testPaths: readonly string[]): boolean {
  return TEST_FILE_PATTERN.test(normalizePath(file)) || isUnderAny(file, testPaths);
}
