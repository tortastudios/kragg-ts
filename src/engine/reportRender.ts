/**
 * Turning a processed report into the two things a caller can read: JSON for
 * a machine, lines for a human or an agent.
 *
 * Split out of `report.ts`, which re-exports both renderers. Rendering is
 * kept away from the wire format on purpose: the JSON shape is a contract
 * with the Python implementation, while this text is free to change whenever
 * it reads better.
 */

import { violationLocation, type Violation } from "./models.ts";
import type { CheckReport, ProcessedGate } from "./report.ts";
import { nextActions, summaryPayload, toPayload } from "./reportPayload.ts";

export function renderJson(report: CheckReport): string {
  // indent=1 matches the Python renderer: readable in a terminal without
  // wasting context window on indentation.
  return JSON.stringify(toPayload(report), null, 1);
}

export function renderText(report: CheckReport): string {
  const lines: string[] = [];
  for (const gate of report.gates) {
    lines.push(...renderGateText(gate));
  }
  const summary = summaryPayload(report);
  lines.push(
    `${summary.gates_passed} passed, ${summary.gates_failed} failed, ` +
      `${summary.gates_skipped} skipped`,
  );
  for (const action of nextActions(report)) {
    lines.push(`next: ${action}`);
  }
  return lines.join("\n");
}

function renderGateText(gate: ProcessedGate): string[] {
  const result = gate.result;
  const seconds = (result.durationMs / 1000).toFixed(1);
  if (result.skipped) {
    return [`[SKIP] ${result.name} — ${result.skipReason ?? ""}`];
  }
  if (result.passed) {
    return [`[PASS] ${result.name} (${seconds}s)`];
  }
  const label = result.error ? "ERROR" : "FAIL";
  const count =
    result.violationCount > 0 ? ` — ${result.violationCount} violations` : "";
  const lines = [`[${label}] ${result.name} (${seconds}s)${count}`];
  for (const violation of gate.shown) {
    lines.push(`  ${renderViolationText(violation)}`);
  }
  if (gate.truncated) {
    const hidden = result.violationCount - gate.shown.length;
    lines.push(`  ... ${hidden} more not shown (use --max-violations)`);
  }
  if (gate.rawOutput !== null) {
    for (const line of gate.rawOutput.split("\n")) {
      lines.push(`  ${line}`);
    }
  }
  return lines;
}

function renderViolationText(violation: Violation): string {
  const parts: string[] = [];
  const location = violationLocation(violation);
  if (location !== "") {
    parts.push(location);
  }
  if (violation.code !== undefined) {
    parts.push(violation.code);
  }
  parts.push(violation.message);
  const text = parts.join(" ");
  return violation.fixHint !== undefined ? `${text} -> ${violation.fixHint}` : text;
}
