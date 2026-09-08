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
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
