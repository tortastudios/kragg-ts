/**
 * The `tools` lane: kragg's adapters against the REAL external tools.
 *
 * ── THE GAP THIS CLOSES ────────────────────────────────────────────────────
 * `test/lintParsers.test.ts`, `test/testRunner.test.ts` and their neighbours
 * feed the adapters RECORDED output — strings captured from some version of
 * some tool, at some point, and frozen into `test/fixtures/`. That is the
 * right way to test the parser, and it is not evidence about the tool. A
 * recorded fixture keeps passing forever after the tool changes its JSON:
 * biome renamed `diagnostics[].location.path` between majors, ESLint's flat
 * config changed which files are linted by default, vitest's `--outputFile`
 * schema has moved. Every one of those breaks kragg in production and breaks
 * nothing in the suite. So this lane installs each supported tool, at a pinned
 * version, runs kragg against a fixture that deliberately contains one
 * finding, and asserts kragg turned that tool's CURRENT output into a
 * violation with a file and a rule id.
 *
 * ── WHY IT IS SEPARATELY GOVERNED, AND NOT PART OF `check` ─────────────────
 * Everything this lane asserts depends on software this repository does not
 * control and cannot pin transitively. A tool ships a breaking change, a
 * registry has a bad five minutes, a platform-specific optional dependency
 * does not resolve — and a lane wired into the required checks turns every
 * unrelated pull request red for a reason no author can fix. That is how a
 * check becomes something people learn to re-run until it passes, which is
 * strictly worse than not having it. The same reasoning already keeps the
 * conformance job out of `check` in `.github/workflows/ci.yml`.
 *
 * So it lives in `.github/workflows/external-tools.yml`: `workflow_dispatch`
 * plus a weekly schedule, `continue-on-error`, never a required check. A red
 * run is a maintenance ticket ("bump the pin, fix the parser"), not a blocked
 * merge. Run it locally the same way:
 *
 *     pnpm run build
 *     node scripts/compat.ts tools                    # every row
 *     node scripts/compat.ts tools --only vitest+biome # one row
 *
 * ── WHERE THE PINS LIVE ────────────────────────────────────────────────────
 * `scripts/compat/toolFixture.ts` holds the fixture and the exact `VERSIONS`
 * table. Bumping a pin there is the entire maintenance ritual of this lane.
 *
 * `bun` is the exception that cannot be pinned: its npm package installs the
 * binary from a lifecycle script, which this repository forbids running. bun
 * rows therefore need a bun already on PATH — `oven-sh/setup-bun` in CI — and
 * report an explicit SKIP with a reason when there is none. A skip is never
 * counted as a pass; `--strict` turns it into a failure for CI runs that
 * expect every tool to be present.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  announce,
  check,
  describeGate,
  gateNamed,
  gateRan,
  install,
  note,
  outcomeOf,
  parseReport,
  ranRow,
  scratch,
  selected,
  sh,
  skippedRow,
  writeTree,
  type CheckOutcome,
  type LaneEnvironment,
  type LaneOutcome,
  type RowOutcome,
} from "./support.ts";
import { toolFixtureFiles, type Linter, type RowSpec, type Runner } from "./toolFixture.ts";

const RUNNERS: readonly Runner[] = ["vitest", "node", "bun"];
const LINTERS: readonly Linter[] = ["oxlint", "biome", "eslint"];

/** The scanner row's name. One scanner is npm-installable; see `lookup.ts`. */
const SECRETLINT_ROW = "secretlint";

/** Every runner × linter pair, plus one row for the npm-installable scanner. */
function rowSpecs(): readonly RowSpec[] {
  const specs: RowSpec[] = [];
  for (const runner of RUNNERS) {
    for (const linter of LINTERS) {
      specs.push({ row: `${runner}+${linter}`, runner, linter, scanner: false });
    }
  }
  specs.push({ row: SECRETLINT_ROW, runner: "node", linter: "oxlint", scanner: true });
  return specs;
}

export async function toolsLane(environment: LaneEnvironment): Promise<LaneOutcome> {
  const rows: RowOutcome[] = [];
  for (const spec of rowSpecs()) {
    if (!selected(environment, spec.row)) {
      continue;
    }
    announce(spec.row);
    rows.push(await runRow(environment, spec));
  }
  return { lane: "tools", rows };
}

