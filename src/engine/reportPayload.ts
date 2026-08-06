/**
 * THE CROSS-LANGUAGE WIRE FORMAT: the JSON kragg-ts emits, and nothing else.
 *
 * Split out of `report.ts`, which re-exports every name here. The payload
 * interfaces and the one function that fills them are the entire contract
 * with the Python implementation, and keeping them in a file of their own
 * means a reviewer can read the contract without reading the report
 * machinery around it.
 *
 * The JSON emitted by `toPayload` must be byte-compatible in *shape* with the
 * Python implementation's output at the same `schema_version`. Payload
 * interfaces therefore use snake_case keys on purpose — they describe the
 * wire format, not TypeScript style. Domain types stay camelCase; this module
 * is the only translation boundary.
 *
 * See docs/spec-conformance.md before changing anything here.
 */

import { type Violation } from "./models.ts";
import type { CheckReport, ProcessedGate } from "./report.ts";
import { reportDurationMs, reportExitCode, reportPassed } from "./report.ts";
import { kraggVersion } from "./reportMeta.ts";

export const SCHEMA_VERSION = 1;

export interface ViolationPayload {
  file: string | null;
  line: number | null;
  column: number | null;
  code: string | null;
  message: string;
  fix_hint: string | null;
}

export interface GatePayload {
  name: string;
  passed: boolean;
  skipped: boolean;
  skip_reason: string | null;
  error: boolean;
  duration_ms: number;
  violation_count: number;
  violations: ViolationPayload[];
  truncated: boolean;
  raw_output: string | null;
}

export interface SummaryPayload {
  gates_total: number;
  gates_passed: number;
  gates_failed: number;
  gates_skipped: number;
  violations_total: number;
  violations_shown: number;
}

export interface ReportPayload {
  schema_version: number;
  kragg_version: string;
  command: string;
  mode: string;
  targets: string[];
  git_sha: string | null;
  started_at: string;
  duration_ms: number;
  passed: boolean;
  exit_code: number;
  summary: SummaryPayload;
  gates: GatePayload[];
  next_actions: string[];
}

/** Serialize a report to the stable JSON schema. */
export function toPayload(report: CheckReport): ReportPayload {
  return {
    schema_version: SCHEMA_VERSION,
    kragg_version: kraggVersion(),
    command: report.command,
    mode: report.mode,
    targets: [...report.targets],
    git_sha: report.gitSha,
    started_at: report.startedAt,
    duration_ms: reportDurationMs(report),
    passed: reportPassed(report),
    exit_code: reportExitCode(report),
    summary: summaryPayload(report),
    gates: report.gates.map(gatePayload),
    next_actions: nextActions(report),
  };
}

function gatePayload(gate: ProcessedGate): GatePayload {
  const result = gate.result;
  return {
    name: result.name,
    passed: result.passed,
    skipped: result.skipped,
    skip_reason: result.skipReason,
    error: result.error,
    duration_ms: result.durationMs,
    violation_count: result.violationCount,
    violations: gate.shown.map(violationPayload),
    truncated: gate.truncated,
    raw_output: gate.rawOutput,
  };
}

function violationPayload(violation: Violation): ViolationPayload {
  // `?? null` everywhere: absent fields are explicit nulls on the wire, as
  // in Python. Never omit a key — consumers index it unconditionally.
  return {
    file: violation.file ?? null,
    line: violation.line ?? null,
    column: violation.column ?? null,
    code: violation.code ?? null,
    message: violation.message,
    fix_hint: violation.fixHint ?? null,
  };
}

/**
 * The counts block, shared with the text renderer — which prints the same
 * numbers and must not compute them a second, subtly different way.
 */
export function summaryPayload(report: CheckReport): SummaryPayload {
  const results = report.gates.map((g) => g.result);
  const skipped = results.filter((r) => r.skipped).length;
  const passed = results.filter((r) => r.passed && !r.skipped).length;
  return {
    gates_total: results.length,
    gates_passed: passed,
    gates_failed: results.length - passed - skipped,
    gates_skipped: skipped,
    violations_total: results.reduce((n, r) => n + r.violationCount, 0),
    violations_shown: report.gates.reduce((n, g) => n + g.shown.length, 0),
  };
}

/** Tell the agent what to do next, in priority order. */
export function nextActions(report: CheckReport): string[] {
  const actions = environmentFixes(report);
  const fixable = autoFixableCount(report);
  if (fixable > 0) {
    actions.push(`run \`kragg fix\` to auto-fix ${fixable} violations`);
  }
  if (!reportPassed(report) && actions.length === 0) {
    actions.push(
      "fix the violations at the file:line locations above, " +
        `then re-run \`kragg ${report.command}\``,
    );
  }
  return actions;
}

/** A broken environment is fixed by a command, not by editing source. */
function environmentFixes(report: CheckReport): string[] {
  const actions: string[] = [];
  for (const gate of report.gates) {
    if (!gate.result.error || gate.rawOutput === null) {
      continue;
    }
    for (const line of gate.rawOutput.split("\n")) {
      if (line.startsWith("Fix:")) {
        actions.push(`${gate.result.name}: ${line}`);
      }
    }
  }
  return actions;
}

function autoFixableCount(report: CheckReport): number {
  return report.gates.reduce(
    (n, gate) =>
      n +
      gate.shown.filter((v) => v.fixHint?.startsWith("auto-fixable") === true)
        .length,
    0,
  );
}
