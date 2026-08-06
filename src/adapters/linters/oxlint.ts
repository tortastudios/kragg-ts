/**
 * Parser for `oxlint --format=json` — the closest analogue kragg has to ruff.
 *
 * ── SCHEMA, AND HOW IT WAS VERIFIED ────────────────────────────────────────
 * Read from oxc's own source, not from documentation or memory:
 *
 *  - `apps/oxlint/src/output_formatter/json.rs` — builds the envelope
 *    (`lint_command_info`) and delegates each diagnostic to miette's
 *    `JSONReportHandler`. Its inline `#[test] fn reporter()` asserts the exact
 *    bytes, which is the strongest form of confirmation available: the schema
 *    below is that assertion, field for field.
 *  - `oxc-project/oxc-miette`, `src/handlers/json.rs` — oxc's FORK of miette
 *    (`Cargo.toml`: `miette = { package = "oxc-miette", version = "3.0.0" }`).
 *    Upstream miette emits a span of `{offset, length}` only; the fork adds
 *    `line` and `column`. Targeting upstream's shape here would have silently
 *    produced position-less violations.
 *  - `crates/oxc_diagnostics/src/service.rs`, `wrap_diagnostics` — `filename`
 *    is the path made relative to the cwd with `\` normalized to `/`, falling
 *    back to the path as given when it is not under the cwd.
 *
 * Verified against oxc `main` as of 2026-08. Field ORDER is not relied on.
 *
 *     {
 *       "diagnostics": [
 *         {
 *           "message": "`debugger` statement is not allowed",
 *           "code": "eslint(no-debugger)",     // optional
 *           "severity": "error" | "warning" | "advice",
 *           "causes": [],
 *           "url": "...",                      // optional
 *           "help": "Remove the debugger statement",  // optional
 *           "note": "...",                     // optional
 *           "filename": "src/a.ts",
 *           "labels": [
 *             { "label": "...", "span": { "offset": 0, "length": 8,
 *                                         "line": 1, "column": 1 } }
 *           ],
 *           "related": []
 *         }
 *       ],
 *       "number_of_files": 1,
 *       "number_of_rules": 92,   // or null
 *       "threads_count": 8,
 *       "start_time": 0.031
 *     }
 *
 * ── FOUND-PROBLEMS vs. TOOL-CRASH ──────────────────────────────────────────
 * THE EXIT CODE CANNOT TELL THEM APART. `apps/oxlint/src/result.rs` maps
 * `LintFoundErrors` AND `InvalidOptionConfig` (and `InvalidOptionTsConfig`,
 * and every other `InvalidOption*`) to the same `ExitCode::FAILURE`. There is
 * no ruff-style exit 2 to key on.
 *
 * The discriminator is therefore the ENVELOPE: a run that reached the linter
 * always prints `{"diagnostics": [...], "number_of_files": ...}`, because
 * `lint_command_info` writes it unconditionally at the end of the run. A
 * config error aborts before that and leaves stdout without it. So "stdout
 * carries the envelope" means the linter ran, whatever it exited with, and
 * anything else is a crash — including a zero exit with no envelope, which
 * fails closed on purpose.
 */

import type { Violation } from "../../engine/models.ts";
import {
  isJsonObject,
  parseJsonPayload,
  readArray,
  readObject,
  readPosition,
  readString,
  relativeToRoot,
  violation,
  type JsonObject,
  type LintParse,
} from "./json.ts";

/** The envelope key that proves oxlint reached the end of a lint run. */
const ENVELOPE_KEY = "diagnostics";

/**
 * Turn `oxlint --format=json` stdout into violations.
 *
 * `root` is the project root; oxlint's own paths are relative to the cwd the
 * gate ran it in, which is that same root, so `relativeToRoot` is a no-op for
 * them and exists for the case where oxlint reports a path outside the cwd
 * (then absolute) verbatim.
 */
export function parseOxlintJson(stdout: string, root: string): LintParse {
  const payload = parseJsonPayload(stdout);
  if (!isJsonObject(payload) || !Array.isArray(payload[ENVELOPE_KEY])) {
    return {
      ok: false,
      message:
        "oxlint did not produce a JSON report. Its exit code cannot distinguish " +
        "a bad config from lint errors, so kragg treats a missing report as a " +
        "tool failure rather than a passing gate.",
    };
  }
  const violations: Violation[] = [];
  for (const entry of payload[ENVELOPE_KEY]) {
    const parsed = toViolation(entry, root);
    if (parsed !== null) {
      violations.push(parsed);
    }
  }
  return { ok: true, violations };
}

/**
 * One diagnostic, or `null` when there is nothing actionable to report.
 *
 * A diagnostic with neither a message nor a code carries no information a
 * reader could act on; dropping it is better than emitting an empty row.
 */
function toViolation(entry: unknown, root: string): Violation | null {
  if (!isJsonObject(entry)) {
    return null;
  }
  const message = readString(entry, "message");
  const code = readString(entry, "code");
  if (message === undefined && code === undefined) {
    return null;
  }
  const file = readString(entry, "filename");
  const span = firstSpan(entry);
  return violation({
    message: message ?? "lint violation",
    file: file === undefined ? undefined : relativeToRoot(file, root),
    line: span === undefined ? undefined : readPosition(span, "line"),
    column: span === undefined ? undefined : readPosition(span, "column"),
    code,
    // oxlint's JSON has no "fixable" flag — `--fix` is decided by rule
    // metadata the reporter never serializes. `help` is the fix advice the
    // tool actually provides ("Remove the debugger statement"), so it is what
    // a fix hint should carry. Falling back to `note` picks up the rules that
    // put their guidance there instead.
    fixHint: readString(entry, "help") ?? readString(entry, "note"),
  });
}

/**
 * The span of the FIRST label, which is the primary location.
 *
 * miette's label list is ordered as the rule attached them and oxlint's rules
 * attach the primary span first; later labels annotate context ("this is
 * declared here"). Reporting one violation per label would multiply a single
 * finding across the file.
 */
function firstSpan(entry: JsonObject): JsonObject | undefined {
  for (const label of readArray(entry, "labels")) {
    if (isJsonObject(label)) {
      const span = readObject(label, "span");
      if (span !== undefined) {
        return span;
      }
    }
  }
  return undefined;
}
