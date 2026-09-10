/**
 * Tests for the Claude Code hook adapter.
 *
 * Two properties matter more than anything else here, and a manual smoke test
 * cannot tell either of them apart from working code:
 *
 *  1. THE HOOK FAILS OPEN. Malformed stdin, an unreadable policy, a check
 *     pipeline that throws — every one must return exit 0 and leave the
 *     editing session alone. A hook that wedges the harness is worse than no
 *     hook.
 *  2. THE HOOK IS NOT SILENTLY ADVISORY. A failing check must produce a
 *     `{"decision":"block"}` payload on stdout, because that — not a non-zero
 *     exit code — is what reaches the model. Every block-path assertion checks
 *     BOTH the exit code AND the payload, since either alone would also pass
 *     for a hook that does nothing at all.
 *
 * The check pipeline is faked in every test; nothing here shells out.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { cmdHook } from "../src/commands/hook.ts";
import { hookCheck } from "../src/commands/hookCheck.ts";
import { gateResult } from "../src/engine/models.ts";
import { buildReport, EXIT_USAGE, utcNow, type CheckReport } from "../src/engine/report.ts";
import {
  HOOK_ACTIVE_ENV,
  HOOK_OK,
  isCheckableSource,
  runClaudeHook,
  type HookCheckOutcome,
  type HookCheckRequest,
} from "../src/hooks/claude.ts";
import { HOOK_ERROR_FILE, recordHookFailure } from "../src/hooks/diagnostics.ts";
import { MAX_PAYLOAD_CHARS, parseHookInput } from "../src/hooks/protocol.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A throwaway project root. `files` maps a relative path to its contents. */
function project(files: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-hooks-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

/** A canned report. `count` violations, each distinct so nothing dedupes. */
function report(passed: boolean, count = 1): CheckReport {
  const violations = passed
    ? []
    : Array.from({ length: count }, (_unused, i) => ({
        message: `Type error number ${i} with a fairly long explanatory message`,
        file: `src/file${i}.ts`,
        line: i + 1,
      }));
  return buildReport({
    command: "check",
    mode: "changed",
    targets: ["src/a.ts"],
    results: [
      gateResult({ name: "tsc", passed, violations, violationCount: violations.length }),
    ],
    maxViolations: Math.max(count, 25),
    startedAt: utcNow(),
    gitSha: null,
  });
}

/** A canned verdict from the check seam. */
function verdict(passed: boolean, count = 1): HookCheckOutcome {
  return { kind: "report", report: report(passed, count) };
}

/** The seam's "no opinion" answer — nothing in scope, nothing to say. */
const NOTHING: HookCheckOutcome = { kind: "nothing" };

/** Records what the hook asked for, and answers with a canned verdict. */
function spyCheck(result: HookCheckOutcome): {
  run: (request: HookCheckRequest) => Promise<HookCheckOutcome>;
  calls: HookCheckRequest[];
} {
  const calls: HookCheckRequest[] = [];
  return {
    calls,
    run: (request) => {
      calls.push(request);
      return Promise.resolve(result);
    },
  };
}

/** Every failure record the hook wrote under a root, oldest first. */
function records(root: string): Readonly<Record<string, unknown>>[] {
  const path = join(root, ".kragg", HOOK_ERROR_FILE);
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => table(JSON.parse(line)));
}

/**
 * Drive the hook with one payload and collect everything it emitted.
 *
 * `ensureCriticality` defaults to a no-op that RECORDS its calls: nothing here
 * may build a `ts.Program`, and several tests assert on when it was invoked.
 * `errors` collects the diagnostics channel, which is a real stderr write in
 * production and must never be conflated with the payload on stdout.
 */
async function invoke(
  root: string,
  stdin: string,
  check: (request: HookCheckRequest) => Promise<HookCheckOutcome>,
  ensureCriticality: (derivedRoot: string) => void = () => undefined,
): Promise<{ code: number; emitted: string[]; errors: string[] }> {
  const emitted: string[] = [];
  const errors: string[] = [];
  const code = await runClaudeHook({
    root,
    stdin,
    runCheck: check,
    ensureCriticality,
    emit: (line) => emitted.push(line),
    emitError: (line) => errors.push(line),
  });
  return { code, emitted, errors };
}

