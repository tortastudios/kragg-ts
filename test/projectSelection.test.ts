/**
 * TOR-1371: ONE tsconfig per run, selected by the policy, read by every
 * type-aware surface — and a solution-style file refused by all of them.
 *
 * The failures these pin, all reproduced on the base commit:
 *
 *  - a project configured by `tsconfig.base.json` + `tsconfig.app.json` with
 *    no `tsconfig.json` had no way to be checked at all: `tsc` errored,
 *    `typing-strictness` wrote `tsconfig-missing`, the program would not build;
 *  - a solution-style root (`references`, no inputs) made `tsc -p` exit 0
 *    having checked nothing, so the `tsc` gate reported PASS while the
 *    referenced project had a real type error, and `typing-strictness` judged
 *    the solution file's empty `compilerOptions` as four violations;
 *  - the freshness stamp hashed `tsconfig.json` by name, so a program built
 *    from any other file was fingerprinted by a file it never read.
 *
 * The typing-strictness half is in `typingStrictness.test.ts`; the
 * `boundaries` alias table in `architecture.test.ts`.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import ts from "typescript";

import { runTypeCheck } from "../src/adapters/tsc.ts";
import { analysisProgram, programFileNames, readProjectConfig } from "../src/analysis/program.ts";
import { catalogContext } from "../src/catalog/context.ts";
import { runDoctor } from "../src/commands/doctor.ts";
import { resolveScope } from "../src/commands/scope.ts";
import { EXIT_USAGE } from "../src/engine/report.ts";
import {
  DEFAULT_TSCONFIG,
  projectTsconfig,
  resolveProjectEnvironment,
} from "../src/environment/project.ts";
import {
  criticalityFreshness,
  criticalityPath,
  writeJson,
  writeStamp,
} from "../src/gates/criticality.ts";
import { checkLayers } from "../src/gates/architecture.ts";
import { clearAliasCache } from "../src/gates/architecture.ts";
import { DEFAULT_POLICY, loadPolicy } from "../src/policy/policy.ts";

const roots: string[] = [];

after(() => {
  clearAliasCache();
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(files: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-selection-"));
  roots.push(root);
  mkdirSync(join(root, ".git"), { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

const STRICT = JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, module: "nodenext", target: "es2022", types: [] },
});

/** The Vite template's root: references only, no inputs of its own. */
const SOLUTION: Readonly<Record<string, string>> = {
  "tsconfig.json": JSON.stringify({
    files: [],
    references: [{ path: "./tsconfig.app.json" }, { path: "./tsconfig.node.json" }],
  }),
  "tsconfig.app.json": JSON.stringify({
    compilerOptions: { composite: true, strict: true },
    include: ["src"],
  }),
  "tsconfig.node.json": JSON.stringify({
    compilerOptions: { composite: true },
    files: ["vite.config.ts"],
  }),
  "src/a.ts": "export const a = 1;\n",
  "vite.config.ts": "export default {};\n",
};

