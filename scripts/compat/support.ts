/**
 * Shared plumbing for the compatibility lanes in `scripts/compat.ts`.
 *
 * ── WHAT THE LANES ARE FOR ─────────────────────────────────────────────────
 * The unit suite proves things about the SOURCE tree, on ONE Node version, on
 * whatever host happens to run it. `package.json` claims more than that:
 * `engines.node` says `>=20`, `bin`/`main`/`types`/`exports` claim files that
 * only exist after a build, and `src/engine/runner.ts` carries a Windows
 * branch. Every one of those is a claim about the PACKED artifact on a host
 * nobody here runs. These lanes are how the claims get executed instead of
 * asserted, and `.github/workflows/compat.yml` is where the matrix rows the
 * developer machine cannot supply (Windows, Node 20, Node 22) actually run.
 *
 * ── NO NEW DEPENDENCIES, NO SHELL ──────────────────────────────────────────
 * Argument parsing is `node:util`. Every subprocess goes through
 * `src/engine/runner.ts` — the repository's single approved spawn point, argv
 * array, `shell: false` — exactly as `scripts/calibrate.ts` does. That is not
 * ceremony here: the Windows half of this harness spawns a `pnpm.cmd` shim,
 * so the harness driving the compatibility test is itself a user of the code
 * under test.
 *
 * The external tools the `tools` lane installs (vitest, biome, eslint,
 * secretlint …) are pinned, installed into a THROWAWAY fixture outside this
 * repository, and never enter `package.json` or the lockfile. They are inputs
 * to a test, not dependencies of kragg; see `docs/dependency-policy.md`.
 *
 * Runs under Node 24's type stripping like the test suite: no build step for
 * the harness itself. The artifact it EXERCISES is built JavaScript, which is
 * the entire point — see `--node` in `scripts/compat.ts`.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import type { CompletedCommand } from "../../src/engine/models.ts";
import { runCommand } from "../../src/engine/runner.ts";

/** One assertion inside a matrix row, and what it observed. */
export interface CheckOutcome {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  /**
   * True for an assertion about THIRD-PARTY STATE rather than about this
   * package: a published advisory against a transitive dependency of a
   * scaffold's pinned SDK, say. A failing advisory check is printed as `warn`,
   * named in the summary and never dropped — it simply does not turn a
   * required job red for something no pull-request author caused and no change
   * to this repository can fix. `--strict` promotes it to a failure, which is
   * how the separately governed `external-tools` workflow runs these lanes.
   */
  readonly advisory: boolean;
}

/**
 * One matrix row.
 *
 * `skipped` is a REASON, never a boolean and never absent-meaning-pass: a row
 * whose tool is not installed on this host has not passed, and the summary
 * says so in the same words the rest of this codebase uses for a gate that
 * did not run. `checks` is still reported for a skipped row so the log shows
 * how far it got.
 */
export interface RowOutcome {
  readonly row: string;
  readonly skipped: string | null;
  readonly checks: readonly CheckOutcome[];
}

/** One lane's worth of rows. */
export interface LaneOutcome {
  readonly lane: string;
  readonly rows: readonly RowOutcome[];
}

/** Everything a lane needs from the command line, resolved once. */
export interface LaneEnvironment {
  /** This repository's root, absolute. */
  readonly repoRoot: string;
  /**
   * The Node binary the PACKAGED artifact is executed with — the matrix row's
   * Node, which is generally NOT the Node running this harness. Node 20 and 22
   * cannot run a `.ts` file, so the harness stays on the development Node and
   * hands the interpreter under test to the thing being tested.
   */
  readonly nodeUnderTest: string;
  /** Package-manager binary for fixture installs. pnpm only; see AGENTS.md. */
  readonly pnpm: string;
  /** The packed tarball every lane installs, absolute. */
  readonly tarball: string;
  /** Keep the scratch directories for inspection instead of deleting them. */
  readonly keep: boolean;
  /** Row filter, so a CI matrix row runs exactly its own row. Empty = all. */
  readonly only: readonly string[];
}

/** Fixture installs and real linters are slow. Ten minutes is the ceiling. */
const STEP_TIMEOUT_MS = 10 * 60 * 1000;

/** Scratch roots created by this process, removed unless `--keep`. */
const scratchRoots: string[] = [];

/** Record one assertion. */
export function check(name: string, ok: boolean, detail: string): CheckOutcome {
  return record({ name, ok, detail, advisory: false });
}

/** Record one assertion about third-party state. See `CheckOutcome.advisory`. */
export function advisory(name: string, ok: boolean, detail: string): CheckOutcome {
  return record({ name, ok, detail, advisory: true });
}