async function runRow(environment: LaneEnvironment, spec: RowSpec): Promise<RowOutcome> {
  if (spec.runner === "bun") {
    const probe = await sh("bun --version", ["bun", "--version"], environment.repoRoot);
    if (probe.returncode !== 0) {
      return skippedRow(
        spec.row,
        "no `bun` on PATH — bun's npm package installs its binary from a lifecycle " +
          "script, which this repository does not run. Install bun (CI uses oven-sh/setup-bun).",
      );
    }
    note(`bun ${probe.stdout.trim()}`);
  }

  const root = scratch(spec.row.replace("+", "-"));
  writeTree(root, toolFixtureFiles(environment.tarball, spec));
  note(`fixture at ${root}`);

  const checks: CheckOutcome[] = [];
  const installed = await install(environment, root);
  checks.push(check("pnpm install of the real tools", installed.returncode === 0, outcomeOf(installed)));
  if (installed.returncode !== 0) {
    return ranRow(spec.row, checks);
  }

  // `--all` forces the slow tier: the fixture's lint gate FAILS by design, and
  // without `--all` a failed fast gate would skip `test-coverage`, which is the
  // half of the row that exercises the test runner.
  const result = await sh(
    "kragg check --all",
    [
      environment.nodeUnderTest,
      join(root, "node_modules", "kragg-ts", "dist", "cli.js"),
      "check",
      "--all",
      "--format",
      "json",
      "--no-journal",
    ],
    root,
  );
  const report = parseReport(result.stdout);
  checks.push(
    check("kragg check produced a schema_version 1 report", report?.["schema_version"] === 1, outcomeOf(result)),
  );
  checks.push(...lintChecks(spec, report));
  checks.push(...runnerChecks(spec, report, root));
  if (spec.scanner) {
    checks.push(...scannerChecks(report));
  }
  return ranRow(spec.row, checks);
}

/** The linter really ran, and its CURRENT output became a located violation. */
function lintChecks(spec: RowSpec, report: Record<string, unknown> | null): readonly CheckOutcome[] {
  const gate = gateNamed(report, "lint");
  const outcomes: CheckOutcome[] = [
    check(`${spec.linter} ran (not skipped, not errored)`, gateRan(gate), describeGate(gate)),
  ];
  const violations = violationsOf(gate);
  const located = violations.filter(
    (violation) => typeof violation["file"] === "string" && violation["file"].includes("bad"),
  );
  const coded = violations.filter((violation) => typeof violation["code"] === "string" && violation["code"] !== "");
  outcomes.push(
    check(
      `${spec.linter}'s finding parsed into a located violation`,
      located.length > 0,
      `${String(violations.length)} violations; files: ${violations
        .map((violation) => String(violation["file"]))
        .slice(0, 4)
        .join(", ")}`,
    ),
  );
  outcomes.push(
    check(
      `${spec.linter}'s rule id survived parsing`,
      coded.length > 0,
      `codes: ${coded
        .map((violation) => String(violation["code"]))
        .slice(0, 4)
        .join(", ")}`,
    ),
  );
  return outcomes;
}

/**
 * The test runner really ran, and kragg read the report IT wrote.
 *
 * The coverage artifact is the load-bearing assertion. `test-coverage` writes
 * each invocation's report into a directory that did not exist before the
 * invocation created it (see `adapters/support/testCommands.ts`) and publishes
 * it afterwards, so a published artifact cannot be a leftover — it is proof
 * this runner, this run, produced output kragg could parse.
 */
function runnerChecks(
  spec: RowSpec,
  report: Record<string, unknown> | null,
  root: string,
): readonly CheckOutcome[] {
  const gate = gateNamed(report, "test-coverage");
  const artifact =
    spec.runner === "vitest"
      ? join(root, "coverage", "coverage-final.json")
      : join(root, "coverage", "lcov.info");
  return [
    check(
      `${spec.runner} ran the suite and the gate passed`,
      gateRan(gate) && gate?.["passed"] === true,
      describeGate(gate),
    ),
    check(
      `kragg read and published ${spec.runner}'s own coverage report`,
      existsSync(artifact),
      artifact,
    ),
  ];
}

/** secretlint really ran, and its finding became a redacted violation. */
function scannerChecks(report: Record<string, unknown> | null): readonly CheckOutcome[] {
  const gate = gateNamed(report, "detect-secrets");
  const violations = violationsOf(gate);
  return [
    check("secretlint ran (not skipped, not errored)", gateRan(gate), describeGate(gate)),
    check(
      "secretlint's finding parsed into a located violation",
      violations.some((violation) => typeof violation["file"] === "string" && violation["file"].includes("leak")),
      `${String(violations.length)} violations; codes: ${violations
        .map((violation) => String(violation["code"]))
        .slice(0, 4)
        .join(", ")}`,
    ),
  ];
}

/** A gate's `violations` array as records. */
function violationsOf(gate: Record<string, unknown> | null): readonly Record<string, unknown>[] {
  const violations: unknown = gate?.["violations"];
  if (!Array.isArray(violations)) {
    return [];
  }
  const records: Record<string, unknown>[] = [];
  for (const violation of violations) {
    if (typeof violation === "object" && violation !== null && !Array.isArray(violation)) {
      records.push(violation as Record<string, unknown>);
    }
  }
  return records;
}
