/**
 * Tests for `parseSourceFile`, the syntax tier's single-file entry point.
 *
 * `program.test.ts` covers `parsedSources` at the WALK level — which files are
 * visited, in what order. This file pins the per-file contract that walk is
 * built on, because every syntax-only gate reports through it. Four properties
 * carry the weight:
 *
 *  - `null` means "do not analyze this file", and it has TWO causes. The
 *    unreadable one is obvious. The other is not: `ts.createSourceFile`
 *    RECOVERS from bad syntax instead of throwing, so a broken file yields a
 *    plausible-looking partial tree, and a gate that walked it would report
 *    violations pointing at code the author never wrote. The tests below assert
 *    that the compiler really does hand back that tree, and that
 *    `parseSourceFile` refuses it anyway.
 *  - only SYNTAX errors disqualify a file. A type error belongs to the program
 *    tier, and a file full of them must still be scanned here.
 *  - the module name is taken relative to the REPO ROOT, not to the source path
 *    the file was found under — the divergence from Python that makes the
 *    import table usable.
 *  - the script kind follows the extension, so the same JSX text is a valid
 *    `.tsx` file and a broken `.ts` one.
 *
 * The compiler is imported and passed in explicitly, for the reason
 * `program.test.ts` gives: here it is the thing under test rather than a
 * resolved dependency, and passing it keeps these tests off the handle cache.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import ts from "typescript";

import { parseSourceFile } from "../src/analysis/sourceFile.ts";
import { DEFAULT_EXTENSIONS, walkFiles } from "../src/analysis/walk.ts";

const temporaryRoots: string[] = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-source-file-"));
  temporaryRoots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

/** Write one file and parse it, returning both the root and the result. */
function parseOne(
  name: string,
  contents: string,
): { readonly root: string; readonly path: string } {
  const root = project({ [name]: contents });
  return { root, path: join(root, name) };
}

describe("walkFiles", () => {
  it("yields the TypeScript family, sorted at every level, and nothing under node_modules", () => {
    const root = project({
      "src/b.ts": "",
      "src/a.tsx": "",
      "src/nested/z.mts": "",
      "src/nested/y.cts": "",
      "src/types.d.ts": "",
      "src/build.js": "",
      "node_modules/dep/index.ts": "",
    });
    const files = [...walkFiles(root, DEFAULT_EXTENSIONS, false, root)].map((path) =>
      path.slice(root.length + 1),
    );
    assert.deepEqual(files, ["src/a.tsx", "src/b.ts", "src/nested/y.cts", "src/nested/z.mts"]);
    // Declaration files are opt-in; a missing base yields nothing rather than throwing.
    const withDeclarations = [...walkFiles(join(root, "src"), DEFAULT_EXTENSIONS, true, root)];
    assert.ok(withDeclarations.some((path) => path.endsWith("types.d.ts")));
    assert.deepEqual([...walkFiles(join(root, "absent"), DEFAULT_EXTENSIONS, false, root)], []);
  });
});

