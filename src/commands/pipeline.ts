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
 *  - {@link executePipeline} runs the gates, builds the report and journals
 *    it — everything that is a fact about the run;
 *  - {@link runPipeline} prints that report and returns the exit code — the
 *    single-root rendering. A package run renders several reports itself.
 *
 * `check.ts` re-exports everything here, so its importers see one module.
 */

import { runGates, type GateSpec } from "../engine/gate.ts";
import { appendRun } from "../engine/journal.ts";
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

/** Everything `runPipeline` needs that is not already in the flags. */
export interface PipelineRun {
  /** `"check"` or `"security"` — recorded in the report and the journal. */
  readonly command: string;
  readonly mode: string;
  readonly policy: KraggPolicy;
  readonly specs: readonly GateSpec[];
  readonly targets: readonly string[];
  readonly flags: ReportFlags;
}

/**
 * Run gates, build the report, journal it.
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
  const results = await runGates(run.specs, {
    failFast: flags.failFast,
    forceSlow: flags.all,
  });
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
