/**
 * The type-check gate's adapter — kragg-ts's answer to Python's mypy gate.
 *
 * The direct analogue of `_project_tool_gate("mypy", env, ...)`: Python runs
 * mypy on the PROJECT's interpreter, never on kragg's, because a type checker
 * reads the project's config and the project's installed stubs and gives a
 * confidently wrong answer when it reads someone else's. The same rule, one
 * ecosystem over: `tsc` comes from the project's `node_modules/.bin` via
 * `resolveBin`, never from `PATH`, never from a global install, and NEVER from
 * the `typescript` that kragg itself depends on. A project pinned to TS 5.4
 * type-checked by kragg's TS 6 reports errors that do not exist in its CI, and
 * misses ones that do.
 *
 * ── WHERE THE OUTPUT IS PARSED ─────────────────────────────────────────────
 * In `support/tscOutput.ts`, not here. `tsc` has no machine-readable
 * diagnostic output, so the gate reads `--pretty false` text — and the whole
 * of that reasoning (the two-line `formatDiagnostic` the format is read off,
 * the 1-based line and column, the optional file prefix, and why a
 * `DiagnosticMessageChain` is ONE violation rather than four) lives on that
 * module, next to the regex it justifies.
 *
 * The seam is text-in/violations-out: `tscOutput.ts` touches no process, no
 * filesystem and no environment, while this file keeps everything about
 * RUNNING the compiler and deciding whether its exit status can be believed.
 * `parseTscOutput` is re-exported below, so importers still see one adapter.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { commandOutput, type CompletedCommand, type Violation } from "../engine/models.ts";
import { runCommand } from "../engine/runner.ts";
import {
  missingTool,
  missingToolMessage,
  resolveBin,
  type ProjectEnvironment,
} from "../environment/project.ts";
import { toPosix } from "./linters/json.ts";
import { parseTscOutput } from "./support/tscOutput.ts";

export { parseTscOutput } from "./support/tscOutput.ts";

/** `node_modules/.bin` entry, and the package that provides it. */
const TSC_BIN = "tsc";
const TSC_PACKAGE = "typescript";

/** Default project file, matching `tsc`'s own default. */
export const DEFAULT_PROJECT = "tsconfig.json";

/**
 * TS codes that mean THE PROJECT COULD NOT BE CONFIGURED, not that it has type
 * errors.
 *
 * Every code here was read out of the diagnostic table in
 * `node_modules/typescript/lib/typescript.js`; none is guessed:
 *
 *   5023 Unknown compiler option '{0}'.
 *   5024 Compiler option '{0}' requires a value of type {1}.
 *   5025 Unknown compiler option '{0}'. Did you mean '{1}'?
 *   5057 Cannot find a tsconfig.json file at the specified directory: '{0}'.
 *   5058 The specified path does not exist: '{0}'.
 *   5081 Cannot find a tsconfig.json file at the current directory: {0}.
 *   5083 Cannot read file '{0}'.
 *  18000 Circularity detected while resolving configuration: {0}
 *  18002 The 'files' list in config file '{0}' is empty.
 *  18003 No inputs were found in config file '{0}'. ...
 *
 * 18002/18003 are the quiet ones and the reason this set exists at all. A
 * tsconfig whose `include` matches nothing produces ZERO type errors and exits
 * non-zero, and a gate that only counted violations would read that as "no
 * findings" — a green type-check gate over a project that was never checked.
 * That is the exact fail-open shape kragg is built to refuse.
 */
export const CONFIG_ERROR_CODES: ReadonlySet<string> = new Set([
  "TS5023",
  "TS5024",
  "TS5025",
  "TS5057",
  "TS5058",
  "TS5081",
  "TS5083",
  "TS18000",
  "TS18002",
  "TS18003",
]);

/**
 * `tsc` exit statuses that mean the project itself is unusable.
 *
 * From `ExitStatus` in the compiler: 3 is `InvalidProject_OutputsSkipped` and
 * 4 is `ProjectReferenceCycle_OutputsSkipped`. 1 and 2 both mean "diagnostics
 * present" and are the ordinary found-type-errors path.
 */
const INVALID_PROJECT_STATUSES: readonly number[] = [3, 4];

export interface TypeCheckOptions {
  /** Resolved target project. `tsc` comes from ITS `node_modules/.bin`. */
  readonly env: ProjectEnvironment;
  /** tsconfig to check, relative to the root. Defaults to `tsconfig.json`. */
  readonly project?: string | undefined;
  /**
   * Put diagnostics in these files FIRST in the report — the `--changed`
   * path.
   *
   * An order, never a filter and never a narrower invocation; see
   * `orderByPaths` for why either of those would hide the errors a change
   * introduces.
   */
  readonly paths?: readonly string[] | undefined;
  /** Passed through to `runCommand`. */
  readonly timeoutMs?: number | undefined;
}

