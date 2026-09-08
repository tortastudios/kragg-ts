/**
 * `kragg criticality` — call-graph risk analysis.
 *
 * Port of `cmd_criticality` in `crag/src/kragg/commands.py`. Without
 * `--write` it prints a table; with it, writes `CRITICALITY.md` for humans and
 * `.kragg/criticality.json` for the gates that key off it
 * (`critical-tests`, `critical-coverage`) and for `brief`/`coverage` ranking.
 *
 * Those gates SKIP VISIBLY when the JSON is absent or STALE rather than
 * passing silently, so this command is the documented remedy printed in their
 * skip reason — keep the two in sync.
 *
 * `--write` also writes `.kragg/criticality.stamp.json`, which records the
 * tree the data was derived from. Without it the file it just wrote would read
 * as unverifiable and the next `check` would derive it all over again; see
 * `gates/criticality/freshness.ts`. The stamp's paths come from the POLICY
 * rather than from a caller, because the gates that later judge freshness read
 * the same policy, and two answers to "which files does this depend on" is one
 * too many.
 */

import { isAbsolute, join, relative, resolve } from "node:path";

import type bundledTs from "typescript";

import { analysisProgram, programSourceFiles } from "../analysis/program.ts";
import type { AnalysisProgram } from "../analysis/program.ts";
import { EXIT_ENVIRONMENT, EXIT_OK, EXIT_USAGE } from "../engine/report.ts";
import {
  analyze,
  criticalityPath,
  formatTable,
  writeJson,
  writeReport,
  writeStamp,
} from "../gates/criticality.ts";
import type { FunctionProfile } from "../gates/criticality.ts";
import { DEFAULT_POLICY, loadPolicy } from "../policy/policy.ts";

export interface CriticalityCommandOptions {
  readonly root: string;
  /** Write the report files instead of printing a table. */
  readonly write: boolean;
  /**
   * `--path`: analyze only the files under these paths. Empty means the whole
   * program, which is what every caller but the CLI wants.
   */
  readonly paths?: readonly string[] | undefined;
  readonly log?: ((line: string) => void) | undefined;
  readonly logError?: ((line: string) => void) | undefined;
}

/**
 * Analyze the call graph, then print or persist it.
 *
 * Returns `EXIT_ENVIRONMENT` when the program could not be built — an
 * unusable tsconfig is a broken environment, not a finding, and the exit-code
 * contract keeps those distinguishable without parsing output — and
 * `EXIT_USAGE` when `--path` names nothing the program contains, because that
 * is a command line to fix and not a project to fix.
 */
export function runCriticality(options: CriticalityCommandOptions): number {
  const log = options.log ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const logError =
    options.logError ?? ((line: string): void => void process.stderr.write(`${line}\n`));

  const paths = options.paths ?? [];
  if (options.write && paths.length > 0) {
    logError(scopedWriteRefusal());
    return EXIT_USAGE;
  }
  const result = analyzeScoped(options.root, paths);
  if (!result.ok) {
    logError(result.message);
    return result.code;
  }
  if (options.write) {
    return writeAll(options.root, result.profiles, log);
  }
  for (const line of formatTable(result.profiles)) {
    log(line);
  }
  return EXIT_OK;
}

/** The profiles, or the message and exit code that replace them. */
type ScopedAnalysis =
  | { readonly ok: true; readonly profiles: readonly FunctionProfile[] }
  | { readonly ok: false; readonly message: string; readonly code: number };

/** Build the program once, narrow it to `paths`, and analyze what is left. */
function analyzeScoped(root: string, paths: readonly string[]): ScopedAnalysis {
  const analysis = analysisProgram({ root });
  const scoped = scopeFiles(analysis, root, paths);
  if (scoped !== null && !scoped.ok) {
    return scoped;
  }
  const result = analyze({ analysis, ...(scoped === null ? {} : { files: scoped.files }) });
  return result.ok
    ? { ok: true, profiles: result.profiles }
    : { ok: false, message: result.message, code: EXIT_ENVIRONMENT };
}

