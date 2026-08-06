/**
 * Driving the `stryker` binary, and finding the report it wrote.
 *
 * The runner half of `kragg mutation`; `../mutation.ts` carries the design
 * argument and the command itself. Everything asserted here about Stryker's
 * CLI and behaviour was read out of `@stryker-mutator/core@9.6.1` (npm
 * `dist-tags.latest`), not inferred:
 *
 *  - `bin` is `{ "stryker": "bin/stryker.js" }`, so the console script is
 *    `stryker` and the subcommand is `stryker run [configFile]`.
 *  - The full CLI option list lives in `packages/core/src/stryker-cli.ts`.
 *    THERE IS NO `--since` FLAG, and no git-aware option of any kind — the
 *    complete option schema (`packages/api/schema/stryker-core.json`) has
 *    `incremental` and `incrementalFile` and nothing else in that family.
 *  - `--mutate` is parsed with a `,` splitter, so it is one comma-separated
 *    argument. It accepts globs and the `file.ts:1:3-1:5` mutation-range form.
 *  - `--incremental` / `--incrementalFile <file>` (default
 *    `reports/stryker-incremental.json`), and `--force` to re-test everything
 *    despite an existing incremental file.
 *  - There is NO CLI option for the json report's path. It is settable only
 *    through the config file's `jsonReporter.fileName`.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { detectTestRunner } from "../../adapters/support/detect.ts";
import type { TestRunnerName } from "../../adapters/support/detect.ts";
import { runCommand } from "../../engine/runner.ts";
import { missingTool, remediation, resolveBin } from "../../environment/project.ts";
import type { ProjectEnvironment } from "../../environment/project.ts";
import { parseReport } from "./report.ts";
import type { MutationReport } from "./report.ts";

/** The console script `@stryker-mutator/core` installs into `.bin`. */
export const STRYKER_BIN = "stryker";

/** Where Stryker's `json` reporter writes unless the project says otherwise. */
export const DEFAULT_REPORT_PATH = "reports/mutation/mutation.json";

/**
 * A mutation run is minutes-to-hours, not seconds. `engine/runner.ts` defaults
 * to a 10-minute ceiling, which would kill almost any real run; this is the one
 * command that legitimately needs a much larger one.
 */
export const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Stryker's config discovery order, replicated exactly.
 *
 * `packages/core/src/config/config-file-formats.ts` builds it as prefixes
 * `["", "."]` x suffixes `[".conf", ".config"]` x extensions
 * `["json", "js", "mjs", "cjs"]`, and `ConfigReader.findConfigFile` takes the
 * FIRST that exists. The order is replicated so that when we look for a
 * `jsonReporter.fileName` override we read the same file Stryker will.
 */
export const CONFIG_FILE_NAMES: readonly string[] = ["", "."].flatMap((prefix) =>
  [".conf", ".config"].flatMap((suffix) =>
    ["json", "js", "mjs", "cjs"].map((ext) => `${prefix}stryker${suffix}.${ext}`),
  ),
);

/** The plugin package per detectable runner; `null` where Stryker ships none. */
type RunnerPlugins = Readonly<Record<TestRunnerName, string | null>>;

/** Stryker's test-runner plugin for each runner kragg can detect. */
const RUNNER_PLUGIN: RunnerPlugins = {
  vitest: "@stryker-mutator/vitest-runner",
  // `node --test` emits TAP, which the tap runner consumes.
  node: "@stryker-mutator/tap-runner",
  // Stryker ships no bun plugin. Its generic `command` runner works (it runs
  // `npm test` and reads the exit code) but cannot do per-test coverage
  // analysis, so every mutant re-runs the whole suite.
  bun: null,
};

/** Where the JSON report will be, and how confident we are about it. */
export interface ReportLocation {
  /** Absolute path. */
  readonly path: string;
  /** A caveat to surface when the location was inferred rather than read. */
  readonly note: string | null;
}

