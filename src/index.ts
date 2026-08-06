/**
 * Public API surface of the `kragg` package.
 *
 * Everything re-exported here is a supported entry point that other tools may
 * import; everything else is internal and may change without a major bump.
 * Keep this list SMALL and deliberate — a future `public-surface` gate caps
 * the number of exported symbols, and this file is where that budget is spent.
 *
 * The CLI (`src/cli.ts`) is intentionally not re-exported: it is a binary,
 * not a library.
 */

export type {
  CompletedCommand,
  GateResult,
  ProjectContext,
  Violation,
} from "./engine/models.ts";
export {
  commandOutput,
  commandPassed,
  completedToGateResult,
  gateResult,
  violationLocation,
} from "./engine/models.ts";

export type { GateSpec, RunGatesOptions, Tier } from "./engine/gate.ts";
export { FAST, runGates, SLOW } from "./engine/gate.ts";

export type { BuildReportOptions, CheckReport, ProcessedGate } from "./engine/report.ts";
export {
  buildReport,
  capOutput,
  dedupeViolations,
  EXIT_ENVIRONMENT,
  EXIT_GATE_FAILURES,
  EXIT_OK,
  EXIT_USAGE,
  kraggVersion,
  renderJson,
  renderText,
  reportDurationMs,
  reportExitCode,
  reportPassed,
  utcNow,
} from "./engine/report.ts";

// The snake_case wire format shared with kragg-Python, taken from its own
// module rather than through `report.ts` — so that file's symbol budget
// measures its real reachable surface. See its header for why that matters.
export type {
  GatePayload,
  ReportPayload,
  SummaryPayload,
  ViolationPayload,
} from "./engine/reportPayload.ts";
export { nextActions, SCHEMA_VERSION, toPayload } from "./engine/reportPayload.ts";

export type { JournalEntry, JournalGate } from "./engine/journal.ts";
export { appendRun, journalPath, readRuns, renderStatusLines } from "./engine/journal.ts";

export type { RunCommandOptions } from "./engine/runner.ts";
export { runCommand } from "./engine/runner.ts";

export type { KraggPolicy } from "./policy/policy.ts";
export { DEFAULT_POLICY, loadPolicy } from "./policy/policy.ts";

export type { PackageManager, ProjectEnvironment } from "./environment/project.ts";
export { LOCKFILES } from "./environment/project.ts";
