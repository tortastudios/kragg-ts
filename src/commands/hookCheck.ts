/**
 * The implementations behind the Claude Code hook's two injected seams:
 * `RunCheck` and `EnsureCriticality`.
 *
 * `src/hooks/claude.ts` deliberately does NOT import the catalog: it declares
 * the narrow seams it needs and takes implementations as parameters, so the
 * hook is testable with fakes and cannot drift into assembling its own gate
 * list. This module is the one place that closes them.
 *
 * It runs the SAME pipeline as `kragg check` — via `buildCheckGates`, the
 * single assembly point — over the SAME scope, via `scope.ts`, the single
 * resolver, because a hook that enforced a different set of rules, or the same
 * rules over a different set of files, would teach the agent one contract and
 * the human another. That is not hypothetical: the Stop hook used to check
 * `source_paths[0]` while `kragg check` checked every source path, so a
 * project with `["src", "lib"]` could finish a turn green on a `lib` no gate
 * had been pointed at.
 *
 * Two differences from `runPipeline`, both required by the hook contract:
 *
 *  - **Nothing is written to stdout.** The hook owns its own output format;
 *    stray text on stdout is either swallowed or, worse, parsed as the hook's
 *    JSON payload.
 *  - **An outcome on failure, never a throw and never an exit code.** Hooks
 *    fail OPEN (see `claude.ts`): a broken guardrail must not become a broken
 *    editing session, so a pipeline that could not be assembled or run at all
 *    — an unusable config, a project that cannot be resolved — degrades to
 *    `failed`, which blocks nothing. What it is NOT any more is silent: the
 *    caller records it. `nothing` is kept for the genuinely empty outcomes, so
 *    the two cannot be confused again.
 *
 *    ONE GATE crashing is no longer one of those cases, and deliberately so.
 *    `runGates` now catches a gate's exception and reports that gate as
 *    `error: true` (see `engine/gate.ts`), so the run still produces a report
 *    and this function still returns it. That is the same treatment a gate
 *    which could not run already got — a missing `tsc` has always reached the
 *    hook as an errored gate — and it closes a real fail-open hole: one gate
 *    throwing used to discard every OTHER gate's findings and leave the hook
 *    with no opinion about violations it had already found.
 *
 * Journaling DOES happen here, because this is the check — `SessionStart`
 * reads `.kragg/history.jsonl` back, so the two halves of the hook meet
 * through that file.
 */

import { analysisProgram } from "../analysis/program.ts";
import { buildCheckGates } from "../catalog.ts";
import { criticalityCache } from "../catalog/criticalityCache.ts";
import { runGates } from "../engine/gate.ts";
import { appendRun } from "../engine/journal.ts";
import { buildReport, utcNow, EXIT_ENVIRONMENT, type CheckReport } from "../engine/report.ts";
import type { GateResult } from "../engine/models.ts";
import { toPayload } from "../engine/reportPayload.ts";
import { resolveProjectEnvironment } from "../environment/project.ts";
import { gitDirty, gitSha } from "../git/changes.ts";
import type { HookCheckOutcome, HookCheckRequest, HookScope } from "../hooks/claude.ts";
import { applyBaseline, readBaseline } from "../policy/baseline.ts";
import { loadPolicy } from "../policy/policy.ts";
import { testScanDirectories } from "../util/testPaths.ts";
import { resolveScope, type ScopeRequest } from "./scope.ts";

/**
 * Run the check pipeline for a hook invocation.
 *
 * Returns the report, the fact that there was nothing to check, or the
 * failure that stopped it — see `HookCheckOutcome` in `hooks/claude.ts`.
 */
