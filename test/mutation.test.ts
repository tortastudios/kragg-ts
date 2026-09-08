/**
 * Tests for `kragg mutation`.
 *
 * STRYKER IS NEVER INSTALLED OR RUN HERE. The adapter is tested against
 * RECORDED FIXTURES built from the `mutation-testing-elements` schema
 * (`mutation-testing-report-schema`, as consumed by `@stryker-mutator/core`
 * 9.6.1): the exact key names, the exact eight `status` spellings, and the
 * 1-based `location.start.{line,column}`. A test that shelled out to a real
 * Stryker would take minutes and would test Stryker rather than this code.
 *
 * The two assertions that carry the most weight:
 *
 *  1. STATUS CLASSIFICATION. `Survived` and `NoCoverage` are undetected;
 *     `Killed`, `Timeout`, `CompileError`, `RuntimeError`, `Ignored` and
 *     `Pending` are not survivors. Getting `Timeout` wrong would report a
 *     detected mutant as a failure; getting `CompileError` wrong would demand
 *     tests for code that cannot compile.
 *  2. BASELINE SIGNATURE STABILITY. A baselined equivalent mutant must survive
 *     an edit ELSEWHERE in its file, because otherwise every acceptance is
 *     revoked by the next commit and the baseline is worthless. The signature
 *     therefore carries no line number, and that is asserted directly.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { EXIT_ENVIRONMENT, EXIT_GATE_FAILURES, EXIT_OK } from "../src/engine/report.ts";
import { resolveProjectEnvironment } from "../src/environment/project.ts";
import {
  emptyScopeMessage,
  mutationCommand,
  reportOutcome,
  splitCommaSafe,
} from "../src/commands/mutation.ts";
import {
  BASELINE_RELATIVE,
  filterBaselined,
  GITIGNORE_LINES,
  loadBaseline,
  signature,
  staleSignatures,
  writeBaseline,
} from "../src/commands/mutation/baseline.ts";
import {
  condense,
  parseReport,
  renderSurvivors,
  renderTotals,
  survivorCode,
  SURVIVING_MUTANT,
  UNCOVERED_MUTANT,
} from "../src/commands/mutation/report.ts";
import type { Survivor } from "../src/commands/mutation/report.ts";
import {
  buildStrykerCommand,
  DEFAULT_REPORT_PATH,
  installMessage,
  resolveReportLocation,
  STRYKER_BIN,
  strykerBin,
} from "../src/commands/mutation/stryker.ts";
import { expandGlobs, isMutable, selectTargets } from "../src/commands/mutation/targets.ts";
import { DEFAULT_POLICY } from "../src/policy/policy.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-mutation-"));
  roots.push(root);
  return root;
}

function write(root: string, relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

/* --- Fixtures ------------------------------------------------------------ */

interface MutantFixture {
  readonly id: string;
  readonly mutatorName: string;
  readonly status: string;
  readonly line: number;
  readonly column?: number;
  readonly replacement?: string;
}

function mutant(fixture: MutantFixture): Record<string, unknown> {
  return {
    id: fixture.id,
    mutatorName: fixture.mutatorName,
    replacement: fixture.replacement ?? "",
    status: fixture.status,
    location: {
      start: { line: fixture.line, column: fixture.column ?? 1 },
      end: { line: fixture.line, column: (fixture.column ?? 1) + 4 },
    },
  };
}

/** A report in the real schema shape, with one file's mutants. */
function report(files: Readonly<Record<string, readonly MutantFixture[]>>): string {
  const entries: Record<string, unknown> = {};
  for (const [name, mutants] of Object.entries(files)) {
    entries[name] = {
      language: "typescript",
      source: "// source\n",
      mutants: mutants.map(mutant),
    };
  }
  return JSON.stringify({
    schemaVersion: "1.0",
    thresholds: { high: 80, low: 60 },
    projectRoot: "/repo",
    files: entries,
  });
}

