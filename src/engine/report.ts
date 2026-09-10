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
 * Caps on the raw output kept for a gate we could not parse.
 *
 * Internal: they tune `capOutput` below and nothing else reads them.
 *
 * There is no longer a cap on locations listed in a deduped message, because
 * a deduped message no longer lists any: dedupe collapses only findings that
 * share a LOCATION as well as a `(code, message)`, so the extra locations it
 * used to fold into prose are now violation objects of their own. See
 * `dedupeViolations`.
 */
const MAX_RAW_LINES = 40;
const MAX_RAW_CHARS = 4000;

/* --- Domain types ------------------------------------------------------- */

/** A gate result with display violations deduped and capped. */
export interface ProcessedGate {
  readonly result: GateResult;
  readonly shown: readonly Violation[];
  readonly truncated: boolean;
  readonly rawOutput: string | null;
  /**
   * Advisories to display: deduped and capped exactly like `shown`.
   *
   * They are processed on EVERY gate, passing or failing, which is the whole
   * point — `rawOutput` above is deliberately a failure-only fallback, and
   * routing advisories through it (as `typing-strictness` used to) meant a
   * green gate printed nothing about a real escape hatch in the config.
   */
  readonly advisories: readonly Violation[];
  /**
   * How many DISTINCT advisories the gate produced, after dedupe.
   *
   * Deliberately post-dedupe, unlike `result.violationCount`, so that
   * `advisoryCount > advisories.length` is exactly the truncation signal and
   * needs no companion boolean. Dedupe loses no LOCATION: it only collapses
   * advisories that already sit at the same one, and says how many with a
   * `(+N more)` tail.
   */
  readonly advisoryCount: number;
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
  // Advisories get the same dedupe and the same cap, and are NOT conditioned
  // on the verdict: a passing gate is the case they exist for.
  const advisories = dedupeViolations(result.advisories);
  return {
    result,
    shown,
    truncated: shown.length < deduped.length,
    rawOutput,
    advisories: advisories.slice(0, maxViolations),
    advisoryCount: advisories.length,
  };
}

/**
 * Collapse findings identical in `(code, message, location)` — and NOTHING
 * that differs in where it is.
 *
 * THE LOCATION IS PART OF THE KEY, AND THAT IS THE WHOLE POINT. This used to
 * group on `(code, message)` alone and fold every other location into the
 * survivor's prose — "maintainability index grade C (minimum: A) (+2 more at
 * src/scene.ts, src/simulation.ts)". One line reads well, but the JSON
 * payload then carried ONE violation object for three affected files, with no
 * structured field naming the other two: a consumer filtering `violations` by
 * `file` concluded that `src/simulation.ts` was clean, and a file-scoped agent
 * skipped work it had actually been assigned. Prose is not a data structure.
 *
 * So every distinct location is now a violation object of its own, subject to
 * the same per-gate cap as before (`truncated` still means, and only means,
 * that the cap dropped entries). Genuine duplicates — the identical finding
 * reported twice AT THE SAME location — still collapse, and say so with a
 * `(+N more)` tail; there is nowhere else for the reader to look, so nothing
 * is hidden by that.
 *
 * A gate whose findings really are one finding about many files should say so
 * in ONE violation, not by relying on the report to fold N of them.
 */
export function dedupeViolations(
  violations: readonly Violation[],
): readonly Violation[] {
  const groups = new Map<string, Violation[]>();
  for (const violation of violations) {
    // JSON.stringify of a tuple is collision-free here: no delimiter in
    // any field can be confused for the separator.
    const key = JSON.stringify([
      violation.code ?? null,
      violation.message,
      violationLocation(violation),
    ]);
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
    // No `at …` list: every member of this group is at `first`'s location.
    deduped.push({
      ...first,
      message: `${first.message} (+${group.length - 1} more)`,
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
