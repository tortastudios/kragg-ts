/**
 * `kragg mutation` — targeted mutation testing via StrykerJS.
 *
 * Mutation testing is the rigorous form of kragg's founding claim: coverage
 * proves a line RAN, mutation proves a test would NOTICE if that line broke.
 *
 * NOT A GATE, AND NEVER WILL BE. This command lives outside `kragg check`, for
 * the same reason the Python sibling keeps it out: a mutation run re-executes
 * the suite once per mutant, which is minutes-to-hours of wall clock. An
 * inner-loop gate has to be fast and deterministic, and this is neither. It is
 * an on-demand and CI surface. Do not wire it into a gate pipeline.
 *
 * ── PORTING DECISION: MANUAL TARGETING vs. `--incremental` ─────────────────
 * The Python implementation mutates `changed ∩ critical` files, because
 * cosmic-ray has no notion of what it already knows. Stryker does: verified in
 * `packages/core/src/mutants/incremental-differ.ts`, `--incremental` stores the
 * previous report (`--incrementalFile`, default
 * `reports/stryker-incremental.json`) and reuses a mutant's result when the
 * code it points at is unchanged AND — for a killed mutant — its culprit test
 * is unchanged AND — for a survivor — no test was added. It re-maps every
 * location through google's diff-match-patch first, so an edit ABOVE a mutant
 * does not invalidate it.
 *
 * That is strictly better than a git-diff file intersection: it works at MUTANT
 * granularity rather than file granularity, and it models a dimension a git
 * diff cannot — a survivor goes stale when a TEST changes, not only when the
 * source does. So the change-set machinery is NOT ported as the default.
 *
 * WHAT IS KEPT, and why neither part is redundant:
 *
 *  1. CRITICALITY SCOPING (`--mutate <critical files>`). `--incremental` models
 *     CHANGE; criticality models RISK, and Stryker has nothing equivalent.
 *     Without a scope the first run mutates the whole tree — on a repo of any
 *     size that does not finish, and a surface that never finishes is a surface
 *     nobody runs. `mutation_include` / `mutation_exclude` and a `--path`
 *     override keep working exactly as the policy documents them.
 *  2. THE CHANGE INTERSECTION, demoted to an opt-in (`changedSince`). On a COLD
 *     CACHE — a fresh clone, the first CI run, a wiped `reports/` —
 *     `--incremental` has no prior report and narrows NOTHING. The git
 *     intersection is the only lever that still works there, so it stays
 *     available; it is simply no longer the default.
 *
 * KNOWN INTERACTION, stated rather than discovered later: Stryker OVERWRITES
 * the incremental file with the current run's report (`writeIncrementalReport`).
 * Narrowing `--mutate` therefore shrinks the cache, so alternating between a
 * narrow and a wide scope loses the wide scope's history. Prefer a stable
 * scope, or pass `--force` for a deliberately clean run.
 *
 * ── TYPE ANNOTATIONS: ALREADY HANDLED UPSTREAM ─────────────────────────────
 * The Python port carries an AST filter that drops mutants inside type
 * annotations: under PEP 563/695 an annotation is never evaluated, so mutating
 * `str | None` into `str & None` yields a mutant no test can kill. TypeScript's
 * version of that problem is worse in principle — annotations are ERASED at
 * runtime, so every mutant inside one is equivalent by construction.
 *
 * NO SUCH FILTER IS NEEDED HERE, and that was verified rather than assumed.
 * `packages/instrumenter/src/transformers/babel-transformer.ts` calls
 * `path.skip()` whenever `shouldSkip(path)` holds, and `shouldSkip` begins with
 * `isTypeNode(path)`. `isTypeNode`
 * (`packages/instrumenter/src/util/syntax-helpers.ts`) covers `TSTypeAnnotation`,
 * `TSTypeAliasDeclaration`, `TSInterfaceDeclaration`, `TSEnumDeclaration`,
 * `TSDeclareFunction`, `TSAsExpression`, `TSTypeParameterInstantiation`,
 * `TSTypeParameterDeclaration`, the whole Flow equivalent set, `declare`
 * variable statements and `declare module`. Because it calls `skip()` the
 * entire subtree is never traversed, so nothing in a type position is ever
 * collected as a mutant. Writing our own filter would be dead code that only
 * pretended to earn its keep.
 *
 * (One consequence worth knowing, since it is Stryker's trade and not ours:
 * `TSAsExpression` being on that list means `foo() as Bar` is skipped WHOLE, so
 * expressions written inside an `as` cast are not mutated at all. That
 * understates the mutant count; it never manufactures a false survivor.)
 *
 * ── WHY THE VERDICT IS COMPUTED FROM THE REPORT ────────────────────────────
 * Stryker's exit code is not usable as a verdict. `determineExitCode` in
 * `mutation-test-report-helper.ts` sets exit 1 ONLY when `thresholds.break` is
 * configured and the score falls under it; with the default (`break: null`) a
 * run full of survivors exits 0. So kragg reads the JSON report and decides for
 * itself — the same reasoning `adapters/testRunner.ts` gives for computing the
 * coverage percentage instead of delegating the threshold to the runner.
 */

