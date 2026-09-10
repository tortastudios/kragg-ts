/**
 * Tests for `criticalFunctions`, the lookup three gates are built on.
 *
 * `test-quality`, `critical-tests` and `critical-coverage` all decide what to
 * report from this one list, so its failure modes are their failure modes. Two
 * of them are fatal in opposite directions:
 *
 *  - INCLUDING too much makes the gates noisy. The measured example is in the
 *    module header: treating every non-underscored name as public flagged 41
 *    `critical-untested` violations against this repo, nearly all of them
 *    module-private helpers no test could ever reference. A gate that noisy
 *    gets switched off. So the export check is pinned from both sides here —
 *    an exported name resolves, an identically-shaped unexported one does not.
 *  - INCLUDING something unresolvable points a reviewer at a file that is not
 *    there. `criticality.json` is written by a separate command and can be
 *    stale, or written by the Python sibling in a polyglot repo, so a name that
 *    does not resolve must be dropped rather than reported.
 *
 * Fixtures are throwaway projects with a real `.kragg/criticality.json`, parsed
 * with the compiler passed in explicitly so nothing depends on what is
 * installed where.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import ts from "typescript";

import {
  criticalFunctions,
  simpleName,
} from "../src/gates/testDepth/criticalFunctions.ts";

const temporaryRoots: string[] = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-critical-functions-"));
  temporaryRoots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

/** A project whose `.kragg/criticality.json` holds `records` verbatim. */
function projectWith(records: unknown, files: Readonly<Record<string, string>>): string {
  return project({ ...files, ".kragg/criticality.json": JSON.stringify(records) });
}

/** Every resolved qualname, sorted, so assertions do not depend on walk order. */
function qualnames(root: string, includePrivate = false): readonly string[] {
  return criticalFunctions(root, ["src"], { api: ts, includePrivate })
    .map((critical) => critical.qualname)
    .toSorted();
}

