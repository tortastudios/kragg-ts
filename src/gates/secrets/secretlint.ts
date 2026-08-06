/**
 * secretlint adapter: command surface, exit-code classification, report parsing.
 *
 * ── THE CLI SURFACE THIS TARGETS ───────────────────────────────────────────
 * secretlint v10+, verified against `packages/secretlint/src/cli.ts` upstream
 * rather than from memory:
 *
 *  - the positional argument is a FILE PATH OR PICOMATCH GLOB, and the help
 *    text's own example is `secretlint "**` + `/*"`. It is not a directory
 *    walker; see `globFor` for the translation we do;
 *  - `--format json` selects the JSON formatter, which is literally
 *    `JSON.stringify(results)` over `SecretLintCoreResult[]`;
 *  - `--output <path>` writes the report to a file AND, per the documented
 *    exit table, forces exit `0` even when findings exist. We therefore NEVER
 *    pass `--output`: it would convert every finding into a clean scan;
 *  - `--secretlintignore <path>` is the allowlist file, secretlint's analogue
 *    of a baseline.
 *
 * Documented exit status, quoted from the help text:
 *   0 — no errors found (or errors found but `--output` specified)
 *   1 — linting failed, errors found
 *   2 — unexpected error occurred, fatal error
 *
 * ── REDACTION, AND WHY IT DIFFERS FROM gitleaks ────────────────────────────
 * `SecretLintCoreResult` carries `sourceContent`, which is THE ENTIRE FILE,
 * and each message carries a `message` string that rules build by
 * interpolating the matched value. secretlint masks that by default
 * (`maskSecrets`, on since v10) — but the CLI exposes `--no-maskSecrets`, and
 * a project's own config could turn it off, so the masking is not a guarantee
 * we control.
 *
 * So this adapter DOES NOT USE `message` AT ALL, which is the one real
 * difference from the gitleaks adapter (where `Description` is static rule
 * metadata and is safe). A finding is described by its `ruleId` and
 * `messageId`, which are structural identifiers that never contain matched
 * text. That costs some prose in the report and buys a guarantee.
 */

import { isAbsolute, join } from "node:path";

import type { Violation } from "../../engine/models.ts";
import {
  isRecord,
  own,
  plainText,
  positiveInt,
  SECRET_CODE,
  type SecretScanContext,
} from "./types.ts";

/** How a secretlint exit status should be read. */
export type SecretlintExit = "clean" | "leaks" | "error";

/**
 * Classify secretlint's exit status.
 *
 * `1` is findings and `2` is a fatal error, per the documented table above.
 * Every other non-zero status — including `127`, which `runCommand` returns
 * for a missing binary or a timeout — is an error. There is no
 * "unknown, assume clean" case.
 */
export function classifyExit(returncode: number): SecretlintExit {
  if (returncode === 0) {
    return "clean";
  }
  return returncode === 1 ? "leaks" : "error";
}

/**
 * The argv for one scan.
 *
 * All targets go in a single invocation, because secretlint accepts many
 * positionals and starting Node once instead of N times is the difference
 * between a fast gate and a slow one.
 *
 * `--no-color` because the stylish formatter is the CLI default and a
 * misconfigured `--format` should not hand us ANSI-laced output to parse.
 * Nothing here is shell-interpreted (`runner.ts` uses `shell: false`), so the
 * globs reach secretlint's own picomatch unexpanded, which is what its help
 * text asks for.
 */
export function scanCommand(context: SecretScanContext): readonly string[] {
  const command: string[] = [context.bin, "--format", "json", "--no-color"];
  if (context.baselinePath !== null) {
    command.push("--secretlintignore", absolutePath(context.root, context.baselinePath));
  }
  for (const target of context.targets) {
    command.push(globFor(target));
  }
  return command;
}

/**
 * Turn a kragg target into something secretlint will match.
 *
 * kragg targets are directories (`src`, `.`) because that is what every other
 * gate takes and what the Python sibling passes around. secretlint matches
 * paths and globs, and a bare `src` matches the directory ENTRY, not the files
 * under it — it would silently scan nothing, which is the fail-open case this
 * gate cannot have. A target that already looks like a glob is passed through
 * untouched so a project can be precise when it wants to be.
 */
