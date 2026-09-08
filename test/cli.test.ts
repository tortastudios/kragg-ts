/**
 * Tests for the command-line surface.
 *
 * THE EXIT CODE IS THE INTERFACE, so that is what these assert. A hook, a CI
 * job and an agent all branch on it without reading a word of the output, and
 * the four codes have to stay distinguishable:
 *
 *   0 passed | 1 violations | 2 bad invocation or config | 3 broken env
 *
 * The two easiest ways to break this quietly are covered explicitly: a usage
 * mistake that exits 0 (so a typo'd command reads as a clean run), and a
 * `PolicyError` that exits 3 (so a config typo reads as a broken machine and
 * sends everyone to reinstall something).
 *
 * EVERY CASE SPAWNS A REAL PROCESS. The commands write to `process.stdout`
 * directly, and swapping that out in-process silently eats `node --test`'s own
 * reporter output — the tests appear to pass while reporting almost nothing.
 * Spawning also exercises the parts an in-process call skips: the shebang
 * entry guard, `process.cwd()` as the project root, and `process.exitCode`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { runCommand } from "../src/engine/runner.ts";
import {
  EXIT_ENVIRONMENT,
  EXIT_GATE_FAILURES,
  EXIT_OK,
  EXIT_USAGE,
  kraggVersion,
} from "../src/engine/report.ts";

/** The source entry point; Node strips its types natively, as `pnpm test` does. */
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(files: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-cli-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, name), contents);
  }
  return root;
}

