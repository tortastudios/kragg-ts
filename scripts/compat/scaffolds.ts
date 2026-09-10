/**
 * The `scaffolds` lane: every `kragg new` output installs and passes its own
 * `pnpm exec kragg check`.
 *
 * ── WHY THIS IS NOT COVERED BY `test/scaffold.test.ts` ─────────────────────
 * That suite asserts which FILES the scaffold writes and what is in them. It
 * has never installed one, and it has never run the gates the generated
 * `kragg.json` turns on. Those are the two ways a scaffold breaks in a user's
 * hands: a pin that no longer resolves (the generated `pnpm-workspace.yaml`
 * sets `minimumReleaseAge: 43200`, so a pin younger than 30 days FAILS the
 * user's very first install), and a template that does not satisfy the
 * strictness its own `kragg.json` demands. `docs/calibration.md` measured this
 * once, by hand. Once is not a check.
 *
 * Four rows, because `--kind mcp` is really two scaffolds: the fastmcp default
 * and the `--mcp-sdk official` opt-out ship different dependencies and
 * different entry points.
 *
 * ── THE ONE SUBSTITUTION, AND WHY IT IS HONEST ─────────────────────────────
 * `guardrails.ts` pins `@tortastudios/kragg-ts` in the generated `devDependencies` as soon
 * as this build carries a released version number — which 0.1.0 is, and which
 * is not on npm yet. Left alone, every row here would fail with an
 * `ERR_PNPM_FETCH_404` that says nothing about the scaffold. So the lane
 * rewrites that ONE dependency to the tarball this run just packed, which is
 * strictly closer to what a user gets than any registry version would be: it
 * is the code in this working tree, installed as a package. Every other pin,
 * the lockfile-free install, `--ignore-scripts` and the generated supply-chain
 * settings are untouched. The substitution is reported as its own check so it
 * can never be mistaken for "the published pin resolved".
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  advisory,
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
  tarballSpecifier,
  type CheckOutcome,
  type LaneEnvironment,
  type LaneOutcome,
  type RowOutcome,
} from "./support.ts";

interface ScaffoldSpec {
  readonly row: string;
  readonly kind: "cli" | "api" | "mcp";
  readonly mcpSdk: "fastmcp" | "official" | null;
}

const SPECS: readonly ScaffoldSpec[] = [
  { row: "cli", kind: "cli", mcpSdk: null },
  { row: "api", kind: "api", mcpSdk: null },
  { row: "mcp-fastmcp", kind: "mcp", mcpSdk: "fastmcp" },
  { row: "mcp-official", kind: "mcp", mcpSdk: "official" },
];

export async function scaffoldLane(environment: LaneEnvironment): Promise<LaneOutcome> {
  const rows: RowOutcome[] = [];
  for (const spec of SPECS) {
    if (!selected(environment, spec.row)) {
      continue;
    }
    announce(spec.row);
    rows.push(await runRow(environment, spec));
  }
  return { lane: "scaffolds", rows };
}

async function runRow(environment: LaneEnvironment, spec: ScaffoldSpec): Promise<RowOutcome> {
  const parent = scratch(`scaffold-${spec.row}`);
  const name = `demo-${spec.row}`;
  const root = join(parent, name);
  const checks: CheckOutcome[] = [];

  const created = await sh(
    "kragg new",
    [
      environment.nodeUnderTest,
      join(environment.repoRoot, "dist", "cli.js"),
      "new",
      name,
      "--kind",
      spec.kind,
      ...(spec.mcpSdk === null ? [] : ["--mcp-sdk", spec.mcpSdk]),
    ],
    parent,
  );
  checks.push(check(`kragg new --kind ${spec.kind} succeeds`, created.returncode === 0, outcomeOf(created)));
  if (created.returncode !== 0) {
    return ranRow(spec.row, checks);
  }
  note(`scaffold at ${root}`);

  checks.push(check("the generated manifest pins @tortastudios/kragg-ts", substituteTarball(root, environment.tarball), "rewritten to the packed tarball for this run"));

  const installed = await install(environment, root);
  checks.push(
    check("the generated project installs with --ignore-scripts", installed.returncode === 0, outcomeOf(installed)),
  );
  if (installed.returncode !== 0) {
    return ranRow(spec.row, checks);
  }

  const result = await sh(
    "pnpm exec kragg check",
    [environment.pnpm, "exec", "kragg", "check", "--format", "json", "--no-journal"],
    root,
  );
  const report = parseReport(result.stdout);
  checks.push(
    check("the report is schema_version 1", report?.["schema_version"] === 1, `got ${String(report?.["schema_version"])}`),
  );
  const tsc = gateNamed(report, "tsc");
  checks.push(
    check("the tsc gate ran against the generated sources", gateRan(tsc) && tsc?.["passed"] === true, describeGate(tsc)),
  );
  checks.push(...gateVerdictChecks(report, result.returncode));
  return ranRow(spec.row, checks);
}

/**
 * Split the verdict the way its two halves are actually governed.
 *
 * Everything except `audit` judges the code and config kragg just WROTE, and a
 * failure there is a scaffold bug this repository must fix — blocking.
 *
 * `audit` judges the world: it reads a live advisory feed against a dependency
 * tree whose direct pins are exact but whose transitives are not. The
 * generated `pnpm-workspace.yaml` deliberately sets `minimumReleaseAge` to 30
 * days, so when an advisory lands against a transitive, the FIX is held back
 * by the very cooldown that is protecting the project — a state no change here
 * can shorten, that resolves itself, and that must not turn every unrelated
 * pull request red. It is reported as an advisory warning, in full, with the
 * findings; `--strict` (how `external-tools.yml` runs this lane) makes it fail.
 *
 * A gate that ERRORED is never either of those. It is blocking in both halves:
 * the user's first `pnpm exec kragg check`, in a project they have not written
 * a line of code in, would exit 3.
 */
