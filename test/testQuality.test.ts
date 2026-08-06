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

import type { Violation } from "../src/engine/models.ts";
import { writeStamp } from "../src/gates/criticality.ts";
import {
  checkTestQuality,
  CRITICAL_UNTESTED_CODE,
  NO_ASSERT_CODE,
  NO_ASSERT_FIX_HINT,
} from "../src/gates/testQuality.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-test-quality-"));
  roots.push(root);
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
    api: ts,
  });
  assert.equal(outcome.ok, true, "the gate should have run");
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

  it("honours a suppression comment on the flagged site", () => {
    assert.deepEqual(
      violationsFor(`it("known gap", () => { setup(); }); // kragg: ignore`),
      [],
    );
  });
});

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

  it("flags a public critical function no test mentions", () => {
    const violations = violationsIn({
      ".kragg/criticality.json": CRITICALITY,
      "src/client.ts": SOURCE,
      "test/sample.test.ts": `it("builds", () => { expect(new Client()).toBeTruthy(); });`,
    });
    assert.equal(violations.length, 1);
    const violation = violations[0];
    assert.ok(violation !== undefined);
    assert.equal(violation.message, "no test references critical function src/client#Client.send");
    assert.equal(violation.code, CRITICAL_UNTESTED_CODE);
    assert.equal(violation.fixHint, "add a test exercising send directly");
    assert.equal(violation.file, undefined);
  });

  it("is satisfied by a mention anywhere in the test tree", () => {
    assert.deepEqual(
      violationsIn({
        ".kragg/criticality.json": CRITICALITY,
        "src/client.ts": SOURCE,
        "test/helpers.ts": `export const call = (c) => c.send();`,
        "test/sample.test.ts": `it("builds", () => { expect(call(c)).toBe(1); });`,
      }),
      [],
    );
  });

  it("exempts a critical function the module does not export", () => {
    // `helper` is critical and carries no underscore, but nothing outside
    // `src/client.ts` can reach it, so no test could reference it.
    const violations = violationsIn({
      ".kragg/criticality.json": CRITICALITY,
      "src/client.ts": SOURCE,
      "test/sample.test.ts": `it("sends", () => { expect(c.send()).toBe(1); });`,
    });
    assert.deepEqual(violations, []);
  });

  it("says nothing without criticality data", () => {
    assert.deepEqual(
      violationsIn({
        "src/client.ts": SOURCE,
        "test/sample.test.ts": `it("x", () => { expect(1).toBe(1); });`,
      }),
      [],
    );
  });
});

describe("test-quality: when it cannot run", () => {
  it("skips visibly rather than passing on a repo with no tests", () => {
    const outcome = checkTestQuality({
      root: project({ "src/a.ts": "export const a = 1;\n" }),
      testPaths: ["test", "tests"],
      sourcePaths: ["src"],
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
