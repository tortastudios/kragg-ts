/**
 * `kragg check` — the whole quality pipeline.
 *
 * Ported from `cmd_check` and `_check_targets` in `commands.py`; the shared
 * `_run_pipeline` is `pipeline.ts`, re-exported here so `check` and `security`
 * cannot render, journal or exit differently for no reason anyone intended.
 *
 * TARGET RESOLUTION lives in `scope.ts` — one resolver for `check` and
 * `security` both, so the two cannot disagree about what a `--file` argument
 * means. What is left here is what to DO with each answer: an unresolvable
 * selection is an exit code, an empty one is a clean run, and anything else
 * assembles the pipeline. See that module for the three modes, for why a
 * changed configuration file promotes an incremental run to a full one, and
 * for why git failing to answer is exit 3 and not an empty file list.
 *
 * PACKAGE RUNS. `--package` hands the whole invocation to `packages.ts`,
 * which assembles this same pipeline once per selected workspace member —
 * each with the member's own root, policy, tsconfig, compiler and program —
 * through {@link assembleCheck}. A root run in a workspace says on stderr
 * which members it did NOT check; it never checks them by accident, and it
 * never omits them in silence.
 */

import { buildCheckGates } from "../catalog.ts";
import {
  buildReport,
  renderJson,
  reportExitCode,
  utcNow,
  EXIT_OK,
} from "../engine/report.ts";
import { resolveProjectEnvironment, type ProjectEnvironment } from "../environment/project.ts";
import { gitSha } from "../git/changes.ts";
import { loadPolicy, type KraggPolicy } from "../policy/policy.ts";
import { runPackages, uncheckedPackagesNotice } from "./packages.ts";
import { runPipeline, type PipelineRun, type ReportFlags } from "./pipeline.ts";
import { resolveScope, type Scope } from "./scope.ts";

export type { PipelineRun, ReportFlags } from "./pipeline.ts";
export { executePipeline, runPipeline } from "./pipeline.ts";

/** Everything `check` accepts on top of the shared reporting flags. */
export interface CheckFlags extends ReportFlags {
  readonly changed: boolean;
  readonly since: string | null;
}

/**
 * A resolved scope and the pipeline it calls for, or the exit it earned.
 *
 * `run` is a THUNK: assembling the gates creates the run context, which
 * resolves (and loads) the project's compiler and creates `.kragg/`. A
 * `--changed` run with nothing to check must do neither, so the caller looks
 * at `scope` first and builds only when there is something to run.
 */
export type Assembly =
  | { readonly ok: true; readonly scope: Scope; readonly run: () => PipelineRun }
  | { readonly ok: false; readonly exit: number; readonly message: string };

/** Run the full check pipeline and return the process exit code. */
export async function runCheck(flags: CheckFlags): Promise<number> {
  if (flags.packages.length > 0) {
    // `--changed`/`--since`/`--file` are rejected alongside `--package` by
    // the CLI, so a member run is always the member's full scope.
    return runPackages(flags, (memberFlags, policy, env) =>
      assembleCheck({ ...memberFlags, changed: false, since: null }, policy, env),
    );
  }
  const policy = loadPolicy(flags.root);
  const env = resolveProjectEnvironment(flags.root);
  const assembled = await assembleCheck(flags, policy, env);
  if (!assembled.ok) {
    process.stderr.write(`kragg: ${assembled.message}\n`);
    return assembled.exit;
  }
  const { scope } = assembled;
  // stderr, not stdout: `--format json` promises one parseable document on
  // stdout, and neither explanation is part of the wire format.
  if (scope.note !== undefined) {
    process.stderr.write(`kragg: ${scope.note}\n`);
  }
  const unchecked = uncheckedPackagesNotice(env, "check");
  if (unchecked !== undefined) {
    process.stderr.write(`kragg: ${unchecked}\n`);
  }
  if (scope.mode !== "full" && scope.targets.length === 0) {
    return await emptySelection(flags, policy, scope.mode);
  }
  return runPipeline(assembled.run());
}

/**
 * Resolve the scope and describe the pipeline for ONE root — the project, or
 * one workspace member.
 *
 * Everything that can be a usage error happens here, before any gate runs:
 * an unresolvable selection, a policy `tsconfig` that does not exist. For a
 * package run that is what lets `packages.ts` refuse the whole invocation
 * with exit 2 when any member's configuration is wrong, instead of running
 * the others and reporting the broken one as a finding.
 */
export async function assembleCheck(
  flags: CheckFlags,
  policy: KraggPolicy,
  env: ProjectEnvironment,
): Promise<Assembly> {
  const resolved = await resolveScope(
    { root: flags.root, targets: flags.targets, changed: flags.changed, since: flags.since },
    policy,
  );
  if (!resolved.ok) {
    return resolved;
  }
  const { scope } = resolved;
  return {
    ok: true,
    scope,
    run: (): PipelineRun => ({
      command: "check",
      mode: scope.mode,
      policy,
      specs: buildCheckGates({
        root: flags.root,
        policy,
        env,
        targets: scope.targets,
        paths: scope.paths,
        incremental: scope.mode !== "full",
        since: flags.since,
      }),
      targets: scope.targets,
      flags,
    }),
  };
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
