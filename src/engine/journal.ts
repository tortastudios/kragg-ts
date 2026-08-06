/**
 * Local run journal: `.kragg/history.jsonl`, one slim line per check run.
 *
 * Ported from `kragg/src/kragg/journal.py`. Append-only JSON Lines: each run
 * appends exactly one line and never rewrites earlier ones, so a crash
 * mid-write costs at most the current entry and the file stays readable by
 * `tail`, `jq` and a diff.
 *
 * TELEMETRY MUST NEVER FAIL A CHECK. Every write path swallows its error.
 * A read-only checkout, a full disk, or a `.kragg/` owned by another user
 * degrades `kragg status`; it does not turn a passing check into a failure.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ReportPayload } from "./reportPayload.ts";

export const JOURNAL_DIR = ".kragg";
export const JOURNAL_FILE = "history.jsonl";
export const MAX_LINES = 1000;
export const KEEP_LINES = 500;

/** Wire format — snake_case, shared with the Python implementation. */
export interface JournalGate {
  name: string;
  passed: boolean;
  skipped: boolean;
  duration_ms: number;
  violation_count: number;
}

export interface JournalEntry {
  schema_version: number;
  ts: string;
  command: string;
  mode: string;
  git_sha: string | null;
  git_dirty: boolean;
  passed: boolean;
  exit_code: number;
  duration_ms: number;
  gates: JournalGate[];
}

export function journalPath(root: string): string {
  return join(root, JOURNAL_DIR, JOURNAL_FILE);
}

export interface AppendRunOptions {
  /**
   * Whether the working tree had uncommitted changes. Passed in rather than
   * computed here: the Python version reads it from its `changes` module, and
   * this port has no git integration yet.
   * TODO(git): replace with a `changes.ts` port once `kragg check --changed`
   * lands, so callers cannot forget it and silently record `false`.
   */
  readonly gitDirty?: boolean;
}

/** Record one run; rotates the file when it grows past MAX_LINES. */
export function appendRun(
  root: string,
  payload: ReportPayload,
  options: AppendRunOptions = {},
): void {
  const entry: JournalEntry = {
    schema_version: payload.schema_version,
    ts: payload.started_at,
    command: payload.command,
    mode: payload.mode,
    git_sha: payload.git_sha,
    git_dirty: options.gitDirty ?? false,
    passed: payload.passed,
    exit_code: payload.exit_code,
    duration_ms: payload.duration_ms,
    gates: payload.gates.map((gate) => ({
      name: gate.name,
      passed: gate.passed,
      skipped: gate.skipped,
      duration_ms: gate.duration_ms,
      violation_count: gate.violation_count,
    })),
  };
  const path = journalPath(root);
  try {
    mkdirSync(join(root, JOURNAL_DIR), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
    rotate(path);
  } catch {
    // Deliberately swallowed. See the module docstring.
  }
}

/** Return the most recent runs, oldest first; tolerates malformed lines. */
export function readRuns(root: string, last: number): JournalEntry[] {
  let lines: string[];
  try {
    lines = readFileSync(journalPath(root), "utf8").split("\n");
  } catch {
    return [];
  }
  const runs: JournalEntry[] = [];
  for (const line of lines.slice(Math.max(0, lines.length - last))) {
    if (line === "") {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // A half-written final line from an interrupted run. Skip it; the rest
      // of the history is still perfectly good.
      continue;
    }
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      runs.push(entry as JournalEntry);
    }
  }
  return runs;
}

/** Summarize recorded runs for `kragg status` text output. */
export function renderStatusLines(runs: readonly JournalEntry[]): string[] {
  const last = runs.at(-1);
  if (last === undefined) {
    return ["no runs recorded yet — run `kragg check`"];
  }
  const lines = [summaryLine(last)];
  const failing = failingLine(last);
  if (failing !== null) {
    lines.push(failing);
  }
  lines.push(`pass streak: ${passStreak(runs)} of last ${runs.length} runs`);
  const slowest = slowestLine(last);
  if (slowest !== null) {
    lines.push(slowest);
  }
  return lines;
}

function summaryLine(last: JournalEntry): string {
  const verdict = last.passed ? "PASS" : "FAIL";
  const duration = ((last.duration_ms ?? 0) / 1000).toFixed(1);
  return (
    `last run: ${verdict} (${last.command}, ${last.mode} mode, ` +
    `${last.ts}, ${duration}s)`
  );
}

function failingLine(last: JournalEntry): string | null {
  const failing = gatesOf(last)
    .filter((gate) => !gate.passed && !gate.skipped)
    .map((gate) => `${gate.name} (${gate.violation_count} violations)`);
  return failing.length === 0 ? null : `failing gates: ${failing.join(", ")}`;
}

function slowestLine(last: JournalEntry): string | null {
  const timed = gatesOf(last).filter((gate) => (gate.duration_ms ?? 0) > 0);
  let slowest: JournalGate | undefined;
  for (const gate of timed) {
    if (slowest === undefined || gate.duration_ms > slowest.duration_ms) {
      slowest = gate;
    }
  }
  if (slowest === undefined) {
    return null;
  }
  return `slowest gate: ${slowest.name} (${(slowest.duration_ms / 1000).toFixed(1)}s)`;
}

function passStreak(runs: readonly JournalEntry[]): number {
  let streak = 0;
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    if (runs[i]?.passed !== true) {
      break;
    }
    streak += 1;
  }
  return streak;
}

function gatesOf(run: JournalEntry): JournalGate[] {
  return Array.isArray(run.gates) ? run.gates : [];
}

/**
 * Truncate to the most recent KEEP_LINES once the file exceeds MAX_LINES.
 *
 * Rewriting the whole file is the one non-append operation here; it happens
 * at most once every (MAX_LINES - KEEP_LINES) runs.
 */
function rotate(path: string): void {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
  if (lines.length > MAX_LINES) {
    writeFileSync(path, `${lines.slice(lines.length - KEEP_LINES).join("\n")}\n`, "utf8");
  }
}
