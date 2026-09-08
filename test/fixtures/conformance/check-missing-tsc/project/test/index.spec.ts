import { strict as assert } from "node:assert";
import { test } from "node:test";

import { add, total } from "../src/index.ts";

test("add returns the sum", () => {
  assert.equal(add(2, 3), 5);
});

test("total folds add over the list", () => {
  assert.equal(total([1, 2, 3]), 6);
});
