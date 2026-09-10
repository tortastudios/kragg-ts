/**
 * Tests for the test-quality gate.
 *
 * These are written to BREAK the gate. A gate that flags a working test gets
 * switched off within a day, so the suite is weighted toward the false
 * positives that would do it: an assertion reached through `rejects`, through
 * a local helper, through a callback, through a snapshot matcher, through a
 * named import of `node:assert`; and the skipped forms, which are placeholders
 * rather than tests that cannot fail.
 *
 * The gate's own detection rules are name-based, so the fixtures deliberately
 * spell tests the way each of the three supported runners does — vitest's
 * `expect`, node:test's `assert` and `t.assert`, bun:test's `expect` — without
 * importing any of them. That is exactly how a project with globals enabled
 * writes them, and it is the shape the gate must handle.
 *
 * Fixtures are written to a throwaway directory and parsed with the compiler
 * passed in explicitly, so nothing depends on what is installed where.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import ts from "typescript";

import { analysisProgram } from "../src/analysis/program.ts";
import type { Violation } from "../src/engine/models.ts";
import { writeStamp } from "../src/gates/criticality.ts";
import { calleeChain, type CalleeChain } from "../src/gates/testDepth/testCases.ts";
import {
  checkTestQuality,
  CRITICAL_UNTESTED_CODE,
  NO_ASSERT_CODE,
  NO_ASSERT_FIX_HINT,
  SKIPPED_ONLY_NOTE,
} from "../src/gates/testQuality.ts";
import {
  failed as failedOutcome,
  ran as ranOutcome,
  skipped as skippedOutcome,
} from "../src/gates/testDepth/outcome.ts";
import {
  isUnderAny,
  normalizePath,
  OUTSIDE_PROGRAM_NOTE,
} from "../src/gates/testDepth/references.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Includes the test tree, so the checker can bind what the tests name. */
const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "es2022",
    module: "nodenext",
    moduleResolution: "nodenext",
    strict: true,
    allowImportingTsExtensions: true,
    noEmit: true,
    types: [],
  },
  include: ["src", "test", "tests"],
});

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-test-quality-"));
  roots.push(root);
  writeFileSync(join(root, "tsconfig.json"), TSCONFIG);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

/** Run the gate over one test file's worth of source and return findings. */
function violationsFor(body: string): readonly Violation[] {
  return violationsIn({ "test/sample.test.ts": body });
}

function violationsIn(files: Readonly<Record<string, string>>): readonly Violation[] {
  const root = project(files);
  // Vouch for the fixture's `.kragg/criticality.json` before the gate reads
  // it. The gate refuses criticality data that nothing says is current, and a
  // fixture writing the data BEFORE the sources it describes is the exact
  // shape of the bug that check exists for. The real pipeline does this by
  // deriving; see `gates/criticality/freshness.ts`.
  writeStamp(root, ["src", "test", "tests"]);
  const outcome = checkTestQuality({
    root,
    testPaths: ["test", "tests"],
    sourcePaths: ["src"],
    program: analysisProgram({ root, api: ts }),
    api: ts,
  });
  assert.equal(outcome.ok, true, outcome.ok ? "the gate should have run" : outcome.message);
  assert.equal(outcome.skipped, false, "the gate should not have skipped");
  return outcome.ok && !outcome.skipped ? outcome.violations : [];
}

function codes(violations: readonly Violation[]): readonly (string | undefined)[] {
  return violations.map((violation) => violation.code);
}

