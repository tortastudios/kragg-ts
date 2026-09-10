/**
 * Tests for the test-runner adapter.
 *
 * Three runners, three formats, one normalized report. The fixtures are built
 * from each runner's documented/verified output shape — vitest's JSON reporter
 * (read out of an installed vitest 3.2.7 and cross-checked against 4.1.10),
 * node's TAP reporter, bun's console output — and no runner is executed here
 * beyond the one already running these tests.
 *
 * The load-bearing cases:
 *
 *  - a test file that fails to IMPORT is a test failure, not a broken
 *    environment (the `_is_tool_module` distinction from `catalog.py`);
 *  - policy outranks every inference, and no evidence yields no runner;
 *  - a missing runner is an environment error, never a passing gate.
 *
 * The coverage formats have their own file, `adapterCoverage.test.ts`.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { runTests, TEST_GATE } from "../src/adapters/testRunner.ts";
import type { TestRunOutcome } from "../src/adapters/testRunner.ts";
import { detectTestRunner } from "../src/adapters/support/detect.ts";
import { parseBunTest } from "../src/adapters/support/bunTestReport.ts";
import { parseNodeTap } from "../src/adapters/support/nodeTestReport.ts";
import { parseVitestJson } from "../src/adapters/support/vitestReport.ts";
import { artifacts, buildCommand, RUNS_DIR } from "../src/adapters/support/testCommands.ts";
import { fromReport } from "../src/catalog/results.ts";
import { buildReport, EXIT_ENVIRONMENT, reportExitCode } from "../src/engine/report.ts";
import {
  relativeToRoot as reportRelativeToRoot,
  condense,
  stackLocation,
} from "../src/adapters/support/testReport.ts";
import { resolveProjectEnvironment } from "../src/environment/project.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(
  files: Readonly<Record<string, string>>,
  prefix = "kragg-testrunner-",
): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents, "utf8");
  }
  return root;
}

// ── vitest ─────────────────────────────────────────────────────────────────

const VITEST_REPORT = JSON.stringify({
  numTotalTestSuites: 2,
  numPassedTestSuites: 1,
  numFailedTestSuites: 1,
  numPendingTestSuites: 0,
  numTotalTests: 3,
  numPassedTests: 1,
  numFailedTests: 1,
  numPendingTests: 1,
  numTodoTests: 0,
  startTime: 1_697_737_019_307,
  success: false,
  testResults: [
    {
      assertionResults: [
        {
          ancestorTitles: ["", "math"],
          fullName: " math adds",
          status: "passed",
          title: "adds",
          duration: 2,
          failureMessages: [],
          meta: {},
        },
        {
          ancestorTitles: ["", "math"],
          fullName: " math subtracts",
          status: "failed",
          title: "subtracts",
          duration: 3,
          failureMessages: [
            "AssertionError: expected 5 to be 4 // Object.is equality\n" +
              "    at /repo/test/math.test.ts:21:20\n" +
              "    at node_modules/@vitest/runner/dist/index.js:9:1",
          ],
          location: { line: 20, column: 28 },
          meta: {},
        },
        {
          ancestorTitles: ["", "math"],
          fullName: " math divides",
          status: "skipped",
          title: "divides",
          failureMessages: [],
          meta: {},
        },
      ],
      startTime: 1,
      endTime: 2,
      status: "failed",
      message: "",
      name: "/repo/test/math.test.ts",
    },
  ],
  snapshot: {},
});

test("vitest: a failed assertion becomes one pointer with a re-run command", () => {
  const report = parseVitestJson(VITEST_REPORT, "/repo");
  assert.ok(report !== undefined);
  assert.equal(report.success, false);
  assert.deepEqual(report.summary, {
    total: 3,
    passed: 1,
    failed: 1,
    skipped: 1,
    todo: 0,
    failedFiles: 1,
  });

  assert.equal(report.violations.length, 1);
  const violation = report.violations[0];
  // Project-relative: an absolute path embeds a home directory and cannot be
  // diffed between machines.
  assert.equal(violation?.file, "test/math.test.ts");
  // `location` is the DEFINITION site and wins over the stack's top frame.
  assert.equal(violation?.line, 20);
  assert.equal(violation?.column, 28);
  assert.equal(violation?.code, "test-failed");
  assert.match(violation?.message ?? "", /expected 5 to be 4/u);
  assert.match(violation?.fixHint ?? "", /vitest run test\/math\.test\.ts -t 'math subtracts'/u);
});

test("vitest: the stack is used when --includeTaskLocation was not passed", () => {
  const withoutLocation = VITEST_REPORT.replace('"location":{"line":20,"column":28},', "");
  const report = parseVitestJson(withoutLocation, "/repo");
  assert.ok(report !== undefined);
  // The frame inside node_modules must never be preferred over the test file.
  assert.equal(report.violations[0]?.line, 21);
  assert.equal(report.violations[0]?.column, 20);
});

test("vitest: a test file that fails to IMPORT is a test failure, not a broken env", () => {
  const importFailure = JSON.stringify({
    numTotalTests: 0,
    numPassedTests: 0,
    numFailedTests: 0,
    success: false,
    testResults: [
      {
        assertionResults: [],
        startTime: 1,
        endTime: 1,
        status: "failed",
        message: "Cannot find module './helpers.ts' imported from /repo/test/api.test.ts",
        name: "/repo/test/api.test.ts",
      },
    ],
  });
  const report = parseVitestJson(importFailure, "/repo");
  assert.ok(report !== undefined);
  assert.equal(report.violations.length, 1);
  // Its own code, so a reader can tell "your import is wrong" from
  // "your assertion is wrong" — and neither from "vitest is missing".
  assert.equal(report.violations[0]?.code, "test-suite-error");
  assert.equal(report.violations[0]?.file, "test/api.test.ts");
  assert.match(report.violations[0]?.message ?? "", /Cannot find module/u);
});

test("vitest: a run matching no test files is a failure, not an empty pass", () => {
  const noFiles = JSON.stringify({
    numTotalTests: 0,
    numPassedTests: 0,
    numFailedTests: 0,
    success: false,
    testResults: [],
  });
  const report = parseVitestJson(noFiles, "/repo");
  assert.ok(report !== undefined);
  assert.equal(report.success, false);
  assert.deepEqual(report.violations, []);
});

test("vitest: malformed, truncated, empty and foreign JSON never parse", () => {
  const bad = ["", " \n", "not json", '{"numTotalTests":3,"testResults":[', '{"issues":[]}', "[]"];
  for (const text of bad) {
    assert.equal(parseVitestJson(text, "/repo"), undefined, text);
  }
});

// ── node --test (TAP) ──────────────────────────────────────────────────────

const NODE_TAP = `TAP version 13
# Subtest: adds
ok 1 - adds
  ---
  duration_ms: 0.5
  ...
# Subtest: subtracts
not ok 2 - subtracts
  ---
  duration_ms: 1.2
  location: '/repo/test/math.test.ts:12:1'
  failureType: 'testCodeFailure'
  error: 'Expected values to be strictly equal:\\n\\n1 !== 2'
  code: 'ERR_ASSERTION'
  stack: |-
    TestContext.<anonymous> (/repo/test/math.test.ts:13:3)
    Test.run (node:internal/test_runner/test:1118:25)
  ...
# Subtest: pending
not ok 3 - pending # SKIP
  ---
  ...
1..3
# tests 3
# suites 0
# pass 1
# fail 1
# cancelled 0
# skipped 1
# todo 0
# duration_ms 40
`;

test("node: parses TAP counts, locations and re-run commands", () => {
  const report = parseNodeTap(NODE_TAP, "/repo");
  assert.ok(report !== undefined);
  assert.equal(report.summary.total, 3);
  assert.equal(report.summary.passed, 1);
  assert.equal(report.summary.failed, 1);
  assert.equal(report.summary.skipped, 1);
  assert.equal(report.success, false);

  assert.equal(report.violations.length, 1);
  const violation = report.violations[0];
  assert.equal(violation?.file, "test/math.test.ts");
  assert.equal(violation?.line, 12);
  assert.match(violation?.message ?? "", /subtracts/u);
  assert.match(violation?.fixHint ?? "", /node --test test\/math\.test\.ts/u);
});

test("node: a `# SKIP` directive is not a failure", () => {
  const report = parseNodeTap(NODE_TAP, "/repo");
  assert.ok(report !== undefined);
  assert.ok(!report.violations.some((violation) => /pending/u.test(violation.message)));
});

test("node: a subtestsFailed rollup does not double-report its children", () => {
  const withRollup = `TAP version 13
    # Subtest: fails
    not ok 1 - fails
      ---
      location: '/repo/test/a.test.ts:3:1'
      failureType: 'testCodeFailure'
      error: 'boom'
      ...
    1..1
not ok 1 - test/a.test.ts
  ---
  location: '/repo/test/a.test.ts:1:1'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  ...
1..1
# tests 1
# pass 0
# fail 1
`;
  const report = parseNodeTap(withRollup, "/repo");
  assert.ok(report !== undefined);
  assert.equal(report.violations.length, 1);
  assert.match(report.violations[0]?.message ?? "", /^fails/u);
});

test("node: a clean run passes and a truncated one is unreadable", () => {
  const clean = "TAP version 13\nok 1 - works\n1..1\n# tests 1\n# pass 1\n# fail 0\n";
  const report = parseNodeTap(clean, "/repo");
  assert.ok(report !== undefined);
  assert.equal(report.success, true);
  assert.deepEqual(report.violations, []);

  // No summary and no failure recorded: the process died before finishing and
  // nothing it printed says whether the tests pass. That is not a test
  // failure to report against the code; it is evidence kragg cannot use.
  assert.equal(parseNodeTap("TAP version 13\nok 1 - works\n", "/repo"), undefined);

  // A failure recorded BEFORE the process died is real and is kept — but the
  // incomplete run is still not a pass.
  const partialWithFailure = parseNodeTap(
    "TAP version 13\nnot ok 1 - breaks\n  ---\n  location: '/repo/test/a.test.ts:3:1'\n" +
      "  failureType: 'testCodeFailure'\n  error: 'boom'\n  ...\n",
    "/repo",
  );
  assert.ok(partialWithFailure !== undefined);
  assert.equal(partialWithFailure.success, false);
  assert.equal(partialWithFailure.violations.length, 1);
});

test("node: output that is not TAP at all does not parse", () => {
  for (const bad of ["", "node: bad option: --nope", "{}"]) {
    assert.equal(parseNodeTap(bad, "/repo"), undefined, bad);
  }
});

// ── bun test ───────────────────────────────────────────────────────────────

test("bun: scrapes counts and failures from the console output", () => {
  const output = `bun test v1.3.14 (abcdef01)

test/math.test.ts:
(pass) math > adds [0.05ms]
(fail) math > subtracts [0.10ms]
  error: expect(received).toBe(expected)

 1 pass
 0 skip
 1 fail
 2 expect() calls
Ran 2 tests across 1 files. [12.00ms]
`;
  const report = parseBunTest(output, 1);
  assert.ok(report !== undefined);
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.passed, 1);
  assert.equal(report.summary.failed, 1);
  assert.equal(report.success, false);
  assert.equal(report.violations[0]?.file, "test/math.test.ts");
  assert.match(report.violations[0]?.message ?? "", /expect\(received\)/u);
  assert.match(report.violations[0]?.fixHint ?? "", /bun test test\/math\.test\.ts/u);
});

test("bun: the TTY marker is recognised too, and a clean run needs exit 0", () => {
  const output = "✓ adds [0.05ms]\n✗ subtracts [0.10ms]\n 1 pass\n 1 fail\n";
  const report = parseBunTest(output, 1);
  assert.ok(report !== undefined);
  assert.equal(report.violations.length, 1);

  const clean = parseBunTest(" 2 pass\n 0 fail\nRan 2 tests across 1 files.\n", 0);
  assert.ok(clean !== undefined);
  assert.equal(clean.success, true);

  // The exit code is authoritative: bun's text format is not a contract, so a
  // non-zero exit with no parsed failure must still not read as a pass.
  const exitOnly = parseBunTest(" 2 pass\n 0 fail\nRan 2 tests across 1 files.\n", 1);
  assert.ok(exitOnly !== undefined);
  assert.equal(exitOnly.success, false);
});

test("bun: unrecognisable output does not parse", () => {
  assert.equal(parseBunTest("", 1), undefined);
  assert.equal(parseBunTest("bun: command not found", 127), undefined);
});

// ── detection ──────────────────────────────────────────────────────────────

test("the test script outranks a config file and a dependency", () => {
  const root = project({
    "package.json": JSON.stringify({
      scripts: { test: "tsc --noEmit && node --test" },
      devDependencies: { vitest: "3.2.7" },
    }),
    "vitest.config.ts": "export default {}",
  });
  const detection = detectTestRunner(root, "auto");
  assert.equal(detection.runner, "node");
  assert.equal(detection.source, "package.json#scripts.test");
});

test("the first runner token in the script wins", () => {
  const root = project({
    "package.json": JSON.stringify({ scripts: { test: "vitest run && bun test" } }),
  });
  assert.equal(detectTestRunner(root, "auto").runner, "vitest");
});

test("a vitest config, then a vitest dependency, then bun evidence", () => {
  assert.equal(
    detectTestRunner(project({ "package.json": "{}", "vitest.config.mts": "" }), "auto").runner,
    "vitest",
  );
  assert.equal(
    detectTestRunner(
      project({ "package.json": JSON.stringify({ devDependencies: { vitest: "3" } }) }),
      "auto",
    ).runner,
    "vitest",
  );
  const bunTypes = project({ "package.json": '{"devDependencies":{"@types/bun":"1.2.0"}}' });
  assert.deepEqual(detectTestRunner(bunTypes, "auto"), {
    runner: "bun",
    source: "package.json dependency: @types/bun",
  });
  assert.equal(
    detectTestRunner(project({ "package.json": "{}", "bunfig.toml": "[test]\n" }), "auto").runner,
    "bun",
  );
});

test("policy outranks every inference, and `off` means off", () => {
  const root = project({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) });
  assert.equal(detectTestRunner(root, "node").runner, "node");
  assert.equal(detectTestRunner(root, "off").runner, undefined);
});

test("an unsupported runner is named rather than reported as absent", () => {
  const root = project({ "package.json": JSON.stringify({ scripts: { test: "jest --ci" } }) });
  const detection = detectTestRunner(root, "auto");
  assert.equal(detection.runner, undefined);
  assert.equal(detection.unsupported, "jest");
});

test("no evidence yields no runner rather than defaulting to node", () => {
  const detection = detectTestRunner(project({ "package.json": '{"name":"x"}' }), "auto");
  assert.equal(detection.runner, undefined);
  assert.equal(detection.source, "no test runner detected");
});

// ── commands ───────────────────────────────────────────────────────────────

const RUN_DIR = "/repo/.kragg/runs/test-abc123";

test("vitest is told where to write both of its reports", () => {
  const layout = artifacts("/repo", "coverage/coverage-final.json", RUN_DIR);
  const command = buildCommand(["/repo/node_modules/.bin/vitest"], "vitest", layout, true, []);
  assert.ok(command.includes("--includeTaskLocation"), "location needs the explicit flag");
  // Both into THIS run's directory, never the shared location.
  assert.ok(command.includes(`--outputFile=${RUN_DIR}/test-report.json`));
  assert.ok(command.includes(`--coverage.reportsDirectory=${RUN_DIR}/coverage`));
  assert.ok(command.includes("--coverage.reporter=json"));
  // Without this a failing run writes no coverage at all.
  assert.ok(command.includes("--coverage.reportOnFailure"));
  // No threshold is delegated: vitest signals it with the same exit code as a
  // test failure, which would destroy the distinction.
  assert.ok(!command.some((argument) => argument.includes("thresholds")));
});

test("node pairs each reporter with the destination that follows it", () => {
  const layout = artifacts("/repo", "coverage/coverage-final.json", RUN_DIR);
  const command = buildCommand(["/usr/bin/node"], "node", layout, true, ["test/"]);
  const tap = command.indexOf("--test-reporter=tap");
  const tapTo = command.indexOf("--test-reporter-destination=stdout");
  const lcov = command.indexOf("--test-reporter=lcov");
  assert.ok(tap >= 0 && tapTo === tap + 1, "tap destination must follow tap");
  assert.ok(lcov > tapTo, "lcov reporter must come after the tap pair");
  assert.equal(command[lcov + 1], `--test-reporter-destination=${layout.lcovFile}`);
  // `test_paths` are DIRECTORIES, and `node --test test` runs nothing at all:
  // it resolves the argument as a module, dies with `Cannot find module`, and
  // the TAP reader turns that into "1 test, 1 failed". `buildCommand` is the
  // one place that expands them, so no caller can reintroduce the bare form.
  assert.equal(command.at(-1), "test/**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}");
  assert.ok(!command.includes("test/"), "a bare directory must never reach node --test");
});

test("every configured test path becomes its own glob, trailing slash or not", () => {
  const layout = artifacts("/repo", "coverage/coverage-final.json", RUN_DIR);
  const command = buildCommand(["/usr/bin/node"], "node", layout, false, ["test", "tests/"]);
  assert.deepEqual(command.slice(-2), [
    "test/**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
    "tests/**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
  ]);
});

test("bun asks for lcov, the only coverage format it can write", () => {
  const layout = artifacts("/repo", "coverage/coverage-final.json", RUN_DIR);
  const command = buildCommand(["bun"], "bun", layout, true, []);
  assert.deepEqual(command, [
    "bun",
    "test",
    "--coverage",
    "--coverage-reporter=lcov",
    `--coverage-dir=${layout.coverageDir}`,
  ]);
});

test("the runner writes into this run's directory; the configured path is where it is published", () => {
  const layout = artifacts("/repo", "reports/cov/coverage-final.json", RUN_DIR);
  assert.equal(layout.runDir, RUN_DIR);
  assert.equal(layout.coverageDir, `${RUN_DIR}/coverage`);
  assert.equal(layout.istanbulFile, `${RUN_DIR}/coverage/coverage-final.json`);
  assert.equal(layout.lcovFile, `${RUN_DIR}/coverage/lcov.info`);
  // `coverage_report_path` still decides where the coverage ends up — for
  // `kragg coverage` — and the lcov beside it; no gate reads either.
  assert.equal(layout.publishedIstanbulFile, "/repo/reports/cov/coverage-final.json");
  assert.equal(layout.publishedLcovFile, "/repo/reports/cov/lcov.info");
});

// ── end to end skips ───────────────────────────────────────────────────────

test("a project with no runner skips visibly with install commands", async () => {
  const outcome = await runTests({
    env: resolveProjectEnvironment(
      project({ "package.json": '{"name":"x"}', "pnpm-lock.yaml": "" }),
    ),
    choice: "auto",
    coverageFailUnder: 80,
    maxViolations: 25,
    testPaths: ["test"],
    sourcePaths: ["src"],
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "not-configured");
  assert.match(outcome.message, /no test runner detected/u);
  assert.match(outcome.message, /pnpm add -D vitest/u);
  assert.match(outcome.message, /nothing was verified/iu);
});

test("a missing vitest is an environment error, not a passing gate", async () => {
  const outcome = await runTests({
    env: resolveProjectEnvironment(
      project({
        "package.json": JSON.stringify({
          packageManager: "pnpm@11.9.0",
          scripts: { test: "vitest run" },
        }),
      }),
    ),
    choice: "auto",
    coverageFailUnder: 80,
    maxViolations: 25,
    testPaths: ["test"],
    sourcePaths: ["src"],
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "missing-tool");
  assert.match(outcome.message, /pnpm add -D vitest/u);
});

test("`test_runner: off` is a deliberate skip that says so", async () => {
  const outcome = await runTests({
    env: resolveProjectEnvironment(project({ "package.json": "{}" })),
    choice: "off",
    coverageFailUnder: 80,
    maxViolations: 25,
    testPaths: ["test"],
    sourcePaths: ["src"],
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /switched off/u);
});

// ── current-run evidence ───────────────────────────────────────────────────
//
// The runner is a stand-in `node_modules/.bin/vitest` — an `sh` script, the
// same seam `tsc.test.ts` and `lint.test.ts` use — that receives the exact
// argv kragg builds, so it writes (or fails to write) precisely where a real
// vitest would. Nothing here spawns anything except through `runTests`.

/** Stale artifacts at the locations a PREVIOUS run would have left them. */
const STALE_LOCATIONS = {
  ".kragg/test-report.json": "",
  "coverage/coverage-final.json": "",
  "coverage/notes.txt": "unrelated; must survive\n",
};