function gateVerdictChecks(
  report: Record<string, unknown> | null,
  returncode: number,
): readonly CheckOutcome[] {
  const errored: string[] = [];
  const failed: string[] = [];
  let auditFailed = false;
  let auditDetail = "no audit gate in the report";
  for (const gate of gatesIn(report)) {
    const name = String(gate["name"]);
    if (gate["error"] === true) {
      errored.push(name);
      continue;
    }
    if (name === "audit") {
      auditFailed = gate["passed"] !== true && gate["skipped"] !== true;
      auditDetail = describeGate(gate);
      continue;
    }
    if (gate["passed"] !== true && gate["skipped"] !== true) {
      failed.push(name);
    }
  }
  return [
    check(
      "no gate errored in the generated project",
      errored.length === 0,
      errored.length === 0 ? "" : `errored: ${errored.join(", ")}`,
    ),
    check(
      "every gate that judges the generated code passed",
      failed.length === 0,
      failed.length === 0 ? `exit ${String(returncode)}` : `failed: ${failed.join(", ")}`,
    ),
    advisory(
      "no published advisory against the pinned dependency tree",
      !auditFailed,
      auditDetail,
    ),
  ];
}

/** The report's `gates` array as records. */
function gatesIn(report: Record<string, unknown> | null): readonly Record<string, unknown>[] {
  const gates: unknown = report?.["gates"];
  if (!Array.isArray(gates)) {
    return [];
  }
  const records: Record<string, unknown>[] = [];
  for (const gate of gates) {
    if (typeof gate === "object" && gate !== null && !Array.isArray(gate)) {
      records.push(gate as Record<string, unknown>);
    }
  }
  return records;
}

/** Point the generated `@tortastudios/kragg-ts` devDependency at this run's tarball. */
function substituteTarball(root: string, tarball: string): boolean {
  const path = join(root, "package.json");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  const manifest = parsed as Record<string, unknown>;
  const dev: unknown = manifest["devDependencies"];
  if (typeof dev !== "object" || dev === null || Array.isArray(dev)) {
    return false;
  }
  const devDependencies = dev as Record<string, unknown>;
  const pinned = typeof devDependencies["@tortastudios/kragg-ts"] === "string";
  devDependencies["@tortastudios/kragg-ts"] = tarballSpecifier(tarball);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return pinned;
}
