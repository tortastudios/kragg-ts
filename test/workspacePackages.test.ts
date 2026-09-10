/**
 * TOR-1371: bounded package-level checking — `check --package` and
 * `security --package` — and the notice a root run prints about the members
 * it did not check.
 *
 * The failure reproduced on the base commit: a pnpm workspace with
 * `packages/a` and `packages/b`, each with its own tsconfig and its own
 * `typescript`, one holding a type error. The root run errored on the missing
 * root tsconfig, resolved the root's compiler for everything, and never
 * mentioned either package; `b`'s error was invisible.
 *
 * Three layers, each asserting what the layer above cannot:
 *
 *  - `selectWorkspacePackage` — how a `--package` value becomes a member;
 *  - `runPackages` over canned gates — policy and environment inheritance,
 *    per-member journals, exit-code aggregation, and that every usage error
 *    is found before any gate runs;
 *  - the CLI end to end, with a real `tsc` — one report per member, the
 *    member's own diagnostics, the compiler line, the root-run notice, and the
 *    flag combinations that are refused. Both members fail `tsc` on purpose,
 *    so the slow tier (which includes the network-bound `audit`) never runs
 *    and the test is deterministic offline.
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { errorGate, nativeGate } from "../src/catalog/results.ts";
import { runPackages, type Assemble } from "../src/commands/packages.ts";
import type { ReportFlags } from "../src/commands/pipeline.ts";
import { FAST } from "../src/engine/gate.ts";
import { journalPath } from "../src/engine/journal.ts";
import {
  EXIT_ENVIRONMENT,
  EXIT_GATE_FAILURES,
  EXIT_OK,
  EXIT_USAGE,
} from "../src/engine/report.ts";
import type { ReportPayload } from "../src/engine/reportPayload.ts";
import { runCommand } from "../src/engine/runner.ts";
import { detectWorkspaces } from "../src/environment/project.ts";
import { selectWorkspacePackage } from "../src/environment/workspaces.ts";
import type { KraggPolicy } from "../src/policy/policy.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TSC_ENTRY = fileURLToPath(new URL("../node_modules/typescript/lib/tsc.js", import.meta.url));

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(files: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-workspace-"));
  roots.push(root);
  mkdirSync(join(root, ".git"), { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    put(root, name, contents);
  }
  return root;
}

function put(root: string, name: string, contents: string): void {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

const POLICY = '{"lint_tool":"off","test_runner":"off","secret_scanner":"off","coverage_fail_under":0}';

describe("selectWorkspacePackage", () => {
  function workspace(): string {
    return project({
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "packages/a/package.json": '{"name":"@ws/a"}',
      "packages/b/package.json": "{}",
      "extra/c/package.json": '{"name":"c"}',
    });
  }

  it("resolves a member by name or by root-relative path", () => {
    const root = workspace();
    const info = detectWorkspaces(root);
    for (const selector of ["@ws/a", "packages/a", "./packages/a/"]) {
      const selected = selectWorkspacePackage(root, info, selector);
      assert.equal(selected.ok, true, selector);
      if (selected.ok) {
        assert.equal(selected.package.root, join(root, "packages", "a"));
        assert.equal(selected.package.name, "@ws/a");
      }
    }
  });

  it("accepts a directory holding a package.json even when no pattern lists it", () => {
    const root = workspace();
    const selected = selectWorkspacePackage(root, detectWorkspaces(root), "extra/c");
    assert.equal(selected.ok, true);
    if (selected.ok) {
      assert.equal(selected.package.name, "c");
      assert.equal(selected.package.path, "extra/c");
    }
  });

  it("refuses an unknown selector, listing what it knows, and never the root itself", () => {
    const root = workspace();
    const info = detectWorkspaces(root);
    const selected = selectWorkspacePackage(root, info, "nope");
    assert.equal(selected.ok, false);
    if (!selected.ok) {
      assert.match(
        selected.reason,
        /no such package name or directory \(known packages: @ws\/a, packages\/b\)/u,
      );
    }
    assert.equal(selectWorkspacePackage(root, info, ".").ok, false);
  });

  it("repeats why names cannot be resolved when the declaration was refused", () => {
    const root = project({ "pnpm-workspace.yaml": "packages: [a]\n", "a/package.json": "{}" });
    const info = detectWorkspaces(root);
    const byName = selectWorkspacePackage(root, info, "a-name");
    assert.equal(byName.ok, false);
    if (!byName.ok) {
      assert.match(byName.reason, /names cannot be resolved because pnpm-workspace\.yaml line 1/u);
    }
    assert.equal(selectWorkspacePackage(root, info, "a").ok, true, "a path still works");
  });
});

describe("runPackages over canned gates", () => {
  /** Everything `assemble` was handed, per member, so inheritance is observable. */
  interface Seen {
    readonly root: string;
    readonly policy: KraggPolicy;
    readonly packageManager: string;
    readonly source: string;
  }

  function flagsFor(root: string, packages: readonly string[]): ReportFlags {
    return {
      root,
      targets: [],
      format: "json",
      maxViolations: undefined,
      journal: true,
      failFast: false,
      all: false,
      packages,
    };
  }

  /** A workspace with a lockfile at the root and two members, `a` with its own policy. */
  function workspace(): string {
    return project({
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "kragg.json": '{"profile":"root-policy"}',
      "packages/a/package.json": '{"name":"@ws/a"}',
      "packages/a/kragg.json": '{"profile":"member-policy"}',
      "packages/b/package.json": '{"name":"@ws/b"}',
    });
  }

  /** An `assemble` that records its inputs and answers with `outcomeFor(root)`. */
  function canned(seen: Seen[], outcomeFor: (root: string) => "pass" | "fail" | "error"): Assemble {
    return async (flags, policy, env) => {
      seen.push({ root: flags.root, policy, packageManager: env.packageManager, source: env.source });
      const outcome = outcomeFor(flags.root);
      return {
        ok: true,
        scope: { targets: ["src"], paths: undefined, mode: "full", note: undefined },
        run: () => ({
          command: "check",
          mode: "full",
          policy,
          targets: ["src"],
          flags,
          specs: [
            {
              name: "canned",
              tier: FAST,
              run: () =>
                outcome === "pass"
                  ? nativeGate("canned", [])
                  : outcome === "fail"
                    ? nativeGate("canned", [{ message: "found", file: "src/a.ts" }])
                    : errorGate("canned", "could not run"),
            },
          ],
        }),
      };
    };
  }

  it("runs each member with its own root, its own or the root's policy, and the root's manager", async () => {
    const root = workspace();
    const seen: Seen[] = [];
    const code = await runPackages(flagsFor(root, ["@ws/a", "packages/b", "@ws/a"]), canned(seen, () => "pass"));
    assert.equal(code, EXIT_OK);
    assert.deepEqual(
      seen.map((entry) => [entry.root, entry.policy.profile, entry.packageManager]),
      [
        [join(root, "packages", "a"), "member-policy", "pnpm"],
        [join(root, "packages", "b"), "root-policy", "pnpm"],
      ],
      "a repeated selector runs once; a member without a policy inherits the ROOT's, not the defaults",
    );
    assert.match(seen[1]?.source ?? "", /inherited from the workspace root/u);
    // Each member journals under ITS OWN `.kragg/`, where its `kragg status` reads.
    for (const member of ["a", "b"]) {
      const journal = journalPath(join(root, "packages", member));
      assert.ok(existsSync(journal), `${member} has a journal`);
      assert.match(readFileSync(journal, "utf8"), /"command": ?"check"/u);
    }
    assert.equal(existsSync(journalPath(root)), false, "the root ran nothing");
  });

  it("returns the worst member's exit code: environment over findings over clean", async () => {
    const root = workspace();
    const outcomes = new Map<string, "pass" | "fail" | "error">([
      [join(root, "packages", "a"), "fail"],
      [join(root, "packages", "b"), "pass"],
    ]);
    const pick = (memberRoot: string): "pass" | "fail" | "error" => outcomes.get(memberRoot) ?? "pass";
    const flags = { ...flagsFor(root, ["@ws/a", "@ws/b"]), journal: false };
    assert.equal(await runPackages(flags, canned([], pick)), EXIT_GATE_FAILURES);
    outcomes.set(join(root, "packages", "b"), "error");
    assert.equal(await runPackages(flags, canned([], pick)), EXIT_ENVIRONMENT);
  });

  it("refuses the whole invocation with exit 2 before ANY gate runs when a member cannot be assembled", async () => {
    const root = workspace();
    const seen: Seen[] = [];
    let gatesRan = 0;
    const assemble: Assemble = async (flags, policy, env) => {
      seen.push({ root: flags.root, policy, packageManager: env.packageManager, source: env.source });
      if (flags.root.endsWith("b")) {
        return { ok: false, exit: EXIT_USAGE, message: "the policy's `tsconfig` setting names nope.json, which does not exist" };
      }
      return {
        ok: true,
        scope: { targets: ["src"], paths: undefined, mode: "full", note: undefined },
        run: () => ({
          command: "check",
          mode: "full",
          policy,
          targets: ["src"],
          flags,
          specs: [{ name: "canned", tier: FAST, run: () => { gatesRan += 1; return nativeGate("canned", []); } }],
        }),
      };
    };
    assert.equal(await runPackages(flagsFor(root, ["@ws/a", "@ws/b"]), assemble), EXIT_USAGE);
    assert.equal(seen.length, 2, "both members were assembled");
    assert.equal(gatesRan, 0, "and none of them ran");
    assert.equal(existsSync(journalPath(join(root, "packages", "a"))), false);
  });

  it("refuses an unknown member and a malformed member policy with exit 2", async () => {
    const root = workspace();
    assert.equal(await runPackages(flagsFor(root, ["nope"]), canned([], () => "pass")), EXIT_USAGE);
    put(root, "packages/b/kragg.json", '{"lint_tool":"oxlnt"}');
    await assert.rejects(
      runPackages(flagsFor(root, ["@ws/b"]), canned([], () => "pass")),
      /lint_tool must be one of/u,
      "a PolicyError, which the CLI maps to exit 2",
    );
  });
});

