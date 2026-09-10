/**
 * The `packaged` lane: does the tarball a consumer installs actually work,
 * on this Node and on this operating system?
 *
 * ── WHAT IT PROVES THAT THE UNIT SUITE CANNOT ──────────────────────────────
 * `pnpm test` imports `src/*.ts` on the one Node in `.node-version`. It never
 * builds, never packs, never installs, and never resolves `bin`, `main`,
 * `types` or `exports`. So four separate claims in `package.json` had no
 * executable evidence behind them:
 *
 *  1. `engines.node: ">=20"` — nothing ran on 20 or 22.
 *  2. `bin`/`main`/`types`/`exports` — nothing checked those paths exist in
 *     the published tarball, only that `src/` compiles.
 *  3. A TypeScript consumer sees usable types — never compiled against the
 *     emitted `.d.ts`, only against the sources.
 *  4. Windows — `src/engine/runner.ts` has a Windows-only branch that rewrites
 *     a `node_modules/.bin/*.cmd` shim into `<node> <script>`. Its unit tests
 *     inject `platform: "win32"` and so run everywhere, which proves the argv
 *     is right and proves nothing about `CreateProcess` accepting it.
 *
 * This lane closes all four, and the Windows row in
 * `.github/workflows/compat.yml` is where (4) actually executes. The fixture
 * deliberately installs `typescript` and `oxlint` so that `kragg check` has to
 * SPAWN two project-local binaries: on Windows those are `tsc.cmd` (a batch
 * shim, the case Node refuses to spawn without a shell) and `oxlint.cmd`
 * (whose target re-execs a native `.exe`). A gate that merely skipped would
 * prove nothing, so every assertion below insists the gate RAN.
 *
 * ── WHY THE FIXTURE HAS NO TESTS ───────────────────────────────────────────
 * `test-coverage` resolves the `node` runner to `process.execPath` and hands
 * it the project's test files. On Node 20 that fails for a TypeScript suite
 * with `ERR_UNKNOWN_FILE_EXTENSION` — Node 20 has no type stripping — which is
 * a fact about NODE, not about this package. Including it would turn "the
 * packaged CLI works on Node 20" into "Node 20 can run TypeScript", a
 * different question with a different answer; KNOWN_LIMITATIONS.md states
 * both. The real test runners are exercised in the `tools` lane instead.
 *
 * With no test files present the test gates skip VISIBLY with a reason, which
 * is the outcome this codebase is built to produce — and is asserted below
 * rather than ignored, so the absence cannot quietly become a pass.
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
  tarballSpecifier,
  writeTree,
  type CheckOutcome,
  type LaneEnvironment,
  type LaneOutcome,
  type RowOutcome,
} from "./support.ts";
import { readManifest, publishedEntryPoints } from "./manifest.ts";

/** Pinned toolchain for the fixture. Same versions this repository pins. */
const FIXTURE_TYPESCRIPT = "6.0.3";
const FIXTURE_OXLINT = "1.73.0";

/** The row name: one row, because the matrix dimension lives in CI. */
const ROW = "packed";

export async function packagedLane(environment: LaneEnvironment): Promise<LaneOutcome> {
  if (!selected(environment, ROW)) {
    return { lane: "packaged", rows: [] };
  }
  announce(ROW);
  const checks: CheckOutcome[] = [];
  const manifest = readManifest(environment.repoRoot);

  checks.push(...buildOutputChecks(environment.repoRoot, manifest));
  const row = await installedChecks(environment, manifest, checks);
  return { lane: "packaged", rows: [row] };
}

/** Every published path resolves to a file the build actually produced. */
function buildOutputChecks(
  repoRoot: string,
  manifest: Record<string, unknown>,
): readonly CheckOutcome[] {
  const outcomes: CheckOutcome[] = [];
  for (const entry of publishedEntryPoints(manifest)) {
    outcomes.push(
      check(
        `build output for ${entry.field}`,
        existsSync(join(repoRoot, entry.path)),
        `${entry.path}${existsSync(join(repoRoot, entry.path)) ? "" : " is missing — run `pnpm run build`"}`,
      ),
    );
  }
  return outcomes;
}