describe("test-quality: assertion detection", () => {
  it("flags a test that cannot fail", () => {
    const violations = violationsFor(`
      it("does something", () => {
        const result = compute();
        console.log(result);
      });
    `);
    assert.equal(violations.length, 1);
    const violation = violations[0];
    assert.ok(violation !== undefined);
    assert.equal(violation.message, "does something has no assertions");
    assert.equal(violation.code, NO_ASSERT_CODE);
    assert.equal(violation.fixHint, NO_ASSERT_FIX_HINT);
    assert.equal(violation.file, "test/sample.test.ts");
    assert.equal(violation.line, 2);
  });

  it("accepts a plain expect", () => {
    assert.deepEqual(violationsFor(`it("x", () => { expect(1).toBe(1); });`), []);
  });

  it("accepts an awaited rejection assertion", () => {
    assert.deepEqual(
      violationsFor(`
        it("rejects", async () => {
          await expect(run()).rejects.toThrow(RangeError);
        });
      `),
      [],
    );
  });

  it("accepts a snapshot assertion", () => {
    assert.deepEqual(
      violationsFor(`it("renders", () => { expect(render()).toMatchSnapshot(); });`),
      [],
    );
  });

  it("accepts an assertion inside a callback", () => {
    assert.deepEqual(
      violationsFor(`
        it("each item", () => {
          items.forEach((item) => {
            assert.equal(item.ok, true);
          });
        });
      `),
      [],
    );
  });

  it("accepts an assertion inside a locally declared helper", () => {
    assert.deepEqual(
      violationsFor(`
        function checkShape(value) {
          assert.equal(typeof value, "object");
        }
        it("has the shape", () => {
          checkShape(build());
        });
      `),
      [],
    );
  });

  it("follows a helper that only asserts through another helper", () => {
    assert.deepEqual(
      violationsFor(`
        const close = (a, b) => { assert.ok(Math.abs(a - b) < 1e-9); };
        const closeAll = (pairs) => { for (const [a, b] of pairs) close(a, b); };
        it("is close", () => { closeAll(measure()); });
      `),
      [],
    );
  });

  it("terminates on mutually recursive helpers that never assert", () => {
    const violations = violationsFor(`
      function ping(n) { return pong(n); }
      function pong(n) { return ping(n); }
      it("loops", () => { ping(1); });
    `);
    assert.deepEqual(codes(violations), [NO_ASSERT_CODE]);
  });

  it("accepts node:assert reached through a named import", () => {
    assert.deepEqual(
      violationsIn({
        "test/named.test.ts": `
          import { strictEqual } from "node:assert";
          it("is equal", () => { strictEqual(1, 1); });
        `,
      }),
      [],
    );
  });

  it("accepts the node:test context assert namespace", () => {
    assert.deepEqual(
      violationsFor(`test("ctx", (t) => { t.assert.ok(true); });`),
      [],
    );
  });

  it("accepts assert called directly and through the strict namespace", () => {
    assert.deepEqual(
      violationsFor(`
        it("direct", () => { assert(true); });
        it("strict", () => { assert.strict.deepEqual(a, b); });
      `),
      [],
    );
  });

  it("accepts a convention-named assertion helper from another file", () => {
    assert.deepEqual(
      violationsFor(`it("named", () => { assertMatchesSpec(value); });`),
      [],
    );
  });

  it("flags an assertion-free case in a chained each form", () => {
    const violations = violationsFor(`
      it.each([1, 2])("case %i", (n) => {
        compute(n);
      });
    `);
    assert.deepEqual(codes(violations), [NO_ASSERT_CODE]);
  });

  it("flags each assertion-free case separately", () => {
    const violations = violationsFor(`
      describe("group", () => {
        it("first", () => { noop(); });
        it("second", () => { expect(1).toBe(1); });
        test("third", () => { noop(); });
      });
    `);
    assert.deepEqual(
      violations.map((violation) => violation.message),
      ["first has no assertions", "third has no assertions"],
    );
  });
});

