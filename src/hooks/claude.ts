/**
 * Claude Code hook adapter — the thing that closes kragg's feedback loop.
 *
 * `kragg hook claude` reads one hook payload from stdin, dispatches on the
 * event, and answers in the protocol the harness understands. Ported from
 * `kragg/src/kragg/hooks.py`, with the wire details re-verified against the
 * current Claude Code hooks reference rather than trusted from the port.
 *
 *  - PostToolUse: incremental check on the file that was just edited. On
 *    failure, emit `{"decision":"block","reason":...}` so the violations
 *    re-enter the model's context while it still remembers the edit.
 *  - Stop: full check. Failure blocks the stop, so "done" always means green.
 *    `stop_hook_active` is honoured — see {@link handleStop}.
 *  - SessionStart: inject last-run status and the critical-function inventory
 *    as context, so the model starts the session knowing where the load-
 *    bearing code is. The inventory is DERIVED when the last session's edits
 *    outran it, rather than silently omitted — see {@link EnsureCriticality}.
 *
 * ==================== READ THIS BEFORE CHANGING EXIT CODES ================
 *
 * A PLAIN `exit 1` HOOK IS ADVISORY AND THE MODEL NEVER SEES IT. Claude Code
 * treats any non-zero, non-2 exit as a non-blocking error: the user gets a
 * `hook error` notice in the transcript and the turn proceeds unchanged. Only
 * exit 2 (stderr → model) or a `{"decision":"block"}` JSON payload on exit 0
 * actually reaches the model, and PostToolUse is documented as non-blockable
 * even at exit 2. So every path here returns 0 and speaks through stdout
 * JSON. Making failures `return 1` would produce a hook that appears to work,
 * silently does nothing, and gives false confidence that the loop is closed.
 *
 * ==================== HOOKS FAIL OPEN. DO NOT "FIX" THIS. ================
 *
 * Everywhere else kragg is fail-closed: a gate that cannot run is an error,
 * a malformed policy is an error, a missing tool is an error. THIS FILE IS
 * THE DELIBERATE EXCEPTION. `runClaudeHook` wraps the whole dispatch and
 * returns 0 on ANY internal failure — bad policy, unreadable repo, a crash in
 * a gate, a protocol change we did not anticipate. The reason is that this
 * code runs inside somebody's editing session on every single edit: a broken
 * guardrail must not become a broken editor. A hook that wedges the harness
 * gets uninstalled within the hour, and then there are no guardrails at all.
 * The check itself stays fail-closed; only its delivery here fails open.
 */

import { isAbsolute, relative } from "node:path";

import { readRuns, renderStatusLines } from "../engine/journal.ts";
import { renderText, reportPassed, type CheckReport } from "../engine/report.ts";
import { DECLARATION_SUFFIXES, SOURCE_EXTENSIONS, changedFiles } from "../git/changes.ts";
import { readJson as readCriticality } from "../gates/criticality.ts";
import { loadPolicy } from "../policy/policy.ts";
import { testScanDirectories } from "../util/testPaths.ts";
import {
  blockPayload,
  parseHookInput,
  sessionContextPayload,
  type HookInput,
} from "./protocol.ts";

/** The only exit code a hook may return. See the module docstring. */
export const HOOK_OK = 0;

/** How many recent journal entries SessionStart summarizes. */
export const SESSION_RUN_WINDOW = 10;

/** How many critical functions SessionStart lists before it stops. */
export const SESSION_CRITICAL_LIMIT = 8;

/** What the hook asks the check pipeline to do. */
export interface HookCheckRequest {
  /** Project root the hook is running in. */
  readonly root: string;
  /** Repo-relative paths to check. Never empty. */
  readonly targets: readonly string[];
  /** True for the fast changed-files pass, false for the full pipeline. */
  readonly incremental: boolean;
}

/**
 * THE INTEGRATION SEAM. The check pipeline, injected rather than imported.
 *
 * The real implementation lives in `src/catalog.ts`, which builds gate specs
 * and runs them. This module deliberately does not import it: the hook is
 * pure protocol and policy, and every test here drives it with a fake so no
 * test ever shells out to tsc, a linter, or a test runner. Wire the real one
 * at the CLI dispatch site.
 *
 * Resolving to `null` means "the check could not be run at all". The hook
 * treats that exactly like a pass — it is the fail-open contract: an
 * unrunnable pipeline must not block the user's edit. Do not throw for that
 * case; reserve throwing for genuine bugs (which are also swallowed, one
 * level up, but noisily wrong all the same).
 *
 * The injected implementation OWNS JOURNALING. `kragg check` appends its own
 * run to `.kragg/history.jsonl`; if this module appended too, every hook
 * invocation would double-count. SessionStart reads that journal, so the two
 * halves meet through the file, not through a call.
 */