function isTable(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow an emitted value to a JSON object, failing the test if it is not. */
function table(value: unknown): Readonly<Record<string, unknown>> {
  if (!isTable(value)) {
    assert.fail(`expected a JSON object, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Parse one emitted stdout line as the JSON payload the harness would read. */
function payload(line: string | undefined): Readonly<Record<string, unknown>> {
  assert.ok(line !== undefined, "expected a payload on stdout");
  return table(JSON.parse(line));
}

function postToolUse(filePath: string): string {
  return JSON.stringify({
    session_id: "abc123", transcript_path: "/tmp/t.jsonl", cwd: "/repo",
    permission_mode: "default", hook_event_name: "PostToolUse",
    tool_name: "Edit", tool_use_id: "toolu_01",
    tool_input: { file_path: filePath, old_string: "a", new_string: "b" },
    tool_response: { filePath, success: true },
  });
}

describe("protocol parsing", () => {
  it("narrows a full PostToolUse payload and ignores unknown fields", () => {
    const input = parseHookInput(postToolUse("/repo/src/a.ts"));
    assert.equal(input.hookEventName, "PostToolUse");
    assert.equal(input.toolName, "Edit");
    assert.equal(input.filePath, "/repo/src/a.ts");
    assert.equal(input.stopHookActive, false);
  });

  it("survives a protocol addition it has never seen", () => {
    const input = parseHookInput(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_input: { file_path: "src/a.ts" },
        some_future_field: { nested: [1, 2, 3] },
        effort: { level: "max" },
      }),
    );
    assert.equal(input.filePath, "src/a.ts");
  });

  it("degrades non-object and malformed JSON to an empty payload", () => {
    for (const text of ["", "{oops", "null", "[1,2]", '"a string"', "7"]) {
      const input = parseHookInput(text);
      assert.equal(input.hookEventName, "", `for input ${JSON.stringify(text)}`);
      assert.equal(input.filePath, null);
      assert.equal(input.stopHookActive, false);
    }
  });

  it("reads stop_hook_active strictly, never truthily", () => {
    assert.equal(parseHookInput('{"stop_hook_active":true}').stopHookActive, true);
    assert.equal(parseHookInput('{"stop_hook_active":"false"}').stopHookActive, false);
    assert.equal(parseHookInput('{"stop_hook_active":1}').stopHookActive, false);
    assert.equal(parseHookInput("{}").stopHookActive, false);
  });

  it("ignores a tool_input that is not an object, or has no file_path", () => {
    assert.equal(parseHookInput('{"tool_input":"src/a.ts"}').filePath, null);
    assert.equal(parseHookInput('{"tool_input":{"command":"ls"}}').filePath, null);
    assert.equal(parseHookInput('{"tool_input":{"file_path":42}}').filePath, null);
    assert.equal(parseHookInput('{"tool_input":{"file_path":""}}').filePath, null);
  });
});

describe("source-file filter", () => {
  it("accepts every extension the changed-files scanner accepts", () => {
    const names = ["a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.jsx", "a.mjs", "a.cjs"];
    for (const name of names) assert.equal(isCheckableSource(`src/${name}`), true, name);
  });

  it("rejects non-source and ambient declaration files", () => {
    const names = ["README.md", "kragg.json", "a.py", "a.d.ts", "a.d.mts", "a.d.cts"];
    for (const name of names) assert.equal(isCheckableSource(`src/${name}`), false, name);
  });
});

describe("PostToolUse", () => {
  it("blocks with a decision payload when gates fail", async () => {
    const root = project();
    const check = spyCheck(verdict(false));
    const { code, emitted } = await invoke(root, postToolUse("src/a.ts"), check.run);

    assert.equal(code, HOOK_OK, "a failing check must still exit 0");
    const body = payload(emitted[0]);
    assert.equal(body["decision"], "block", "exit 1 would be advisory; the payload is not");
    assert.match(String(body["reason"]), /kragg gates failed/);
    assert.match(String(body["reason"]), /Type error/);
    assert.deepEqual(check.calls, [
      { root, scope: { kind: "file", file: "src/a.ts" } },
    ]);
  });

  it("stays silent when gates pass", async () => {
    const root = project();
    const check = spyCheck(verdict(true));
    const { code, emitted } = await invoke(root, postToolUse("src/a.ts"), check.run);
    assert.equal(code, HOOK_OK);
    assert.deepEqual(emitted, []);
    assert.equal(check.calls.length, 1);
  });

  it("does not run the pipeline for a non-source edit", async () => {
    const root = project();
    for (const file of ["README.md", "src/a.d.ts", "package.json"]) {
      const check = spyCheck(verdict(false));
      const { code, emitted } = await invoke(root, postToolUse(file), check.run);
      assert.equal(code, HOOK_OK);
      assert.deepEqual(emitted, [], file);
      assert.deepEqual(check.calls, [], `${file} must not trigger a check`);
    }
  });

  it("rewrites an absolute harness path to a repo-relative target", async () => {
    const root = project();
    const check = spyCheck(verdict(true));
    await invoke(root, postToolUse(join(root, "src", "deep", "a.ts")), check.run);
    assert.deepEqual(check.calls[0]?.scope, { kind: "file", file: "src/deep/a.ts" });
  });

  it("leaves a path outside the root alone rather than emitting a traversal", async () => {
    const root = project();
    const check = spyCheck(verdict(true));
    await invoke(root, postToolUse("/elsewhere/other.ts"), check.run);
    assert.deepEqual(check.calls[0]?.scope, { kind: "file", file: "/elsewhere/other.ts" });
  });

  it("asks for the change set when the tool edited no single file", async () => {
    // The `--changed` scope, resolved by the same resolver `kragg check
    // --changed` uses — including the promotion rules the hook must not
    // reimplement. A `Bash` tool call is the ordinary way here.
    const root = project();
    const check = spyCheck(verdict(true));
    await invoke(
      root,
      JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "rm src/gone.ts" },
      }),
      check.run,
    );
    assert.deepEqual(check.calls, [{ root, scope: { kind: "changed" } }]);
  });

  it("treats an unknown event name as a post-edit and never crashes", async () => {
    const root = project();
    const check = spyCheck(NOTHING);
    const { code, emitted } = await invoke(
      root,
      JSON.stringify({ hook_event_name: "SomeFutureEvent", session_id: "x" }),
      check.run,
    );
    // No file in the payload, so it asks about the change set; a bare temp dir
    // is not a repository, so the answer is "nothing". Crucially it exits 0
    // instead of throwing.
    assert.equal(code, HOOK_OK);
    assert.deepEqual(emitted, []);
    assert.deepEqual(check.calls, [{ root, scope: { kind: "changed" } }]);
  });

  it("handles a payload with no fields at all", async () => {
    const root = project();
    const check = spyCheck(NOTHING);
    const { code, emitted } = await invoke(root, "{}", check.run);
    assert.equal(code, HOOK_OK);
    assert.deepEqual(emitted, []);
  });
});