/** sh: pick the two paths kragg passes out of the argv. */
const READ_ARGV = [
  'for arg in "$@"; do',
  '  case "$arg" in',
  '    --outputFile=*) out="${arg#--outputFile=}" ;;',
  '    --coverage.reportsDirectory=*) cov="${arg#--coverage.reportsDirectory=}" ;;',
  "  esac",
  "done",
].join("\n");

/** sh: write `content` to `$out`, verbatim (quoted heredoc — nothing expands). */
function writeReport(content: string): string {
  return `mkdir -p "$(dirname "$out")"\ncat > "$out" <<'KRAGG_EOF'\n${content}\nKRAGG_EOF`;
}

/** sh: write `content` as this run's `coverage-final.json`. */
function writeCoverage(content: string): string {
  return `mkdir -p "$cov"\ncat > "$cov/coverage-final.json" <<'KRAGG_EOF'\n${content}\nKRAGG_EOF`;
}

interface FakeTest {
  readonly title: string;
  readonly status: "passed" | "failed";
}

/** A vitest JSON report in the reporter's real shape. */
function vitestReport(tests: readonly FakeTest[]): string {
  const failed = tests.filter((entry) => entry.status === "failed").length;
  return JSON.stringify({
    numTotalTests: tests.length,
    numPassedTests: tests.length - failed,
    numFailedTests: failed,
    numPendingTests: 0,
    numTodoTests: 0,
    success: failed === 0,
    testResults: [
      {
        assertionResults: tests.map((entry) => ({
          ancestorTitles: [],
          fullName: entry.title,
          title: entry.title,
          status: entry.status,
          failureMessages: entry.status === "failed" ? [`${entry.title} failed`] : [],
          meta: {},
        })),
        startTime: 1,
        endTime: 2,
        status: failed === 0 ? "passed" : "failed",
        message: "",
        name: "/repo/test/a.test.ts",
      },
    ],
  });
}

