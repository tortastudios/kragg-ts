/**
 * Reading the report payload the way a consumer has to read it.
 *
 * The regression cases assert on FIELDS OF THE JSON, not on rendered text, so
 * something has to turn `stdout` into typed values. That something is here,
 * and it is deliberately strict: every field is read by name and rejected by
 * name when it is missing or of the wrong type. `schema_version`, `exit_code`,
 * `mode`, `targets` and the three-state gate verdict are a cross-language
 * contract (`docs/spec-conformance.md`), so a rename that slipped through
 * would fail these readers loudly rather than quietly returning `undefined`
 * and letting an assertion pass for the wrong reason.
 *
 * The views are camelCase because everything inside this repository is; the
 * KEYS read off the wire are the snake_case ones and are written out in full
 * below, which makes this module a small, executable restatement of the
 * payload's field names.
 */

import type { CliRun } from "./regressionHarness.ts";

/** One violation, as the payload spells it. */
export interface ViolationView {
  readonly file: string | null;
  readonly line: number | null;
  readonly code: string | null;
  readonly message: string;
  readonly fixHint: string | null;
}

/** One gate's outcome: the three states, its findings, and its raw output. */
export interface GateView {
  readonly name: string;
  readonly passed: boolean;
  readonly skipped: boolean;
  readonly skipReason: string | null;
  readonly error: boolean;
  readonly durationMs: number;
  readonly violationCount: number;
  readonly violations: readonly ViolationView[];
  /** Did the per-gate display cap drop entries? Never anything else. */
  readonly truncated: boolean;
  readonly rawOutput: string | null;
}

/** The summary counts. */
export interface SummaryView {
  readonly gatesTotal: number;
  readonly gatesPassed: number;
  readonly gatesFailed: number;
  readonly gatesSkipped: number;
}

/** The subset of the report payload the regression cases assert on. */
export interface ReportView {
  readonly schemaVersion: number;
  readonly command: string;
  readonly mode: string;
  readonly targets: readonly string[];
  readonly passed: boolean;
  readonly exitCode: number;
  readonly summary: SummaryView;
  readonly gates: readonly GateView[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, at: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new Error(`${at} must be an object, got ${JSON.stringify(value)}`);
  }
  return value;
}

function str(source: Readonly<Record<string, unknown>>, key: string, at: string): string {
  const value = source[key];
  if (typeof value !== "string") {
    throw new Error(`${at}.${key} must be a string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function nullableStr(
  source: Readonly<Record<string, unknown>>,
  key: string,
  at: string,
): string | null {
  const value = source[key];
  if (value === null || typeof value === "string") {
    return value;
  }
  throw new Error(`${at}.${key} must be a string or null, got ${JSON.stringify(value)}`);
}

function num(source: Readonly<Record<string, unknown>>, key: string, at: string): number {
  const value = source[key];
  if (typeof value !== "number") {
    throw new Error(`${at}.${key} must be a number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function nullableNum(
  source: Readonly<Record<string, unknown>>,
  key: string,
  at: string,
): number | null {
  const value = source[key];
  if (value === null || typeof value === "number") {
    return value;
  }
  throw new Error(`${at}.${key} must be a number or null, got ${JSON.stringify(value)}`);
}

function bool(source: Readonly<Record<string, unknown>>, key: string, at: string): boolean {
  const value = source[key];
  if (typeof value !== "boolean") {
    throw new Error(`${at}.${key} must be a boolean, got ${JSON.stringify(value)}`);
  }
  return value;
}

function list(source: Readonly<Record<string, unknown>>, key: string, at: string): readonly unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) {
    throw new Error(`${at}.${key} must be a list, got ${JSON.stringify(value)}`);
  }
  return value;
}

function violationOf(value: unknown, at: string): ViolationView {
  const raw = record(value, at);
  return {
    file: nullableStr(raw, "file", at),
    line: nullableNum(raw, "line", at),
    code: nullableStr(raw, "code", at),
    message: str(raw, "message", at),
    fixHint: nullableStr(raw, "fix_hint", at),
  };
}

function gateOf(value: unknown, at: string): GateView {
  const raw = record(value, at);
  const name = str(raw, "name", at);
  const where = `${at}(${name})`;
  return {
    name,
    passed: bool(raw, "passed", where),
    skipped: bool(raw, "skipped", where),
    skipReason: nullableStr(raw, "skip_reason", where),
    error: bool(raw, "error", where),
    durationMs: num(raw, "duration_ms", where),
    violationCount: num(raw, "violation_count", where),
    violations: list(raw, "violations", where).map((entry, index) =>
      violationOf(entry, `${where}.violations[${index}]`),
    ),
    truncated: bool(raw, "truncated", where),
    rawOutput: nullableStr(raw, "raw_output", where),
  };
}

/**
 * Parse the payload a `--format json` run printed.
 *
 * Anything on stdout that is not the document is a bug in its own right, so
 * the parse is of the WHOLE stream rather than of a substring found by
 * searching for a brace.
 */
export function reportOf(run: CliRun): ReportView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `\`kragg ${run.argv.join(" ")}\` did not print a JSON report (${reason}).\n` +
        `exit ${run.exit}\nstdout: ${run.stdout.slice(0, 800)}\nstderr: ${run.stderr.slice(0, 800)}`,
    );
  }
  const raw = record(parsed, "report");
  const summary = record(raw["summary"], "report.summary");
  return {
    schemaVersion: num(raw, "schema_version", "report"),
    command: str(raw, "command", "report"),
    mode: str(raw, "mode", "report"),
    targets: list(raw, "targets", "report").map((entry, index) => {
      if (typeof entry !== "string") {
        throw new Error(`report.targets[${index}] must be a string`);
      }
      return entry;
    }),
    passed: bool(raw, "passed", "report"),
    exitCode: num(raw, "exit_code", "report"),
    summary: {
      gatesTotal: num(summary, "gates_total", "report.summary"),
      gatesPassed: num(summary, "gates_passed", "report.summary"),
      gatesFailed: num(summary, "gates_failed", "report.summary"),
      gatesSkipped: num(summary, "gates_skipped", "report.summary"),
    },
    gates: list(raw, "gates", "report").map((entry, index) =>
      gateOf(entry, `report.gates[${index}]`),
    ),
  };
}

/** One gate by name. A gate the report does not list is itself a failure. */
export function gate(report: ReportView, name: string): GateView {
  const found = report.gates.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(
      `the report has no gate named ${name}; it listed ${report.gates
        .map((entry) => entry.name)
        .join(", ")}`,
    );
  }
  return found;
}

/** Every violation code a gate reported, in order. */
export function violationCodes(view: GateView): readonly string[] {
  return view.violations.map((violation) => violation.code ?? "");
}

/** Did this gate RUN — neither skipped nor unable to start? */
export function ran(view: GateView): boolean {
  return !view.skipped && !view.error;
}
