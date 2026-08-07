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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { cmdHook } from "../src/commands/hook.ts";
import { gateResult } from "../src/engine/models.ts";
import { buildReport, EXIT_USAGE, utcNow, type CheckReport } from "../src/engine/report.ts";
import {
  HOOK_OK,
  isCheckableSource,
  runClaudeHook,
  type HookCheckRequest,
} from "../src/hooks/claude.ts";
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

/** Records what the hook asked for, and answers with a canned verdict. */
function spyCheck(result: CheckReport | null): {
  run: (request: HookCheckRequest) => Promise<CheckReport | null>;
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

/**
 * Drive the hook with one payload and collect everything it emitted.
 *
 * `ensureCriticality` defaults to a no-op that RECORDS its calls: nothing here
 * may build a `ts.Program`, and several tests assert on when it was invoked.
 */
async function invoke(
  root: string,
  stdin: string,
  check: (request: HookCheckRequest) => Promise<CheckReport | null>,
  ensureCriticality: (derivedRoot: string) => void = () => undefined,
): Promise<{ code: number; emitted: string[] }> {
  const emitted: string[] = [];
  const code = await runClaudeHook({
    root,
    stdin,
    runCheck: check,
    ensureCriticality,
    emit: (line) => emitted.push(line),
  });
  return { code, emitted };
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
    const check = spyCheck(report(false));
    const { code, emitted } = await invoke(root, postToolUse("src/a.ts"), check.run);

    assert.equal(code, HOOK_OK, "a failing check must still exit 0");
    const body = payload(emitted[0]);
    assert.equal(body["decision"], "block", "exit 1 would be advisory; the payload is not");
    assert.match(String(body["reason"]), /kragg gates failed/);
    assert.match(String(body["reason"]), /Type error/);
    assert.deepEqual(check.calls, [{ root, targets: ["src/a.ts"], incremental: true }]);
  });

  it("stays silent when gates pass", async () => {
    const root = project();
    const check = spyCheck(report(true));
    const { code, emitted } = await invoke(root, postToolUse("src/a.ts"), check.run);
    assert.equal(code, HOOK_OK);
    assert.deepEqual(emitted, []);
    assert.equal(check.calls.length, 1);
  });

  it("does not run the pipeline for a non-source edit", async () => {
    const root = project();
    for (const file of ["README.md", "src/a.d.ts", "package.json"]) {
      const check = spyCheck(report(false));
      const { code, emitted } = await invoke(root, postToolUse(file), check.run);
      assert.equal(code, HOOK_OK);
      assert.deepEqual(emitted, [], file);
      assert.deepEqual(check.calls, [], `${file} must not trigger a check`);
    }
  });

  it("rewrites an absolute harness path to a repo-relative target", async () => {
    const root = project();
    const check = spyCheck(report(true));
    await invoke(root, postToolUse(join(root, "src", "deep", "a.ts")), check.run);
    assert.deepEqual(check.calls[0]?.targets, ["src/deep/a.ts"]);
  });

  it("leaves a path outside the root alone rather than emitting a traversal", async () => {
    const root = project();
    const check = spyCheck(report(true));
    await invoke(root, postToolUse("/elsewhere/other.ts"), check.run);
    assert.deepEqual(check.calls[0]?.targets, ["/elsewhere/other.ts"]);
  });

  it("treats an unknown event name as a post-edit and never crashes", async () => {
    const root = project();
    const check = spyCheck(report(false));
    const { code, emitted } = await invoke(
      root,
      JSON.stringify({ hook_event_name: "SomeFutureEvent", session_id: "x" }),
      check.run,
    );
    // No file in the payload and no git history in a bare temp dir, so there
    // is nothing to check — but crucially it exits 0 instead of throwing.
    assert.equal(code, HOOK_OK);
    assert.deepEqual(emitted, []);
  });

  it("handles a payload with no fields at all", async () => {
    const root = project();
    const check = spyCheck(report(false));
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
    const check = spyCheck(report(false));
    const { code, emitted } = await invoke(root, stop(false), check.run);

    assert.equal(code, HOOK_OK);
    const body = payload(emitted[0]);
    assert.equal(body["decision"], "block");
    assert.match(String(body["reason"]), /kragg check must pass before finishing/);
    assert.deepEqual(check.calls, [{ root, targets: ["src"], incremental: false }]);
  });

  it("lets the turn end when the check is green", async () => {
    const root = project();
    const check = spyCheck(report(true));
    const { code, emitted } = await invoke(root, stop(false), check.run);
    assert.equal(code, HOOK_OK);
    assert.deepEqual(emitted, []);
  });

  it("honours stop_hook_active and does not recurse", async () => {
    const root = project();
    const check = spyCheck(report(false));
    const { code, emitted } = await invoke(root, stop(true), check.run);

    assert.equal(code, HOOK_OK);
    assert.deepEqual(emitted, [], "a second block would loop the turn forever");
    assert.deepEqual(check.calls, [], "the pipeline must not even run");
  });

  it("uses the configured source path as the full-check target", async () => {
    const root = project({ "kragg.json": JSON.stringify({ source_paths: ["lib", "app"] }) });
    const check = spyCheck(report(true));
    await invoke(root, stop(false), check.run);
    assert.deepEqual(check.calls[0]?.targets, ["lib"]);
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
    const check = spyCheck(report(false));
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
    const check = spyCheck(report(false));
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
    const { code, emitted } = await invoke(root, sessionStart, spyCheck(null).run, (target) => {
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
    const { code, emitted } = await invoke(root, sessionStart, spyCheck(null).run, () => {
      throw new Error("tsconfig is unusable");
    });

    assert.equal(code, HOOK_OK);
    const context = String(table(payload(emitted[0])["hookSpecificOutput"])["additionalContext"]);
    assert.match(context, /last run: FAIL/);
    assert.doesNotMatch(context, /critical functions/);
  });

  it("ignores a corrupt criticality file instead of failing the session", async () => {
    const root = project({
      ".kragg/history.jsonl": `${journalLine}\n`,
      ".kragg/criticality.json": "{not json",
    });
    const { code, emitted } = await invoke(root, sessionStart, spyCheck(null).run);
    assert.equal(code, HOOK_OK);
    const fields = table(payload(emitted[0])["hookSpecificOutput"]);
    assert.doesNotMatch(String(fields["additionalContext"]), /critical functions/);
  });
});