const GREEN = vitestReport([{ title: "adds", status: "passed" }]);
const RED = vitestReport([{ title: "subtracts", status: "failed" }]);

/** An istanbul report with one fully covered statement. */
// Keyed relatively, as c8 and CI path rewrites produce: the totals count only
// files under the project's `source_paths`, and a key under a foreign root
// would resolve to none of them.
const FULL_COVERAGE = JSON.stringify({
  "src/a.ts": {
    path: "src/a.ts",
    statementMap: { "0": { start: { line: 1, column: 0 }, end: { line: 1, column: 9 } } },
    fnMap: {},
    branchMap: {},
    s: { "0": 3 },
    f: {},
    b: {},
  },
});

/**
 * A vitest project whose `vitest` is `script`, run after `READ_ARGV`.
 *
 * Stale artifacts from a "previous successful run" are always present, so
 * every test below is also the "prior success followed by X" case: an
 * outcome that credits them is the bug.
 */
function vitestProject(script: string, stale: Record<string, string> = STALE_LOCATIONS): string {
  const root = project({
    "package.json": JSON.stringify({
      packageManager: "pnpm@11.9.0",
      scripts: { test: "vitest run" },
    }),
    "pnpm-lock.yaml": "",
    ...stale,
    ".kragg/test-report.json": stale[".kragg/test-report.json"] || GREEN,
    "coverage/coverage-final.json": stale["coverage/coverage-final.json"] || FULL_COVERAGE,
  });
  const bin = join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "vitest"), `#!/bin/sh\n${READ_ARGV}\n${script}\n`, { mode: 0o755 });
  return root;
}

