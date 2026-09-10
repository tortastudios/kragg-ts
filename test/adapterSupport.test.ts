/**
 * Tests for the shared adapter support helpers: the total JSON readers, the
 * non-throwing file reads, the run-options builder and the `Unavailable`
 * constructors.
 *
 * These are the smallest modules in `src/adapters/support/`, and they are also
 * the ones every adapter routes its untrusted input through. The properties
 * that matter are not "does it parse a happy document" but the three the
 * module docstrings promise and the adapters above them rely on:
 *
 *  - TOTALITY. Nothing here throws, for any input — truncated JSON, a value of
 *    the wrong shape, a path that is a directory. An adapter that crashed on
 *    one of those would turn a reportable finding into a stack trace.
 *  - NO INHERITED PROPERTIES. Tool output is attacker-influenced (an advisory
 *    title comes from a third-party registry), so `constructor` and `toString`
 *    must read as absent rather than resolving through `Object.prototype`.
 *  - THE KIND SURVIVES. `not-configured` (a visible skip) and `crashed` (an
 *    environment error, exit 3) are different outcomes with different exit
 *    codes, and collapsing them is the fail-open failure kragg exists to stop.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  asArray,
  asCount,
  asNumber,
  asObject,
  asString,
  extractJson,
  isJsonObject,
  objectsIn,
  parseJson,
  prop,
  type JsonObject,
} from "../src/adapters/support/json.ts";
import { readTextFile } from "../src/adapters/support/manifest.ts";
import { capped, crashed, missingTool, notConfigured } from "../src/adapters/support/outcome.ts";
import { runOptions } from "../src/adapters/support/run.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-support-"));
  roots.push(root);
  return root;
}

describe("isJsonObject", () => {
  it("accepts a plain object and rejects every other JSON value", () => {
    assert.equal(isJsonObject({}), true);
    assert.equal(isJsonObject({ a: 1 }), true);
    // Arrays are objects to `typeof`; `asArray` owns them, so this must not.
    assert.equal(isJsonObject([]), false);
    assert.equal(isJsonObject(null), false);
    assert.equal(isJsonObject(undefined), false);
    assert.equal(isJsonObject("{}"), false);
    assert.equal(isJsonObject(7), false);
  });
});

describe("asString", () => {
  it("returns the string, and undefined for any other type", () => {
    const object: JsonObject = { name: "lodash", version: 4, missing: null };
    assert.equal(asString(object, "name"), "lodash");
    assert.equal(asString(object, "version"), undefined);
    assert.equal(asString(object, "missing"), undefined);
    assert.equal(asString(object, "absent"), undefined);
  });

  it("does not resolve an inherited property", () => {
    // A tool report with a `constructor` key must not hand a function back.
    assert.equal(asString({}, "constructor"), undefined);
    assert.equal(asString({}, "toString"), undefined);
  });
});

describe("asNumber", () => {
  it("accepts finite numbers only", () => {
    const object: JsonObject = {
      line: 12,
      negative: -3,
      fractional: 1.5,
      infinite: Number.POSITIVE_INFINITY,
      notANumber: Number.NaN,
      text: "12",
    };
    assert.equal(asNumber(object, "line"), 12);
    assert.equal(asNumber(object, "negative"), -3);
    assert.equal(asNumber(object, "fractional"), 1.5);
    assert.equal(asNumber(object, "infinite"), undefined);
    assert.equal(asNumber(object, "notANumber"), undefined);
    assert.equal(asNumber(object, "text"), undefined);
  });
});

describe("asCount", () => {
  it("rejects the corrupt line numbers asNumber would pass through", () => {
    const object: JsonObject = { zero: 0, line: 12, fractional: 1.5, negative: -1 };
    assert.equal(asCount(object, "zero"), 0);
    assert.equal(asCount(object, "line"), 12);
    // Both would produce a `file:line` pointer that resolves to nothing.
    assert.equal(asCount(object, "fractional"), undefined);
    assert.equal(asCount(object, "negative"), undefined);
  });
});

describe("asArray", () => {
  it("returns the array, and an empty one for anything else", () => {
    const object: JsonObject = { via: [1, 2], scalar: "x", nothing: null };
    assert.deepEqual(asArray(object, "via"), [1, 2]);
    assert.deepEqual(asArray(object, "scalar"), []);
    assert.deepEqual(asArray(object, "nothing"), []);
    assert.deepEqual(asArray(object, "absent"), []);
  });
});

describe("asObject", () => {
  it("returns the nested object, and undefined for an array or a scalar", () => {
    const object: JsonObject = { meta: { id: 1 }, list: [{ id: 1 }], scalar: 1 };
    assert.deepEqual(asObject(object, "meta"), { id: 1 });
    assert.equal(asObject(object, "list"), undefined);
    assert.equal(asObject(object, "scalar"), undefined);
    assert.equal(asObject(object, "absent"), undefined);
  });
});

describe("objectsIn", () => {
  it("keeps the objects and drops everything else, order preserved", () => {
    assert.deepEqual(objectsIn([{ a: 1 }, null, "x", [1], 2, { b: 2 }]), [{ a: 1 }, { b: 2 }]);
    assert.deepEqual(objectsIn([]), []);
  });
});

describe("extractJson", () => {
  it("finds the document inside a tool's human-readable noise", () => {
    const noisy = 'npm warn config global\n{"auditReportVersion":2}\ndone in 3s\n';
    assert.deepEqual(extractJson(noisy), { auditReportVersion: 2 });
  });

  it("does not let a brace inside a string end the value", () => {
    // The classic depth-counting bug: advisory titles routinely contain braces.
    const text = 'banner\n{"title":"fix: use {} not new Object","id":1}\ntrailer';
    assert.deepEqual(extractJson(text), { title: "fix: use {} not new Object", id: 1 });
  });

  it("does not let an escaped quote end the string", () => {
    assert.deepEqual(extractJson('x {"q":"a \\" }","n":2} y'), { q: 'a " }', n: 2 });
  });

  it("extracts a top-level array as readily as an object", () => {
    assert.deepEqual(extractJson('prefix [{"a":1},2] suffix'), [{ a: 1 }, 2]);
  });

  it("returns undefined for truncated output rather than a partial value", () => {
    // The failure this exists for: the tool was killed mid-write.
    assert.equal(extractJson('{"advisories":{"1":{"title":"unterminated'), undefined);
    assert.equal(extractJson('{"a":1'), undefined);
  });

  it("returns undefined when there is no JSON value at all", () => {
    assert.equal(extractJson("npm warn: nothing to report\n"), undefined);
    assert.equal(extractJson(""), undefined);
  });
});

describe("readTextFile", () => {
  it("returns the contents of a readable file", () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "package.json"), '{"name":"a"}\n');
    assert.equal(readTextFile(join(root, "package.json")), '{"name":"a"}\n');
  });

  it("returns undefined instead of throwing for a missing path", () => {
    const root = temporaryRoot();
    assert.equal(readTextFile(join(root, "nope.json")), undefined);
  });

  it("returns undefined for a directory, which readFileSync throws on", () => {
    // A repo where a config NAME is a directory is broken in an ordinary way,
    // not an exceptional one: it must not surface as a stack trace.
    const root = temporaryRoot();
    mkdirSync(join(root, "vitest.config.ts"));
    assert.equal(readTextFile(join(root, "vitest.config.ts")), undefined);
  });
});

describe("runOptions", () => {
  it("omits the key entirely when there is no timeout", () => {
    // Not cosmetic: `exactOptionalPropertyTypes` makes `{ timeoutMs: undefined }`
    // a different type from `{}`, and only the second is assignable here.
    const options = runOptions(undefined);
    assert.deepEqual(options, {});
    assert.equal(Object.hasOwn(options, "timeoutMs"), false);
  });

  it("carries the timeout through when there is one", () => {
    assert.deepEqual(runOptions(30_000), { timeoutMs: 30_000 });
  });
});

describe("notConfigured", () => {
  it("builds the visible-skip outcome, keeping its kind and message", () => {
    const outcome = notConfigured("no secret scanner configured; run `kragg doctor`");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.kind, "not-configured");
    assert.equal(outcome.message, "no secret scanner configured; run `kragg doctor`");
  });
});

describe("crashed", () => {
  it("stays distinct from not-configured, so it cannot become a skip", () => {
    // `crashed` maps to `error: true` and exit 3; `not-configured` to a skip
    // and exit 0. The kind is the only thing that keeps them apart.
    const outcome = crashed("oxlint exited 1 with unreadable stdout: SyntaxError");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.kind, "crashed");
    assert.match(outcome.message, /unreadable stdout/);
    assert.notEqual(outcome.kind, notConfigured("x").kind);
  });
});

describe("capped", () => {
  it("truncates to the limit once the list is longer", () => {
    assert.deepEqual(capped([1, 2, 3, 4], 2), [1, 2]);
  });

  it("returns the list untouched when it fits", () => {
    const items = [1, 2];
    assert.equal(capped(items, 2), items);
    assert.equal(capped(items, 5), items);
  });

  it("treats a limit of zero or less as no cap, never as report-nothing", () => {
    // Silently showing no findings would read as a clean gate.
    const items = [1, 2, 3];
    assert.equal(capped(items, 0), items);
    assert.equal(capped(items, -1), items);
  });
});

describe("parseJson", () => {
  it("returns the document for valid JSON", () => {
    assert.deepEqual(parseJson('{"advisories": [1]}'), { advisories: [1] });
  });

  it("returns undefined for empty, blank and malformed input", () => {
    assert.equal(parseJson(""), undefined);
    assert.equal(parseJson("  \n"), undefined);
    assert.equal(parseJson('{"advisories": ['), undefined);
  });
});

describe("prop", () => {
  it("reads own properties only, never the prototype", () => {
    assert.equal(prop({ title: "x" }, "title"), "x");
    assert.equal(prop({ title: "x" }, "missing"), undefined);
    assert.equal(prop({}, "constructor"), undefined);
    assert.equal(prop({}, "toString"), undefined);
  });
});

describe("missingTool", () => {
  it("builds the missing-tool arm around the install message", () => {
    assert.deepEqual(missingTool("Fix: pnpm add -D vitest"), {
      ok: false,
      kind: "missing-tool",
      message: "Fix: pnpm add -D vitest",
    });
  });
});