/**
 * Either the findings, or the reason the checker could not run.
 *
 * No `"skipped"` arm, unlike the lint gate. A TypeScript project with no
 * TypeScript compiler is not an unconfigured gate that should step aside — it
 * is a broken environment, and it gets exit 3 and an install command.
 */
export type TypeCheckOutcome =
  | {
      readonly ok: true;
      readonly command: readonly string[];
      readonly violations: readonly Violation[];
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly command?: readonly string[] | undefined;
    };

/**
 * Put the diagnostics a change is most likely to explain first — the
 * `--changed` path.
 *
 * WHY THIS IS AN ORDER AND NOT A NARROWER INVOCATION. A linter is per-file,
 * so `--changed` can hand it a shorter list and get the same answer faster. A
 * TYPE CHECKER IS NOT. Two things break if the invocation is narrowed:
 *
 *  1. `tsc a.ts b.ts` IGNORES tsconfig.json ENTIRELY. Passing files on the
 *     command line switches the compiler out of project mode, so `strict`,
 *     `paths`, `lib`, `types` and every other option silently revert to
 *     defaults. The gate would still exit 0 and would still look like it ran —
 *     while checking the project under rules the project never chose. That is
 *     a green gate over an unchecked codebase, the failure mode this whole
 *     codebase is shaped to refuse.
 *  2. Even with the config forced back on, a program is a WHOLE-PROGRAM fact.
 *     Changing a type in `a.ts` produces the error in `b.ts`, which did not
 *     change. Type-checking only the changed files would miss precisely the
 *     errors a change introduces.
 *
 * WHY IT IS NOT A FILTER EITHER. This used to be one: the whole program was
 * checked and every diagnostic outside the changed set was dropped — which,
 * by point 2's own argument, dropped exactly the error in `b.ts` that the
 * edit to `a.ts` caused. The gate then reported `[PASS] tsc` for a change
 * that broke its callers, while `tsc -p tsconfig.json` was failing. So
 * nothing is dropped: the whole-project verdict is the verdict, and every
 * diagnostic counts toward it. The report's dedupe and per-gate cap handle
 * volume; this function decides what the cap keeps.
 *
 * THREE GROUPS, each in the compiler's own order (file, then position):
 *
 *  1. diagnostics with NO FILE — facts about the project rather than about
 *     any one file (a missing global type, a config-level notice); few, and
 *     the ones that explain everything below them, so they are never pushed
 *     past the cap by per-file errors;
 *  2. diagnostics IN the changed set — what the edit most likely caused where
 *     the reader is already looking;
 *  3. everything else — the errors the edit caused ELSEWHERE, the case the
 *     filter used to hide.
 *
 * With no paths the list is returned as it came.
 */
export function orderByPaths(
  violations: readonly Violation[],
  root: string,
  paths: readonly string[],
): readonly Violation[] {
  if (paths.length === 0) {
    return violations;
  }
  const wanted = new Set(paths.map((path) => normalize(path, root)));
  const group = (item: Violation): number => {
    if (item.file === undefined) {
      return 0;
    }
    return wanted.has(normalize(item.file, root)) ? 1 : 2;
  };
  // `sort` is stable, so within a group the compiler's order survives.
  return [...violations].sort((left, right) => group(left) - group(right));
}