function run(root: string, timeoutMs?: number): Promise<TestRunOutcome> {
  return runTests({
    env: resolveProjectEnvironment(root),
    choice: "auto",
    coverageFailUnder: 80,
    maxViolations: 25,
    testPaths: ["test"],
    sourcePaths: ["src"],
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/** The stale files and the unrelated one are still exactly as seeded. */
function assertPreserved(root: string): void {
  assert.equal(readFileSync(join(root, ".kragg/test-report.json"), "utf8"), GREEN);
  assert.equal(readFileSync(join(root, "coverage/notes.txt"), "utf8"), STALE_LOCATIONS["coverage/notes.txt"]);
  // No per-run directory is left behind, on any path out of `runTests`.
  assert.deepEqual(readdirSync(join(root, RUNS_DIR)), []);
}

test("a crashed runner is an error — never the previous run's pass", async () => {
  const root = vitestProject("echo 'Error: worker crashed' >&2\nexit 1");
  const outcome = await run(root);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "crashed");
  assert.match(outcome.message, /vitest exited 1 without a complete test report for this run/u);
  // What was expected and what was found, so the reader knows which it is.
  assert.match(outcome.message, /expected: .*\/\.kragg\/runs\/test-[^/]+\/test-report\.json/u);
  assert.match(outcome.message, /found: no file at/u);
  assert.match(outcome.message, /worker crashed/u);
  assertPreserved(root);
  assert.equal(readFileSync(join(root, "coverage/coverage-final.json"), "utf8"), FULL_COVERAGE);
});

test("a runner kragg had to kill is an error, even if it left a plausible report", async () => {
  // Writes a complete green report AND coverage, then hangs: the run did not
  // finish, so what it wrote is not accepted as complete evidence.
  const root = vitestProject(`${writeReport(GREEN)}\n${writeCoverage(FULL_COVERAGE)}\nexec sleep 30`);
  const outcome = await run(root, 300);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "crashed");
  assert.match(outcome.message, /vitest did not finish: kragg terminated it after 300 ms/u);
  assertPreserved(root);
});

test("a partial report is unusable evidence, not a failed test", async () => {
  const root = vitestProject(`${writeReport('{"numTotalTests":3,"testResults":[')}\nexit 0`);
  const outcome = await run(root);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "crashed");
  assert.match(outcome.message, /found: \d+ bytes there that are not a complete vitest report/u);
  assertPreserved(root);
});