describe("the CLI end to end", () => {
  interface Captured {
    readonly code: number;
    readonly out: string;
    readonly err: string;
  }

  async function run(argv: readonly string[], root: string): Promise<Captured> {
    const result = await runCommand("kragg", [process.execPath, CLI, ...argv], root);
    return { code: result.returncode, out: result.stdout, err: result.stderr };
  }

  const MEMBER_TSCONFIG = JSON.stringify({
    compilerOptions: {
      target: "es2023",
      lib: ["es2023"],
      module: "nodenext",
      moduleResolution: "nodenext",
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      verbatimModuleSyntax: true,
      isolatedModules: true,
      noEmit: true,
      types: [],
    },
    include: ["src"],
  });

  /** Two members, each with its own real `tsc` and its own type error. */
  function workspace(): string {
    const root = project({
      "package.json": '{"name":"root","private":true,"workspaces":["packages/*"],"packageManager":"pnpm@11.0.0"}',
      "kragg.json": POLICY,
    });
    const bodies = {
      a: "export const a: string = 1;\n",
      b: "export function broken(n: number): string {\n  return n;\n}\n",
    };
    for (const [name, body] of Object.entries(bodies)) {
      put(root, `packages/${name}/package.json`, `{"name":"@ws/${name}","private":true,"type":"module"}`);
      put(root, `packages/${name}/tsconfig.json`, MEMBER_TSCONFIG);
      put(root, `packages/${name}/src/index.ts`, body);
      put(root, `packages/${name}/node_modules/.bin/tsc`, `#!${process.execPath}\nimport(${JSON.stringify(TSC_ENTRY)});\n`);
      chmodSync(join(root, "packages", name, "node_modules", ".bin", "tsc"), 0o755);
    }
    return root;
  }

  it("a root run says on stderr which members it did NOT check", async () => {
    const root = workspace();
    const result = await run(["check", "--no-journal", "--format", "json"], root);
    assert.match(
      result.err,
      /checked only the root package, NOT its 2 member packages \(packages\/a \(@ws\/a\), packages\/b \(@ws\/b\)\)/u,
    );
    assert.match(result.err, /--package <name-or-path>/u);
    const payload: ReportPayload = JSON.parse(result.out);
    assert.deepEqual(payload.targets, ["src"], "the root's own scope, unchanged");
  });

  it("checks each selected member as its own run and reports the member's own diagnostics", async () => {
    const root = workspace();
    const result = await run(
      ["check", "--no-journal", "--format", "json", "--package", "@ws/a", "--package", "packages/b"],
      root,
    );
    assert.equal(result.code, EXIT_GATE_FAILURES, result.err);
    const payloads: ReportPayload[] = JSON.parse(result.out);
    assert.equal(payloads.length, 2, "one payload per member, the unchanged schema each");
    const tsc = payloads.map((payload) => payload.gates.find((gate) => gate.name === "tsc"));
    assert.equal(tsc[0]?.violations[0]?.line, 1, "a's error is on line 1");
    assert.equal(tsc[1]?.violations[0]?.line, 2, "b's error is on line 2");
    assert.equal(tsc[1]?.violations[0]?.code, "TS2322");
    assert.deepEqual(payloads.map((payload) => payload.targets), [["src"], ["src"]]);
    assert.match(result.err, /packages\/a: compiler: typescript \d/u);
    assert.match(result.err, /packages\/b: compiler: typescript \d/u);
  });

  it("renders one text section per member, the compiler used, and a workspace summary", async () => {
    const root = workspace();
    const result = await run(["check", "--no-journal", "--package", "packages/a", "--package", "packages/b"], root);
    assert.equal(result.code, EXIT_GATE_FAILURES);
    assert.match(result.out, /^== package packages\/a \(@ws\/a\) ==$/mu);
    assert.match(result.out, /^== package packages\/b \(@ws\/b\) ==$/mu);
    assert.match(result.out, /^compiler: typescript \d+\.\d+\.\d+ /mu);
    assert.match(result.out, /^== workspace: 2 packages checked: packages\/a failed, packages\/b failed ==$/mu);
  });

  it("refuses an unknown member, and the flag combinations it cannot honour, with exit 2", async () => {
    const root = workspace();
    const unknown = await run(["check", "--no-journal", "--package", "nope"], root);
    assert.equal(unknown.code, EXIT_USAGE);
    assert.match(unknown.err, /--package nope: no such package name or directory \(known packages: @ws\/a, @ws\/b\)/u);
    assert.equal(unknown.out, "");
    for (const argv of [["--changed"], ["--file", "packages/a/src/index.ts"], ["--since", "HEAD"]]) {
      const result = await run(["check", "--package", "@ws/a", ...argv], root);
      assert.equal(result.code, EXIT_USAGE, argv.join(" "));
      assert.match(result.err, /--package cannot be combined with/u);
    }
    assert.equal((await run(["status", "--package", "@ws/a"], root)).code, EXIT_USAGE);
  });

  it("refuses the whole invocation when one member's configured tsconfig is missing", async () => {
    const root = workspace();
    put(root, "packages/b/kragg.json", '{"tsconfig":"tsconfig.app.json","lint_tool":"off","test_runner":"off","secret_scanner":"off"}');
    const result = await run(
      ["check", "--no-journal", "--format", "json", "--package", "@ws/a", "--package", "@ws/b"],
      root,
    );
    assert.equal(result.code, EXIT_USAGE);
    assert.match(result.err, /packages\/b: the policy's `tsconfig` setting names tsconfig\.app\.json, which does not exist/u);
    assert.equal(result.out, "", "no member ran");
  });

  it("security --package goes through the same runner", async () => {
    const root = workspace();
    // `forbidden-calls` is the security gate that reads the member's program;
    // banning a call the member makes proves the program is the member's.
    put(root, "kragg.json", `${POLICY.slice(0, -1)},"forbidden_calls":{"eval":"no"}}`);
    put(root, "packages/a/src/index.ts", 'export const a: unknown = eval("1");\n');
    const result = await run(["security", "--no-journal", "--format", "json", "--package", "@ws/a"], root);
    assert.equal(result.code, EXIT_GATE_FAILURES, result.err);
    const payloads: ReportPayload[] = JSON.parse(result.out);
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0]?.command, "security");
    const forbidden = payloads[0]?.gates.find((gate) => gate.name === "forbidden-calls");
    assert.equal(forbidden?.passed, false);
    assert.equal(forbidden?.violations[0]?.file, "src/index.ts");
  });
});