/**
 * Resolve where Stryker's `json` reporter will write.
 *
 * The path cannot be set from the CLI, and we must NOT pass our own config
 * file: `ConfigReader.findConfigFile` treats an explicit path as a REPLACEMENT
 * for discovery, so the project would lose its own `testRunner`, `plugins` and
 * `tsconfigFile` settings and the run would fail or, worse, run against the
 * wrong toolchain.
 *
 * So: read `jsonReporter.fileName` out of the project's config when that config
 * is JSON, and otherwise fall back to the schema default WITH a note. Reading a
 * JS/MJS/CJS config would mean importing and executing project code just to
 * learn a file path — not a trade worth making.
 */
export function resolveReportLocation(root: string): ReportLocation {
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = join(root, name);
    if (!existsSync(candidate)) {
      continue;
    }
    if (!name.endsWith(".json")) {
      return {
        path: join(root, DEFAULT_REPORT_PATH),
        note:
          `${name} is not JSON, so kragg could not read a jsonReporter.fileName ` +
          `override from it and assumed the default ${DEFAULT_REPORT_PATH}`,
      };
    }
    const configured = readReportFileName(candidate);
    if (configured !== null) {
      return {
        path: isAbsolute(configured) ? configured : join(root, configured),
        note: null,
      };
    }
    return { path: join(root, DEFAULT_REPORT_PATH), note: null };
  }
  return { path: join(root, DEFAULT_REPORT_PATH), note: null };
}

function readReportFileName(configPath: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(data)) {
    return null;
  }
  const reporter = data["jsonReporter"];
  if (!isRecord(reporter)) {
    return null;
  }
  const fileName = reporter["fileName"];
  return typeof fileName === "string" && fileName !== "" ? fileName : null;
}

export interface StrykerRunOptions {
  readonly env: ProjectEnvironment;
  readonly bin: string;
  readonly targets: readonly string[];
  readonly reportPath: string;
  readonly incremental: boolean;
  /** Re-test every mutant even with an incremental file present. */
  readonly force: boolean;
  readonly timeoutMs?: number | undefined;
}

/** Stryker ran and produced a readable report, or it did not. */
export type MutationOutcome =
  | {
      readonly ok: true;
      readonly report: MutationReport;
      readonly command: readonly string[];
    }
  | { readonly ok: false; readonly message: string };

/**
 * Build the argv.
 *
 * `--mutate` takes a COMMA-SEPARATED list, which means a path containing a
 * comma cannot be expressed. The caller drops such a path and says so, rather
 * than letting the scope silently mean something else.
 *
 * `--reporters json` REPLACES the project's configured reporters for this run
 * (CLI options win in `ConfigReader.readConfig`'s `deepMerge`). That is
 * intentional: `clear-text` and `html` are for a human at a terminal, and this
 * command's output is usually read by an agent.
 */
export function buildStrykerCommand(options: StrykerRunOptions): readonly string[] {
  const argv = [options.bin, "run", "--reporters", "json"];
  if (options.targets.length > 0) {
    argv.push("--mutate", options.targets.join(","));
  }
  if (options.incremental) {
    argv.push("--incremental");
  }
  if (options.force) {
    argv.push("--force");
  }
  return argv;
}

/**
 * Run Stryker and parse its report.
 *
 * THE STALE REPORT IS DELETED FIRST. This is the direct analogue of the Python
 * implementation unlinking the cosmic-ray session before `init` — there because
 * `cosmic-ray init` refuses to overwrite a session that already has results,
 * here because a report left by a previous run is indistinguishable from this
 * run's once it is on disk, and reading one as if it were fresh would report
 * yesterday's survivors against today's code.
 *
 * Stryker's own EXIT CODE IS NOT THE VERDICT and is not consulted for one:
 * `determineExitCode` sets 1 only when `thresholds.break` is configured and
 * missed, so a run full of survivors exits 0 by default. The report is the
 * verdict; the exit code only ever appears in a failure message.
 */
