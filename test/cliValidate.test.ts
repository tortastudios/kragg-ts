/**
 * Direct tests for `src/cli/validate.ts`, split out of `cli.ts` to stay under
 * the file-budget gate. `test/cli.test.ts` exercises these through the real
 * CLI end to end; these pin the functions themselves.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { conflict, format, integer, invalidValue, notACount } from "../src/cli/validate.ts";
import type { Values } from "../src/cli.ts";

/** A minimal `Values` object: every key `Values` declares, all unset. */
function values(overrides: Partial<Values>): Values {
  return {
    help: false,
    version: false,
    file: undefined,
    format: undefined,
    "max-violations": undefined,
    "no-journal": false,
    changed: false,
    since: undefined,
    "fail-fast": false,
    "fast-only": false,
    all: false,
    package: undefined,
    write: false,
    path: undefined,
    rerun: undefined,
    last: undefined,
    limit: undefined,
    symbol: undefined,
    "update-baseline": false,
    ...overrides,
  } as Values;
}

describe("notACount", () => {
  it("accepts digits only, and an absent flag", () => {
    assert.equal(notACount("last", undefined), null);
    assert.equal(notACount("last", "0"), null);
    assert.equal(notACount("last", "10"), null);
  });

  it("rejects a sign, a decimal, scientific notation and non-digits", () => {
    assert.match(notACount("last", "-1") ?? "", /--last must be a non-negative integer/);
    assert.notEqual(notACount("last", "1.5"), null);
    assert.notEqual(notACount("last", "1e3"), null);
    assert.notEqual(notACount("last", "abc"), null);
  });
});

describe("invalidValue", () => {
  it("accepts text and json, and rejects anything else", () => {
    assert.equal(invalidValue(values({ format: "text" })), null);
    assert.equal(invalidValue(values({ format: "json" })), null);
    assert.match(invalidValue(values({ format: "yaml" })) ?? "", /--format must be 'text' or 'json'/);
  });

  it("checks every count flag it knows about", () => {
    assert.notEqual(invalidValue(values({ "max-violations": "abc" })), null);
    assert.notEqual(invalidValue(values({ last: "abc" })), null);
    assert.notEqual(invalidValue(values({ limit: "abc" })), null);
    assert.notEqual(invalidValue(values({ rerun: "abc" })), null);
  });
});

describe("conflict", () => {
  it("rejects --file with --changed or --since", () => {
    assert.notEqual(conflict(values({ changed: true, file: ["a.ts"] })), null);
    assert.notEqual(conflict(values({ since: "main", file: ["a.ts"] })), null);
    assert.equal(conflict(values({ changed: true })), null);
  });

  it("rejects --package with --file, --changed or --since", () => {
    assert.notEqual(conflict(values({ package: ["a"], file: ["a.ts"] })), null);
    assert.notEqual(conflict(values({ package: ["a"], changed: true })), null);
    assert.equal(conflict(values({ package: ["a"] })), null);
  });

  it("rejects --all with --limit", () => {
    assert.notEqual(conflict(values({ all: true, limit: "0" })), null);
    assert.equal(conflict(values({ all: true })), null);
  });

  it("rejects --all with --fast-only, which asks for the opposite tier", () => {
    // TOR-1415. `--all` forces the slow tier to run after a fast failure;
    // `--fast-only` never runs it. Silently honouring one would produce a
    // pipeline the caller did not ask for, and the only visible sign would be
    // which gates are in the report.
    assert.match(
      conflict(values({ all: true, "fast-only": true })) ?? "",
      /--fast-only cannot be combined with --all/,
    );
    // Each alone is fine, and `--fast-only` clashes with nothing else here:
    // it composes with every scope flag.
    assert.equal(conflict(values({ "fast-only": true })), null);
    assert.equal(conflict(values({ "fast-only": true, changed: true })), null);
    assert.equal(conflict(values({ "fast-only": true, file: ["a.ts"] })), null);
    assert.equal(conflict(values({ "fast-only": true, "fail-fast": true })), null);
  });
});

describe("format / integer", () => {
  it("format defaults to text", () => {
    assert.equal(format(values({})), "text");
    assert.equal(format(values({ format: "json" })), "json");
  });

  it("integer falls back on anything not a non-negative integer", () => {
    assert.equal(integer(undefined, 10), 10);
    assert.equal(integer("5", 10), 5);
    assert.equal(integer("-1", 10), 10);
    assert.equal(integer("1.5", 10), 10);
  });
});
