/**
 * `kragg check` — the whole quality pipeline, and the shared pipeline runner.
 *
 * Ported from `cmd_check`, `_check_targets` and `_run_pipeline` in
 * `commands.py`. `runPipeline` lives here rather than in its own module
 * because `check` and `security` differ only in which gates they assemble;
 * giving each its own runner is how the two start rendering, journaling and
 * exiting differently for no reason anyone intended.
 *
 * TARGET RESOLUTION has three modes, and the distinction between two of them
 * is not cosmetic:
 *
 *  - `full`    — no scoping. Gates walk `source_paths`.
 *  - `changed` — `--changed`/`--since`. Git decides the file set.
 *  - `file`    — explicit `--file`. The caller decides.
 *
 * `changed` mode outside a git repository returns NULL, never an empty list.
 * Collapsing those would make `--changed` silently check nothing and report a
 * confident pass, which is the exact shape of failure kragg exists to catch.
 * `changes.ts` preserves the distinction; this is where it is acted on.
 */

import { buildCheckGates } from "../catalog.ts";
import { runGates, type GateSpec } from "../engine/gate.ts";
import { appendRun } from "../engine/journal.ts";
import type { GateResult } from "../engine/models.ts";
import {
  buildReport,
  renderJson,
  renderText,
  reportExitCode,
  utcNow,
  EXIT_ENVIRONMENT,
  EXIT_OK,
  EXIT_USAGE,
} from "../engine/report.ts";
import { toPayload } from "../engine/reportPayload.ts";
import { resolveProjectEnvironment } from "../environment/project.ts";
import { changedFiles, gitDirty, gitSha } from "../git/changes.ts";
import {
  applyBaseline,
  readBaseline,
  recordBaseline,
  type AppliedBaseline,
} from "../policy/baseline.ts";
import { loadPolicy, type KraggPolicy } from "../policy/policy.ts";

/** How a run should be reported, shared by `check` and `security`. */
export interface ReportFlags {
  readonly root: string;
  /** `--file`, repeatable. Empty means "the whole project". */
  readonly targets: readonly string[];
  readonly format: "text" | "json";
  /** `--max-violations`; falls back to `max_violations_per_gate`. */
  readonly maxViolations: number | undefined;
  /** False for `--no-journal`. */
  readonly journal: boolean;
  readonly failFast: boolean;
  /** `--all`: run the SLOW gates even after a fast gate failed. */
  readonly all: boolean;
}

/** Everything `check` accepts on top of the shared reporting flags. */
export interface CheckFlags extends ReportFlags {
  readonly changed: boolean;
  readonly since: string | null;
  /** `--update-baseline`: record this run's eligible findings as accepted debt. */
  readonly updateBaseline?: boolean | undefined;
}

/** Run the full check pipeline and return the process exit code. */
export async function runCheck(flags: CheckFlags): Promise<number> {
  const policy = loadPolicy(flags.root);
  const update = flags.updateBaseline === true;
  const refusal = update ? updateRefusal(flags, policy) : null;
  if (refusal !== null) {
    process.stderr.write(`kragg: ${refusal}\n`);
    return EXIT_USAGE;
  }
  const scope = await resolveScope(flags, policy);
  if (scope === null) {
    process.stderr.write("not a git repository (required for --changed/--since)\n");
    return EXIT_ENVIRONMENT;
  }
  if (scope.mode !== "full" && scope.targets.length === 0) {
    return await emptySelection(flags, policy, scope.mode);
  }
  const specs = buildCheckGates({
    root: flags.root,
    policy,
    env: resolveProjectEnvironment(flags.root),
    targets: scope.targets,
    paths: scope.paths,
    incremental: scope.mode !== "full",
    since: flags.since,
  });
  // The baseline is a `check` concern only: every gate `security` runs is one
  // that can never be baselined, so there is nothing for it to apply.
  const baseline =
    policy.baseline === undefined ? null : { path: policy.baseline, scope: scope.paths, update };
  return runPipeline({
    command: "check",
    mode: scope.mode,
    policy,
    specs,
    flags,
    targets: scope.targets,
    baseline,
  });
}

/**
 * Why `--update-baseline` cannot proceed, or `null`.
 *
 * A baseline records a FULL run: an incremental one has not re-derived the
 * findings outside its selection, and replacing the file from it would drop
 * every accepted entry the run did not happen to see. And with no
 * `kragg.json#baseline` there is nowhere to write that a later run would
 * read — writing a file nothing consults would be a silent no-op with a
 * success code, the class of bug the CLI refuses everywhere else.
 */
function updateRefusal(flags: CheckFlags, policy: KraggPolicy): string | null {
  if (flags.changed || flags.since !== null || flags.targets.length > 0) {
    return "--update-baseline records a full run; it cannot be combined with --file, --changed or --since";
  }
  if (policy.baseline === undefined) {
    return (
      'kragg.json#baseline names no file; set it (for example ".kragg/baseline.json") ' +
      "before recording accepted legacy debt with --update-baseline"
    );
  }
  return null;
}

/**
 * Report a run that had nothing in scope — a clean run, not a vacuous pass
 * over the project.
 *
 * The text form says so in words, so nobody reads it as "the whole repo is
 * green". `--format json` USED TO PRINT THAT SAME SENTENCE, which is not
 * JSON: every caller that asked for a machine format got a parse error on the
 * one path where the answer is "nothing to do", and the exit code (0) told
 * them the run had succeeded. So the JSON form is the ordinary report payload
 * with an empty gate list — same schema, same keys, `mode: "changed"`,
 * `targets: []`, every summary count 0 — which is exactly what happened.
 *
 * NOT JOURNALED, in either format. A run that assembled no gates is not a run
 * `kragg status` should show a verdict for, and making that depend on
 * `--format` would give the two formats different side effects.
 */
