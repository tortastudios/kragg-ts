/**
 * `kragg doctor` — is this project set up so the gates can actually run?
 *
 * Ported from `cmd_doctor`, `_doctor_environment` and `_doctor_project_tools`.
 * Every line answers one question and, when the answer is bad, carries the ONE
 * command that fixes it. A diagnostic that reports a problem without its
 * remedy just moves the search somewhere else.
 *
 * WHY IT EXISTS AT ALL: several gates report `error: true` and exit 3 when
 * their tool is missing, which is correct but arrives mid-pipeline. `doctor`
 * is the same information up front, in one place, before anyone has waited for
 * a type-check.
 *
 * REQUIRED vs. ADVISORY, and the split is deliberate. Required items make some
 * gate impossible: no `package.json` means no project, no compiler means no
 * type-checking, no source directory means nothing to check. Those set the
 * exit code. Advisory items are ALTERNATIVES — three linters, several test
 * runners, two secret scanners — where the project needs one, not all, so
 * reporting each individually as a failure would make a correctly-configured
 * repo look broken. Each group is summarized on its own line, and only an
 * empty group counts against the exit code.
 *
 * WHICH SIDE OF THAT LINE A TOOL FALLS ON IS THE POLICY'S DECISION, NOT THIS
 * FILE'S. `lint_tool`, `test_runner` and `secret_scanner` each take `"auto"`
 * (optional autodetection: pick whatever is installed, and report "none" as a
 * fact), `"off"` (a deliberate opt-out), or the NAME of a tool — and a named
 * tool is REQUIRED. The gate that drives it reports `error: true` and exit 3
 * when it is missing (see `adapters/lint.ts` and `gates/secrets.ts`), so
 * doctor must show it as a problem with its install command and count it
 * against the exit code. Reporting "linter: none installed" as advisory while
 * the pipeline is about to exit 3 over the same fact would make doctor the
 * one diagnostic that disagrees with the run.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { detectLintTool, type LintToolSetting } from "../adapters/lint.ts";
import type { TestRunnerChoice } from "../adapters/support/detect.ts";
import { EXIT_GATE_FAILURES, EXIT_OK } from "../engine/report.ts";
import {
  describe,
  environmentFound,
  remediation,
  resolveBin,
  resolveProjectEnvironment,
  type ProjectEnvironment,
} from "../environment/project.ts";
import {
  defaultLookup,
  secretScannerMissing,
  type SecretScannerChoice,
} from "../gates/secrets.ts";
import { loadPolicy, type KraggPolicy } from "../policy/policy.ts";

/** A tool kragg drives, and the package that provides it. */
interface Tool {
  readonly bin: string;
  readonly packageName: string;
}

/** No gate can substitute for these. Missing means UNCHECKED. */
const REQUIRED_TOOLS: readonly Tool[] = [{ bin: "tsc", packageName: "typescript" }];

/** Interchangeable linters: under `lint_tool: "auto"` the project needs one. */
const LINTERS: readonly Tool[] = [
  { bin: "oxlint", packageName: "oxlint" },
  { bin: "biome", packageName: "@biomejs/biome" },
  { bin: "eslint", packageName: "eslint" },
];

/**
 * The only test runner that is an installed package.
 *
 * `node --test` and `bun test` are RUNTIMES, so this group can legitimately be
 * empty on disk while the test gate still runs. Reported, never counted —
 * unless `test_runner` names vitest, which makes it required.
 */
const TEST_RUNNERS: readonly Tool[] = [{ bin: "vitest", packageName: "vitest" }];

/** Report the project's setup. Returns 1 when something required is missing. */
export function runDoctor(root: string): number {
  const policy = loadPolicy(root);
  const env = resolveProjectEnvironment(root);
  let ok = true;

  for (const [label, present] of layoutChecks(root, policy.sourcePaths, policy.testPaths)) {
    process.stdout.write(`${label}: ${present ? "ok" : "missing"}\n`);
    ok = ok && present;
  }

  process.stdout.write(`${describe(env)}\n`);
  if (!environmentFound(env)) {
    process.stdout.write(
      "Fix: add a lockfile or a package.json#packageManager field so kragg " +
        "knows which manager owns this project (it will not guess).\n",
    );
    ok = false;
  }

  return reportTools(env, policy) && ok ? EXIT_OK : EXIT_GATE_FAILURES;
}

/**
 * The `project tools:` block: what kragg would drive, and what is missing.
 *
 * Every line is printed before the verdict is returned — a diagnostic that
 * stops at the first problem makes the reader run it again for each one.
 */
function reportTools(env: ProjectEnvironment, policy: KraggPolicy): boolean {
  process.stdout.write("project tools:\n");
  const results = [
    ...REQUIRED_TOOLS.map((tool) => reportTool(env, tool)),
    reportLinter(env, policy.lintTool),
    reportTestRunner(env, policy.testRunner),
    reportSecretScanner(env, policy.secretScanner),
  ];
  return results.every((result) => result);
}

/** The files and directories the policy says this project has. */
function layoutChecks(
  root: string,
  sourcePaths: readonly string[],
  testPaths: readonly string[],
): readonly (readonly [string, boolean])[] {
  const any = (paths: readonly string[]): boolean =>
    paths.some((path) => existsSync(join(root, path)));
  return [
    ["package.json", existsSync(join(root, "package.json"))],
    ["tsconfig.json", existsSync(join(root, "tsconfig.json"))],
    ["source path", any(sourcePaths)],
    ["test path", any(testPaths)],
  ];
}

