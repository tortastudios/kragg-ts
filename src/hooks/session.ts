/**
 * The SessionStart half of the Claude Code hook: what the model is told before
 * it writes a line.
 *
 * Split out of `claude.ts`, which dispatches events and owns the fail-open
 * contract. This event is the odd one out — it runs NO GATE, reads two files
 * from disk, and answers with context rather than a decision — so keeping it
 * beside the two checking paths only made the interesting part of that file
 * (what each event checks, and what happens when it cannot) harder to read.
 */

import { readRuns, renderStatusLines } from "../engine/journal.ts";
import { readJson as readCriticality } from "../gates/criticality.ts";
import { consumeFailureNotice, recordHookFailure } from "./diagnostics.ts";
import { sessionContextPayload } from "./protocol.ts";

/** How many recent journal entries SessionStart summarizes. */
export const SESSION_RUN_WINDOW = 10;

/** How many critical functions SessionStart lists before it stops. */
export const SESSION_CRITICAL_LIMIT = 8;

/**
 * THE SECOND INTEGRATION SEAM: make `.kragg/criticality.json` current.
 *
 * Injected for the same reason as `RunCheck` — the real implementation needs
 * the catalog and a `ts.Program`, and the hook must stay pure protocol so
 * every test here drives it with a fake. `commands/hookCheck.ts` closes both
 * seams; the CLI wires them at one call site.
 *
 * SessionStart needs this because `readJson` refuses data that no longer
 * describes the tree, and the previous session's edits are exactly what makes
 * it stale. Reading without deriving means the critical-function inventory
 * silently empties out for every repo anyone has ever worked in.
 *
 * CONTRACT: synchronous, idempotent, and best-effort. It may do nothing. It
 * may throw — the caller catches and records — but it must not be slow on a
 * repo whose data is already fresh, because it runs before the model gets its
 * context.
 */
export type EnsureCriticality = (root: string) => void;

/**
 * SessionStart: hand the model the inventory before it writes a line.
 *
 * Three pieces of state that are cheap to read and expensive to rediscover:
 * whether any hook failed since the last session, whether the last check
 * passed, and which functions the criticality analysis marked load-bearing.
 * All come from files on disk (`.kragg/hook-errors.jsonl`,
 * `.kragg/history.jsonl`, `.kragg/criticality.json`), so this event still runs
 * NO GATE.
 *
 * THE FAILURE NOTICE COMES FIRST, and it is the reason a broken hook cannot
 * stay broken indefinitely. Everything else here describes a guardrail that
 * was working; a session that opens with "the guardrail was not running" is
 * the one moment somebody is in a position to fix it. See `diagnostics.ts`.
 *
 * IT MAY DERIVE, ONCE. `readJson` refuses criticality data that no longer
 * describes the tree, and last session's edits are precisely what makes it
 * stale — so reading alone would have handed the model an empty inventory in
 * any repo anyone had ever touched, without saying so. `ensureCriticality`
 * regenerates it. That is a `ts.Program` build in the worst case, which is why
 * it is here and NOT on the PostToolUse path: SessionStart fires once, before
 * the model has started, where a one-time cost buys a session's worth of
 * context. Fresh data costs a directory walk and nothing else.
 *
 * FAIL-OPEN IS PRESERVED, AND THAT IS WHY THE `catch` IS AT THE DERIVATION
 * rather than around the whole dispatch. `runClaudeHook` would already swallow
 * a throw, but it would swallow the run-status lines with it — losing
 * information that was already on disk because a derivation we did not need
 * failed. Catching here means a broken analyzer costs exactly the criticality
 * section, and the rest of the context still reaches the model. It is no
 * longer quiet about it: the failure is recorded for the next session.
 *
 * NOTE ON A DELIBERATE GAP: the Python version also emits a project-map
 * digest via its `mapping` module. This port has no `mapping` equivalent yet,
 * so that section is absent rather than faked. Add it here when `kragg map`
 * lands on the TypeScript side.
 */
export function emitSessionContext(
  root: string,
  ensureCriticality: EnsureCriticality,
  emit: (line: string) => void,
  emitError: (line: string) => void,
): void {
  const lines: string[] = [];
  const notice = consumeFailureNotice(root);
  if (notice !== null) {
    lines.push(notice);
  }
  const runs = readRuns(root, SESSION_RUN_WINDOW);
  if (runs.length > 0) {
    lines.push(...renderStatusLines(runs));
  }
  try {
    ensureCriticality(root);
  } catch (error) {
    recordHookFailure(root, "SessionStart", error, emitError);
  }
  const critical = criticalFunctions(root, SESSION_CRITICAL_LIMIT);
  if (critical.length > 0) {
    lines.push("critical functions (extra scrutiny + tests when editing):");
    for (const name of critical) {
      lines.push(`  ${name}`);
    }
  }
  if (lines.length === 0) {
    // Nothing recorded yet. Emitting an empty context block would spend
    // context window to say nothing.
    return;
  }
  emit(sessionContextPayload(lines.join("\n")));
}

/**
 * Names from `.kragg/criticality.json` flagged `is_critical`.
 *
 * The records come back as raw `unknown`-valued maps because either the
 * Python or the TypeScript implementation may have written the file, at any
 * version — so each field is narrowed here rather than assumed. A missing or
 * malformed file yields an empty list, which simply omits the section.
 */
function criticalFunctions(root: string, limit: number): string[] {
  const names: string[] = [];
  for (const entry of readCriticality(root)) {
    if (entry["is_critical"] !== true) {
      continue;
    }
    const name = entry["name"];
    if (typeof name === "string" && name !== "") {
      names.push(name);
    }
    if (names.length >= limit) {
      break;
    }
  }
  return names;
}
