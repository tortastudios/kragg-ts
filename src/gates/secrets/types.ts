/**
 * Shared vocabulary for the secret-scanning gate.
 *
 * This module exists to keep `../secrets.ts` (which orchestrates) and the two
 * scanner adapters (which parse) from importing each other. Everything here is
 * data and pure helpers; nothing spawns a process or touches the filesystem.
 *
 * THE REDACTION PRIMITIVES LIVE HERE. `plainText` is the only way a string
 * from a scanner may reach a `Violation`, and both adapters route every
 * string field through it. See `../secrets.ts` for why that matters.
 */

import type { Violation } from "../../engine/models.ts";

/** `Violation.code` for every finding this gate produces, in either scanner. */
export const SECRET_CODE = "secret";

/**
 * Longest scanner-supplied string that may appear in a violation message.
 *
 * A rule id or description is a short label. Anything longer is either a
 * malformed report or a payload, and neither belongs in a terminal, in
 * `.kragg/history.jsonl`, or in an agent transcript.
 */
export const MAX_TEXT_LENGTH = 200;

/**
 * C0 and C1 control characters, written as escapes.
 *
 * Deliberately NOT typed as literal control bytes in the source: an invisible
 * character class is unreviewable, and this pattern is a security control.
 * The range covers ESC (0x1B), which begins every ANSI sequence, so a rule
 * description out of an untrusted repo cannot repaint the terminal it is
 * printed to.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/gu;

/** A scanner kragg knows how to drive. */
export type SecretScanner = "gitleaks" | "secretlint";

/**
 * The `secret_scanner` policy setting.
 *
 * `"auto"` prefers gitleaks and falls back to secretlint. Naming a scanner
 * explicitly disables that fallback: a choice we cannot honour is reported,
 * never quietly swapped for the other tool. `"off"` is a legitimate, distinct
 * state and produces its own skip reason.
 */
export type SecretScannerChoice = SecretScanner | "auto" | "off";

/** Everything one adapter run needs. Resolution has already happened. */
export interface SecretScanContext {
  /** Absolute project root; the scanner's working directory. */
  readonly root: string;
  /** Absolute path to the resolved scanner executable. */
  readonly bin: string;
  /**
   * Paths or globs to scan, relative to `root`. Adapters translate these into
   * whatever their tool accepts; see each adapter for the exact mapping.
   */
  readonly targets: readonly string[];
  /** Root-relative or absolute baseline/allowlist path, or `null`. */
  readonly baselinePath: string | null;
}

/**
 * The three things a secret scan can produce, as a discriminated union.
 *
 * A union rather than a throw, matching `ForbiddenCallsOutcome`. The third arm
 * is what `forbiddenCalls` does not need: this gate can be legitimately
 * UNAVAILABLE, and "no scanner is installed" must never be rendered as a pass.
 *
 *  - `ok: true` — the scanner ran. Zero violations means a real clean scan.
 *  - `ok: false, skipped: true` — the gate did not run and says why. The
 *    caller renders `passed: true, skipped: true, skipReason: reason`.
 *  - `ok: false, skipped: false` — the scanner itself broke. The caller
 *    renders `error: true`, which is exit code 3.
 */
export type SecretsOutcome =
  | {
      readonly ok: true;
      readonly scanner: SecretScanner;
      readonly command: readonly string[];
      readonly violations: readonly Violation[];
    }
  | { readonly ok: false; readonly skipped: true; readonly reason: string }
  | {
      readonly ok: false;
      readonly skipped: false;
      readonly command: readonly string[];
      readonly message: string;
    };

/** Build the "the scanner ran" arm. */
export function scanned(
  scanner: SecretScanner,
  command: readonly string[],
  violations: readonly Violation[],
): SecretsOutcome {
  return { ok: true, scanner, command: [...command], violations };
}

/** Build the "gate did not run, and here is why" arm. */
export function skipped(reason: string): SecretsOutcome {
  return { ok: false, skipped: true, reason };
}

/** Build the "the scanner itself broke" arm — exit code 3, not a finding. */
export function broken(command: readonly string[], message: string): SecretsOutcome {
  return { ok: false, skipped: false, command: [...command], message };
}

/**
 * Make a scanner-supplied string safe to print, or fall back.
 *
 * Two jobs, both about output that lands in a terminal and a log:
 *
 *  1. CONTROL CHARACTERS ARE STRIPPED. A finding travels from an untrusted
 *     repo through a scanner into someone's terminal. An ANSI escape in a rule
 *     description could rewrite the line above it — including the count of
 *     findings — so C0 and C1 controls are removed rather than escaped.
 *  2. LENGTH IS CAPPED at `MAX_TEXT_LENGTH`. An unbounded string in a
 *     violation message is a way to push a scan's real findings off screen.
 *
 * Anything that is not a non-empty string yields `fallback`, so a malformed
 * report degrades to a named-but-vague finding instead of `undefined`
 * stringified into a message.
 */
export function plainText(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const stripped = value
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (stripped === "") {
    return fallback;
  }
  return stripped.length > MAX_TEXT_LENGTH
    ? `${stripped.slice(0, MAX_TEXT_LENGTH)}…`
    : stripped;
}

/** A parsed JSON object, before any of its fields have been checked. */
export type JsonObject = Readonly<Record<string, unknown>>;

/** Narrow parsed JSON to an object, the only shape either report uses. */
export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read an OWN property.
 *
 * Mirrors `policy.ts`: a plain index read on a parsed-JSON object resolves
 * `"constructor"` through `Object.prototype` and hands a function to a
 * narrowing helper. Scanner reports are derived from untrusted repo content.
 */
export function own(record: JsonObject, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * A 1-based line/column number, or `undefined`.
 *
 * `undefined` rather than a guessed `1`: `violationLocation` omits a missing
 * line entirely, and pointing an agent at the top of a file it should not edit
 * is worse than pointing it at the file alone.
 */
export function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return undefined;
  }
  return value;
}
