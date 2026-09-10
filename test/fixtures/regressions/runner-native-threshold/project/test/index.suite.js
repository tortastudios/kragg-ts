// Named `*.suite.js`, like every fixture suite here: see the "FIXTURE SUITES
// ARE NAMED `*.suite.*`" section of test/regressionHarness.ts.
//
// Two tests, both passing, deliberately leaving the `zero` and `even` arms of
// `classify` — and `label` entirely — unexecuted. That is enough coverage for
// kragg's own floor (50) and not enough for the runner's own
// `--test-coverage-lines=90`.
import assert from "node:assert/strict";
import { test } from "node:test";

import { classify } from "../src/index.ts";

test("classify names a negative number", () => {
  assert.equal(classify(-1), "negative");
});

test("classify names an odd number", () => {
  assert.equal(classify(7), "odd");
});
