/**
 * `kragg audit` — the on-demand hygiene sweep.
 *
 * Port of `cmd_audit` in `crag/src/kragg/commands.py`, which runs criticality,
 * then vulture (dead code), then deptry (dependency hygiene). **knip covers
 * both of the latter for JavaScript**, so this command is criticality + knip
 * rather than a three-tool chain.
 *
 * Deliberately OUTSIDE `kragg check`, matching Python: dead-code and
 * dependency findings are a periodic cleanup surface, not an inner-loop gate.
 * Failing a commit because an export is temporarily unused would train people
 * to disable the tool.
 */

import { resolveProjectEnvironment } from "../environment/project.ts";
import { EXIT_ENVIRONMENT, EXIT_GATE_FAILURES, EXIT_OK } from "../engine/report.ts";
import { loadPolicy } from "../policy/policy.ts";
import { runDeadCode, type DeadCodeFindings } from "../adapters/deadcode.ts";
import { runCriticality } from "./criticality.ts";

export interface AuditCommandOptions {
  readonly root: string;
  readonly log?: ((line: string) => void) | undefined;
  readonly logError?: ((line: string) => void) | undefined;
}

/**
 * Refresh the criticality graph, then report dead code and dependency drift.
 *
 * Exit codes follow the house contract: `1` when knip found something, `3`
 * when it could not run. A missing knip is an environment problem with a
 * copy-pasteable fix, never a silent pass — the same rule every adapter obeys.
 */
export async function runAudit(options: AuditCommandOptions): Promise<number> {
  const log = options.log ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const logError =
    options.logError ?? ((line: string): void => void process.stderr.write(`${line}\n`));

  const criticality = runCriticality({ root: options.root, write: true, log, logError });
  if (criticality !== EXIT_OK) {
    return criticality;
  }

  const policy = loadPolicy(options.root);
  const env = resolveProjectEnvironment(options.root);
  const outcome = await runDeadCode({ env, maxViolations: policy.maxViolationsPerGate });

  if (!outcome.ok) {
    logError(outcome.message);
    // `not-configured` is a visible skip, not a broken environment: a project
    // with no knip has simply not opted into this check. Everything else —
    // knip missing, crashed, or offline — is exit 3, because a sweep that
    // could not run must never be mistaken for a clean one.
    return outcome.kind === "not-configured" ? EXIT_OK : EXIT_ENVIRONMENT;
  }

  for (const line of renderFindings(outcome)) {
    log(line);
  }
  return outcome.passed ? EXIT_OK : EXIT_GATE_FAILURES;
}

/**
 * Render knip's findings as `file: message [code]` lines plus a summary.
 *
 * Separated from `runAudit` so the formatting is testable without a knip
 * install, and so neither half carries the other's branching.
 */
function renderFindings(outcome: DeadCodeFindings): string[] {
  const lines = outcome.violations.map((violation) => {
    const where = violation.file === undefined ? "" : `${violation.file}: `;
    const code = violation.code === undefined ? "" : ` [${violation.code}]`;
    return `${where}${violation.message}${code}`;
  });
  if (outcome.output !== "") {
    lines.push(outcome.output);
  }
  const hidden = outcome.violationCount - outcome.violations.length;
  if (hidden > 0) {
    lines.push(`... and ${hidden} more`);
  }
  lines.push(outcome.passed ? "Audit complete" : `Audit found ${outcome.violationCount} issues`);
  return lines;
}