describe("Stop", () => {
  const stop = (active: boolean): string =>
    JSON.stringify({
      session_id: "abc123",
      hook_event_name: "Stop",
      stop_hook_active: active,
    });

  it("blocks the stop when the full check is red", async () => {
    const root = project();
    const check = spyCheck(verdict(false));
    const { code, emitted } = await invoke(root, stop(false), check.run);

    assert.equal(code, HOOK_OK);
    const body = payload(emitted[0]);
    assert.equal(body["decision"], "block");
    assert.match(String(body["reason"]), /kragg check must pass before finishing/);
    assert.deepEqual(check.calls, [{ root, scope: { kind: "full" } }]);
  });

  it("lets the turn end when the check is green", async () => {
    const root = project();
    const check = spyCheck(verdict(true));
    const { code, emitted } = await invoke(root, stop(false), check.run);
    assert.equal(code, HOOK_OK);
    assert.deepEqual(emitted, []);
  });

  it("honours stop_hook_active and does not recurse", async () => {
    const root = project();
    const check = spyCheck(verdict(false));
    const { code, emitted } = await invoke(root, stop(true), check.run);

    assert.equal(code, HOOK_OK);
    assert.deepEqual(emitted, [], "a second block would loop the turn forever");
    assert.deepEqual(check.calls, [], "the pipeline must not even run");
  });

  it("asks for the whole project, not one directory of it", async () => {
    // THE BUG THIS CLOSES, at the protocol end: the hook used to hand the
    // pipeline `source_paths[0]`, so a project declaring several source
    // directories had the rest linted by `kragg check` and by nothing on Stop.
    // The scope is now an intent the CLI's own resolver expands — see the
    // "hook scope resolution" tests for what it expands to.
    const root = project({ "kragg.json": JSON.stringify({ source_paths: ["lib", "app"] }) });
    const check = spyCheck(verdict(true));
    await invoke(root, stop(false), check.run);
    assert.deepEqual(check.calls, [{ root, scope: { kind: "full" } }]);
  });

  it("does not re-enter itself through a subprocess of its own run", async () => {
    // `stop_hook_active` covers the loop the harness can see. This is the one
    // it cannot: the pipeline spawns the project's own tools, and a project
    // whose test command invokes `kragg hook claude` would start a fresh full
    // pipeline inside the one already running, at every level.
    const root = project();
    const inner = spyCheck(verdict(false));
    const outer: string[] = [];
    const code = await runClaudeHook({
      root,
      stdin: stop(false),
      ensureCriticality: () => undefined,
      emit: (line) => outer.push(line),
      emitError: () => undefined,
      runCheck: async (request) => {
        // What a spawned kragg process would see: the marker is set for the
        // duration of the outer dispatch, and it inherits the environment.
        assert.equal(process.env[HOOK_ACTIVE_ENV], "1", "descendants must see the marker");
        const nested = await invoke(request.root, stop(false), inner.run);
        assert.equal(nested.code, HOOK_OK);
        assert.deepEqual(nested.emitted, [], "the nested invocation must do nothing");
        assert.deepEqual(inner.calls, [], "and must not start a second pipeline");
        assert.match(String(nested.errors[0]), /already running/);
        return verdict(true);
      },
    });

    assert.equal(code, HOOK_OK);
    assert.deepEqual(outer, []);
    assert.equal(process.env[HOOK_ACTIVE_ENV], undefined, "the marker is cleared afterwards");
  });
});

