/**
 * Tests for the two analysis tiers.
 *
 * The load-bearing properties here are not "does it parse" but:
 *
 *  - the program tier is LAZY and SHARED — a run with no type-aware gate must
 *    never build a `ts.Program`, and two gates must never build two;
 *  - a broken configuration is REPORTED, not guessed around;
 *  - the syntax tier never crashes the run on one bad file.
 *
 * The tests import `typescript` directly, which production analysis code must
 * NOT do (see `resolveTypeScript`): here it is the compiler under test, and
 * passing it in explicitly keeps the resolution out of the picture.
 *
 * SHARED MEANS PER RUN, NOT PER PROCESS. `analysisProgram` keeps no
 * module-level handle cache — it used to, and a second run in one process was
 * served the first run's pre-edit program. The sharing that gates rely on is
 * asserted against `catalogContext` in `catalog.test.ts`.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import ts from "typescript";

import {
  analysisProgram,
  programFileNames,
  programSourceFiles,
  sourceFilesFor,
} from "../src/analysis/program.ts";
import { absolutePath, resolveSpecifier, toPosix } from "../src/analysis/modulePath.ts";
import {
  clearCompilerCache,
  moduleImports,
  moduleName,
  parsedSources,
  resolveTypeScript,
} from "../src/analysis/sourceFile.ts";
import { walkFiles } from "../src/analysis/walk.ts";

const temporaryRoots: string[] = [];

after(() => {
  clearCompilerCache();
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-analysis-"));
  temporaryRoots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

/** Parse a snippet with the bundled compiler, for import-table assertions. */
function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function importsOf(module: string, text: string): ReadonlyMap<string, string> {
  return moduleImports(module, parse(`${module}.ts`, text), ts);
}

describe("moduleName", () => {
  it("drops the extension and uses / separators", () => {
    assert.equal(moduleName("/repo/src/a/b.ts", "/repo"), "src/a/b");
    assert.equal(moduleName("/repo/src/a.tsx", "/repo/src"), "a");
    assert.equal(moduleName("/repo/src/a.mts", "/repo/src"), "a");
    assert.equal(moduleName("/repo/src/a.d.ts", "/repo/src"), "a");
  });

  it("drops a trailing index, as Python drops __init__", () => {
    assert.equal(moduleName("/repo/src/a/index.ts", "/repo/src"), "a");
  });

  it("falls back to the source directory's own name at the root", () => {
    assert.equal(moduleName("/repo/src/index.ts", "/repo/src"), "src");
  });
});

describe("moduleImports", () => {
  it("records default, named, aliased and namespace imports", () => {
    const imports = importsOf(
      "src/a",
      [
        'import def from "./other.ts";',
        'import { one, two as alias } from "./other.ts";',
        'import * as ns from "node:fs";',
      ].join("\n"),
    );
    assert.equal(imports.get("def"), "src/other#default");
    assert.equal(imports.get("one"), "src/other#one");
    assert.equal(imports.get("alias"), "src/other#two");
    assert.equal(imports.get("ns"), "node:fs#*");
  });

  it("records type-only imports — a type edge is still a dependency edge", () => {
    const imports = importsOf(
      "src/a",
      ['import type { T } from "./types.ts";', 'import { type U } from "./types.ts";'].join("\n"),
    );
    assert.equal(imports.get("T"), "src/types#T");
    assert.equal(imports.get("U"), "src/types#U");
  });

  it("keeps bare specifiers verbatim and resolves relative ones", () => {
    const imports = importsOf(
      "src/deep/a",
      ['import { x } from "../shared/util.ts";', 'import { y } from "typescript";'].join("\n"),
    );
    assert.equal(imports.get("x"), "src/shared/util#x");
    assert.equal(imports.get("y"), "typescript#y");
  });

  it("collapses a barrel specifier onto the directory module", () => {
    const imports = importsOf("src/a", 'import { x } from "./sub/index.ts";');
    assert.equal(imports.get("x"), "src/sub#x");
  });

  it("records re-exports, which barrels depend on", () => {
    const imports = importsOf("src/index", 'export { inner as outer } from "./inner.ts";');
    assert.equal(imports.get("outer"), "src/inner#inner");
  });

  it("skips export * — expanding it needs the other module's exports", () => {
    assert.equal(importsOf("src/index", 'export * from "./inner.ts";').size, 0);
  });

  it("ignores a side-effect import, which binds no name", () => {
    assert.equal(importsOf("src/a", 'import "./polyfill.ts";').size, 0);
  });

  it("records the two unambiguous require shapes", () => {
    const imports = importsOf(
      "src/a",
      ['const whole = require("node:path");', 'const { join, resolve: r } = require("node:fs");'].join(
        "\n",
      ),
    );
    assert.equal(imports.get("whole"), "node:path#=");
    assert.equal(imports.get("join"), "node:fs#join");
    assert.equal(imports.get("r"), "node:fs#resolve");
  });

  it("never lets a re-export alias clobber a real local binding", () => {
    const imports = importsOf(
      "src/index",
      ['import { x } from "./real.ts";', 'export { other as x } from "./barrel.ts";'].join("\n"),
    );
    assert.equal(imports.get("x"), "src/real#x");
  });
});