describe("fail open", () => {
  it("swallows malformed stdin", async () => {
    const root = project();
    const check = spyCheck(report(false));
    for (const stdin of ["", "{oops", "null", "[]", "not json at all"]) {
      const { code, emitted } = await invoke(root, stdin, check.run);
      assert.equal(code, HOOK_OK, `for stdin ${JSON.stringify(stdin)}`);
      assert.deepEqual(emitted, []);
    }
  });

  it("swallows a check pipeline that throws", async () => {
    const root = project();
    const { code, emitted } = await invoke(root, postToolUse("src/a.ts"), () => {
      throw new Error("tsc exploded");
    });
    assert.equal(code, HOOK_OK, "a crashing gate must not wedge the editor");
    assert.deepEqual(emitted, []);
  });

  it("swallows a check pipeline that rejects", async () => {
    const root = project();
    const { code } = await invoke(root, postToolUse("src/a.ts"), () =>
      Promise.reject(new Error("boom")),
    );
    assert.equal(code, HOOK_OK);
  });

  it("treats an unrunnable pipeline (null) as a pass", async () => {
    const root = project();
    const { code, emitted } = await invoke(root, postToolUse("src/a.ts"), spyCheck(null).run);
    assert.equal(code, HOOK_OK);
    assert.deepEqual(emitted, []);
  });

  it("swallows an unreadable policy rather than blocking the stop", async () => {
    const root = project({ "kragg.json": "{ this is not json" });
    const check = spyCheck(report(false));
    const { code, emitted } = await invoke(
      root,
      JSON.stringify({ hook_event_name: "Stop" }),
      check.run,
    );
    assert.equal(code, HOOK_OK);
    assert.deepEqual(emitted, []);
    assert.deepEqual(check.calls, []);
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
      const { code } = await invoke(root, stdin, spyCheck(report(false)).run);
      assert.equal(code, HOOK_OK, `payload ${stdin.slice(0, 40)} returned ${code}`);
    }
  });
});

describe("payload size", () => {
  it("truncates an enormous reason so the harness does not spill it to a file", async () => {
    const huge = spyCheck(report(false, 400));
    const { emitted } = await invoke(project(), postToolUse("src/a.ts"), huge.run);
    const reason = String(payload(emitted[0])["reason"]);
    assert.ok(reason.length <= MAX_PAYLOAD_CHARS + 100, `reason was ${reason.length} chars`);
    assert.match(reason, /truncated/);
  });
});

describe("cmdHook", () => {
  it("reads injected stdin and dispatches to the claude adapter", async () => {
    const root = project();
    const emitted: string[] = [];
    const code = await cmdHook({
      protocol: "claude",
      root,
      runCheck: spyCheck(report(false)).run,
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
      runCheck: spyCheck(report(true)).run,
      ensureCriticality: () => undefined,
      readStdin: () => postToolUse("src/a.ts"),
      emit: () => undefined,
    });
    assert.equal(code, HOOK_OK);
  });

  it("rejects an unknown protocol loudly, because that is a config typo", async () => {
    const errors: string[] = [];
    const check = spyCheck(report(false));
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
