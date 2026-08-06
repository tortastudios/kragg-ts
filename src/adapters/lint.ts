/**
 * The lint gate's adapter — kragg-ts's answer to Python's `_ruff_gate`.
 *
 * ── WHY THIS IS NOT A PORT OF `_ruff_gate` ─────────────────────────────────
 * The Python sibling BUNDLES ruff. `_kragg_module("ruff", ...)` runs the copy
 * that shipped with kragg, so the gate can assume the linter exists and there
 * is exactly one of it. Neither assumption survives the move to JavaScript.
 *
 * WE BUNDLE NOTHING (docs/dependency-policy.md). The linter is resolved from
 * the PROJECT's `node_modules/.bin` through `environment/project.ts`, never
 * from `PATH` and never from a global install — a different major of a linter
 * reports pass/fail that does not reproduce in CI, which is the whole reason
 * that module refuses to fall back.
 *
 * And there is no single JavaScript linter to bundle. Three are in real use,
 * so the gate detects rather than dictates, and the absence of all three is a
 * VISIBLE SKIP carrying the exact install command. That is `_unconfigured` in
 * `catalog.py`: "Unconfigured policy-driven gates SKIP visibly, never PASS
 * silently."
 *
 * ── SKIP vs. ERROR, AND WHY THEY SPLIT ON THE POLICY ───────────────────────
 * The split follows rule 2 of `environment/project.ts` — "an explicit override
 * outranks inference, and an override we cannot honour is an error, never a
 * silent fall-through":
 *
 *  - `lintTool: "auto"` with no linter installed -> SKIP. The project never
 *    asked for one. Reporting it as an error would make kragg unusable in a
 *    repo that lints elsewhere, and the skip is loud enough to act on.
 *  - `lintTool: "oxlint"` with oxlint not installed -> ERROR (exit 3). The
 *    project named a linter. Quietly not running it leaves the project
 *    believing it is linted when it is not, which is the fail-open outcome
 *    every module in this codebase is built to refuse.
 *  - `lintTool: "off"` -> SKIP. An explicit, deliberate opt-out.
 *
 * ── FOUND-PROBLEMS vs. TOOL-CRASH ──────────────────────────────────────────
 * Ruff needs `error_codes=(2,)` because exit 1 and exit 2 mean different
 * things. Only ESLint is shaped that way; see `EXIT_FATAL` below and the long
 * note in each parser. For the two Rust linters the exit code is USELESS as a
 * discriminator — both map "found lint errors" and "your config is invalid" to
 * the same failure code — so the envelope in their JSON output is what decides,
 * and a missing envelope is a tool failure, never a green gate.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { runCommand } from "../engine/runner.ts";
import { commandOutput, type CompletedCommand, type Violation } from "../engine/models.ts";
import {
  missingTool,
  missingToolMessage,
  remediation,
  resolveBin,
  type ProjectEnvironment,
} from "../environment/project.ts";
import { parseBiomeJson } from "./linters/biome.ts";
import { parseEslintJson } from "./linters/eslint.ts";
import { parseOxlintJson } from "./linters/oxlint.ts";
import type { LintParse } from "./linters/json.ts";

/** A linter this adapter can drive. */
export type LintTool = "oxlint" | "biome" | "eslint";

/**
 * The `lintTool` policy field.
 *
 * `"auto"` detects (see `detectLintTool`), a tool name pins one, `"off"`
 * disables the gate outright.
 */
export type LintToolSetting = "auto" | LintTool | "off";

/**
 * Detection order, and the tie-break when a repo carries several configs.
 *
 * Ordered by COST TO RUN, cheapest first. oxlint and biome are native and
 * finish a mid-size repo in well under a second; ESLint loads a JavaScript
 * plugin graph and is an order of magnitude slower. A repo that carries two
 * configs is almost always mid-migration toward the faster tool, and the
 * lint gate is an inner-loop gate — running the slow one when the fast one is
 * also configured makes the loop worse for no extra signal.
 */
export const LINT_TOOLS: readonly LintTool[] = ["oxlint", "biome", "eslint"];

/**
 * ESLint's "I did not run" exit status, and the reason it is called out here.
 *
 * The direct analogue of ruff's `error_codes=(2,)`. `bin/eslint.js` documents
 * it in its own words: 2 is "unsuccessful execution", 1 is "successful
 * execution, lint problems found". No other supported linter separates the two
 * by exit code.
 */