describe("test-quality: what is not a broken test", () => {
  it("ignores skipped and todo cases", () => {
    assert.deepEqual(
      violationsFor(`
        it.skip("later", () => {});
        test.todo("planned", () => {});
        it.skip("also later", () => { setup(); });
      `),
      [],
    );
  });

  it("ignores a case skipped through the node:test options object", () => {
    assert.deepEqual(
      violationsFor(`
        test("pending", { skip: true }, () => { setup(); });
        test("noted", { todo: "waiting on the API" }, () => { setup(); });
      `),
      [],
    );
  });

  it("still checks a case whose options say skip: false", () => {
    assert.deepEqual(
      codes(violationsFor(`test("runs", { skip: false }, () => { setup(); });`)),
      [NO_ASSERT_CODE],
    );
  });

  it("ignores every case inside a skipped describe", () => {
    assert.deepEqual(
      violationsFor(`
        describe.skip("group", () => {
          it("first", () => { noop(); });
          it("second", () => { noop(); });
        });
      `),
      [],
    );
  });

  it("ignores a case with no function body to inspect", () => {
    assert.deepEqual(violationsFor(`it.todo("no body at all");`), []);
    assert.deepEqual(violationsFor(`it("delegates", namedCallback);`), []);
  });

  it("still checks a failing case, which runs and must assert", () => {
    assert.deepEqual(
      codes(violationsFor(`it.fails("throws", () => { boom(); });`)),
      [NO_ASSERT_CODE],
    );
  });

  it("ignores a describe with no cases in it", () => {
    assert.deepEqual(violationsFor(`describe("empty", () => {});`), []);
  });

  it("ignores a call to an unrelated function named test", () => {
    assert.deepEqual(violationsFor(`const ok = test(pattern, input);`), []);
  });

  it("honours a suppression comment with a reason on the flagged site", () => {
    assert.deepEqual(
      violationsFor(`it("known gap", () => { setup(); }); // kragg: ignore -- smoke test: setup throwing is the assertion`),
      [],
    );
  });

  it("reports a test whose bare marker names no reason, saying so", () => {
    const violations = violationsFor(`it("known gap", () => { setup(); }); // kragg: ignore`);
    assert.equal(violations.length, 1);
    assert.match(violations[0]?.message ?? "", /^known gap has no assertions \(the `\/\/ kragg: ignore` on line 1 names no reason/u);
  });
});

/**
 * The reference check. A critical function is referenced when an identifier
 * in the test tree, outside a skipped or todo test, BINDS to it through the
 * checker — an alias, a re-export, a helper wrapper and a `describe`-level
 * fixture all qualify, so a valid indirect test is never rejected for
 * lacking a direct call. A comment, a string, a same-named local and a
 * skipped test do not, because none of them exercises the function.
 */
describe("test-quality: critical references", () => {
  const CRITICALITY = JSON.stringify([
    { name: "src/client#Client.send", fan_in: 9, is_critical: true },
    { name: "src/client#helper", fan_in: 4, is_critical: true },
    { name: "src/client#Client.retry", fan_in: 1, is_critical: false },
  ]);

  const SOURCE = `
    export class Client {
      send() {}
      retry() {}
    }
    function helper() {}
  `;

  const IMPORT_CLIENT = 'import { Client } from "../src/client.ts";\n';

  /** The gate over the fixture sources plus the given test-tree files. */
  function referencesIn(tests: Readonly<Record<string, string>>): readonly Violation[] {
    return violationsIn({
      ".kragg/criticality.json": CRITICALITY,
      "src/client.ts": SOURCE,
      ...tests,
    });
  }

  it("flags a public critical function no test binds", () => {
    const violations = referencesIn({
      "test/sample.test.ts": `${IMPORT_CLIENT}it("builds", () => { expect(new Client()).toBeTruthy(); });`,
    });
    assert.equal(violations.length, 1);
    const violation = violations[0];
    assert.ok(violation !== undefined);
    assert.equal(violation.message, "no test references critical function src/client#Client.send");
    assert.equal(violation.code, CRITICAL_UNTESTED_CODE);
    assert.equal(violation.fixHint, "add a test that exercises send, directly or through a helper");
    assert.equal(violation.file, undefined);
  });

  it("is satisfied by a direct call", () => {
    assert.deepEqual(
      referencesIn({
        "test/sample.test.ts": `${IMPORT_CLIENT}it("sends", () => { expect(new Client().send()).toBe(undefined); });`,
      }),
      [],
    );
  });

  it("is not satisfied by the name in a comment or a string", () => {
    const violations = referencesIn({
      "test/sample.test.ts": [
        IMPORT_CLIENT,
        "// TODO: send",
        'it("send works", () => { expect(new Client()).toBeTruthy(); });',
      ].join("\n"),
    });
    assert.deepEqual(codes(violations), [CRITICAL_UNTESTED_CODE]);
  });

  it("is not satisfied by a same-named symbol on another type", () => {
    const violations = referencesIn({
      "test/sample.test.ts": [
        "class Fake { send() { return 1; } }",
        'it("fakes", () => { expect(new Fake().send()).toBe(1); });',
      ].join("\n"),
    });
    assert.deepEqual(codes(violations), [CRITICAL_UNTESTED_CODE]);
  });

  it("is satisfied by a typed helper anywhere in the test tree", () => {
    assert.deepEqual(
      referencesIn({
        "test/helpers.ts": `${IMPORT_CLIENT}export const call = (c: Client) => c.send();`,
        "test/sample.test.ts": `${IMPORT_CLIENT}import { call } from "./helpers.ts";\nit("calls", () => { expect(call(new Client())).toBe(undefined); });`,
      }),
      [],
    );
  });

  it("follows an alias through a re-exporting barrel", () => {
    assert.deepEqual(
      referencesIn({
        "src/auth.ts": "export function verifyPassword(given: string): boolean { return given.length > 3; }\n",
        "test/barrel.ts": 'export { verifyPassword as vp } from "../src/auth.ts";\n',
        "test/sample.test.ts": 'import { vp } from "./barrel.ts";\nit("aliases", () => { expect(vp("abcd")).toBe(true); });',
        ".kragg/criticality.json": JSON.stringify([
          { name: "src/auth#verifyPassword", fan_in: 5, is_critical: true },
        ]),
      }),
      [],
    );
  });

  it("is satisfied by the function passed to a helper, not called", () => {
    assert.deepEqual(
      referencesIn({
        "src/auth.ts": "export function verifyPassword(given: string): boolean { return given.length > 3; }\n",
        "test/sample.test.ts": [
          'import { verifyPassword } from "../src/auth.ts";',
          "function expectAuth(check: (given: string) => boolean): void { assert.ok(check('abcd')); }",
          'it("indirect", () => { expectAuth(verifyPassword); });',
        ].join("\n"),
        ".kragg/criticality.json": JSON.stringify([
          { name: "src/auth#verifyPassword", fan_in: 5, is_critical: true },
        ]),
      }),
      [],
    );
  });

  it("is satisfied by a describe-level fixture", () => {
    assert.deepEqual(
      referencesIn({
        "test/sample.test.ts": [
          IMPORT_CLIENT,
          'describe("Client", () => {',
          "  const client = new Client();",
          "  const send = () => client.send();",
          '  it("sends", () => { expect(send()).toBe(undefined); });',
          "});",
        ].join("\n"),
      }),
      [],
    );
  });

  it("does not count a reference inside a skipped or todo test, and says so", () => {
    const violations = referencesIn({
      "test/sample.test.ts": [
        IMPORT_CLIENT,
        'it.skip("later", () => { expect(new Client().send()).toBe(undefined); });',
        'test("pending", { todo: "soon" }, () => { new Client().send(); });',
        'describe.skip("group", () => { it("x", () => { new Client().send(); }); });',
        'it("real", () => { expect(new Client()).toBeTruthy(); });',
      ].join("\n"),
    });
    assert.deepEqual(
      violations.map((violation) => violation.message),
      [`no test references critical function src/client#Client.send (${SKIPPED_ONLY_NOTE})`],
    );
  });

  it("exempts a critical function the module does not export", () => {
    // `helper` is critical and carries no underscore, but nothing outside
    // `src/client.ts` can reach it, so no test could reference it.
    assert.deepEqual(
      referencesIn({
        "test/sample.test.ts": `${IMPORT_CLIENT}it("sends", () => { expect(new Client().send()).toBe(undefined); });`,
      }),
      [],
    );
  });

  it("names the test files the program does not contain", () => {
    const violations = referencesIn({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, types: [] },
        include: ["src"],
      }),
      "test/sample.test.ts": `${IMPORT_CLIENT}it("sends", () => { expect(new Client().send()).toBe(undefined); });`,
    });
    assert.deepEqual(
      violations.map((violation) => violation.message),
      [
        "no test references critical function src/client#Client.send " +
          `(1 test file is ${OUTSIDE_PROGRAM_NOTE}: test/sample.test.ts)`,
      ],
    );
  });

  it("errors when the program cannot be built", () => {
    const root = project({
      ".kragg/criticality.json": CRITICALITY,
      "src/client.ts": SOURCE,
      "tsconfig.json": "{ not json",
      "test/sample.test.ts": 'it("x", () => { expect(1).toBe(1); });',
    });
    writeStamp(root, ["src", "test", "tests"]);
    const outcome = checkTestQuality({
      root,
      testPaths: ["test", "tests"],
      sourcePaths: ["src"],
      program: analysisProgram({ root, api: ts }),
      api: ts,
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? "" : outcome.message, /tsconfig\.json/u);
  });

  it("does not load the program without a critical function to look for", () => {
    const root = project({
      "src/client.ts": SOURCE,
      "tsconfig.json": "{ not json",
      "test/sample.test.ts": 'it("x", () => { expect(1).toBe(1); });',
    });
    const program = analysisProgram({ root, api: ts });
    const outcome = checkTestQuality({
      root,
      testPaths: ["test", "tests"],
      sourcePaths: ["src"],
      program,
      api: ts,
    });
    assert.equal(outcome.ok && !outcome.skipped && outcome.violations.length, 0);
    assert.equal(program.loaded(), false);
  });
});

