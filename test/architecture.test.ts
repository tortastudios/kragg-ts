/**
 * Tests for the architecture gates.
 *
 * The load-bearing properties, in priority order:
 *
 *  - a breach is REPORTED (the Python parity cases: message, code, fix hint);
 *  - the TypeScript-only escape routes — path aliases, barrel files, bare
 *    specifiers — do not turn a breach into a silent pass, because a false
 *    pass is the only failure this gate cannot be trusted through;
 *  - barrel following stays NAME-AWARE, so a barrel that touches a higher
 *    layer does not implicate every importer of that barrel. A gate that
 *    cries wolf gets switched off, which is a false pass with extra steps;
 *  - a specifier that genuinely cannot be resolved becomes noise
 *    (`layer-unresolved`), never silence.
 *
 * Projects are written to real temp directories rather than mocked: alias
 * resolution and barrel following both hit the filesystem, and stubbing that
 * out would test the stub.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { clearCompilerCache, resolveTypeScript } from "../src/analysis/sourceFile.ts";
import type { Violation } from "../src/engine/models.ts";
import { checkLayers, checkStructure, clearAliasCache } from "../src/gates/architecture.ts";
import { existingFile, loadAliases } from "../src/gates/architecture/aliases.ts";
import {
  layerIndex,
  parseCached,
  resolveTarget,
  type ResolveContext,
} from "../src/gates/architecture/resolve.ts";

/** Layers used throughout: modules are named relative to the REPO ROOT. */
const LAYERS: readonly string[] = ["src/entrypoints", "src/services", "src/domain"];

const HIGH = "src/entrypoints/high.ts";
const HIGH_SOURCE = "export const High = 1;\nexport const Other = 2;\n";

const temporaryRoots: string[] = [];