/**
 * The walk itself, without a parser in the way.
 *
 * `parsedSources` is the usual caller, but `commands/scope.ts` walks directly
 * to expand a `--file` directory into the files the path-aware gates compare
 * against — and it walks with the wider `SOURCE_EXTENSIONS`, so the extension
 * list being a parameter has to keep working.
 */
describe("walkFiles", () => {
  it("yields matching files under a base, sorted, skipping vendored trees", () => {
    const root = project({
      "src/b.ts": "export const b = 1;\n",
      "src/a.ts": "export const a = 1;\n",
      "src/nested/c.tsx": "export const c = 1;\n",
      "src/types.d.ts": "export declare const d: number;\n",
      "src/node_modules/vendor.ts": "export const v = 1;\n",
      "src/.hidden/skip.ts": "export const s = 1;\n",
    });
    assert.deepEqual(
      [...walkFiles(join(root, "src"), [".ts", ".tsx"], false, root)],
      [join(root, "src/a.ts"), join(root, "src/b.ts"), join(root, "src/nested/c.tsx")],
    );
  });

  it("honours the extension list and the declaration switch it is given", () => {
    const root = project({
      "src/a.ts": "export const a = 1;\n",
      "src/a.mjs": "export const b = 1;\n",
      "src/types.d.ts": "export declare const d: number;\n",
    });
    assert.deepEqual(
      [...walkFiles(join(root, "src"), [".mjs"], false, root)],
      [join(root, "src/a.mjs")],
    );
    assert.deepEqual(
      [...walkFiles(join(root, "src"), [".ts"], true, root)],
      [join(root, "src/a.ts"), join(root, "src/types.d.ts")],
    );
  });

  it("yields nothing for a base that is not a directory", () => {
    const root = project({ "src/a.ts": "export const a = 1;\n" });
    assert.deepEqual([...walkFiles(join(root, "src/a.ts"), [".ts"], false, root)], []);
    assert.deepEqual([...walkFiles(join(root, "nope"), [".ts"], false, root)], []);
  });
});

