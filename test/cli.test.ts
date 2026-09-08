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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import type { ReportPayload } from "../src/engine/reportPayload.ts";

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

describe("a check with nothing in its scope", () => {
  /** Identity flags, so a commit works on any developer machine. */
  const COMMIT = [
    "-c",
    "user.name=kragg-test",
    "-c",
    "user.email=kragg-test@example.invalid",
    "-c",
    "commit.gpgsign=false",
  ];

  /** A repository with a clean tree, so `--changed` selects nothing at all. */
  async function cleanRepo(): Promise<string | null> {
    const root = project();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    for (const args of [
      ["init", "--initial-branch=main"],
      ["add", "."],
      [...COMMIT, "commit", "-m", "initial"],
    ]) {
      const result = await runCommand("git", ["git", ...args], root);
      if (result.returncode !== 0) {
        return null;
      }
    }
    return root;
  }

  it("says so in words under the default format", async (t) => {
    const root = await cleanRepo();
    if (root === null) {
      t.skip("git is not available");
      return;
    }
    const result = await run(["check", "--changed"], root);
    assert.equal(result.code, EXIT_OK);
    assert.match(result.out, /no changed TypeScript files/);
  });

  it("emits a report payload under --format json, not that sentence", async (t) => {
    // It used to print the prose in both formats: the one path where the
    // answer is "nothing to do" handed every machine caller a parse error.
    const root = await cleanRepo();
    if (root === null) {
      t.skip("git is not available");
      return;
    }
    const result = await run(["check", "--changed", "--format", "json"], root);
    assert.equal(result.code, EXIT_OK);
    const payload: ReportPayload = JSON.parse(result.out);
    assert.equal(payload.schema_version, 1);
    assert.equal(payload.command, "check");
    assert.equal(payload.mode, "changed");
    assert.deepEqual(payload.targets, []);
    assert.deepEqual(payload.gates, []);
    assert.deepEqual(payload.next_actions, []);
    assert.equal(payload.passed, true);
    assert.equal(payload.exit_code, EXIT_OK);
    assert.equal(payload.summary.gates_total, 0);
    assert.equal(payload.summary.violations_total, 0);
  });
});

describe("an accepted argument must be an argument that acts", () => {
  // Three shapes of one bug, each of which used to be a silent fallback: a
  // value outside its domain, a positional nobody reads, and a flag that
  // silently loses to another flag.

  it("rejects a --format it cannot produce instead of printing text", async () => {
    // The lenient fallback exited 0 and printed text, so a caller parsing
    // stdout as JSON got a parse error and no way to tell a typo'd flag from
    // a broken run.
    const result = await run(["check", "--format", "yaml"]);
    assert.equal(result.code, EXIT_USAGE);
    assert.match(result.err, /--format must be 'text' or 'json', not 'yaml'/);
    assert.equal(result.out, "");
  });

  it("still accepts both formats it advertises", async () => {
    for (const format of ["text", "json"]) {
      const result = await run(["status", "--format", format]);
      assert.equal(result.code, EXIT_OK, format);
    }
  });

  it("rejects a count that is not a count, rather than using the default", async () => {
    // `--max-violations abc` silently restored the policy's cap over the one
    // the caller asked for: a smaller report than requested, and no sign why.
    for (const argv of [
      ["check", "--max-violations", "abc"],
      ["status", "--last", "1.5"],
      ["flaky", "--rerun", "2x"],
      ["status", "--last", ""],
    ]) {
      const result = await run(argv);
      assert.equal(result.code, EXIT_USAGE, argv.join(" "));
      assert.match(result.err, /must be a non-negative integer/, argv.join(" "));
    }
  });

  it("still accepts a well-formed count", async () => {
    assert.equal((await run(["status", "--last", "3"])).code, EXIT_OK);
  });

  it("rejects a positional the command has no use for", async () => {
    // `kragg check src/a.ts` reads like it scoped the run. It did not — that
    // is `--file` — and the word was dropped on the floor.
    for (const argv of [["check", "src/a.ts"], ["status", "20"], ["policy", "show", "extra"]]) {
      const result = await run(argv);
      assert.equal(result.code, EXIT_USAGE, argv.join(" "));
      assert.match(
        result.err,
        /does not take the argument|usage: kragg policy show/,
        argv.join(" "),
      );
    }
  });

  it("keeps the positionals that mean something", async () => {
    assert.equal((await run(["policy", "show"])).code, EXIT_OK);
  });

  it("refuses --file alongside --changed instead of discarding it", async () => {
    // Git decides the file set in changed mode, so the explicit list was
    // dropped and the run silently checked something else.
    const result = await run(["check", "--changed", "--file", "src/a.ts"]);
    assert.equal(result.code, EXIT_USAGE);
    assert.match(result.err, /--file cannot be combined with --changed or --since/);
  });

  it("accepts the mutation baseline flag the docs name, and only that one", async () => {
    // README and the Python sibling both call it `--update-baseline`; the
    // parser accepted `--write` and rejected the documented spelling.
    const rejected = await run(["mutation", "--write"]);
    assert.equal(rejected.code, EXIT_USAGE);
    assert.match(rejected.err, /`mutation` does not accept --write/);
    const accepted = await run(["mutation", "--update-baseline"]);
    assert.notEqual(accepted.code, EXIT_USAGE);
  });

  it("refuses to persist a criticality report scoped by --path", async () => {
    // A partial .kragg/criticality.json does not read as partial: it reads as
    // "every function outside --path is uncritical", and two gates go quiet.
    const result = await run(["criticality", "--write", "--path", "src"]);
    assert.equal(result.code, EXIT_USAGE);
    assert.match(result.err, /--write cannot be combined with --path/);
  });
});

