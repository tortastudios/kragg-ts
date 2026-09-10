/**
 * Deciding which test runner a project uses.
 *
 * There is no manifest field that names a JavaScript project's test runner, so
 * this is inference — and inference that guesses WRONG is worse than
 * inference that gives up, because running the wrong runner reports a project
 * as broken when it is fine. Every rule below is therefore evidence-based and
 * ordered by how directly the evidence states intent, and the fall-through is a
 * visible skip rather than a default.
 *
 * ── PRECEDENCE, highest first ──────────────────────────────────────────────
 *
 *  1. **Policy.** `test_runner` in `kragg.json`, when it is not `"auto"`.
 *     An explicit instruction outranks every inference, and `"off"` is an
 *     explicit instruction to skip. This mirrors `KRAGG_PACKAGE_MANAGER` in
 *     `environment/project.ts`: an override that inference can quietly
 *     override is not an override.
 *
 *  2. **`package.json#scripts.test`.** The strongest inference available,
 *     because it is not evidence ABOUT the project — it is the command the
 *     project actually runs. A repo with vitest in `devDependencies` and
 *     `node --test` in its test script runs node, and the script is the only
 *     signal that says so. The FIRST recognised runner token wins, so
 *     `"tsc --noEmit && vitest run"` resolves to vitest rather than to the
 *     build step in front of it.
 *
 *  3. **A vitest config file.** `vitest.config.*` or `vitest.workspace.*`.
 *     Deliberate, vitest-specific, and present only when someone configured
 *     vitest. `vite.config.*` is NOT consulted: a `test` block inside it is
 *     common, but detecting it needs the file evaluated, and config is data
 *     here, never code (`src/policy/policy.ts`).
 *
 *  4. **A `vitest` dependency** in `dependencies` or `devDependencies`.
 *     Weaker than a config file — a package can be installed and unused —
 *     but it is unambiguous about WHICH runner.
 *
 *  5. **Bun evidence:** `bunfig.toml`, or `@types/bun` / `bun-types` in the
 *     manifest. Last because bun's presence often means "bun is the package
 *     manager", which says nothing about the test runner.
 *
 *  6. **Nothing.** A visible skip naming the install commands. NOT a default
 *     to `node --test`: it needs no dependency, so "no evidence" is
 *     indistinguishable from "no tests", and a runner that finds no test files
 *     reports a failure the project cannot act on.
 *
 * jest, mocha, ava and tap are recognised only well enough to say "kragg does
 * not support this yet" instead of skipping with a misleading "no test runner
 * found".
 */

import { join } from "node:path";

import { fileExists, readJsonFile } from "./manifest.ts";
import { asObject, asString, isJsonObject, prop } from "./json.ts";

/** Runners kragg can drive. */
export type TestRunnerName = "vitest" | "node" | "bun";

/** The `test_runner` policy setting. `"off"` is a deliberate skip. */
export type TestRunnerChoice = "auto" | TestRunnerName | "off";

/** Every valid `test_runner` value, for validating untrusted policy input. */
export const TEST_RUNNER_CHOICES: readonly TestRunnerChoice[] = [
  "auto",
  "vitest",
  "node",
  "bun",
  "off",
];

/** Narrow an arbitrary value to a `TestRunnerChoice`, or `undefined`. */
export function toTestRunnerChoice(value: unknown): TestRunnerChoice | undefined {
  return TEST_RUNNER_CHOICES.find((choice) => choice === value);
}

/** What detection concluded, and what convinced it. */
export interface RunnerDetection {
  /** `undefined` when nothing decided, or when the policy said `"off"`. */
  readonly runner: TestRunnerName | undefined;
  /** Human-readable provenance, e.g. `package.json#scripts.test`. */
  readonly source: string;
  /**
   * A runner kragg recognised but cannot drive (jest, mocha, …). Present so
   * the skip message can say "not supported yet" rather than "not found",
   * which would send someone to install a runner they already have.
   */
  readonly unsupported?: string | undefined;
  /**
   * The `package.json#scripts.test` text, verbatim, when that is what decided.
   *
   * Carried so the report can print it NEXT TO the argv kragg built, because
   * the two are not the same command and reading detection as if they were is
   * the mistake this field exists to prevent: a script of
   * `node --import tsx --test "src/**\/*.test.ts"` tells kragg "the runner is
   * node" and nothing else — not the loader, not the setup file, not the file
   * selection. kragg re-derives all of that from policy, and a reader has to
   * be able to see the difference. `test_command` is how a project stops
   * kragg re-deriving it.
   */
  readonly script?: string | undefined;
}

