/**
 * Tests for the type-check adapter.
 *
 * The multi-line fixtures below are RECORDED, not invented: they are the exact
 * bytes `pnpm run typecheck` (i.e. `tsc --noEmit -p tsconfig.json`, TypeScript
 * 6.0.3) printed for a scratch file written to provoke a
 * `DiagnosticMessageChain`, indentation included —
 *
 *     src/…/x.ts(3,14): error TS2322: Type 'B' is not assignable to type 'A'.
 *       The types of 'a.b.c' are incompatible between these types.
 *         Type 'string' is not assignable to type 'number'.
 *
 * — which is what `flattenDiagnosticMessageText` produces: two spaces of
 * indent per nesting level. That run also confirmed `tsc --noEmit` exits 2
 * (`ExitStatus.DiagnosticsPresent_OutputsGenerated`) for ordinary type errors,
 * which is why 2 is NOT in `INVALID_PROJECT_STATUSES`. Treating it as a
 * crash-code the way ruff treats exit 2 would turn every type error into
 * "your compiler is broken".
 *
 * The cases are weighted toward the failures that would silently pass: a
 * tsconfig that matches no files (TS18003 — zero type errors over zero
 * source), a compiler that dies producing no diagnostics, and the collapse of
 * a chained message into ONE violation rather than one per line.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  CONFIG_ERROR_CODES,
  orderByPaths,
  parseTscOutput,
  runTypeCheck,
} from "../src/adapters/tsc.ts";
import type { Violation } from "../src/engine/models.ts";
import { resolveProjectEnvironment } from "../src/environment/project.ts";

const ROOT = "/repo";
const temporaryRoots: string[] = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(files: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-tsc-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@11.0.0" }));
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

/** A stand-in `tsc`: fixed stdout, fixed exit status. */
function fakeTsc(root: string, stdout: string, status: number): void {
  const dir = join(root, "node_modules", ".bin");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "tsc");
  writeFileSync(path, `#!/bin/sh\ncat <<'KRAGG_EOF'\n${stdout}\nKRAGG_EOF\nexit ${status}\n`);
  chmodSync(path, 0o755);
}

/** Verbatim `tsc --pretty false` output, indentation preserved. */
const CHAINED = [
  "src/a.ts(3,14): error TS2322: Type 'B' is not assignable to type 'A'.",
  "  The types of 'a.b.c' are incompatible between these types.",
  "    Type 'string' is not assignable to type 'number'.",
  "src/a.ts(4,14): error TS2322: Type 'number' is not assignable to type 'string'.",
  "src/b.ts(6,3): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
].join("\n");

describe("parseTscOutput", () => {
  it("returns nothing for a clean run", () => {
    assert.deepEqual(parseTscOutput("", ROOT), []);
    assert.deepEqual(parseTscOutput("\n\n", ROOT), []);
  });

  it("collapses a chained message into ONE violation", () => {
    // The bug this exists to prevent: three lines of one error reported as
    // three findings, or — as `parse_mypy_output` does — the explanation
    // silently dropped because the continuations match no pattern.
    const violations = parseTscOutput(CHAINED, ROOT);
    assert.equal(violations.length, 3);
    assert.deepEqual(violations[0], {
      message:
        "Type 'B' is not assignable to type 'A'. " +
        "The types of 'a.b.c' are incompatible between these types. " +
        "Type 'string' is not assignable to type 'number'.",
      file: "src/a.ts",
      line: 3,
      column: 14,
      code: "TS2322",
    });
  });

  it("reads position and code off every diagnostic", () => {
    const violations = parseTscOutput(CHAINED, ROOT);
    assert.equal(violations[1]?.code, "TS2322");
    assert.equal(violations[2]?.file, "src/b.ts");
    assert.equal(violations[2]?.line, 6);
    assert.equal(violations[2]?.column, 3);
    assert.equal(violations[2]?.code, "TS2345");
  });

  it("reads a file-less config diagnostic", () => {
    // `formatDiagnostic` emits the file prefix only `if (diagnostic.file)`.
    const violations = parseTscOutput("error TS5058: The specified path does not exist: 'nope.json'.", ROOT);
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.file, undefined);
    assert.equal(violations[0]?.code, "TS5058");
  });

  it("handles a Windows drive letter without mistaking it for a position", () => {
    const violations = parseTscOutput(
      "C:\\repo\\src\\a.ts(9,2): error TS2304: Cannot find name 'foo'.",
      ROOT,
    );
    assert.equal(violations[0]?.line, 9);
    assert.equal(violations[0]?.column, 2);
    assert.equal(violations[0]?.code, "TS2304");
  });

  it("keeps warnings and suggestions, which are still diagnostics", () => {
    const violations = parseTscOutput(
      [
        "src/a.ts(1,1): warning TS6133: 'x' is declared but its value is never read.",
        "src/a.ts(2,1): suggestion TS80001: File is a CommonJS module.",
      ].join("\n"),
      ROOT,
    );
    assert.equal(violations.length, 2);
  });

  it("does not swallow an indented summary table as a continuation", () => {
    // `--pretty false` suppresses the summary (`createReportErrorSummary`
    // returns undefined), but the blank-line reset means the parser stays
    // correct if it ever appears anyway.
    const violations = parseTscOutput(
      [
        "src/a.ts(3,14): error TS2322: Bad.",
        "",
        "Found 1 error in 1 file.",
        "",
        "Errors  Files",
        "     1  src/a.ts:3",
      ].join("\n"),
      ROOT,
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.message, "Bad.");
  });

  it("ignores noise and never throws", () => {
    for (const noise of [
      "some random line",
      "src/a.ts: not a diagnostic",
      "src/a.ts(x,y): error TS1: nope",
      "  orphan continuation with no diagnostic above it",
      "error TS: missing code",
    ]) {
      assert.deepEqual(parseTscOutput(noise, ROOT), [], noise);
    }
  });

  it("survives CRLF output", () => {
    const violations = parseTscOutput(CHAINED.split("\n").join("\r\n"), ROOT);
    assert.equal(violations.length, 3);
    assert.equal(violations[0]?.file, "src/a.ts");
  });

  it("makes an absolute diagnostic path repo-relative", () => {
    const violations = parseTscOutput(`${ROOT}/src/a.ts(1,1): error TS2304: Cannot find name 'x'.`, ROOT);
    assert.equal(violations[0]?.file, "src/a.ts");
  });
});