function record(outcome: CheckOutcome): CheckOutcome {
  const label = outcome.ok ? "ok  " : outcome.advisory ? "warn" : "FAIL";
  const detail = outcome.detail === "" ? "" : ` — ${outcome.detail}`;
  process.stdout.write(`    ${label} ${outcome.name}${detail}\n`);
  return outcome;
}

/** Print a progress line that is not itself an assertion. */
export function note(text: string): void {
  process.stdout.write(`    ..   ${text}\n`);
}

/** Announce a row before its checks, so a hanging install is attributable. */
export function announce(row: string): void {
  process.stdout.write(`  row ${row}\n`);
}

/** A row that could not run, with the reason it could not. */
export function skippedRow(row: string, reason: string, checks: readonly CheckOutcome[] = []): RowOutcome {
  process.stdout.write(`    SKIP ${row} — ${reason}\n`);
  return { row, skipped: reason, checks };
}

/** A row that ran. */
export function ranRow(row: string, checks: readonly CheckOutcome[]): RowOutcome {
  return { row, skipped: null, checks };
}

/** True when every row passed, warned only, or is a stated skip. */
export function laneOk(lane: LaneOutcome): boolean {
  return lane.rows.every(
    (row) => row.skipped !== null || row.checks.every((one) => one.ok || one.advisory),
  );
}

/** True when any row carries a failing advisory check. `--strict` fails on it. */
export function laneWarned(lane: LaneOutcome): boolean {
  return lane.rows.some((row) => row.checks.some((one) => !one.ok && one.advisory));
}

/**
 * The end-of-run summary.
 *
 * A skip is printed as a skip and counted separately from a pass, because the
 * one thing this harness must never do is let "the tool was not installed"
 * read as "the platform is supported".
 */
