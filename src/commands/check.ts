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
import {
  buildReport,
  renderJson,
  renderText,
  reportExitCode,
  utcNow,
  EXIT_ENVIRONMENT,
  EXIT_OK,
} from "../engine/report.ts";
import { toPayload } from "../engine/reportPayload.ts";
import { resolveProjectEnvironment } from "../environment/project.ts";
import { changedFiles, gitDirty, gitSha } from "../git/changes.ts";
import { loadPolicy, type KraggPolicy } from "../policy/policy.ts";
import { testScanDirectories } from "../util/testPaths.ts";

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

/** Resolve the scope, or `null` when git was needed and could not answer. */
async function resolveScope(
  flags: CheckFlags,
  policy: KraggPolicy,
): Promise<Scope | null> {
  if (flags.changed || flags.since !== null) {
    const allowed = [...policy.sourcePaths, ...testScanDirectories(policy.testPaths)];
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