const ALL_STATUSES: readonly MutantFixture[] = [
  { id: "0", mutatorName: "ConditionalExpression", status: "Survived", line: 10, replacement: "true" },
  { id: "1", mutatorName: "ArithmeticOperator", status: "Killed", line: 11, replacement: "-" },
  { id: "2", mutatorName: "BooleanLiteral", status: "NoCoverage", line: 12, replacement: "false" },
  { id: "3", mutatorName: "EqualityOperator", status: "Timeout", line: 13, replacement: "<=" },
  { id: "4", mutatorName: "StringLiteral", status: "CompileError", line: 14, replacement: '""' },
  { id: "5", mutatorName: "BlockStatement", status: "RuntimeError", line: 15, replacement: "{}" },
  { id: "6", mutatorName: "ObjectLiteral", status: "Ignored", line: 16, replacement: "{}" },
  { id: "7", mutatorName: "OptionalChaining", status: "Pending", line: 17, replacement: "." },
];

/* --- Report parsing ------------------------------------------------------ */

describe("parseReport", () => {
  it("treats Survived and NoCoverage as undetected and nothing else", () => {
    const parsed = parseReport(report({ "src/pay.ts": ALL_STATUSES }));
    assert.ok(parsed !== null);
    assert.deepEqual(
      parsed.survivors.map((survivor) => `${survivor.status}@${survivor.line}`),
      ["Survived@10", "NoCoverage@12"],
    );
  });

  it("counts every status into the totals", () => {
    const parsed = parseReport(report({ "src/pay.ts": ALL_STATUSES }));
    assert.deepEqual(parsed?.totals, {
      mutants: 8,
      files: 1,
      killed: 1,
      survived: 1,
      noCoverage: 1,
      timeout: 1,
      compileError: 1,
      ignored: 1,
    });
    assert.equal(parsed?.schemaVersion, "1.0");
  });

  it("keeps the 1-based line and column from location.start", () => {
    const parsed = parseReport(
      report({
        "src/pay.ts": [
          { id: "0", mutatorName: "ArithmeticOperator", status: "Survived", line: 42, column: 7 },
        ],
      }),
    );
    assert.equal(parsed?.survivors[0]?.line, 42);
    assert.equal(parsed?.survivors[0]?.column, 7);
    assert.equal(parsed?.survivors[0]?.file, "src/pay.ts");
  });

  it("numbers occurrences per file+mutator+replacement, in report order", () => {
    const parsed = parseReport(
      report({
        "src/pay.ts": [
          { id: "0", mutatorName: "BooleanLiteral", status: "Survived", line: 3, replacement: "false" },
          { id: "1", mutatorName: "BooleanLiteral", status: "Survived", line: 9, replacement: "true" },
          { id: "2", mutatorName: "BooleanLiteral", status: "Survived", line: 20, replacement: "false" },
        ],
      }),
    );
    assert.deepEqual(
      parsed?.survivors.map((survivor) => `${survivor.replacement}#${survivor.occurrence}`),
      ["false#0", "true#0", "false#1"],
    );
  });

  it("returns null — never an empty report — for unusable input", () => {
    assert.equal(parseReport("not json"), null);
    assert.equal(parseReport("[]"), null);
    assert.equal(parseReport('{"schemaVersion":"1.0"}'), null);
  });

  it("skips a malformed mutant instead of discarding the whole report", () => {
    const raw = JSON.stringify({
      schemaVersion: "1.0",
      files: {
        "src/a.ts": {
          language: "typescript",
          source: "",
          mutants: [
            { status: "Survived" },
            { status: "Survived", mutatorName: "X", location: { start: {} } },
            null,
            mutant({ id: "9", mutatorName: "BooleanLiteral", status: "Survived", line: 4 }),
          ],
        },
        "src/broken.ts": { language: "typescript", source: "", mutants: "nope" },
      },
    });
    const parsed = parseReport(raw);
    assert.equal(parsed?.survivors.length, 1);
    assert.equal(parsed?.survivors[0]?.line, 4);
    // The unreadable file contributes no mutants and is not counted as a file.
    assert.equal(parsed?.totals.files, 1);
  });
});