/** A stand-in `tsc` that prints `stdout` and exits `status`. */
function fakeTsc(root: string, stdout: string, status: number): void {
  const path = join(root, "node_modules", ".bin", "tsc");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\ncat <<'KRAGG_EOF'\n${stdout}\nKRAGG_EOF\nexit ${status}\n`, {
    mode: 0o755,
  });
}

/** Capture synchronous stdout, the way `commands.test.ts` does. */
function capture<T>(fn: () => T): { readonly value: T; readonly out: string } {
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

describe("the policy's `tsconfig` setting", () => {
  it("defaults to tsc's own project file, spelled once for every consumer", () => {
    assert.equal(DEFAULT_POLICY.tsconfig, DEFAULT_TSCONFIG);
    assert.equal(DEFAULT_TSCONFIG, "tsconfig.json");
  });

  it("reads a root-relative path, resolves it once, and rejects an empty one by name", () => {
    const root = project({ "kragg.json": '{"tsconfig":"config/tsconfig.app.json"}' });
    const policy = loadPolicy(root);
    assert.equal(policy.tsconfig, "config/tsconfig.app.json");
    assert.equal(projectTsconfig(root, policy.tsconfig), join(root, "config", "tsconfig.app.json"));
    writeFileSync(join(root, "kragg.json"), '{"tsconfig":""}');
    assert.throws(() => loadPolicy(root), /kragg\.json#tsconfig must be a non-empty path/u);
  });

  it("is a USAGE error (exit 2) when the configured file does not exist", async () => {
    const root = project({ "kragg.json": '{"tsconfig":"tsconfig.app.json"}' });
    const request = { root, targets: [], changed: false, since: null };
    const result = await resolveScope(request, loadPolicy(root));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.exit, EXIT_USAGE);
      assert.match(
        result.message,
        /`tsconfig` setting names tsconfig\.app\.json, which does not exist/u,
      );
    }
    // The DEFAULT is not a setting anyone wrote: its absence is a finding for
    // the gates (`tsconfig-missing`, a `tsc` error), not a refusal to run.
    assert.equal((await resolveScope(request, DEFAULT_POLICY)).ok, true);
  });
});

describe("the program tier", () => {
  it("builds the program from the SELECTED tsconfig, not from tsconfig.json", () => {
    const root = project({
      "tsconfig.base.json": STRICT,
      "tsconfig.app.json": JSON.stringify({ extends: "./tsconfig.base.json", include: ["src"] }),
      "src/a.ts": "export const a = 1;\n",
    });
    const handle = analysisProgram({ root, tsconfigPath: "tsconfig.app.json", api: ts });
    assert.equal(handle.tsconfigPath, join(root, "tsconfig.app.json"));
    const load = handle.load();
    assert.ok(load.ok, load.ok ? "" : load.message);
    if (load.ok) {
      assert.deepEqual(
        programFileNames(load.program).map((file) => file.split("/").pop()),
        ["a.ts"],
      );
    }
    const unselected = analysisProgram({ root, api: ts }).load();
    assert.equal(unselected.ok, false);
    if (!unselected.ok) {
      assert.match(unselected.message, /no tsconfig\.json at/u);
      assert.match(unselected.message, /set `tsconfig` in kragg\.json/u);
    }
  });

  it("refuses a solution-style tsconfig instead of building an EMPTY program", () => {
    const root = project(SOLUTION);
    const load = analysisProgram({ root, api: ts }).load();
    assert.equal(load.ok, false);
    if (!load.ok) {
      assert.match(load.message, /solution-style/u);
      assert.match(load.message, /2 project references \(tsconfig\.app\.json, tsconfig\.node\.json\)/u);
      assert.match(load.message, /"tsconfig": "tsconfig\.app\.json"/u);
    }
    const config = readProjectConfig(ts, join(root, "tsconfig.json"));
    assert.equal(config.ok, false);
    if (!config.ok) {
      assert.equal(config.kind, "solution");
    }
    // Selecting a referenced project is the fix, and it works.
    assert.equal(analysisProgram({ root, tsconfigPath: "tsconfig.app.json", api: ts }).load().ok, true);
  });

  it("classifies every way a config can be unusable, so consumers branch on a kind", () => {
    const root = project({
      "empty.json": JSON.stringify({ include: ["nope"] }),
      "broken.json": "{ not json",
      "invalid.json": JSON.stringify({ compilerOptions: { noSuchOption: true }, include: ["src"] }),
      "src/a.ts": "export const a = 1;\n",
    });
    const kinds = ["missing.json", "broken.json", "invalid.json", "empty.json"].map((name) => {
      const config = readProjectConfig(ts, join(root, name));
      return config.ok ? "ok" : config.kind;
    });
    assert.deepEqual(kinds, ["missing", "unreadable", "invalid", "empty"]);
  });

  it("is what the run context builds, from the policy, still lazily", () => {
    const root = project();
    const ctx = catalogContext({
      root,
      policy: { ...DEFAULT_POLICY, tsconfig: "config/tsconfig.app.json" },
      env: resolveProjectEnvironment(root),
      targets: ["src"],
    });
    assert.equal(ctx.program.tsconfigPath, join(root, "config", "tsconfig.app.json"));
    assert.equal(ctx.program.loaded(), false);
  });
});

describe("the tsc gate", () => {
  const withManager = (files: Readonly<Record<string, string>>): string =>
    project({ ...files, "package.json": '{"packageManager":"pnpm@11.0.0"}' });

  it("refuses a solution-style project BEFORE spawning the compiler", async () => {
    const root = withManager(SOLUTION);
    // The stand-in exits 0 with no output — exactly what the real compiler
    // does on a solution file (verified against typescript 6.0.3) — so a gate
    // that spawned it would report [PASS] tsc over an unchecked project.
    fakeTsc(root, "", 0);
    const outcome = await runTypeCheck({ env: resolveProjectEnvironment(root) });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.match(outcome.message, /solution-style/u);
      assert.match(outcome.message, /The type-check gate did not run/u);
      assert.equal(outcome.command, undefined, "nothing was spawned");
    }
  });

  it("type-checks the referenced project once it is the one selected", async () => {
    const root = withManager(SOLUTION);
    fakeTsc(root, "src/a.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.", 2);
    const outcome = await runTypeCheck({
      env: resolveProjectEnvironment(root),
      project: "tsconfig.app.json",
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.command.at(-1), "tsconfig.app.json");
      assert.equal(outcome.violations.length, 1);
    }
  });
});

describe("the boundaries alias table", () => {
  const LAYERS = ["src/entrypoints", "src/domain"];

  it("reads `paths` from the SELECTED tsconfig", () => {
    // `@/…` is declared only in tsconfig.app.json. Read off the (absent)
    // root tsconfig.json the specifier is external and the breach invisible.
    const root = project({
      "tsconfig.app.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
        include: ["src"],
      }),
      "src/entrypoints/high.ts": "export const High = 1;\n",
      "src/domain/low.ts": 'import { High } from "@/entrypoints/high.ts";\nexport const low = High;\n',
    });
    clearAliasCache();
    const unselected = checkLayers(root, ["src"], LAYERS);
    assert.deepEqual(unselected, [], "without the alias table the import reads as a package");
    const selected = checkLayers(root, ["src"], LAYERS, "tsconfig.app.json");
    assert.equal(selected.length, 1);
    assert.equal(selected[0]?.code, "layer-breach");
    clearAliasCache();
  });
});

describe("the criticality stamp", () => {
  function writeData(root: string): void {
    writeJson([], criticalityPath(root));
  }

  it("goes stale when the policy switches to another tsconfig, both files untouched", () => {
    const root = project({
      "src/a.ts": "export const a = 1;\n",
      "tsconfig.json": STRICT,
      "tsconfig.app.json": STRICT,
    });
    writeData(root);
    writeStamp(root, ["src"]);
    assert.equal(criticalityFreshness(root), "fresh");
    writeFileSync(join(root, "kragg.json"), '{"tsconfig":"tsconfig.app.json"}');
    assert.equal(criticalityFreshness(root), "stale", "the program is now built from another file");
  });

  it("watches the selected file's bytes, not tsconfig.json's", () => {
    const root = project({
      "src/a.ts": "export const a = 1;\n",
      "kragg.json": '{"tsconfig":"tsconfig.app.json"}',
      "tsconfig.json": STRICT,
      "tsconfig.app.json": STRICT,
    });
    writeData(root);
    writeStamp(root, ["src"]);
    assert.equal(criticalityFreshness(root), "fresh");
    writeFileSync(join(root, "tsconfig.json"), "{}");
    assert.equal(criticalityFreshness(root), "fresh", "a file the program never reads");
    writeFileSync(join(root, "tsconfig.app.json"), "{}");
    assert.equal(criticalityFreshness(root), "stale", "the file the program is built from");
  });
});

describe("doctor", () => {
  it("names the selected tsconfig and the compiler it would analyze with", () => {
    const root = project({
      "package.json": '{"name":"a","packageManager":"pnpm@9.0.0"}',
      "kragg.json": '{"tsconfig":"tsconfig.app.json"}',
      "tsconfig.app.json": "{}",
    });
    const result = capture(() => runDoctor(root));
    assert.match(result.out, /^tsconfig \(tsconfig\.app\.json\): ok$/mu);
    assert.match(result.out, /^compiler:\s+typescript \d+\.\d+\.\d+ \(bundled\)$/mu);
    assert.match(result.out, /note: no project-local typescript/u);
  });

  it("lists a workspace's members and says a root run does not check them", () => {
    const root = project({
      "package.json": '{"name":"root","packageManager":"pnpm@9.0.0","workspaces":["packages/*"]}',
      "packages/a/package.json": '{"name":"@ws/a"}',
    });
    const result = capture(() => runDoctor(root));
    assert.match(result.out, /workspaces:\s+package-json, 1 packages: packages\/a \(@ws\/a\)/u);
    assert.match(result.out, /a root run checks only the root package; run `kragg check --package/u);
  });
});
