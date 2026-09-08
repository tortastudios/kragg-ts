/**
 * The cross-language contract, as code: schema validation and normalization.
 *
 * This is the TypeScript half of `spec/run_conformance.py` in the Python
 * sibling (`tortastudios/crag`, pinned at `f76a7d03`, release 0.9.0). Both
 * halves answer the same two questions about a payload:
 *
 *  1. **Does it satisfy the contract?** Every key SPEC.md section 2 lists is
 *     present — `null` where there is nothing to say, never absent, because
 *     consumers index unconditionally. The derivable fields really derive:
 *     the summary counts come out of `gates[]`, `duration_ms` is the sum of
 *     the gate durations, and `exit_code` follows the 3-outranks-1 rule.
 *  2. **What may legitimately differ between two conforming runs?** Exactly
 *     the fields in {@link normalizeReport} and nowhere else. Every other
 *     byte — gate order, violation order, skip-reason wording, messages,
 *     counts — is compared exactly. An over-normalized diff hides real
 *     breaks; an under-normalized one cries wolf and gets switched off.
 *
 * ── ONE DELIBERATE DIFFERENCE FROM THE PYTHON RUNNER ───────────────────────
 * `run_conformance.py` reports an unexpected key on a gate as a *note*: it
 * cannot prove the sibling never reads it, so it leaves the judgement to a
 * human. This module is stricter, because it runs inside kragg-ts's own suite
 * where the judgement has already been made: `advisories` and
 * `advisory_count` are the two additive keys whose "additive and provably
 * unread" proof is written down (docs/spec-conformance.md section 2), and a
 * third one fails here. That is the point — a new wire key must not be able
 * to reach `main` without someone redoing that proof.
 */

/** What a contract key is allowed to hold. Mirrors the Python key tables. */
type Tag = "int" | "number" | "string" | "bool" | "list" | "object" | "string?" | "int?";

/** A JSON object after `JSON.parse`, before anything has been checked. */
export type JsonObject = Readonly<Record<string, unknown>>;

/** SPEC.md section 2.1 — `ReportPayload`. */
const REPORT_KEYS = {
  schema_version: "int",
  kragg_version: "string",
  command: "string",
  mode: "string",
  targets: "list",
  git_sha: "string?",
  started_at: "string",
  duration_ms: "int",
  passed: "bool",
  exit_code: "int",
  summary: "object",
  gates: "list",
  next_actions: "list",
} as const satisfies Record<string, Tag>;

/** SPEC.md section 2.2 — `SummaryPayload`. */
const SUMMARY_KEYS = {
  gates_total: "int",
  gates_passed: "int",
  gates_failed: "int",
  gates_skipped: "int",
  violations_total: "int",
  violations_shown: "int",
} as const satisfies Record<string, Tag>;

/** SPEC.md section 2.3 — `GatePayload`, without the two TS-only keys. */
const GATE_KEYS = {
  name: "string",
  passed: "bool",
  skipped: "bool",
  skip_reason: "string?",
  error: "bool",
  duration_ms: "int",
  violation_count: "int",
  violations: "list",
  truncated: "bool",
  raw_output: "string?",
} as const satisfies Record<string, Tag>;

/**
 * The additive keys kragg-ts is allowed to put on a gate, and nothing else.
 *
 * SPEC.md section 2.6 legalises them because Python's `journal.py` — the only
 * place either sibling *reads* a gate object — indexes five named keys and
 * ignores the rest. Any further additive key has to repeat that proof before
 * this list grows.
 */
const GATE_ADDITIVE_KEYS: readonly string[] = ["advisories", "advisory_count"];

/** SPEC.md section 2.4 — `ViolationPayload`, shared by advisories. */
const VIOLATION_KEYS = {
  file: "string?",
  line: "int?",
  column: "int?",
  code: "string?",
  message: "string",
  fix_hint: "string?",
} as const satisfies Record<string, Tag>;

/** SPEC.md section 5 — one `.kragg/history.jsonl` line. */
const JOURNAL_KEYS = {
  schema_version: "int",
  ts: "string",
  command: "string",
  mode: "string",
  git_sha: "string?",
  git_dirty: "bool",
  passed: "bool",
  exit_code: "int",
  duration_ms: "int",
  gates: "list",
} as const satisfies Record<string, Tag>;

/**
 * SPEC.md section 5 — the FIVE keys that are the whole read surface of a gate.
 *
 * Python's `read_runs` / `render_status_lines` index exactly these. They are
 * the reason additive keys elsewhere on a gate are safe, so a fixture that
 * writes a journal is what keeps that claim executable rather than asserted.
 */