import { resolve } from "node:path";

import { EXIT_ENVIRONMENT, EXIT_GATE_FAILURES, EXIT_OK } from "../engine/report.ts";
import { resolveProjectEnvironment } from "../environment/project.ts";
import type { ProjectEnvironment } from "../environment/project.ts";
import { loadPolicy } from "../policy/policy.ts";
import type { KraggPolicy } from "../policy/policy.ts";
import {
  BASELINE_RELATIVE,
  filterBaselined,
  loadBaseline,
  staleSignatures,
  writeBaseline,
} from "./mutation/baseline.ts";
import { renderSurvivors, renderTotals } from "./mutation/report.ts";
import type { MutationReport } from "./mutation/report.ts";
import { installMessage, resolveReportLocation, runStryker, strykerBin } from "./mutation/stryker.ts";
import type { StrykerRunOptions } from "./mutation/stryker.ts";
import { selectTargets } from "./mutation/targets.ts";
import type { TargetSource } from "./mutation/targets.ts";

export interface MutationOptions {
  readonly root: string;
  /** `--path` globs, replacing both `mutation_include` and criticality. */
  readonly paths?: readonly string[] | undefined;
  /**
   * Intersect the scope with the git change set. Omit to mutate the whole
   * scope (the default, since `--incremental` handles change); `null` compares
   * against HEAD; a string is the ref to merge-base from.
   */
  readonly changedSince?: string | null | undefined;
  /** Record the surviving mutants as the accepted baseline and stop. */
  readonly updateBaseline?: boolean | undefined;
  /** Pass `--incremental`. On by default; see the module docs. */
  readonly incremental?: boolean | undefined;
  /** Pass `--force`, re-testing every mutant despite the incremental file. */
  readonly force?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
  readonly log?: ((line: string) => void) | undefined;
  readonly logError?: ((line: string) => void) | undefined;
}

/**
 * Handler for `kragg mutation`. Returns the process exit code.
 *
 *  - {@link EXIT_OK} — no survivors remain once the baseline is applied, or
 *    nothing was in scope to mutate, or `--update-baseline` succeeded.
 *  - {@link EXIT_GATE_FAILURES} — survivors remain.
 *  - {@link EXIT_ENVIRONMENT} — Stryker is missing, could not run, or produced
 *    no readable report. NEVER reported as a pass: a mutation run that did not
 *    happen has proved nothing about the test suite.
 */
export async function mutationCommand(options: MutationOptions): Promise<number> {
  const log = options.log ?? defaultLog;
  const logError = options.logError ?? defaultLogError;
  const root = resolve(options.root);
  const policy = loadPolicy(root);
  const env = resolveProjectEnvironment(root);

  const scope = await resolveScope(root, policy, options, logError);
  if (scope === null) {
    return EXIT_ENVIRONMENT;
  }
  if (scope.targets.length === 0) {
    log(emptyScopeMessage(scope.source, scope.narrowedToChanges));
    return EXIT_OK;
  }

  const bin = strykerBin(env);
  if (bin === null) {
    logError(installMessage(env));
    return EXIT_ENVIRONMENT;
  }

  const location = resolveReportLocation(root);
  if (location.note !== null) {
    log(`note: ${location.note}`);
  }
  log(`mutating ${scope.targets.length} files (scope: ${scope.source})`);

  const outcome = await runStryker(strykerOptions(env, bin, location.path, scope, options));
  if (!outcome.ok) {
    logError(outcome.message);
    return EXIT_ENVIRONMENT;
  }
  return reportOutcome(root, outcome.report, options.updateBaseline ?? false, log);
}

/** The files to mutate, once policy, criticality and git have been applied. */
interface MutationScope {
  readonly targets: readonly string[];
  readonly source: TargetSource;
  readonly narrowedToChanges: boolean;
}

/**
 * Resolve what to mutate, reporting anything dropped on the way.
 *
 * `null` means the scope could not be resolved AT ALL and the caller must exit
 * {@link EXIT_ENVIRONMENT}. An EMPTY scope is not a failure: it comes back as a
 * scope with no targets, which the caller explains and exits 0 on.
 */
