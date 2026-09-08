import { strict as assert } from "node:assert";
import { test } from "node:test";

import { sign } from "../src/index.ts";

test("sign appends the key", () => {
  assert.equal(sign("a", "k"), "a:k");
});