describe("orderByPaths", () => {
  const violations: readonly Violation[] = [
    { message: "a1", file: "src/a.ts", line: 1, code: "TS1" },
    { message: "a2", file: "src/a.ts", line: 9, code: "TS1" },
    { message: "b", file: "src/b.ts", line: 2, code: "TS2" },
    { message: "global", code: "TS2318" },
  ];

  it("drops nothing: the selected set comes first, the rest follows", () => {
    // The bug this replaces: a filter that kept only `src/b.ts` and so hid
    // the errors an edit to `b.ts` caused in `a.ts`.
    const ordered = orderByPaths(violations, ROOT, ["src/b.ts"]);
    assert.equal(ordered.length, violations.length);
    assert.deepEqual(
      ordered.map((item) => item.message),
      ["global", "b", "a1", "a2"],
    );
  });

  it("an error in b.ts survives a run scoped to src/a.ts", () => {
    const only = [{ message: "b", file: "src/b.ts", line: 2, code: "TS2" }];
    assert.deepEqual(orderByPaths(only, ROOT, ["src/a.ts"]), only);
  });

  it("puts a file-less diagnostic first, ahead of the selected set", () => {
    // A fact about the whole project, not about a file: it is what explains
    // the errors under it, and a per-gate cap must never push it out of view.
    const ordered = orderByPaths(violations, ROOT, ["src/a.ts"]);
    assert.deepEqual(
      ordered.map((item) => item.message),
      ["global", "a1", "a2", "b"],
    );
  });

  it("keeps the compiler's order within each group", () => {
    const ordered = orderByPaths(violations, ROOT, ["src/nothing.ts"]);
    assert.deepEqual(
      ordered.map((item) => item.message),
      ["global", "a1", "a2", "b"],
    );
  });

  it("matches absolute and ./-prefixed spellings of the same path", () => {
    for (const spelling of [`${ROOT}/src/b.ts`, "./src/b.ts", "src/b.ts"]) {
      const ordered = orderByPaths(violations, ROOT, [spelling]);
      assert.equal(ordered[1]?.file, "src/b.ts", spelling);
    }
  });

  it("returns the list as it came when there are no paths", () => {
    assert.equal(orderByPaths(violations, ROOT, []), violations);
  });
});

