/**
 * Tests for the istanbul coverage normalizer.
 *
 * The load-bearing claim is the LINE RULE: a line's count is the maximum over
 * the statements that START on it, and a line no statement starts on is not in
 * the model at all. Both halves are tested directly, because getting either
 * wrong produces `file:line` pointers that address the wrong line — the one
 * failure that makes a coverage gate worse than no gate.
 *
 * The fixtures are hand-written report literals rather than the output of a
 * real coverage run, deliberately: the gate must be testable without running
 * vitest, and a recorded artifact would pin these tests to one tool's version.
 * They are shaped exactly as `coverage-final.json` is, down to the string keys
 * that istanbul uses for its integer ids.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeIstanbul, readIstanbulReport } from "../src/coverage/istanbul.ts";
import {
  functionsNamed,
  uncoveredWithin,
  type FileCoverage,
} from "../src/coverage/model.ts";

const ROOT = "/repo";

/** Build one file entry from `[startLine, endLine, hits]` statement triples. */
function entry(
  statements: readonly (readonly [number, number, number])[],
  functions: readonly (readonly [string, number, number, number])[] = [],
): Record<string, unknown> {
  const statementMap: Record<string, unknown> = {};
  const s: Record<string, number> = {};
  statements.forEach(([start, end, hits], index) => {
    statementMap[String(index)] = {
      start: { line: start, column: 0 },
      end: { line: end, column: 10 },
    };
    s[String(index)] = hits;
  });
  const fnMap: Record<string, unknown> = {};
  const f: Record<string, number> = {};
  functions.forEach(([name, start, end, hits], index) => {
    fnMap[String(index)] = {
      name,
      decl: { start: { line: start, column: 0 }, end: { line: start, column: 5 } },
      loc: { start: { line: start, column: 0 }, end: { line: end, column: 1 } },
    };
    f[String(index)] = hits;
  });
  return { statementMap, s, fnMap, f };
}

function fileAt(report: unknown, path: string): FileCoverage {
  const normalized = normalizeIstanbul(report, ROOT);
  const found = normalized.files.get(path);
  assert.ok(found !== undefined, `no coverage for ${path}`);
  return found;
}

describe("normalizeIstanbul: the line rule", () => {
  it("reports only the start line of a multi-line statement", () => {
    // A call spanning lines 4-7 that never ran must point at line 4 alone;
    // lines 5-7 hold arguments and are not lines any coverage tool reports.
    const file = fileAt({ "/repo/src/a.ts": entry([[4, 7, 0]]) }, "src/a.ts");
    assert.deepEqual(file.uncoveredLines, [4]);
  });

  it("treats a line as covered when any statement starting there ran", () => {
    // `if (x) return;` — two statements, one line, one of them never taken.
    const file = fileAt(
      { "/repo/src/a.ts": entry([[3, 3, 5], [3, 3, 0], [4, 4, 0]]) },
      "src/a.ts",
    );
    assert.deepEqual(file.uncoveredLines, [4]);
  });

  it("keeps uncovered lines ascending regardless of statement order", () => {
    const file = fileAt(
      { "/repo/src/a.ts": entry([[9, 9, 0], [2, 2, 0], [5, 5, 1], [7, 7, 0]]) },
      "src/a.ts",
    );
    assert.deepEqual(file.uncoveredLines, [2, 7, 9]);
  });

  it("reports nothing for a fully covered file", () => {
    const file = fileAt({ "/repo/src/a.ts": entry([[1, 1, 3], [2, 2, 1]]) }, "src/a.ts");
    assert.deepEqual(file.uncoveredLines, []);
  });

  it("counts a statement with no recorded hit entry as never run", () => {
    const report = { "/repo/src/a.ts": { statementMap: { "0": { start: { line: 8 } } } } };
    assert.deepEqual(fileAt(report, "src/a.ts").uncoveredLines, [8]);
  });
});

describe("normalizeIstanbul: paths", () => {
  it("makes an absolute key under the root repo-relative", () => {
    const normalized = normalizeIstanbul({ "/repo/src/a.ts": entry([]) }, ROOT);
    assert.deepEqual([...normalized.files.keys()], ["src/a.ts"]);
  });

  it("accepts a key that is already relative", () => {
    const normalized = normalizeIstanbul({ "./src/a.ts": entry([]) }, ROOT);
    assert.deepEqual([...normalized.files.keys()], ["src/a.ts"]);
  });

  it("leaves a key outside the root alone rather than growing dot-dots", () => {
    const normalized = normalizeIstanbul({ "/elsewhere/a.ts": entry([]) }, ROOT);
    assert.deepEqual([...normalized.files.keys()], ["/elsewhere/a.ts"]);
  });

  it("prefers the entry's own path field over the key", () => {
    const normalized = normalizeIstanbul(
      { "whatever": { ...entry([[1, 1, 0]]), path: "/repo/src/a.ts" } },
      ROOT,
    );
    assert.deepEqual([...normalized.files.keys()], ["src/a.ts"]);
  });

  it("merges two keys that normalize to the same path", () => {
    const normalized = normalizeIstanbul(
      { "/repo/src/a.ts": entry([[1, 1, 0], [2, 2, 0]]), "src/a.ts": entry([[2, 2, 4]]) },
      ROOT,
    );
    assert.equal(normalized.files.size, 1);
    const file = normalized.files.get("src/a.ts");
    assert.ok(file !== undefined);
    assert.deepEqual(file.uncoveredLines, [1]);
  });
});