/** Install the tarball into a fixture and exercise it on the Node under test. */
async function installedChecks(
  environment: LaneEnvironment,
  manifest: Record<string, unknown>,
  checks: CheckOutcome[],
): Promise<RowOutcome> {
  const root = scratch("packaged");
  writeTree(root, fixtureFiles(environment.tarball));
  note(`fixture at ${root}`);

  const installed = await install(environment, root);
  checks.push(check("pnpm install of the tarball", installed.returncode === 0, outcomeOf(installed)));
  if (installed.returncode !== 0) {
    return ranRow(ROW, checks);
  }

  const packageRoot = join(root, "node_modules", "kragg-ts");
  for (const entry of publishedEntryPoints(manifest)) {
    checks.push(
      check(
        `installed tarball contains ${entry.field}`,
        existsSync(join(packageRoot, entry.path)),
        entry.path,
      ),
    );
  }

  const cli = join(packageRoot, "dist", "cli.js");
  const version = await sh("kragg --version", [environment.nodeUnderTest, cli, "--version"], root);
  const declared = typeof manifest["version"] === "string" ? manifest["version"] : "";
  checks.push(
    check(
      "packed CLI --version on the Node under test",
      version.returncode === 0 && version.stdout.includes(declared),
      `${outcomeOf(version)} (expected ${declared})`,
    ),
  );

  const help = await sh("kragg --help", [environment.nodeUnderTest, cli, "--help"], root);
  checks.push(
    check(
      "packed CLI --help lists the commands",
      help.returncode === 0 && help.stdout.includes("check") && help.stdout.includes("hook"),
      outcomeOf(help),
    ),
  );

  checks.push(...binShimChecks(root));
  checks.push(await shimLaunchCheck(environment, root));
  checks.push(...(await checkRunChecks(environment, cli, root)));
  checks.push(...(await typeConsumerChecks(environment, root)));
  return ranRow(ROW, checks);
}

/** The `node_modules/.bin` entry an installed consumer gets for `kragg`. */
function binShimChecks(root: string): readonly CheckOutcome[] {
  const binDir = join(root, "node_modules", ".bin");
  const names = process.platform === "win32" ? ["kragg.cmd", "kragg.ps1", "kragg"] : ["kragg"];
  const present = names.filter((name) => existsSync(join(binDir, name)));
  return [
    check(
      "node_modules/.bin carries a kragg shim",
      present.length > 0,
      present.length > 0 ? present.join(", ") : `none of ${names.join(", ")} in ${binDir}`,
    ),
  ];
}

/**
 * Run the CLI through the `.bin` shim, not through `node dist/cli.js`.
 *
 * On Windows this is the `.cmd` batch shim — the file `execFile` refuses to
 * spawn without a shell. `pnpm exec` is used because it is what the generated
 * projects' own `check` script uses, so this is the path a real user takes.
 */
async function shimLaunchCheck(environment: LaneEnvironment, root: string): Promise<CheckOutcome> {
  const result = await sh("pnpm exec kragg", [environment.pnpm, "exec", "kragg", "--version"], root);
  return check("pnpm exec kragg --version through the shim", result.returncode === 0, outcomeOf(result));
}

/**
 * A real `kragg check` on the fixture, on the Node under test.
 *
 * The assertions are about what RAN, not only about the exit code: a run in
 * which `tsc` and `lint` both skipped would exit 0 and prove nothing about
 * this platform's ability to spawn a project-local binary.
 */
async function checkRunChecks(
  environment: LaneEnvironment,
  cli: string,
  root: string,
): Promise<readonly CheckOutcome[]> {
  const result = await sh(
    "kragg check",
    [environment.nodeUnderTest, cli, "check", "--format", "json", "--no-journal"],
    root,
  );
  const report = parseReport(result.stdout);
  const outcomes: CheckOutcome[] = [
    check("kragg check exits 0 on the fixture", result.returncode === 0, outcomeOf(result)),
    check("kragg check emits schema_version 1 JSON", report?.["schema_version"] === 1, `got ${String(report?.["schema_version"])}`),
  ];
  for (const name of ["tsc", "lint"]) {
    const gate = gateNamed(report, name);
    outcomes.push(
      check(
        `the ${name} gate spawned the project's binary and passed`,
        gateRan(gate) && gate?.["passed"] === true,
        describeGate(gate),
      ),
    );
  }
  const testGate = gateNamed(report, "test-coverage");
  outcomes.push(
    check(
      "test-coverage skips visibly rather than passing silently",
      testGate?.["skipped"] === true && typeof testGate["skip_reason"] === "string",
      describeGate(testGate),
    ),
  );
  return outcomes;
}

/**
 * A TypeScript consumer compiled against the PACKED `.d.ts`, then executed.
 *
 * Two failures this catches and nothing else does: a `types` entry that points
 * at a file the build does not emit, and an emitted declaration that does not
 * typecheck under the strictness a consumer is likely to use. The compiled
 * output is then run on the Node under test, so "it typechecks" is not
 * mistaken for "it works".
 */