describe("SessionStart", () => {
  const sessionStart = JSON.stringify({
    session_id: "abc123",
    hook_event_name: "SessionStart",
    source: "startup",
  });

  const journalLine = JSON.stringify({
    schema_version: 1,
    ts: "2026-08-06T10:00:00+00:00",
    command: "check",
    mode: "full",
    git_sha: "abc1234",
    git_dirty: false,
    passed: false,
    exit_code: 1,
    duration_ms: 4200,
    gates: [
      { name: "tsc", passed: false, skipped: false, duration_ms: 4200, violation_count: 3 },
    ],
  });

  const entry = (name: string, isCritical: boolean): Record<string, unknown> =>
    ({ name, fan_in: 6, fan_out: 1, betweenness: 0.2, is_critical: isCritical, risk: "HIGH" });
  const criticality = JSON.stringify([
    entry("src/engine/gate#runGates", true),
    entry("src/util/pad#pad", false),
    entry("src/policy/policy#loadPolicy", true),
  ]);

  it("injects run status and critical functions as context", async () => {
    const root = project({
      ".kragg/history.jsonl": `${journalLine}\n`,
      ".kragg/criticality.json": criticality,
    });
    const check = spyCheck(verdict(false));
    const { code, emitted } = await invoke(root, sessionStart, check.run);

    assert.equal(code, HOOK_OK);
    assert.deepEqual(check.calls, [], "SessionStart must never run gates");
    const fields = table(payload(emitted[0])["hookSpecificOutput"]);
    assert.equal(fields["hookEventName"], "SessionStart");
    const context = String(fields["additionalContext"]);
    assert.match(context, /last run: FAIL/);
    assert.match(context, /critical functions/);
    assert.match(context, /src\/engine\/gate#runGates/);
    assert.match(context, /src\/policy\/policy#loadPolicy/);
    assert.doesNotMatch(context, /src\/util\/pad#pad/, "non-critical entries are noise");
  });

  it("emits nothing when there is no history and no criticality data", async () => {
    const root = project();
    const check = spyCheck(verdict(false));
    const { code, emitted } = await invoke(root, sessionStart, check.run);
    assert.equal(code, HOOK_OK);
    assert.deepEqual(emitted, []);
  });

  it("derives the inventory before reading it, so an edit does not empty it", async () => {
    // THE BUG THIS CLOSES. `readJson` refuses data the sources have outrun,
    // and last session's edits are exactly what outruns it — so a hook that
    // only read would hand the model an empty critical-function list in any
    // repo anyone had ever worked in, silently. The fake writes what a real
    // derivation would have written; what is asserted is that the hook asks
    // BEFORE it reads, and asks about the right root.
    const root = project({ ".kragg/history.jsonl": `${journalLine}\n` });
    const derived: string[] = [];
    const { code, emitted } = await invoke(root, sessionStart, spyCheck(NOTHING).run, (target) => {
      derived.push(target);
      mkdirSync(join(target, ".kragg"), { recursive: true });
      writeFileSync(join(target, ".kragg/criticality.json"), criticality);
    });

    assert.equal(code, HOOK_OK);
    assert.deepEqual(derived, [root]);
    const fields = table(payload(emitted[0])["hookSpecificOutput"]);
    assert.match(String(fields["additionalContext"]), /src\/engine\/gate#runGates/);
  });

  it("keeps the rest of the context when the derivation throws", async () => {
    // FAIL-OPEN, NARROWLY. `runClaudeHook` would swallow this throw anyway,
    // but it would swallow the run-status lines with it — dropping facts
    // already on disk because a derivation nobody asked for broke. The catch
    // sits at the derivation so the cost is exactly the criticality section.
    const root = project({ ".kragg/history.jsonl": `${journalLine}\n` });
    const { code, emitted } = await invoke(root, sessionStart, spyCheck(NOTHING).run, () => {
      throw new Error("tsconfig is unusable");
    });

    assert.equal(code, HOOK_OK);
    const context = String(table(payload(emitted[0])["hookSpecificOutput"])["additionalContext"]);
    assert.match(context, /last run: FAIL/);
    assert.doesNotMatch(context, /critical functions/);
    assert.deepEqual(
      records(root).map((entry) => [entry["event"], entry["error"]]),
      [["SessionStart", "tsconfig is unusable"]],
      "a section that quietly stopped appearing is exactly what the record is for",
    );
  });

  it("ignores a corrupt criticality file instead of failing the session", async () => {
    const root = project({
      ".kragg/history.jsonl": `${journalLine}\n`,
      ".kragg/criticality.json": "{not json",
    });
    const { code, emitted } = await invoke(root, sessionStart, spyCheck(NOTHING).run);
    assert.equal(code, HOOK_OK);
    const fields = table(payload(emitted[0])["hookSpecificOutput"]);
    assert.doesNotMatch(String(fields["additionalContext"]), /critical functions/);
  });
});

describe("fail open", () => {
  it("swallows malformed stdin", async () => {
    // A payload that told us nothing narrows to the empty input, which
    // dispatches as a post-edit with no file — the change-set scope, which in
    // a tree with no change set answers `nothing`. No crash, no stack trace on
    // stdout, no record: an unreadable payload is not an internal failure.
    const root = project();
    const check = spyCheck(NOTHING);
    for (const stdin of ["", "{oops", "null", "[]", "not json at all", '"a string"', "7"]) {
      const { code, emitted, errors } = await invoke(root, stdin, check.run);
      assert.equal(code, HOOK_OK, `for stdin ${JSON.stringify(stdin)}`);
      assert.deepEqual(emitted, []);
      assert.deepEqual(errors, []);
    }
    assert.deepEqual(records(root), []);
    assert.deepEqual(
      check.calls.map((call) => call.scope),
      check.calls.map(() => ({ kind: "changed" })),
      "and never a scope invented out of a payload that said nothing",
    );
  });

  it("survives a payload far larger than any real one", async () => {
    const root = project();
    const check = spyCheck(NOTHING);
    const huge = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "src/a.ts", old_string: "x".repeat(5_000_000) },
    });
    const { code, emitted } = await invoke(root, huge, check.run);
    assert.equal(code, HOOK_OK);
    assert.deepEqual(emitted, []);
    assert.deepEqual(check.calls[0]?.scope, { kind: "file", file: "src/a.ts" });
  });

  it("swallows a check pipeline that throws — and records it", async () => {
    const root = project();
    const { code, emitted, errors } = await invoke(root, postToolUse("src/a.ts"), () => {
      throw new Error("tsc exploded");
    });
    assert.equal(code, HOOK_OK, "a crashing gate must not wedge the editor");
    assert.deepEqual(emitted, [], "and must not put anything on stdout");
    assert.match(String(errors[0]), /kragg hook: PostToolUse: tsc exploded/);
    assert.deepEqual(
      records(root).map((entry) => [entry["event"], entry["error"]]),
      [["PostToolUse", "tsc exploded"]],
    );
  });

  it("swallows a check pipeline that rejects", async () => {
    const root = project();
    const { code } = await invoke(root, postToolUse("src/a.ts"), () =>
      Promise.reject(new Error("boom")),
    );
    assert.equal(code, HOOK_OK);
    assert.deepEqual(records(root).map((entry) => entry["error"]), ["boom"]);
  });

  it("treats an empty selection as a pass, and records nothing", async () => {
    const root = project();
    const { code, emitted, errors } = await invoke(
      root,
      postToolUse("src/a.ts"),
      spyCheck(NOTHING).run,
    );
    assert.equal(code, HOOK_OK);
    assert.deepEqual(emitted, []);
    assert.deepEqual(errors, [], "nothing to check is not a failure");
    assert.deepEqual(records(root), []);
  });

  it("records a pipeline that could not run, instead of calling it a pass", async () => {
    // THE OTHER HALF OF THE SILENCE. The seam used to answer `null` for both
    // "nothing to check" and "could not run at all", and both read as a pass.
    const root = project();
    const { code, emitted, errors } = await invoke(root, postToolUse("src/a.ts"), () =>
      Promise.resolve({ kind: "failed", message: "kragg.json#layers must be a list" }),
    );
    assert.equal(code, HOOK_OK, "a broken pipeline still must not block the edit");
    assert.deepEqual(emitted, []);
    assert.match(String(errors[0]), /kragg.json#layers must be a list/);
    assert.deepEqual(records(root).map((entry) => entry["event"]), ["PostToolUse"]);
  });

  it("swallows an unreadable policy rather than blocking the stop", async () => {
    // The policy is now loaded by the injected implementation, so the throw
    // arrives as a `failed` outcome rather than out of this module — and is
    // recorded either way. `kragg.json` being unreadable is the single most
    // likely reason a hook silently stops working.
    const root = project({ "kragg.json": "{ this is not json" });
    const { code, emitted, errors } = await invoke(
      root,
      JSON.stringify({ hook_event_name: "Stop" }),
      hookCheck,
    );
    assert.equal(code, HOOK_OK);
    assert.deepEqual(emitted, []);
    assert.match(String(errors[0]), /kragg hook: Stop: /);
    assert.deepEqual(records(root).map((entry) => entry["event"]), ["Stop"]);
  });

  it("never writes the stdin payload into the record", async () => {
    // A `tool_input` is the tool's own arguments: for `Bash` that is a command
    // line, which routinely carries credentials. A failure record explains a
    // failure; it is not a place to copy the payload to.
    const root = project();
    const stdin = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      transcript_path: "/Users/someone/.claude/projects/x/transcript.jsonl",
      tool_input: { command: "curl -H 'authorization: Bearer sk-live-SECRET' https://x" },
    });
    await invoke(root, stdin, () => {
      throw new Error("pipeline failed");
    });
    const text = readFileSync(join(root, ".kragg", HOOK_ERROR_FILE), "utf8");
    assert.doesNotMatch(text, /sk-live-SECRET|transcript|curl/);
    assert.match(text, /"event":"PostToolUse"/);
  });

  it("records an unknown event under a fixed label, never the payload's own", async () => {
    const root = project();
    await invoke(root, JSON.stringify({ hook_event_name: "A".repeat(4000) }), () => {
      throw new Error("boom");
    });
    assert.deepEqual(records(root).map((entry) => entry["event"]), ["other"]);
  });

  it("never returns a non-zero code on any recorded payload", async () => {
    const root = project({ ".kragg/criticality.json": "[]" });
    const payloads = [
      postToolUse("src/a.ts"),
      postToolUse("README.md"),
      JSON.stringify({ hook_event_name: "Stop", stop_hook_active: true }),
      JSON.stringify({ hook_event_name: "Stop" }),
      JSON.stringify({ hook_event_name: "SessionStart", source: "compact" }),
      JSON.stringify({ hook_event_name: "SubagentStop" }),
      "{}",
      "garbage",
    ];
    for (const stdin of payloads) {
      const { code } = await invoke(root, stdin, spyCheck(verdict(false)).run);
      assert.equal(code, HOOK_OK, `payload ${stdin.slice(0, 40)} returned ${code}`);
    }
  });
});