test("green tests without a coverage artifact are an error, with the tests kept", async () => {
  const root = vitestProject(`${writeReport(GREEN)}\nexit 0`);
  const outcome = await run(root);
  assert.ok(outcome.ok);
  assert.equal(outcome.passed, false);
  assert.equal(outcome.error, true);
  assert.equal(outcome.summary.passed, 1);
  assert.match(outcome.output, /coverage unavailable — no complete coverage report for this run/u);
  assert.match(outcome.output, /no coverage report at .*\/\.kragg\/runs\/test-[^/]+\/coverage\/coverage-final\.json/u);

  // Through the gate mapping: ERROR, exit 3, and the message survives.
  const gate = fromReport(TEST_GATE, outcome);
  assert.equal(gate.error, true);
  assert.equal(gate.passed, false);
  assert.match(gate.output, /coverage unavailable/u);
  assert.equal(exitCodeFor(gate), EXIT_ENVIRONMENT);
  assertPreserved(root);
  // The stale istanbul report was NOT published over or read.
  assert.equal(readFileSync(join(root, "coverage/coverage-final.json"), "utf8"), FULL_COVERAGE);
});

test("failing tests without a coverage artifact keep the failures AND error", async () => {
  const root = vitestProject(`${writeReport(RED)}\nexit 1`);
  const outcome = await run(root);
  assert.ok(outcome.ok);
  assert.equal(outcome.error, true);
  assert.equal(outcome.violations.length, 1);
  assert.equal(outcome.violations[0]?.code, "test-failed");
  const gate = fromReport(TEST_GATE, outcome);
  assert.equal(gate.error, true);
  assert.equal(gate.violationCount, 1);
  // Parsed violations normally suppress the raw output; an error must not,
  // because the output is the only place the missing evidence is explained.
  assert.match(gate.output, /coverage unavailable/u);
});

test("a truncated coverage artifact is not read as coverage", async () => {
  const root = vitestProject(`${writeReport(GREEN)}\n${writeCoverage('{"/repo/src/a.ts":{"s":')}\nexit 0`);
  const outcome = await run(root);
  assert.ok(outcome.ok);
  assert.equal(outcome.error, true);
  assert.match(outcome.output, /not a JSON object \(truncated or not a coverage report\)/u);
  assertPreserved(root);
});

test("a complete run is credited, and its coverage is published where it is configured", async () => {
  const root = vitestProject(`${writeReport(GREEN)}\n${writeCoverage(FULL_COVERAGE)}\nexit 0`);
  const outcome = await run(root);
  assert.ok(outcome.ok);
  assert.equal(outcome.passed, true);
  assert.equal(outcome.error, false);
  assert.ok(outcome.coverage?.ok);
  assert.equal(outcome.coverage.evidence.format, "istanbul");
  assert.equal(outcome.coverage.totals.pct, 100);
  // This run's report replaced the stale one at `coverage_report_path`; the
  // unrelated file beside it is untouched, and the run directory is gone.
  assert.equal(readFileSync(join(root, "coverage/coverage-final.json"), "utf8"), `${FULL_COVERAGE}\n`);
  assertPreserved(root);
});

test("switching runners: node's lcov is this run's evidence; vitest's stale istanbul is not consulted", async () => {
  const root = project({
    "package.json": JSON.stringify({
      type: "module",
      packageManager: "pnpm@11.9.0",
      scripts: { test: "node --test" },
    }),
    "pnpm-lock.yaml": "",
    "src/a.js": 'export function pick(flag) {\n  if (flag) {\n    return "yes";\n  }\n  return "no";\n}\n',
    "test/a.test.js":
      'import assert from "node:assert/strict";\nimport { test } from "node:test";\n' +
      'import { pick } from "../src/a.js";\n\ntest("pick", () => {\n  assert.equal(pick(false), "no");\n});\n',
    // Left by the project's vitest days: claims everything is covered.
    "coverage/coverage-final.json": FULL_COVERAGE,
    "coverage/notes.txt": STALE_LOCATIONS["coverage/notes.txt"],
  });
  // This suite itself runs under `node --test`, and a child `node --test`
  // that inherits NODE_TEST_CONTEXT refuses to run ("called recursively").
  // Clear it for the spawn only; a real `kragg check` is never a test child.
  const testContext = process.env["NODE_TEST_CONTEXT"];
  delete process.env["NODE_TEST_CONTEXT"];
  let outcome: TestRunOutcome;
  try {
    outcome = await runTests({
      env: resolveProjectEnvironment(root),
      choice: "auto",
      coverageFailUnder: 1,
      maxViolations: 25,
      testPaths: ["test"],
      sourcePaths: ["src"],
    });
  } finally {
    if (testContext !== undefined) {
      process.env["NODE_TEST_CONTEXT"] = testContext;
    }
  }
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.message);
  assert.equal(outcome.runner, "node");
  assert.equal(outcome.passed, true);
  assert.ok(outcome.coverage?.ok, outcome.coverage?.ok ? "" : outcome.coverage?.message);
  // The evidence is the lcov node just wrote — with the `yes` branch uncovered
  // — not the istanbul file's 100%.
  assert.equal(outcome.coverage.evidence.format, "lcov");
  assert.ok(outcome.coverage.totals.pct < 100, `pct ${outcome.coverage.totals.pct}`);
  assert.ok(outcome.coverage.totals.pct > 0);
  const lcov = readFileSync(join(root, "coverage/lcov.info"), "utf8");
  assert.match(lcov, /SF:src\/a\.js/u);
  assert.equal(readFileSync(join(root, "coverage/coverage-final.json"), "utf8"), FULL_COVERAGE);
  assert.equal(readFileSync(join(root, "coverage/notes.txt"), "utf8"), STALE_LOCATIONS["coverage/notes.txt"]);
  assert.deepEqual(readdirSync(join(root, RUNS_DIR)), []);
});