export type RunCheck = (request: HookCheckRequest) => Promise<CheckReport | null>;

/**
 * THE SECOND INTEGRATION SEAM: make `.kragg/criticality.json` current.
 *
 * Injected for the same reason as {@link RunCheck} — the real implementation
 * needs the catalog and a `ts.Program`, and this module must stay pure
 * protocol so every test here drives it with a fake. `hookCheck.ts` closes
 * both seams; the CLI wires them at one call site.
 *
 * SessionStart needs this because `readJson` refuses data that no longer
 * describes the tree, and the previous session's edits are exactly what makes
 * it stale. Reading without deriving means the critical-function inventory
 * silently empties out for every repo anyone has ever worked in.
 *
 * CONTRACT: synchronous, idempotent, and best-effort. It may do nothing. It
 * may throw — the caller catches — but it must not be slow on a repo whose
 * data is already fresh, because it runs before the model gets its context.
 */
export type EnsureCriticality = (root: string) => void;

/** Inputs to one hook invocation. */
export interface ClaudeHookOptions {
  /** Project root — normally `process.cwd()`. */
  readonly root: string;
  /** Raw stdin text. Untrusted; may be empty or malformed. */
  readonly stdin: string;
  /** The check pipeline. See {@link RunCheck}. */
  readonly runCheck: RunCheck;
  /** Criticality derivation. See {@link EnsureCriticality}. */
  readonly ensureCriticality: EnsureCriticality;
  /** Where a payload line goes. Defaults to stdout. Injected by tests. */
  readonly emit?: ((line: string) => void) | undefined;
}

/**
 * Handle one Claude Code hook invocation. NEVER THROWS, ALWAYS RETURNS 0.
 *
 * The `catch` is not defensive padding — it is the fail-open contract stated
 * in the module docstring, and it is exercised by tests. Adding a rethrow, a
 * non-zero return, or an error log to stderr (which the harness surfaces as a
 * `hook error` notice on every edit) would all break it in different ways.
 */
export async function runClaudeHook(options: ClaudeHookOptions): Promise<number> {
  try {
    return await dispatch(options);
  } catch {
    return HOOK_OK;
  }
}

async function dispatch(options: ClaudeHookOptions): Promise<number> {
  const input = parseHookInput(options.stdin);
  const emit = options.emit ?? writeStdout;
  if (input.hookEventName === "Stop") {
    return await handleStop(input, options, emit);
  }
  if (input.hookEventName === "SessionStart") {
    return handleSessionStart(options, emit);
  }
  // Everything else is treated as a post-edit event, matching the Python
  // original. An unknown or absent event name therefore costs at most one
  // incremental check on the changed files, never a crash — and a payload
  // with no editable file (the common case for an unknown event) short-
  // circuits to a no-op inside `editTargets`.
  return await handlePostEdit(input, options, emit);
}

/**
 * PostToolUse: check what was just edited, and say so if it is broken.
 *
 * Scoped to a single file when the tool reported one, so the common Edit or
 * Write case costs one incremental pass rather than a full run. A tool that
 * edited no single file (Bash, MultiEdit across a set) falls back to git's
 * changed-files list, which is what `kragg check --changed` uses.
 */
async function handlePostEdit(
  input: HookInput,
  options: ClaudeHookOptions,
  emit: (line: string) => void,
): Promise<number> {
  const targets = await editTargets(input, options.root);
  if (targets.length === 0) {
    return HOOK_OK;
  }
  const report = await options.runCheck({
    root: options.root,
    targets,
    incremental: true,
  });
  if (report === null || reportPassed(report)) {
    return HOOK_OK;
  }
  emit(blockPayload(`kragg gates failed:\n${renderText(report)}`));
  return HOOK_OK;
}

/**
 * Stop: refuse to let the turn end while the project is red.
 *
 * `stop_hook_active` IS THE INFINITE-LOOP GUARD AND IT IS NOT OPTIONAL. The
 * harness sets it on a Stop payload that follows a Stop this hook already
 * blocked. Without the check, a repo with one unfixable violation would block
 * every stop forever: the model tries to finish, we block, it tries again, we
 * block again. Claude Code does cap consecutive blocks and force the stop
 * through, so the failure mode is a burned turn budget rather than a true
 * hang — which is worse, because it looks like the model is being stupid
 * instead of like the hook being wrong. Return 0 immediately and let the turn
 * end; the next Stop starts fresh.
 */
async function handleStop(
  input: HookInput,
  options: ClaudeHookOptions,
  emit: (line: string) => void,
): Promise<number> {
  if (input.stopHookActive) {
    return HOOK_OK;
  }
  const policy = loadPolicy(options.root);
  const target = policy.sourcePaths[0];
  if (target === undefined) {
    return HOOK_OK;
  }
  const report = await options.runCheck({
    root: options.root,
    targets: [target],
    incremental: false,
  });
  if (report === null || reportPassed(report)) {
    return HOOK_OK;
  }
  emit(blockPayload(`kragg check must pass before finishing:\n${renderText(report)}`));
  return HOOK_OK;
}