describe("criticalFunctions", () => {
  it("resolves a critical entry to the file that defines it", () => {
    const root = projectWith(
      [{ name: "src/nested/client#Client.send", fan_in: 9, is_critical: true }],
      {
        "src/nested/client.ts": [
          "export class Client {",
          "  send(): number {",
          "    return 1;",
          "  }",
          "}",
        ].join("\n"),
      },
    );
    assert.deepEqual(criticalFunctions(root, ["src"], { api: ts }), [
      {
        qualname: "src/nested/client#Client.send",
        module: "src/nested/client",
        // POSIX separators, repo-relative: a reviewer's path, and a coverage
        // report's key.
        file: "src/nested/client.ts",
        // The last segment — what a test calls it, which is all the reference
        // check in `test-quality` has to search for.
        name: "send",
        fanIn: 9,
      },
    ]);
  });

  it("takes only the entries the criticality run marked critical", () => {
    const root = projectWith(
      [
        { name: "src/a#kept", fan_in: 5, is_critical: true },
        { name: "src/a#belowThreshold", fan_in: 1, is_critical: false },
        { name: "src/a#unmarked", fan_in: 4 },
        // A truthy-but-not-true value is a different tool's spelling, not ours.
        { name: "src/a#stringly", fan_in: 4, is_critical: "true" },
      ],
      {
        "src/a.ts": [
          "export function kept(): number { return 1; }",
          "export function belowThreshold(): number { return 2; }",
          "export function unmarked(): number { return 3; }",
          "export function stringly(): number { return 4; }",
        ].join("\n"),
      },
    );
    assert.deepEqual(qualnames(root), ["src/a#kept"]);
  });

  it("drops a name that resolves to no module under the source paths", () => {
    const root = projectWith(
      [
        { name: "src/a#present", fan_in: 3, is_critical: true },
        // Stale record: the file was deleted after the last criticality run.
        { name: "src/deleted#gone", fan_in: 9, is_critical: true },
        // Outside the policy's source paths.
        { name: "scripts/tool#run", fan_in: 9, is_critical: true },
        // What the PYTHON sibling writes in a polyglot repo: no `#` at all.
        { name: "kragg.gates.criticality.build_graph", fan_in: 9, is_critical: true },
        // A leading separator leaves an empty module, which is not a module.
        { name: "#orphan", fan_in: 9, is_critical: true },
      ],
      {
        "src/a.ts": "export function present(): number { return 1; }",
        "scripts/tool.ts": "export function run(): number { return 2; }",
      },
    );
    assert.deepEqual(qualnames(root), ["src/a#present"]);
  });

  it("drops a name the module does not export, and keeps its exported twin", () => {
    // The header's headline decision, and the expensive one: this is why the
    // lookup walks the source at all instead of judging the string. `hidden`
    // and `shown` are the same shape of name; only the `export` keyword differs.
    const root = projectWith(
      [
        { name: "src/a#shown", fan_in: 8, is_critical: true },
        { name: "src/a#hidden", fan_in: 8, is_critical: true },
      ],
      {
        "src/a.ts": [
          "function hidden(): number { return 1; }",
          "export function shown(): number { return hidden(); }",
        ].join("\n"),
      },
    );
    assert.deepEqual(qualnames(root), ["src/a#shown"]);
    // `includePrivate` is what `critical-coverage` uses: coverage can see an
    // unexported function even though no test can name it.
    assert.deepEqual(qualnames(root, true), ["src/a#hidden", "src/a#shown"]);
  });

  it("judges a method by the binding that reaches it, not by the method name", () => {
    // `Client.send` is reachable because `Client` is exported; `Hidden.send`
    // is not, though the last segment is identical. Matching on the last
    // segment instead of the first would let the second through.
    const root = projectWith(
      [
        { name: "src/a#Client.send", fan_in: 8, is_critical: true },
        { name: "src/a#Hidden.send", fan_in: 8, is_critical: true },
      ],
      {
        "src/a.ts": [
          "class Hidden {",
          "  send(): number { return 1; }",
          "}",
          "export class Client {",
          "  send(): number { return new Hidden().send(); }",
          "}",
        ].join("\n"),
      },
    );
    assert.deepEqual(qualnames(root), ["src/a#Client.send"]);
  });

  it("treats an underscore or an ECMAScript private field as private", () => {
    const root = projectWith(
      [
        { name: "src/a#_internalHelper", fan_in: 7, is_critical: true },
        { name: "src/_private/util#run", fan_in: 7, is_critical: true },
        { name: "src/a#Client.#secret", fan_in: 7, is_critical: true },
        { name: "src/a#Client.send", fan_in: 7, is_critical: true },
      ],
      {
        "src/a.ts": [
          "export function _internalHelper(): number { return 1; }",
          "export class Client {",
          "  #secret(): number { return 1; }",
          "  send(): number { return this.#secret(); }",
          "}",
        ].join("\n"),
        "src/_private/util.ts": "export function run(): number { return 1; }",
      },
    );
    // All three private spellings are dropped even though every one of them is
    // exported — the export check alone would let all three through.
    assert.deepEqual(qualnames(root), ["src/a#Client.send"]);
    assert.deepEqual(qualnames(root, true), [
      "src/_private/util#run",
      "src/a#Client.#secret",
      "src/a#Client.send",
      "src/a#_internalHelper",
    ]);
  });

  it("keeps a TypeScript-private member in the population", () => {
    // TOR-1417 relaxed what counts as EVIDENCE for a `private` member in
    // `test-quality`; it must not have removed the member from the list three
    // gates enforce on. `critical-coverage` still demands that not one of its
    // lines is uncovered, and it can only do that if the member is here.
    const root = projectWith(
      [
        { name: "src/a#Client.sign", fan_in: 3, is_critical: true },
        { name: "src/a#Client.hook", fan_in: 2, is_critical: true },
        { name: "src/a#Client.send", fan_in: 7, is_critical: true },
      ],
      {
        "src/a.ts": [
          "export class Client {",
          "  send(): number { return this.sign(); }",
          "  private sign(): number { return this.hook(); }",
          "  protected hook(): number { return 1; }",
          "}",
        ].join("\n"),
      },
    );
    assert.deepEqual(qualnames(root), [
      "src/a#Client.hook",
      "src/a#Client.send",
      "src/a#Client.sign",
    ]);
  });

  it("recognises every export spelling that binds a callable", () => {
    // `export { local as alias }` records the LOCAL name, because that is what
    // the criticality graph named the declaration. Recording the alias instead
    // would drop the entry that is actually written in the file.
    const root = projectWith(
      [
        { name: "src/a#fromDeclaration", fan_in: 6, is_critical: true },
        { name: "src/a#FromClass.run", fan_in: 6, is_critical: true },
        { name: "src/a#fromConst", fan_in: 6, is_critical: true },
        { name: "src/a#local", fan_in: 6, is_critical: true },
        { name: "src/a#alias", fan_in: 6, is_critical: true },
        { name: "src/a#Ns.nested", fan_in: 6, is_critical: true },
      ],
      {
        "src/a.ts": [
          "export function fromDeclaration(): number { return 1; }",
          "export class FromClass {",
          "  run(): number { return 1; }",
          "}",
          "export const fromConst = (): number => 1;",
          "function local(): number { return 1; }",
          "export { local as alias };",
          "export namespace Ns {",
          "  export function nested(): number { return 1; }",
          "}",
        ].join("\n"),
      },
    );
    assert.deepEqual(qualnames(root), [
      "src/a#FromClass.run",
      "src/a#Ns.nested",
      "src/a#fromConst",
      "src/a#fromDeclaration",
      "src/a#local",
    ]);
  });

  it("strips an accessor prefix from the reported name", () => {
    // `criticality.ts` prefixes accessors to keep a getter distinct from a
    // setter. Neither a test nor a coverage report ever spells the property
    // that way, so the prefix must not reach either.
    const root = projectWith(
      [
        { name: "src/a#Client.get token", fan_in: 4, is_critical: true },
        { name: "src/a#Client.set token", fan_in: 4, is_critical: true },
      ],
      {
        "src/a.ts": [
          "export class Client {",
          "  #value = '';",
          "  get token(): string { return this.#value; }",
          "  set token(next: string) { this.#value = next; }",
          "}",
        ].join("\n"),
      },
    );
    assert.deepEqual(
      criticalFunctions(root, ["src"], { api: ts }).map((critical) => critical.name),
      ["token", "token"],
    );
  });

  it("defaults an absent or non-numeric fan-in to zero rather than dropping the entry", () => {
    // The fan-in is a report detail; the criticality flag is the decision. A
    // record written by a tool at a version we do not control must not lose its
    // entry over a field nothing gates on.
    const root = projectWith(
      [
        { name: "src/a#missing", is_critical: true },
        { name: "src/a#stringly", fan_in: "12", is_critical: true },
        { name: "src/a#nulled", fan_in: null, is_critical: true },
        { name: "src/a#counted", fan_in: 12, is_critical: true },
      ],
      {
        "src/a.ts": [
          "export function missing(): number { return 1; }",
          "export function stringly(): number { return 1; }",
          "export function nulled(): number { return 1; }",
          "export function counted(): number { return 1; }",
        ].join("\n"),
      },
    );
    const byName = new Map(
      criticalFunctions(root, ["src"], { api: ts }).map((critical) => [critical.name, critical.fanIn]),
    );
    assert.equal(byName.get("missing"), 0);
    assert.equal(byName.get("stringly"), 0);
    assert.equal(byName.get("nulled"), 0);
    assert.equal(byName.get("counted"), 12);
  });

  it("drops a record with no usable name", () => {
    const root = projectWith(
      [
        { name: "", fan_in: 3, is_critical: true },
        { name: 42, fan_in: 3, is_critical: true },
        { fan_in: 3, is_critical: true },
        { name: "src/a#real", fan_in: 3, is_critical: true },
      ],
      { "src/a.ts": "export function real(): number { return 1; }" },
    );
    assert.deepEqual(qualnames(root), ["src/a#real"]);
  });

  it("returns nothing when there is no criticality data to read", () => {
    // Not an error: a repo that has never run `kragg criticality --write` is a
    // legitimate state, and the gates render it as a visible skip.
    const noFile = project({ "src/a.ts": "export function a(): number { return 1; }" });
    assert.deepEqual(criticalFunctions(noFile, ["src"], { api: ts }), []);

    const malformed = project({
      "src/a.ts": "export function a(): number { return 1; }",
      ".kragg/criticality.json": "[{\"name\": \"src/a#a\",",
    });
    assert.deepEqual(criticalFunctions(malformed, ["src"], { api: ts }), []);

    // An object where the schema says array — a plausible future format change.
    const wrongShape = projectWith(
      { functions: [{ name: "src/a#a", fan_in: 9, is_critical: true }] },
      { "src/a.ts": "export function a(): number { return 1; }" },
    );
    assert.deepEqual(criticalFunctions(wrongShape, ["src"], { api: ts }), []);
  });

  it("resolves against the source paths it is given, not every path in the repo", () => {
    // A policy naming two source paths must see both, and a critical function
    // in a directory the policy does not call source must not be reported.
    const root = projectWith(
      [
        { name: "src/a#fromSrc", fan_in: 3, is_critical: true },
        { name: "lib/b#fromLib", fan_in: 3, is_critical: true },
      ],
      {
        "src/a.ts": "export function fromSrc(): number { return 1; }",
        "lib/b.ts": "export function fromLib(): number { return 1; }",
      },
    );
    assert.deepEqual(
      criticalFunctions(root, ["src"], { api: ts }).map((critical) => critical.qualname),
      ["src/a#fromSrc"],
    );
    assert.deepEqual(
      criticalFunctions(root, ["src", "lib"], { api: ts })
        .map((critical) => critical.qualname)
        .toSorted(),
      ["lib/b#fromLib", "src/a#fromSrc"],
    );
  });

  it("skips a file the parser could not use, rather than resolving through it", () => {
    // The module index is built from `parsedSources`, so a file with a syntax
    // error contributes no exports. Reporting its functions as critical would
    // point at a file no gate can read.
    const root = projectWith(
      [
        { name: "src/broken#fn", fan_in: 3, is_critical: true },
        { name: "src/good#fn", fan_in: 3, is_critical: true },
      ],
      {
        "src/broken.ts": "export function fn(): number { return 1;\n",
        "src/good.ts": "export function fn(): number { return 1; }",
      },
    );
    assert.deepEqual(qualnames(root), ["src/good#fn"]);
  });
});