/** A path as a root-relative posix string, for set comparison. */
function normalize(path: string, root: string): string {
  const relativePath = isAbsolute(path) ? relative(root, path) : path;
  return toPosix(relativePath).replace(/^\.\//, "");
}

/**
 * Run the project's `tsc --noEmit` and return violations or a reason.
 *
 * FOUR OUTCOMES, kept distinct because they have different fixes:
 *
 *  1. No tsconfig -> error, checked on disk BEFORE spawning anything. `tsc`
 *     would report this itself as TS5058, but checking first produces a
 *     message that names the file we looked for instead of a compiler code.
 *  2. `tsc` not installed -> error with the install command, from
 *     `missingToolMessage`. Never a fall back to kragg's own compiler.
 *  3. Type errors found -> violations, gate failure, exit 1.
 *  4. `tsc` crashed, or the project is invalid -> error, exit 3. Detected
 *     three ways: an `ExitStatus` in `INVALID_PROJECT_STATUSES`, any
 *     diagnostic in `CONFIG_ERROR_CODES`, or a non-zero exit that produced no
 *     parseable diagnostics at all (an out-of-memory kill, a panic, a
 *     `--pretty` we failed to suppress).
 */
export async function runTypeCheck(options: TypeCheckOptions): Promise<TypeCheckOutcome> {
  const { env } = options;
  const project = options.project ?? DEFAULT_PROJECT;
  const compiler = resolveCompiler(env, project);
  if (!compiler.ok) {
    return { ok: false, message: compiler.message };
  }

  // `--pretty false` as two argv entries: the compiler's boolean option parser
  // consumes a following literal "true"/"false" (verified in
  // `parseCommandLineWorker`), and being explicit means the result does not
  // depend on whether a TTY was inherited.
  const command = [compiler.bin, "--noEmit", "--pretty", "false", "--project", project];
  const result = await runCommand(
    "tsc",
    command,
    env.root,
    options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
  );
  return interpretRun({ env, project, command, result, paths: options.paths });
}

/** `tsc`'s path, or the environment problem that means there is not one. */
type CompilerLookup =
  | { readonly ok: true; readonly bin: string }
  | { readonly ok: false; readonly message: string };

/**
 * Outcomes 1 and 2: the two things checked BEFORE anything is spawned.
 *
 * The tsconfig is looked for on disk even though `tsc` would report its
 * absence itself as TS5058, because the message here can name the file we
 * looked for instead of handing back a compiler code.
 */
function resolveCompiler(env: ProjectEnvironment, project: string): CompilerLookup {
  const projectPath = join(env.root, project);
  if (!existsSync(projectPath)) {
    return {
      ok: false,
      message:
        `no ${project} found at ${projectPath}.\n` +
        "kragg type-checks through the project's own tsconfig; without one there " +
        "is no configuration to check against, and checking with defaults would " +
        "report against rules this project never chose.\n" +
        `Fix: create ${project}, or point the gate at the right one.`,
    };
  }
  const bin = resolveBin(env, TSC_BIN);
  return bin === null
    ? { ok: false, message: missingToolMessage(env, TSC_BIN, TSC_PACKAGE) }
    : { ok: true, bin };
}

/** One completed `tsc` invocation, with everything needed to judge it. */
interface TypeCheckRun {
  readonly env: ProjectEnvironment;
  readonly project: string;
  readonly command: readonly string[];
  readonly result: CompletedCommand;
  readonly paths?: readonly string[] | undefined;
}

/**
 * Outcomes 3 and 4: violations, or a compiler that could not be believed.
 *
 * Split from `runTypeCheck` because it is the half with no I/O: given a
 * `CompletedCommand`, whether this run is a gate failure or an environment
 * error is a pure function, and that is what makes it testable against
 * recorded compiler output.
 */
function interpretRun(run: TypeCheckRun): TypeCheckOutcome {
  const { command, result } = run;
  if (missingTool(result) !== null) {
    return { ok: false, message: missingToolMessage(run.env, TSC_BIN, TSC_PACKAGE), command };
  }
  const all = parseTscOutput(result.stdout, run.env.root);
  const unusable = unusableProject(run, all);
  if (unusable !== null) {
    return { ok: false, message: unusable, command };
  }
  return { ok: true, command, violations: orderByPaths(all, run.env.root, run.paths ?? []) };
}

/**
 * Why this run says nothing about the code, or `null` when it does say
 * something. The three spellings of outcome 4, in the order they are cheapest
 * to be sure about.
 */
function unusableProject(run: TypeCheckRun, all: readonly Violation[]): string | null {
  const configErrors = all.filter((item) => isConfigError(item.code));
  if (configErrors.length > 0) {
    return configErrorMessage(run.project, configErrors);
  }
  const { result } = run;
  if (INVALID_PROJECT_STATUSES.includes(result.returncode)) {
    return (
      `tsc exited ${result.returncode} (invalid project or project-reference ` +
      `cycle).\n${trim(result)}`
    );
  }
  if (result.returncode !== 0 && all.length === 0) {
    return (
      `tsc exited ${result.returncode} but produced no parseable diagnostics, so ` +
      `the failure is the compiler's and not the code's.\n${trim(result)}`
    );
  }
  return null;
}

function isConfigError(code: string | undefined): boolean {
  return code !== undefined && CONFIG_ERROR_CODES.has(code);
}

function configErrorMessage(project: string, errors: readonly Violation[]): string {
  const lines = errors.map((item) => `  ${item.code ?? "TS?"}: ${item.message}`);
  return (
    `tsc could not use ${project}; the type-check gate did not run.\n` +
    `${lines.join("\n")}\n` +
    "Fix the tsconfig — a type check that never looked at your source would " +
    "otherwise report as passing."
  );
}

/**
 * BOTH streams, capped so a report stays readable.
 *
 * Both, not "whichever is non-empty": `tsc` writes its diagnostics to STDOUT
 * (`sys.write`), and when a process dies with an empty stderr `runner.ts`
 * substitutes execFile's own `"Command failed: …"` message there. Preferring
 * stderr would therefore report that placeholder and DROP the real cause —
 * `FATAL ERROR: JavaScript heap out of memory` lands on stdout — leaving a
 * user with a message that names the command and nothing about why it died.
 */
function trim(result: CompletedCommand): string {
  const text = commandOutput(result);
  return text.length > 4000 ? `${text.slice(0, 4000)}\n… (output truncated)` : text;
}
