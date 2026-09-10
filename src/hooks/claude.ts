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
 *
 *  - SessionStart: inject last-run status and the critical-function inventory
 *    as context, so the model starts the session knowing where the load-
 *    bearing code is. It lives in `session.ts`; the inventory is DERIVED when
 *    the last session's edits outran it, rather than silently omitted.
 *
 * WHAT EACH EVENT CHECKS IS NOT DECIDED HERE. This module says which of the
 * CLI's own three scopes an event means — the whole project, one file, the
 * change set — and `src/commands/scope.ts` resolves it, exactly as it does for
 * `kragg check`. That is why {@link HookScope} is an intent rather than a file
 * list: `src/hooks` sits BELOW `src/commands` in the layer order, so the hook
 * cannot import the resolver, and the alternative — deriving targets here —
 * is how the Stop hook came to check only the first of a project's source
 * directories while `kragg check` checked all of them.
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
 *
 * FAILING OPEN IS NOT FAILING INVISIBLY. Every one of those internal failures
 * is now RECORDED — a line on stderr and an entry in `.kragg/hook-errors.jsonl`
 * that the next SessionStart reports — because a hook that has quietly stopped
 * working is indistinguishable from a hook with nothing to say, and it stays
 * that way for as long as nobody notices. See `diagnostics.ts` for what may go
 * in that file (never the stdin payload) and why stderr at exit 0 does not put
 * a `hook error` notice in front of the user.
 */

import { isAbsolute, relative } from "node:path";

import { renderText, reportPassed, type CheckReport } from "../engine/report.ts";
import { DECLARATION_SUFFIXES, SOURCE_EXTENSIONS } from "../git/changes.ts";
import { eventLabel, recordHookFailure } from "./diagnostics.ts";
import { blockPayload, parseHookInput, type HookInput } from "./protocol.ts";
import { emitSessionContext, type EnsureCriticality } from "./session.ts";

/** The only exit code a hook may return. See the module docstring. */
export const HOOK_OK = 0;

/**
 * Which of the CLI's scopes this event means. Resolved by the implementation.
 *
 *  - `full`    — the whole project, as plain `kragg check`. EVERY source path,
 *                not the first one: a project that declares `["src", "lib"]`
 *                had `lib` linted by the command and not by the Stop hook,
 *                which is a green "done" over a directory nobody looked at.
 *  - `file`    — one edited file, as `kragg check --file <path>`.
 *  - `changed` — the change set, as `kragg check --changed`, for a tool that
 *                edited no single file (`Bash`, a multi-file edit).
 */
export type HookScope =
  | { readonly kind: "full" }
  | { readonly kind: "file"; readonly file: string }
  | { readonly kind: "changed" };

/** What the hook asks the check pipeline to do. */
export interface HookCheckRequest {
  /** Project root the hook is running in. */
  readonly root: string;
  /** What to check. See {@link HookScope}. */
  readonly scope: HookScope;
}

/**
 * What came back — and, crucially, WHICH KIND OF NOTHING when it is nothing.
 *
 * The seam used to answer `CheckReport | null`, and `null` meant both "there
 * was nothing in scope to check" and "the pipeline could not be run at all".
 * Both were treated as a pass, silently, which made an unusable `kragg.json`
 * look exactly like a clean tree for as long as nobody investigated. They are
 * separate answers now: `nothing` is the ordinary quiet outcome, `failed`
 * carries a message this module records. Neither blocks — the fail-open
 * contract is unchanged; only the silence is gone.
 */
