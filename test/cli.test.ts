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
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("kragg init", () => {
  it("leaves an embedded policy in charge, and says it did", async () => {
    // The whole point of the command's restraint: a standalone kragg.json wins
    // outright over package.json#kragg, so writing one here would silently
    // replace a stricter policy with the generated defaults.
    const root = project({
      "package.json": '{"name": "legacy", "kragg": {"coverage_fail_under": 95}}',
    });
    const init = await run(["init", root], root);
    assert.equal(init.code, EXIT_OK);
    assert.match(init.out, /preserved .*kragg\.json/);
    const policy = await run(["policy", "show"], root);
    assert.equal(policy.code, EXIT_OK);
    assert.match(policy.out, /"coverage_fail_under": 95/);
  });

  it("writes nothing under --dry-run", async () => {
    const root = project({ "package.json": '{"name": "legacy"}' });
    const result = await run(["init", root, "--dry-run"], root);
    assert.equal(result.code, EXIT_OK);
    assert.match(result.out, /Dry run/);
    assert.deepEqual(readdirSync(root), ["package.json"]);
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

/**
 * The project's OWN compiler, wired into a throwaway project.
 *
 * A shim rather than a copy of `node_modules/typescript` (24 MB per test) and
 * rather than a symlink (`resolveBin` rejects a `.bin` entry whose real path
 * escapes the project, which is the invariant that keeps kragg off a global
 * toolchain). The shim is a real file inside the project that loads the real
 * compiler, so the diagnostics asserted below are TypeScript's own — file,
 * line and column included — and not a recorded string. POSIX shebang, like
 * the stand-in `tsc` in `tsc.test.ts`.
 */
const TSC_ENTRY = fileURLToPath(new URL("../node_modules/typescript/lib/tsc.js", import.meta.url));

function writeProjectFile(root: string, name: string, contents: string): void {
  const path = join(root, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

const TOR1359_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "es2023",
    lib: ["es2023"],
    module: "nodenext",
    moduleResolution: "nodenext",
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    allowImportingTsExtensions: true,
    rewriteRelativeImportExtensions: true,
    verbatimModuleSyntax: true,
    isolatedModules: true,
    erasableSyntaxOnly: true,
    skipLibCheck: false,
    noEmit: true,
  },
  include: ["src/**/*.ts"],
});

/**
 * TOR-1359's fixture: an exported return type changed in `src/a.ts`, and the
 * UNCHANGED caller `src/b.ts` no longer type-checks.
 *
 * Committed first with `f(x: number): number`, so `--changed` sees exactly one
 * changed file — `src/a.ts` — and `src/b.ts` is genuinely outside the
 * selection rather than merely unmentioned.
 */
async function brokenCallerProject(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "kragg-caller-"));
  roots.push(root);
  writeProjectFile(root, "package.json", '{"name":"x","version":"0.0.0","type":"module","private":true}');
  // The three external tools are off so the report is about the compiler and
  // nothing else; every gate that judges the code itself still runs.
  writeProjectFile(
    root,
    "kragg.json",
    '{"source_paths":["src"],"test_paths":["test"],"lint_tool":"off",' +
      '"test_runner":"off","secret_scanner":"off"}',
  );
  writeProjectFile(root, "tsconfig.json", TOR1359_TSCONFIG);
  writeProjectFile(root, "src/a.ts", "export function f(x: number): number {\n  return x;\n}\n");
  writeProjectFile(root, "src/b.ts", 'import { f } from "./a.ts";\n\nexport const v: number = f(1);\n');
  writeProjectFile(root, "node_modules/.bin/tsc", `#!${process.execPath}\nimport(${JSON.stringify(TSC_ENTRY)});\n`);
  chmodSync(join(root, "node_modules", ".bin", "tsc"), 0o755);
  await commitBaseline(root);
  // THE CHANGE: the exported return type moves from `number` to `string`.
  // Only `src/a.ts` is touched; `src/b.ts` is what breaks.
  writeProjectFile(root, "src/a.ts", "export function f(x: string): string {\n  return x;\n}\n");
  return root;
}

/** One commit, so `--changed` has a HEAD to diff the edit against. */
async function commitBaseline(root: string): Promise<void> {
  const vcs = async (...args: readonly string[]): Promise<void> => {
    await runCommand("git", ["git", ...args], root);
  };
  await vcs("init", "-q");
  await vcs("add", "-A");
  await vcs(
    "-c",
    "user.email=t@example.test",
    "-c",
    "user.name=t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "baseline",
  );
}

describe("a compiler failure in an unchanged caller survives every scope", () => {
  // Built once: the four scopes read the same tree and none of them writes it.
  const ready = brokenCallerProject();

  /** `[FAIL] tsc`, and the caller's own file:line:column under it. */
  function assertCallerReported(result: Captured, scope: string): void {
    assert.equal(result.code, EXIT_GATE_FAILURES, `${scope}: ${result.out}${result.err}`);
    assert.match(result.out, /\[FAIL] tsc/, scope);
    assert.match(result.out, /src\/b\.ts:3:\d+ TS2345/, scope);
    assert.doesNotMatch(result.out, /\[PASS] tsc/, scope);
  }

  it("fails a full check", async () => {
    assertCallerReported(await run(["check", "--no-journal"], await ready), "full");
  });

  it("fails --changed, where only src/a.ts changed", async () => {
    // The regression: the whole project was compiled, then every diagnostic
    // outside the changed set was dropped, so this printed `[PASS] tsc` for a
    // change that broke its callers while `tsc -p tsconfig.json` was failing.
    assertCallerReported(await run(["check", "--changed", "--no-journal"], await ready), "changed");
  });

  it("fails --file src/a.ts", async () => {
    assertCallerReported(
      await run(["check", "--file", "src/a.ts", "--no-journal"], await ready),
      "file",
    );
  });

  it("still reports the compiler verdict when --file names no TypeScript at all", async () => {
    // Nothing matches the selection at all, and an empty match must never read
    // as compiler success.
    assertCallerReported(
      await run(["check", "--file", "kragg.json", "--no-journal"], await ready),
      "non-typescript file",
    );
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

/**
 * TOR-1365, end to end: what an incremental run may conclude, and from what.
 *
 * The fixture keeps the external tools off so the report is about the gates
 * that judge the code, and gives `nullable-default` something real to find in
 * a nested directory — the finding that a `--file` on that directory used to
 * miss while reporting `[PASS]`.
 */
describe("incremental selection and configuration invalidation", () => {
  const TSCONFIG = JSON.stringify({
    compilerOptions: {
      target: "es2023",
      module: "nodenext",
      moduleResolution: "nodenext",
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      allowImportingTsExtensions: true,
      verbatimModuleSyntax: true,
      erasableSyntaxOnly: true,
      noEmit: true,
    },
    include: ["src/**/*.ts"],
  });

  /** `||` mis-coalescing a legitimate `0` — one `nullable-default` violation. */
  const MIS_COALESCED = "export function port(given: number | null): number {\n" +
    "  return given || 8080;\n}\n";

  async function selectionProject(): Promise<string | null> {
    const root = project({
      "package.json": '{"name":"x","version":"0.0.0","type":"module","private":true}',
      "kragg.json":
        '{"source_paths":["src"],"test_paths":["test"],"lint_tool":"off",' +
        '"test_runner":"off","secret_scanner":"off"}',
      "tsconfig.json": TSCONFIG,
      "README.md": "# fixture\n",
    });
    writeProjectFile(root, "src/a.ts", "export const a = 1;\n");
    writeProjectFile(root, "src/nested/b.ts", MIS_COALESCED);
    for (const args of [
      ["init", "--initial-branch=main"],
      ["add", "-A"],
      [
        "-c",
        "user.name=kragg-test",
        "-c",
        "user.email=kragg-test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        "baseline",
      ],
    ]) {
      const result = await runCommand("git", ["git", ...args], root);
      if (result.returncode !== 0) {
        return null;
      }
    }
    return root;
  }

  /** Run `check --changed --format json` and hand back the payload. */
  async function changedRun(root: string): Promise<{ payload: ReportPayload; err: string }> {
    const result = await run(["check", "--changed", "--format", "json", "--no-journal"], root);
    return { payload: JSON.parse(result.out), err: result.err };
  }

  it("runs a FULL check after a config-only edit, instead of exiting 0 having run nothing", async (t) => {
    const root = await selectionProject();
    if (root === null) {
      t.skip("git is not available");
      return;
    }
    // THE REPORTED BUG. Editing only `kragg.json` left `--changed` with an
    // empty TypeScript selection, so it printed "no changed TypeScript files"
    // and exited 0 before a single gate ran — over a file that decides what
    // every gate concludes about every other file.
    writeFileSync(join(root, "kragg.json"),
      '{"source_paths":["src"],"test_paths":["test"],"lint_tool":"off",' +
        '"test_runner":"off","secret_scanner":"off","max_file_lines":400}');
    const { payload, err } = await changedRun(root);
    assert.equal(payload.mode, "full");
    assert.deepEqual(payload.targets, ["src"]);
    assert.ok(payload.summary.gates_total > 0, "gates must actually have run");
    assert.match(err, /kragg\.json changed/);
  });

  it("runs a FULL check when the only change is a deletion", async (t) => {
    const root = await selectionProject();
    if (root === null) {
      t.skip("git is not available");
      return;
    }
    rmSync(join(root, "src", "a.ts"));
    const { payload, err } = await changedRun(root);
    assert.equal(payload.mode, "full");
    assert.ok(payload.summary.gates_total > 0);
    assert.match(err, /src\/a\.ts was removed/);
  });

  it("still reports an empty selection as a clean run when only a doc changed", async (t) => {
    const root = await selectionProject();
    if (root === null) {
      t.skip("git is not available");
      return;
    }
    // Empty is not failed discovery, and it is not a reason to check the world.
    writeFileSync(join(root, "README.md"), "# edited\n");
    const { payload, err } = await changedRun(root);
    assert.equal(payload.mode, "changed");
    assert.deepEqual(payload.gates, []);
    assert.equal(err, "");
  });

  it("selects a changed non-ASCII path instead of silently dropping it", async (t) => {
    const root = await selectionProject();
    if (root === null) {
      t.skip("git is not available");
      return;
    }
    // `core.quotePath` rendered this as `"src/caf\303\251.ts"`, which matched
    // nothing on disk: the file left the selection and the run passed green.
    writeProjectFile(root, "src/café.ts", MIS_COALESCED);
    const { payload } = await changedRun(root);
    assert.equal(payload.mode, "changed");
    assert.deepEqual(payload.targets, ["src/café.ts"]);
    const gate = payload.gates.find((each) => each.name === "nullable-default");
    assert.equal(gate?.passed, false, "the gate must have looked inside the file");
    assert.equal(gate?.violation_count, 1);
  });

  it("narrows every path-aware gate to a --file directory, not just the linter", async (t) => {
    const root = await selectionProject();
    if (root === null) {
      t.skip("git is not available");
      return;
    }
    // `--file src/nested` used to leave `paths` as the directory string, which
    // no gate that compares FILE paths could ever match: `nullable-default`
    // scanned nothing and printed `[PASS]` over a real finding underneath it.
    const result = await run(
      ["check", "--file", "src/nested", "--format", "json", "--no-journal"],
      root,
    );
    const payload: ReportPayload = JSON.parse(result.out);
    assert.deepEqual(payload.targets, ["src/nested"], "targets stay as given: they are on the wire");
    const gate = payload.gates.find((each) => each.name === "nullable-default");
    assert.equal(gate?.passed, false);
    assert.equal(gate?.violation_count, 1);
  });

  it("rejects a --file that names nothing, on both pipelines", async (t) => {
    const root = await selectionProject();
    if (root === null) {
      t.skip("git is not available");
      return;
    }
    for (const command of ["check", "security"]) {
      const result = await run([command, "--file", "src/typo.ts", "--no-journal"], root);
      assert.equal(result.code, EXIT_USAGE, command);
      assert.match(result.err, /--file src\/typo\.ts: no such file or directory/, command);
      assert.equal(result.out, "", command);
    }
  });

  it("reports git's own message for a --since ref that does not exist", async (t) => {
    const root = await selectionProject();
    if (root === null) {
      t.skip("git is not available");
      return;
    }
    // An unresolvable ref is not an empty change set. It used to be reported
    // as "not a git repository", which sends the reader to the wrong place.
    const result = await run(["check", "--since", "no-such-ref", "--no-journal"], root);
    assert.equal(result.code, EXIT_ENVIRONMENT);
    assert.match(result.err, /merge-base/);
    assert.equal(result.out, "");
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
      ["brief", "check", "criticality", "fix", "flaky", "init", "map", "mutation", "security", "status"],
    );
    assert.deepEqual(documented.get("criticality"), ["write", "path"]);
    assert.deepEqual(allowedTable().get("mutation"), ["path", "since", "all", "update-baseline"]);
  });
});