/**
 * SessionStart: hand the model the inventory before it writes a line.
 *
 * Two pieces of state that are cheap to read and expensive to rediscover:
 * whether the last check passed, and which functions the criticality analysis
 * marked load-bearing. Both come from files on disk (`.kragg/history.jsonl`,
 * `.kragg/criticality.json`), so this event still runs NO GATE.
 *
 * IT MAY NOW DERIVE, ONCE. `readJson` refuses criticality data that no longer
 * describes the tree, and last session's edits are precisely what makes it
 * stale — so reading alone would have handed the model an empty inventory in
 * any repo anyone had ever touched, without saying so. `ensureCriticality`
 * regenerates it. That is a `ts.Program` build in the worst case, which is why
 * it is here and NOT on the PostToolUse path: SessionStart fires once, before
 * the model has started, where a one-time cost buys a session's worth of
 * context. Fresh data costs a directory walk and nothing else.
 *
 * FAIL-OPEN IS PRESERVED, AND THAT IS WHY THE `catch` IS HERE RATHER THAN
 * AROUND THE WHOLE DISPATCH. `runClaudeHook` would already swallow a throw,
 * but it would swallow the run-status lines with it — losing information that
 * was already on disk because a derivation we did not need failed. Catching at
 * the derivation means a broken analyzer costs exactly the criticality
 * section, quietly, and the rest of the context still reaches the model.
 *
 * NOTE ON A DELIBERATE GAP: the Python version also emits a project-map
 * digest via its `mapping` module. This port has no `mapping` equivalent yet,
 * so that section is absent rather than faked. Add it here when `kragg map`
 * lands on the TypeScript side.
 */
function handleSessionStart(
  options: ClaudeHookOptions,
  emit: (line: string) => void,
): number {
  const root = options.root;
  const lines: string[] = [];
  const runs = readRuns(root, SESSION_RUN_WINDOW);
  if (runs.length > 0) {
    lines.push(...renderStatusLines(runs));
  }
  try {
    options.ensureCriticality(root);
  } catch {
    // See the fail-open note above. No stderr: the harness surfaces anything
    // written there as a `hook error` notice on the user's session.
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
    return HOOK_OK;
  }
  emit(sessionContextPayload(lines.join("\n")));
  return HOOK_OK;
}

/**
 * What this hook invocation should check.
 *
 * An empty result means "nothing to do" and the caller returns without ever
 * touching the check pipeline. That is the path a Markdown edit, a config
 * tweak or a `Bash` tool call takes, and it is why the hook is cheap enough
 * to run on every tool use.
 */
async function editTargets(input: HookInput, root: string): Promise<string[]> {
  if (input.filePath !== null) {
    return isCheckableSource(input.filePath) ? [relativeToRoot(input.filePath, root)] : [];
  }
  const policy = loadPolicy(root);
  const allowed = [...policy.sourcePaths, ...testScanDirectories(policy.testPaths)];
  // `changedFiles` returns null outside a git repository. Here — unlike in
  // `kragg check --changed`, which must report that loudly — null and "no
  // changes" are the same no-op: there is nothing to check either way.
  return (await changedFiles(root, null, allowed)) ?? [];
}

/**
 * Whether a path is TypeScript/JavaScript source kragg gates apply to.
 *
 * The extension list is imported from `git/changes.ts` rather than restated,
 * so the hook and `--changed` can never disagree about what counts as source.
 * Python only had to check `.py`.
 *
 * ORDER MATTERS: `.d.ts` also ends in `.ts`, so the declaration test runs
 * first. An ambient declaration is generated build output in most repos and
 * has no executable statements for a gate to find.
 */
export function isCheckableSource(filePath: string): boolean {
  const path = filePath.replaceAll("\\", "/");
  if (DECLARATION_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
    return false;
  }
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/**
 * Make a harness-supplied path repo-relative, or leave it alone.
 *
 * Claude Code reports absolute paths. Gates and reports speak repo-relative
 * ones. A path that resolves OUTSIDE the root is returned unchanged rather
 * than as a `../..` traversal — the caller passes targets to the check
 * pipeline, and a relative path escaping the project is not something to
 * hand onward.
 */
function relativeToRoot(filePath: string, root: string): string {
  if (!isAbsolute(filePath)) {
    return filePath;
  }
  const rel = relative(root, filePath).replaceAll("\\", "/");
  if (rel === "" || rel.startsWith("../") || isAbsolute(rel)) {
    return filePath;
  }
  return rel;
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

function writeStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}
