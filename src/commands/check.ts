/**
 * `kragg check` — the whole quality pipeline, and the shared pipeline runner.
 *
 * Ported from `cmd_check`, `_check_targets` and `_run_pipeline` in
 * `commands.py`. `runPipeline` lives here rather than in its own module
 * because `check` and `security` differ only in which gates they assemble;
 * giving each its own runner is how the two start rendering, journaling and
 * exiting differently for no reason anyone intended.
 *
 * TARGET RESOLUTION lives in `scope.ts` — one resolver for `check` and
 * `security` both, so the two cannot disagree about what a `--file` argument
 * means. What is left here is what to DO with each answer: an unresolvable
 * selection is an exit code, an empty one is a clean run, and anything else
 * assembles the pipeline. See that module for the three modes, for why a
 * changed configuration file promotes an incremental run to a full one, and
 * for why git failing to answer is exit 3 and not an empty file list.
 */

import { buildCheckGates } from "../catalog.ts";
import { runGates, type GateSpec } from "../engine/gate.ts";
import { appendRun } from "../engine/journal.ts";
import {
  buildReport,
  renderJson,
  renderText,
  reportExitCode,
  utcNow,
  EXIT_OK,
} from "../engine/report.ts";
import { toPayload } from "../engine/reportPayload.ts";
import { resolveProjectEnvironment } from "../environment/project.ts";
import { gitDirty, gitSha } from "../git/changes.ts";
import { loadPolicy, type KraggPolicy } from "../policy/policy.ts";
import { resolveScope } from "./scope.ts";

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
}

/** Run the full check pipeline and return the process exit code. */
export async function runCheck(flags: CheckFlags): Promise<number> {
  const policy = loadPolicy(flags.root);
  const resolved = await resolveScope(
    { root: flags.root, targets: flags.targets, changed: flags.changed, since: flags.since },
    policy,
  );
  if (!resolved.ok) {
    process.stderr.write(`kragg: ${resolved.message}\n`);
    return resolved.exit;
  }
  const { scope } = resolved;
  if (scope.note !== undefined) {
    // stderr, not stdout: `--format json` promises one parseable document on
    // stdout, and an explanation is not part of the wire format.
    process.stderr.write(`kragg: ${scope.note}\n`);
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
  return runPipeline({ command: "check", mode: scope.mode, policy, specs, flags, targets: scope.targets });
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
 *
 * AN EMPTY SELECTION IS NOT A FAILED ONE, and only `changed` reaches this:
 * the change set held no source file that still exists, AND nothing in it
 * invalidates the whole project — a changed config file or a deletion is
 * promoted to a full run by `scope.ts` before this is reached, and git failing
 * to answer is exit 3 before that. `file` cannot get here at all, because a
 * `--file` naming nothing is exit 2.
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
 * Run gates, render, journal, and return the exit code.
 *
 * The journal write is last and cannot change the outcome: telemetry must
 * never fail a check (see `journal.ts`), so a read-only checkout degrades
 * `kragg status` and nothing else.
 */
export async function runPipeline(run: PipelineRun): Promise<number> {
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
  const rendered = flags.format === "json" ? renderJson(report) : renderText(report);
  process.stdout.write(`${rendered}\n`);
  if (flags.journal) {
    appendRun(flags.root, toPayload(report), { gitDirty: await gitDirty(flags.root) });
  }
  return reportExitCode(report);
}
