/**
 * Tests for the command handlers, below the argument parser.
 *
 * `cli.test.ts` covers the surface by spawning a process; this file drives the
 * handlers directly, which is the only practical way to assert what
 * `runPipeline` writes into `.kragg/history.jsonl` and how each command turns
 * a state of the world into an exit code.
 *
 * CAPTURING STDOUT IS ONLY SAFE SYNCHRONOUSLY, and the reason is worth stating
 * because getting it wrong looks like a passing suite: `node --test`'s reporter
 * writes to `process.stdout` too. Swallowing writes across an `await` eats the
 * reporter's own output and the run silently reports almost nothing. During a
 * synchronous call nothing else can interleave, so `capture` is safe there and
 * is used nowhere else — the async cases assert side effects instead and let
 * their output through.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { runPipeline } from "../src/commands/check.ts";
import { runCriticality } from "../src/commands/criticality.ts";
import { runDoctor } from "../src/commands/doctor.ts";
import { runPolicyShow } from "../src/commands/policyShow.ts";
import { runStatus } from "../src/commands/status.ts";
import { errorGate, nativeGate, skipGate } from "../src/catalog/results.ts";
import { FAST, type GateSpec } from "../src/engine/gate.ts";
import { journalPath, type JournalEntry } from "../src/engine/journal.ts";
import {
  EXIT_ENVIRONMENT,
  EXIT_GATE_FAILURES,
  EXIT_OK,
  EXIT_USAGE,
} from "../src/engine/report.ts";
import { criticalityFreshness, criticalityPath } from "../src/gates/criticality.ts";
import { DEFAULT_POLICY } from "../src/policy/policy.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(files: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-commands-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, name), contents);
  }
  return root;
}

interface Capture<T> {
  readonly value: T;
  readonly out: string;
}

/** Run a SYNCHRONOUS function with stdout captured. See the module docs. */
function capture<T>(fn: () => T): Capture<T> {
  const chunks: string[] = [];
  const real = process.stdout.write;
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  try {
    return { value: fn(), out: chunks.join("") };
  } finally {
    process.stdout.write = real;
  }
}

/** A gate spec that returns a canned result. */
function stub(name: string, result: GateSpec["run"]): GateSpec {
  return { name, tier: FAST, run: result };
}

/** Drive `runPipeline` over canned gates. Output is deliberately not captured. */
function pipeline(
  root: string,
  specs: readonly GateSpec[],
  overrides: Partial<Parameters<typeof runPipeline>[0]["flags"]> = {},
): Promise<number> {
  return runPipeline({
    command: "check",
    mode: "full",
    policy: DEFAULT_POLICY,
    specs,
    targets: ["src"],
    flags: {
      root,
      targets: [],
      // JSON keeps the incidental output in the test log to one blob, and it
      // is the format a caller would actually parse.
      format: "json",
      maxViolations: undefined,
      journal: true,
      failFast: false,
      all: false,
      ...overrides,
    },
  });
}

function readJournal(root: string): JournalEntry[] {
  return readFileSync(journalPath(root), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line): JournalEntry => JSON.parse(line));
}

describe("runPipeline: exit codes", () => {
  it("returns 0 when every gate passed or skipped", async () => {
    const root = project();
    const code = await pipeline(root, [
      stub("a", () => nativeGate("a", [])),
      stub("b", () => skipGate("b", "nothing configured")),
    ]);
    assert.equal(code, EXIT_OK);
  });

  it("returns 1 for findings", async () => {
    const root = project();
    const code = await pipeline(root, [stub("a", () => nativeGate("a", [{ message: "x" }]))]);
    assert.equal(code, EXIT_GATE_FAILURES);
  });

  it("returns 3 when a gate could not run, even alongside findings", async () => {
    // The environment outranks the findings: a violation list produced by a
    // half-broken pipeline is not a list anyone should start fixing.
    const root = project();
    const code = await pipeline(root, [
      stub("a", () => nativeGate("a", [{ message: "x" }])),
      stub("b", () => errorGate("b", "tsc is not installed")),
    ]);
    assert.equal(code, EXIT_ENVIRONMENT);
  });

  it("keeps the whole report when a gate throws, and returns 3", async () => {
    // THE LOST REPORT THIS CLOSES. An exception out of a gate's `run` used to
    // propagate through `runGates` to `cli.ts`, which printed one stderr line
    // and exited 3 — no report, no journal entry, and every other gate's
    // result gone with it. The thrown gate is `error: true` instead, its
    // message survives into the payload, and the pipeline still finishes.
    const root = project();
    const code = await pipeline(root, [
      stub("a", () => nativeGate("a", [])),
      stub("boom", () => {
        throw new Error("ENOENT: no such file or directory, open 'src/gone.ts'");
      }),
      stub("c", () => nativeGate("c", [])),
    ]);

    assert.equal(code, EXIT_ENVIRONMENT);
    const gates = readJournal(root)[0]?.gates ?? [];
    assert.deepEqual(gates.map((gate) => gate.name), ["a", "boom", "c"]);
    assert.equal(gates[1]?.passed, false);
    assert.equal(gates[1]?.skipped, false, "a gate that threw is not a skip");
    assert.equal(gates[2]?.passed, true, "the gates after it still ran");
  });
});

