import { strict as assert } from "node:assert";
import { test } from "node:test";

import { normalize, parse, render, report, validate } from "../src/index.ts";

test("validate rejects the empty string", () => {
  assert.throws(() => validate(""));
});

test("normalize trims and lowercases", () => {
  assert.equal(normalize("  AB "), "ab");
});

test("the three entry points all go through normalize", () => {
  assert.equal(parse(" A "), "a");
  assert.equal(render(" A "), "<a>");
  assert.equal(report(" A "), "report: a");
});