describe("runTypeCheck", () => {
  it("errors when there is no tsconfig, before spawning anything", async () => {
    const root = project();
    const outcome = await runTypeCheck({ env: resolveProjectEnvironment(root) });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.match(outcome.message, /no tsconfig\.json found/);
      assert.equal(outcome.command, undefined);
    }
  });

  it("errors with the install command when tsc is not in the project", async () => {
    const root = project({ "tsconfig.json": "{}" });
    const outcome = await runTypeCheck({ env: resolveProjectEnvironment(root) });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.match(outcome.message, /tsc is not installed in this project/);
      assert.match(outcome.message, /pnpm add -D typescript/);
      // The invariant the whole environment module exists for.
      assert.match(outcome.message, /will not fall back to a global/);
    }
  });

  it("passes a clean run", async () => {
    const root = project({ "tsconfig.json": "{}" });
    fakeTsc(root, "", 0);
    const outcome = await runTypeCheck({ env: resolveProjectEnvironment(root) });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.deepEqual(outcome.violations, []);
      assert.deepEqual(outcome.command.slice(1), [
        "--noEmit",
        "--pretty",
        "false",
        "--project",
        "tsconfig.json",
      ]);
    }
  });

  it("reports type errors as violations, not as an environment error", async () => {
    // Exit 2 here is DiagnosticsPresent_OutputsGenerated, NOT a fatal status.
    const root = project({ "tsconfig.json": "{}" });
    fakeTsc(root, CHAINED, 2);
    const outcome = await runTypeCheck({ env: resolveProjectEnvironment(root) });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.violations.length, 3);
    }
  });

  it("errors on a config-level diagnostic even though tsc reports zero type errors", async () => {
    // TS18003: the include globs matched nothing. Zero violations and a
    // non-zero exit — a gate counting only violations would call this clean
    // while nothing was ever checked.
    const root = project({ "tsconfig.json": "{}" });
    fakeTsc(
      root,
      "error TS18003: No inputs were found in config file 'tsconfig.json'. " +
        "Specified 'include' paths were '[\"nope/**\"]' and 'exclude' paths were '[]'.",
      1,
    );
    const outcome = await runTypeCheck({ env: resolveProjectEnvironment(root) });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.match(outcome.message, /TS18003/);
      assert.match(outcome.message, /did not run/);
    }
  });

  it("errors on an invalid-project exit status", async () => {
    const root = project({ "tsconfig.json": "{}" });
    fakeTsc(root, "", 3);
    const outcome = await runTypeCheck({ env: resolveProjectEnvironment(root) });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.match(outcome.message, /invalid project/);
    }
  });

  it("errors when tsc dies producing no diagnostics", async () => {
    const root = project({ "tsconfig.json": "{}" });
    fakeTsc(root, "FATAL ERROR: JavaScript heap out of memory", 134);
    const outcome = await runTypeCheck({ env: resolveProjectEnvironment(root) });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.match(outcome.message, /no parseable diagnostics/);
      assert.match(outcome.message, /heap out of memory/);
    }
  });

  it("checks the whole program and reports every diagnostic, selected files first", async () => {
    // The invocation must stay project-wide: `tsc <file>` ignores tsconfig
    // entirely, so narrowing it would check the project under default rules.
    // And the REPORT must stay whole too — see the next test.
    const root = project({ "tsconfig.json": "{}" });
    fakeTsc(root, CHAINED, 2);
    const outcome = await runTypeCheck({
      env: resolveProjectEnvironment(root),
      paths: ["src/b.ts"],
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.deepEqual(outcome.command.slice(1), [
        "--noEmit",
        "--pretty",
        "false",
        "--project",
        "tsconfig.json",
      ]);
      assert.deepEqual(
        outcome.violations.map((item) => `${item.file}:${item.line}`),
        ["src/b.ts:6", "src/a.ts:3", "src/a.ts:4"],
      );
    }
  });

  it("keeps the error in an UNCHANGED caller when the run is scoped to src/a.ts", async () => {
    // The incremental-mode bug: `f(x: string)` changed in a.ts, the caller
    // in b.ts no longer type-checks, and b.ts is not in the changed set. The
    // old filter dropped it and the gate reported [PASS] tsc for the edit,
    // while `tsc -p tsconfig.json` was failing.
    const root = project({ "tsconfig.json": "{}" });
    fakeTsc(
      root,
      "src/b.ts(4,28): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.",
      2,
    );
    const outcome = await runTypeCheck({
      env: resolveProjectEnvironment(root),
      paths: ["src/a.ts"],
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.violations.length, 1);
      assert.equal(outcome.violations[0]?.file, "src/b.ts");
      assert.equal(outcome.violations[0]?.line, 4);
      assert.equal(outcome.violations[0]?.column, 28);
      assert.equal(outcome.violations[0]?.code, "TS2345");
    }
  });

  it("keeps every diagnostic when the selected file is not TypeScript at all", async () => {
    // `--file README.md`: nothing matches the selection, and the whole-project
    // verdict must survive that rather than collapsing to an empty list.
    const root = project({ "tsconfig.json": "{}" });
    fakeTsc(root, CHAINED, 2);
    const outcome = await runTypeCheck({
      env: resolveProjectEnvironment(root),
      paths: ["README.md"],
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.violations.length, 3);
    }
  });

  it("honours an explicit project file", async () => {
    const root = project({ "tsconfig.build.json": "{}" });
    fakeTsc(root, "", 0);
    const outcome = await runTypeCheck({
      env: resolveProjectEnvironment(root),
      project: "tsconfig.build.json",
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.command.at(-1), "tsconfig.build.json");
    }
  });
});

describe("CONFIG_ERROR_CODES", () => {
  it("covers the quiet ones that would otherwise pass as clean", () => {
    for (const code of ["TS18002", "TS18003", "TS5058", "TS5083"]) {
      assert.equal(CONFIG_ERROR_CODES.has(code), true, code);
    }
  });

  it("excludes ordinary type errors", () => {
    for (const code of ["TS2322", "TS2345", "TS6133"]) {
      assert.equal(CONFIG_ERROR_CODES.has(code), false, code);
    }
  });
});