describe("rendering", () => {
  const survived: Survivor = {
    file: "src/pay.ts",
    line: 10,
    column: 3,
    mutatorName: "ConditionalExpression",
    replacement: "true",
    status: "Survived",
    occurrence: 0,
  };
  const uncovered: Survivor = { ...survived, line: 12, status: "NoCoverage" };

  it("says so plainly when nothing survived", () => {
    assert.deepEqual(renderSurvivors([]), ["no surviving mutants"]);
  });

  it("emits one file:line:column pointer per survivor", () => {
    const lines = renderSurvivors([survived, uncovered]);
    assert.equal(lines[0], "mutation: 2 undetected mutants in 1 files");
    assert.equal(
      lines[1],
      "  src/pay.ts:10:3 surviving mutant (ConditionalExpression -> true)",
    );
    assert.equal(
      lines[2],
      "  src/pay.ts:12:3 uncovered mutant (ConditionalExpression -> true)",
    );
  });

  it("gives the two kinds different violation codes", () => {
    assert.equal(survivorCode(survived), SURVIVING_MUTANT);
    assert.equal(survivorCode(uncovered), UNCOVERED_MUTANT);
    assert.notEqual(SURVIVING_MUTANT, UNCOVERED_MUTANT);
  });

  it("collapses a multi-line replacement onto one bounded line", () => {
    assert.equal(condense("{\n  return 1;\n}"), "{ return 1; }");
    assert.equal(condense("x".repeat(200)).length, 60);
  });

  it("scores detection as killed+timeout over all valid mutants", () => {
    const line = renderTotals({
      mutants: 8,
      files: 1,
      killed: 1,
      survived: 1,
      noCoverage: 1,
      timeout: 1,
      compileError: 1,
      ignored: 1,
    });
    // 2 detected of 4 valid.
    assert.match(line, /score 50%/);
    assert.match(line, /1 killed, 1 timed out, 1 survived, 1 uncovered/);
  });

  it("reports n/a rather than 100% when no valid mutant ran", () => {
    assert.match(
      renderTotals({
        mutants: 0,
        files: 0,
        killed: 0,
        survived: 0,
        noCoverage: 0,
        timeout: 0,
        compileError: 0,
        ignored: 0,
      }),
      /score n\/a/,
    );
  });
});

/* --- Baseline ------------------------------------------------------------ */

describe("baseline", () => {
  const base: Survivor = {
    file: "src/pay.ts",
    line: 10,
    column: 3,
    mutatorName: "ConditionalExpression",
    replacement: "true",
    status: "Survived",
    occurrence: 0,
  };

  it("SURVIVES an edit elsewhere in the file — no line number in the signature", () => {
    const moved: Survivor = { ...base, line: 210, column: 9 };
    assert.equal(signature(base), signature(moved));
    assert.equal(signature(base), "src/pay.ts::ConditionalExpression::true::0");
  });

  it("distinguishes two replacements from the same mutator at one site", () => {
    assert.notEqual(signature(base), signature({ ...base, replacement: "false" }));
  });

  it("distinguishes repeated identical mutants by occurrence", () => {
    assert.notEqual(signature(base), signature({ ...base, occurrence: 1 }));
  });

  it("round-trips through disk and filters what it accepted", () => {
    const root = tempRoot();
    const other: Survivor = { ...base, mutatorName: "BooleanLiteral", replacement: "false" };
    assert.equal(writeBaseline(root, [base]), 1);
    const loaded = loadBaseline(root);
    assert.equal(loaded.size, 1);
    assert.deepEqual(filterBaselined([base, other], loaded), [other]);
    // Byte format matches Python's `json.dumps(..., indent=1) + "\n"`.
    const raw = readFileSync(join(root, BASELINE_RELATIVE), "utf8");
    assert.equal(raw, '[\n "src/pay.ts::ConditionalExpression::true::0"\n]\n');
  });

  it("degrades to an EMPTY set — never to accept-everything — when unreadable", () => {
    const root = tempRoot();
    assert.equal(loadBaseline(root).size, 0);
    write(root, BASELINE_RELATIVE, "{ not an array");
    assert.equal(loadBaseline(root).size, 0);
    write(root, BASELINE_RELATIVE, '{"accepted": ["x"]}');
    assert.equal(loadBaseline(root).size, 0);
  });

  it("replaces rather than merges, so a removal shows up in the diff", () => {
    const root = tempRoot();
    writeBaseline(root, [base]);
    writeBaseline(root, []);
    assert.equal(loadBaseline(root).size, 0);
  });

  it("reports stale entries without silently pruning them", () => {
    const baseline = new Set([signature(base), "src/gone.ts::BooleanLiteral::true::0"]);
    assert.deepEqual(staleSignatures([base], baseline), ["src/gone.ts::BooleanLiteral::true::0"]);
  });

  it("documents the gitignore negation git actually honours", () => {
    // `.kragg/` alone would make the negation a no-op: git never descends into
    // an excluded directory. The contents form is the only one that works.
    assert.deepEqual(GITIGNORE_LINES, [".kragg/*", "!.kragg/mutants.baseline"]);
  });
});

