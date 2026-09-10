/**
 * Hook failure diagnostics — the file that stops a broken hook being silent.
 *
 * `src/hooks/claude.ts` fails OPEN on purpose: an internal failure exits 0 and
 * leaves the editing session alone. That contract is right and it stays. What
 * it USED to imply is that a hook which had stopped working looked exactly
 * like a hook with nothing to say — no output, exit 0, session unchanged — so
 * a `kragg.json` typo, an unresolvable project or a crash in the pipeline
 * could sit there for weeks while the model was told, every single turn, that
 * nothing was wrong. Failing open is about not DISRUPTING the session. It was
 * never meant to mean failing invisibly.
 *
 * So every internal failure now leaves two traces, neither of which disrupts
 * anything:
 *
 *  1. **A line on stderr.** At exit 0 the harness does not surface stderr as a
 *     `hook error` notice — it goes to the hook's debug output, where somebody
 *     asking "why did the hook not fire?" will actually find it. (This is why
 *     the exit code stays 0: it is the non-zero exits that put a red notice in
 *     front of the user on every edit.)
 *  2. **A record in `.kragg/hook-errors.jsonl`**, which `SessionStart` reads
 *     back and reports as "N kragg hook failures recorded since the last
 *     session" — so the next session BEGINS by telling the model and the
 *     human that the guardrail has been off.
 *
 * ── WHAT MAY GO IN THE FILE, AND WHAT MAY NOT ──────────────────────────────
 * The stdin payload is off limits. A hook payload carries a transcript path, a
 * session id, and a `tool_input` that is the tool's own arguments — for `Bash`
 * that is a command line, which routinely contains credentials. None of it is
 * needed to explain a failure, so none of it is written. What is written is a
 * timestamp, the EVENT NAME NARROWED TO A FIXED SET (see {@link eventLabel}),
 * and the error's own message, single-lined and capped. A payload cannot put
 * bytes of its own choosing into this file.
 *
 * ── WHY NOT `.kragg/history.jsonl` ─────────────────────────────────────────
 * That file is the cross-language wire format (SPEC.md section 5): a fixed set
 * of keys, one line per RUN, read by Python's `read_runs`. A hook that failed
 * before it could run anything has no run to record, and adding a key or an
 * entry kind would be a contract change in both repositories. A separate file
 * in the same append-only JSON Lines shape costs nothing and changes nothing.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { JOURNAL_DIR } from "../engine/journal.ts";
import { utcNow } from "../engine/report.ts";

/** Where the records live, beside the journal. */
export const HOOK_ERROR_FILE = "hook-errors.jsonl";

/** Rotation bounds, in the same shape as the journal's. */
const MAX_LINES = 200;
const KEEP_LINES = 100;

/** Cap on one recorded message. Long enough to name a file and a cause. */
const MAX_MESSAGE_CHARS = 400;

/**
 * The only event names that reach the file.
 *
 * `hook_event_name` is a string the harness chose, and a future release will
 * add events this port has never heard of. Narrowing to a fixed set here is
 * what makes the "no payload bytes in this file" promise checkable rather
 * than merely intended.
 */
const KNOWN_EVENTS: readonly string[] = ["PostToolUse", "Stop", "SessionStart"];

/** Full path of the record file for a root. */
export function hookErrorPath(root: string): string {
  return join(root, JOURNAL_DIR, HOOK_ERROR_FILE);
}

/** The label an event name is recorded under. Anything unknown is `other`. */
export function eventLabel(hookEventName: string): string {
  return KNOWN_EVENTS.includes(hookEventName) ? hookEventName : "other";
}

/**
 * Record one internal failure: a line on stderr, and a line in the file.
 *
 * NEVER THROWS, for the same reason journalling never throws — a read-only
 * checkout is a legitimate state, and diagnostics that can fail a hook are
 * worse than no diagnostics. A failure to record is itself best-effort: the
 * stderr line is attempted first, so the cheapest channel survives a `.kragg`
 * nobody can write to.
 */
export function recordHookFailure(
  root: string,
  event: string,
  error: unknown,
  emitError: (line: string) => void,
): void {
  const label = eventLabel(event);
  const message = failureMessage(error);
  try {
    emitError(`kragg hook: ${label}: ${message}`);
  } catch {
    // A caller-supplied sink that throws must not become the failure.
  }
  append(root, { ts: utcNow(), event: label, error: message });
}

/**
 * The SessionStart line for failures recorded since the last session, and the
 * marker that makes "since the last session" mean something.
 *
 * Returns `null` when nothing has been recorded since the previous report, so
 * the ordinary session pays nothing for this. When it does return a line it
 * has also appended a marker, so the same failures are not re-reported to the
 * next session — the file keeps its whole history for anyone who opens it.
 */
export function consumeFailureNotice(root: string): string | null {
  const pending = pendingFailures(root);
  const latest = pending.at(-1);
  if (latest === undefined) {
    return null;
  }
  append(root, { ts: utcNow(), event: "SessionStart", reported: pending.length });
  const count = pending.length;
  const noun = count === 1 ? "failure" : "failures";
  return (
    `${count} kragg hook ${noun} recorded since the last session ` +
    `(latest — ${latest.event}: ${latest.error}); ` +
    `the guardrail was not running. See ${JOURNAL_DIR}/${HOOK_ERROR_FILE}.`
  );
}

/** One recorded failure, already narrowed. */
interface RecordedFailure {
  readonly event: string;
  readonly error: string;
}

/** Failures written after the most recent `reported` marker. */
function pendingFailures(root: string): readonly RecordedFailure[] {
  let text: string;
  try {
    text = readFileSync(hookErrorPath(root), "utf8");
  } catch {
    return [];
  }
  const pending: RecordedFailure[] = [];
  for (const line of text.split("\n")) {
    if (line === "") {
      continue;
    }
    const entry = parseLine(line);
    if (entry === null) {
      continue;
    }
    if (typeof entry["reported"] === "number") {
      // A marker: everything before it has already been reported to a session.
      pending.length = 0;
      continue;
    }
    const error = entry["error"];
    const event = entry["event"];
    if (typeof error === "string" && typeof event === "string") {
      pending.push({ event, error });
    }
  }
  return pending;
}

function parseLine(line: string): Readonly<Record<string, unknown>> | null {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    // A half-written final line from an interrupted process, exactly as the
    // journal reader tolerates. The rest of the file is still good.
    return null;
  }
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Readonly<Record<string, unknown>>)
    : null;
}

/** Append one record and rotate. Swallows every write error. */
function append(root: string, entry: Readonly<Record<string, unknown>>): void {
  const path = hookErrorPath(root);
  try {
    mkdirSync(join(root, JOURNAL_DIR), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
    rotate(path);
  } catch {
    // See the docstring: diagnostics never fail the thing they describe.
  }
}

function rotate(path: string): void {
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
  if (lines.length > MAX_LINES) {
    writeFileSync(path, `${lines.slice(lines.length - KEEP_LINES).join("\n")}\n`, "utf8");
  }
}

/**
 * One line of text for anything that can be thrown.
 *
 * Newlines are collapsed because each record is one JSON Lines entry and a
 * stack trace in the middle of it helps nobody; the message is what names the
 * cause. Capped so a tool that prints its whole stdout into an error cannot
 * fill the file.
 */
function failureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const flat = raw.replaceAll(/\s+/gu, " ").trim();
  const text = flat === "" ? "no message" : flat;
  return text.length <= MAX_MESSAGE_CHARS
    ? text
    : `${text.slice(0, MAX_MESSAGE_CHARS)}… [truncated]`;
}