async function resolveScope(
  root: string,
  policy: KraggPolicy,
  options: MutationOptions,
  logError: (line: string) => void,
): Promise<MutationScope | null> {
  const selection = await selectTargets({
    root,
    policy,
    includeOverride: options.paths,
    changedSince: options.changedSince,
  });
  if (!selection.ok) {
    logError(selection.message);
    return null;
  }
  const { targets, dropped } = splitCommaSafe(selection.files);
  for (const path of dropped) {
    logError(
      `skipping ${path}: stryker's --mutate list is comma-separated and cannot carry it`,
    );
  }
  return {
    targets,
    source: selection.source,
    narrowedToChanges: selection.narrowedToChanges,
  };
}

/**
 * Fill in the run's defaults: `--incremental` on, `--force` off.
 *
 * The module doc argues both. `--incremental` is what makes a repeat run
 * affordable, and `--force` is the deliberate escape hatch from it.
 */
function strykerOptions(
  env: ProjectEnvironment,
  bin: string,
  reportPath: string,
  scope: MutationScope,
  options: MutationOptions,
): StrykerRunOptions {
  return {
    env,
    bin,
    targets: scope.targets,
    reportPath,
    incremental: options.incremental ?? true,
    force: options.force ?? false,
    timeoutMs: options.timeoutMs,
  };
}

/**
 * Apply the baseline and render — the analogue of Python's `_report_mutation`.
 *
 * `--update-baseline` records EVERY current survivor and exits 0 without
 * reporting any of them; that is the whole point of the flag. It also prints
 * the commit instruction, because a baseline that stays untracked silently
 * stops working for everyone but its author (see `mutation/baseline.ts`).
 */
export function reportOutcome(
  root: string,
  parsed: MutationReport,
  updateBaseline: boolean,
  log: (line: string) => void,
): number {
  if (updateBaseline) {
    const count = writeBaseline(root, parsed.survivors);
    log(`baselined ${count} undetected mutants in ${BASELINE_RELATIVE}`);
    log(
      "COMMIT THIS FILE. It records a reviewed decision that these mutants are " +
        "equivalent, and .gitignore must read `.kragg/*` followed by " +
        `\`!${BASELINE_RELATIVE}\` for git to keep it.`,
    );
    return EXIT_OK;
  }
  const baseline = loadBaseline(root);
  const survivors = filterBaselined(parsed.survivors, baseline);
  log(renderTotals(parsed.totals));
  if (baseline.size > 0) {
    const suppressed = parsed.survivors.length - survivors.length;
    log(`${suppressed} suppressed by the ${baseline.size}-entry accepted-mutant baseline`);
  }
  for (const line of renderSurvivors(survivors)) {
    log(line);
  }
  const stale = staleSignatures(parsed.survivors, baseline);
  if (stale.length > 0) {
    log(
      `${stale.length} baselined mutants no longer appear — re-run with ` +
        "--update-baseline to prune them (they may simply be out of this run's scope)",
    );
  }
  return survivors.length > 0 ? EXIT_GATE_FAILURES : EXIT_OK;
}

/**
 * Split the target list on whether a path survives `--mutate`'s
 * comma-separated encoding.
 *
 * A path containing a comma would be split into two nonexistent paths, and
 * Stryker would then mutate neither — quietly narrowing the scope. Dropping it
 * loudly is the honest failure: the run covers less than asked, and says so.
 */
export interface CommaSplit {
  /** Paths Stryker's `--mutate` list can carry. */
  readonly targets: readonly string[];
  /** Paths it cannot, which the caller reports as narrowed scope. */
  readonly dropped: readonly string[];
}

export function splitCommaSafe(files: readonly string[]): CommaSplit {
  const targets: string[] = [];
  const dropped: string[] = [];
  for (const file of files) {
    (file.includes(",") ? dropped : targets).push(file);
  }
  return { targets, dropped };
}

/** Why there was nothing to mutate — specific enough to act on. */
export function emptyScopeMessage(source: TargetSource, narrowed: boolean): string {
  if (narrowed) {
    return "no changed files in the mutation scope";
  }
  if (source === "criticality") {
    return (
      "no critical files to mutate — run `kragg criticality --write` to build " +
      ".kragg/criticality.json, or set `mutation_include` to scope mutation by hand"
    );
  }
  return `no files matched the ${source} scope`;
}

function defaultLog(line: string): void {
  console.log(line);
}

function defaultLogError(line: string): void {
  console.error(line);
}
