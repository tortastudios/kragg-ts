/**
 * The shared pipeline runner, and the flags `check` and `security` share.
 *
 * Ported from `_run_pipeline` in `commands.py`. It lived inside `check.ts`
 * until package-level runs needed to drive it from a third place: `check` and
 * `security` differ only in which gates they assemble, and `--package` differs
 * from both only in how many times it assembles and where it renders. Giving
 * each its own runner is how the three start rendering, journaling and exiting
 * differently for no reason anyone intended, so there is one, here, in two
 * halves:
 *
 *  - {@link executePipeline} runs the gates, applies the legacy-debt baseline,
 *    builds the report and journals it — everything that is a fact about the
 *    run;
 *  - {@link runPipeline} prints that report and returns the exit code — the
 *    single-root rendering. A package run renders several reports itself.
 *
 * `check.ts` re-exports everything here, so its importers see one module.
 */

import { runGates, type GateSpec } from "../engine/gate.ts";
import { appendRun } from "../engine/journal.ts";
import type { GateResult } from "../engine/models.ts";
import {
  buildReport,
  renderJson,
  renderText,
  reportExitCode,
  utcNow,
  type CheckReport,
} from "../engine/report.ts";
import { toPayload } from "../engine/reportPayload.ts";
import { gitDirty, gitSha } from "../git/changes.ts";
import {
  applyBaseline,
  readBaseline,
  recordBaseline,
  type AppliedBaseline,
} from "../policy/baseline.ts";
import type { KraggPolicy } from "../policy/policy.ts";

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
  /**
   * `--package`, repeatable: workspace members to check INSTEAD of the root,
   * each as its own run. Empty means the root project. See `packages.ts`.
   */
  readonly packages: readonly string[];
}

/** The legacy-debt baseline a run applies, and whether it re-records it first. */
export interface PipelineBaseline {
  /** Path relative to THIS run's root, from `kragg.json#baseline`. */
  readonly path: string;
  /** The run's file selection, or `undefined` for a full run. */
  readonly scope: readonly string[] | undefined;
  readonly update: boolean;
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
 * Run gates, apply the baseline, build the report, journal it.
 *
 * The baseline, when there is one, is applied between the gates and the
 * report, so the report, the journal and the exit code all describe the same
 * post-baseline results. Its accounting goes to STDERR in both formats:
 * stdout is the report (and under `--format json` must stay pure JSON), and
 * the accepted findings themselves are already in it as `baselined:`
 * advisories.
 *
 * Everything here is resolved against `flags.root`, which for a package run is
 * the MEMBER's directory: the member applies (and records) its own baseline
 * file at its own root, exactly as if `kragg` had been invoked inside it.
 *
 * The journal write is last and cannot change the outcome: telemetry must
 * never fail a check (see `journal.ts`), so a read-only checkout degrades
 * `kragg status` and nothing else. It is written under `flags.root`, which
 * for a package run is the MEMBER's `.kragg/`, where that member's own
 * `kragg status` reads it.
 */
export async function executePipeline(run: PipelineRun): Promise<CheckReport> {
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
  if (flags.journal) {
    appendRun(flags.root, toPayload(report), { gitDirty: await gitDirty(flags.root) });
  }
  return report;
}

/** Run gates, render, journal, and return the exit code. */
export async function runPipeline(run: PipelineRun): Promise<number> {
  const report = await executePipeline(run);
  const rendered = run.flags.format === "json" ? renderJson(report) : renderText(report);
  process.stdout.write(`${rendered}\n`);
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