after(() => {
  clearAliasCache();
  clearCompilerCache();
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-architecture-"));
  temporaryRoots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

function only(violations: readonly Violation[]): Violation {
  assert.equal(violations.length, 1, `expected one violation, got ${describeAll(violations)}`);
  const first = violations[0];
  assert.ok(first !== undefined);
  return first;
}

function describeAll(violations: readonly Violation[]): string {
  return JSON.stringify(violations.map((violation) => `${violation.code ?? "?"}: ${violation.message}`));
}

/** Run the layer gate over a one-consumer project importing `src/entrypoints`. */
function breachOf(consumerSource: string, extra: Readonly<Record<string, string>> = {}): Violation {
  const root = project({
    [HIGH]: HIGH_SOURCE,
    "src/domain/consumer.ts": consumerSource,
    ...extra,
  });
  return only(checkLayers(root, ["src"], LAYERS));
}

describe("checkLayers", () => {
  it("does nothing with fewer than two layers", () => {
    const root = project({
      [HIGH]: HIGH_SOURCE,
      "src/domain/consumer.ts": 'import { High } from "../entrypoints/high.ts";\nexport const x = High;\n',
    });
    assert.deepEqual(checkLayers(root, ["src"], ["src/entrypoints"]), []);
    assert.deepEqual(checkLayers(root, ["src"], []), []);
  });

  it("reports an upward import with the Python message, code and fix hint", () => {
    const violation = breachOf(
      'import { High } from "../entrypoints/high.ts";\nexport const x = High;\n',
    );
    assert.equal(
      violation.message,
      "src/domain/consumer (layer `src/domain`) imports " +
        "src/entrypoints/high (layer `src/entrypoints`)",
    );
    assert.equal(violation.code, "layer-breach");
    assert.equal(violation.file, "src/domain/consumer.ts");
    assert.equal(violation.line, 1);
    assert.equal(
      violation.fixHint,
      "lower layers must not import higher layers; " +
        "invert the dependency or move the shared code down",
    );
  });

  it("allows same-layer and downward imports", () => {
    const root = project({
      "src/entrypoints/a.ts": 'import { S } from "../services/s.ts";\nimport { B } from "./b.ts";\nexport const x = S + B;\n',
      "src/entrypoints/b.ts": "export const B = 1;\n",
      "src/services/s.ts": 'import { D } from "../domain/d.ts";\nexport const S = D;\n',
      "src/domain/d.ts": "export const D = 1;\n",
    });
    assert.deepEqual(checkLayers(root, ["src"], LAYERS), []);
  });

  it("leaves modules outside every layer unrestricted", () => {
    const root = project({
      [HIGH]: HIGH_SOURCE,
      "src/scripts/tool.ts": 'import { High } from "../entrypoints/high.ts";\nexport const x = High;\n',
    });
    assert.deepEqual(checkLayers(root, ["src"], LAYERS), []);
  });

  it("reports `export ... from` re-exports, which are breaches too", () => {
    const violation = breachOf('export { High } from "../entrypoints/high.ts";\n');
    assert.equal(violation.code, "layer-breach");
    assert.match(violation.message, /imports src\/entrypoints\/high/u);
  });

  it("reports dynamic import() and require()", () => {
    const dynamic = breachOf('export const p = import("../entrypoints/high.ts");\n');
    assert.equal(dynamic.code, "layer-breach");

    const required = breachOf('export const h = require("../entrypoints/high.ts");\n');
    assert.equal(required.code, "layer-breach");
  });

  it("reports a side-effect import, which binds no name at all", () => {
    // `moduleImports` deliberately drops this form (nothing to bind); the
    // dedicated walk keeps it, because it is still a runtime dependency.
    const violation = breachOf('import "../entrypoints/high.ts";\nexport const x = 1;\n');
    assert.equal(violation.code, "layer-breach");
  });
});

describe("checkLayers / import type", () => {
  it("still reports a type-only import, under its own code", () => {
    const violation = breachOf(
      'import type { High } from "../entrypoints/high.ts";\nexport type X = typeof High;\n',
    );
    assert.equal(violation.code, "layer-breach-type");
    assert.match(violation.message, /\(type-only\)$/u);
  });

  it("treats an all-`type` specifier list as type-only", () => {
    const violation = breachOf(
      'import { type High, type Other } from "../entrypoints/high.ts";\n' +
        "export type X = typeof High | typeof Other;\n",
    );
    assert.equal(violation.code, "layer-breach-type");
  });

  it("treats a mixed list as a value import — the runtime binding wins", () => {
    const violation = breachOf(
      'import { type High, Other } from "../entrypoints/high.ts";\nexport const x = Other;\n',
    );
    assert.equal(violation.code, "layer-breach");
    assert.doesNotMatch(violation.message, /type-only/u);
  });

  it("reports `export type ... from` as type-only", () => {
    const violation = breachOf('export type { High } from "../entrypoints/high.ts";\n');
    assert.equal(violation.code, "layer-breach-type");
  });
});

describe("checkLayers / path aliases", () => {
  const TSCONFIG = JSON.stringify({
    compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
  });

  it("resolves a tsconfig `paths` alias before matching layers", () => {
    // The whole point: a raw prefix match on "@/entrypoints/high" sees no
    // layer at all and would pass this silently.
    const violation = breachOf('import { High } from "@/entrypoints/high";\nexport const x = High;\n', {
      "tsconfig.json": TSCONFIG,
    });
    assert.equal(violation.code, "layer-breach");
    assert.match(violation.message, /imports src\/entrypoints\/high/u);
  });

  it("resolves a bare specifier through `baseUrl`", () => {
    const violation = breachOf('import { High } from "src/entrypoints/high";\nexport const x = High;\n', {
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "." } }),
    });
    assert.equal(violation.code, "layer-breach");
  });

  it("falls back to matching a bare specifier against the layers themselves", () => {
    // No tsconfig at all: the specifier is prefixed by a declared layer, so
    // it is judged rather than waved through.
    const violation = breachOf('import { High } from "src/entrypoints/high";\nexport const x = High;\n');
    assert.equal(violation.code, "layer-breach");
  });

  it("leaves real packages and node builtins alone", () => {
    const root = project({
      "tsconfig.json": TSCONFIG,
      "src/domain/d.ts": 'import { readFileSync } from "node:fs";\nimport x from "left-pad";\nexport const y = [readFileSync, x];\n',
    });
    assert.deepEqual(checkLayers(root, ["src"], LAYERS), []);
  });

  it("reports an unpinnable alias as unresolved rather than unrestricted", () => {
    const root = project({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@x/*": ["src/entrypoints/*", "src/domain/*"] },
        },
      }),
      "src/domain/consumer.ts": 'import { Gone } from "@x/gone";\nexport const x = Gone;\n',
    });
    const violation = only(checkLayers(root, ["src"], LAYERS));
    assert.equal(violation.code, "layer-unresolved");
    assert.equal(violation.file, "src/domain/consumer.ts");
    assert.match(violation.message, /different layers/u);
  });

  it("does not cry unresolved when every candidate lands in the same layer", () => {
    const root = project({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@y/*": ["src/domain/a/*", "src/domain/b/*"] },
        },
      }),
      "src/entrypoints/e.ts": 'import { Gone } from "@y/gone";\nexport const x = Gone;\n',
    });
    assert.deepEqual(checkLayers(root, ["src"], LAYERS), []);
  });

  it("prefers the longest matching alias prefix, as the compiler does", () => {
    const violation = breachOf('import { High } from "@/deep/high";\nexport const x = High;\n', {
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@/*": ["src/domain/*"], "@/deep/*": ["src/entrypoints/*"] },
        },
      }),
    });
    assert.equal(violation.code, "layer-breach");
    assert.match(violation.message, /imports src\/entrypoints\/high/u);
  });
});

describe("checkLayers / barrel files", () => {
  /** A barrel at `src/index.ts` is module `src`, which is in no layer at all. */
  const BARREL = "src/index.ts";
  const BARREL_SOURCE =
    'export { High } from "./entrypoints/high.ts";\nexport { Low } from "./domain/low.ts";\n';
  const LOW = "src/domain/low.ts";
  const LOW_SOURCE = "export const Low = 1;\n";

  it("follows a re-export chain to the module that really owns the symbol", () => {
    const root = project({
      [HIGH]: HIGH_SOURCE,
      [LOW]: LOW_SOURCE,
      [BARREL]: BARREL_SOURCE,
      "src/domain/consumer.ts": 'import { High } from "../index.ts";\nexport const x = High;\n',
    });
    const violation = only(checkLayers(root, ["src"], LAYERS));
    assert.equal(violation.code, "layer-breach");
    assert.equal(
      violation.message,
      "src/domain/consumer (layer `src/domain`) imports " +
        "src/entrypoints/high (layer `src/entrypoints`) via barrel src",
    );
  });

  it("stays name-aware: taking a legal symbol from the same barrel is clean", () => {
    const root = project({
      [HIGH]: HIGH_SOURCE,
      [LOW]: LOW_SOURCE,
      [BARREL]: BARREL_SOURCE,
      "src/domain/consumer.ts": 'import { Low } from "../index.ts";\nexport const x = Low;\n',
    });
    assert.deepEqual(checkLayers(root, ["src"], LAYERS), []);
  });

  it("narrows `export *` by parsing the target's real export list", () => {
    const files = {
      [HIGH]: HIGH_SOURCE,
      "src/shared/index.ts": 'export * from "../entrypoints/high.ts";\n',
    };
    const hit = project({
      ...files,
      "src/domain/consumer.ts": 'import { High } from "../shared/index.ts";\nexport const x = High;\n',
    });
    assert.equal(only(checkLayers(hit, ["src"], LAYERS)).code, "layer-breach");

    const miss = project({
      ...files,
      "src/domain/consumer.ts": 'import { Absent } from "../shared/index.ts";\nexport const x = Absent;\n',
    });
    assert.deepEqual(checkLayers(miss, ["src"], LAYERS), []);
  });

  it("follows everything behind a namespace import, which depends on everything", () => {
    const root = project({
      [HIGH]: HIGH_SOURCE,
      [LOW]: LOW_SOURCE,
      [BARREL]: BARREL_SOURCE,
      "src/domain/consumer.ts": 'import * as all from "../index.ts";\nexport const x = all;\n',
    });
    assert.equal(only(checkLayers(root, ["src"], LAYERS)).code, "layer-breach");
  });

  it("survives a re-export cycle between two barrels", () => {
    const root = project({
      "src/a/index.ts": 'export { Round } from "../b/index.ts";\n',
      "src/b/index.ts": 'export { Round } from "../a/index.ts";\n',
      "src/domain/consumer.ts": 'import { Round } from "../a/index.ts";\nexport const x = Round;\n',
    });
    assert.deepEqual(checkLayers(root, ["src"], LAYERS), []);
  });
});

describe("checkStructure", () => {
  it("reports a file over the line budget with the Python wording", () => {
    const root = project({ "src/big.ts": "export const x = 1;\n".repeat(12) });
    const violation = only(checkStructure(root, ["src"], 10, 100));
    assert.equal(violation.message, "file has 13 lines (max 10)");
    assert.equal(violation.code, "file-budget");
    assert.equal(violation.file, "src/big.ts");
    assert.equal(violation.fixHint, "split into smaller modules with single concerns");
  });

  it("counts lines the way Python counts them", () => {
    // `text.count("\n") + 1`: a trailing newline still ends a line.
    const root = project({ "src/two.ts": "export const a = 1;\n" });
    assert.deepEqual(checkStructure(root, ["src"], 2, 100), []);
    assert.equal(only(checkStructure(root, ["src"], 1, 100)).message, "file has 2 lines (max 1)");
  });

  it("reports a module over the symbol budget with the Python wording", () => {
    const root = project({
      "src/wide.ts": "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
    });
    const violation = only(checkStructure(root, ["src"], 100, 2));
    assert.equal(violation.message, "module exposes 3 public symbols (max 2)");
    assert.equal(violation.code, "symbol-budget");
    assert.equal(violation.fixHint, "split the module or prefix internals with underscores");
  });

  it("exempts excluded files from BOTH budgets, and nothing else", () => {
    const files = {
      "src/generated/api.ts": "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
      "src/hand/written.ts": "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
    };
    const root = project(files);
    assert.equal(checkStructure(root, ["src"], 100, 1).length, 2);
    assert.equal(checkStructure(root, ["src"], 1, 1).length, 4);

    const excluded = checkStructure(root, ["src"], 1, 1, ["src/generated/*"]);
    assert.equal(excluded.length, 2);
    assert.ok(excluded.every((violation) => violation.file === "src/hand/written.ts"));
  });
});

describe("checkStructure / public symbol counting", () => {
  /** Symbols in one module, read back out of the budget message. */
  function symbolsIn(code: string): number {
    const root = project({ "src/m.ts": code });
    const violation = checkStructure(root, ["src"], 100_000, 0).find(
      (candidate) => candidate.code === "symbol-budget",
    );
    if (violation === undefined) {
      return 0;
    }
    const match = /exposes (\d+) public symbols/u.exec(violation.message);
    assert.ok(match !== null, `unexpected message: ${violation.message}`);
    return Number(match[1]);
  }

  it("counts every kind of exported declaration", () => {
    assert.equal(
      symbolsIn(
        "export function a(): void {}\n" +
          "export class B {}\n" +
          "export const c = 1;\n" +
          "export let d = 2;\n" +
          "export enum E { One }\n",
      ),
      5,
    );
  });

  it("counts types and interfaces — they are public API surface", () => {
    // TypeScript's advantage over the Python original: `_public_symbols`
    // there is a leading-underscore convention, so it cannot see these at all.
    assert.equal(symbolsIn("export type T = string;\nexport interface I { x: number }\n"), 2);
  });

  it("does not count unexported declarations", () => {
    assert.equal(symbolsIn("const hidden = 1;\nfunction alsoHidden(): void {}\nexport const a = hidden;\n"), 1);
  });

  it("counts a symbol once even when declared and re-listed", () => {
    assert.equal(symbolsIn("export function a(): void {}\nexport { a };\n"), 1);
  });

  it("counts the EXPORTED name of an alias, not the local one", () => {
    assert.equal(symbolsIn("function a(): void {}\nexport { a as b };\n"), 1);
    assert.equal(symbolsIn("export function a(): void {}\nexport { a as b };\n"), 2);
  });

  it("counts `export default` once, however it is written", () => {
    assert.equal(symbolsIn("export default function named(): void {}\n"), 1);
    assert.equal(symbolsIn("const v = 1;\nexport default v;\n"), 1);
  });

  it("counts every name bound by a destructured export", () => {
    assert.equal(symbolsIn("declare const o: { a: number; b: number };\nexport const { a, b } = o;\n"), 2);
    assert.equal(symbolsIn("declare const t: [number, number];\nexport const [c, d] = t;\n"), 2);
  });

  it("counts a re-export list and `export * as ns`", () => {
    assert.equal(symbolsIn('export { a, b } from "./other.ts";\n'), 2);
    assert.equal(symbolsIn('export * as ns from "./other.ts";\n'), 1);
  });

  it("ignores exports nested inside another declaration", () => {
    assert.equal(symbolsIn("export function outer(): void {\n  class Inner {}\n  void Inner;\n}\n"), 1);
  });
});

/**
 * `export *` and the symbol budget.
 *
 * This suite exists because the budget was once duckable: a module could park
 * its declarations in a sibling and write `export * from "./sibling.ts"`,
 * keeping its counted surface at zero while its real surface was whatever the
 * sibling declared. An agent found that, used it, and disclosed it.
 *
 * Every test below is one of the ways the FIX could itself be wrong —
 * over-counting a namespace star, forwarding `default`, double-counting a name
 * that is also declared locally, looping on a cycle — plus the one that
 * matters most: an UNRESOLVABLE star must not quietly count as zero, because
 * counting it as zero is the original bug wearing a different hat.
 */
describe("checkStructure / `export *` re-exports", () => {
  /** The surface the budget measured for `src/m.ts`, and any star finding. */
  function measure(files: Readonly<Record<string, string>>): {
    readonly count: number;
    readonly unresolved: Violation | undefined;
  } {
    const violations = checkStructure(project(files), ["src"], 100_000, 0);
    const budget = violations.find(
      (candidate) => candidate.code === "symbol-budget" && candidate.file === "src/m.ts",
    );
    const match =
      budget === undefined
        ? null
        : /exposes (?:at least )?(\d+) public symbols/u.exec(budget.message);
    return {
      count: match === null ? 0 : Number(match[1]),
      unresolved: violations.find(
        (candidate) =>
          candidate.code === "symbol-budget-unresolved" && candidate.file === "src/m.ts",
      ),
    };
  }

  it("counts the names a bare `export *` forwards", () => {
    const found = measure({
      "src/m.ts": 'export * from "./other.ts";\n',
      "src/other.ts": "export const a = 1;\nexport const b = 2;\nexport type T = string;\n",
    });
    assert.equal(found.count, 3);
    assert.equal(found.unresolved, undefined);
  });

  it("follows a chain of stars", () => {
    const found = measure({
      "src/m.ts": 'export * from "./mid.ts";\n',
      "src/mid.ts": 'export * from "./leaf.ts";\nexport const own = 1;\n',
      "src/leaf.ts": "export const deep = 1;\n",
    });
    assert.equal(found.count, 2);
  });

  it("counts `export * as ns` as ONE name, not the target's whole surface", () => {
    const found = measure({
      "src/m.ts": 'export * as ns from "./other.ts";\n',
      "src/other.ts": "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
    });
    assert.equal(found.count, 1);
  });

  it("does not forward `default` through a star", () => {
    const found = measure({
      "src/m.ts": 'export * from "./other.ts";\n',
      "src/other.ts": "export const a = 1;\nexport default 2;\n",
    });
    assert.equal(found.count, 1);
  });

  it("counts a name once when it is both re-exported and declared here", () => {
    const found = measure({
      "src/m.ts": 'export * from "./other.ts";\nexport const a = 1;\n',
      "src/other.ts": "export const a = 2;\nexport const b = 3;\n",
    });
    assert.equal(found.count, 2);
  });

  it("survives a cycle between two star re-exports", () => {
    const found = measure({
      "src/m.ts": 'export * from "./other.ts";\nexport const m = 1;\n',
      "src/other.ts": 'export * from "./m.ts";\nexport const o = 1;\n',
    });
    assert.equal(found.count, 2);
    assert.equal(found.unresolved, undefined);
  });

  it("reports a star it cannot resolve instead of counting it as zero", () => {
    const missing = measure({ "src/m.ts": 'export * from "./gone.ts";\n' });
    assert.ok(missing.unresolved !== undefined, "a missing target must be reported");
    assert.match(missing.unresolved.message, /could not be enumerated/u);
    assert.match(missing.unresolved.message, /\.\/gone\.ts/u);

    const external = measure({ "src/m.ts": 'export * from "some-package";\n' });
    assert.ok(external.unresolved !== undefined, "a package star must be reported");
    assert.match(external.unresolved.fixHint ?? "", /structure_exclude/u);
  });

  it("says `at least` when an unresolvable star makes the count a lower bound", () => {
    const root = project({
      "src/m.ts": 'export * from "some-package";\nexport const a = 1;\nexport const b = 2;\n',
    });
    const budget = checkStructure(root, ["src"], 100_000, 1).find(
      (candidate) => candidate.code === "symbol-budget",
    );
    assert.equal(budget?.message, "module exposes at least 2 public symbols (max 1)");
  });

  it("exempts an excluded barrel from the star findings too", () => {
    const root = project({ "src/m.ts": 'export * from "some-package";\n' });
    assert.deepEqual(checkStructure(root, ["src"], 100_000, 0, ["src/m.ts"]), []);
  });

  it("resolves a star written through a tsconfig `paths` alias", () => {
    clearAliasCache();
    const found = measure({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
      }),
      "src/m.ts": 'export * from "@/other.ts";\n',
      "src/other.ts": "export const a = 1;\nexport const b = 2;\n",
    });
    clearAliasCache();
    assert.equal(found.count, 2);
  });
});

/**
 * The specifier resolver on its own, rather than through `checkLayers`.
 *
 * `resolveTarget` is where every TypeScript-only escape route is decided, and
 * the gate above can only observe the answers that end in a breach. The rest
 * are pinned here, because each one is a place where a wrong answer becomes a
 * silent PASS rather than a visible violation: a package mistaken for a
 * module, a layer-prefixed bare specifier treated as external, a relative
 * path silently dropped because nothing on disk confirms it.
 */
describe("resolveTarget / layerIndex / parseCached", () => {
  function contextFor(root: string): ResolveContext {
    const api = resolveTypeScript(root).api;
    return {
      root,
      api,
      layers: LAYERS,
      aliases: loadAliases(join(root, "tsconfig.json"), api),
      parsed: new Map(),
      seen: new Set(),
    };
  }

  it("indexes a module by the layer that prefixes it", () => {
    assert.equal(layerIndex("src/entrypoints", LAYERS), 0);
    assert.equal(layerIndex("src/services/inner/deep", LAYERS), 1);
    assert.equal(layerIndex("src/domain/x", LAYERS), 2);
  });

  it("refuses a module that merely starts with a layer's characters", () => {
    assert.equal(layerIndex("src/domainless/x", LAYERS), null);
    assert.equal(layerIndex("src/entrypointsX", LAYERS), null);
    assert.equal(layerIndex("vendor/thing", LAYERS), null);
    assert.equal(layerIndex("src/domain", []), null);
  });

  it("pins a relative specifier to the file it names", () => {
    const root = project({ [HIGH]: HIGH_SOURCE, "src/domain/consumer.ts": "" });
    const target = resolveTarget(
      "../entrypoints/high.ts",
      join(root, "src/domain/consumer.ts"),
      contextFor(root),
    );
    assert.ok(target.kind === "module", `expected a module, got ${target.kind}`);
    assert.equal(target.module, "src/entrypoints/high");
    assert.equal(target.file, join(root, HIGH));
  });

  it("still names the module of a relative specifier nothing on disk confirms", () => {
    const root = project({ "src/domain/consumer.ts": "" });
    const target = resolveTarget(
      "../entrypoints/gone.ts",
      join(root, "src/domain/consumer.ts"),
      contextFor(root),
    );
    assert.ok(target.kind === "module", `expected a module, got ${target.kind}`);
    assert.equal(target.module, "src/entrypoints/gone");
    assert.equal(target.file, null, "an unconfirmed path must not invent a file");
  });

  it("treats a package and a Node builtin as unrestricted", () => {
    const root = project({ "src/domain/consumer.ts": "" });
    const context = contextFor(root);
    const from = join(root, "src/domain/consumer.ts");
    assert.equal(resolveTarget("typescript", from, context).kind, "external");
    assert.equal(resolveTarget("node:path", from, context).kind, "external");
  });

  it("treats a bare specifier prefixed by a declared layer as that module", () => {
    const root = project({ "src/domain/consumer.ts": "" });
    const target = resolveTarget(
      "src/entrypoints/high",
      join(root, "src/domain/consumer.ts"),
      contextFor(root),
    );
    assert.ok(target.kind === "module", `expected a module, got ${target.kind}`);
    assert.equal(target.module, "src/entrypoints/high");
    assert.equal(target.file, null);
  });

  it("resolves a specifier through `baseUrl` when no `paths` pattern matches", () => {
    clearAliasCache();
    const root = project({
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "." } }),
      [HIGH]: HIGH_SOURCE,
      "src/domain/consumer.ts": "",
    });
    const target = resolveTarget(
      "src/entrypoints/high",
      join(root, "src/domain/consumer.ts"),
      contextFor(root),
    );
    clearAliasCache();
    assert.ok(target.kind === "module", `expected a module, got ${target.kind}`);
    assert.equal(target.module, "src/entrypoints/high");
    assert.equal(target.file, join(root, HIGH));
  });

  it("parses a file once per run and remembers the misses too", () => {
    const root = project({ [HIGH]: HIGH_SOURCE });
    const context = contextFor(root);
    const path = join(root, HIGH);

    const first = parseCached(path, context);
    assert.ok(first !== null, "an existing file must parse");
    assert.equal(first.relative, "src/entrypoints/high.ts");
    assert.equal(parseCached(path, context), first, "a second call must reuse the parse");
    assert.equal(context.parsed.size, 1);

    const missing = join(root, "src/entrypoints/gone.ts");
    assert.equal(parseCached(missing, context), null);
    assert.equal(context.parsed.size, 2, "a failed parse must be remembered, not retried");
    assert.equal(context.parsed.get(missing), null);
  });

  it("probes extensions in the compiler's order, and answers null for nothing", () => {
    const root = project({
      "src/domain/plain.ts": "export const a = 1;\n",
      "src/domain/hub/index.ts": "export const b = 2;\n",
    });
    assert.equal(existingFile(join(root, "src/domain/plain.ts")), join(root, "src/domain/plain.ts"));
    assert.equal(existingFile(join(root, "src/domain/plain")), join(root, "src/domain/plain.ts"));
    assert.equal(
      existingFile(join(root, "src/domain/hub")),
      join(root, "src/domain/hub/index.ts"),
      "a directory is not a file; the index inside it is",
    );
    assert.equal(existingFile(join(root, "src/domain/absent")), null);
  });
});