async function typeConsumerChecks(
  environment: LaneEnvironment,
  root: string,
): Promise<readonly CheckOutcome[]> {
  const consumer = join(root, "consumer");
  const tsc = await sh(
    "tsc consumer",
    [environment.pnpm, "exec", "tsc", "-p", "consumer/tsconfig.json"],
    root,
  );
  const outcomes: CheckOutcome[] = [
    check("a .ts consumer typechecks against the packed .d.ts", tsc.returncode === 0, outcomeOf(tsc)),
  ];
  if (tsc.returncode !== 0) {
    return outcomes;
  }
  const ran = await sh(
    "run consumer",
    [environment.nodeUnderTest, join(consumer, "out", "consumer.js")],
    root,
  );
  outcomes.push(
    check(
      "the compiled consumer runs the packed API on the Node under test",
      ran.returncode === 0 && ran.stdout.includes("kragg-api-ok schema=1"),
      outcomeOf(ran),
    ),
  );
  return outcomes;
}

/**
 * The fixture project.
 *
 * Small on purpose, and strict on purpose: `typing-strictness` audits the
 * project's own `tsconfig.json`, so a lax fixture would fail the check for a
 * reason that has nothing to do with packaging.
 */
function fixtureFiles(tarball: string): Readonly<Record<string, string>> {
  const strict = {
    target: "es2023",
    lib: ["es2023"],
    module: "nodenext",
    moduleResolution: "nodenext",
    types: ["node"],
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    noImplicitOverride: true,
    noFallthroughCasesInSwitch: true,
    noImplicitReturns: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    noPropertyAccessFromIndexSignature: true,
    useUnknownInCatchVariables: true,
    allowUnusedLabels: false,
    allowUnreachableCode: false,
    verbatimModuleSyntax: true,
    isolatedModules: true,
    erasableSyntaxOnly: true,
    forceConsistentCasingInFileNames: true,
    skipLibCheck: false,
  };
  return {
    "package.json": `${JSON.stringify(
      {
        name: "kragg-packaged-fixture",
        version: "0.0.0",
        private: true,
        type: "module",
        devDependencies: {
          "@types/node": "24.12.4",
          "kragg-ts": tarballSpecifier(tarball),
          oxlint: FIXTURE_OXLINT,
          typescript: FIXTURE_TYPESCRIPT,
        },
      },
      null,
      2,
    )}\n`,
    "tsconfig.json": `${JSON.stringify(
      { compilerOptions: { ...strict, noEmit: true }, include: ["src/**/*.ts"] },
      null,
      2,
    )}\n`,
    "kragg.json": `${JSON.stringify({ source_paths: ["src"], test_paths: ["test"] }, null, 2)}\n`,
    ".oxlintrc.json": `${JSON.stringify({ categories: { correctness: "error" } }, null, 2)}\n`,
    "src/greet.ts": [
      "/** The fixture's entire domain. Small on purpose. */",
      "export function greet(name: string): string {",
      "  return `hello, ${name}`;",
      "}",
      "",
    ].join("\n"),
    "consumer/tsconfig.json": `${JSON.stringify(
      {
        compilerOptions: { ...strict, noEmit: false, outDir: "out", rootDir: "." },
        include: ["consumer.ts"],
      },
      null,
      2,
    )}\n`,
    "consumer/consumer.ts": CONSUMER,
  };
}

/**
 * The consumer smoke test, in TypeScript, importing only `exports["."]`.
 *
 * It uses a value export, a type-only export and an async API so that a
 * broken `.d.ts` fails at compile time rather than producing an `any` that
 * silently typechecks — `noImplicitAny` alone would not catch a missing
 * declaration file, but `moduleResolution: nodenext` refusing to resolve
 * `kragg-ts` would.
 */
const CONSUMER = `import { buildReport, FAST, gateResult, runGates, SCHEMA_VERSION, toPayload } from "kragg-ts";
import type { GateResult, GateSpec, ReportPayload } from "kragg-ts";

const spec: GateSpec = {
  name: "compat-smoke",
  tier: FAST,
  run: (): GateResult => gateResult({ name: "compat-smoke", passed: true }),
};

const results: readonly GateResult[] = await runGates([spec]);
const payload: ReportPayload = toPayload(
  buildReport({
    command: "check",
    mode: "full",
    targets: [],
    results,
    maxViolations: 10,
    startedAt: new Date(0).toISOString(),
    gitSha: null,
  }),
);

if (payload.schema_version !== SCHEMA_VERSION) {
  throw new Error("schema version mismatch");
}
console.log(\`kragg-api-ok schema=\${payload.schema_version} gates=\${payload.gates.length}\`);
`;
