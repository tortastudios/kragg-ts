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
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { EXIT_GATE_FAILURES, EXIT_OK } from "../engine/report.ts";
import {
  describe,
  environmentFound,
  remediation,
  resolveBin,
  resolveProjectEnvironment,
  type ProjectEnvironment,
} from "../environment/project.ts";
import { loadPolicy } from "../policy/policy.ts";

/** A tool kragg drives, and the package that provides it. */
interface Tool {
  readonly bin: string;
  readonly packageName: string;
}

/** No gate can substitute for these. Missing means UNCHECKED. */
const REQUIRED_TOOLS: readonly Tool[] = [{ bin: "tsc", packageName: "typescript" }];

/** A group's label paired with the tools that can satisfy it. */
type ToolGroup = readonly [string, readonly Tool[]];

/** Interchangeable alternatives: the project needs one of each group. */
const TOOL_GROUPS: readonly ToolGroup[] = [
  [
    "linter",
    [
      { bin: "oxlint", packageName: "oxlint" },
      { bin: "biome", packageName: "@biomejs/biome" },
      { bin: "eslint", packageName: "eslint" },
    ],
  ],
  // `node --test` and `bun test` are runtimes, not `node_modules/.bin`
  // entries, so this group can legitimately be empty on disk and the test
  // gate still runs. It is reported, never counted.
  ["test runner", [{ bin: "vitest", packageName: "vitest" }]],
  ["secret scanner", [{ bin: "secretlint", packageName: "secretlint" }]],
];

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

  process.stdout.write("project tools:\n");
  for (const tool of REQUIRED_TOOLS) {
    ok = reportTool(env, tool) && ok;
  }
  for (const [label, group] of TOOL_GROUPS) {
    ok = reportGroup(env, label, group) && ok;
  }
  return ok ? EXIT_OK : EXIT_GATE_FAILURES;
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

/** A group of alternatives, summarized on one line. Never fails the run. */
function reportGroup(
  env: ProjectEnvironment,
  label: string,
  group: readonly Tool[],
): boolean {
  const found = group.filter((tool) => reportTool(env, tool));
  const summary =
    found.length > 0 ? `ok (${found.map((tool) => tool.bin).join(", ")})` : "none installed";
  process.stdout.write(`  ${label}: ${summary}\n`);
  // Never counted against the exit code: `node --test` and `bun test` are
  // runtimes rather than installed packages, and gitleaks is a standalone
  // binary, so an empty group here does not prove the gate cannot run.
  return true;
}