/**
 * Why `--write` and `--path` cannot be combined.
 *
 * NOT A TASTE JUDGEMENT — it is the fail-closed rule. `.kragg/criticality.json`
 * is read by `critical-tests` and `critical-coverage` as THE list of critical
 * functions, so a file describing one subtree does not read as "partial data",
 * it reads as "every other function in this repo is uncritical" and those
 * gates go quiet about all of them. The freshness stamp cannot save it either:
 * a stamp left over from an earlier full write still validates a tree nobody
 * touched in between, so the partial file would be trusted outright. Printing
 * the scoped table asks nothing of anyone; persisting it silently weakens two
 * gates. (This diverges from Python's `cmd_criticality`, which writes whatever
 * `--path` produced — see docs/spec-conformance.md.)
 */
function scopedWriteRefusal(): string {
  return (
    "--write cannot be combined with --path: the written .kragg/criticality.json " +
    "is the whole project's critical set, and a scoped one would make every " +
    "function outside --path look uncritical to `critical-tests` and " +
    "`critical-coverage`. Drop --write for the scoped table, or --path to " +
    "write the full report."
  );
}

/** Persist the analysis and stamp the tree it was derived from. */
function writeAll(
  root: string,
  profiles: readonly FunctionProfile[],
  log: (line: string) => void,
): number {
  const markdown = join(root, "CRITICALITY.md");
  const json = criticalityPath(root);
  writeReport(profiles, markdown);
  writeJson(profiles, json);
  writeStamp(root, scanPaths(root));
  log(`Wrote ${markdown} and ${json}`);
  return EXIT_OK;
}

/** What `--path` narrowed the program to: `null` when it narrowed nothing. */
type ScopedFiles =
  | { readonly ok: true; readonly files: readonly bundledTs.SourceFile[] }
  | { readonly ok: false; readonly message: string; readonly code: number };

/**
 * Resolve `--path` against the program's own source files.
 *
 * Python's `--path` replaces `source_paths[0]` as the directory it parses;
 * here the program is already the whole project, so the equivalent is to
 * narrow the file list `buildCallGraph` walks. A path that matches nothing is
 * reported rather than analyzed: an empty graph prints an empty table and
 * exits 0, which reads exactly like "this code has no risk".
 */
function scopeFiles(
  analysis: AnalysisProgram,
  root: string,
  paths: readonly string[],
): ScopedFiles | null {
  if (paths.length === 0) {
    return null;
  }
  const loaded = analysis.load();
  if (!loaded.ok) {
    return { ok: false, message: loaded.message, code: EXIT_ENVIRONMENT };
  }
  const files = programSourceFiles(loaded.program).filter((file) =>
    paths.some((path) => contains(resolve(root, path), file.fileName)),
  );
  if (files.length === 0) {
    return {
      ok: false,
      message: `--path matched no analyzed source file: ${paths.join(", ")}`,
      code: EXIT_USAGE,
    };
  }
  return { ok: true, files };
}

/** Is `file` the path `directory` names, or somewhere beneath it? */
function contains(directory: string, file: string): boolean {
  const rel = relative(directory, resolve(file));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The paths the freshness stamp should watch: the policy's sources AND tests.
 *
 * Both are in the program, so both contribute call-graph nodes and an edit to
 * either can change the answer. A policy that will not load falls back to the
 * defaults rather than failing the command: an unstampable write is still a
 * correct write, and the only cost of watching the wrong paths is that the
 * next `check` re-derives.
 */
function scanPaths(root: string): readonly string[] {
  try {
    const policy = loadPolicy(root);
    return [...policy.sourcePaths, ...policy.testPaths];
  } catch {
    return [...DEFAULT_POLICY.sourcePaths, ...DEFAULT_POLICY.testPaths];
  }
}