/** One recognised runner spelling, and the runner it names. */
type ScriptToken = readonly [pattern: RegExp, runner: TestRunnerName];

/** One recognised-but-undriveable runner spelling, and its display name. */
type UnsupportedToken = readonly [pattern: RegExp, name: string];

/** Runner tokens as they appear in a `test` script, longest match first. */
const SCRIPT_TOKENS: readonly ScriptToken[] = [
  [/\bvitest\b/u, "vitest"],
  [/\bbun\s+(?:--\S+\s+)*test\b/u, "bun"],
  [/\bnode\b[^&|;]*--test\b/u, "node"],
  [/\bnode:test\b/u, "node"],
];

/** Runners kragg recognises but does not drive. */
const UNSUPPORTED_TOKENS: readonly UnsupportedToken[] = [
  [/\bjest\b/u, "jest"],
  [/\bmocha\b/u, "mocha"],
  [/\bava\b/u, "ava"],
  [/\btap\b/u, "tap"],
  [/\bjasmine\b/u, "jasmine"],
];

/** vitest config filenames, all extensions vitest itself accepts. */
const VITEST_CONFIGS: readonly string[] = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.cts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.cjs",
  "vitest.workspace.ts",
  "vitest.workspace.js",
  "vitest.workspace.json",
  "vitest.config.json",
];

/** Resolve the runner for `root` under `choice`. See the module docs. */
export function detectTestRunner(root: string, choice: TestRunnerChoice): RunnerDetection {
  if (choice === "off") {
    return { runner: undefined, source: "policy: test_runner = \"off\"" };
  }
  if (choice !== "auto") {
    return { runner: choice, source: `policy: test_runner = "${choice}"` };
  }

  const manifest = readJsonFile(join(root, "package.json"));
  const fromScript = detectFromScript(manifest);
  if (fromScript !== undefined) {
    return fromScript;
  }
  const configFile = VITEST_CONFIGS.find((name) => fileExists(join(root, name)));
  if (configFile !== undefined) {
    return { runner: "vitest", source: configFile };
  }
  if (hasDependency(manifest, "vitest")) {
    return { runner: "vitest", source: "package.json dependency: vitest" };
  }
  if (fileExists(join(root, "bunfig.toml"))) {
    return { runner: "bun", source: "bunfig.toml" };
  }
  for (const name of ["@types/bun", "bun-types"]) {
    if (hasDependency(manifest, name)) {
      return { runner: "bun", source: `package.json dependency: ${name}` };
    }
  }
  return { runner: undefined, source: "no test runner detected" };
}

/** The `test` script's first recognised runner token. */
function detectFromScript(manifest: ReturnType<typeof readJsonFile>): RunnerDetection | undefined {
  if (manifest === undefined) {
    return undefined;
  }
  const scripts = asObject(manifest, "scripts");
  const script = scripts === undefined ? undefined : asString(scripts, "test");
  if (script === undefined || script.trim() === "") {
    return undefined;
  }

  const best = earliestMatch(script, SCRIPT_TOKENS);
  const unsupported = earliestMatch(script, UNSUPPORTED_TOKENS);
  if (best !== undefined && (unsupported === undefined || best.index <= unsupported.index)) {
    return { runner: best.value, source: "package.json#scripts.test", script };
  }
  if (unsupported !== undefined) {
    return {
      runner: undefined,
      source: "package.json#scripts.test",
      unsupported: unsupported.value,
      script,
    };
  }
  return undefined;
}

/** Where a token matched, and what it stands for. */
interface TokenMatch<T> {
  /** Offset of the match in the script, which is what decides precedence. */
  readonly index: number;
  readonly value: T;
}

/** The match occurring earliest in `text`, so command order decides. */
function earliestMatch<T>(
  text: string,
  table: readonly (readonly [RegExp, T])[],
): TokenMatch<T> | undefined {
  let best: TokenMatch<T> | undefined;
  for (const [pattern, value] of table) {
    const index = text.search(pattern);
    if (index >= 0 && (best === undefined || index < best.index)) {
      best = { index, value };
    }
  }
  return best;
}

/** Is `name` declared in `dependencies` or `devDependencies`? */
function hasDependency(manifest: ReturnType<typeof readJsonFile>, name: string): boolean {
  if (manifest === undefined) {
    return false;
  }
  for (const field of ["dependencies", "devDependencies"]) {
    const table = prop(manifest, field);
    if (isJsonObject(table) && Object.hasOwn(table, name)) {
      return true;
    }
  }
  return false;
}
