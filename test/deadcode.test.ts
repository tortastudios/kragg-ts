/**
 * Tests for the knip adapter.
 *
 * Every fixture below is a hand-built document in the shape knip's own source
 * and CLI tests show it emitting (knip 6.32.0 and 5.88.1 — see
 * `src/adapters/support/knipReport.ts` for provenance). Nothing here executes
 * knip: kragg installs nothing, and a parser test that needs the tool present
 * is a parser test that does not run in CI.
 *
 * The cases that matter most are the ones where the tool did NOT behave: a
 * truncated report, an empty stream, a crash. Those must never produce "no
 * findings", because a clean-looking gate built from a failed read is the one
 * outcome this codebase treats as worse than no tool at all.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { runDeadCode } from "../src/adapters/deadcode.ts";
import { parseKnipJson } from "../src/adapters/support/knipReport.ts";
import { resolveProjectEnvironment } from "../src/environment/project.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A throwaway project directory with the given package.json contents. */
function project(manifest: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-deadcode-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest), "utf8");
  return root;
}

/** knip 6: one unused file, one unused export, one unlisted dependency. */
const KNIP_V6 = JSON.stringify({
  issues: [
    {
      file: "src/orphan.ts",
      binaries: [],
      dependencies: [],
      devDependencies: [],
      duplicates: [],
      enumMembers: [],
      exports: [],
      files: [{ name: "src/orphan.ts" }],
      types: [],
      unlisted: [],
      unresolved: [],
    },
    {
      file: "src/api.ts",
      exports: [{ name: "unusedHelper", line: 42, col: 14, pos: 900 }],
      unlisted: [{ name: "lodash", line: 3, col: 20, pos: 60 }],
    },
    {
      file: "package.json",
      dependencies: [{ name: "left-pad", line: 8, col: 6, pos: 131 }],
      binaries: [{ name: "start-server" }],
    },
  ],
});

test("parses a knip 6 report into per-category violations", () => {
  const report = parseKnipJson(KNIP_V6);
  assert.ok(report !== undefined);
  assert.equal(report.violations.length, 5);
  assert.deepEqual(report.counts, { deadCode: 2, dependencies: 3 });

  const codes = report.violations.map((violation) => violation.code).sort();
  assert.deepEqual(codes, [
    "unlisted-binary",
    "unlisted-dependency",
    "unused-dependency",
    "unused-export",
    "unused-file",
  ]);
});

test("unused exports and unlisted dependencies stay distinguishable", () => {
  const report = parseKnipJson(KNIP_V6);
  assert.ok(report !== undefined);

  const unusedExport = report.violations.find((v) => v.code === "unused-export");
  assert.ok(unusedExport !== undefined);
  assert.equal(unusedExport.file, "src/api.ts");
  assert.equal(unusedExport.line, 42);
  assert.equal(unusedExport.column, 14);
  assert.match(unusedExport.message, /unusedHelper/u);

  const unlisted = report.violations.find((v) => v.code === "unlisted-dependency");
  assert.ok(unlisted !== undefined);
  assert.match(unlisted.message, /not declared in package\.json/u);
  // The two hints must differ: one is a cleanup, the other is a broken build.
  assert.notEqual(unlisted.fixHint, unusedExport.fixHint);
});

test("a binary finding carries no fabricated line number", () => {
  const report = parseKnipJson(KNIP_V6);
  assert.ok(report !== undefined);
  const binary = report.violations.find((v) => v.code === "unlisted-binary");
  assert.ok(binary !== undefined);
  assert.equal(binary.line, undefined);
  assert.equal(binary.column, undefined);
});

