/**
 * Parser for `biome check --reporter=json`.
 *
 * ── SCHEMA, AND HOW IT WAS VERIFIED ────────────────────────────────────────
 * Read from Biome's own source and from its committed CLI snapshots:
 *
 *  - `crates/biome_cli/src/reporter/json.rs` — the reporter builds its output
 *    by hand with the JSON factory (NOT serde), so the field names in
 *    `report_to_json` / `location_report_to_json` / `location_span_to_json`
 *    are literally the emitted keys. `category` and `location` are pushed
 *    CONDITIONALLY (`if let Some(...)`), so both are genuinely optional.
 *  - `crates/biome_cli/tests/snapshots/main_cases_reporter_json/
 *    reports_diagnostics_json_lint_command.snap` — a recorded end-to-end run,
 *    which is where the 1-based line/column convention was confirmed rather
 *    than assumed: `let f;` reports column 5 (`f`), and `\t\tlet f;` reports
 *    column 7, so a tab counts as one column and the first column is 1.
 *  - `to_json_report` — when a diagnostic has a file but no span, `location`
 *    is emitted with `{line: 0, column: 0}`. `readPosition` rejects zero, so
 *    that degrades to a file-only violation instead of `file:0:0`.
 *
 * Verified against biome `main` as of 2026-08 (latest release 2.5.x). The
 * reporter is still labelled experimental by Biome itself — it prints
 * "The `json` and `json-pretty` reporters are experimental and may change in
 * patch releases." on every run — which is the single biggest schema risk of
 * the three tools.
 *
 *     {
 *       "summary": { "changed": 0, "unchanged": 2, "errors": 12, ... },
 *       "diagnostics": [
 *         {
 *           "severity": "hint"|"info"|"warning"|"error"|"fatal",
 *           "message": "This import is unused.",
 *           "category": "lint/correctness/noUnusedImports",   // optional
 *           "location": {                                      // optional
 *             "path": "index.ts",
 *             "start": { "line": 1, "column": 8 },
 *             "end":   { "line": 1, "column": 12 }
 *           },
 *           "advices": [ { "start": {...}, "end": {...}, "text": "..." } ]
 *         }
 *       ],
 *       "command": "lint"
 *     }
 *
 * ── FOUND-PROBLEMS vs. TOOL-CRASH ──────────────────────────────────────────
 * As with oxlint, THE EXIT CODE CANNOT TELL THEM APART:
 * `crates/biome_cli/src/diagnostics.rs`'s `impl Termination for CliDiagnostic`
 * is `if severity >= Severity::Error { FAILURE } else { SUCCESS }` — one
 * failure code for a lint finding and for an unreadable `biome.json` alike.
 *
 * Two discriminators, both needed:
 *
 *  1. THE ENVELOPE. A run that reached the reporter prints a `diagnostics`
 *     array. A config error aborts before the traversal and prints a plain
 *     text diagnostic instead, so no envelope means the tool failed.
 *  2. THE CATEGORY. Biome routes SOME failures through the diagnostics array
 *     rather than out of band, so an envelope is not by itself proof of a
 *     clean run. A diagnostic in `TOOL_FAILURE_CATEGORIES`, or one at
 *     `"fatal"` severity, is Biome reporting that IT broke — not that the code
 *     did — and is surfaced as a tool failure. Reporting `internalError` as a
 *     code-quality violation would send a user to fix their own source over a
 *     bug in the linter.
 */

import type { Violation } from "../../engine/models.ts";
import {
  isJsonObject,
  parseJsonPayload,
  readObject,
  readPosition,
  readString,
  relativeToRoot,
  violation,
  readArray,
  type JsonObject,
  type LintParse,
} from "./json.ts";

/** The envelope key that proves biome reached its reporter. */
const ENVELOPE_KEY = "diagnostics";

/**
 * Diagnostic categories that mean BIOME failed, not that the code did.
 *
 * Matched as a prefix on `category`, because Biome's categories are
 * `/`-delimited paths (`lint/correctness/noUnusedImports`) and the failure
 * families have sub-categories. `lint/*` and `format/*` are deliberately
 * absent: those are findings about the project.
 */
const TOOL_FAILURE_CATEGORIES: readonly string[] = [
  "configuration",
  "internalError",
  "flags",
  "project",
];

/** Severity that means Biome could not continue. */
const FATAL_SEVERITY = "fatal";

/** Turn `biome check --reporter=json` stdout into violations. */
export function parseBiomeJson(stdout: string, root: string): LintParse {
  const payload = parseJsonPayload(stdout);
  if (!isJsonObject(payload) || !Array.isArray(payload[ENVELOPE_KEY])) {
    return {
      ok: false,
      message:
        "biome did not produce a JSON report. Its exit code cannot distinguish " +
        "a bad config from lint errors, so kragg treats a missing report as a " +
        "tool failure rather than a passing gate.",
    };
  }
  const violations: Violation[] = [];
  for (const entry of payload[ENVELOPE_KEY]) {
    if (!isJsonObject(entry)) {
      continue;
    }
    const failure = toolFailure(entry);
    if (failure !== null) {
      return { ok: false, message: failure };
    }
    const parsed = toViolation(entry, root);
    if (parsed !== null) {
      violations.push(parsed);
    }
  }
  return { ok: true, violations };
}

/**
 * The message for a diagnostic that reports Biome's own failure, or `null`.
 *
 * Fails the WHOLE parse rather than skipping the entry: if the config is
 * unreadable then every finding Biome did or did not produce is suspect, and
 * reporting the remaining ones as a complete result would understate the
 * problem.
 */
function toolFailure(entry: JsonObject): string | null {
  const category = readString(entry, "category");
  const severity = readString(entry, "severity");
  const isFailure =
    severity === FATAL_SEVERITY ||
    (category !== undefined &&
      TOOL_FAILURE_CATEGORIES.some(
        (prefix) => category === prefix || category.startsWith(`${prefix}/`),
      ));
  if (!isFailure) {
    return null;
  }
  const message = readString(entry, "message") ?? "biome reported a fatal diagnostic";
  return `biome could not complete the check [${category ?? severity ?? "fatal"}]: ${message}`;
}

function toViolation(entry: JsonObject, root: string): Violation | null {
  const message = readString(entry, "message");
  const category = readString(entry, "category");
  if (message === undefined && category === undefined) {
    return null;
  }
  const location = readObject(entry, "location");
  const start = location === undefined ? undefined : readObject(location, "start");
  const file = location === undefined ? undefined : readString(location, "path");
  return violation({
    message: message ?? "lint violation",
    file: file === undefined ? undefined : relativeToRoot(file, root),
    line: start === undefined ? undefined : readPosition(start, "line"),
    column: start === undefined ? undefined : readPosition(start, "column"),
    code: category,
    // Biome's JSON `advices` are code suggestions — `{start, end, text}` where
    // `text` is replacement source. That text is unbounded and often
    // multi-line, so it is a poor fix HINT; its presence is the useful signal,
    // and the actionable advice is the command that applies it.
    fixHint:
      readArray(entry, "advices").length > 0
        ? "auto-fixable: run `biome check --write`"
        : undefined,
  });
}