/* --- Target selection ---------------------------------------------------- */

describe("targets", () => {
  it("excludes declarations, tests and non-TypeScript files", () => {
    assert.equal(isMutable("src/pay.ts"), true);
    assert.equal(isMutable("src/pay.tsx"), true);
    assert.equal(isMutable("src/types.d.ts"), false);
    assert.equal(isMutable("src/pay.test.ts"), false);
    assert.equal(isMutable("src/pay.spec.ts"), false);
    assert.equal(isMutable("src/__tests__/pay.ts"), false);
    assert.equal(isMutable("src/bundle.js"), false);
  });

  it("expands include globs over the source paths only", () => {
    const root = tempRoot();
    write(root, "src/pay/charge.ts", "export const a = 1;\n");
    write(root, "src/util/log.ts", "export const b = 1;\n");
    write(root, "src/pay/charge.test.ts", "export const c = 1;\n");
    write(root, "vendor/pay/x.ts", "export const d = 1;\n");
    assert.deepEqual(expandGlobs(root, ["src"], ["src/pay/*.ts"]), ["src/pay/charge.ts"]);
    assert.deepEqual(expandGlobs(root, ["src"], ["*.ts"]).length, 2);
  });

  it("subtracts mutation_exclude from whichever scope won", async () => {
    const root = tempRoot();
    write(root, "src/a.ts", "export const a = 1;\n");
    write(root, "src/telemetry.ts", "export const b = 1;\n");
    const selection = await selectTargets({
      root,
      policy: {
        ...DEFAULT_POLICY,
        mutationInclude: ["src/*.ts"],
        mutationExclude: ["src/telemetry.ts"],
      },
    });
    assert.ok(selection.ok);
    assert.deepEqual(selection.files, ["src/a.ts"]);
    assert.equal(selection.source, "mutation_include");
    assert.equal(selection.narrowedToChanges, false);
  });

  it("lets --path override mutation_include", async () => {
    const root = tempRoot();
    write(root, "src/a.ts", "export const a = 1;\n");
    write(root, "src/b.ts", "export const b = 1;\n");
    const selection = await selectTargets({
      root,
      policy: { ...DEFAULT_POLICY, mutationInclude: ["src/a.ts"] },
      includeOverride: ["src/b.ts"],
    });
    assert.ok(selection.ok);
    assert.deepEqual(selection.files, ["src/b.ts"]);
    assert.equal(selection.source, "path-override");
  });

  it("derives the scope from criticality.json when no include is set", async () => {
    const root = tempRoot();
    write(root, "src/pay.ts", "export function chargeCard(): number {\n  return 1;\n}\n");
    write(root, "src/quiet.ts", "export function quiet(): number {\n  return 2;\n}\n");
    write(
      root,
      ".kragg/criticality.json",
      JSON.stringify([
        { name: "src/pay#chargeCard", fan_in: 7, is_critical: true },
        { name: "src/quiet#quiet", fan_in: 0, is_critical: false },
      ]),
    );
    const selection = await selectTargets({ root, policy: DEFAULT_POLICY });
    assert.ok(selection.ok);
    assert.deepEqual(selection.files, ["src/pay.ts"]);
    assert.equal(selection.source, "criticality");
  });

  it("FAILS rather than returning empty when the change set cannot be computed", async () => {
    const root = tempRoot();
    write(root, "src/a.ts", "export const a = 1;\n");
    const selection = await selectTargets({
      root,
      policy: { ...DEFAULT_POLICY, mutationInclude: ["src/*.ts"] },
      changedSince: null,
    });
    // A temp dir is not a git repository. "I could not tell" must never render
    // as "nothing changed", which would be a silent no-op run.
    assert.equal(selection.ok, false);
    assert.match(selection.ok ? "" : selection.message, /not a git repository/);
  });
});

