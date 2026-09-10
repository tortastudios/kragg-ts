// Plain JavaScript, named `*.suite.js`, and both on purpose. See the
// "FIXTURE SUITES ARE NAMED `*.suite.*`" section of test/regressionHarness.ts:
// this repository's own test discovery is `test/**/*.{test,spec}.*`, and a
// fixture suite that matched it would be executed as if it were kragg's own.
// The fixture's `kragg.json` names the `*.suite.*` pattern, so the project
// under test still discovers it.
import assert from "node:assert/strict";
import { test } from "node:test";

import { add, formatMoney } from "../src/index.ts";

test("add sums two numbers", () => {
  assert.equal(add(2, 3), 5);
});

test("formatMoney renders an amount and a currency", () => {
  assert.equal(formatMoney({ amount: 1.5, currency: "EUR" }), "1.50 EUR");
});