const JOURNAL_GATE_KEYS = {
  name: "string",
  passed: "bool",
  skipped: "bool",
  duration_ms: "int",
  violation_count: "int",
} as const satisfies Record<string, Tag>;

/** SPEC.md section 6 — one record in `.kragg/criticality.json`. */
const CRITICALITY_KEYS = {
  name: "string",
  fan_in: "int",
  fan_out: "int",
  betweenness: "number",
  is_critical: "bool",
  risk: "string",
} as const satisfies Record<string, Tag>;

/**
 * `.kragg/criticality.stamp.json` — the TypeScript-only freshness sidecar.
 *
 * Not a shared surface: Python never opens this file, which is exactly why
 * the fingerprint lives here instead of inside `criticality.json` (whose top
 * level is a LIST that Python's `read_json` hands back record by record). The
 * contract this pins is therefore one-sided — the sidecar must exist beside
 * the shared file and must not be mistaken for part of it.
 */
const STAMP_KEYS = {
  version: "int",
  scan_paths: "list",
  files: "int",
  bytes: "int",
  source_digest: "string",
  inputs_digest: "string",
} as const satisfies Record<string, Tag>;

/** A stamp digest is a SHA-256 hex string; its VALUE is normalized, its shape is not. */
const SHA256_HEX = /^[0-9a-f]{64}$/u;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matches(tag: Tag, value: unknown): boolean {
  switch (tag) {
    case "int":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "string":
      return typeof value === "string";
    case "bool":
      return typeof value === "boolean";
    case "list":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    case "string?":
      return value === null || typeof value === "string";
    case "int?":
      return value === null || (typeof value === "number" && Number.isInteger(value));
  }
}