const EXIT_FATAL = 2;

/**
 * A tool's stdout reader.
 *
 * `root` is the project root, needed because two of the three linters report
 * paths relative to their own cwd and one reports them absolute.
 */
type LintOutputParser = (stdout: string, root: string) => LintParse;

/** How a linter is invoked and what it is called on disk. */
interface LintToolSpec {
  /** `node_modules/.bin` entry to resolve. */
  readonly bin: string;
  /** npm package that provides it — differs from the bin for biome. */
  readonly packageName: string;
  /** Config files, relative to the project root, that mark it as configured. */
  readonly configFiles: readonly string[];
  /** Arguments after the binary, before the target paths. */
  readonly args: readonly string[];
  /** stdout parser for this tool's machine-readable output. */
  readonly parse: LintOutputParser;
}

/**
 * Per-tool invocation.
 *
 * The config file names are taken from each tool's own loader, not from
 * documentation:
 *
 *  - oxlint: `apps/oxlint/src/config_loader.rs` (`OXLINT_CONFIG_FILE_NAMES`)
 *    lists a json, a jsonc and two JS/TS names.
 *  - biome: `biome.json` / `biome.jsonc`.
 *  - eslint: flat config (`eslint.config.*`) plus the legacy `.eslintrc.*`,
 *    which still appears in repos pinned below ESLint 9.
 */
const SPECS: Readonly<Record<LintTool, LintToolSpec>> = {
  oxlint: {
    bin: "oxlint",
    packageName: "oxlint",
    configFiles: [
      ".oxlintrc.json",
      ".oxlintrc.jsonc",
      "oxlint.config.ts",
      "oxlint.config.mts",
    ],
    args: ["--format=json"],
    parse: parseOxlintJson,
  },
  biome: {
    bin: "biome",
    packageName: "@biomejs/biome",
    configFiles: ["biome.json", "biome.jsonc"],
    // `check` rather than `lint`: it is what the gate is specified to run, and
    // it covers lint + import order + formatting in one pass. The cost is that
    // a formatting difference surfaces as a lint violation; a project that
    // wants those separated should run `biome format` from its own scripts.
    args: ["check", "--reporter=json"],
    parse: parseBiomeJson,
  },
  eslint: {
    bin: "eslint",
    packageName: "eslint",
    configFiles: [
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.cjs",
      "eslint.config.ts",
      "eslint.config.mts",
      "eslint.config.cts",
      ".eslintrc.js",
      ".eslintrc.cjs",
      ".eslintrc.json",
      ".eslintrc.yaml",
      ".eslintrc.yml",
      ".eslintrc",
    ],
    args: ["--format", "json"],
    parse: parseEslintJson,
  },
};

/** Default target when the caller scopes nothing: the whole project. */
const DEFAULT_PATHS: readonly string[] = ["."];

export interface LintOptions {
  /** Resolved target project. Binaries come from ITS `node_modules/.bin`. */
  readonly env: ProjectEnvironment;
  /** `KraggPolicy.lintTool`. Defaults to `"auto"`. */
  readonly setting?: LintToolSetting | undefined;
  /**
   * Files or directories to lint — the `--changed` path. Unlike the type
   * checker (see `tsc.ts`), a linter is per-file and CAN be scoped this way
   * without changing what it computes. Defaults to the whole project.
   */
  readonly paths?: readonly string[] | undefined;
  /** Passed through to `runCommand`. */
  readonly timeoutMs?: number | undefined;
}

/**
 * What the gate should report.
 *
 * Three outcomes, not two, because "no linter here" and "the linter broke" are
 * different facts with different exit codes. `reason` forces the caller to
 * choose: `"skipped"` becomes `skipped: true` with a `skipReason`, `"error"`
 * becomes `error: true` and exit 3.
 */
export type LintOutcome =
  | {
      readonly ok: true;
      readonly tool: LintTool;
      readonly command: readonly string[];
      readonly violations: readonly Violation[];
    }
  | {
      readonly ok: false;
      readonly reason: "skipped" | "error";
      readonly message: string;
      readonly command?: readonly string[] | undefined;
    };