export type HookCheckOutcome =
  | { readonly kind: "report"; readonly report: CheckReport }
  | { readonly kind: "nothing" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * THE INTEGRATION SEAM. The check pipeline, injected rather than imported.
 *
 * The real implementation lives in `src/catalog.ts`, which builds gate specs
 * and runs them. This module deliberately does not import it: the hook is
 * pure protocol and policy, and every test here drives it with a fake so no
 * test ever shells out to tsc, a linter, or a test runner. Wire the real one
 * at the CLI dispatch site.
 *
 * The implementation also OWNS SCOPE RESOLUTION: it turns the {@link HookScope}
 * intent into targets through `src/commands/scope.ts`, the one resolver
 * `check` and `security` use. The hook must not derive a file list of its own
 * — two resolvers is how the hook and the command came to disagree about what
 * a project's source paths are.
 *
 * Resolving to `nothing` means "no opinion", and the hook treats it exactly
 * like a pass — it is the fail-open contract: an unrunnable pipeline must not
 * block the user's edit. Resolving to `failed` means the same to the session
 * (nothing is blocked) but is RECORDED, so the failure is discoverable. Do not
 * throw for either case; reserve throwing for genuine bugs, which are caught
 * one level up and recorded the same way.
 *
 * The injected implementation OWNS JOURNALING. `kragg check` appends its own
 * run to `.kragg/history.jsonl`; if this module appended too, every hook
 * invocation would double-count. SessionStart reads that journal, so the two
 * halves meet through the file, not through a call.
 */
export type RunCheck = (request: HookCheckRequest) => Promise<HookCheckOutcome>;

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
  /** Where a diagnostic line goes. Defaults to stderr. Injected by tests. */
  readonly emitError?: ((line: string) => void) | undefined;
}

/**
 * The marker that stops a hook re-entering itself through its own subprocess.
 *
 * `stop_hook_active` is the harness's guard against a Stop loop, and it covers
 * the case the harness can see. It cannot see this one: the check pipeline
 * spawns the project's own tools (a linter, a compiler, a test runner) with
 * the environment inherited, and a project whose test command or wrapper
 * script invokes `kragg hook claude` would re-enter this module inside the run
 * it is already inside — a real, unbounded recursion in which each level
 * spawns another full pipeline. The variable is set for the duration of the
 * dispatch, so every descendant process sees it and steps aside.
 */
export const HOOK_ACTIVE_ENV = "KRAGG_HOOK_ACTIVE";

/**
 * Handle one Claude Code hook invocation. NEVER THROWS, ALWAYS RETURNS 0.
 *
 * The `catch` is not defensive padding — it is the fail-open contract stated
 * in the module docstring, and it is exercised by tests. Adding a rethrow or a
 * non-zero return would break it in different ways. What the catch may NOT do
 * any more is stay quiet: it records the failure (stderr plus
 * `.kragg/hook-errors.jsonl`) before returning 0, because a guardrail that
 * stopped working and said nothing is the failure this hook exists to prevent,
 * committed by the hook itself.
 */
export async function runClaudeHook(options: ClaudeHookOptions): Promise<number> {
  const emitError = options.emitError ?? writeStderr;
  const input = parseHookInput(options.stdin);
  const event = eventLabel(input.hookEventName);
  if (process.env[HOOK_ACTIVE_ENV] === "1") {
    // See HOOK_ACTIVE_ENV. Not a failure and not recorded: the outer
    // invocation is doing the work, and this one has nothing to add.
    emitError(`kragg hook: ${event}: skipped, a kragg hook is already running`);
    return HOOK_OK;
  }
  process.env[HOOK_ACTIVE_ENV] = "1";
  try {
    return await dispatch(input, options, emitError);
  } catch (error) {
    recordHookFailure(options.root, event, error, emitError);
    return HOOK_OK;
  } finally {
    delete process.env[HOOK_ACTIVE_ENV];
  }
}

async function dispatch(
  input: HookInput,
  options: ClaudeHookOptions,
  emitError: (line: string) => void,
): Promise<number> {
  const emit = options.emit ?? writeStdout;
  if (input.hookEventName === "Stop") {
    return await handleStop(input, options, emit, emitError);
  }
  if (input.hookEventName === "SessionStart") {
    emitSessionContext(options.root, options.ensureCriticality, emit, emitError);
    return HOOK_OK;
  }
  // Everything else is treated as a post-edit event, matching the Python
  // original. An unknown or absent event name therefore costs at most one
  // incremental check on the changed files, never a crash — and a payload
  // with no editable file (the common case for an unknown event) short-
  // circuits to a no-op inside `editScope`.
  return await handlePostEdit(input, options, emit, emitError);
}