describe("parseSourceFile", () => {
  it("describes the file with everything a name-resolving gate needs", () => {
    const { root, path } = parseOne(
      "src/nested/a.ts",
      ['import { x } from "../other.ts";', "export const a = x;", "// kragg: allow"].join("\n"),
    );
    const parsed = parseSourceFile(path, root, ts);
    if (parsed === null) {
      assert.fail("a well-formed file must parse");
    }
    assert.equal(parsed.path, path);
    assert.equal(parsed.relative, "src/nested/a.ts");
    assert.equal(parsed.module, "src/nested/a");
    assert.equal(parsed.sourceFile.fileName, path);
    // Raw lines, verbatim and in order — suppression-comment scanning reads
    // these, so a shifted index points a violation at the wrong line.
    assert.deepEqual(parsed.lines, [
      'import { x } from "../other.ts";',
      "export const a = x;",
      "// kragg: allow",
    ]);
    // The import table is resolved against the module, not the file path.
    assert.equal(parsed.imports.get("x"), "src/other#x");
  });

  it("names the module relative to the repo root, not to the source path", () => {
    // The documented divergence from Python. Naming `src/a.ts` as `a` would
    // make a `../lib/util.ts` specifier join against nothing, and would collide
    // `src/a.ts` with `lib/a.ts` in any policy listing two source paths.
    const { root, path } = parseOne("src/a.ts", 'import { x } from "../lib/util.ts";\n');
    const fromRepoRoot = parseSourceFile(path, root, ts);
    const fromSourcePath = parseSourceFile(path, join(root, "src"), ts);
    assert.equal(fromRepoRoot?.module, "src/a");
    assert.equal(fromRepoRoot?.imports.get("x"), "lib/util#x");
    assert.equal(fromSourcePath?.module, "a");
    assert.equal(fromSourcePath?.relative, "a.ts");
  });

  it("returns null for a file that cannot be read", () => {
    const root = project({ "src/a.ts": "export const a = 1;\n" });
    assert.equal(parseSourceFile(join(root, "src", "missing.ts"), root, ts), null);
    // A directory is the other everyday I/O failure: the walk hands paths in,
    // and one that is not a file must skip rather than take the run down.
    assert.equal(parseSourceFile(join(root, "src"), root, ts), null);
  });

  it("returns null for a file the parser only RECOVERED from", () => {
    // The subtle half of the null contract. `ts.createSourceFile` does not
    // throw on bad syntax, so without this check a gate would walk the partial
    // tree below and report on statements the author never wrote.
    const text = "export const a = { b: 1,\n";
    const { root, path } = parseOne("src/broken.ts", text);
    const transpiled = ts.transpileModule(text, { reportDiagnostics: true, fileName: path });
    assert.ok(
      (transpiled.diagnostics ?? []).length > 0,
      "the fixture must actually be a syntax error",
    );
    const recovered = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    assert.ok(
      recovered.statements.length > 0,
      "the compiler recovers rather than throwing — that is the whole reason this case needs detecting",
    );
    assert.equal(parseSourceFile(path, root, ts), null);
  });

  it("returns null for every shape of syntax error, not just unbalanced braces", () => {
    const cases: Readonly<Record<string, string>> = {
      "src/one.ts": "const = ;;; function (\n",
      "src/two.ts": "export function f( {\n",
      "src/three.ts": 'const s = "unterminated\n',
      "src/four.ts": "class C { method() { }\n",
    };
    const root = project(cases);
    for (const name of Object.keys(cases)) {
      assert.equal(parseSourceFile(join(root, name), root, ts), null, `${name} must be skipped`);
    }
  });

  it("keeps a file whose only errors are semantic", () => {
    // Type errors are the program tier's business. Skipping them here would
    // silently exempt any file with a type error from every syntax-only gate —
    // exactly the files most worth scanning.
    const { root, path } = parseOne(
      "src/typed.ts",
      ["export const n: number = \"not a number\";", "export const missing: Nope = undefined;"].join(
        "\n",
      ),
    );
    const parsed = parseSourceFile(path, root, ts);
    assert.notEqual(parsed, null, "a type error must not disqualify a file from parsing");
    assert.equal(parsed?.module, "src/typed");
  });

  it("parses .tsx as JSX, and rejects the same text spelled .ts", () => {
    // Both halves matter. Without the JSX script kind every `.tsx` file in a
    // React project would be skipped as broken and silently unscanned; with
    // JSX applied everywhere, `a < b > (c)` in a `.ts` file would parse as an
    // element.
    const jsx = "export const el = <div className=\"x\" />;\n";
    const root = project({ "src/view.tsx": jsx, "src/view.ts": jsx, "src/legacy.jsx": jsx });
    const tsx = parseSourceFile(join(root, "src", "view.tsx"), root, ts);
    assert.notEqual(tsx, null, ".tsx must parse as JSX");
    assert.equal(tsx?.sourceFile.languageVariant, ts.LanguageVariant.JSX);
    assert.notEqual(parseSourceFile(join(root, "src", "legacy.jsx"), root, ts), null);
    assert.equal(
      parseSourceFile(join(root, "src", "view.ts"), root, ts),
      null,
      "JSX in a .ts file is a syntax error and must be skipped",
    );
  });

  it("parses .ts as plain TypeScript, where angle brackets are type syntax", () => {
    const { root, path } = parseOne("src/cast.ts", "export const n = <number>1;\n");
    const parsed = parseSourceFile(path, root, ts);
    assert.equal(parsed?.sourceFile.languageVariant, ts.LanguageVariant.Standard);
  });

  it("treats .js, .mjs and .cjs as JavaScript", () => {
    // JSX is legal in a `.js` file, so it doubles as the probe for the kind.
    const jsx = "export const el = <div />;\n";
    const root = project({ "src/a.js": jsx, "src/b.mjs": jsx, "src/c.cjs": jsx });
    for (const name of ["src/a.js", "src/b.mjs", "src/c.cjs"]) {
      const parsed = parseSourceFile(join(root, name), root, ts);
      assert.equal(parsed?.sourceFile.languageVariant, ts.LanguageVariant.JSX, name);
    }
  });

  it("sets parent pointers, which every gate walk relies on", () => {
    // A gate that asks a node for its enclosing function gets `undefined` if
    // this is off, and reports nothing while looking perfectly healthy.
    const { root, path } = parseOne("src/a.ts", "export function f(): number {\n  return 1;\n}\n");
    const parsed = parseSourceFile(path, root, ts);
    const statement = parsed?.sourceFile.statements[0];
    if (statement === undefined || parsed === null) {
      assert.fail("expected one statement");
    }
    assert.equal(statement.parent, parsed.sourceFile);
  });

  it("splits CRLF lines without leaving carriage returns behind", () => {
    // A line-length or suppression-comment check that saw a trailing `\r`
    // would be off by one character on every line of a Windows checkout.
    const { root, path } = parseOne("src/crlf.ts", "export const a = 1;\r\n// kragg: allow\r\n");
    const parsed = parseSourceFile(path, root, ts);
    assert.deepEqual(parsed?.lines, ["export const a = 1;", "// kragg: allow", ""]);
  });

  it("accepts an empty file, which is valid and imports nothing", () => {
    const { root, path } = parseOne("src/empty.ts", "");
    const parsed = parseSourceFile(path, root, ts);
    if (parsed === null) {
      assert.fail("an empty file is not a broken file");
    }
    assert.equal(parsed.module, "src/empty");
    assert.equal(parsed.imports.size, 0);
    assert.deepEqual(parsed.lines, [""]);
    assert.equal(parsed.sourceFile.statements.length, 0);
  });

  it("drops the index segment, so a barrel is named for its directory", () => {
    const { root, path } = parseOne("src/sub/index.ts", "export const a = 1;\n");
    const parsed = parseSourceFile(path, root, ts);
    assert.equal(parsed?.module, "src/sub");
    assert.equal(parsed?.relative, "src/sub/index.ts");
  });
});

