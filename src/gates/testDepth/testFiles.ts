/**
 * The test corpus every test-depth surface reads.
 *
 * `test-quality`, `kragg spec` and `kragg spec`'s property report each used to
 * call `parsedSources(root, policy.testPaths)` directly, which works only
 * while a `test_paths` entry is a DIRECTORY: hand a walk `src/**\/*.test.ts`
 * and it resolves to a directory that does not exist, yields nothing, and the
 * gate reports "no test files found" about a suite the runner is executing.
 *
 * So the corpus is assembled here, once, from the two halves of
 * `util/testPaths.ts` — walk the directories a `test_paths` entry implies,
 * then keep the files that entry actually selects. Both halves are load
 * bearing:
 *
 *  - walking only would put every source file under `src/` into the corpus
 *    when the entry is `src/**\/*.test.ts`. `test-quality` asks whether each
 *    critical function is MENTIONED anywhere in the corpus, so a corpus
 *    containing the sources would answer yes for every function in the
 *    codebase — the check would go quietly vacuous, which is the fail-open
 *    direction;
 *  - filtering only is not possible: a walk needs a directory to start from.
 *
 * A directory entry behaves exactly as it always has — everything under it,
 * `helpers.ts` included. That breadth is deliberate and documented in
 * `gates/testQuality.ts`: a shared helper IS part of the test suite.
 */

import { parsedSources, type ParsedSource, type TypeScriptApi } from "../../analysis/sourceFile.ts";
import { isTestPath, testScanDirectories } from "../../util/testPaths.ts";

/** Every parsed file the policy's `test_paths` selects, in walk order. */
export function parsedTestSources(
  root: string,
  testPaths: readonly string[],
  api: TypeScriptApi,
): readonly ParsedSource[] {
  const sources: ParsedSource[] = [];
  for (const source of parsedSources(root, testScanDirectories(testPaths), { api })) {
    if (isTestPath(source.relative, testPaths)) {
      sources.push(source);
    }
  }
  return sources;
}