test("concurrent invocations in one project each read only their own report", async () => {
  // An UNQUOTED heredoc, so `$out` expands: each report names the file it
  // was written to, and a run that read the other's would say so.
  const root = vitestProject(
    [
      'mkdir -p "$(dirname "$out")" "$cov"',
      'cat > "$out" <<KRAGG_EOF',
      '{"numTotalTests":1,"numPassedTests":0,"numFailedTests":1,"success":false,"testResults":[{"assertionResults":[{"ancestorTitles":[],"fullName":"marker","title":"marker","status":"failed","failureMessages":["written to $out"],"meta":{}}],"startTime":1,"endTime":2,"status":"failed","message":"","name":"/repo/test/a.test.ts"}]}',
      "KRAGG_EOF",
      `cat > "$cov/coverage-final.json" <<'KRAGG_EOF'\n${FULL_COVERAGE}\nKRAGG_EOF`,
      "exit 1",
    ].join("\n"),
  );
  const [first, second] = await Promise.all([run(root), run(root)]);
  assert.ok(first.ok && second.ok);
  const reportOf = (outcome: typeof first): string => {
    const flag = outcome.command.find((argument) => argument.startsWith("--outputFile="));
    assert.ok(flag !== undefined);
    return flag.slice("--outputFile=".length);
  };
  assert.notEqual(reportOf(first), reportOf(second));
  assert.match(first.violations[0]?.message ?? "", new RegExp(`written to ${reportOf(first)}$`, "u"));
  assert.match(second.violations[0]?.message ?? "", new RegExp(`written to ${reportOf(second)}$`, "u"));
  assertPreserved(root);
});

test("no private run directory means no run — never a fallback to the shared location", async () => {
  const root = vitestProject("touch ran.marker\nexit 0");
  // `.kragg/runs` is a FILE, so the directory cannot be created.
  writeFileSync(join(root, RUNS_DIR), "in the way");
  const outcome = await run(root);
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /could not create a private directory for this run's test artifacts/u);
  assert.equal(existsSync(join(root, "ran.marker")), false, "the runner must not have been spawned");
});

function exitCodeFor(gate: ReturnType<typeof fromReport>): number {
  return reportExitCode(
    buildReport({
      command: "check",
      mode: "full",
      targets: [],
      results: [gate],
      maxViolations: 10,
      startedAt: "now",
      gitSha: null,
    }),
  );
}
// ── The runner-independent half: stack frames and path shortening ──────────
//
// `stackLocation` decides where a failed test's violation POINTS. Getting it
// wrong is not cosmetic: the first frame of a vitest failure is usually inside
// the assertion library, and an agent sent to `node_modules/@vitest/expect`
// goes and edits the wrong codebase.

test("stackLocation prefers a frame in the test file over the first frame", () => {
  const stack = [
    "AssertionError: expected 1 to be 2",
    "    at Proxy.assert (/repo/node_modules/chai/chai.js:9192:11)",
    "    at Object.<anonymous> (/repo/test/math.test.ts:12:3)",
    "    at runNextTicks (node:internal/process/task_queues:60:5)",
  ].join("\n");
  assert.deepEqual(stackLocation(stack, "test/math.test.ts"), {
    file: "/repo/test/math.test.ts",
    line: 12,
    column: 3,
  });
});

test("stackLocation reads vitest's ❯ frames as well as node's `at` frames", () => {
  const stack = "  ❯ test/a.test.ts:3:9\n  ❯ test/b.test.ts:4:1";
  assert.deepEqual(stackLocation(stack, "test/b.test.ts"), {
    file: "test/b.test.ts",
    line: 4,
    column: 1,
  });
});

test("stackLocation falls back to the first frame outside node_modules", () => {
  // No preferred file — the `bun test` case, where the report names no file.
  const stack = [
    "    at expect (/repo/node_modules/bun-types/expect.js:10:2)",
    "    at /repo/src/math.ts:7:11",
  ].join("\n");
  assert.deepEqual(stackLocation(stack, undefined), {
    file: "/repo/src/math.ts",
    line: 7,
    column: 11,
  });
});

test("stackLocation returns undefined rather than a made-up position", () => {
  // Every frame is vendored, or there is no frame at all. A violation with an
  // invented `file:line` is worse than one with none.
  assert.equal(
    stackLocation("    at x (/repo/node_modules/vitest/dist/index.js:1:1)", undefined),
    undefined,
  );
  assert.equal(stackLocation("Error: boom", "test/a.test.ts"), undefined);
  assert.equal(stackLocation("", undefined), undefined);
});

test("stackLocation is not confused by a previous call's regex state", () => {
  // STACK_FRAME is a module-level /g regex, so a leaked `lastIndex` would make
  // the second read start halfway through the string and silently miss frames.
  const stack = "    at Object.<anonymous> (/repo/test/a.test.ts:5:7)";
  assert.deepEqual(stackLocation(stack, "test/a.test.ts"), stackLocation(stack, "test/a.test.ts"));
});