export function globFor(target: string): string {
  if (/[*?[\]{}]/u.test(target)) {
    return target;
  }
  const trimmed = target.replace(/\/+$/u, "");
  return trimmed === "" || trimmed === "." ? "**/*" : `${trimmed}/**/*`;
}

function absolutePath(root: string, path: string): string {
  return isAbsolute(path) ? path : join(root, path);
}

/**
 * Turn a secretlint JSON report into violations.
 *
 * Returns `null` when the payload is not a JSON array, so the caller treats an
 * unreadable report as a broken scanner rather than as a clean repo. A single
 * malformed result or message is skipped; the readable ones survive.
 *
 * secretlint prints one result object PER FILE SCANNED, findings or not, so
 * the common case is a long array of empty `messages`. That is a clean scan,
 * not an empty report.
 */
export function parseReport(payload: string): readonly Violation[] | null {
  const trimmed = payload.trim();
  if (trimmed === "") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const violations: Violation[] = [];
  for (const result of parsed) {
    violations.push(...resultViolations(result));
  }
  return violations;
}

function resultViolations(result: unknown): readonly Violation[] {
  if (!isRecord(result)) {
    return [];
  }
  // `filePath` is read; `sourceContent` — the entire file — is not.
  const file = plainText(own(result, "filePath"), "");
  const messages = own(result, "messages");
  if (!Array.isArray(messages)) {
    return [];
  }
  const violations: Violation[] = [];
  for (const message of messages) {
    const violation = toViolation(message, file);
    if (violation !== null) {
      violations.push(violation);
    }
  }
  return violations;
}

/**
 * One message, reduced to the fields that are safe to publish.
 *
 * THE ALLOWLIST: `ruleId`, `messageId`, `severity`, `docsUrl`, and
 * `loc.start.{line,column}`. Read nothing else — in particular not `message`
 * (rules interpolate the matched value into it), not `data` (rule-defined and
 * unbounded), and not `range` (byte offsets into content we do not have).
 *
 * `type` is checked: secretlint emits `{ type: "ignore" }` entries for
 * suppressed findings in some shapes, and reporting a suppression as a
 * violation would make an allowlist look broken.
 *
 * COLUMN IS CONVERTED. secretlint documents `line` as 1-based and `column` as
 * 0-BASED (`SecretLintSourceNodeLocation`), while `violationLocation` renders
 * an editor-style 1-based `file:line:column`. Passing it through would point
 * one character to the left of every finding.
 */
function toViolation(message: unknown, file: string): Violation | null {
  if (!isRecord(message)) {
    return null;
  }
  const type = own(message, "type");
  if (type !== undefined && type !== "message") {
    return null;
  }
  const rule = plainText(own(message, "ruleId"), "unknown-rule");
  const messageId = plainText(own(message, "messageId"), "");
  const severity = plainText(own(message, "severity"), "error");
  const detail = messageId === "" ? "" : `: ${messageId}`;
  const level = severity === "error" ? "" : ` (${severity})`;
  const docsUrl = plainText(own(message, "docsUrl"), "");
  const start = startPosition(own(message, "loc"));
  return {
    message: `potential secret [${rule}]${detail}${level}`,
    file: file === "" ? undefined : file,
    line: start.line,
    column: start.column,
    code: SECRET_CODE,
    fixHint:
      "remove the credential and rotate it — assume it is compromised. If it " +
      "is a fixture or a false positive, allow it in .secretlintignore or via " +
      "`allowMessageIds` in .secretlintrc." +
      (docsUrl === "" ? "" : ` See ${docsUrl}`),
  };
}

/** A 1-based source position, with either half absent when unreadable. */
interface StartPosition {
  readonly line: number | undefined;
  readonly column: number | undefined;
}

/** `loc.start`, converted to 1-based line and column. */
function startPosition(loc: unknown): StartPosition {
  if (!isRecord(loc)) {
    return { line: undefined, column: undefined };
  }
  const start = own(loc, "start");
  if (!isRecord(start)) {
    return { line: undefined, column: undefined };
  }
  const rawColumn = own(start, "column");
  return {
    line: positiveInt(own(start, "line")),
    column:
      typeof rawColumn === "number" && Number.isInteger(rawColumn) && rawColumn >= 0
        ? rawColumn + 1
        : undefined,
  };
}