async function emptySelection(
  flags: CheckFlags,
  policy: KraggPolicy,
  mode: string,
): Promise<number> {
  if (flags.format !== "json") {
    process.stdout.write("no changed TypeScript files\n");
    return EXIT_OK;
  }
  const report = buildReport({
    command: "check",
    mode,
    targets: [],
    results: [],
    maxViolations: flags.maxViolations ?? policy.maxViolationsPerGate,
    startedAt: utcNow(),
    gitSha: await gitSha(flags.root),
  });
  process.stdout.write(`${renderJson(report)}\n`);
  return reportExitCode(report);
}

/** What one invocation is scoped to. */
interface Scope {
  /** Passed to the per-file external tools (the linter, the scanner). */
  readonly targets: readonly string[];
  /** Narrowing for path-aware gates; `undefined` for a whole-project run. */
  readonly paths: readonly string[] | undefined;
  readonly mode: "full" | "changed" | "file";
}

/** The legacy-debt baseline a run applies, and whether it re-records it first. */
export interface PipelineBaseline {
  /** Root-relative path, from `kragg.json#baseline`. */
  readonly path: string;
  /** The run's file selection, or `undefined` for a full run. */
  readonly scope: readonly string[] | undefined;
  readonly update: boolean;
}

/** Resolve the scope, or `null` when git was needed and could not answer. */
async function resolveScope(
  flags: CheckFlags,
  policy: KraggPolicy,
): Promise<Scope | null> {
  if (flags.changed || flags.since !== null) {
    const allowed = [...policy.sourcePaths, ...policy.testPaths];
    const files = await changedFiles(flags.root, flags.since, allowed);
    if (files === null) {
      return null;
    }
    return { targets: files, paths: files, mode: "changed" };
  }
  if (flags.targets.length > 0) {
    return { targets: flags.targets, paths: flags.targets, mode: "file" };
  }
  // DIVERGES from Python, which passes only `source_paths[0]` to its external
  // tools and therefore lints exactly one directory in a project that declares
  // several. Passing all of them checks what the project said it has.
  return { targets: policy.sourcePaths, paths: undefined, mode: "full" };
}

/** Everything `runPipeline` needs that is not already in the flags. */
export interface PipelineRun {
  /** `"check"` or `"security"` — recorded in the report and the journal. */
  readonly command: string;
  readonly mode: string;
  readonly policy: KraggPolicy;
  readonly specs: readonly GateSpec[];
  readonly targets: readonly string[];
  readonly flags: ReportFlags;
  /** `null` (or absent) when the policy names no baseline, and for `security`. */
  readonly baseline?: PipelineBaseline | null | undefined;
}

/**
 * Run gates, render, journal, and return the exit code.
 *
 * The baseline, when there is one, is applied between the gates and the
 * report, so the report, the journal and the exit code all describe the same
 * post-baseline results. Its accounting goes to STDERR in both formats:
 * stdout is the report (and under `--format json` must stay pure JSON), and
 * the accepted findings themselves are already in it as `baselined:`
 * advisories.
 *
 * The journal write is last and cannot change the outcome: telemetry must
 * never fail a check (see `journal.ts`), so a read-only checkout degrades
 * `kragg status` and nothing else.
 */
export async function runPipeline(run: PipelineRun): Promise<number> {
  const { flags } = run;
  const startedAt = utcNow();
  const raw = await runGates(run.specs, {
    failFast: flags.failFast,
    forceSlow: flags.all,
  });
  const baseline = run.baseline ?? null;
  const results = baseline === null ? raw : withBaseline(flags.root, raw, baseline).results;
  const report = buildReport({
    command: run.command,
    mode: run.mode,
    targets: run.targets,
    results,
    maxViolations: flags.maxViolations ?? run.policy.maxViolationsPerGate,
    startedAt,
    gitSha: await gitSha(flags.root),
  });
  const rendered = flags.format === "json" ? renderJson(report) : renderText(report);
  process.stdout.write(`${rendered}\n`);
  if (flags.journal) {
    appendRun(flags.root, toPayload(report), { gitDirty: await gitDirty(flags.root) });
  }
  return reportExitCode(report);
}

/**
 * Re-record the baseline if asked, then apply it, writing the accounting to
 * stderr.
 *
 * NOTHING IS WRITTEN OVER A BROKEN ENVIRONMENT. A gate that errored produced
 * no findings to accept, and a baseline recorded beside an exit 3 would be an
 * incomplete list presented as the reviewed one; the previous file stays and
 * the run says so. Refused gates are named with their counts, so a security
 * or compiler failure can never be mistaken for something the file absorbed.
 */
function withBaseline(
  root: string,
  results: readonly GateResult[],
  baseline: PipelineBaseline,
): AppliedBaseline {
  const lines: string[] = [];
  if (baseline.update && results.some((result) => result.error)) {
    lines.push(
      `baseline not written to ${baseline.path}: a gate could not run (exit 3); fix the environment first`,
    );
  } else if (baseline.update) {
    const recorded = recordBaseline(root, baseline.path, results);
    lines.push(
      `recorded ${recorded.written} findings as accepted legacy debt in ${baseline.path}; COMMIT THIS FILE`,
    );
    for (const [gate, count] of recorded.refused) {
      lines.push(`refused to baseline ${count} findings in ${gate}: they cannot be accepted as debt, fix them`);
    }
  }
  const applied = applyBaseline(root, results, readBaseline(root, baseline.path), baseline.scope);
  lines.push(
    `baseline ${baseline.path}: ${applied.accepted} findings accepted as legacy debt, ` +
      `${applied.stale.length} stale entries`,
  );
  process.stderr.write(lines.map((line) => `kragg: ${line}\n`).join(""));
  return applied;
}