/**
 * The name a test and a coverage report actually spell.
 *
 * `criticality.json` records `src/a#Client.send`; istanbul's `fnMap` records
 * `send`, and a test that exercises it writes `send`. Everything the three
 * test-depth gates do — the substring search, the coverage match, the fix
 * hint — is keyed on this reduction, so a wrong answer here does not fail
 * loudly, it silently stops matching and every gate quietly checks less.
 */
describe("simpleName", () => {
  it("keeps a free function's own name", () => {
    assert.equal(simpleName("src/gates/criticality#buildCallGraph"), "buildCallGraph");
  });

  it("drops the qualifiers a report does not carry", () => {
    assert.equal(simpleName("src/engine/gate#Pipeline.run"), "run");
    assert.equal(simpleName("src/a#Outer.Inner.deep"), "deep");
  });

  it("strips the accessor prefix, which nothing downstream spells", () => {
    // `criticality.ts` writes `get token`/`set token` to keep a getter and a
    // setter distinct; neither a test nor a coverage report ever writes that.
    assert.equal(simpleName("src/a#Client.get token"), "token");
    assert.equal(simpleName("src/a#Client.set token"), "token");
  });

  it("handles a name that carries no module at all", () => {
    // What the PYTHON sibling writes, in a repo where both share the file.
    assert.equal(simpleName("build_call_graph"), "build_call_graph");
    assert.equal(simpleName(""), "");
  });
});
