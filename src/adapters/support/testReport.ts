/**
 * The runner-independent half of test reporting: counts, and turning a failed
 * test into a `file:line` pointer.
 *
 * Every supported runner (vitest, `node --test`, `bun test`) reports the same
 * facts in a different format, so the parsers in `vitestReport.ts` and its
 * siblings all normalize to `TestSummary` + `Violation[]` defined here. That
 * keeps `adapters/testRunner.ts` free of per-runner shapes and keeps the
 * OUTPUT identical whichever runner a project uses — a gate whose report
 * changes format when someone swaps test runners is a gate nobody can build a
 * tool on top of.
 *
 * OUTPUT PHILOSOPHY, inherited from `parse_pytest_output` in the Python
 * sibling: a failing suite must produce POINTERS, not a transcript. Python
 * emits pytest's one-line `FAILED tests/x.py::test_y` short-summary entries
 * plus a `re-run alone:` hint, and deliberately not the tracebacks. The reader
 * is usually an agent with a finite context window; a thousand lines of diff
 * output crowds out the thing it needs to act on. So: one violation per failed
 * test, first line of the assertion message only, a `file:line:column` taken
 * from the stack, and the exact command to re-run that ONE test.
 */

import { relative, resolve } from "node:path";

import type { Violation } from "../../engine/models.ts";

/** Counts for one test run, normalized across runners. */
export interface TestSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  /** Skipped plus pending. Runners disagree on the boundary; we do not split. */
  readonly skipped: number;
  readonly todo: number;
  /** Test FILES that contained at least one failure. */
  readonly failedFiles: number;
}

/** Normalized parse of one runner's machine-readable output. */
export interface TestReport {
  readonly summary: TestSummary;
  readonly violations: readonly Violation[];
  /**
   * True when the runner's own verdict was "passed". Kept separate from
   * `summary.failed === 0` because a runner can fail a run with zero failed
   * tests — no test files matched, or a suite threw during collection — and
   * that must not read as a clean pass.
   */
  readonly success: boolean;
}

/** A summary with every count at zero, for reports we could not parse. */
export const EMPTY_SUMMARY: TestSummary = {
  total: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  todo: 0,
  failedFiles: 0,
};

/** One line, trimmed, capped — the readable head of an assertion message. */
export function condense(message: string, maxLength = 160): string {
  const firstLine = message.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
  return firstLine.length > maxLength ? `${firstLine.slice(0, maxLength - 1)}…` : firstLine;
}

/** A source position recovered from a stack trace. */
export interface StackLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/**
 * `path:line:column` inside a stack frame.
 *
 * Matches both frame spellings Node produces — `at fn (/abs/x.test.ts:3:9)`
 * and vitest's `❯ test/x.test.ts:3:9` — by looking for the position triple
 * rather than for the frame syntax around it. The path may not contain `:`,
 * which would otherwise swallow the line number; a Windows drive letter is
 * allowed back in explicitly by the optional prefix.
 */
const STACK_FRAME =
  /(?:^|[\s(])((?:[A-Za-z]:)?[^\s():]+\.(?:[cm]?[jt]sx?|vue|svelte)):(\d+):(\d+)/gu;

/**
 * Best `file:line:column` for a failure.
 *
 * Prefers a frame in `preferFile` — the test file itself — over the first
 * frame in the trace, because the first frame is very often inside the
 * assertion library or the runner, and pointing an agent at
 * `node_modules/@vitest/expect/dist/index.js` sends it to fix the wrong
 * codebase. Frames under `node_modules` are never returned as the fallback for
 * the same reason.
 */
export function stackLocation(
  stack: string,
  preferFile: string | undefined,
): StackLocation | undefined {
  let fallback: StackLocation | undefined;
  STACK_FRAME.lastIndex = 0;
  for (const match of stack.matchAll(STACK_FRAME)) {
    // Every capture group in `STACK_FRAME` is mandatory, so a match always
    // carries all three; the defaults only satisfy `noUncheckedIndexedAccess`.
    const [, file = "", line = "0", column = "0"] = match;
    const found: StackLocation = {
      file,
      line: Number.parseInt(line, 10),
      column: Number.parseInt(column, 10),
    };
    if (preferFile !== undefined && sameFile(file, preferFile)) {
      return found;
    }
    if (fallback === undefined && !file.includes("node_modules")) {
      fallback = found;
    }
  }
  return fallback;
}

/** Path equality that tolerates absolute-vs-relative spellings of one file. */
function sameFile(left: string, right: string): boolean {
  return left === right || left.endsWith(right) || right.endsWith(left);
}

/**
 * Project-relative path, for output that stays short and stable.
 *
 * Absolute paths embed the developer's home directory: they differ between
 * every machine and CI, so a report containing them cannot be diffed across
 * runs. A path outside the root is left ABSOLUTE rather than rendered as a
 * `../../..` chain, which is longer and harder to read than the original.
 */
export function relativeToRoot(path: string, root: string): string {
  const rel = relative(root, resolve(root, path));
  return rel === "" || rel.startsWith("..") ? path : rel;
}