/** Check one object against a key table; append every break to `errors`. */
function checkKeys(
  value: unknown,
  schema: Readonly<Record<string, Tag>>,
  where: string,
  errors: string[],
  additive: readonly string[] = [],
): value is JsonObject {
  if (!isObject(value)) {
    errors.push(`${where}: must be a JSON object`);
    return false;
  }
  for (const [key, tag] of Object.entries(schema)) {
    if (!(key in value)) {
      errors.push(`${where}: missing key \`${key}\` (null, never absent)`);
      continue;
    }
    if (!matches(tag, value[key])) {
      errors.push(`${where}.${key}: not ${tag}`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!(key in schema) && !additive.includes(key)) {
      errors.push(
        `${where}: unexpected key \`${key}\` — a new wire key needs the ` +
          "additive-and-provably-unread proof in docs/spec-conformance.md",
      );
    }
  }
  return true;
}

/** Validate a `check`/`security` report payload. Returns every break found. */
export function validateReport(payload: unknown): readonly string[] {
  const errors: string[] = [];
  if (!checkKeys(payload, REPORT_KEYS, "report", errors)) {
    return errors;
  }
  if (errors.length > 0) {
    return errors;
  }
  if (payload["schema_version"] !== 1) {
    errors.push("report.schema_version must be 1");
  }
  checkKeys(payload["summary"], SUMMARY_KEYS, "report.summary", errors);
  const gates = asArray(payload["gates"]);
  gates.forEach((gate, index) => validateGate(gate, `gates[${index}]`, errors));
  if (errors.length === 0) {
    validateDerivations(payload, gates, errors);
  }
  return errors;
}

function validateGate(gate: unknown, where: string, errors: string[]): void {
  if (!checkKeys(gate, GATE_KEYS, where, errors, GATE_ADDITIVE_KEYS)) {
    return;
  }
  const skipped = gate["skipped"] === true;
  if (skipped !== (gate["skip_reason"] !== null)) {
    errors.push(`${where}: skipped and skip_reason must agree`);
  }
  if (skipped && (gate["passed"] === true || gate["error"] === true)) {
    errors.push(`${where}: a skipped gate is neither passed nor error`);
  }
  if (gate["error"] === true && gate["passed"] === true) {
    errors.push(`${where}: error:true cannot also be passed:true`);
  }
  const violations = asArray(gate["violations"]);
  violations.forEach((violation, index) =>
    checkKeys(violation, VIOLATION_KEYS, `${where}.violations[${index}]`, errors),
  );
  asArray(gate["advisories"]).forEach((advisory, index) =>
    checkKeys(advisory, VIOLATION_KEYS, `${where}.advisories[${index}]`, errors),
  );
  const total = gate["violation_count"];
  if (typeof total !== "number") {
    return;
  }
  if (violations.length > total) {
    errors.push(`${where}: len(violations) exceeds violation_count`);
  }
  if (gate["truncated"] === true && violations.length >= total) {
    errors.push(`${where}: truncated:true but nothing was hidden`);
  }
}

/**
 * The fields that MUST be derivable from `gates[]`.
 *
 * These are the checks that make a golden more than a snapshot: a report can
 * match its recorded bytes and still be internally inconsistent, and it is
 * the inconsistency — a summary that disagrees with the gates, an exit code
 * that downgrades a broken environment — that a consumer would act on.
 */
function validateDerivations(
  payload: JsonObject,
  gates: readonly unknown[],
  errors: string[],
): void {
  const rows = gates.filter(isObject);
  const skipped = rows.filter((gate) => gate["skipped"] === true).length;
  const passed = rows.filter(
    (gate) => gate["passed"] === true && gate["skipped"] !== true,
  ).length;
  const summary = payload["summary"];
  if (!isObject(summary)) {
    return;
  }
  const expect = (key: string, value: number): void => {
    if (summary[key] !== value) {
      errors.push(`summary.${key} (${String(summary[key])}) disagrees with gates[]: ${value}`);
    }
  };
  expect("gates_total", rows.length);
  expect("gates_passed", passed);
  expect("gates_skipped", skipped);
  expect("gates_failed", rows.length - passed - skipped);
  expect("violations_total", sum(rows, (gate) => numberAt(gate, "violation_count")));
  expect("violations_shown", sum(rows, (gate) => asArray(gate["violations"]).length));
  const duration = sum(rows, (gate) => numberAt(gate, "duration_ms"));
  if (payload["duration_ms"] !== duration) {
    errors.push("report.duration_ms != sum of gate duration_ms");
  }
  const allOk = rows.every((gate) => gate["passed"] === true || gate["skipped"] === true);
  if (payload["passed"] !== allOk) {
    errors.push("report.passed disagrees with gates[]");
  }
  const anyError = rows.some((gate) => gate["error"] === true);
  const expected = anyError ? 3 : allOk ? 0 : 1;
  if (payload["exit_code"] !== expected) {
    errors.push(
      `report.exit_code ${String(payload["exit_code"])} != ${expected} derived ` +
        "from gates[] (3 outranks 1; skipped is not failed)",
    );
  }
}

/** Validate one `.kragg/history.jsonl` line (SPEC.md section 5). */
export function validateJournalEntry(entry: unknown, where: string): readonly string[] {
  const errors: string[] = [];
  if (!checkKeys(entry, JOURNAL_KEYS, where, errors)) {
    return errors;
  }
  asArray(entry["gates"]).forEach((gate, index) =>
    checkKeys(gate, JOURNAL_GATE_KEYS, `${where}.gates[${index}]`, errors),
  );
  return errors;
}

/** Validate `.kragg/criticality.json`: a LIST of profile records. */
export function validateCriticality(data: unknown): readonly string[] {
  const errors: string[] = [];
  if (!Array.isArray(data)) {
    errors.push(
      "criticality: top level must be a list — a metadata object here would " +
        "surface through Python's read_json as a nameless profile record",
    );
    return errors;
  }
  data.forEach((record, index) =>
    checkKeys(record, CRITICALITY_KEYS, `criticality[${index}]`, errors),
  );
  return errors;
}

/** Validate `.kragg/criticality.stamp.json`, the TypeScript-only sidecar. */
export function validateStamp(data: unknown): readonly string[] {
  const errors: string[] = [];
  checkKeys(data, STAMP_KEYS, "criticality.stamp", errors);
  if (isObject(data)) {
    for (const key of ["source_digest", "inputs_digest"]) {
      const value = data[key];
      if (typeof value === "string" && !SHA256_HEX.test(value)) {
        errors.push(`criticality.stamp: \`${key}\` is not a SHA-256 hex digest`);
      }
    }
  }
  return errors;
}

/**
 * A run-varying string, and the token it is replaced by.
 *
 * Path replacement is a list rather than a regex because the values are known
 * exactly: the fixture's own temp directory and this repository's root. macOS
 * hands back `/private/var/...` from some APIs and `/var/...` from others, so
 * both spellings are registered; longest first, so a nested root never gets
 * half-replaced by its parent.
 */
export type Replacement = readonly [string, string];

/** Every spelling a path may take in output, longest first. */
export function pathReplacements(entries: readonly Replacement[]): readonly Replacement[] {
  const pairs: Replacement[] = [];
  for (const [source, token] of entries) {
    pairs.push([source, token]);
    if (source.startsWith("/private/")) {
      pairs.push([source.slice("/private".length), token]);
    } else if (source.startsWith("/var/") || source.startsWith("/tmp/")) {
      pairs.push([`/private${source}`, token]);
    }
  }
  return pairs.sort((left, right) => right[0].length - left[0].length);
}

/** Replace every registered run-varying path with its token. */
export function scrub(text: string, replacements: readonly Replacement[]): string {
  let result = text;
  for (const [source, token] of replacements) {
    result = result.split(source).join(token);
  }
  return result;
}

function scrubDeep(value: unknown, replacements: readonly Replacement[]): unknown {
  if (typeof value === "string") {
    return scrub(value, replacements);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubDeep(item, replacements));
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubDeep(item, replacements)]),
    );
  }
  return value;
}

