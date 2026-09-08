/**
 * The reviewed legacy-debt baseline (TOR-1377) — the file `kragg.json#baseline`
 * names, conventionally `.kragg/baseline.json`.
 *
 * Adopting kragg on an existing project produces a wall of findings, and a
 * wall nobody can clear in one sitting is a wall everyone learns to scroll
 * past. The baseline is the controlled adoption path: every finding recorded
 * in it is ACCEPTED debt and is reported as an advisory of its gate instead of
 * failing the run; every finding NOT in it is new and fails exactly as it did
 * before. The debt never disappears from the report — `[advisory] baselined:`
 * lines and the `advisory_count` carry it — so a green run over a baseline
 * never reads as a clean one, and nothing on the wire moves: a baselined
 * finding rides in the existing `advisories` list, and the payload gains no
 * key.
 *
 * ── WHAT CAN NEVER BE BASELINED, ENFORCED HERE ─────────────────────────────
 * Only the gates in {@link BASELINE_GATES} — the metric, structure and
 * test-quality gates, whose findings are the legacy debt a team can
 * legitimately agree to carry — may be recorded, and only their findings are
 * ever consulted when a baseline is applied. Refused, by construction:
 *
 *  - `detect-secrets`, `secret-default`, `forbidden-calls`: security contracts;
 *  - `tsc`, `typing-strictness`: the compiler's verdict and its escape hatches;
 *  - `test-coverage`, `critical-tests`, `audit`: thresholds and evidence about
 *    THIS change, which a baseline must never loosen;
 *  - every `error: true` result and every skip: nothing was learned, so there
 *    is nothing to accept, and exit 3 stays exit 3.
 *
 * A baseline never loosens a threshold and never widens an exclusion: the
 * gates run exactly as configured, and the subtraction happens afterwards, one
 * recorded finding at a time. `critical-coverage` IS baselinable — an
 * uncovered critical function is legacy debt — but only its findings: the
 * missing-evidence outcomes (skips and errors) are not findings and never
 * reach this module.
 *
 * ── THE IDENTITY, AND WHAT IT SURVIVES ─────────────────────────────────────
 * An entry is `(gate, file, code, message, fingerprint)`, where `fingerprint`
 * is a hash of the TRIMMED TEXT OF THE FLAGGED LINE and there is deliberately
 * no line number. So an entry survives edits ABOVE it (the line shifts, its
 * text does not) and does NOT survive a change to the code it points at: the
 * flagged line changing, the message changing (a metric that grew), or the
 * file being renamed. In every one of those cases the entry goes STALE and
 * the finding comes back as NEW and fails the run — the honest direction. A
 * rename is therefore a re-review: the old entries are reported as stale,
 * never silently dropped and never silently re-matched to the new path.
 *
 * ONE ENTRY PER OCCURRENCE: the file is a multiset. Two identical findings in
 * one file — same message, same line text — take two entries, and a third
 * copy is reported.
 *
 * ── GIT-TRACKED, WRITTEN ONLY ON REQUEST ───────────────────────────────────
 * Only `kragg check --update-baseline` writes the file, and it REPLACES the
 * previous one, so a fixed finding shows up as a deletion in review. Like
 * `.kragg/mutants.baseline` it is a reviewed, shared property of the codebase
 * and must be committed; `.gitignore` must exclude `.kragg/*` and re-include
 * it by name (see `commands/mutation/baseline.ts` for why the directory form
 * silently loses it).
 *
 * ── FAIL CLOSED ────────────────────────────────────────────────────────────
 * A missing file is an EMPTY baseline: everything is reported. A file that
 * exists but is malformed is a `PolicyError` (exit 2, naming the entry) —
 * never "accept everything" and never silently empty, because a bad merge in
 * a reviewed exemption file is exactly the case the reviewer needs to see.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { GateResult, Violation } from "../engine/models.ts";
import { isTable, own, PolicyError, readTable } from "./readers.ts";

/** The on-disk format version; a different one is rejected by name. */
export const BASELINE_VERSION = 1;

/** The gates whose findings may be recorded. Everything else is refused. */
export const BASELINE_GATES: readonly string[] = [
  "lint",
  "complexity",
  "maintainability",
  "halstead",
  "type-complexity",
  "boundaries",
  "structure",
  "nullable-default",
  "test-quality",
  "critical-coverage",
];

/** One accepted finding. Keys are what the file holds, verbatim. */
export interface BaselineEntry {
  readonly gate: string;
  readonly file: string;
  readonly code: string | null;
  readonly message: string;
  readonly fingerprint: string;
}

/** A read baseline: the root-relative path the policy named, and its entries. */
export interface Baseline {
  readonly path: string;
  readonly entries: readonly BaselineEntry[];
}

/** Read the baseline at `relative`; EMPTY when absent, `PolicyError` when malformed. */
export function readBaseline(root: string, relative: string): Baseline {
  const table = readTable(join(root, relative));
  return { path: relative, entries: table === null ? [] : baselineEntries(table, `${relative}#`) };
}

