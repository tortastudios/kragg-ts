/**
 * `kragg.schema.json` and the loader must say the same thing.
 *
 * The schema exists so an editor can flag a bad `kragg.json` before kragg
 * does; it is only worth anything if it never disagrees with the loader. No
 * validator dependency is involved: this test reads the schema as data and
 * PROBES THE LOADER with values the schema accepts and values it rejects, so
 * a key, an enum member or a range that drifts on either side fails here.
 *
 * Two directions are checked. Every schema property is a key the loader reads
 * (setting it changes `policy show` output at that key), and every key the
 * loader emits is in the schema. Every property's shape falls into exactly one
 * of the branches below; a new shape is a test failure, not a silent pass.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { DEFAULT_POLICY, loadPolicy, policyAsDict, PolicyError } from "../src/policy/policy.ts";

type Table = Readonly<Record<string, unknown>>;

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function table(value: unknown, what: string): Table {
  assert.ok(isTable(value), what);
  return value;
}

const schema = table(
  JSON.parse(readFileSync(new URL("../kragg.schema.json", import.meta.url), "utf8")),
  "schema root",
);
const properties = table(schema["properties"], "schema.properties");
const definitions = table(schema["definitions"], "schema.definitions");

/** Follow a local `$ref` to its definition; everything else is returned as is. */
function resolve(property: Table): Table {
  const ref = property["$ref"];
  if (typeof ref !== "string") {
    return property;
  }
  const name = ref.replace("#/definitions/", "");
  return { ...table(definitions[name], `definition ${name}`), ...property, $ref: undefined };
}

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Load a one-key config and return what `policy show` would print for it. */
function shown(key: string, value: unknown): unknown {
  const root = mkdtempSync(join(tmpdir(), "kragg-schema-"));
  roots.push(root);
  writeFileSync(join(root, "kragg.json"), JSON.stringify({ [key]: value }));
  return policyAsDict(loadPolicy(root))[key];
}

function rejects(key: string, value: unknown, pattern: RegExp): void {
  assert.throws(
    () => shown(key, value),
    (error: unknown) => {
      assert.ok(error instanceof PolicyError, `${key}=${JSON.stringify(value)} must be rejected`);
      assert.match(error.message, pattern);
      return true;
    },
  );
}

function isStringList(property: Table): boolean {
  return JSON.stringify(property["anyOf"]) === JSON.stringify(resolve({ $ref: "#/definitions/stringList" })["anyOf"]);
}

const SETTINGS = Object.keys(properties).filter((key) => key !== "$schema");

describe("kragg.schema.json mirrors the loader", () => {
  it("lists exactly the keys the loader reads, plus $schema", () => {
    assert.deepEqual([...SETTINGS].sort(), Object.keys(policyAsDict(DEFAULT_POLICY)).sort());
    assert.equal(properties["$schema"] !== undefined, true);
    assert.equal(schema["additionalProperties"], false, "unknown keys must be rejected by both");
  });

  it("accepts $schema without treating it as a setting", () => {
    assert.equal(shown("$schema", "./kragg.schema.json"), undefined);
  });

  it("describes every property and names its default", () => {
    for (const key of SETTINGS) {
      const description = table(properties[key], key)["description"];
      assert.ok(typeof description === "string" && description.includes("Default:"), key);
    }
  });

  for (const key of SETTINGS) {
    const property = resolve(table(properties[key], key));
    const defaults = policyAsDict(DEFAULT_POLICY);

    if (property["type"] === "integer") {
      it(`${key}: the loader enforces the schema's integer range`, () => {
        const min = property["minimum"];
        const max = property["maximum"];
        assert.equal(typeof min, "number", `${key} needs a minimum`);
        assert.ok(typeof min === "number");
        assert.equal(shown(key, min), min);
        rejects(key, min - 1, new RegExp(`#${key} must be an integer`, "u"));
        if (max !== undefined) {
          assert.ok(typeof max === "number");
          assert.equal(shown(key, max), max);
          rejects(key, max + 1, new RegExp(`#${key} must be an integer from ${min} to ${max}`, "u"));
        } else {
          assert.equal(shown(key, 1_000_000), 1_000_000);
        }
        for (const bad of ["5", true, 1.5, null, [5]]) {
          rejects(key, bad, new RegExp(`#${key} must be an integer`, "u"));
        }
      });
    } else if (Array.isArray(property["enum"])) {
      const allowed: readonly unknown[] = property["enum"];
      it(`${key}: the loader accepts exactly the schema's enum`, () => {
        for (const value of allowed) {
          assert.equal(shown(key, value), value);
        }
        rejects(key, "bogus", new RegExp(`#${key} must be one of: ${allowed.join(", ")} `, "u"));
        rejects(key, 3, new RegExp(`#${key} must be one of`, "u"));
      });
    } else if (isStringList(property)) {
      it(`${key}: the loader reads a string or a list of strings`, () => {
        assert.deepEqual(shown(key, "one"), ["one"]);
        assert.deepEqual(shown(key, ["a", "b"]), ["a", "b"]);
        assert.deepEqual(shown(key, []), []);
        rejects(key, ["a", 1], new RegExp(`#${key}\\[1\\] must be a string`, "u"));
        rejects(key, { a: 1 }, new RegExp(`#${key} must be a string or a list of strings`, "u"));
      });
    } else if (key === "forbidden_calls") {
      it(`${key}: the loader reads an entry-to-hint object or a list of entries`, () => {
        assert.deepEqual(shown(key, { "a.b": "hint" }), [["a.b", "hint"]]);
        assert.deepEqual(shown(key, ["z", "a"]), [["a", ""], ["z", ""]]);
        assert.deepEqual(shown(key, {}), []);
        rejects(key, { "a.b": 1 }, /#forbidden_calls\["a\.b"\] must be a string/u);
        rejects(key, ["a", 1], /#forbidden_calls\[1\] must be a string/u);
        rejects(key, "a.b", /#forbidden_calls must be an object/u);
      });
    } else if (JSON.stringify(property["type"]) === '["string","null"]') {
      it(`${key}: the loader reads a string or null`, () => {
        assert.equal(shown(key, "x"), "x");
        assert.equal(shown(key, null), null);
        rejects(key, 1, new RegExp(`#${key} must be a string or null`, "u"));
      });
    } else if (property["type"] === "string") {
      it(`${key}: the loader reads a string`, () => {
        assert.equal(shown(key, "distinctive"), "distinctive");
        assert.notEqual(defaults[key], "distinctive");
        rejects(key, 1, new RegExp(`#${key} must be a string`, "u"));
      });
    } else {
      it(`${key}: has a shape this test knows how to probe`, () => {
        assert.fail(`unrecognised schema shape for ${key}: ${JSON.stringify(property)}`);
      });
    }
  }
});
