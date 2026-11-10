/**
 * Recorded vitest output for the unhandled-error path (TOR-1902), used by
 * `testRunner.test.ts`.
 *
 * NOT a test file (no `.test.ts` suffix), so `node --test "test/**\/*.test.ts"`
 * does not execute it — it is data, imported by the suite that needs it.
 *
 * PROVENANCE. Both values come from ONE real run, not from the parser's
 * expectations: vitest 5.0.0 (darwin-arm64, Node 26.13.0) in the compatibility
 * lane's own vitest+oxlint fixture, after `UNHANDLED_ERROR_FILES`
 * (`scripts/compat/toolFixture.ts`) was written into it, with the argv kragg
 * builds — `--reporter=json`, kragg's reporter from the installed tarball, and
 * a third probe reporter that recorded the list vitest hands reporters. vitest
 * exited 1 with 3 of 3 tests passing and a json report saying `success: true`.
 *
 * The fixture's absolute root is replaced by `RECORDED_ROOT`; nothing else is
 * edited. `atRoot` puts a test's own root back.
 */

/** The placeholder the recorded paths use for the fixture's root. */
export const RECORDED_ROOT = "/recorded-root";

/**
 * The one error vitest 5.0.0 handed `onTestRunEnd`, exactly as it arrived: the
 * worker's serialized object, a source-mapped stack, vitest's own keys, and the
 * two prototype methods its serializer renders as strings.
 */
export const VITEST_5_REPORTER_INPUT = {
  stack: "ReferenceError: document is not defined\n    at captureFocus (/recorded-root/src/widget.ts:14:3)\n    at paint (/recorded-root/src/widget.ts:10:3)\n    at Timeout._onTimeout (/recorded-root/src/widget.ts:5:5)\n    at listOnTimeout (node:internal/timers:685:17)\n    at process.processTimers (node:internal/timers:618:7)",
  message: "document is not defined",
  constructor: "Function<ReferenceError>",
  name: "ReferenceError",
  toString: "Function<toString>",
  VITEST_TEST_NAME: "is still running when the repaint fires",
  VITEST_TEST_PATH: "/recorded-root/test/widget.test.ts",
  type: "Uncaught Exception",
};

/** What kragg's reporter wrote to `unhandled-errors.json` in that run, byte for byte. */
export const VITEST_5_UNHANDLED_ERRORS_FILE = "{\"errors\":[{\"name\":\"ReferenceError\",\"message\":\"document is not defined\",\"stack\":\"ReferenceError: document is not defined\\n    at captureFocus (/recorded-root/src/widget.ts:14:3)\\n    at paint (/recorded-root/src/widget.ts:10:3)\\n    at Timeout._onTimeout (/recorded-root/src/widget.ts:5:5)\\n    at listOnTimeout (node:internal/timers:685:17)\\n    at process.processTimers (node:internal/timers:618:7)\",\"type\":\"Uncaught Exception\",\"testPath\":\"/recorded-root/test/widget.test.ts\",\"testName\":\"is still running when the repaint fires\",\"afterTeardown\":false}]}\n";

/** `text` with the recorded root replaced by `root`. */
export function atRoot(text: string, root: string): string {
  return text.replaceAll(RECORDED_ROOT, root);
}
