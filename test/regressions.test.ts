/**
 * END-TO-END REGRESSION GATE — one real project per closed false-green defect.
 *
 * ── WHAT THIS SUITE IS FOR ─────────────────────────────────────────────────
 * 1,090 passing unit tests did not catch false-green behaviour between the
 * engine, the adapters, the policy and the CLI, because every one of those
 * defects was found and fixed at a seam a unit test does not cross. Each case
 * below drives the BUILT CLI (`dist/cli.js`) over a real project on disk and
 * asserts the invariant its issue restored — the process exit status, a named
 * gate's three-state verdict, a violation code, or a file the run left behind.
 * If a future refactor reopens one of these holes, the case that pins it goes
 * red without anyone having to remember the original bug.
 *
 * ── THE RULES THESE ASSERTIONS KEEP ────────────────────────────────────────
 * - NO SNAPSHOTS. A recorded golden proves output has not changed since it was
 *   captured; it does not prove a defect is still fixed, and its usual failure
 *   mode is to be re-recorded. Every assertion here names the thing that was
 *   wrong.
 * - NOTHING IS MOCKED. The fixtures are projects: their own `package.json`,
 *   `tsconfig.json`, `kragg.json`, sources, suites, and — where the case needs
 *   a compiler — their own installed `typescript`. No runner is faked, no gate
 *   is stubbed, no result is injected.
 * - A GATE THAT DID NOT RUN IS NEVER TREATED AS EVIDENCE. Where a case asserts
 *   work happened, it asserts it against something only work produces: a
 *   coverage tracefile naming the functions that executed, a criticality file
 *   naming the functions that exist now, a journal line listing every gate.
 *
 * `test/regressionHarness.ts` materializes the projects and runs the CLI;
 * `test/regressionReport.ts` reads the payload field by field.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  artifactJson,
  artifactText,
  cleanupRoots,
  edit,
  hasArtifact,
  journalEntries,
  materialize,
  remove,
  runCli,
  type CliRun,
} from "./regressionHarness.ts";
import { gate, ran, reportOf, violationCodes, type ReportView } from "./regressionReport.ts";

after(() => {
  cleanupRoots();
});

/** The halt reason the pipeline prints when a gate that RAN did not pass. */
const HALT_REASON = "static gates failed";

/** Run a scenario at most once, however many `it`s ask for its result. */
function scenario<T>(build: () => Promise<T>): () => Promise<T> {
  let memo: Promise<T> | null = null;
  return () => {
    memo ??= build();
    return memo;
  };
}

