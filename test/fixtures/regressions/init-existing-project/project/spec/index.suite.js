// The project's suite lives in `spec/`, which its embedded policy names —
// not in `test/`, which is what a written-out default would have asserted.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { slugify } = require("../lib/index.js");

test("slugify", () => {
  assert.equal(slugify(" Hello World "), "hello-world");
});