export function renderLanes(lanes: readonly LaneOutcome[]): string {
  const lines: string[] = ["", "compatibility summary"];
  for (const lane of lanes) {
    for (const row of lane.rows) {
      const failures = row.checks.filter((one) => !one.ok && !one.advisory);
      const warnings = row.checks.filter((one) => !one.ok && one.advisory);
      lines.push(`  ${lane.lane}/${row.row}: ${statusOf(row.skipped, row.checks.length, failures.length, warnings.length)}`);
      for (const failure of failures) {
        lines.push(`      - FAIL ${failure.name}: ${failure.detail}`);
      }
      for (const warning of warnings) {
        lines.push(`      - warn ${warning.name}: ${warning.detail}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

/** One row's one-line verdict. A skip is never spelled as a pass. */
function statusOf(skipped: string | null, total: number, failed: number, warned: number): string {
  if (skipped !== null) {
    return `SKIP (${skipped})`;
  }
  if (failed > 0) {
    return `FAIL (${String(failed)}/${String(total)} checks)`;
  }
  const suffix = warned > 0 ? `, ${String(warned)} advisory warning(s)` : "";
  return `pass (${String(total)} checks${suffix})`;
}

/** Whether a row was selected by `--only`. Empty selection means all rows. */
export function selected(environment: LaneEnvironment, row: string): boolean {
  return environment.only.length === 0 || environment.only.includes(row);
}

/** A fresh scratch directory, outside this repository and its workspace. */
export function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `kragg-compat-${prefix}-`));
  scratchRoots.push(root);
  return root;
}

/** Remove every scratch directory this process created. */
export function cleanup(keep: boolean): void {
  if (keep) {
    for (const root of scratchRoots) {
      process.stdout.write(`  kept ${root}\n`);
    }
    return;
  }
  for (const root of scratchRoots) {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Write a `relative path -> contents` map under `root`, creating directories. */
export function writeTree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [relative, contents] of Object.entries(files)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
  }
}

/**
 * Run one command through the approved runner.
 *
 * `argv[0]` may be an absolute Windows `.cmd` shim: `launchPlan` turns that
 * into `<node> <script>` with no shell, which is the behaviour this harness
 * exists to prove works.
 */
export function sh(
  name: string,
  argv: readonly string[],
  cwd: string,
): Promise<CompletedCommand> {
  return runCommand(name, argv, cwd, { timeoutMs: STEP_TIMEOUT_MS });
}

/** A one-line summary of a finished command, for a check's `detail`. */
export function outcomeOf(result: CompletedCommand): string {
  const output = `${result.stdout}${result.stderr}`.trim().split("\n");
  const tail = output.slice(-3).join(" | ").slice(0, 400);
  return `exit ${result.returncode}${tail === "" ? "" : `: ${tail}`}`;
}

/**
 * Turn a package-manager NAME into something Windows can actually spawn.
 *
 * On POSIX a bare `pnpm` is handed to the OS's own PATH search and that is the
 * end of it. On Windows the entry corepack writes is `pnpm.cmd`, a batch file,
 * and `execFile` with `shell: false` cannot spawn one by bare name — nor
 * should it, since the alternative is `cmd.exe` and a command-line parser
 * between kragg and the tool. `launchPlan` handles a batch shim by reading it
 * and running the script it points at, but only when it is given a PATH to
 * read, so this resolves one.
 *
 * This is not the `PATH` lookup `environment/bin.ts` refuses to do. That one
 * resolves the PROJECT'S toolchain, where a global `tsc` of another major
 * silently changes a verdict. This resolves the DEVELOPER'S package manager
 * for a maintenance script — "whatever pnpm is on this PATH" is exactly what a
 * developer typing `pnpm install` gets, and is the intended answer.
 *
 * An explicit path (from `--pnpm`) is returned unchanged, and so is a name
 * that cannot be found: letting the spawn fail with its own error beats
 * inventing a path that does not exist.
 */
export function resolvePackageManager(name: string): string {
  if (process.platform !== "win32" || name.includes("/") || name.includes("\\")) {
    return name;
  }
  const extensions = (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";");
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    if (directory === "") {
      continue;
    }
    for (const extension of ["", ...extensions]) {
      const candidate = join(directory, `${name}${extension}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return name;
}

/** `pnpm install --ignore-scripts` in a fixture. Lifecycle scripts stay off. */
export function install(environment: LaneEnvironment, cwd: string): Promise<CompletedCommand> {
  return sh("pnpm install", [environment.pnpm, "install", "--ignore-scripts"], cwd);
}

/**
 * Pack the repository the way npm would publish it.
 *
 * `pnpm pack` honours `files`, so what comes out is exactly the tarball a
 * consumer installs — which is the artifact every lane here is about. Packing
 * does not build; the caller is responsible for `pnpm run build` first, and
 * `packaged.ts` asserts the build output exists before it packs.
 */
export async function packTarball(repoRoot: string, pnpm: string): Promise<string> {
  const destination = scratch("pack");
  const result = await sh("pnpm pack", [pnpm, "pack", "--pack-destination", destination], repoRoot);
  if (result.returncode !== 0) {
    throw new Error(`pnpm pack failed: ${outcomeOf(result)}`);
  }
  const line = result.stdout
    .split("\n")
    .map((one) => one.trim())
    .filter((one) => one.endsWith(".tgz"))
    .at(-1);
  if (line === undefined) {
    throw new Error(`pnpm pack printed no tarball path:\n${result.stdout}`);
  }
  return line;
}

/**
 * The `file:` dependency specifier for a packed tarball.
 *
 * Backslashes become forward slashes. A Windows path written verbatim into a
 * `file:` specifier is read as an escape sequence by more than one consumer of
 * that field, and forward slashes are accepted by every one of them — on
 * Windows too. This is the only place a host path becomes manifest text.
 */
export function tarballSpecifier(tarball: string): string {
  return `file:${tarball.replaceAll("\\", "/")}`;
}

/** `JSON.parse` that reports the text it choked on instead of throwing. */
export function parseReport(stdout: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** One gate out of a `kragg check --format json` payload, by name. */
export function gateNamed(
  report: Record<string, unknown> | null,
  name: string,
): Record<string, unknown> | null {
  const gates: unknown = report?.["gates"];
  if (!Array.isArray(gates)) {
    return null;
  }
  for (const gate of gates) {
    if (typeof gate === "object" && gate !== null && !Array.isArray(gate)) {
      const record = gate as Record<string, unknown>;
      if (record["name"] === name) {
        return record;
      }
    }
  }
  return null;
}

/**
 * A gate that RAN — neither skipped nor errored.
 *
 * The distinction is the point of the whole repository, so the harness makes
 * it too: a lane that accepted a skipped `tsc` gate as evidence that Windows
 * can spawn `tsc.cmd` would be asserting nothing at all.
 */
export function gateRan(gate: Record<string, unknown> | null): boolean {
  return gate !== null && gate["skipped"] !== true && gate["error"] !== true;
}

/** How a gate came out, for a check's `detail`. */
export function describeGate(gate: Record<string, unknown> | null): string {
  if (gate === null) {
    return "gate absent from the report";
  }
  const raw = gate["raw_output"];
  const excerpt = typeof raw === "string" ? raw.trim().split("\n").slice(0, 2).join(" | ") : "";
  return (
    `passed=${String(gate["passed"])} skipped=${String(gate["skipped"])} ` +
    `error=${String(gate["error"])} violations=${String(gate["violation_count"])}` +
    (excerpt === "" ? "" : ` :: ${excerpt.slice(0, 300)}`)
  );
}