describe("runPipeline: the journal", () => {
  it("appends exactly one line per run", async () => {
    const root = project();
    await pipeline(root, [stub("a", () => nativeGate("a", []))]);
    await pipeline(root, [stub("a", () => nativeGate("a", [{ message: "x" }]))]);
    const runs = readJournal(root);
    assert.equal(runs.length, 2);
    assert.equal(runs[0]?.passed, true);
    assert.equal(runs[1]?.passed, false);
    assert.equal(runs[1]?.exit_code, EXIT_GATE_FAILURES);
    assert.equal(runs[1]?.command, "check");
  });

  it("writes nothing at all with --no-journal", async () => {
    const root = project();
    await pipeline(root, [stub("a", () => nativeGate("a", []))], { journal: false });
    assert.throws(() => readJournal(root));
  });

  it("records each gate's verdict, not just the run's", async () => {
    const root = project();
    await pipeline(root, [
      stub("a", () => nativeGate("a", [{ message: "x" }, { message: "y" }])),
      stub("b", () => skipGate("b", "why")),
    ]);
    const gates = readJournal(root)[0]?.gates ?? [];
    assert.deepEqual(gates.map((gate) => gate.name), ["a", "b"]);
    assert.equal(gates[0]?.violation_count, 2);
    assert.equal(gates[1]?.skipped, true);
  });
});

describe("runPipeline: fail-fast", () => {
  it("accounts for every remaining gate as skipped, never omits it", async () => {
    // The report has to describe the WHOLE pipeline. A gate that vanishes from
    // the output reads as a gate that does not exist.
    const root = project();
    await pipeline(
      root,
      [
        stub("a", () => nativeGate("a", [{ message: "x" }])),
        stub("b", () => nativeGate("b", [])),
      ],
      { failFast: true },
    );
    const gates = readJournal(root)[0]?.gates ?? [];
    assert.equal(gates.length, 2);
    assert.equal(gates[1]?.skipped, true);
  });
});

