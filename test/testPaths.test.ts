/**
 * `test_paths` is one answer, and this is where that is pinned.
 *
 * The setting feeds three consumers — the runner's file selection, the walk
 * the test-depth gates parse, and the "is this file a test" question
 * `critical-tests` asks — and a project's suite is whatever all three agree
 * on. Before TOR-1372 they could not agree, because only the first of them
 * could express a colocated suite at all.
 *
 * The dialect tests are deliberately literal about `**`. `util/globs.ts` is
 * fnmatch (`*` spans `/`, no `**`) and these patterns are ALSO handed to
 * `node --test`, which is not fnmatch. Using the wrong one would match files
 * the runner never ran, so every rule below is asserted rather than assumed.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import ts from "typescript";

import { checkTestQuality } from "../src/gates/testQuality.ts";
import { parsedTestSources } from "../src/gates/testDepth/testFiles.ts";
import {
  isTestPath,
  isTestPattern,
  matchesTestPattern,
  TEST_FILE_GLOB,
  testRunnerPatterns,
  testScanDirectories,
} from "../src/util/testPaths.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-testpaths-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
  }
  return root;
}

describe("the pattern dialect", () => {
  it("lets `**` stand for zero or more whole segments", () => {
    // The colocated case: without the zero-segment rule, `src/a.test.ts` is
    // invisible and the suite silently shrinks to whatever lives deeper.
    assert.equal(matchesTestPattern("src/a.test.ts", "src/**/*.test.ts"), true);
    assert.equal(matchesTestPattern("src/deep/a.test.ts", "src/**/*.test.ts"), true);
    assert.equal(matchesTestPattern("src/a/b/c.test.ts", "src/**/*.test.ts"), true);
    assert.equal(matchesTestPattern("lib/a.test.ts", "src/**/*.test.ts"), false);
    assert.equal(matchesTestPattern("src/a.ts", "src/**/*.test.ts"), false);
    assert.equal(matchesTestPattern("a.test.ts", "**/*.test.ts"), true);
    assert.equal(matchesTestPattern("x/y/a.test.ts", "**/*.test.ts"), true);
  });

  it("keeps `*` and `?` inside one segment", () => {
    // This is the difference from `util/globs.ts`, where `*` spans `/`.
    assert.equal(matchesTestPattern("src/a.test.ts", "src/*.test.ts"), true);
    assert.equal(matchesTestPattern("src/deep/a.test.ts", "src/*.test.ts"), false);
    assert.equal(matchesTestPattern("test/a.ts", "test/?.ts"), true);
    assert.equal(matchesTestPattern("test/ab.ts", "test/?.ts"), false);
  });

  it("alternates with `{a,b}` and classes with `[...]`", () => {
    assert.equal(matchesTestPattern("src/a.spec.ts", "src/**/*.{test,spec}.ts"), true);
    assert.equal(matchesTestPattern("src/a.test.ts", "src/**/*.{test,spec}.ts"), true);
    assert.equal(matchesTestPattern("src/a.snap.ts", "src/**/*.{test,spec}.ts"), false);
    assert.equal(matchesTestPattern("test/a1.test.ts", "test/a[0-9].test.ts"), true);
    assert.equal(matchesTestPattern("test/ax.test.ts", "test/a[0-9].test.ts"), false);
    assert.equal(matchesTestPattern("test/ax.test.ts", "test/a[!0-9].test.ts"), true);
  });

  it("treats a dot as a literal and never as `any character`", () => {
    // A regex translation that forgot to escape `.` would match `axtest.ts`,
    // which is a source file, and quietly pull it into the test corpus.
    assert.equal(matchesTestPattern("srcXa.test.ts", "src/*.test.ts"), false);
    assert.equal(matchesTestPattern("test/axtestxts", "test/*.test.ts"), false);
  });

  it("reads an unterminated `{` or `[` as an ordinary character", () => {
    assert.equal(matchesTestPattern("test/a{b.ts", "test/a{b.ts"), true);
    assert.equal(matchesTestPattern("test/a[b.ts", "test/a[b.ts"), true);
  });

  it("recognises a pattern by its metacharacters, and nothing else", () => {
    assert.equal(isTestPattern("test"), false);
    assert.equal(isTestPattern("packages/api/test"), false);
    assert.equal(isTestPattern("my tests"), false);
    assert.equal(isTestPattern("src/**/*.test.ts"), true);
    assert.equal(isTestPattern("test/a?.ts"), true);
    assert.equal(isTestPattern("test/a[0].ts"), true);
    assert.equal(isTestPattern("test/{a,b}.ts"), true);
  });
});