export async function hookCheck(request: HookCheckRequest): Promise<HookCheckOutcome> {
  try {
    return await runHookCheck(request);
  } catch (error) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

async function runHookCheck(request: HookCheckRequest): Promise<HookCheckOutcome> {
  const { root } = request;
  const policy = loadPolicy(root);
  const resolved = await resolveScope(scopeRequest(root, request.scope), policy);
  if (!resolved.ok) {
    // The CLI's own two answers, mapped onto a contract with no exit codes.
    // Git being unable to answer (exit 3) is not a hook failure: outside a
    // repository there is no change set either way, and saying so once per
    // tool call would bury the failures that matter. Anything else — today,
    // a `--file` scope naming a path that is not there — is exit 2 for the
    // command, so it is a recorded failure here rather than a quiet pass.
    return resolved.exit === EXIT_ENVIRONMENT
      ? { kind: "nothing" }
      : { kind: "failed", message: resolved.message };
  }
  const { scope } = resolved;
  const incremental = scope.mode !== "full";
  if (incremental && scope.targets.length === 0) {
    // An empty selection is not a failed one — the same rule `check` states
    // in `emptySelection`. Nothing changed; there is nothing to say.
    return { kind: "nothing" };
  }

  const specs = buildCheckGates({
    root,
    policy,
    env: resolveProjectEnvironment(root),
    targets: scope.targets,
    // Straight from the resolver, so the path-aware gates narrow to exactly
    // what the equivalent command would narrow to. `paths: undefined` means
    // "everything" and is NOT the same as an empty array — see
    // `CatalogOptions`.
    paths: scope.paths,
    incremental,
  });
  const startedAt = utcNow();
  const raw = await runGates(specs, { failFast: false, forceSlow: false });
  const results = await withBaseline(root, policy, raw, incremental ? scope.targets : undefined);
  const report = buildReport({
    command: "check",
    // The two mode values the hook has always journalled, and the two the
    // Python hook writes. A `file` scope is an incremental run here, as it
    // is for `check --file`; only the label stays coarser, because the
    // journal is a cross-language file.
    mode: incremental ? "changed" : "full",
    targets: scope.targets,
    results,
    maxViolations: policy.maxViolationsPerGate,
    startedAt,
    gitSha: await gitSha(root),
  });
  await journalHookRun(root, report);
  return { kind: "report", report };
}

/** The SAME baseline `kragg check` applies, or the hook blocks the agent on
 * debt the command has accepted and the two teach different contracts. */
async function withBaseline(
  root: string,
  policy: ReturnType<typeof loadPolicy>,
  raw: readonly GateResult[],
  targets: readonly string[] | undefined,
): Promise<readonly GateResult[]> {
  if (policy.baseline === undefined) {
    return raw;
  }
  return applyBaseline(root, raw, readBaseline(root, policy.baseline), targets).results;
}

async function journalHookRun(root: string, report: CheckReport): Promise<void> {
  try {
    await appendRun(root, toPayload(report), { gitDirty: await gitDirty(root) });
  } catch {
    // Telemetry must never change the outcome of a check, and a read-only
    // checkout is a legitimate state. Degrade `kragg status`, nothing else.
  }
}

/** The hook's intent, in the flags `resolveScope` reads. */
function scopeRequest(root: string, scope: HookScope): ScopeRequest {
  if (scope.kind === "file") {
    return { root, targets: [scope.file], changed: false, since: null };
  }
  return { root, targets: [], changed: scope.kind === "changed", since: null };
}

/**
 * The `EnsureCriticality` implementation: bring `.kragg/criticality.json` up
 * to date so SessionStart can read a real inventory instead of an empty one.
 *
 * ONE DERIVATION PATH, NOT TWO. This is the same `criticalityCache` the check
 * pipeline and `kragg map` use, assembled from the same policy paths, so all
 * three agree by construction about what "critical" means and about when the
 * answer has gone stale.
 *
 * NOT WRAPPED IN A `try`. `loadPolicy` throws on an unusable `kragg.json`, and
 * the hook's fail-open contract already catches at the call site — swallowing
 * here as well would only hide the failure from the tests that assert it.
 */
export function hookCriticality(root: string): void {
  const policy = loadPolicy(root);
  criticalityCache({
    root,
    scanPaths: [...policy.sourcePaths, ...testScanDirectories(policy.testPaths)],
    analysis: analysisProgram({ root }),
  }).ensure();
}