describe("normalizeIstanbul: functions", () => {
  it("records the body span and hit count", () => {
    const file = fileAt(
      { "/repo/src/a.ts": entry([[4, 4, 0]], [["send", 3, 6, 0], ["retry", 8, 9, 2]]) },
      "src/a.ts",
    );
    assert.deepEqual(functionsNamed(file, "send"), [
      { name: "send", startLine: 3, endLine: 6, hits: 0 },
    ]);
    assert.equal(functionsNamed(file, "retry")[0]?.hits, 2);
    assert.deepEqual(functionsNamed(file, "missing"), []);
  });

  it("returns every function sharing a name, so the caller can see ambiguity", () => {
    const file = fileAt(
      { "/repo/src/a.ts": entry([], [["close", 3, 5, 1], ["close", 20, 22, 0]]) },
      "src/a.ts",
    );
    assert.equal(functionsNamed(file, "close").length, 2);
  });

  it("falls back to decl when a producer omits loc", () => {
    const report = {
      "/repo/src/a.ts": {
        fnMap: { "0": { name: "run", decl: { start: { line: 7 }, end: { line: 7 } } } },
        f: { "0": 1 },
      },
    };
    assert.deepEqual(fileAt(report, "src/a.ts").functions, [
      { name: "run", startLine: 7, endLine: 7, hits: 1 },
    ]);
  });

  it("names an entry that carries no name", () => {
    const report = {
      "/repo/src/a.ts": { fnMap: { "4": { loc: { start: { line: 2 }, end: { line: 3 } } } } },
    };
    assert.equal(fileAt(report, "src/a.ts").functions[0]?.name, "(anonymous_4)");
  });

  it("drops a function whose location cannot be read", () => {
    const report = { "/repo/src/a.ts": { fnMap: { "0": { name: "run" } }, f: { "0": 0 } } };
    assert.deepEqual(fileAt(report, "src/a.ts").functions, []);
  });
});

describe("uncoveredWithin", () => {
  const file = fileAt(
    { "/repo/src/a.ts": entry([[2, 2, 0], [5, 5, 0], [6, 6, 0], [11, 11, 0]]) },
    "src/a.ts",
  );

  it("keeps the lines inside an inclusive span", () => {
    assert.deepEqual(uncoveredWithin(file, 5, 6), [5, 6]);
    assert.deepEqual(uncoveredWithin(file, 2, 2), [2]);
  });

  it("excludes lines outside the span", () => {
    assert.deepEqual(uncoveredWithin(file, 7, 10), []);
  });
});

describe("normalizeIstanbul: malformed input", () => {
  it("yields nothing for a report that is not an object", () => {
    for (const value of [null, undefined, 7, "x", [1, 2]]) {
      assert.equal(normalizeIstanbul(value, ROOT).files.size, 0);
    }
  });

  it("skips entries that are not objects", () => {
    assert.equal(normalizeIstanbul({ "/repo/src/a.ts": 3 }, ROOT).files.size, 0);
  });

  it("tolerates a file entry with no maps at all", () => {
    const file = fileAt({ "/repo/src/a.ts": {} }, "src/a.ts");
    assert.deepEqual(file.uncoveredLines, []);
    assert.deepEqual(file.functions, []);
  });

  it("ignores a statement whose line is missing or not a positive integer", () => {
    const report = {
      "/repo/src/a.ts": {
        statementMap: {
          "0": { start: { line: 0 } },
          "1": { start: { line: -3 } },
          "2": { start: { line: 1.5 } },
          "3": { start: {} },
          "4": {},
          "5": { start: { line: 6 } },
        },
        s: { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
      },
    };
    assert.deepEqual(fileAt(report, "src/a.ts").uncoveredLines, [6]);
  });
});

describe("readIstanbulReport", () => {
  it("returns null for a file that is not there", () => {
    assert.equal(readIstanbulReport("/repo/definitely/not/here.json"), null);
  });
});