describe("failures reach the next session", () => {
  const sessionStart = JSON.stringify({ hook_event_name: "SessionStart", source: "startup" });

  /** Fail one PostToolUse invocation, the way a broken pipeline would. */
  async function fail(root: string, message: string): Promise<void> {
    await invoke(root, postToolUse("src/a.ts"), () => {
      throw new Error(message);
    });
  }

  it("reports how many failures were recorded since the last session", async () => {
    const root = project();
    await fail(root, "tsc exploded");
    await fail(root, "kragg.json is unreadable");

    const { code, emitted } = await invoke(root, sessionStart, spyCheck(NOTHING).run);
    assert.equal(code, HOOK_OK);
    const context = String(table(payload(emitted[0])["hookSpecificOutput"])["additionalContext"]);
    assert.match(context, /2 kragg hook failures recorded since the last session/);
    assert.match(context, /kragg\.json is unreadable/, "the latest one, so it is actionable");
    assert.match(context, /hook-errors\.jsonl/, "and where the rest are");
  });

  it("does not report the same failures to the next session again", async () => {
    const root = project();
    await fail(root, "tsc exploded");
    await invoke(root, sessionStart, spyCheck(NOTHING).run);

    const second = await invoke(root, sessionStart, spyCheck(NOTHING).run);
    assert.equal(second.code, HOOK_OK);
    assert.deepEqual(second.emitted, [], "nothing new, and nothing else to say");
    await fail(root, "and again");
    const third = await invoke(root, sessionStart, spyCheck(NOTHING).run);
    const context = String(
      table(payload(third.emitted[0])["hookSpecificOutput"])["additionalContext"],
    );
    assert.match(context, /1 kragg hook failure recorded since the last session/);
    assert.match(context, /and again/);
  });

  it("says nothing when nothing failed", async () => {
    const root = project({ ".kragg/criticality.json": "[]" });
    const { emitted } = await invoke(root, sessionStart, spyCheck(NOTHING).run);
    assert.deepEqual(emitted, [], "a clean session pays nothing for this");
  });
});