test("relativeToRoot shortens a path inside the root and leaves the rest alone", () => {
  // Absolute paths embed a home directory, so a report full of them cannot be
  // diffed between a laptop and CI.
  const root = join("/repo");
  assert.equal(reportRelativeToRoot(join(root, "test", "a.test.ts"), root), join("test", "a.test.ts"));
  assert.equal(reportRelativeToRoot("test/a.test.ts", root), "test/a.test.ts");
  // Outside the root: an absolute path reads better than a `../../..` chain.
  assert.equal(reportRelativeToRoot("/elsewhere/a.test.ts", root), "/elsewhere/a.test.ts");
  assert.equal(reportRelativeToRoot(root, root), root);
});

test("condense keeps the first non-blank line, trimmed and capped", () => {
  assert.equal(
    condense("\n\n  Expected 1 to be 2  \n    at fn (test/x.test.ts:3:9)"),
    "Expected 1 to be 2",
  );
  assert.equal(condense("x".repeat(200), 10), `${"x".repeat(9)}…`);
  assert.equal(condense("   \n  "), "");
});

// ── TOR-1372: the invocation is stated, and discovery is one answer ─────────
//
// Detection concludes WHICH RUNNER a project uses. It does not, and cannot,
// reconstruct the project's own command: a script of
// `node --import tsx --test "src/**/*.test.ts"` yields "node" and nothing
// else, and the argv kragg built from that carried neither the loader nor the
// file selection. The suite then discovered nothing and the gate reported a
// green "0 tests". These tests pin all three halves of the fix — an explicit
// argv, patterns in `test_paths`, and a zero-test run that is never a pass.

test("`test_command` carries the project's loader flags, and `--test` is not doubled", () => {
  const layout = artifacts("/repo", "coverage/coverage-final.json", RUN_DIR);
  const command = buildCommand(
    ["/usr/bin/node", "--import", "tsx", "--test"],
    "node",
    layout,
    false,
    ["src/**/*.test.ts"],
  );
  assert.deepEqual(command, [
    "/usr/bin/node",
    "--import",
    "tsx",
    "--test",
    "--test-reporter=tap",
    "--test-reporter-destination=stdout",
    "src/**/*.test.ts",
  ]);
  // The loader has to precede the modules it loads, and kragg's own reporter
  // flags have to survive: it parses their output.
  assert.ok(command.indexOf("--import") < command.indexOf("--test-reporter=tap"));
});

test("a repeated subcommand is dropped for vitest and bun, and everything else is kept", () => {
  const layout = artifacts("/repo", "coverage/coverage-final.json", RUN_DIR);
  const vitest = buildCommand(
    ["/repo/node_modules/.bin/vitest", "run", "--config", "vitest.ci.ts"],
    "vitest",
    layout,
    false,
    [],
  );
  assert.equal(vitest.filter((argument) => argument === "run").length, 1);
  assert.deepEqual(vitest.slice(0, 4), [
    "/repo/node_modules/.bin/vitest",
    "run",
    "--config",
    "vitest.ci.ts",
  ]);
  const bun = buildCommand(["bun", "test", "--preload", "./setup.ts"], "bun", layout, false, []);
  assert.deepEqual(bun, ["bun", "test", "--preload", "./setup.ts"]);
});

test("a colocated pattern reaches the runner verbatim; a directory still becomes a glob", () => {
  const layout = artifacts("/repo", "coverage/coverage-final.json", RUN_DIR);
  const command = buildCommand(["/usr/bin/node"], "node", layout, false, [
    "test",
    "src/**/*.test.ts",
  ]);
  assert.deepEqual(command.slice(-2), [
    "test/**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
    "src/**/*.test.ts",
  ]);
});

test("a test path containing spaces is one argv element, never quoted or split", () => {
  const layout = artifacts("/repo/my project", "coverage/coverage-final.json", RUN_DIR);
  const command = buildCommand(["/usr/bin/node"], "node", layout, false, ["my tests"]);
  assert.equal(command.at(-1), "my tests/**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}");
  assert.ok(!command.some((argument) => argument.includes('"') || argument.includes("\\ ")));
});

test("an unsupported runner skips with BOTH remedies, and never passes", async () => {
  const root = project({
    "package.json": JSON.stringify({
      packageManager: "pnpm@11.9.0",
      scripts: { test: "jest --ci" },
    }),
  });
  const outcome = await runTests({
    env: resolveProjectEnvironment(root),
    choice: "auto",
    coverageFailUnder: 80,
    maxViolations: 25,
    testPaths: ["test"],
    sourcePaths: ["src"],
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "not-configured");
  assert.match(outcome.message, /jest, which kragg does not drive yet/u);
  assert.match(outcome.message, /jest --ci/u, "the script itself must be quoted back");
  assert.match(outcome.message, /`test_runner`/u);
  assert.match(outcome.message, /`test_command`/u);
  const gate = fromReport(TEST_GATE, outcome);
  assert.equal(gate.skipped, true);
  assert.equal(gate.passed, false);
});

test('`test_runner: "off"` outranks `test_command`', async () => {
  const outcome = await runTests({
    env: resolveProjectEnvironment(project({ "package.json": "{}" })),
    choice: "off",
    coverageFailUnder: 80,
    maxViolations: 25,
    testPaths: ["test"],
    sourcePaths: ["src"],
    testCommand: ["node", "--test"],
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /switched off/u);
});

test("a detected runner reports the argv kragg built, next to the script it is not", async () => {
  const root = vitestProject(`${writeReport(GREEN)}\n${writeCoverage(FULL_COVERAGE)}\nexit 0`);
  const outcome = await run(root);
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.message);
  assert.equal(outcome.passed, true);
  assert.match(outcome.output, /^invocation: .*\/node_modules\/\.bin\/vitest run /mu);
  assert.match(outcome.output, /kragg BUILT this argv itself/u);
  assert.match(
    outcome.output,
    /inferred from package\.json#scripts\.test, which reads `vitest run`/u,
  );
  assert.match(outcome.output, /that script was NOT run and this argv is not equivalent to it/u);
  assert.match(outcome.output, /Set `test_command`/u);
});

test("`test_command` runs the stated argv, from the project's own node_modules/.bin", async () => {
  const root = vitestProject(
    [
      'printf "%s\\n" "$@" > argv.txt',
      writeReport(GREEN),
      writeCoverage(FULL_COVERAGE),
      "exit 0",
    ].join("\n"),
  );
  const outcome = await runTests({
    env: resolveProjectEnvironment(root),
    choice: "auto",
    coverageFailUnder: 80,
    maxViolations: 25,
    testPaths: ["test"],
    sourcePaths: ["src"],
    testCommand: ["vitest", "--config", "vitest.ci.ts"],
  });
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.message);
  assert.equal(outcome.passed, true);
  assert.equal(outcome.source, "test_command");
  assert.equal(outcome.command[0], join(root, "node_modules", ".bin", "vitest"));
  // The flags reached the process, in order, as separate argv elements.
  const argv = readFileSync(join(root, "argv.txt"), "utf8").trimEnd().split("\n");
  assert.deepEqual(argv.slice(0, 3), ["run", "--config", "vitest.ci.ts"]);
  assert.match(outcome.output, /from `test_command` in kragg\.json/u);
  assert.doesNotMatch(outcome.output, /kragg BUILT this argv/u);
});

