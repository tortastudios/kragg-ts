/**
 * What every gate in a pipeline shares: root, policy, environment, ONE
 * program.
 *
 * THE PROGRAM IS THE REASON THIS TYPE EXISTS. `analysis/program.ts` spells out
 * the cost: `ts.createProgram` reads the whole transitive file graph, every
 * `lib.*.d.ts` and every `.d.ts` in `node_modules` the project touches, and
 * builds a type checker. On a real repo that is seconds. Two type-aware gates
 * each building their own is not a slow tool, it is an unusable one.
 *
 * So the handle is created ONCE, here, and passed to every gate that needs a
 * checker. Two properties matter and both are load-bearing:
 *
 *  1. SHARED, AND THIS IS THE ONLY THING SHARING IT. `forbidden-calls` and
 *     `nullable-default` receive the same handle, so the second one to run
 *     pays nothing. `analysisProgram` keeps no process-global cache of its
 *     own — it used to, and a second run in one process was then served the
 *     first run's pre-edit program — so the run context is the sole owner of
 *     the run's program, and the sharing is a property of the pipeline rather
 *     than an accident of a cache.
 *  2. STILL LAZY. Creating the handle only resolves the compiler; the program
 *     is built on the first `load()`. A run where no type-aware gate executes
 *     — every rule unconfigured, or `--changed` with nothing to check — must
 *     not pay a millisecond of it, and does not.
 *
 * `api` is taken from the SAME resolution, so the syntax-tier gates parse with
 * the identical compiler the type-aware ones use. Mixing two compilers across
 * one run means two different `SyntaxKind` numberings applied to one file set;
 * see the COMPILER IDENTITY note in `analysis/program.ts`.
 */

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type { TestRunOutcome } from "../adapters/testRunner.ts";
import { analysisProgram, type AnalysisProgram } from "../analysis/program.ts";
import type { TypeScriptApi } from "../analysis/sourceFile.ts";
import { JOURNAL_DIR } from "../engine/journal.ts";
import type { ProjectEnvironment } from "../environment/project.ts";
import { criticalityFreshness, STALE_CRITICALITY_REASON } from "../gates/criticality.ts";
import { NO_CRITICALITY_REASON } from "../gates/testDepth/outcome.ts";
import type { KraggPolicy } from "../policy/policy.ts";
import { testScanDirectories } from "../util/testPaths.ts";
import { criticalityCache, type CriticalityCache } from "./criticalityCache.ts";

/** Everything a caller must decide before a pipeline can be assembled. */
export interface CatalogOptions {
  /** Absolute or cwd-relative project root. */
  readonly root: string;
  readonly policy: KraggPolicy;
  readonly env: ProjectEnvironment;
  /**
   * Paths handed to the per-file external tools (the linter, the secret
   * scanner). Source directories in a full run; concrete files otherwise.
   */
  readonly targets: readonly string[];
  /**
   * Narrowing for the gates that accept a file list — the `--changed` and
   * `--file` paths. `undefined` means "scan the whole project", which is NOT
   * the same as an empty array, and the two must not be conflated: an empty
   * list is a run with nothing to check.
   */
  readonly paths?: readonly string[] | undefined;
  /** True for a `--changed`/`--file` run: slow gates are skipped wholesale. */
  readonly incremental?: boolean | undefined;
  /** `--since` ref, forwarded to `critical-tests`. */
  readonly since?: string | null | undefined;
}

/**
 * Evidence produced by a gate earlier in THIS run, for the gates that depend
 * on it.
 *
 * `critical-coverage` needs the coverage `test-coverage` just measured. It
 * used to re-read the coverage files from disk, which is how it came to
 * report on last week's report after a crash, and on the OTHER runner's
 * format after a runner switch (istanbul wins over lcov, whichever is newer).
 * The test gate now records its outcome here and the dependent gate reads
 * only this — evidence from this invocation or nothing. Mutable by design:
 * the pipeline is sequential, the producer writes once, the consumer reads
 * after.
 */