describe("test-quality: when it cannot run", () => {
  it("skips visibly rather than passing on a repo with no tests", () => {
    const root = project({ "src/a.ts": "export const a = 1;\n" });
    const outcome = checkTestQuality({
      root,
      testPaths: ["test", "tests"],
      sourcePaths: ["src"],
      program: analysisProgram({ root, api: ts }),
      api: ts,
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok && outcome.skipped, true);
    if (outcome.ok && outcome.skipped) {
      assert.match(outcome.reason, /no test files found/);
      assert.match(outcome.reason, /test, tests/);
    }
  });
});

/**
 * The callee reducer that decides what a test call even IS.
 *
 * Everything above reaches `calleeChain` through `findTestCases`, which can
 * only show the shapes that survive as test cases. The shapes that must NOT
 * become one are just as load-bearing: a call on a computed member the gate
 * cannot name, or on a literal, is not a runner entry point, and inventing a
 * head for it would conjure test cases that do not exist — the opposite of
 * what a test-quality gate is for.
 */
describe("calleeChain", () => {
  /** Reduce the expression `code` denotes, as a callee would be reduced. */
  function chainOf(code: string): CalleeChain | null {
    const source = ts.createSourceFile(
      "snippet.ts",
      `${code};\n`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const statement = source.statements[0];
    assert.ok(statement !== undefined && ts.isExpressionStatement(statement));
    return calleeChain(statement.expression, ts);
  }

  it("reduces a bare identifier to a head with no modifiers", () => {
    assert.deepEqual(chainOf("it"), { head: "it", props: [] });
  });

  it("keeps the property chain outermost last", () => {
    assert.deepEqual(chainOf("it.concurrent.skip"), {
      head: "it",
      props: ["concurrent", "skip"],
    });
  });

  it("reads a string-keyed element access as the property it names", () => {
    assert.deepEqual(chainOf('it["skip"]'), { head: "it", props: ["skip"] });
    assert.deepEqual(chainOf("it[`todo`]"), { head: "it", props: ["todo"] });
    assert.deepEqual(chainOf('it["skip"].each'), {
      head: "it",
      props: ["skip", "each"],
    });
  });

  it("refuses an element access whose key is not a literal", () => {
    assert.equal(
      chainOf("it[modifier]"),
      null,
      "a computed modifier could be anything; guessing would invent a test",
    );
    assert.equal(chainOf("it[0]"), null);
  });

  it("strips the layers that carry no name of their own", () => {
    assert.deepEqual(chainOf("it.each([1, 2])"), { head: "it", props: ["each"] });
    assert.deepEqual(chainOf("it.each`a`"), { head: "it", props: ["each"] });
    assert.deepEqual(chainOf("(it.skip)"), { head: "it", props: ["skip"] });
    assert.deepEqual(chainOf("it.skip!"), { head: "it", props: ["skip"] });
    assert.deepEqual(chainOf("(it as Runner).skip"), { head: "it", props: ["skip"] });
  });

  it("gives up on a root that is not a plain identifier", () => {
    assert.equal(chainOf("this.it"), null);
    assert.equal(chainOf('"it".valueOf'), null);
    assert.equal(chainOf("runners[0].it"), null);
  });
});

/** The three states the test-depth gates report, built by their constructors. */
describe("test-depth outcomes", () => {
  it("builds the three distinguishable states", () => {
    assert.deepEqual(ranOutcome([]), { ok: true, skipped: false, violations: [] });
    assert.deepEqual(skippedOutcome("no data"), { ok: true, skipped: true, reason: "no data" });
    assert.deepEqual(failedOutcome("boom"), { ok: false, message: "boom" });
  });
});

/** The path arithmetic the evidence rule keys its lookups on. */
describe("references: path helpers", () => {
  it("normalises to repo-relative POSIX", () => {
    assert.equal(normalizePath("./test\\a.ts"), "test/a.ts");
    assert.equal(normalizePath("test/"), "test");
    assert.equal(normalizePath("/"), "/");
  });

  it("matches prefixes by segment", () => {
    assert.equal(isUnderAny("test/a.ts", ["test"]), true);
    assert.equal(isUnderAny("testing/a.ts", ["test"]), false);
    assert.equal(isUnderAny("test", ["test"]), true);
    assert.equal(isUnderAny("anything.ts", ["."]), true);
    assert.equal(isUnderAny("src/a.ts", []), false);
  });
});