/** Which linter to run, or why none will be. */
export type LintDetection =
  | { readonly ok: true; readonly tool: LintTool; readonly bin: string }
  | {
      readonly ok: false;
      readonly reason: "skipped" | "error";
      readonly message: string;
    };

/**
 * Choose the linter for this project.
 *
 * PRECEDENCE, highest first:
 *
 *  1. `setting === "off"` -> skip. Nothing else is consulted.
 *  2. `setting` names a tool -> that tool, or an ERROR if it is not installed.
 *     An explicit instruction is never quietly downgraded to another tool.
 *  3. `"auto"`, stage one: the first tool in `LINT_TOOLS` that is BOTH
 *     configured (a config file in the project root) AND installed. Configured
 *     beats merely-installed because a config file is the project saying which
 *     linter it lints with, while a `node_modules` entry is often a transitive
 *     dependency of something else — half the ecosystem pulls ESLint in
 *     indirectly, and picking it on that basis would run a linter the project
 *     never chose against a config it does not have.
 *  4. `"auto"`, stage two: the first tool in `LINT_TOOLS` that is installed.
 *     This is what catches a project whose config lives somewhere this
 *     function does not look — `package.json#eslintConfig`, a workspace
 *     member's own config, or a tool running on its built-in defaults.
 *  5. Nothing installed -> skip, naming all three with their install commands
 *     and calling out any config file found without its tool.
 *
 * KNOWN GAP: config files are looked for in the project ROOT only. A monorepo
 * that configures its linter per package is detected through stage 4 instead,
 * which reaches the same tool whenever only one is installed.
 */
export function detectLintTool(
  env: ProjectEnvironment,
  setting: LintToolSetting = "auto",
): LintDetection {
  if (setting === "off") {
    return { ok: false, reason: "skipped", message: "lint gate disabled (lint_tool = off)" };
  }
  if (setting !== "auto") {
    const bin = resolveBin(env, SPECS[setting].bin);
    if (bin !== null) {
      return { ok: true, tool: setting, bin };
    }
    return {
      ok: false,
      // ERROR, not skip: see the module header. The project named this linter.
      reason: "error",
      message:
        `lint_tool = ${setting}, but ` +
        missingToolMessage(env, SPECS[setting].bin, SPECS[setting].packageName),
    };
  }

  const installed = LINT_TOOLS.map((tool) => ({ tool, bin: resolveBin(env, SPECS[tool].bin) }));
  const configured = installed.filter(({ tool }) => isConfigured(env.root, tool));
  const chosen =
    configured.find((entry) => entry.bin !== null) ?? installed.find((entry) => entry.bin !== null);
  if (chosen !== undefined && chosen.bin !== null) {
    return { ok: true, tool: chosen.tool, bin: chosen.bin };
  }
  return { ok: false, reason: "skipped", message: noLinterMessage(env) };
}

function isConfigured(root: string, tool: LintTool): boolean {
  return SPECS[tool].configFiles.some((name) => existsSync(join(root, name)));
}

/**
 * The skip message, which has to be actionable enough to fix the skip.
 *
 * Calls out a configured-but-missing linter first, because "you have a
 * `biome.json` and no biome" is a broken install with one obvious fix, while
 * "you have no linter at all" is a choice the project may have made.
 */
function noLinterMessage(env: ProjectEnvironment): string {
  const lines: string[] = [
    "no JavaScript linter is installed in this project; the lint gate did not run.",
  ];
  for (const tool of LINT_TOOLS) {
    if (isConfigured(env.root, tool)) {
      lines.push(
        `${configFilesFound(env.root, tool)} found, but ${SPECS[tool].bin} is not installed.`,
      );
    }
  }
  lines.push("Install one of:");
  for (const tool of LINT_TOOLS) {
    lines.push(`  ${tool}: ${remediation(env.packageManager, SPECS[tool].packageName)}`);
  }
  return lines.join("\n");
}

function configFilesFound(root: string, tool: LintTool): string {
  return SPECS[tool].configFiles.filter((name) => existsSync(join(root, name))).join(", ");
}