/**
 * One tool line: where it resolved from, or the command that installs it.
 *
 * Returns whether it RESOLVED. What that means for the exit code is the
 * caller's decision, which is the only way one function can serve both the
 * required tools and the interchangeable groups without lying about either.
 */
function reportTool(env: ProjectEnvironment, tool: Tool): boolean {
  const bin = resolveBin(env, tool.bin);
  if (bin !== null) {
    process.stdout.write(`  ${tool.bin}: ok (${bin})\n`);
    return true;
  }
  process.stdout.write(
    `  ${tool.bin}: MISSING -> ${remediation(env.packageManager, tool.packageName)}\n`,
  );
  return false;
}

/**
 * A group of ALTERNATIVES under `"auto"`, summarized on one line.
 *
 * Never fails the run, and the line says so: `node --test` and `bun test` are
 * runtimes rather than installed packages, and gitleaks is a standalone
 * binary, so an empty group here does not prove the gate cannot run. `hint`
 * is what turns "none installed" from a verdict into an instruction.
 */
function reportGroup(
  env: ProjectEnvironment,
  label: string,
  group: readonly Tool[],
  hint: string,
): boolean {
  const found = group.filter((tool) => reportTool(env, tool));
  const summary =
    found.length > 0
      ? `ok (${found.map((tool) => tool.bin).join(", ")})`
      : `none installed — optional: ${hint}`;
  process.stdout.write(`  ${label}: ${summary}\n`);
  return true;
}

/** One line for a tool the policy REQUIRED and this project does not have. */
function reportRequired(label: string, setting: string, fix: string): boolean {
  process.stdout.write(`  ${label}: MISSING -> required by ${setting}. ${fix}\n`);
  return false;
}

/**
 * The linter line, from the gate's OWN detection.
 *
 * `detectLintTool` is what `runLint` calls, so doctor cannot disagree with the
 * pipeline about which linter would run or about whether its absence is an
 * error: the function already returns `reason: "error"` exactly when
 * `lint_tool` names a linter that is not installed.
 */
function reportLinter(env: ProjectEnvironment, setting: LintToolSetting): boolean {
  if (setting === "auto") {
    return reportGroup(
      env,
      "linter",
      LINTERS,
      "install one to enable the lint gate, or set `lint_tool` to require one",
    );
  }
  const detection = detectLintTool(env, setting);
  if (detection.ok) {
    process.stdout.write(`  linter: ok (${detection.tool} at ${detection.bin})\n`);
    return true;
  }
  if (detection.reason === "skipped") {
    process.stdout.write(`  linter: disabled (lint_tool = "off")\n`);
    return true;
  }
  return reportRequired("linter", `lint_tool = "${setting}"`, detection.message);
}

/**
 * The test-runner line.
 *
 * `"node"` and `"bun"` name RUNTIMES, which are not resolved from
 * `node_modules/.bin` and cannot be missing in the way a package can, so they
 * are reported and not checked. `"vitest"` is a package, and naming it makes
 * it required — the same rule the test gate applies in `resolveRunner`.
 */
function reportTestRunner(env: ProjectEnvironment, choice: TestRunnerChoice): boolean {
  if (choice === "auto") {
    return reportGroup(
      env,
      "test runner",
      TEST_RUNNERS,
      "`node --test` and `bun test` are runtimes and need no install; vitest does",
    );
  }
  if (choice === "off") {
    process.stdout.write('  test runner: disabled (test_runner = "off")\n');
    return true;
  }
  if (choice !== "vitest") {
    process.stdout.write(`  test runner: ok (${choice} — a runtime, not an installed package)\n`);
    return true;
  }
  const bin = resolveBin(env, "vitest");
  if (bin !== null) {
    process.stdout.write(`  test runner: ok (vitest at ${bin})\n`);
    return true;
  }
  return reportRequired(
    "test runner",
    'test_runner = "vitest"',
    remediation(env.packageManager, "vitest"),
  );
}

/**
 * The secret-scanner line, resolved the way the gate resolves it.
 *
 * `defaultLookup` is the gate's own resolver, so gitleaks is looked for on
 * `PATH` (the one sanctioned exception, see `gates/secrets.ts`) and secretlint
 * in the project's `node_modules/.bin` — which is why this cannot be a
 * `reportGroup` over `Tool`s: half of it is not a package.
 */
function reportSecretScanner(env: ProjectEnvironment, choice: SecretScannerChoice): boolean {
  if (choice === "off") {
    process.stdout.write('  secret scanner: disabled (secret_scanner = "off")\n');
    return true;
  }
  const lookup = defaultLookup(env);
  if (choice === "auto") {
    const found = [
      ...(lookup.findGitleaks() === null ? [] : ["gitleaks"]),
      ...(lookup.findSecretlint() === null ? [] : ["secretlint"]),
    ];
    process.stdout.write(
      found.length > 0
        ? `  secret scanner: ok (${found.join(", ")})\n`
        : "  secret scanner: none installed — optional: install gitleaks or " +
            "secretlint to enable the scan, or set `secret_scanner` to require one\n",
    );
    return true;
  }
  const bin = choice === "gitleaks" ? lookup.findGitleaks() : lookup.findSecretlint();
  if (bin !== null) {
    process.stdout.write(`  secret scanner: ok (${choice} at ${bin})\n`);
    return true;
  }
  return reportRequired(
    "secret scanner",
    `secret_scanner = "${choice}"`,
    secretScannerMissing(env, choice),
  );
}
