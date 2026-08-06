/**
 * Claude Code hook wire protocol: parse untrusted stdin, build valid stdout.
 *
 * THIS MODULE PARSES A PAYLOAD WE DO NOT CONTROL. The harness writes JSON to
 * the hook's stdin; its shape is documented but the documentation moves, the
 * installed Claude Code may be newer or older than this package, and a future
 * release will add fields. Everything therefore arrives as `unknown` and is
 * narrowed field by field. No casts, no assertions, no trusting the shape.
 *
 * TOLERANCE IS A FEATURE, NOT SLOPPINESS. Unknown keys are ignored rather
 * than rejected, a missing key degrades to a null/false default, and a
 * payload that is not even a JSON object degrades to {@link EMPTY_HOOK_INPUT}.
 * A protocol addition must never crash the hook, because a crashing hook is a
 * broken editing session (see `claude.ts` on failing open).
 *
 * THE OUTPUT SIDE IS THE LOAD-BEARING PART. Verified against the current
 * Claude Code hooks reference (code.claude.com/docs/en/hooks.md):
 *
 *   - Exit 0 is the ONLY exit code whose stdout JSON is parsed at all.
 *     "JSON output is only processed on exit 0."
 *   - A non-zero, non-2 exit is a NON-BLOCKING error: the transcript shows a
 *     `<hook name> hook error` notice to the USER. The model never sees it.
 *     So `exit 1` is advisory and effectively inert for our purpose.
 *   - Exit 2 feeds stderr to Claude, but PostToolUse is documented as
 *     "Can block? No" — exit 2 there only surfaces stderr after the fact.
 *   - Top-level `{"decision": "block", "reason": ...}` on exit 0 is the
 *     documented decision-control shape for PostToolUse AND Stop, and it is
 *     the shape whose `reason` reaches the model.
 *
 * Hence: kragg always exits 0 and speaks through stdout JSON. Do not
 * "simplify" this to `process.exit(1)` on failure — it would look like it
 * works, and silently do nothing.
 */

/**
 * The fields of a hook payload kragg acts on, already narrowed.
 *
 * Deliberately flat and lossy: the raw payload carries `session_id`,
 * `transcript_path`, `permission_mode`, `tool_use_id`, `tool_response` and
 * more, none of which kragg needs. Keeping only what is used means a change
 * to any other field cannot affect this code.
 */
export interface HookInput {
  /** `hook_event_name`, or `""` when absent/unparseable. */
  readonly hookEventName: string;
  /** `tool_name` (e.g. `"Edit"`), or `null`. */
  readonly toolName: string | null;
  /** `tool_input.file_path`, or `null` when the tool edited no single file. */
  readonly filePath: string | null;
  /** `stop_hook_active` — true when a Stop hook already blocked this turn. */
  readonly stopHookActive: boolean;
  /** SessionStart `source`: startup | resume | clear | compact | fork. */
  readonly source: string | null;
  /** `cwd` reported by the harness, or `null`. */
  readonly cwd: string | null;
}

/** What a payload that told us nothing narrows to. Dispatches as a no-op. */
export const EMPTY_HOOK_INPUT: HookInput = {
  hookEventName: "",
  toolName: null,
  filePath: null,
  stopHookActive: false,
  source: null,
  cwd: null,
};

/**
 * Upper bound on a single emitted string.
 *
 * Claude Code caps hook output and spills the excess to a file, so an
 * unbounded `renderText` of a thousand-violation report would be replaced by
 * a preview — exactly the violations the model needs, dropped. Truncating
 * here keeps the head of the report, which is the actionable part, and says
 * so in-band.
 */
export const MAX_PAYLOAD_CHARS = 9000;

/**
 * Parse one hook payload. Total: never throws, never returns a partial shape.
 *
 * A non-object JSON document (`null`, `[1]`, `"x"`, `7`) and invalid JSON are
 * treated identically, because both mean "this is not a hook payload".
 */
export function parseHookInput(stdinText: string): HookInput {
  const data = parseObject(stdinText);
  if (data === null) {
    return EMPTY_HOOK_INPUT;
  }
  return {
    hookEventName: readString(data, "hook_event_name") ?? "",
    toolName: readString(data, "tool_name"),
    filePath: readFilePath(data),
    // Strict `=== true`: a truthy `"false"` string must not read as active,
    // and an absent field must read as inactive.
    stopHookActive: data["stop_hook_active"] === true,
    source: readString(data, "source"),
    cwd: readString(data, "cwd"),
  };
}

/**
 * Build the payload that puts `reason` in front of the model.
 *
 * Used for PostToolUse (feedback on the edit that just happened) and Stop
 * (refusing to let the turn end). The caller prints this on stdout and exits
 * 0 — see the module docstring for why any other exit code is a silent no-op.
 */
export function blockPayload(reason: string): string {
  return JSON.stringify({ decision: "block", reason: truncate(reason) });
}

/**
 * Build the SessionStart payload that injects `context` into the session.
 *
 * `hookSpecificOutput.additionalContext` is the documented context channel
 * for SessionStart. Plain stdout is also documented as being added to context
 * for this event specifically, which makes this doubly safe: if a future
 * Claude Code stopped recognising the JSON, the serialized text would still
 * land in context as stdout. Degraded, but never inert.
 */
export function sessionContextPayload(context: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: truncate(context),
    },
  });
}

/** A parsed JSON object. Values stay `unknown` until narrowed. */
type Table = Readonly<Record<string, unknown>>;

function parseObject(text: string): Table | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  return isTable(data) ? data : null;
}

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(table: Table, key: string): string | null {
  const value = table[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Pull the edited path out of `tool_input`.
 *
 * `tool_input` is the tool's own argument object, so its contents vary per
 * tool: Edit/Write/MultiEdit carry `file_path`, Bash carries `command`, and a
 * future tool may carry neither. Anything that is not a non-empty string
 * `file_path` yields `null`, which the caller reads as "no single file to
 * check" and falls back to git.
 */
function readFilePath(table: Table): string | null {
  const toolInput = table["tool_input"];
  return isTable(toolInput) ? readString(toolInput, "file_path") : null;
}

function truncate(text: string): string {
  if (text.length <= MAX_PAYLOAD_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_PAYLOAD_CHARS)}\n... [truncated, ${text.length} chars total]`;
}