describe("payload size", () => {
  it("truncates an enormous reason so the harness does not spill it to a file", async () => {
    const huge = spyCheck(verdict(false, 400));
    const { emitted } = await invoke(project(), postToolUse("src/a.ts"), huge.run);
    const body = payload(emitted[0]);
    const reason = String(body["reason"]);
    assert.ok(reason.length <= MAX_PAYLOAD_CHARS + 100, `reason was ${reason.length} chars`);
    assert.match(reason, /truncated/);
    // TRUNCATION IS OF THE TEXT, NEVER OF THE ENVELOPE. A cap applied to the
    // serialized payload would cut the JSON mid-string, and a decision the
    // harness cannot parse is a decision that never happened.
    assert.equal(body["decision"], "block");
    assert.equal(emitted.length, 1, "and it is still a single line");
  });

  it("truncates a Stop reason on the same terms", async () => {
    const { emitted } = await invoke(
      project(),
      JSON.stringify({ hook_event_name: "Stop" }),
      spyCheck(verdict(false, 400)).run,
    );
    const body = payload(emitted[0]);
    assert.equal(body["decision"], "block");
    assert.match(String(body["reason"]), /truncated/);
    assert.ok(String(body["reason"]).length <= MAX_PAYLOAD_CHARS + 100);
  });

  it("truncates the SessionStart context too, keeping the envelope intact", async () => {
    // The other emitting path. An unbounded `additionalContext` is spilled by
    // the harness exactly as an unbounded reason is, and a session that starts
    // by losing its context is the failure this cap exists to prevent.
    const long = (index: number): Record<string, unknown> => ({
      name: `src/deep/module${index}#${"veryLongCriticalFunctionName".repeat(80)}`,
      fan_in: 9,
      fan_out: 2,
      betweenness: 0.4,
      is_critical: true,
      risk: "HIGH",
    });
    const root = project({
      ".kragg/criticality.json": JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7].map(long)),
    });
    const { emitted } = await invoke(
      root,
      JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }),
      spyCheck(NOTHING).run,
    );
    const fields = table(payload(emitted[0])["hookSpecificOutput"]);
    const context = String(fields["additionalContext"]);
    assert.ok(context.length <= MAX_PAYLOAD_CHARS + 100, `context was ${context.length} chars`);
    assert.match(context, /truncated/);
    assert.equal(fields["hookEventName"], "SessionStart", "the envelope survives the cut");
  });
});