describe("runStatus", () => {
  it("reports an empty history as empty, never as a pass", async () => {
    const root = project();
    const result = capture(() => runStatus(root, "text", 10));
    assert.equal(result.value, EXIT_OK);
    assert.match(result.out, /no recorded runs \(run `kragg check` first\)/);
  });

  it("summarizes the last run, naming the failing gates", async () => {
    const root = project();
    await pipeline(root, [stub("lint", () => nativeGate("lint", [{ message: "x" }]))]);
    const result = capture(() => runStatus(root, "text", 10));
    assert.match(result.out, /last run: FAIL \(check, full mode/);
    assert.match(result.out, /failing gates: lint \(1 violations\)/);
  });

  it("breaks out last_run in JSON so a hook need not index a list", async () => {
    const root = project();
    await pipeline(root, [stub("a", () => nativeGate("a", []))]);
    const result = capture(() => runStatus(root, "json", 10));
    const parsed: unknown = JSON.parse(result.out);
    assert.ok(typeof parsed === "object" && parsed !== null && "last_run" in parsed);
    assert.equal(result.value, EXIT_OK);
  });
});

describe("runPolicyShow", () => {
  it("prints the EFFECTIVE policy, defaults filled in", async () => {
    const root = project({ "kragg.json": '{"max_file_lines": 120}' });
    const result = capture(() => runPolicyShow(root));
    assert.equal(result.value, EXIT_OK);
    const parsed: unknown = JSON.parse(result.out);
    assert.ok(typeof parsed === "object" && parsed !== null);
    assert.equal(Object.getOwnPropertyDescriptor(parsed, "max_file_lines")?.value, 120);
    // Not configured, so it comes from the defaults — that is the point of the
    // command: what is enforced, not what the file says.
    assert.equal(Object.getOwnPropertyDescriptor(parsed, "lint_tool")?.value, "auto");
  });

  it("sorts keys so two runs, and two siblings, diff cleanly", async () => {
    const result = capture(() => runPolicyShow(project()));
    const keys = Object.keys(JSON.parse(result.out) as Record<string, unknown>);
    assert.deepEqual(keys, [...keys].sort());
  });
});

describe("runDoctor", () => {
  it("fails a directory that is not a project, and says what is missing", async () => {
    const result = capture(() => runDoctor(project()));
    assert.equal(result.value, EXIT_GATE_FAILURES);
    assert.match(result.out, /package.json: missing/);
    assert.match(result.out, /source path: missing/);
  });

  it("attaches an install command to every missing tool", async () => {
    // A diagnostic that reports a problem without its remedy just moves the
    // search somewhere else.
    const root = project({ "package.json": '{"name":"a","packageManager":"pnpm@9.0.0"}' });
    const result = capture(() => runDoctor(root));
    assert.match(result.out, /tsc: MISSING -> Fix: pnpm add -D typescript/);
    assert.match(result.out, /package manager: pnpm/);
  });

  it("summarizes interchangeable tools as a group, not as three failures", async () => {
    const result = capture(() => runDoctor(project()));
    assert.match(result.out, /linter: none installed — optional/);
    // gitleaks is a standalone binary on PATH, so a developer machine may
    // legitimately have one; either way the line is optional, never a failure.
    assert.match(result.out, /secret scanner: (none installed — optional|ok \(gitleaks)/);
    assert.equal(result.value, EXIT_GATE_FAILURES, "…on the layout, not on the groups");
  });

  it("reports a tool the policy NAMED but the project lacks as required", async () => {
    // The distinction the gates already make: `"auto"` is optional
    // autodetection, a named tool is required and its gate exits 3 without it.
    // doctor must not report the second as an advisory "none installed".
    const root = project({
      "package.json": '{"name":"a","packageManager":"pnpm@9.0.0"}',
      "kragg.json":
        '{"lint_tool":"eslint","test_runner":"vitest","secret_scanner":"secretlint"}',
    });
    const result = capture(() => runDoctor(root));
    assert.equal(result.value, EXIT_GATE_FAILURES);
    assert.match(result.out, /linter: MISSING -> required by lint_tool = "eslint"/);
    assert.match(result.out, /test runner: MISSING -> required by test_runner = "vitest"/);
    assert.match(
      result.out,
      /secret scanner: MISSING -> required by secret_scanner = "secretlint"/,
    );
    // Every one of them still carries the command that fixes it.
    assert.match(result.out, /pnpm add -D eslint/);
    assert.match(result.out, /pnpm add -D vitest/);
    assert.match(result.out, /pnpm add -D secretlint @secretlint/);
    assert.doesNotMatch(result.out, /none installed/);
  });

  it("counts a deliberate opt-out as fine, not as a missing tool", async () => {
    const root = project({
      "package.json": '{"name":"a","packageManager":"pnpm@9.0.0"}',
      "tsconfig.json": "{}",
      "kragg.json": '{"lint_tool":"off","test_runner":"off","secret_scanner":"off"}',
    });
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "test"));
    const result = capture(() => runDoctor(root));
    assert.match(result.out, /linter: disabled \(lint_tool = "off"\)/);
    assert.match(result.out, /test runner: disabled \(test_runner = "off"\)/);
    assert.match(result.out, /secret scanner: disabled \(secret_scanner = "off"\)/);
    // Only `tsc` is genuinely missing here; the three opt-outs add nothing.
    assert.match(result.out, /tsc: MISSING/);
  });

  it("does not require a test runner that is a runtime rather than a package", async () => {
    const root = project({
      "package.json": '{"name":"a","packageManager":"pnpm@9.0.0"}',
      "kragg.json": '{"test_runner":"node"}',
    });
    const result = capture(() => runDoctor(root));
    assert.match(result.out, /test runner: ok \(node — a runtime/);
  });

  it("passes a project that has its layout and its compiler", async () => {
    const root = project({
      "package.json": '{"name":"a","packageManager":"pnpm@9.0.0"}',
      "tsconfig.json": "{}",
    });
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "test"));
    // No `tsc` in this throwaway tree, so the run still fails — on the ONE
    // required item that is genuinely absent, and not on the optional groups.
    const result = capture(() => runDoctor(root));
    assert.equal(result.value, EXIT_GATE_FAILURES);
    assert.match(result.out, /package.json: ok/);
    assert.match(result.out, /source path: ok/);
    assert.match(result.out, /test path: ok/);
  });
});