/**
 * Narrow a parsed baseline document, rejecting anything off-shape by name.
 *
 * Shared with `kragg brief`, which parses the base revision of the file out of
 * git rather than off the disk. A gate outside {@link BASELINE_GATES} is
 * rejected HERE, not merely ignored at apply time: an entry that can never
 * be honoured is a hand edit that deserves an error, not a quiet no-op.
 */
export function baselineEntries(data: unknown, label: string): readonly BaselineEntry[] {
  if (!isTable(data)) {
    throw new PolicyError(`${label} must be a JSON object with version and entries`);
  }
  const version = own(data, "version");
  if (version !== BASELINE_VERSION) {
    throw new PolicyError(`${label}version must be ${BASELINE_VERSION} (got ${JSON.stringify(version)})`);
  }
  const entries = own(data, "entries");
  if (!Array.isArray(entries)) {
    throw new PolicyError(`${label}entries must be a list (got ${JSON.stringify(entries)})`);
  }
  for (const key of Object.keys(data)) {
    if (key !== "version" && key !== "entries") {
      throw new PolicyError(`${label}${key} is not a baseline key`);
    }
  }
  return entries.map((entry, index) => narrowEntry(entry, `${label}entries[${index}]`));
}

function narrowEntry(entry: unknown, label: string): BaselineEntry {
  if (!isTable(entry)) {
    throw new PolicyError(`${label} must be an object (got ${JSON.stringify(entry)})`);
  }
  for (const key of Object.keys(entry)) {
    if (!["gate", "file", "code", "message", "fingerprint"].includes(key)) {
      throw new PolicyError(`${label}.${key} is not a baseline entry key`);
    }
  }
  const gate = text(entry, "gate", label);
  if (!BASELINE_GATES.includes(gate)) {
    throw new PolicyError(
      `${label}.gate "${gate}" can never be baselined (accepted: ${BASELINE_GATES.join(", ")})`,
    );
  }
  const file = text(entry, "file", label);
  const message = text(entry, "message", label);
  const fingerprint = text(entry, "fingerprint", label);
  const code = own(entry, "code");
  if (code !== null && typeof code !== "string") {
    throw new PolicyError(`${label}.code must be a string or null (got ${JSON.stringify(code)})`);
  }
  return { gate, file, code, message, fingerprint };
}