export async function runStryker(options: StrykerRunOptions): Promise<MutationOutcome> {
  removeQuietly(options.reportPath);
  mkdirQuietly(dirname(options.reportPath));

  const command = buildStrykerCommand(options);
  const result = await runCommand("stryker", command, options.env.root, {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  const missing = missingTool(result);
  if (missing !== null && (missing === STRYKER_BIN || missing.endsWith(`/${STRYKER_BIN}`))) {
    return { ok: false, message: installMessage(options.env) };
  }

  let raw: string;
  try {
    raw = readFileSync(options.reportPath, "utf8");
  } catch {
    return { ok: false, message: noReportMessage(options, command, result.returncode, result) };
  }
  const report = parseReport(raw);
  if (report === null) {
    return {
      ok: false,
      message:
        `${options.reportPath} is not a readable mutation-testing report. ` +
        "kragg will not report a pass from a report it could not parse.",
    };
  }
  return { ok: true, report, command };
}

/** The output streams a finished command left behind. */
interface CommandStreams {
  readonly stdout: string;
  readonly stderr: string;
}

function noReportMessage(
  options: StrykerRunOptions,
  command: readonly string[],
  returncode: number,
  result: CommandStreams,
): string {
  return (
    `stryker exited ${returncode} without writing ${options.reportPath}, so ` +
    "kragg cannot say whether any mutants survived.\n" +
    `command: ${command.join(" ")}\n` +
    "If this project sets `jsonReporter.fileName` in a JS/MJS/CJS stryker " +
    "config, kragg cannot read it — move that setting to stryker.conf.json, " +
    "or leave it at the default.\n" +
    tail(`${result.stderr}\n${result.stdout}`.trim())
  );
}

/**
 * Whether Stryker is installed in the PROJECT, never on `PATH`.
 *
 * The analogue of `cosmic_ray_available`. A globally-installed Stryker would
 * run against the project's code with its own plugin set and a different
 * major's config schema, and report results that do not reproduce in CI.
 */
export function strykerBin(env: ProjectEnvironment): string | null {
  return resolveBin(env, STRYKER_BIN);
}

/**
 * The exact install command, including the runner plugin.
 *
 * `remediation()` alone would name only `@stryker-mutator/core`, and a Stryker
 * with no test-runner plugin fails at startup complaining about an unknown test
 * runner — sending the reader back for a second round trip. The analogue of
 * Python's `environment.remediation("cosmic_ray")`, extended because the
 * JavaScript side needs two packages rather than one.
 */
export function installMessage(env: ProjectEnvironment): string {
  const runner = detectTestRunner(env.root, "auto").runner;
  const plugin = runner === undefined ? null : RUNNER_PLUGIN[runner];
  const packages =
    plugin === null ? "@stryker-mutator/core" : `@stryker-mutator/core ${plugin}`;
  const lines = [
    `${STRYKER_BIN} is not installed in this project.`,
    "kragg will not fall back to a global stryker: a different version would " +
      "read a different config schema and report results that do not " +
      "reproduce in CI.",
    remediation(env.packageManager, packages),
  ];
  if (runner === "bun") {
    lines.push(
      "Note: Stryker ships no bun-test plugin. Its generic `command` runner " +
        "works but cannot do per-test coverage analysis, so every mutant " +
        "re-runs the whole suite.",
    );
  }
  if (runner === undefined) {
    lines.push(
      "kragg could not detect this project's test runner, so no Stryker runner " +
        "plugin is named above — add the one matching your runner " +
        "(vitest-runner, mocha-runner, jest-runner, tap-runner, …).",
    );
  }
  return lines.join("\n");
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // A report we cannot delete surfaces through the read below; the run still
    // fails loudly if Stryker did not overwrite it.
  }
}

function mkdirQuietly(path: string): void {
  try {
    mkdirSync(path, { recursive: true });
  } catch {
    // Stryker creates it itself; a failure here surfaces as a missing report.
  }
}

/** The LAST lines of a failure: the cause is at the end, not the start. */
function tail(text: string, maxLines = 20): string {
  const lines = text.split("\n");
  return lines.length <= maxLines
    ? text
    : [`… ${lines.length - maxLines} earlier lines`, ...lines.slice(-maxLines)].join("\n");
}

/** A parsed JSON object, before any of its fields have been checked. */
type JsonObject = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