describe("what each consumer is given", () => {
  it("expands a directory into the runner's glob and passes a pattern through", () => {
    assert.deepEqual(testRunnerPatterns(["test", "tests/", "src/**/*.test.ts"]), [
      `test/${TEST_FILE_GLOB}`,
      `tests/${TEST_FILE_GLOB}`,
      "src/**/*.test.ts",
    ]);
    // A bare directory must never reach `node --test`: it is read as a module
    // specifier and dies before running anything.
    assert.ok(!testRunnerPatterns(["test"]).includes("test"));
  });

  it("keeps a space in a path, because argv elements are never quoted", () => {
    assert.deepEqual(testRunnerPatterns(["my tests"]), [`my tests/${TEST_FILE_GLOB}`]);
    assert.deepEqual(testScanDirectories(["my tests"]), ["my tests"]);
    assert.equal(isTestPath("my tests/a.test.ts", ["my tests"]), true);
  });

  it("walks the literal prefix of a pattern, deduplicated", () => {
    assert.deepEqual(testScanDirectories(["test", "tests"]), ["test", "tests"]);
    // Two patterns rooted at the same place are one walk, not two.
    assert.deepEqual(
      testScanDirectories(["src/**/*.test.ts", "src/**/*.spec.ts", "test/"]),
      ["src", "test"],
    );
    assert.deepEqual(testScanDirectories(["**/*.test.ts"]), ["."]);
    assert.deepEqual(testScanDirectories(["packages/*/test"]), ["packages"]);
  });

  it("answers `is this a test file` by segment for a directory, by pattern otherwise", () => {
    assert.equal(isTestPath("test/a.ts", ["test"]), true);
    assert.equal(isTestPath("test/deep/a.ts", ["test"]), true);
    // Segment-aware: `test` is not a prefix of `testing`.
    assert.equal(isTestPath("testing/a.ts", ["test"]), false);
    assert.equal(isTestPath("./test/a.ts", ["test/"]), true);
    assert.equal(isTestPath("src/a.test.ts", ["src/**/*.test.ts"]), true);
    // THE FAIL-OPEN GUARD: the pattern's directory is walked, but a source
    // file under it is NOT part of the suite.
    assert.equal(isTestPath("src/a.ts", ["src/**/*.test.ts"]), false);
    assert.equal(isTestPath("anything.ts", ["."]), true);
  });
});

describe("the corpus the test-depth gates read", () => {
  const COLOCATED = {
    "src/client.ts": "export function send(): number {\n  return 1;\n}\n",
    "src/client.test.ts":
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\n' +
      'import { send } from "./client.ts";\n\ntest("send", () => {\n' +
      "  assert.equal(send(), 1);\n});\n",
  };

  it("finds a colocated suite a directory-only reading missed", () => {
    const root = project(COLOCATED);
    const sources = parsedTestSources(root, ["src/**/*.test.ts"], ts);
    assert.deepEqual(sources.map((source) => source.relative), ["src/client.test.ts"]);
    // The source beside it is walked and then rejected: including it would
    // make `test-quality`'s "is this critical function mentioned in a test"
    // check true for every function in the codebase.
    assert.ok(!sources.some((source) => source.relative === "src/client.ts"));
  });

  it("still takes everything under a directory entry, helpers included", () => {
    const root = project({
      "test/a.test.ts": 'import { test } from "node:test";\n',
      "test/helpers.ts": "export const fixture = 1;\n",
    });
    assert.deepEqual(
      parsedTestSources(root, ["test"], ts).map((source) => source.relative).sort(),
      ["test/a.test.ts", "test/helpers.ts"],
    );
  });

  it("lets test-quality run on a colocated project instead of skipping", () => {
    const root = project(COLOCATED);
    const outcome = checkTestQuality({
      root,
      testPaths: ["src/**/*.test.ts"],
      sourcePaths: ["src"],
      api: ts,
    });
    // Before the fix this walked a directory named `src/**/*.test.ts`, found
    // nothing, and skipped with "no test files found" on a project whose
    // suite the runner was executing.
    assert.ok(outcome.ok);
    assert.equal(outcome.skipped, false);
  });
});