/** Every name in a criticality sidecar that the analysis marked critical. */
function criticalNames(root: string): readonly string[] {
  const data = artifactJson(root, ".kragg/criticality.json");
  assert.ok(Array.isArray(data), ".kragg/criticality.json must be a JSON array");
  const names: string[] = [];
  for (const entry of data) {
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const record: Readonly<Record<string, unknown>> = { ...entry };
      if (record["is_critical"] === true && typeof record["name"] === "string") {
        names.push(record["name"]);
      }
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Ordinary success. The control case: everything the environment allows really
// runs, the run exits 0, and the artifacts prove the work happened.
// ---------------------------------------------------------------------------

const ordinary = scenario(async (): Promise<{ root: string; report: ReportView }> => {
  const root = await materialize({ fixture: "clean-project", git: true, typescript: true });
  const run = await runCli(root, ["check", "--format", "json"]);
  return { root, report: reportOf(run) };
});

describe("ordinary success: a clean project checks green, having actually checked", () => {
  it("exits 0 with nothing failed and nothing errored", async () => {
    const { report } = await ordinary();
    assert.equal(report.exitCode, 0);
    assert.equal(report.passed, true);
    assert.equal(report.summary.gatesFailed, 0);
    assert.deepEqual(
      report.gates.filter((view) => view.error).map((view) => view.name),
      [],
    );
  });

  it("compiled the project and ran the suite rather than reporting on neither", async () => {
    const { report } = await ordinary();
    for (const name of ["tsc", "test-coverage", "critical-coverage"]) {
      const view = gate(report, name);
      assert.equal(ran(view), true, `${name} did not run: ${JSON.stringify(view)}`);
      assert.equal(view.passed, true);
    }
  });

  it("left a coverage tracefile naming the functions the suite executed", async () => {
    const { root } = await ordinary();
    const lcov = artifactText(root, "coverage/lcov.info");
    assert.match(lcov, /^SF:src\/index\.ts$/mu);
    // `FNDA:<hits>,<name>`: a non-zero hit count is a fact only an executed
    // test can produce, and neither gate can fabricate it.
    assert.match(lcov, /^FNDA:[1-9]\d*,add$/mu);
    assert.match(lcov, /^FNDA:[1-9]\d*,formatMoney$/mu);
  });

  it("journaled exactly one run that accounts for every gate", async () => {
    const { root, report } = await ordinary();
    const entries = journalEntries(root);
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.ok(typeof entry === "object" && entry !== null && !Array.isArray(entry));
    const journalled: Readonly<Record<string, unknown>> = { ...entry };
    assert.equal(journalled["exit_code"], 0);
    assert.ok(Array.isArray(journalled["gates"]));
    assert.equal(journalled["gates"].length, report.gates.length);
    assert.equal(report.summary.gatesTotal, report.gates.length);
  });

  it("wrote the criticality sidecar the criticality-driven gates read", async () => {
    const { root } = await ordinary();
    assert.ok(Array.isArray(artifactJson(root, ".kragg/criticality.json")));
    assert.equal(hasArtifact(root, ".kragg/criticality.stamp.json"), true);
  });
});

// ---------------------------------------------------------------------------
// TOR-1358 (a). A gate that steps aside from inside its own run is a SKIP, not
// a failure, so it must not silence the slow tier. The reproduction: a project
// with no linter installed and no git repository — two runtime skips nothing
// on the gate spec could have predicted.
// ---------------------------------------------------------------------------

const runtimeSkip = scenario(async (): Promise<{ root: string; report: ReportView }> => {
  const root = await materialize({ fixture: "clean-project", typescript: true });
  const run = await runCli(root, ["check", "--no-journal", "--format", "json"]);
  return { root, report: reportOf(run) };
});

describe("TOR-1358: a runtime skip does not silence the slow tier", () => {
  it("really does skip two gates from inside their own run", async () => {
    const { report } = await runtimeSkip();
    for (const name of ["lint", "critical-tests"]) {
      const view = gate(report, name);
      assert.equal(view.skipped, true, `${name} was expected to skip`);
      assert.equal(view.passed, false, "a visible skip is never a pass");
      assert.equal(view.error, false);
      assert.notEqual(view.skipReason, null);
    }
  });

  it("still runs the slow tier, and no gate is skipped for a failure that did not happen", async () => {
    const { report } = await runtimeSkip();
    assert.equal(report.summary.gatesFailed, 0);
    for (const name of ["test-coverage", "critical-coverage"]) {
      const view = gate(report, name);
      assert.equal(ran(view), true, `${name} was silenced: ${JSON.stringify(view)}`);
      assert.equal(view.passed, true);
    }
    const halted = report.gates.filter((view) => (view.skipReason ?? "").includes(HALT_REASON));
    assert.deepEqual(halted.map((view) => view.name), []);
  });

  it("exits 0 having executed the suite, not having stepped over it", async () => {
    const { root, report } = await runtimeSkip();
    assert.equal(report.exitCode, 0);
    assert.match(artifactText(root, "coverage/lcov.info"), /^FNDA:[1-9]\d*,add$/mu);
  });
});

// ---------------------------------------------------------------------------
// TOR-1358 (b). A gate that could not run is `error: true` and exit 3, and it
// does not take the consolidated report down with it: the remaining gates run,
// and both the report and the journal still account for every gate.
//
// WHAT THIS CASE CAN AND CANNOT REACH, stated plainly. The other half of that
// fix is the `catch` in `runGates` that turns a gate whose `run` THROWS into
// the same errored result. No project tree reaches it: every file read, glob
// compile and tool probe under `src/gates/` is already guarded, which is the
// point of them, so there is no fixture that makes a gate throw without
// injecting a fault into the source. `test/engine.test.ts` covers the throw
// directly, at the level where it can be provoked.
//
// What this case pins is the CONSEQUENCE, which is the part a refactor can
// take away: a gate that could not run must leave the report intact. Removing
// the catch was verified to make these assertions fail — with the catch gone
// and a gate throwing, the process prints no report at all and `reportOf`
// has nothing to parse.
// ---------------------------------------------------------------------------

const erroredGate = scenario(async (): Promise<{ root: string; run: CliRun; report: ReportView }> => {
  const root = await materialize({ fixture: "clean-project" });
  const run = await runCli(root, ["check", "--format", "json"]);
  return { root, run, report: reportOf(run) };
});

describe("TOR-1358: a gate that could not run keeps the consolidated report", () => {
  it("reports the tool it could not use as an error, never as a pass or a skip", async () => {
    const { report } = await erroredGate();
    const tsc = gate(report, "tsc");
    assert.equal(tsc.error, true);
    assert.equal(tsc.passed, false);
    assert.equal(tsc.skipped, false);
    assert.match(tsc.rawOutput ?? "", /tsc is not installed in this project/u);
    assert.equal(report.exitCode, 3);
  });

  it("runs the rest of the tier anyway", async () => {
    const { report } = await erroredGate();
    for (const name of ["typing-strictness", "complexity", "structure", "nullable-default"]) {
      const view = gate(report, name);
      assert.equal(ran(view), true, `${name} did not run after the errored gate`);
      assert.equal(view.passed, true);
    }
  });

  it("accounts for every gate in the payload and in the journal", async () => {
    const { root, report } = await erroredGate();
    assert.equal(report.summary.gatesTotal, report.gates.length);
    assert.ok(report.gates.length >= 18, `only ${report.gates.length} gates were reported`);
    const entries = journalEntries(root);
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.ok(typeof entry === "object" && entry !== null && !Array.isArray(entry));
    const journalled: Readonly<Record<string, unknown>> = { ...entry };
    assert.ok(Array.isArray(journalled["gates"]));
    assert.equal(journalled["gates"].length, report.gates.length);
    assert.equal(journalled["exit_code"], 3);
  });
});

// ---------------------------------------------------------------------------
// TOR-1359. `--changed` narrows what is HANDED to the tools; it never narrows
// the compiler's verdict. Editing `src/greeting.ts` breaks `src/consumer.ts`,
// which is not in the change set — and that error is the whole point.
// ---------------------------------------------------------------------------

const unchangedCaller = scenario(async (): Promise<ReportView> => {
  const root = await materialize({ fixture: "tsc-unchanged-caller", git: true, typescript: true });
  edit(root, {
    "src/greeting.ts":
      "export function greet(name: string, times: number): string {\n" +
      "  return `hello ${name}`.repeat(times);\n" +
      "}\n",
  });
  return reportOf(await runCli(root, ["check", "--changed", "--no-journal", "--format", "json"]));
});

describe("TOR-1359: an unchanged caller's compiler error survives --changed", () => {
  it("really is an incremental run over the one edited file", async () => {
    const report = await unchangedCaller();
    assert.equal(report.mode, "changed");
    assert.deepEqual([...report.targets], ["src/greeting.ts"]);
  });

  it("reports the error in the file the change set does NOT name", async () => {
    const report = await unchangedCaller();
    const tsc = gate(report, "tsc");
    assert.equal(ran(tsc), true, "the tsc gate has to have run for this to mean anything");
    assert.equal(tsc.passed, false);
    const outside = tsc.violations.filter((violation) => violation.file === "src/consumer.ts");
    assert.equal(outside.length, 1, `expected one violation in the unchanged caller, got ${tsc.violationCount}`);
    assert.equal(outside[0]?.code, "TS2554");
  });

  it("exits 1 rather than 0", async () => {
    const report = await unchangedCaller();
    assert.equal(report.exitCode, 1);
  });
});

// ---------------------------------------------------------------------------
// TOR-1360. The suite takes the runner down with it. A stale coverage report
// from an earlier run is sitting at the published path claiming full coverage;
// accepting it would be a green gate over a run that produced nothing.
// ---------------------------------------------------------------------------

const crashedRunner = scenario(async (): Promise<{ root: string; report: ReportView }> => {
  const root = await materialize({ fixture: "crashed-runner", typescript: true });
  const run = await runCli(root, ["check", "--no-journal", "--format", "json"]);
  return { root, report: reportOf(run) };
});

describe("TOR-1360: a crashed runner does not pass on an old report", () => {
  it("errors on the test gate instead of reporting a coverage number", async () => {
    const { report } = await crashedRunner();
    const coverage = gate(report, "test-coverage");
    assert.equal(coverage.error, true);
    assert.equal(coverage.passed, false);
    assert.equal(coverage.skipped, false);
    assert.equal(report.exitCode, 3);
  });

  it("looked for this run's artifact, in the private directory it created", async () => {
    const { report } = await crashedRunner();
    const critical = gate(report, "critical-coverage");
    assert.equal(critical.passed, false, "a stale report must not become a pass");
    assert.match(critical.skipReason ?? "", /no coverage evidence from this run/u);
    assert.match(critical.skipReason ?? "", /\.kragg[/\\]runs[/\\]/u);
  });

  it("leaves the stale report exactly where it was, unread and unused", async () => {
    const { root } = await crashedRunner();
    // The seeded tracefile claims nine hits on every function. Nothing in the
    // report may be derived from it, and nothing may overwrite it either.
    assert.match(artifactText(root, "coverage/lcov.info"), /^FNDA:9,add$/mu);
    assert.match(artifactText(root, "coverage/coverage-final.json"), /"src\/index\.ts"/u);
  });
});

// ---------------------------------------------------------------------------
// TOR-1361. Twenty-five functions are critical; twenty rows are printed. The
// display limit must not become the enforcement limit.
// ---------------------------------------------------------------------------

const displayCap = scenario(
  async (): Promise<{ root: string; written: CliRun; report: ReportView }> => {
    const root = await materialize({ fixture: "criticality-display-cap", typescript: true });
    const written = await runCli(root, ["criticality", "--write"]);
    const run = await runCli(root, ["check", "--no-journal", "--format", "json"]);
    return { root, written, report: reportOf(run) };
  },
);

describe("TOR-1361: enforcement reaches past the twenty-row display cap", () => {
  it("persists the complete critical population, not the printed one", async () => {
    const { root, written } = await displayCap();
    assert.equal(written.exit, 0);
    assert.equal(criticalNames(root).length, 25);
  });

  it("still prints only twenty rows for a human", async () => {
    const { root } = await displayCap();
    const rows = artifactText(root, "CRITICALITY.md")
      .split("\n")
      .filter((line) => line.startsWith("| `src/"));
    assert.equal(rows.length, 20);
  });

  it("reports a finding for a function ranked below the printed rows", async () => {
    const { root, report } = await displayCap();
    const quality = gate(report, "test-quality");
    assert.equal(ran(quality), true);
    assert.equal(quality.passed, false);
    assert.deepEqual([...new Set(violationCodes(quality))], ["critical-untested"]);
    // One rule is tested; the other twenty-four are not, which is more than the
    // twenty a truncated analysis could ever have known about.
    assert.equal(quality.violationCount, 24);

    const printed = artifactText(root, "CRITICALITY.md");
    const beyondTheCap = quality.violations.filter(
      (violation) => !printed.includes(violation.message.split(" ").at(-1) ?? ""),
    );
    assert.ok(
      beyondTheCap.length > 0,
      "every finding named a function the table printed, so nothing proves the cap was passed",
    );
  });
});

// ---------------------------------------------------------------------------
// TOR-1362. `init` on an existing CommonJS project whose policy lives in
// `package.json#kragg` must not turn it into ESM and must not write a
// `kragg.json` that would shadow the policy it already has.
// ---------------------------------------------------------------------------

const initExisting = scenario(
  async (): Promise<{ root: string; init: CliRun; policy: Readonly<Record<string, unknown>> }> => {
    const root = await materialize({ fixture: "init-existing-project" });
    const init = await runCli(root, ["init"]);
    const shown = await runCli(root, ["policy", "show"]);
    const parsed: unknown = JSON.parse(shown.stdout);
    assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
    return { root, init, policy: { ...parsed } };
  },
);

describe("TOR-1362: init does not change what an existing project means", () => {
  it("withholds the four manifest keys that would redefine the package", async () => {
    const { root, init } = await initExisting();
    assert.equal(init.exit, 0);
    const manifest = artifactJson(root, "package.json");
    assert.ok(typeof manifest === "object" && manifest !== null && !Array.isArray(manifest));
    const keys = Object.keys({ ...manifest });
    for (const key of ["type", "engines", "packageManager"]) {
      assert.equal(keys.includes(key), false, `init added package.json#${key}`);
    }
    assert.equal(keys.includes("kragg"), true, "init dropped the project's embedded policy");
  });

  it("does not write a kragg.json that would shadow package.json#kragg", async () => {
    const { root, init } = await initExisting();
    assert.equal(hasArtifact(root, "kragg.json"), false);
    assert.match(init.stdout, /kragg\.json: not created/u);
  });

  it("leaves the embedded policy in force, unweakened", async () => {
    const { policy } = await initExisting();
    assert.equal(policy["max_file_lines"], 120);
    assert.deepEqual(policy["source_paths"], ["lib"]);
    assert.deepEqual(policy["test_paths"], ["spec"]);
    assert.deepEqual(policy["forbidden_calls"], [
      ["node:child_process", "spawn through the approved runner"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// TOR-1363. A wrong-typed setting is rejected by name. It must not become the
// default, because the default is WEAKER than what the project asked for.
// ---------------------------------------------------------------------------

const malformedPolicy = scenario(async (): Promise<{ root: string; run: CliRun }> => {
  const root = await materialize({ fixture: "malformed-policy" });
  const run = await runCli(root, ["check", "--no-journal", "--format", "json"]);
  return { root, run };
});

describe("TOR-1363: a malformed policy value is rejected, not defaulted", () => {
  it("exits 2 naming the file and the setting", async () => {
    const { run } = await malformedPolicy();
    assert.equal(run.exit, 2);
    assert.match(run.stderr, /kragg\.json#max_file_lines/u);
    assert.match(run.stderr, /must be an integer/u);
  });

  it("prints no report, because nothing was checked", async () => {
    const { run } = await malformedPolicy();
    assert.equal(run.stdout.trim(), "");
  });

  it("runs no gate at all: nothing under .kragg is written", async () => {
    const { root } = await malformedPolicy();
    assert.equal(hasArtifact(root, ".kragg"), false);
  });
});

// ---------------------------------------------------------------------------
// TOR-1364. A critical function whose file the test run never loaded has no
// entry in the coverage report — and "no entry" is not "nothing uncovered".
// ---------------------------------------------------------------------------

const unmeasured = scenario(async (): Promise<ReportView> => {
  const root = await materialize({ fixture: "unmeasured-critical", typescript: true });
  return reportOf(await runCli(root, ["check", "--no-journal", "--format", "json"]));
});

describe("TOR-1364: an unmeasured critical function is a finding, not a pass", () => {
  it("ran the suite and measured what it could", async () => {
    const report = await unmeasured();
    const coverage = gate(report, "test-coverage");
    assert.equal(ran(coverage), true);
    assert.equal(coverage.passed, true);
  });

  it("fails critical-coverage with the code that names the cause", async () => {
    const report = await unmeasured();
    const critical = gate(report, "critical-coverage");
    assert.equal(ran(critical), true, "the gate has to have run for this to mean anything");
    assert.equal(critical.passed, false);
    const unmeasuredFindings = critical.violations.filter(
      (violation) => violation.code === "critical-unmeasured",
    );
    assert.equal(unmeasuredFindings.length, 1);
    assert.equal(unmeasuredFindings[0]?.file, "src/audit.ts");
    assert.match(unmeasuredFindings[0]?.message ?? "", /never loaded src\/audit\.ts/u);
    assert.equal(report.exitCode, 1);
  });
});

// ---------------------------------------------------------------------------
// TOR-1365. A change set containing only configuration used to resolve an
// empty TypeScript selection and exit 0 without running a single gate — over
// the file that decides what every gate concludes about every file.
// ---------------------------------------------------------------------------

const configOnlyChange = scenario(
  async (): Promise<{ root: string; run: CliRun; report: ReportView }> => {
    const root = await materialize({ fixture: "clean-project", git: true, typescript: true });
    edit(root, {
      // The fixture's own policy with one budget added. Nothing else moves —
      // the point is that a change to this FILE, and to nothing a gate reads
      // as source, is still a reason to check everything.
      "kragg.json":
        '{\n  "source_paths": ["src"],\n  "test_paths": ["test/**/*.suite.js"],\n' +
        '  "secret_scanner": "off",\n  "test_runner": "node",\n  "max_file_lines": 300\n}\n',
    });
    const run = await runCli(root, ["check", "--changed", "--no-journal", "--format", "json"]);
    return { root, run, report: reportOf(run) };
  },
);

describe("TOR-1365: a configuration-only change promotes --changed to a full run", () => {
  it("reports the run it actually performed", async () => {
    const { report } = await configOnlyChange();
    assert.equal(report.mode, "full");
    assert.deepEqual([...report.targets], ["src"]);
  });

  it("says on stderr why the incremental run was promoted", async () => {
    const { run } = await configOnlyChange();
    assert.match(run.stderr, /kragg\.json changed/u);
  });

  it("actually ran the gates, including the slow tier", async () => {
    const { root, report } = await configOnlyChange();
    assert.ok(report.gates.length >= 18, "a promoted run must assemble the whole pipeline");
    const coverage = gate(report, "test-coverage");
    assert.equal(ran(coverage), true);
    assert.equal(coverage.passed, true);
    assert.match(artifactText(root, "coverage/lcov.info"), /^FNDA:[1-9]\d*,add$/mu);
    assert.equal(report.exitCode, 0);
  });
});

// ---------------------------------------------------------------------------
// TOR-1366. The freshness walk skipped any directory named `coverage` at any
// depth, so a project's own `src/coverage/` was invisible to it. Both the
// edited function and its callers live there, so nothing outside that
// directory changes — which is exactly what the old fingerprint could not see.
// ---------------------------------------------------------------------------

const invalidation = scenario(async (): Promise<{ root: string; report: ReportView }> => {
  const root = await materialize({ fixture: "criticality-invalidation", git: true, typescript: true });
  const written = await runCli(root, ["criticality", "--write"]);
  assert.equal(written.exit, 0);
  assert.ok(
    criticalNames(root).includes("src/coverage/report#summarize"),
    "the first analysis should have found the original name",
  );
  edit(root, {
    "src/coverage/report.ts":
      "export function condense(lines: readonly number[]): number {\n" +
      "  return lines.reduce((total, line) => total + line, 0);\n" +
      "}\n",
    "src/coverage/callers.ts":
      'import { condense } from "./report.ts";\n\n' +
      "export function totalStatements(lines: readonly number[]): number {\n" +
      "  return condense(lines);\n}\n\n" +
      "export function totalBranches(lines: readonly number[]): number {\n" +
      "  return condense(lines) * 2;\n}\n\n" +
      "export function totalFunctions(lines: readonly number[]): number {\n" +
      "  return condense(lines) + 1;\n}\n",
  });
  const run = await runCli(root, ["check", "--no-journal", "--format", "json"]);
  return { root, report: reportOf(run) };
});

describe("TOR-1366: an edit under a skipped-looking directory invalidates criticality", () => {
  it("re-derives the sidecar rather than trusting the pre-edit file", async () => {
    const { root } = await invalidation();
    const names = criticalNames(root);
    assert.ok(names.includes("src/coverage/report#condense"), `sidecar still reads ${names.join(", ")}`);
    assert.equal(names.includes("src/coverage/report#summarize"), false);
  });

  it("enforces on the functions that exist now, not the ones that used to", async () => {
    const { report } = await invalidation();
    const messages = report.gates
      .flatMap((view) => view.violations)
      .map((violation) => violation.message)
      .join("\n");
    assert.match(messages, /condense/u);
    assert.doesNotMatch(messages, /summarize/u);
    assert.equal(report.exitCode, 1);
  });
});

// ---------------------------------------------------------------------------
// TOR-1367. A scanner the policy NAMES is required. Not installed is exit 3,
// never a skip and never a green run over an unscanned repository.
// ---------------------------------------------------------------------------

const requiredScanner = scenario(async (): Promise<ReportView> => {
  const root = await materialize({ fixture: "required-scanner-missing", typescript: true });
  return reportOf(await runCli(root, ["check", "--no-journal", "--format", "json"]));
});

describe("TOR-1367: an explicitly named, unavailable scanner is an error", () => {
  it("errors rather than skipping", async () => {
    const report = await requiredScanner();
    const scanner = gate(report, "detect-secrets");
    assert.equal(scanner.error, true);
    assert.equal(scanner.skipped, false);
    assert.equal(scanner.passed, false);
  });

  it("says which scanner was required and how to install it", async () => {
    const report = await requiredScanner();
    const output = gate(report, "detect-secrets").rawOutput ?? "";
    assert.match(output, /secret_scanner = "secretlint" requires secretlint/u);
    assert.match(output, /the repository was NOT scanned for secrets/u);
    assert.match(output, /install secretlint/u);
  });

  it("exits 3", async () => {
    const report = await requiredScanner();
    assert.equal(report.exitCode, 3);
  });
});

// ---------------------------------------------------------------------------
// TOR-1368. Zero failures out of zero tests is arithmetic, not evidence.
// ---------------------------------------------------------------------------

const flakyZeroTests = scenario(async (): Promise<CliRun> => {
  const root = await materialize({ fixture: "flaky-zero-tests", git: true });
  return runCli(root, ["flaky", "--rerun", "2"]);
});

describe("TOR-1368: a rerun that discovers no tests is not a stability report", () => {
  it("exits 3 and says the run discovered nothing", async () => {
    const run = await flakyZeroTests();
    assert.equal(run.exit, 3);
    assert.match(run.stderr, /discovered no tests at all/u);
  });

  it("never claims the suite is stable", async () => {
    const run = await flakyZeroTests();
    assert.doesNotMatch(`${run.stdout}${run.stderr}`, /no flaky tests/u);
    assert.match(run.stderr, /no failure ratio is reported/u);
  });

  it("names the invocation and the patterns it searched", async () => {
    const run = await flakyZeroTests();
    assert.match(run.stderr, /invocation: /u);
    assert.match(run.stderr, /searched: tests\/\*\*/u);
  });
});

// ---------------------------------------------------------------------------
// TOR-1414. `Cannot find module 'x'` is Node's wording for a failed require —
// and also TypeScript's wording for TS2307, which a compiler that ran
// perfectly well writes to its stdout. Matching those words anywhere in a
// completed command's output reported the whole type-check gate as "tsc is
// not installed": exit 3, `date-helpers` named as the missing tool, and not
// one of the compiler's actual findings shown.
// ---------------------------------------------------------------------------

/** The bad import, introduced at run time. Line 3 is the `import`. */
const BAD_IMPORT =
  "/** Imports a package that is not installed: the compiler's TS2307. */\n" +
  "\n" +
  'import { formatDate } from "date-helpers";\n' +
  "\n" +
  "export function stamp(when: Date): string {\n" +
  "  return formatDate(when);\n" +
  "}\n";

const tscDiagnostic = scenario(async (): Promise<ReportView> => {
  const root = await materialize({ fixture: "tsc-diagnostic-not-missing", typescript: true });
  edit(root, { "src/index.ts": BAD_IMPORT });
  return reportOf(await runCli(root, ["check", "--no-journal", "--format", "json"]));
});

const tscEntryPointGone = scenario(async (): Promise<ReportView> => {
  const root = await materialize({ fixture: "tsc-diagnostic-not-missing", typescript: true });
  edit(root, { "src/index.ts": BAD_IMPORT });
  // The half-installed shape, and the other half of this case: the `.bin/tsc`
  // shim still resolves, and the entry point it requires is gone. Node's own
  // uncaught MODULE_NOT_FOUND is what the adapter reads then — and THAT is a
  // missing tool, which the fix must not have taken away.
  remove(root, join("node_modules", "typescript", "lib", "tsc.js"));
  return reportOf(await runCli(root, ["check", "--no-journal", "--format", "json"]));
});

describe("TOR-1414: a compiler diagnostic is a finding, not a missing compiler", () => {
  it("reports the tsc gate as RUN and failed, never as an environment error", async () => {
    const report = await tscDiagnostic();
    const tsc = gate(report, "tsc");
    assert.equal(ran(tsc), true, "the compiler ran; reporting it absent hid its findings");
    assert.equal(tsc.error, false);
    assert.equal(tsc.skipped, false);
    assert.equal(tsc.passed, false);
  });

  it("lists the TS2307 diagnostic at an actionable location", async () => {
    const report = await tscDiagnostic();
    const tsc = gate(report, "tsc");
    assert.deepEqual([...violationCodes(tsc)], ["TS2307"]);
    const found = tsc.violations[0];
    assert.equal(found?.file, "src/index.ts");
    assert.equal(found?.line, 3);
    assert.match(found?.message ?? "", /Cannot find module 'date-helpers'/u);
  });

  it("exits 1 (findings), not 3 (environment)", async () => {
    const report = await tscDiagnostic();
    assert.equal(report.exitCode, 1);
  });

  it("still calls a compiler whose own entry point is gone MISSING, at exit 3", async () => {
    const report = await tscEntryPointGone();
    const tsc = gate(report, "tsc");
    assert.equal(tsc.error, true);
    assert.equal(tsc.passed, false);
    assert.equal(tsc.skipped, false);
    assert.match(tsc.rawOutput ?? "", /tsc is not installed in this project/u);
    assert.equal(report.exitCode, 3);
  });
});

// ---------------------------------------------------------------------------
// TOR-1419. The runner kragg drives can enforce coverage thresholds of its
// own, on dimensions kragg does not compute. kragg read only the runner's
// report — which is written BEFORE the runner checks its thresholds — and
// reported a pass over a run the tool itself had already failed.
//
// The fixture asks `node --test` for its own `--test-coverage-lines=90` and
// sets kragg's `coverage_fail_under` to 50, so the suite passes, kragg's own
// floor is met, and the ONLY failing signal in the run is the runner's.
// ---------------------------------------------------------------------------

const runnerThreshold = scenario(async (): Promise<ReportView> => {
  const root = await materialize({ fixture: "runner-native-threshold", typescript: true });
  return reportOf(await runCli(root, ["check", "--no-journal", "--format", "json"]));
});

describe("TOR-1419: a runner-native coverage threshold is not absorbed into a pass", () => {
  it("really ran the suite, and every test in it passed", async () => {
    const report = await runnerThreshold();
    const view = gate(report, "test-coverage");
    assert.equal(ran(view), true, `test-coverage did not run: ${JSON.stringify(view)}`);
    // The runner's verdict is a FINDING, not missing evidence: exit 1, not 3.
    assert.equal(view.error, false);
    assert.equal(view.passed, false);
  });

  it("reports the runner's own threshold under its own code, attributed to the runner", async () => {
    const report = await runnerThreshold();
    const view = gate(report, "test-coverage");
    assert.deepEqual(violationCodes(view), ["runner-reported-failure"]);
    const message = view.violations[0]?.message ?? "";
    assert.match(message, /with all 2 tests passing/u);
    assert.match(message, /runner's OWN configured coverage threshold/u);
    assert.match(message, /not by kragg's line-coverage floor/u);
    // What the runner itself computed, quoted rather than re-derived.
    assert.match(message, /line coverage does not meet threshold of 90%/u);
  });

  it("keeps kragg's own floor a separate, unfired signal", async () => {
    const report = await runnerThreshold();
    // 50% was met, so `coverage-below-threshold` is absent — the two checks
    // are never merged into one number.
    assert.ok(!violationCodes(gate(report, "test-coverage")).includes("coverage-below-threshold"));
    // And the coverage evidence still reached the gate that consumes it.
    assert.equal(gate(report, "critical-coverage").skipped, false);
  });

  it("exits 1: the whole run fails, as the runner's own run does", async () => {
    const report = await runnerThreshold();
    assert.equal(report.exitCode, 1);
    assert.equal(report.passed, false);
  });
});
