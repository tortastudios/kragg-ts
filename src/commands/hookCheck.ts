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
 * single assembly point — because a hook that enforced a different set of
 * rules than the command would teach the agent one contract and the human
 * another.
 *
 * Two differences from `runPipeline`, both required by the hook contract:
 *
 *  - **Nothing is written to stdout.** The hook owns its own output format;
 *    stray text on stdout is either swallowed or, worse, parsed as the hook's
 *    JSON payload.
 *  - **`null` on failure, never a throw.** Hooks fail OPEN (see `claude.ts`):
 *    a broken guardrail must not become a broken editing session, so an
 *    unusable config or a crashed gate degrades to "no opinion" rather than
 *    blocking the user's work.
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
import { buildReport, utcNow, type CheckReport } from "../engine/report.ts";
import { toPayload } from "../engine/reportPayload.ts";
import { resolveProjectEnvironment } from "../environment/project.ts";
import { gitDirty, gitSha } from "../git/changes.ts";
import type { HookCheckRequest } from "../hooks/claude.ts";
import { loadPolicy } from "../policy/policy.ts";

/**
 * Run the check pipeline for a hook invocation.
 *
 * Returns the report, or `null` when the run could not be made at all.
 */
export async function hookCheck(request: HookCheckRequest): Promise<CheckReport | null> {
  try {
    const { root, targets, incremental } = request;
    const policy = loadPolicy(root);
    const env = resolveProjectEnvironment(root);
    const startedAt = utcNow();

    const specs = buildCheckGates({
      root,
      policy,
      env,
      targets,
      // A PostToolUse run narrows to the edited file; a Stop run checks the
      // whole project. `paths: undefined` means "everything" and is NOT the
      // same as an empty array — see `CatalogOptions`.
      paths: incremental ? targets : undefined,
      incremental,
    });

    const results = await runGates(specs, { failFast: false, forceSlow: false });
    const report = buildReport({
      command: "check",
      mode: incremental ? "changed" : "full",
      targets,
      results,
      maxViolations: policy.maxViolationsPerGate,
      startedAt,
      gitSha: await gitSha(root),
    });

    try {
      appendRun(root, toPayload(report), { gitDirty: await gitDirty(root) });
    } catch {
      // Telemetry must never change the outcome of a check, and a read-only
      // checkout is a legitimate state. Degrade `kragg status`, nothing else.
    }
    return report;
  } catch {
    return null;
  }
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
    scanPaths: [...policy.sourcePaths, ...policy.testPaths],
    analysis: analysisProgram({ root }),
  }).ensure();
}