test("reads knip 5's top-level files array and its enumMembers map", () => {
  const knipV5 = JSON.stringify({
    files: ["src/legacy.ts", "src/old.ts"],
    issues: [
      {
        file: "src/enums.ts",
        // v5 shape: parentSymbol -> items, not a flat array.
        enumMembers: { Status: [{ name: "Archived", line: 7, col: 3, pos: 90 }] },
        classMembers: [{ name: "Widget.unusedMethod", line: 12, col: 3, pos: 200 }],
      },
    ],
  });
  const report = parseKnipJson(knipV5);
  assert.ok(report !== undefined);

  const files = report.violations.filter((v) => v.code === "unused-file");
  assert.deepEqual(
    files.map((v) => v.file),
    ["src/legacy.ts", "src/old.ts"],
  );
  const member = report.violations.find((v) => v.code === "unused-enum-member");
  assert.ok(member !== undefined);
  assert.match(member.message, /Archived/u);
  assert.ok(report.violations.some((v) => v.code === "unused-class-member"));
});

test("a file listed as unused in both knip shapes is reported once", () => {
  const both = JSON.stringify({
    files: ["src/orphan.ts"],
    issues: [{ file: "src/orphan.ts", files: [{ name: "src/orphan.ts" }] }],
  });
  const report = parseKnipJson(both);
  assert.ok(report !== undefined);
  assert.equal(report.violations.filter((v) => v.code === "unused-file").length, 1);
});

test("an issue type kragg does not know is reported, not dropped", () => {
  const future = JSON.stringify({
    issues: [{ file: "src/x.ts", someFutureCheck: [{ name: "thing", line: 2, col: 1 }] }],
  });
  const report = parseKnipJson(future);
  assert.ok(report !== undefined);
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0]?.code, "knip-someFutureCheck");
});

test("CODEOWNERS metadata is not mistaken for a finding", () => {
  const withOwners = JSON.stringify({
    issues: [{ file: "src/x.ts", owners: [{ name: "@team" }], exports: [] }],
  });
  const report = parseKnipJson(withOwners);
  assert.ok(report !== undefined);
  assert.deepEqual(report.violations, []);
});

test("a clean report parses to zero findings", () => {
  const report = parseKnipJson(JSON.stringify({ issues: [] }));
  assert.ok(report !== undefined);
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.counts, { deadCode: 0, dependencies: 0 });
});

test("a report preceded by tool noise still parses", () => {
  const noisy = ` WARN  deprecated subdependency\n${KNIP_V6}\n`;
  const report = parseKnipJson(noisy);
  assert.ok(report !== undefined);
  assert.equal(report.violations.length, 5);
});

test("malformed, truncated and empty output never parse as clean", () => {
  for (const bad of [
    "",
    "   \n",
    "not json at all",
    '{"issues": [{"file": "a.ts", "exports": [{"name": "x"',
    '{"issues": {}}',
    "[]",
    '{"totally": "different"}',
  ]) {
    assert.equal(parseKnipJson(bad), undefined, `should not parse: ${bad}`);
  }
});

test("a brace inside a string does not truncate the document", () => {
  const braces = JSON.stringify({
    issues: [{ file: "src/x.ts", exports: [{ name: "render{Template}", line: 1, col: 1 }] }],
  });
  const report = parseKnipJson(braces);
  assert.ok(report !== undefined);
  assert.match(report.violations[0]?.message ?? "", /render\{Template\}/u);
});

test("an unidentifiable project skips visibly instead of passing", async () => {
  const root = project({ name: "no-manager" });
  const outcome = await runDeadCode({
    env: resolveProjectEnvironment(root),
    maxViolations: 25,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "not-configured");
  assert.match(outcome.message, /no package manager detected/u);
});

test("a missing knip is an environment error carrying the install command", async () => {
  const root = project({ name: "has-manager", packageManager: "pnpm@11.9.0" });
  const outcome = await runDeadCode({
    env: resolveProjectEnvironment(root),
    maxViolations: 25,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "missing-tool");
  assert.match(outcome.message, /pnpm add -D knip/u);
  // It must also say why it will not use a global one.
  assert.match(outcome.message, /will not fall back to a global/u);
});