/** Short git SHAs as `git rev-parse --short` prints them. */
const GIT_SHA = /^[0-9a-f]{7,40}$/u;

/** `(1.3s)` inside rendered text, which is wall clock in a string. */
const DURATION_TEXT = /\(\d+\.\ds\)/gu;

/**
 * Canonicalize the fields that legitimately vary; touch nothing else.
 *
 * The rule list is SPEC.md section 9's, unchanged, and each entry is
 * justified in docs/spec-conformance.md. `duration_ms` is only zeroed AFTER
 * {@link validateReport} has checked that the report total equals the sum of
 * the gates, so normalizing it cannot hide a broken total.
 */
export function normalizeReport(
  payload: unknown,
  replacements: readonly Replacement[],
): unknown {
  const scrubbed = scrubDeep(payload, replacements);
  if (!isObject(scrubbed)) {
    return scrubbed;
  }
  const result: Record<string, unknown> = { ...scrubbed };
  result["kragg_version"] = "<kragg-version>";
  result["started_at"] = "<started-at>";
  result["duration_ms"] = 0;
  const sha = result["git_sha"];
  if (typeof sha === "string" && GIT_SHA.test(sha)) {
    result["git_sha"] = "<git-sha>";
  }
  result["gates"] = asArray(result["gates"]).map((gate) =>
    isObject(gate) ? { ...gate, duration_ms: 0 } : gate,
  );
  return result;
}

/**
 * Sort criticality records canonically before diffing.
 *
 * Order among ties in `(betweenness, fan_in)` is implementation-defined —
 * SPEC.md section 6 says so, and Python's tie order is not even stable across
 * runs. The numbers are the contract; their order is not.
 */
export function normalizeCriticality(data: unknown): unknown {
  if (!Array.isArray(data)) {
    return data;
  }
  return [...data.filter(isObject)].sort((left, right) => {
    const byBetweenness = numberAt(right, "betweenness") - numberAt(left, "betweenness");
    if (byBetweenness !== 0) {
      return byBetweenness;
    }
    const byFanIn = numberAt(right, "fan_in") - numberAt(left, "fan_in");
    return byFanIn !== 0 ? byFanIn : stringAt(left, "name").localeCompare(stringAt(right, "name"));
  });
}

/**
 * Blank the sidecar's two digests. `source_digest` hashes the fixture files by
 * ABSOLUTE path, which is a temp directory here, and `inputs_digest` folds in
 * the resolved compiler's version and path, which is this machine's. Both are
 * validated as SHA-256 hex before they are blanked; only the value varies.
 */
export function normalizeStamp(data: unknown): unknown {
  return isObject(data)
    ? { ...data, source_digest: "<source-digest>", inputs_digest: "<inputs-digest>" }
    : data;
}

/**
 * Scrub paths out of hook stdout, and rendered durations only when asked.
 *
 * `(1.3s)` in a block reason is a gate that just ran, so it is wall clock and
 * has to go. The same spelling in a SessionStart context line is a number read
 * back out of the committed journal — fixed input, fixed output — and zeroing
 * it there would erase a real value the golden should be pinning. The
 * fixture's manifest says which case is which; the Python runner normalizes
 * both because every payload it records comes from a live run.
 */
export function normalizeHookOutput(
  text: string,
  replacements: readonly Replacement[],
  liveDurations: boolean,
): string {
  const scrubbed = scrub(text, replacements);
  return liveDurations ? scrubbed.replace(DURATION_TEXT, "(0.0s)") : scrubbed;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberAt(value: JsonObject, key: string): number {
  const item = value[key];
  return typeof item === "number" ? item : 0;
}

function stringAt(value: JsonObject, key: string): string {
  const item = value[key];
  return typeof item === "string" ? item : "";
}

function sum(rows: readonly JsonObject[], pick: (row: JsonObject) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}
