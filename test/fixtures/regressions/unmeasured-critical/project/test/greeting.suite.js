// A green suite that never imports `src/audit.ts`.
import assert from "node:assert/strict";
import { test } from "node:test";

import { greet } from "../src/greeting.ts";

test("greet names the caller", () => {
  assert.equal(greet("world"), "hello world");
});