/**
 * PostToolUse: check what was just edited, and say so if it is broken.
 *
 * Scoped to a single file when the tool reported one, so the common Edit or
 * Write case costs one incremental pass rather than a full run — the same
 * scope, through the same resolver, as `kragg check --file <path>`. A tool
 * that edited no single file (Bash, MultiEdit across a set) asks for the
 * change-set scope instead, which is `kragg check --changed`.
 *
 * PARITY WITH THE COMMAND IS THE POINT, including the awkward cases. A file
 * that no longer exists, or one outside the project, resolves the way the
 * command resolves it rather than through a special case here — and where the
 * command would exit 2, the hook records the failure and stays out of the way,
 * because a hook may not exit 2.
 */
async function handlePostEdit(
  input: HookInput,
  options: ClaudeHookOptions,
  emit: (line: string) => void,
  emitError: (line: string) => void,
): Promise<number> {
  const scope = editScope(input, options.root);
  if (scope === null) {
    return HOOK_OK;
  }
  return await runAndSpeak(options, scope, "kragg gates failed", emit, emitError);
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
  emitError: (line: string) => void,
): Promise<number> {
  if (input.stopHookActive) {
    return HOOK_OK;
  }
  // THE WHOLE PROJECT, exactly as `kragg check` defines it. This used to pass
  // `source_paths[0]` — one directory — so a project declaring several had the
  // rest linted by the command and not by the hook, and "done" meant green
  // over a directory nothing had looked at.
  return await runAndSpeak(
    options,
    { kind: "full" },
    "kragg check must pass before finishing",
    emit,
    emitError,
  );
}

/**
 * Run one check and turn the answer into the protocol: block, or say nothing.
 *
 * The three outcomes and what each one does are the whole delivery contract.
 * A report that failed blocks; `nothing` is silence; `failed` is silence to
 * the session and a RECORD on disk. Note what is not here: no path returns a
 * non-zero code, and no path lets a failure look like a pass.
 */
async function runAndSpeak(
  options: ClaudeHookOptions,
  scope: HookScope,
  prefix: string,
  emit: (line: string) => void,
  emitError: (line: string) => void,
): Promise<number> {
  const outcome = await options.runCheck({ root: options.root, scope });
  if (outcome.kind === "failed") {
    recordHookFailure(options.root, scopeEvent(scope), outcome.message, emitError);
    return HOOK_OK;
  }
  if (outcome.kind === "nothing" || reportPassed(outcome.report)) {
    return HOOK_OK;
  }
  emit(blockPayload(`${prefix}:\n${renderText(outcome.report)}`));
  return HOOK_OK;
}

/** Which event a scope belongs to, for the failure record. */
function scopeEvent(scope: HookScope): string {
  return scope.kind === "full" ? "Stop" : "PostToolUse";
}

/**
 * Which scope this post-edit invocation asks for, or `null` for "nothing to
 * do".
 *
 * `null` is the path a Markdown edit or a `.d.ts` takes, and it is why the
 * hook is cheap enough to run on every tool use: no policy is loaded, no git
 * is consulted, no pipeline is assembled. It is deliberately the ONLY decision
 * about scope this module makes — "is this an editable source file at all" is
 * a property of the payload, not of the project.
 */
function editScope(input: HookInput, root: string): HookScope | null {
  if (input.filePath === null) {
    return { kind: "changed" };
  }
  return isCheckableSource(input.filePath)
    ? { kind: "file", file: relativeToRoot(input.filePath, root) }
    : null;
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

function writeStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Diagnostics channel. Safe at exit 0, which is the only code this hook uses:
 * Claude Code turns stderr into a `hook error` notice for a NON-ZERO exit and
 * into debug output otherwise, so this is visible to whoever goes looking and
 * to nobody who does not.
 */
function writeStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}