describe("hook scope resolution", () => {
  // These drive the REAL `hookCheck`, because the point of the change is that
  // the hook and `kragg check` resolve a scope through one resolver. Every
  // gate that would spawn anything is switched off in the policy, so what is
  // exercised is the scope, not a toolchain.
  const policy = JSON.stringify({
    source_paths: ["src", "lib"],
    test_paths: ["test"],
    lint_tool: "off",
    secret_scanner: "off",
    test_runner: "off",
  });

  it("checks every source path on a full run, not just the first", async () => {
    // THE BUG. `targets` is what the per-file external tools are invoked on,
    // so `["src"]` in a project that declares `["src", "lib"]` is a linter
    // that never opens `lib` — and a Stop hook that lets the turn end green
    // over it.
    const root = project({
      "kragg.json": policy,
      "src/a.ts": "export const a = 1;\n",
      "lib/b.ts": "export const b = 2;\n",
    });
    const outcome = await hookCheck({ root, scope: { kind: "full" } });
    assert.equal(outcome.kind, "report");
    assert.deepEqual(outcome.kind === "report" ? outcome.report.targets : [], ["src", "lib"]);
  });

  it("narrows to the edited file, exactly as `check --file` does", async () => {
    const root = project({
      "kragg.json": policy,
      "src/a.ts": "export const a = 1;\n",
      "lib/b.ts": "export const b = 2;\n",
    });
    const outcome = await hookCheck({ root, scope: { kind: "file", file: "lib/b.ts" } });
    assert.equal(outcome.kind, "report");
    assert.deepEqual(outcome.kind === "report" ? outcome.report.targets : [], ["lib/b.ts"]);
  });

  it("reports an edited file that is no longer there, instead of passing", async () => {
    // `check --file <missing>` is exit 2 (TOR-1365). A hook cannot exit 2, so
    // the equivalent is a recorded failure — never a run over a selection that
    // matches nothing, which prints `[PASS]` over zero files.
    const root = project({ "kragg.json": policy, "src/a.ts": "export const a = 1;\n" });
    const outcome = await hookCheck({ root, scope: { kind: "file", file: "src/gone.ts" } });
    assert.equal(outcome.kind, "failed");
    assert.match(
      outcome.kind === "failed" ? outcome.message : "",
      /src\/gone\.ts: no such file or directory/,
    );
  });

  it("says nothing, rather than failing, when git cannot answer", async () => {
    // Outside a repository there is no change set either way. `kragg check
    // --changed` reports that loudly because someone asked for it; a hook fires
    // on every tool call, and one record per call would bury the real ones.
    const root = project({ "kragg.json": policy, "src/a.ts": "export const a = 1;\n" });
    assert.deepEqual(await hookCheck({ root, scope: { kind: "changed" } }), { kind: "nothing" });
  });

  it("degrades an unusable policy to a failure, never to a pass", async () => {
    const root = project({ "kragg.json": "{ this is not json" });
    const outcome = await hookCheck({ root, scope: { kind: "full" } });
    assert.equal(outcome.kind, "failed");
  });
});

