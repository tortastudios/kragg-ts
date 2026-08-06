/**
 * Consolidated check reports: dedupe, caps, exit codes — and the entry point
 * for the rest of the reporting surface.
 *
 * Ported from `kragg/src/kragg/report.py`.
 *
 * THIS MODULE IS THE CONTRACT'S FRONT DOOR, and the contract itself now lives
 * next door. What was one file is four, split along the lines a reviewer
 * actually reads:
 *
 *  - `reportPayload.ts` — the snake_case JSON wire format shared with the
 *    Python implementation, and the one function that fills it. **Imported
 *    from directly by its consumers, NOT re-exported through here.** It
 *    briefly was, via `export *`, which slipped this module under the
 *    `symbol-budget` only because our own `structure` gate does not enumerate
 *    star re-exports: measured surface 17, reachable surface 24. Passing a
 *    gate by standing in its blind spot is precisely what this project exists
 *    to stop, so the boundary is explicit instead. Code that needs
 *    `toPayload` is doing wire-format work and should say so in its imports.
 *  - `reportRender.ts`  — JSON and text rendering.
 *  - `reportMeta.ts`    — kragg's own version, and the timestamp format the
 *    journal shares with Python.
 *  - this file          — turning raw `GateResult`s into a `CheckReport`:
 *    deduping, capping, and deciding pass/fail and the exit code.
 *
 * The exit codes and the `schema_version` 1 shape are a contract with
 * kragg-Python and do not move. See docs/spec-conformance.md before changing
 * anything about the wire format.
 */

import { violationLocation, type GateResult, type Violation } from "./models.ts";

export { renderJson, renderText } from "./reportRender.ts";
export { kraggVersion, utcNow } from "./reportMeta.ts";

/** Everything passed. */
export const EXIT_OK = 0;
/** Gates ran and found violations. */
export const EXIT_GATE_FAILURES = 1;
/** The user invoked kragg wrongly (bad flags, unknown command). */
export const EXIT_USAGE = 2;
/** A gate could not run: missing tool, unreadable project, broken env. */
export const EXIT_ENVIRONMENT = 3;

/**
 * Caps on the raw output kept for a gate we could not parse, and on the
 * locations listed in a deduped message.
 *
 * Internal: they tune the two functions below and nothing else reads them.
 */
const MAX_RAW_LINES = 40;
const MAX_RAW_CHARS = 4000;
const MAX_DEDUPE_LOCATIONS = 5;

/* --- Domain types ------------------------------------------------------- */

/** A gate result with display violations deduped and capped. */
export interface ProcessedGate {
  readonly result: GateResult;
  readonly shown: readonly Violation[];
  readonly truncated: boolean;
  readonly rawOutput: string | null;
}

/** A full pipeline run, ready to render as text or JSON. */
export interface CheckReport {
  readonly command: string;
  readonly mode: string;
  readonly targets: readonly string[];
  readonly gates: readonly ProcessedGate[];
  readonly startedAt: string;
  readonly gitSha: string | null;
}

/** A skipped gate is not a failure: it never ran, so it cannot fail. */
export function reportPassed(report: CheckReport): boolean {
  return report.gates.every((g) => g.result.passed || g.result.skipped);
}

/**
 * A broken environment outranks gate failures: the findings are unreliable
 * until the environment is fixed, so tell the caller that first.
 */
export function reportExitCode(report: CheckReport): number {
  if (report.gates.some((g) => g.result.error)) {
    return EXIT_ENVIRONMENT;
  }
  if (!reportPassed(report)) {
    return EXIT_GATE_FAILURES;
  }
  return EXIT_OK;
}

export function reportDurationMs(report: CheckReport): number {
  return report.gates.reduce((total, g) => total + g.result.durationMs, 0);
}

export interface BuildReportOptions {
  readonly command: string;
  readonly mode: string;
  readonly targets: readonly string[];
  readonly results: readonly GateResult[];
  readonly maxViolations: number;
  readonly startedAt: string;
  readonly gitSha: string | null;
}

/** Process raw gate results into a renderable report. */
export function buildReport(options: BuildReportOptions): CheckReport {
  return {
    command: options.command,
    mode: options.mode,
    targets: [...options.targets],
    gates: options.results.map((r) => processGate(r, options.maxViolations)),
    startedAt: options.startedAt,
    gitSha: options.gitSha,
  };
}

function processGate(result: GateResult, maxViolations: number): ProcessedGate {
  const deduped = dedupeViolations(result.violations);
  const shown = deduped.slice(0, maxViolations);
  // Raw output is a fallback for gates we could not parse into violations.
  // Showing it alongside parsed violations would just be noise.
  const failed = !result.passed && !result.skipped;
  const rawOutput =
    failed && shown.length === 0 && result.output ? capOutput(result.output) : null;
  return {
    result,
    shown,
    truncated: shown.length < deduped.length,
    rawOutput,
  };
}

/**
 * Collapse identical (code, message) findings spanning many locations.
 *
 * "Missing return type (+37 more at a.ts:1, b.ts:9)" is one actionable line;
 * 38 near-identical lines is a wall the reader skims past.
 */
export function dedupeViolations(
  violations: readonly Violation[],
): readonly Violation[] {
  const groups = new Map<string, Violation[]>();
  for (const violation of violations) {
    // JSON.stringify of a tuple is collision-free here: no delimiter in
    // either field can be confused for the separator.
    const key = JSON.stringify([violation.code ?? null, violation.message]);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [violation]);
    } else {
      group.push(violation);
    }
  }

  const deduped: Violation[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (first === undefined) {
      continue;
    }
    if (group.length === 1) {
      deduped.push(first);
      continue;
    }
    const locations = group
      .slice(1)
      .map(violationLocation)
      .filter((location) => location !== "")
      .slice(0, MAX_DEDUPE_LOCATIONS);
    const where = locations.length > 0 ? ` at ${locations.join(", ")}` : "";
    deduped.push({
      ...first,
      message: `${first.message} (+${group.length - 1} more${where})`,
    });
  }
  return deduped;
}

/** Keep the TAIL of long raw output — tool summaries live at the end. */
export function capOutput(output: string): string {
  let lines = output.split("\n");
  const total = lines.length;
  if (total > MAX_RAW_LINES) {
    lines = [
      `... [truncated, ${total} lines total]`,
      ...lines.slice(total - MAX_RAW_LINES),
    ];
  }
  let capped = lines.join("\n");
  if (capped.length > MAX_RAW_CHARS) {
    capped = `... [truncated]\n${capped.slice(capped.length - MAX_RAW_CHARS)}`;
  }
  return capped;
}