function text(table: Readonly<Record<string, unknown>>, key: string, label: string): string {
  const value = own(table, key);
  if (typeof value !== "string") {
    throw new PolicyError(`${label}.${key} must be a string (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** The identity two entries, or an entry and a finding, are matched on. */
export function entryKey(entry: BaselineEntry): string {
  return JSON.stringify([entry.gate, entry.file, entry.code, entry.message, entry.fingerprint]);
}

/** The fingerprint of one line of source: a short SHA-256 of its trimmed text. */
export function lineFingerprint(line: string): string {
  return createHash("sha256").update(line.trim()).digest("hex").slice(0, 16);
}

/** Per-run cache of file contents, so N findings in one file cost one read. */
type LineCache = Map<string, readonly string[] | null>;

function linesOf(root: string, file: string, cache: LineCache): readonly string[] | null {
  const cached = cache.get(file);
  if (cached !== undefined) {
    return cached;
  }
  let lines: readonly string[] | null;
  try {
    lines = readFileSync(join(root, file), "utf8").split(/\r?\n/u);
  } catch {
    lines = null;
  }
  cache.set(file, lines);
  return lines;
}

/**
 * The entry a finding would be recorded as. The fingerprint is `""` when the
 * finding names no file or line, or the line cannot be read — the identity
 * then rests on the other four parts, which is weaker but never wrong.
 */
function entryOf(gate: string, violation: Violation, root: string, cache: LineCache): BaselineEntry {
  const file = violation.file ?? "";
  const line = violation.line === undefined || file === "" ? undefined : linesOf(root, file, cache)?.[violation.line - 1];
  return {
    gate,
    file,
    code: violation.code ?? null,
    message: violation.message,
    fingerprint: line === undefined ? "" : lineFingerprint(line),
  };
}

/** What `applyBaseline` did to a run's results. */
export interface AppliedBaseline {
  readonly results: readonly GateResult[];
  /** Findings moved out of `violations` into their gate's advisories. */
  readonly accepted: number;
  /** Entries in scope that no current finding matched. Reported, never dropped. */
  readonly stale: readonly BaselineEntry[];
}

/**
 * Subtract the accepted findings from a run's results.
 *
 * Only a gate in {@link BASELINE_GATES} that RAN AND FAILED is touched; a
 * skipped, errored or passing result is returned as is. A matched finding
 * becomes an advisory prefixed `baselined:` on the same gate — visible in text
 * and JSON alike, and counted in nothing that decides the exit code. `passed`
 * flips to true only when every finding was accepted AND the adapter hid none
 * behind its own cap: a finding nobody saw was never reviewed.
 *
 * `scope` is the file selection of an incremental run, or `undefined` for a
 * full one. Stale entries are judged only within it, and only for gates that
 * ran: an entry a narrowed run did not re-derive is unknown, not stale.
 */
export function applyBaseline(
  root: string,
  results: readonly GateResult[],
  baseline: Baseline,
  scope: readonly string[] | undefined,
): AppliedBaseline {
  const pool = new Map<string, number>();
  for (const entry of baseline.entries) {
    const key = entryKey(entry);
    pool.set(key, (pool.get(key) ?? 0) + 1);
  }
  const cache: LineCache = new Map();
  let accepted = 0;
  const applied = results.map((result) => {
    if (!eligible(result)) {
      return result;
    }
    const subtracted = subtract(root, result, pool, cache);
    accepted += result.violationCount - subtracted.violationCount;
    return subtracted;
  });
  const stale = staleEntries(baseline, pool, results, scope);
  return { results: applied.map((result) => withStale(result, stale)), accepted, stale };
}

function eligible(result: GateResult): boolean {
  return BASELINE_GATES.includes(result.name) && !result.skipped && !result.error && !result.passed;
}

/** One gate's result with every finding the pool covers moved to its advisories. */
function subtract(
  root: string,
  result: GateResult,
  pool: Map<string, number>,
  cache: LineCache,
): GateResult {
  const kept: Violation[] = [];
  const moved: Violation[] = [];
  for (const violation of result.violations) {
    const key = entryKey(entryOf(result.name, violation, root, cache));
    const left = pool.get(key) ?? 0;
    if (left > 0) {
      pool.set(key, left - 1);
      moved.push({ ...violation, message: `baselined: ${violation.message}` });
    } else {
      kept.push(violation);
    }
  }
  if (moved.length === 0) {
    return result;
  }
  const hidden = result.violationCount - result.violations.length;
  return {
    ...result,
    passed: kept.length === 0 && hidden === 0,
    violations: kept,
    violationCount: kept.length + hidden,
    advisories: [...result.advisories, ...moved],
  };
}

/**
 * The entries left unconsumed after matching, within scope and for gates that
 * ran. One pool count is consumed per report, so a duplicated entry is listed
 * exactly as many times as it is stale, never more.
 */
function staleEntries(
  baseline: Baseline,
  pool: Map<string, number>,
  results: readonly GateResult[],
  scope: readonly string[] | undefined,
): readonly BaselineEntry[] {
  const ran = new Set(results.filter((r) => !r.skipped && !r.error).map((r) => r.name));
  const inScope = new Set(scope?.map(normalize));
  return baseline.entries.filter((entry) => {
    if (!ran.has(entry.gate) || (scope !== undefined && !inScope.has(normalize(entry.file)))) {
      return false;
    }
    const key = entryKey(entry);
    const left = pool.get(key) ?? 0;
    pool.set(key, left - 1);
    return left > 0;
  });
}

function withStale(result: GateResult, stale: readonly BaselineEntry[]): GateResult {
  const mine = stale.filter((entry) => entry.gate === result.name);
  if (mine.length === 0) {
    return result;
  }
  return {
    ...result,
    advisories: [
      ...result.advisories,
      ...mine.map((entry) => ({
        message:
          `stale baseline entry: ${entry.message} (no current finding matches it; ` +
          "the code was fixed, changed or renamed — re-run `kragg check --update-baseline` to re-record)",
        file: entry.file,
        ...(entry.code === null ? {} : { code: entry.code }),
      })),
    ],
  };
}

function normalize(path: string): string {
  return path.replaceAll("\\", "/").replace(/^(\.\/)+/u, "");
}

/** What `recordBaseline` wrote, and what it refused. */
export interface BaselineRecording {
  readonly written: number;
  /** Failing gates outside {@link BASELINE_GATES}: name → finding count. */
  readonly refused: ReadonlyMap<string, number>;
}

/**
 * Record every finding of the baselinable gates that ran and failed as
 * accepted, REPLACING the previous baseline, and say what was refused.
 *
 * The caller decides whether to call this at all — `check` declines when any
 * gate errored, because a broken environment has produced no complete list to
 * accept. Sorted and `indent: 1` with a trailing newline, the byte format
 * `.kragg/mutants.baseline` uses.
 */
export function recordBaseline(
  root: string,
  relative: string,
  results: readonly GateResult[],
): BaselineRecording {
  const cache: LineCache = new Map();
  const entries: BaselineEntry[] = [];
  const refused = new Map<string, number>();
  for (const result of results) {
    if (result.passed || result.skipped || result.error) {
      continue;
    }
    if (!BASELINE_GATES.includes(result.name)) {
      refused.set(result.name, Math.max(result.violationCount, 1));
      continue;
    }
    for (const violation of result.violations) {
      entries.push(entryOf(result.name, violation, root, cache));
    }
  }
  entries.sort((left, right) => (entryKey(left) < entryKey(right) ? -1 : 1));
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: BASELINE_VERSION, entries }, null, 1)}\n`, "utf8");
  return { written: entries.length, refused };
}