/* --- Stryker invocation -------------------------------------------------- */

describe("stryker invocation", () => {
  const options = {
    env: resolveProjectEnvironment(process.cwd()),
    bin: "/repo/node_modules/.bin/stryker",
    targets: ["src/a.ts", "src/b.ts"],
    reportPath: "/repo/reports/mutation/mutation.json",
    incremental: true,
    force: false,
  };

  it("builds `stryker run` with a comma-separated --mutate and a json reporter", () => {
    assert.deepEqual(buildStrykerCommand(options), [
      "/repo/node_modules/.bin/stryker",
      "run",
      "--reporters",
      "json",
      "--mutate",
      "src/a.ts,src/b.ts",
      "--incremental",
    ]);
  });

  it("adds --force and omits --incremental on request", () => {
    assert.deepEqual(
      buildStrykerCommand({ ...options, incremental: false, force: true }),
      [
        "/repo/node_modules/.bin/stryker",
        "run",
        "--reporters",
        "json",
        "--mutate",
        "src/a.ts,src/b.ts",
        "--force",
      ],
    );
  });

  it("drops a path --mutate cannot encode, rather than corrupting the scope", () => {
    assert.deepEqual(splitCommaSafe(["src/a.ts", "src/we,ird.ts"]), {
      targets: ["src/a.ts"],
      dropped: ["src/we,ird.ts"],
    });
  });

  it("falls back to the schema default report path", () => {
    const root = tempRoot();
    const location = resolveReportLocation(root);
    assert.equal(location.path, join(root, DEFAULT_REPORT_PATH));
    assert.equal(location.note, null);
  });

  it("reads jsonReporter.fileName out of a JSON stryker config", () => {
    const root = tempRoot();
    write(root, "stryker.conf.json", JSON.stringify({ jsonReporter: { fileName: "out/m.json" } }));
    assert.equal(resolveReportLocation(root).path, join(root, "out/m.json"));
  });

  it("NOTES that it could not read a JS config rather than guessing silently", () => {
    const root = tempRoot();
    write(root, "stryker.conf.mjs", "export default {};\n");
    const location = resolveReportLocation(root);
    assert.equal(location.path, join(root, DEFAULT_REPORT_PATH));
    assert.match(location.note ?? "", /could not read a jsonReporter\.fileName/);
  });

  it("never resolves stryker from PATH in a project that lacks it", () => {
    const root = tempRoot();
    assert.equal(strykerBin(resolveProjectEnvironment(root)), null);
    assert.equal(STRYKER_BIN, "stryker");
  });

  it("names both packages, because core alone cannot run any test", () => {
    const root = tempRoot();
    write(root, "package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    write(root, "pnpm-lock.yaml", "");
    const message = installMessage(resolveProjectEnvironment(root));
    assert.match(message, /pnpm add -D @stryker-mutator\/core @stryker-mutator\/vitest-runner/);
    assert.match(message, /will not fall back to a global stryker/);
  });
});

/* --- Command ------------------------------------------------------------- */

describe("mutationCommand", () => {
  it("exits 0 with an actionable message when there is nothing critical yet", async () => {
    const root = tempRoot();
    write(root, "src/a.ts", "export const a = 1;\n");
    const lines: string[] = [];
    const code = await mutationCommand({ root, log: (line) => lines.push(line) });
    assert.equal(code, EXIT_OK);
    assert.match(lines.join("\n"), /kragg criticality --write/);
  });

  it("exits 3 with an install command when stryker is absent", async () => {
    const root = tempRoot();
    write(root, "src/a.ts", "export const a = 1;\n");
    write(root, "kragg.json", JSON.stringify({ mutation_include: ["src/*.ts"] }));
    const errors: string[] = [];
    const code = await mutationCommand({
      root,
      log: () => undefined,
      logError: (line) => errors.push(line),
    });
    // Exit 3, never 0: a mutation run that did not happen proved nothing.
    assert.equal(code, EXIT_ENVIRONMENT);
    assert.match(errors.join("\n"), /stryker is not installed in this project/);
  });

  it("phrases the empty scope by what actually narrowed it", () => {
    assert.match(emptyScopeMessage("criticality", true), /no changed files/);
    assert.match(emptyScopeMessage("criticality", false), /criticality --write/);
    assert.match(emptyScopeMessage("mutation_include", false), /mutation_include scope/);
  });

  /**
   * A project with one mutable file and a stand-in `stryker` — an `sh` script
   * in `node_modules/.bin`, the seam every adapter test uses — that records
   * having run and then exits without writing a report.
   */
  function projectWithFakeStryker(): string {
    const root = tempRoot();
    write(root, "src/a.ts", "export const a = 1;\n");
    write(root, "kragg.json", JSON.stringify({ mutation_include: ["src/*.ts"] }));
    const bin = join(root, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, STRYKER_BIN), "#!/bin/sh\ntouch ran.marker\nexit 0\n", { mode: 0o755 });
    return root;
  }

  it("never credits an earlier run's report to a stryker that wrote none", async () => {
    const root = projectWithFakeStryker();
    // Yesterday's report says two mutants survived — a verdict, either way.
    write(root, DEFAULT_REPORT_PATH, report({ "src/a.ts": ALL_STATUSES }));
    const errors: string[] = [];
    const code = await mutationCommand({
      root,
      log: () => undefined,
      logError: (line) => errors.push(line),
    });
    assert.equal(code, EXIT_ENVIRONMENT);
    assert.match(errors.join("\n"), /stryker exited 0 without writing .*mutation\.json/);
    assert.ok(existsSync(join(root, "ran.marker")), "stryker did run");
    // The stale report was cleared BEFORE the run, not read after it.
    assert.equal(existsSync(join(root, DEFAULT_REPORT_PATH)), false);
  });

  it("refuses to start stryker while an earlier report cannot be cleared", async () => {
    const root = projectWithFakeStryker();
    // A directory where the report goes: `rm` without `recursive` cannot
    // remove it, so the path still exists when stryker would be spawned.
    write(root, join(DEFAULT_REPORT_PATH, "keep.txt"), "not kragg's to delete\n");
    const errors: string[] = [];
    const code = await mutationCommand({
      root,
      log: () => undefined,
      logError: (line) => errors.push(line),
    });
    assert.equal(code, EXIT_ENVIRONMENT);
    assert.match(errors.join("\n"), /could not remove it/);
    assert.match(errors.join("\n"), /stryker was not started/);
    assert.equal(existsSync(join(root, "ran.marker")), false, "stryker must not have run");
    assert.ok(existsSync(join(root, DEFAULT_REPORT_PATH, "keep.txt")), "nothing was deleted");
  });
});