describe("parsedSources", () => {
  it("walks the source paths deterministically, skipping generated trees", () => {
    const root = project({
      "src/a.ts": "export const a = 1;\n",
      "src/nested/b.ts": "export const b = 2;\n",
      "src/types.d.ts": "export declare const d: number;\n",
      "src/node_modules/vendor.ts": "export const v = 3;\n",
      "dist/built.ts": "export const c = 4;\n",
      "other/z.ts": "export const z = 5;\n",
    });
    const parsed = [...parsedSources(root, ["src"], { api: ts })];
    assert.deepEqual(
      parsed.map((source) => source.relative),
      ["src/a.ts", "src/nested/b.ts"],
    );
    assert.equal(parsed[0]?.module, "src/a");
    assert.equal(parsed[1]?.module, "src/nested/b");
  });

  it("analyzes real source directories named after build outputs", () => {
    // REGRESSION. The skip set once matched by name at ANY depth, so this
    // repo's own `src/coverage/istanbul.ts` was invisible to every gate that
    // walks sources — they reported green over code they had never read.
    // Output names are only generated at the top of a walk; a directory
    // deeper in the tree is somebody's module.
    const root = project({
      "src/build/emit.ts": "export const emit = 2;\n",
      "src/coverage/istanbul.ts": "export const normalize = 1;\n",
      "src/dist/pack.ts": "export const pack = 3;\n",
      "src/out/write.ts": "export const write = 4;\n",
    });
    assert.deepEqual(
      [...parsedSources(root, ["src"], { api: ts })].map((source) => source.relative),
      ["src/build/emit.ts", "src/coverage/istanbul.ts", "src/dist/pack.ts", "src/out/write.ts"],
    );
  });

  it("still skips build outputs at the root of the walk", () => {
    // The other half of the rule: scanning `.` must not pull in dist/.
    const root = project({
      "coverage/report.ts": "export const r = 2;\n",
      "dist/built.ts": "export const b = 3;\n",
      "src/a.ts": "export const a = 1;\n",
    });
    assert.deepEqual(
      [...parsedSources(root, ["."], { api: ts })].map((source) => source.relative),
      ["src/a.ts"],
    );
  });

  it("skips nested node_modules at any depth", () => {
    const root = project({
      "src/a.ts": "export const a = 1;\n",
      "src/pkg/node_modules/vendor.ts": "export const v = 2;\n",
    });
    assert.deepEqual(
      [...parsedSources(root, ["src"], { api: ts })].map((source) => source.relative),
      ["src/a.ts"],
    );
  });

  it("includes declaration files only when asked", () => {
    const root = project({ "src/types.d.ts": "export declare const d: number;\n" });
    assert.equal([...parsedSources(root, ["src"], { api: ts })].length, 0);
    assert.equal(
      [...parsedSources(root, ["src"], { api: ts, includeDeclarations: true })].length,
      1,
    );
  });

  it("skips a source path that does not exist", () => {
    const root = project({ "src/a.ts": "export const a = 1;\n" });
    assert.equal([...parsedSources(root, ["src", "lib"], { api: ts })].length, 1);
  });

  it("skips a broken file instead of crashing the run", () => {
    // Python skips SyntaxError; the TS parser recovers instead, so we detect
    // the errors ourselves. One bad file must never take down twelve gates.
    const root = project({
      "src/broken.ts": "const = ;;; function (\n",
      "src/good.ts": "export const good = 1;\n",
    });
    const parsed = [...parsedSources(root, ["src"], { api: ts })];
    assert.deepEqual(
      parsed.map((source) => source.relative),
      ["src/good.ts"],
    );
  });

  it("carries raw lines and an import table", () => {
    const root = project({ "src/a.ts": 'import { x } from "./b.ts";\n// kragg: allow\n' });
    const parsed = [...parsedSources(root, ["src"], { api: ts })];
    const first = parsed[0];
    assert.ok(first !== undefined);
    assert.equal(first.lines[1], "// kragg: allow");
    assert.equal(first.imports.get("x"), "src/b#x");
  });
});

describe("resolveTypeScript", () => {
  it("falls back to the bundled compiler with an explicit note", () => {
    // A silent fallback is the one outcome that is not allowed: a report that
    // used the wrong compiler and said nothing is worse than no report.
    clearCompilerCache();
    const root = project({ "package.json": "{}" });
    const resolution = resolveTypeScript(root);
    assert.equal(resolution.source, "bundled");
    assert.equal(resolution.version, ts.version);
    assert.match(resolution.note ?? "", /bundled typescript/);
  });

  it("caches per root", () => {
    clearCompilerCache();
    const root = project({ "package.json": "{}" });
    assert.equal(resolveTypeScript(root), resolveTypeScript(root));
  });

  it("resolves this repo's own compiler, and reports no version caveat", () => {
    // kragg-ts's own root resolves `typescript` to the very module we bundle,
    // so there is no version disagreement to warn about.
    clearCompilerCache();
    const resolution = resolveTypeScript(join(import.meta.dirname, ".."));
    assert.equal(resolution.api, ts);
    assert.notEqual(resolution.path, null);
    assert.equal(resolution.note, null);
  });
});