describe("walkFiles", () => {
  it("yields candidate files sorted at every level, and nothing that is not a directory", () => {
    const root = project({
      "src/b.ts": "",
      "src/a.ts": "",
      "src/nested/z.tsx": "",
      "src/nested/y.mts": "",
      "src/readme.md": "",
      "src/types.d.ts": "",
    });
    const files = [...walkFiles(join(root, "src"), DEFAULT_EXTENSIONS, false, root)].map((path) =>
      path.slice(root.length + 1),
    );
    assert.deepEqual(files, ["src/a.ts", "src/b.ts", "src/nested/y.mts", "src/nested/z.tsx"]);
    assert.deepEqual([...walkFiles(join(root, "src", "a.ts"), DEFAULT_EXTENSIONS, false, root)], []);
    assert.deepEqual([...walkFiles(join(root, "missing"), DEFAULT_EXTENSIONS, false, root)], []);
  });

  it("includes declaration files only when asked, and honours the extension list", () => {
    const root = project({ "src/types.d.ts": "", "src/impl.ts": "", "src/legacy.js": "" });
    const base = join(root, "src");
    const withDeclarations = [...walkFiles(base, DEFAULT_EXTENSIONS, true, root)].map((p) => p.slice(root.length + 1));
    assert.deepEqual(withDeclarations, ["src/impl.ts", "src/types.d.ts"]);
    const javascript = [...walkFiles(base, [".js"], false, root)].map((p) => p.slice(root.length + 1));
    assert.deepEqual(javascript, ["src/legacy.js"]);
  });

  it("skips build outputs only at the repository root, and dot/vendor directories at any depth", () => {
    const root = project({
      "dist/out.ts": "",
      "src/dist/kept.ts": "",
      "src/coverage/model.ts": "",
      "src/node_modules/dep/index.ts": "",
      "src/.hidden/secret.ts": "",
      "src/index.ts": "",
    });
    const all = [...walkFiles(root, DEFAULT_EXTENSIONS, false, root)].map((p) => p.slice(root.length + 1));
    assert.deepEqual(all, ["src/coverage/model.ts", "src/dist/kept.ts", "src/index.ts"]);
  });
});