describe("the help text and the flag table cannot drift apart", () => {
  // Both directions of one contract: a flag `--help` advertises must be one a
  // command accepts, and a flag a command accepts must be advertised. Read as
  // text so neither table has to be exported just to be checked.
  const source = readFileSync(fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "utf8");
  const usage = readFileSync(
    fileURLToPath(new URL("../src/cli/usage.ts", import.meta.url)),
    "utf8",
  );

  /** `command -> flags`, parsed out of the `ALLOWED` table in `cli.ts`. */
  function allowedTable(): Map<string, string[]> {
    const block = /const ALLOWED: FlagTable = \{\n([\s\S]*?)\n\};/.exec(source);
    assert.ok(block !== null && block[1] !== undefined, "no ALLOWED table in src/cli.ts");
    const table = new Map<string, string[]>();
    for (const line of block[1].split("\n")) {
      const entry = /^ {2}([\w-]+): \[(.*)],$/.exec(line);
      assert.ok(entry?.[1] !== undefined && entry[2] !== undefined, `unparsed: ${line}`);
      table.set(entry[1], [...entry[2].matchAll(/"([\w-]+)"/g)].map((match) => match[1] ?? ""));
    }
    return table;
  }

  /** `command -> flags`, parsed out of the `Options for ...` sections. */
  function documentedTable(): Map<string, string[]> {
    const table = new Map<string, string[]>();
    let commands: string[] = [];
    for (const line of usage.split("\n")) {
      const heading = /^Options for (.+):$/.exec(line);
      if (heading?.[1] !== undefined) {
        commands = heading[1].replace(" only", "").split(" and ");
        continue;
      }
      const flag = /^ {2}(?:-\w, )?--([\w-]+)/.exec(line);
      if (flag?.[1] === undefined) {
        commands = line.startsWith(" ") ? commands : [];
        continue;
      }
      for (const command of commands) {
        table.set(command, [...(table.get(command) ?? []), flag[1]]);
      }
    }
    return table;
  }

  it("documents exactly the flags each command accepts", () => {
    const allowed = allowedTable();
    const documented = documentedTable();
    for (const [command, flags] of documented) {
      assert.deepEqual(
        [...flags].sort(),
        [...(allowed.get(command) ?? [])].sort(),
        `\`${command}\`: --help and the ALLOWED table disagree`,
      );
    }
    for (const [command, flags] of allowed) {
      assert.equal(
        flags.length > 0,
        documented.has(command),
        `\`${command}\`: help and the table disagree about whether it takes flags`,
      );
    }
  });

  it("finds the commands it claims to be checking", () => {
    // A regex that quietly matched nothing would make the test above vacuous.
    const documented = documentedTable();
    assert.deepEqual(
      [...documented.keys()].sort(),
      ["brief", "check", "criticality", "fix", "flaky", "map", "mutation", "security", "status"],
    );
    assert.deepEqual(documented.get("criticality"), ["write", "path"]);
    assert.deepEqual(allowedTable().get("mutation"), ["path", "since", "all", "update-baseline"]);
  });
});