describe("analysisProgram", () => {
  const sample = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { target: "es2023", module: "nodenext", strict: true },
      include: ["src/**/*.ts"],
    }),
    "src/a.ts": "export const count = 1;\nexport const label = 'x';\n",
    "src/b.ts": "import { count } from './a.js';\nexport const doubled = count * 2;\n",
  };

  it("does not build a program until something asks for one", () => {
    // The whole reason this tier is separate: `check --changed` over three
    // files, with no type-aware gate firing, must cost nothing.
    const handle = analysisProgram({ root: project(sample), api: ts });
    assert.equal(handle.loaded(), false);
    handle.load();
    assert.equal(handle.loaded(), true);
  });

  it("builds one program and one checker, and reuses them", () => {
    const handle = analysisProgram({ root: project(sample), api: ts });
    const first = handle.load();
    const second = handle.load();
    assert.equal(first.ok, true);
    assert.equal(first, second, "the program must be built once, not per caller");
    if (!first.ok) {
      return;
    }
    const file = first.program.getSourceFile(join(handle.root, "src", "a.ts"));
    if (file === undefined) {
      assert.fail("the program must contain the project's own source file");
    }
    // The checker is real: it knows `count` is a literal-typed number.
    const statement = file.statements[0];
    if (statement === undefined || !ts.isVariableStatement(statement)) {
      assert.fail("expected `export const count = 1` as the first statement");
    }
    const declaration = statement.declarationList.declarations[0];
    if (declaration === undefined) {
      assert.fail("expected one declaration");
    }
    const symbol = first.checker.getSymbolAtLocation(declaration.name);
    if (symbol === undefined) {
      assert.fail("the checker must resolve a symbol for a declared name");
    }
    assert.equal(
      first.checker.typeToString(first.checker.getTypeOfSymbolAtLocation(symbol, file)),
      "1",
    );
  });

  it("keeps no process-global handle, so a second run cannot inherit one", () => {
    // Sharing is the RUN's job (`catalog/context.ts` owns the one handle every
    // gate is given), never this module's. A module-level memo here is a
    // correctness bug the moment anything outlives one CLI invocation.
    const root = project(sample);
    assert.notEqual(analysisProgram({ root }), analysisProgram({ root }));
  });

  it("shows the second run the edit the first run never saw", () => {
    // THE BUG THIS PINS. `analysisProgram` memoized handles per tsconfig path
    // in a module-level map. A long-lived process using the library API — a
    // watcher, an MCP server, `runCommand` called twice — ran, the files
    // changed, it ran again, and it was handed the FIRST run's `ts.Program`:
    // every source file in it parsed from the pre-edit bytes. It then reported
    // confidently on code that no longer existed, which is the same failure a
    // stale criticality cache causes, one tier down.
    //
    // No `api` is passed, so this is the production resolution path — the one
    // that used to consult the cache.
    const root = project({ ...sample, "src/a.ts": "export const count = 1;\n" });
    const before = analysisProgram({ root }).load();
    assert.equal(before.ok, true);
    if (!before.ok) {
      return;
    }
    assert.match(
      before.program.getSourceFile(join(root, "src", "a.ts"))?.text ?? "",
      /count = 1/,
    );

    writeFileSync(join(root, "src", "a.ts"), "export const count = 99;\n");

    const after = analysisProgram({ root }).load();
    assert.equal(after.ok, true);
    if (!after.ok) {
      return;
    }
    const text = after.program.getSourceFile(join(root, "src", "a.ts"))?.text ?? "";
    assert.match(text, /count = 99/, "the second run must read the edited file");
    assert.doesNotMatch(text, /count = 1;/);
  });

  // The other half of the contract — every gate in ONE run shares ONE lazily
  // built handle — is asserted where the sharing now lives, on the run
  // context: see "the program is shared and lazy" in `catalog.test.ts`.

  it("reports a missing tsconfig instead of inventing default options", () => {
    const load = analysisProgram({ root: project({ "src/a.ts": "export const a = 1;\n" }), api: ts })
      .load();
    assert.equal(load.ok, false);
    if (load.ok) {
      return;
    }
    assert.match(load.message, /no tsconfig\.json at/);
    assert.match(load.message, /Fix:/);
  });

  it("reports an unusable tsconfig", () => {
    const root = project({
      "tsconfig.json": JSON.stringify({ extends: "./does-not-exist.json" }),
      "src/a.ts": "export const a = 1;\n",
    });
    const load = analysisProgram({ root, api: ts }).load();
    assert.equal(load.ok, false);
  });

  it("reports a tsconfig that matches no files", () => {
    const root = project({
      "tsconfig.json": JSON.stringify({ include: ["nothing/**/*.ts"] }),
    });
    const load = analysisProgram({ root, api: ts }).load();
    assert.equal(load.ok, false);
    if (load.ok) {
      return;
    }
    assert.match(load.message, /No inputs were found|matches no files/);
  });

  it("caches the failure, so twelve gates do not retry a broken config", () => {
    const handle = analysisProgram({ root: project({ "src/a.ts": "" }), api: ts });
    assert.equal(handle.load(), handle.load());
  });
});