test("`test_command` will not run a program from outside the project", async () => {
  const root = vitestProject(`${writeReport(GREEN)}\nexit 0`);
  const outcome = await runTests({
    env: resolveProjectEnvironment(root),
    choice: "auto",
    coverageFailUnder: 80,
    maxViolations: 25,
    testPaths: ["test"],
    sourcePaths: ["src"],
    testCommand: ["/usr/local/bin/vitest"],
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "missing-tool");
  assert.match(outcome.message, /must start with a tool NAME, not the path/u);
  assert.match(outcome.message, /never from PATH/u);
});

test("a `test_command` naming a tool the project does not have is an error, not a skip", async () => {
  const root = project({
    "package.json": JSON.stringify({ packageManager: "pnpm@11.9.0" }),
    "pnpm-lock.yaml": "",
  });
  const outcome = await runTests({
    env: resolveProjectEnvironment(root),
    choice: "node",
    coverageFailUnder: 80,
    maxViolations: 25,
    testPaths: ["test"],
    sourcePaths: ["src"],
    testCommand: ["tsx", "--test"],
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "missing-tool");
  assert.match(outcome.message, /pnpm add -D tsx/u);
});

test("a `test_command` kragg cannot map to a report format is refused", async () => {
  const root = project({ "package.json": "{}" });
  const outcome = await runTests({
    env: resolveProjectEnvironment(root),
    choice: "auto",
    coverageFailUnder: 80,
    maxViolations: 25,
    testPaths: ["test"],
    sourcePaths: ["src"],
    testCommand: ["tsx", "--test"],
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "missing-tool");
  assert.match(outcome.message, /cannot tell which runner's report format/u);
  assert.match(outcome.message, /Set `test_runner`/u);
});

test("a completed run that discovered NO TESTS is an error, never a green gate", async () => {
  const root = vitestProject(
    `${writeReport(vitestReport([]))}\n${writeCoverage(FULL_COVERAGE)}\nexit 0`,
  );
  const outcome = await run(root);
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.message);
  assert.equal(outcome.summary.total, 0);
  // The whole point: 0 failures out of 0 tests is arithmetic, not evidence.
  assert.equal(outcome.passed, false);
  assert.equal(outcome.error, true);
  assert.match(outcome.output, /discovered NO TESTS/u);
  assert.match(outcome.output, /`test_paths`/u);
  assert.match(outcome.output, /`test_command`/u);
  assert.match(outcome.output, /`test_runner`/u);
  assert.match(outcome.output, /"off"/u);

  const gate = fromReport(TEST_GATE, outcome);
  assert.equal(gate.passed, false);
  assert.equal(gate.error, true);
  assert.equal(exitCodeFor(gate), EXIT_ENVIRONMENT);
  // The explanation survives into the gate, which is where a reader sees it.
  assert.match(gate.output, /discovered NO TESTS/u);
});

test("the zero-test error describes what the runner was actually pointed at", async () => {
  const root = vitestProject(
    `${writeReport(vitestReport([]))}\n${writeCoverage(FULL_COVERAGE)}\nexit 0`,
  );
  const outcome = await run(root);
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.message);
  // vitest discovers its own files, so kragg must not claim it searched for it.
  assert.match(outcome.output, /searched: whatever vitest discovers from its own config/u);
});

test("colocated tests and paths with spaces run end to end, under `node --test`", async () => {
  const root = project(
    {
      "package.json": JSON.stringify({
        type: "module",
        packageManager: "pnpm@11.9.0",
        scripts: { test: "node --test" },
      }),
      "pnpm-lock.yaml": "",
      "src/a.js": "export const two = () => 2;\n",
      "src/a.test.js":
        'import assert from "node:assert/strict";\nimport { test } from "node:test";\n' +
        'import { two } from "./a.js";\n\ntest("colocated", () => {\n  assert.equal(two(), 2);\n});\n',
      "my tests/b.test.js":
        'import assert from "node:assert/strict";\nimport { test } from "node:test";\n\n' +
        'test("in a directory with a space", () => {\n  assert.ok(true);\n});\n',
    },
    "kragg test runner ",
  );
  assert.ok(root.includes(" "), "the project root itself must contain a space");
  // See the runner-switch test above: a child `node --test` refuses to start
  // while NODE_TEST_CONTEXT is inherited from this suite.
  const testContext = process.env["NODE_TEST_CONTEXT"];
  delete process.env["NODE_TEST_CONTEXT"];
  let outcome: TestRunOutcome;
  try {
    outcome = await runTests({
      env: resolveProjectEnvironment(root),
      choice: "node",
      coverageFailUnder: 0,
      maxViolations: 25,
      testPaths: ["src/**/*.test.js", "my tests"],
      sourcePaths: ["src"],
    });
  } finally {
    if (testContext !== undefined) {
      process.env["NODE_TEST_CONTEXT"] = testContext;
    }
  }
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.message);
  assert.equal(outcome.runner, "node");
  assert.equal(outcome.passed, true);
  // Both files ran: the colocated one the old directory-only rule missed, and
  // the one whose directory name has a space in it.
  assert.equal(outcome.summary.total, 2);
  assert.equal(outcome.summary.failed, 0);
  assert.ok(outcome.command.includes("src/**/*.test.js"));
  assert.ok(outcome.command.includes("my tests/**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"));
});