describe("runCriticality: --path", () => {
  // `--path` was in the CLI's accepted-flag table and read by nothing, so
  // `kragg criticality --path anything` analyzed the whole program and said
  // so in a table that looked exactly like a scoped one.
  const CRITICALITY_TSCONFIG = JSON.stringify({
    compilerOptions: {
      target: "es2022",
      module: "nodenext",
      moduleResolution: "nodenext",
      strict: true,
      allowImportingTsExtensions: true,
      noEmit: true,
    },
    include: ["src/**/*.ts"],
  });

  /** Two source files, so a scope can include one and exclude the other. */
  function twoFileProject(): string {
    const root = project({ "tsconfig.json": CRITICALITY_TSCONFIG });
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "alpha.ts"), "export function alpha(): number {\n  return 1;\n}\n");
    writeFileSync(
      join(root, "src", "beta.ts"),
      'import { alpha } from "./alpha.ts";\n\nexport function beta(): number {\n  return alpha();\n}\n',
    );
    return root;
  }

  interface Run {
    readonly code: number;
    readonly out: string;
    readonly err: string;
  }

  /** Drive the handler with its own log hooks — no stdout capture needed. */
  function criticality(root: string, options: { write?: boolean; paths?: string[] }): Run {
    const out: string[] = [];
    const err: string[] = [];
    const code = runCriticality({
      root,
      write: options.write ?? false,
      paths: options.paths ?? [],
      log: (line) => out.push(line),
      logError: (line) => err.push(line),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  it("analyzes the whole program when no path is given", () => {
    const result = criticality(twoFileProject(), {});
    assert.equal(result.code, EXIT_OK);
    assert.match(result.out, /src\/alpha#alpha/);
    assert.match(result.out, /src\/beta#beta/);
  });

  it("narrows the call graph to the files under the path", () => {
    const result = criticality(twoFileProject(), { paths: ["src/beta.ts"] });
    assert.equal(result.code, EXIT_OK);
    assert.match(result.out, /src\/beta#beta/);
    assert.doesNotMatch(result.out, /src\/alpha#alpha/);
  });

  it("takes several paths, and reads them relative to the root", () => {
    const root = twoFileProject();
    const result = criticality(root, { paths: [join(root, "src", "alpha.ts"), "src/beta.ts"] });
    assert.equal(result.code, EXIT_OK);
    assert.match(result.out, /src\/alpha#alpha/);
    assert.match(result.out, /src\/beta#beta/);
  });

  it("is a usage error when the path matches nothing, not an empty table", () => {
    // An empty table exits 0 and reads exactly like "this code has no risk".
    const result = criticality(twoFileProject(), { paths: ["src/gamma.ts"] });
    assert.equal(result.code, EXIT_USAGE);
    assert.match(result.err, /--path matched no analyzed source file: src\/gamma\.ts/);
    assert.equal(result.out, "");
  });

  it("refuses to WRITE a scoped report, and writes nothing at all", () => {
    // A partial critical set is not read as partial downstream: every function
    // outside the scope simply stops being critical, and two gates go quiet.
    const root = twoFileProject();
    const result = criticality(root, { write: true, paths: ["src/beta.ts"] });
    assert.equal(result.code, EXIT_USAGE);
    assert.match(result.err, /--write cannot be combined with --path/);
    assert.equal(existsSync(criticalityPath(root)), false);
    assert.equal(existsSync(join(root, "CRITICALITY.md")), false);
  });

  it("still writes the full report when no path narrows it", () => {
    const root = twoFileProject();
    const result = criticality(root, { write: true });
    assert.equal(result.code, EXIT_OK);
    assert.match(result.out, /Wrote /);
    assert.equal(criticalityFreshness(root), "fresh");
  });
});
