/**
 * Tests for the shared inventory budget (`src/commands/inventory.ts`).
 *
 * `map`, `spec` and `brief` all print a slice of something bigger, and they
 * all reach the same three helpers to do it. The property that has to hold in
 * every one of them is that a slice ANNOUNCES ITSELF: `applyBudget` keeps the
 * total it cut from, and `truncationNote` turns that into a line the reader
 * cannot miss. A budget that quietly returned the first N entries would make
 * every one of these commands a confident, incomplete answer — which is the
 * failure the commands themselves exist to prevent, one layer out.
 *
 * `underAnyPath` is the other shared piece, and it is segment-aware for the
 * reason `git/changes.ts` is: a plain `startsWith` lets `--path src` select
 * `srcfoo/`, so a filter would return files the caller did not ask about.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyBudget,
  DEFAULT_LIMIT,
  inventoryOptions,
  isFiltered,
  normalizePath,
  truncationNote,
  underAnyPath,
} from "../src/commands/inventory.ts";

describe("inventory: the output budget", () => {
  const entries = ["a", "b", "c", "d"];

  it("keeps the total it cut from, not just what it kept", () => {
    const budget = applyBudget(entries, 2);
    assert.deepEqual(budget.entries, ["a", "b"]);
    assert.equal(budget.total, 4);
    assert.equal(budget.shown, 2);
    assert.equal(budget.truncated, true);
  });

  it("treats 0 as the deliberate full export, not as an empty one", () => {
    // The whole escape hatch: `--limit 0` and `--all` must mean everything,
    // because a caller who wants the complete inventory has no other way to
    // ask and would otherwise be silently handed the default 100.
    const budget = applyBudget(entries, 0);
    assert.deepEqual(budget.entries, entries);
    assert.equal(budget.shown, 4);
    assert.equal(budget.truncated, false);
  });

  it("does not claim truncation when the limit exceeds the selection", () => {
    const budget = applyBudget(entries, 99);
    assert.equal(budget.truncated, false);
    assert.equal(budget.shown, 4);
    assert.equal(truncationNote(budget, "entries"), null);
  });

  it("names the total and the escape hatch when it did cut", () => {
    assert.equal(
      truncationNote(applyBudget(entries, 1), "exported symbols"),
      "showing 1 of 4 exported symbols — pass --limit 0 for everything",
    );
  });

  it("says nothing at all for an empty selection", () => {
    const budget = applyBudget([], 5);
    assert.equal(budget.total, 0);
    assert.equal(budget.truncated, false);
    assert.equal(truncationNote(budget, "tests"), null);
  });
});

describe("inventory: resolving the flags", () => {
  it("defaults the budget, and reads --all as the full export", () => {
    assert.equal(inventoryOptions({}).limit, DEFAULT_LIMIT);
    assert.equal(inventoryOptions({ all: true }).limit, 0);
    assert.equal(inventoryOptions({ limit: "7" }).limit, 7);
    assert.equal(inventoryOptions({ limit: "0" }).limit, 0);
  });

  it("keeps the default rather than inventing one for a value it cannot read", () => {
    // `cli.ts` rejects this before any command runs; the guard is what keeps
    // that true for a caller that does not come through `dispatch`.
    assert.equal(inventoryOptions({ limit: "abc" }).limit, DEFAULT_LIMIT);
  });

  it("defaults the format to text and reads only the one other value", () => {
    assert.equal(inventoryOptions({}).format, "text");
    assert.equal(inventoryOptions({ format: "json" }).format, "json");
    assert.equal(inventoryOptions({ format: "yaml" }).format, "text");
  });

  it("knows whether anything was actually filtered", () => {
    // What separates "this repository has nothing" from "your filter missed".
    assert.equal(isFiltered(inventoryOptions({})), false);
    assert.equal(isFiltered(inventoryOptions({ limit: "1" })), false);
    assert.equal(isFiltered(inventoryOptions({ path: ["src"] })), true);
    assert.equal(isFiltered(inventoryOptions({ symbol: ["x"] })), true);
    assert.equal(isFiltered(inventoryOptions({ changed: true })), true);
  });
});

describe("inventory: path selection", () => {
  it("matches a path at, or under, a prefix — by segment", () => {
    assert.equal(underAnyPath("src/a.ts", ["src"]), true);
    assert.equal(underAnyPath("src", ["src"]), true);
    assert.equal(underAnyPath("srcfoo/a.ts", ["src"]), false);
    assert.equal(underAnyPath("test/a.ts", ["src"]), false);
  });

  it("unions the prefixes it is given", () => {
    assert.equal(underAnyPath("test/a.ts", ["src", "test"]), true);
  });

  it("selects nothing for an empty prefix list", () => {
    // Matching Python's `any()` over an empty sequence: a caller meaning
    // "everywhere" has to say so, rather than getting it by omission.
    assert.equal(underAnyPath("src/a.ts", []), false);
  });

  it("treats the repository root as selecting everything", () => {
    assert.equal(underAnyPath("src/a.ts", ["."]), true);
    assert.equal(underAnyPath("src/a.ts", [""]), true);
  });

  it("normalises separators, `./` and trailing slashes on both sides", () => {
    assert.equal(underAnyPath("./src/a.ts", ["src/"]), true);
    assert.equal(underAnyPath("src\\a.ts", ["./src"]), true);
    assert.equal(normalizePath("././src/a.ts/"), "src/a.ts");
    assert.equal(normalizePath("/"), "/");
  });
});