describe("program file selection", () => {
  const sample = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { target: "es2023", module: "nodenext" },
      include: ["src/**/*.ts"],
    }),
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "export const b = 2;\n",
  };

  it("lists the project's own files, not lib or vendored declarations", () => {
    const handle = analysisProgram({ root: project(sample), api: ts });
    const load = handle.load();
    assert.equal(load.ok, true);
    if (!load.ok) {
      return;
    }
    const names = programFileNames(load.program);
    assert.deepEqual(
      [...names].sort(),
      [join(handle.root, "src", "a.ts"), join(handle.root, "src", "b.ts")].sort(),
    );
  });

  it("narrows to a changed subset given relative or absolute paths", () => {
    const handle = analysisProgram({ root: project(sample), api: ts });
    const load = handle.load();
    assert.equal(load.ok, true);
    if (!load.ok) {
      return;
    }
    const selected = sourceFilesFor(load.program, handle.root, [
      "src/a.ts",
      join(handle.root, "src", "a.ts"),
      "src/a.ts",
    ]);
    assert.equal(selected.length, 1, "duplicates must collapse");

    const mixed = sourceFilesFor(load.program, handle.root, [
      "src/b.ts",
      "README.md",
      "src/deleted.ts",
    ]);
    assert.equal(mixed.length, 1);
    assert.equal(mixed[0]?.fileName.endsWith("b.ts"), true);
  });
});

/**
 * The path arithmetic under the syntax tier.
 *
 * `moduleName` above and `resolveSpecifier` here must agree: the first names a
 * FILE, the second names the target of an import SPECIFIER, and if the two
 * disagree the import table stops joining against the file table and every
 * cross-module gate goes quietly blind. So the assertions below are written as
 * pairs wherever both functions can reach the same module.
 */