/**
 * Detect, run, and parse — the whole gate body except the `GateResult` shape.
 *
 * ORDER OF CHECKS after the run, and it matters:
 *
 *  1. `missingTool` on the result. The binary resolved a moment ago, so this
 *     catches a broken shim or a tool whose own entry point is unresolvable —
 *     an environment problem, exit 3, with the install command.
 *  2. ESLint's exit 2. The one exit code that means "did not run".
 *  3. The parser, which owns the envelope check for the Rust linters.
 *  4. Exit non-zero with NO violations parsed. The run failed, the output was
 *     well-formed, and it blamed nothing — so the failure is the tool's, not
 *     the code's. Passing here would be the silent-green outcome; reporting a
 *     violation-less failure as a code problem would be a wild goose chase.
 */
export async function runLint(options: LintOptions): Promise<LintOutcome> {
  const { env } = options;
  const detected = detectLintTool(env, options.setting ?? "auto");
  if (!detected.ok) {
    return { ok: false, reason: detected.reason, message: detected.message };
  }
  const spec = SPECS[detected.tool];
  const command = [detected.bin, ...spec.args, ...targetPaths(options.paths)];
  const result = await runCommand(
    detected.tool,
    command,
    env.root,
    options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
  );
  return interpretRun({ env, tool: detected.tool, spec, command, result });
}

/** What to lint: the caller's scope, or the whole project when it gave none. */
function targetPaths(paths: readonly string[] | undefined): readonly string[] {
  return paths === undefined || paths.length === 0 ? DEFAULT_PATHS : paths;
}

/** One completed linter invocation, with everything needed to judge it. */
interface LintRun {
  readonly env: ProjectEnvironment;
  readonly tool: LintTool;
  readonly spec: LintToolSpec;
  readonly command: readonly string[];
  readonly result: CompletedCommand;
}

/**
 * Steps 3 and 4 of the order above: believe the output, or refuse to.
 *
 * Kept apart from `runLint` because it is the part with no I/O in it — the
 * whole decision of green-vs-error is a pure function of a `CompletedCommand`,
 * and that is what makes it testable against recorded tool output.
 */
function interpretRun(run: LintRun): LintOutcome {
  const crashed = toolCrash(run);
  if (crashed !== null) {
    return crashed;
  }
  const parsed = run.spec.parse(run.result.stdout, run.env.root);
  if (!parsed.ok) {
    return errorOutcome(run, `${parsed.message}\n${trim(run.result)}`);
  }
  if (run.result.returncode !== 0 && parsed.violations.length === 0) {
    return errorOutcome(run, blamelessFailure(run));
  }
  return { ok: true, tool: run.tool, command: run.command, violations: parsed.violations };
}

/**
 * Steps 1 and 2: the two ways the run itself failed, checked before any of its
 * output is believed. `null` when neither applies.
 */
function toolCrash(run: LintRun): LintOutcome | null {
  if (missingTool(run.result) !== null) {
    return errorOutcome(run, missingToolMessage(run.env, run.spec.bin, run.spec.packageName));
  }
  if (run.tool === "eslint" && run.result.returncode === EXIT_FATAL) {
    return errorOutcome(run, fatalMessage(run.spec.bin, run.result));
  }
  return null;
}

/** An `error` outcome, which the gate turns into exit 3. */
function errorOutcome(run: LintRun, message: string): LintOutcome {
  return { ok: false, reason: "error", message, command: run.command };
}

/** Step 4's message: it failed, and it blamed nothing. */
function blamelessFailure(run: LintRun): string {
  return (
    `${run.spec.bin} exited ${run.result.returncode} but reported no violations, so the ` +
    `failure is the linter's and not the code's.\n${trim(run.result)}`
  );
}

function fatalMessage(bin: string, result: CompletedCommand): string {
  return (
    `${bin} exited ${EXIT_FATAL} (fatal error: bad config, unresolvable plugin, or an ` +
    `internal failure). That is distinct from exit 1, which means it ran and found ` +
    `problems.\n${trim(result)}`
  );
}

/**
 * BOTH streams, capped so a report stays readable.
 *
 * Both, not "whichever is non-empty": a linter's diagnosis can land on either
 * stream, and when a process dies with an empty stderr `runner.ts` substitutes
 * execFile's own `"Command failed: …"` message there. Preferring stderr would
 * therefore report that placeholder and DROP the real cause, leaving a user
 * with a message that names the command and nothing about why it died.
 */
function trim(result: CompletedCommand): string {
  const text = commandOutput(result);
  return text.length > 4000 ? `${text.slice(0, 4000)}\n… (output truncated)` : text;
}
