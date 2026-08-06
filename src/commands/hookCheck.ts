/**
 * The `RunCheck` implementation injected into the Claude Code hook.
 *
 * `src/hooks/claude.ts` deliberately does NOT import the catalog: it declares
 * the narrow seam it needs and takes an implementation as a parameter, so the
 * hook is testable with a fake pipeline and cannot drift into assembling its
 * own gate list. This module is the one place that closes the seam.
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

import { buildCheckGates } from "../catalog.ts";
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
