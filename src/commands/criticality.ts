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

import { join } from "node:path";

import { analysisProgram } from "../analysis/program.ts";
import { EXIT_ENVIRONMENT, EXIT_OK } from "../engine/report.ts";
import {
  analyze,
  criticalityPath,
  formatTable,
  writeJson,
  writeReport,
  writeStamp,
} from "../gates/criticality.ts";
import { DEFAULT_POLICY, loadPolicy } from "../policy/policy.ts";

export interface CriticalityCommandOptions {
  readonly root: string;
  /** Write the report files instead of printing a table. */
  readonly write: boolean;
  readonly log?: ((line: string) => void) | undefined;
  readonly logError?: ((line: string) => void) | undefined;
}

/**
 * Analyze the call graph, then print or persist it.
 *
 * Returns `EXIT_ENVIRONMENT` when the program could not be built — an
 * unusable tsconfig is a broken environment, not a finding, and the exit-code
 * contract keeps those distinguishable without parsing output.
 */
export function runCriticality(options: CriticalityCommandOptions): number {
  const log = options.log ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const logError =
    options.logError ?? ((line: string): void => void process.stderr.write(`${line}\n`));

  const result = analyze({ analysis: analysisProgram({ root: options.root }) });
  if (!result.ok) {
    logError(result.message);
    return EXIT_ENVIRONMENT;
  }

  if (!options.write) {
    for (const line of formatTable(result.profiles)) {
      log(line);
    }
    return EXIT_OK;
  }

  const markdown = join(options.root, "CRITICALITY.md");
  const json = criticalityPath(options.root);
  writeReport(result.profiles, markdown);
  writeJson(result.profiles, json);
  writeStamp(options.root, scanPaths(options.root));
  log(`Wrote ${markdown} and ${json}`);
  return EXIT_OK;
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