describe("recordHookFailure", () => {
  it("writes a timestamped record and a diagnostic line", () => {
    const root = project();
    const errors: string[] = [];
    recordHookFailure(root, "Stop", new Error("tsc exploded"), (line) => errors.push(line));

    assert.deepEqual(errors, ["kragg hook: Stop: tsc exploded"]);
    const entry = records(root)[0] ?? {};
    assert.equal(entry["event"], "Stop");
    assert.equal(entry["error"], "tsc exploded");
    assert.match(String(entry["ts"]), /^\d{4}-\d{2}-\d{2}T/u, "a timestamp, so it can be aged");
  });

  it("still records when the diagnostic sink itself throws", () => {
    // The cheapest channel is attempted first, but it is somebody else's
    // function: a sink that throws must not become the failure, and must not
    // cost the durable record either.
    const root = project();
    recordHookFailure(root, "Stop", new Error("boom"), () => {
      throw new Error("stderr is closed");
    });
    assert.deepEqual(records(root).map((entry) => entry["error"]), ["boom"]);
  });

  it("takes anything that can be thrown, and always says something", () => {
    const root = project();
    recordHookFailure(root, "PostToolUse", "a bare string", () => undefined);
    recordHookFailure(root, "PostToolUse", new Error(""), () => undefined);
    recordHookFailure(root, "PostToolUse", { toString: () => "an object" }, () => undefined);
    assert.deepEqual(
      records(root).map((entry) => entry["error"]),
      ["a bare string", "no message", "an object"],
    );
  });

  it("flattens and caps a message so one record cannot fill the file", () => {
    const root = project();
    recordHookFailure(root, "Stop", new Error(`x\n${"y".repeat(5000)}`), () => undefined);
    const message = String(records(root)[0]?.["error"]);
    assert.ok(message.length < 500, `message was ${message.length} chars`);
    assert.doesNotMatch(message, /\n/u, "one record is one line");
    assert.match(message, /truncated/);
  });

  it("never fails the hook when the record cannot be written", () => {
    // A read-only checkout is a legitimate state, and diagnostics that can
    // break a hook are worse than no diagnostics.
    const errors: string[] = [];
    recordHookFailure(join(project(), "a.ts"), "Stop", new Error("boom"), (line) =>
      errors.push(line),
    );
    assert.deepEqual(errors, ["kragg hook: Stop: boom"], "and the stderr line still goes out");
  });
});

describe("cmdHook", () => {
  it("reads injected stdin and dispatches to the claude adapter", async () => {
    const root = project();
    const emitted: string[] = [];
    const code = await cmdHook({
      protocol: "claude",
      root,
      runCheck: spyCheck(verdict(false)).run,
      ensureCriticality: () => undefined,
      readStdin: () => postToolUse("src/a.ts"),
      emit: (line) => emitted.push(line),
    });
    assert.equal(code, HOOK_OK);
    assert.equal(payload(emitted[0])["decision"], "block");
  });

  it("defaults to the claude protocol", async () => {
    const root = project();
    const code = await cmdHook({
      root,
      runCheck: spyCheck(verdict(true)).run,
      ensureCriticality: () => undefined,
      readStdin: () => postToolUse("src/a.ts"),
      emit: () => undefined,
    });
    assert.equal(code, HOOK_OK);
  });

  it("rejects an unknown protocol loudly, because that is a config typo", async () => {
    const errors: string[] = [];
    const check = spyCheck(verdict(false));
    const code = await cmdHook({
      protocol: "gemini",
      root: project(),
      runCheck: check.run,
      ensureCriticality: () => undefined,
      readStdin: () => postToolUse("src/a.ts"),
      emitError: (line) => errors.push(line),
    });
    assert.equal(code, EXIT_USAGE);
    assert.match(errors[0] ?? "", /unknown hook protocol 'gemini'/);
    assert.deepEqual(check.calls, []);
  });
});
