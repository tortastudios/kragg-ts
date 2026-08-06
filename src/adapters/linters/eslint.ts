/**
 * Parser for `eslint --format json`.
 *
 * ── SCHEMA, AND HOW IT WAS VERIFIED ────────────────────────────────────────
 * Read from ESLint's own source (v10.8.0, the current release as of 2026-08):
 *
 *  - `lib/cli-engine/formatters/json.js` is, in its entirety,
 *    `module.exports = function (results) { return JSON.stringify(results); }`.
 *    The wire format is therefore EXACTLY `ESLint.LintResult[]` with no
 *    reshaping — the type is the schema.
 *  - `lib/types/index.d.ts`, `interface LintResult` — `filePath`, `messages`,
 *    `suppressedMessages`, the five counts, optional `source`/`output`/`stats`,
 *    `usedDeprecatedRules`.
 *  - `@eslint/core`'s `interface LintMessage` (`packages/core/src/types.ts` in
 *    `eslint/rewrite`) — this is where the 1-based convention is stated in the
 *    doc comments themselves: "The 1-based column number", "The 1-based line
 *    number". `ruleId` is `string | null`, `fatal` is `true | undefined`, and
 *    `fix`/`suggestions` are both optional.
 *
 * Unlike the two Rust linters, the top level is an ARRAY, not an object:
 *
 *     [
 *       {
 *         "filePath": "/abs/path/src/a.ts",
 *         "messages": [
 *           { "ruleId": "no-unused-vars", "severity": 2,
 *             "message": "'x' is defined but never used.",
 *             "line": 3, "column": 7, "endLine": 3, "endColumn": 8,
 *             "fix": { "range": [10, 12], "text": "" },
 *             "suggestions": [ { "desc": "Remove it", "fix": {...} } ] }
 *         ],
 *         "suppressedMessages": [],
 *         "errorCount": 1, "fatalErrorCount": 0, "warningCount": 0,
 *         "fixableErrorCount": 1, "fixableWarningCount": 0,
 *         "usedDeprecatedRules": []
 *       }
 *     ]
 *
 * ── FOUND-PROBLEMS vs. TOOL-CRASH ──────────────────────────────────────────
 * ESLint IS the one tool with a ruff-shaped exit code, and it is the direct
 * analogue of ruff's `error_codes=(2,)`. From `bin/eslint.js`, in a comment
 * ESLint wrote itself: "exit code 2 (unsuccessful execution) could be
 * overwritten with 1 (successful execution, lint problems found) or even 0
 * (successful execution, no lint problems found)". So:
 *
 *   0 — ran, clean.        1 — ran, found problems.     2 — did not run.
 *
 * `lint.ts` keys on that, and this parser adds the second, subtler line:
 *
 * A `fatal: true` MESSAGE IS NOT A TOOL CRASH. It is a parse error in one
 * source file — ESLint counts it in `fatalErrorCount`, keeps linting the other
 * files, and exits 1. It is a finding ABOUT THE PROJECT and stays a violation.
 * Only exit 2 means ESLint itself could not run. Getting this backwards would
 * turn every syntax error in a work-in-progress file into "your linter is
 * broken", which is exactly the misdirection `error_codes` exists to avoid.
 */

import type { Violation } from "../../engine/models.ts";
import {
  isJsonObject,
  parseJsonPayload,
  readArray,
  readPosition,
  readProp,
  readString,
  relativeToRoot,
  violation,
  type JsonObject,
  type LintParse,
} from "./json.ts";

/** `Violation.code` for a parse failure, which ESLint reports with no rule. */
export const PARSE_ERROR_CODE = "parse-error";

/** Turn `eslint --format json` stdout into violations. */
export function parseEslintJson(stdout: string, root: string): LintParse {
  const payload = parseJsonPayload(stdout);
  if (!Array.isArray(payload)) {
    return {
      ok: false,
      message:
        "eslint did not produce a JSON report (`--format json` emits a top-level " +
        "array). kragg treats unreadable linter output as a tool failure rather " +
        "than a passing gate.",
    };
  }
  const violations: Violation[] = [];
  for (const result of payload) {
    if (isJsonObject(result)) {
      violations.push(...fileViolations(result, root));
    }
  }
  return { ok: true, violations };
}

/**
 * Every message for one linted file.
 *
 * `suppressedMessages` is deliberately NOT read: those are findings the
 * project disabled at their site with an inline directive, which is the
 * reviewable exemption mechanism, not a loophole to re-report around.
 */
function fileViolations(result: JsonObject, root: string): readonly Violation[] {
  const filePath = readString(result, "filePath");
  const file = filePath === undefined ? undefined : relativeToRoot(filePath, root);
  const violations: Violation[] = [];
  for (const message of readArray(result, "messages")) {
    if (!isJsonObject(message)) {
      continue;
    }
    const parsed = toViolation(message, file);
    if (parsed !== null) {
      violations.push(parsed);
    }
  }
  return violations;
}

function toViolation(message: JsonObject, file: string | undefined): Violation | null {
  const text = readString(message, "message");
  if (text === undefined) {
    return null;
  }
  const ruleId = readString(message, "ruleId");
  const fatal = readProp(message, "fatal") === true;
  return violation({
    message: text,
    file,
    line: readPosition(message, "line"),
    column: readPosition(message, "column"),
    // A fatal message has `ruleId: null` because no rule produced it. Falling
    // back to a synthetic code keeps every violation groupable by cause, which
    // a bare `undefined` would not.
    code: ruleId ?? (fatal ? PARSE_ERROR_CODE : undefined),
    fixHint: fixHint(message),
  });
}

/**
 * The most actionable advice ESLint attached, or `undefined`.
 *
 * `fix` outranks `suggestions` because it is the one ESLint will apply
 * unattended: `--fix` never applies a suggestion, by design, since suggestions
 * can change behaviour. Naming `--fix` for a suggestion-only message would
 * promise a fix that does not arrive.
 */
function fixHint(message: JsonObject): string | undefined {
  if (isJsonObject(readProp(message, "fix"))) {
    return "auto-fixable: run `eslint --fix`";
  }
  for (const suggestion of readArray(message, "suggestions")) {
    if (isJsonObject(suggestion)) {
      const desc = readString(suggestion, "desc");
      if (desc !== undefined) {
        return `suggested fix: ${desc}`;
      }
    }
  }
  return undefined;
}