describe("resolveSpecifier", () => {
  it("agrees with moduleName on a sibling import", () => {
    assert.equal(resolveSpecifier("src/a", "./b.ts"), "src/b");
    assert.equal(resolveSpecifier("src/a", "./b.ts"), moduleName("/repo/src/b.ts", "/repo"));
  });

  it("resolves .. against the importing module's directory", () => {
    assert.equal(resolveSpecifier("src/gates/architecture/layers", "../../engine/models.ts"),
      "src/engine/models");
    assert.equal(resolveSpecifier("src/a/b/c", "../../d.ts"), "src/d");
  });

  it("drops a trailing /index, as moduleName drops it from a path", () => {
    assert.equal(resolveSpecifier("src/a", "./sub/index.ts"), "src/sub");
    assert.equal(
      resolveSpecifier("src/a", "./sub/index.ts"),
      moduleName("/r/src/sub/index.ts", "/r"),
    );
  });

  it("strips every recognised extension, compound .d.ts included", () => {
    assert.equal(resolveSpecifier("src/a", "./b.mts"), "src/b");
    assert.equal(resolveSpecifier("src/a", "./b.tsx"), "src/b");
    assert.equal(resolveSpecifier("src/a", "./b.d.ts"), "src/b");
  });

  it("keeps bare, builtin and aliased specifiers verbatim", () => {
    // Not a gap being papered over: `moduleImports` documents why aliases are
    // deliberately left unresolved rather than guessed at.
    assert.equal(resolveSpecifier("src/a", "typescript"), "typescript");
    assert.equal(resolveSpecifier("src/a", "node:fs"), "node:fs");
    assert.equal(resolveSpecifier("src/a", "@scope/pkg/sub"), "@scope/pkg/sub");
    assert.equal(resolveSpecifier("src/a", "#internal/x"), "#internal/x");
  });

  it("keeps a specifier that escapes the module root rather than dropping the ..", () => {
    assert.equal(resolveSpecifier("a", "../outside.ts"), "../outside");
  });

  it("resolves against a module with no directory part", () => {
    assert.equal(resolveSpecifier("cli", "./commands/check.ts"), "commands/check");
  });
});

describe("toPosix", () => {
  it("leaves a POSIX path untouched", () => {
    // On a POSIX host this is the identity; the Windows branch is what makes a
    // report read the same on every platform.
    assert.equal(toPosix("src/a/b.ts"), "src/a/b.ts");
    assert.equal(toPosix(""), "");
    assert.equal(toPosix(join("src", "a", "b.ts")), "src/a/b.ts");
  });
});

describe("absolutePath", () => {
  it("resolves a repo-relative path against the root", () => {
    assert.equal(absolutePath(join("/repo"), "src/a.ts"), join("/repo", "src", "a.ts"));
  });

  it("leaves an already-absolute path absolute, ignoring the root", () => {
    // git reports relative paths, but a caller's `--changed` list may not.
    const elsewhere = join("/elsewhere", "src", "a.ts");
    assert.equal(absolutePath("/repo", elsewhere), elsewhere);
  });

  it("normalizes . and .. segments so two spellings of one file match", () => {
    assert.equal(absolutePath("/repo", "./src/../src/a.ts"), join("/repo", "src", "a.ts"));
  });
});

describe("programSourceFiles", () => {
  it("returns the project's own source files, not lib or vendored declarations", () => {
    // A program contains every `lib.*.d.ts` the target pulls in; reporting a
    // violation inside one is a bug report against the compiler.
    const root = project({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { target: "es2023", module: "nodenext" },
        include: ["src/**/*.ts"],
      }),
      "src/a.ts": "export const a = 1;\n",
      "src/types.d.ts": "export declare const t: number;\n",
    });
    const load = analysisProgram({ root, api: ts }).load();
    assert.equal(load.ok, true);
    if (!load.ok) {
      return;
    }
    const files = programSourceFiles(load.program);
    assert.deepEqual(files.map((file) => file.fileName), [join(root, "src", "a.ts")]);
    // Real SourceFile objects, not paths — that is what the callers walk.
    assert.equal(files[0]?.statements.length, 1);
    // The program itself really did carry the noise this filters out.
    assert.equal(
      load.program.getSourceFiles().some((file) => file.isDeclarationFile),
      true,
    );
    assert.equal(files.some((file) => file.isDeclarationFile), false);
  });
});
