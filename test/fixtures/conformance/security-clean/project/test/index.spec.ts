import { strict as assert } from "node:assert";
import { test } from "node:test";

import { add } from "../src/index.ts";

test("add", () => {
  assert.equal(add(2, 3), 5);
});