describe("reportOutcome", () => {
  const parsed = parseReport(report({ "src/pay.ts": ALL_STATUSES }));

  it("exits 1 while survivors remain, and 0 once they are baselined", () => {
    assert.ok(parsed !== null);
    const root = tempRoot();
    const lines: string[] = [];
    assert.equal(reportOutcome(root, parsed, false, (line) => lines.push(line)), EXIT_GATE_FAILURES);
    assert.match(lines.join("\n"), /2 undetected mutants/);

    const accepted: string[] = [];
    assert.equal(reportOutcome(root, parsed, true, (line) => accepted.push(line)), EXIT_OK);
    assert.match(accepted.join("\n"), /baselined 2 undetected mutants/);
    // The commit instruction is part of the contract, not decoration.
    assert.match(accepted.join("\n"), /COMMIT THIS FILE/);

    const after: string[] = [];
    assert.equal(reportOutcome(root, parsed, false, (line) => after.push(line)), EXIT_OK);
    assert.match(after.join("\n"), /no surviving mutants/);
    assert.match(after.join("\n"), /2 suppressed by the 2-entry accepted-mutant baseline/);
  });

  it("reports a baselined mutant that no longer appears", () => {
    assert.ok(parsed !== null);
    const root = tempRoot();
    write(root, BASELINE_RELATIVE, JSON.stringify(["src/gone.ts::BooleanLiteral::true::0"]));
    const lines: string[] = [];
    reportOutcome(root, parsed, false, (line) => lines.push(line));
    assert.match(lines.join("\n"), /1 baselined mutants no longer appear/);
  });
});