export interface RunEvidence {
  /** `test-coverage`'s outcome; `undefined` until that gate has run. */
  testRun: TestRunOutcome | undefined;
}

/** `CatalogOptions` plus the per-run analysis handles. */
export interface CatalogContext extends CatalogOptions {
  readonly root: string;
  readonly program: AnalysisProgram;
  readonly api: TypeScriptApi;
  /** Reason every SLOW gate skips, or `undefined` when they should run. */
  readonly slowSkip: string | undefined;
  /** What earlier gates in this run produced. See {@link RunEvidence}. */
  readonly evidence: RunEvidence;
  /**
   * Derive-with-cache for `.kragg/criticality.json`.
   *
   * LAZY, like `program`, and for the same reason: the gates that read
   * criticality data call `ensure()` from their RUN closures, so a run in
   * which none of them executes never builds a call graph. See
   * `criticalityCache.ts`.
   */
  readonly criticality: CriticalityCache;
}

/** Build the shared context. Creates the program handle; never loads it. */
export function catalogContext(options: CatalogOptions): CatalogContext {
  const root = resolve(options.root);
  // Mirrors `build_check_gates`, which mkdirs `.kragg` before assembling:
  // several gates write artifacts there and none of them should have to guess
  // whether the directory exists. Failure is ignored — a read-only checkout
  // still gets to run every gate that does not write.
  try {
    mkdirSync(join(root, JOURNAL_DIR), { recursive: true });
  } catch {
    // Deliberately swallowed: see above.
  }
  const program = analysisProgram({ root });
  return {
    ...options,
    root,
    program,
    api: program.compiler.api,
    slowSkip: options.incremental === true ? "incremental mode" : undefined,
    evidence: { testRun: undefined },
    criticality: criticalityCache({
      root,
      // Sources AND tests: both are in the program, so both contribute
      // call-graph nodes, and an edit to either can change the answer.
      scanPaths: [
        ...options.policy.sourcePaths,
        ...testScanDirectories(options.policy.testPaths),
      ],
      analysis: program,
    }),
  };
}

/**
 * The skip reason for a policy-driven gate with nothing configured.
 *
 * Ported from `_unconfigured`, whose one-line docstring is the whole rule:
 * "Unconfigured policy-driven gates SKIP visibly, never PASS silently." A
 * `boundaries` gate with no layers declared has checked nothing; printing
 * `[PASS] boundaries` for it teaches everyone reading the output that the
 * project's layering is enforced, and it is not.
 */
export function unconfigured(reason: string, configured: boolean): string | undefined {
  return configured ? undefined : reason;
}

/**
 * The skip reason for a repo whose `.kragg/criticality.json` cannot be used —
 * because it is absent, or because it no longer describes this tree.
 *
 * TWO MESSAGES, NOT ONE. The absent message is byte-identical to Python's
 * `_no_criticality_reason` (it lives in `testDepth/outcome.ts` as
 * `NO_CRITICALITY_REASON`) so both siblings tell a user the same thing to
 * type. Stale gets its own, because "you have never generated this" and "what
 * you generated has been outrun by your edits" are different situations even
 * though the remedy is the same command. A skip that does not say how to
 * un-skip itself trains people to ignore skips; one that misdescribes WHY is
 * worse, because it sends a user looking for a file that is right there.
 *
 * THIS IS NO LONGER THE PIPELINE'S SKIP DECISION. `check.ts` derives the data
 * instead of skipping (see `criticalityCache.ts`), so a gate reaches its own
 * internal skip only when the derivation could not run at all. What this
 * function is for is the callers that report on the state of a repo — and as
 * the honest answer to "may this file be believed", which is a question no
 * caller should have to spell as an `existsSync`.
 */
export function noCriticalityReason(root: string): string | undefined {
  switch (criticalityFreshness(root)) {
    case "fresh":
      return undefined;
    case "missing":
      return NO_CRITICALITY_REASON;
    case "stale":
      return STALE_CRITICALITY_REASON;
  }
}