interface Captured {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** Run the CLI in a throwaway directory and capture everything it produced. */
async function run(argv: readonly string[], root = project()): Promise<Captured> {
  const result = await runCommand("kragg", [process.execPath, CLI, ...argv], root);
  return { code: result.returncode, out: result.stdout, err: result.stderr };
}

describe("global flags", () => {
  it("prints the version and exits 0", async () => {
    const result = await run(["--version"]);
    assert.equal(result.code, EXIT_OK);
    assert.equal(result.out.trim(), kraggVersion());
  });

  it("prints help and exits 0 for an explicit --help", async () => {
    const result = await run(["--help"]);
    assert.equal(result.code, EXIT_OK);
    assert.match(result.out, /Usage:\s+kragg <command>/);
  });

  it("exits 2 for a bare invocation, even though it prints help", async () => {
    // A caller that meant to run a check must never see a success code.
    const result = await run([]);
    assert.equal(result.code, EXIT_USAGE);
    assert.match(result.out, /Usage:/);
  });
});

describe("usage errors all exit 2", () => {
  it("rejects an unknown command", async () => {
    const result = await run(["nope"]);
    assert.equal(result.code, EXIT_USAGE);
    assert.match(result.err, /unknown command 'nope'/);
  });

  it("rejects an unknown flag", async () => {
    const result = await run(["check", "--bogus"]);
    assert.equal(result.code, EXIT_USAGE);
  });

  it("rejects a flag the command does not accept", async () => {
    // `--changed` is meaningful for check and meaningless for status; silently
    // ignoring it would let someone believe they scoped a run that they did not.
    const result = await run(["status", "--changed"]);
    assert.equal(result.code, EXIT_USAGE);
    assert.match(result.err, /does not accept --changed/);
  });

  it("rejects `security --changed`, which the pipeline does not support", async () => {
    const result = await run(["security", "--changed"]);
    assert.equal(result.code, EXIT_USAGE);
  });

  it("requires a subcommand for policy", async () => {
    assert.equal((await run(["policy"])).code, EXIT_USAGE);
    assert.equal((await run(["policy", "list"])).code, EXIT_USAGE);
  });
});

describe("every command is wired", () => {
  // These two tests previously asserted the OPPOSITE — that this roster exits
  // 2 with "not implemented yet". They were correct then and are correct now;
  // wiring the handlers is what changed. Keeping the roster in one place means
  // adding a command without a handler fails here rather than shipping a
  // command that silently does nothing.
  const WIRED = ["map", "spec", "brief", "coverage", "criticality", "audit", "mutation", "flaky"];

  it("no command reports itself unimplemented", async () => {
    // A sample, not the whole list: every spawn costs about a second.
    for (const command of ["map", "criticality", "brief"]) {
      const result = await run([command]);
      assert.doesNotMatch(result.err, /not implemented/i, command);
      assert.notEqual(result.code, EXIT_USAGE, command);
    }
  });

  it("lists every one of them in the help text", async () => {
    const result = await run(["--help"]);
    assert.doesNotMatch(result.out, /not implemented/i);
    for (const command of [...WIRED, "hook", "new", "gen", "init"]) {
      assert.ok(result.out.includes(command), `help does not mention ${command}`);
    }
  });

  it("still rejects an unknown command", async () => {
    // The wiring must not have turned the default arm into a silent success.
    const result = await run(["definitely-not-a-command"]);
    assert.equal(result.code, EXIT_USAGE);
    assert.match(result.err, /unknown command/);
  });

  it("requires a protocol name for `hook`", async () => {
    // Running the Claude adapter under another harness's name would "work"
    // while feeding a model output it never reads.
    const result = await run(["hook"]);
    assert.equal(result.code, EXIT_USAGE);
  });
});

describe("a broken config is a USAGE error, not a broken environment", () => {
  it("maps PolicyError to exit 2 for every command that loads policy", async () => {
    // Exit 3 here would send the reader to reinstall a tool. The fix is one
    // character in a JSON file, and the code has to say so.
    const root = project({ "kragg.json": '{"lint_tool": "oxlnt"}' });
    // `status` is absent on purpose: it reads only the journal and never loads
    // policy, so it has no config to be broken by.
    for (const command of [["policy", "show"], ["doctor"], ["check"]]) {
      const result = await run(command, root);
      assert.equal(result.code, EXIT_USAGE, command.join(" "));
      assert.match(result.err, /lint_tool must be one of/, command.join(" "));
    }
  });

  it("rejects a malformed restriction with exit 2 and NO report, naming the setting", async () => {
    // `["node:child_process", 7]` used to load as an empty ban list and
    // `check` ran green over an un-banned call. Now nothing runs at all.
    const root = project({ "kragg.json": '{"forbidden_calls": ["node:child_process", 7]}' });
    const result = await run(["check", "--no-journal", "--format", "json"], root);
    assert.equal(result.code, EXIT_USAGE);
    assert.match(result.err, /kragg\.json#forbidden_calls\[1\] must be a string \(got 7\)/);
    assert.equal(result.out, "");
  });

  it("rejects a misspelled setting with exit 2, suggesting the right key", async () => {
    const root = project({ "kragg.json": '{"forbiden_calls": {"a.b": "x"}}' });
    const result = await run(["policy", "show"], root);
    assert.equal(result.code, EXIT_USAGE);
    assert.match(result.err, /forbiden_calls is not a kragg setting \(did you mean forbidden_calls\?\)/);
    assert.equal(result.out, "");
  });

  it("maps malformed JSON to exit 2 as well", async () => {
    const root = project({ "kragg.json": "{not json" });
    const result = await run(["policy", "show"], root);
    assert.equal(result.code, EXIT_USAGE);
    assert.match(result.err, /not valid JSON/);
  });

  it("does not treat an absent config as an error", async () => {
    assert.equal((await run(["policy", "show"])).code, EXIT_OK);
  });
});

describe("the read-only commands", () => {
  it("prints the effective policy as sorted JSON", async () => {
    const result = await run(["policy", "show"]);
    assert.equal(result.code, EXIT_OK);
    const parsed: unknown = JSON.parse(result.out);
    assert.ok(typeof parsed === "object" && parsed !== null);
    const keys = Object.keys(parsed);
    assert.deepEqual(keys, [...keys].sort());
    assert.match(result.out, /"profile": "strict-ai-typescript"/);
  });

  it("says so when there is no history, rather than reporting a pass", async () => {
    const result = await run(["status"]);
    assert.equal(result.code, EXIT_OK);
    assert.match(result.out, /no recorded runs/);
  });

  it("emits a machine-readable status with an explicit null last run", async () => {
    const result = await run(["status", "--format", "json"]);
    assert.equal(result.code, EXIT_OK);
    assert.deepEqual(JSON.parse(result.out), { last_run: null, runs: [] });
  });

  it("fails doctor on a directory that is not a project", async () => {
    const result = await run(["doctor"]);
    assert.equal(result.code, EXIT_GATE_FAILURES);
    assert.match(result.out, /package.json: missing/);
    assert.match(result.out, /tsc: MISSING -> /);
  });
});

describe("check outside a git repository", () => {
  it("refuses --changed rather than checking nothing and passing", async () => {
    // `null` from `changedFiles` means "git could not answer". Treating it as
    // an empty change set would report a confident pass over an unchecked repo.
    const result = await run(["check", "--changed"]);
    assert.equal(result.code, EXIT_ENVIRONMENT);
    assert.match(result.err, /not a git repository/);
  });

  it("refuses --since for the same reason", async () => {
    const result = await run(["check", "--since", "main"]);
    assert.equal(result.code, EXIT_ENVIRONMENT);
  });
});
