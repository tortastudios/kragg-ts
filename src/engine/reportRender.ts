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
  // Advisories are appended to the tally rather than folded into it: they are
  // not a fourth gate state, and a reader must not be able to mistake one for
  // a failure. Omitted entirely at zero so a clean run's last line is
  // unchanged.
  const advisories = report.gates.reduce((n, gate) => n + gate.advisoryCount, 0);
  const advisoryTally = advisories === 0 ? "" : `, ${advisories} advisories`;
  lines.push(
    `${summary.gates_passed} passed, ${summary.gates_failed} failed, ` +
      `${summary.gates_skipped} skipped${advisoryTally}`,
  );
  for (const action of nextActions(report)) {
    lines.push(`next: ${action}`);
  }
  return lines.join("\n");
}

function renderGateText(gate: ProcessedGate): string[] {
  const result = gate.result;
  const seconds = (result.durationMs / 1000).toFixed(1);
  // A skipped gate never ran, so it cannot have observed anything to advise
  // about. Returning early keeps that impossible rather than merely unlikely.
  if (result.skipped) {
    return [`[SKIP] ${result.name} — ${result.skipReason ?? ""}`];
  }
  const lines = result.passed
    ? [`[PASS] ${result.name} (${seconds}s)`]
    : renderFailedGateText(gate, seconds);
  lines.push(...renderAdvisoryText(gate));
  return lines;
}

function renderFailedGateText(gate: ProcessedGate, seconds: string): string[] {
  const result = gate.result;
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

/**
 * The advisory block, printed under a gate whatever its verdict.
 *
 * EVERY LINE IS PREFIXED `[advisory]`. A reader — human or agent — scans this
 * output for things to fix, and an unlabelled line under a `[PASS]` heading
 * would read as either a violation the tool forgot to count or as noise. The
 * prefix says, in the one place it matters, that this is information and the
 * gate is still green.
 */
function renderAdvisoryText(gate: ProcessedGate): string[] {
  const lines = gate.advisories.map(
    (advisory) => `  [advisory] ${renderViolationText(advisory)}`,
  );
  if (gate.advisoryCount > gate.advisories.length) {
    const hidden = gate.advisoryCount - gate.advisories.length;
    lines.push(`  [advisory] ... ${hidden} more not shown (use --max-violations)`);
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
