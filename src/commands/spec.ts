/**
 * `kragg spec` — the test suite rendered as documentation.
 *
 * The port of `kragg/src/kragg/spec.py` and its `cmd_spec`. Python's module
 * docstring states the audience outright: "the agent can read the test files
 * directly, so this exists for the human". That is why nothing here is capped
 * the way `check` output is — a reviewer asking what the suite CLAIMS wants
 * the whole claim, and gets it in one screenful-per-file shape instead of
 * twenty-seven file opens.
 *
 * ── WHERE TYPESCRIPT WINS ──────────────────────────────────────────────────
 * `spec.py` has to manufacture prose: it takes `def test_writes_json_atomically`
 * and un-snake-cases it into "writes json atomically", then hunts for a
 * docstring that most tests do not have. JavaScript has no such problem —
 * `it("writes .kragg/map.md atomically")` IS the sentence, written by the
 * author, with punctuation and detail intact, and `describe(...)` supplies the
 * grouping Python can only get from the module split. The output is therefore
 * strictly better than the original's, and it needed no humanising step:
 *
 *     test/istanbul.test.ts
 *       normalizeIstanbul
 *         line rule
 *           - takes the max count over statements starting on a line
 *           - ignores lines no statement starts on  [skip]
 *
 * ── WHAT IS REUSED, DELIBERATELY ───────────────────────────────────────────
 * Test-case detection is `gates/testDepth/testCases.ts` — `findTestCases` for
 * the cases and `calleeChain` for the `describe` blocks. That module already
 * handles vitest, node:test and bun:test, `it.each`, tagged-template each,
 * `it.skipIf`, node:test's `{ skip: true }` options object, and skip
 * inheritance into nested groups. A second detector here would drift from it,
 * and then `kragg spec` and the `test-quality` gate would disagree about how
 * many tests the project has — the kind of contradiction that makes a tool
 * untrustworthy. The only thing this file adds is SUITE STRUCTURE, which the
 * gate has no use for and therefore does not collect.
 *
 * Nesting is computed from LINE SPANS rather than by re-walking the tree:
 * a case belongs to the innermost `describe` whose span contains it. That
 * keeps the two concerns separable — `findTestCases` can flatten however it
 * likes and the tree still comes out right.
 *
 * The second section, property-based coverage, lives in `spec/property.ts`;
 * read its header for the fast-check decision.
 */

import type bundledTs from "typescript";

import {
  resolveTypeScript,
  type ParsedSource,
  type TypeScriptApi,
} from "../analysis/sourceFile.ts";
import { EXIT_OK, EXIT_USAGE } from "../engine/report.ts";
import { calleeChain, findTestCases } from "../gates/testDepth/testCases.ts";
import { parsedTestSources } from "../gates/testDepth/testFiles.ts";
import { loadPolicy, PolicyError, type KraggPolicy } from "../policy/policy.ts";
import { propertyCoverage, type PropertyReport } from "./spec/property.ts";

/** Callee names that open a group in every runner kragg supports. */
const SUITE_HEADS: ReadonlySet<string> = new Set(["describe", "suite"]);

/** One `describe`/`suite` block, located by the lines it spans. */
export interface SpecSuite {
  readonly title: string;
  /** 1-based first line of the call. */
  readonly line: number;
  /** 1-based last line of the call. */
  readonly endLine: number;
}

/** One test case, as the author titled it. */
export interface SpecCase {
  readonly title: string;
  /** 1-based line of the call. */
  readonly line: number;
  /** `it.skip`, `test.todo`, `{ skip: true }`, or inside a skipped group. */
  readonly skipped: boolean;
}

/** The spec extracted from one test file. */
export interface SpecFile {
  /** Repo-relative POSIX path. */
  readonly file: string;
  readonly suites: readonly SpecSuite[];
  readonly cases: readonly SpecCase[];
}

/** Inputs for {@link runSpec}. Everything optional so the CLI can pass a subset. */
export interface SpecOptions {
  /** Project root. Defaults to the current working directory. */
  readonly root?: string | undefined;
  /** Pre-loaded policy. Loaded from the root when absent. */
  readonly policy?: KraggPolicy | undefined;
  /** Compiler to parse with. Defaults to the project's own. */
  readonly api?: TypeScriptApi | undefined;
}

/**
 * Print the spec tree, then the property-based coverage section.
 *
 * Always `0` except on a malformed `kragg.json`. `spec` is a REPORT: a suite
 * with no property tests is a finding, not a failure, and nothing here gates
 * a build.
 */
export async function runSpec(options: SpecOptions = {}): Promise<number> {
  const root = options.root ?? process.cwd();
  let policy: KraggPolicy;
  try {
    policy = options.policy ?? loadPolicy(root);
  } catch (error) {
    if (error instanceof PolicyError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }
  const api = options.api ?? resolveTypeScript(root).api;
  const files = buildSpec(root, policy.testPaths, api);
  const lines = [
    ...renderSpec(files),
    ...renderPropertyReport(
      propertyCoverage({
        root,
        sourcePaths: policy.sourcePaths,
        testPaths: policy.testPaths,
        api,
      }),
      policy.maxViolationsPerGate,
    ),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  return EXIT_OK;
}

/**
 * Extract a spec tree from every test file under the test paths.
 *
 * Files with no detected case are omitted — a helper module living in
 * `test/` is not a spec, and printing its name teaches the reader nothing.
 */
export function buildSpec(
  root: string,
  testPaths: readonly string[],
  api?: TypeScriptApi | undefined,
): readonly SpecFile[] {
  const compiler = api ?? resolveTypeScript(root).api;
  const files: SpecFile[] = [];
  for (const source of parsedTestSources(root, testPaths, compiler)) {
    const spec = fileSpec(source, compiler);
    if (spec !== null) {
      files.push(spec);
    }
  }
  return files;
}

/** Render the spec tree as readable documentation lines. */
export function renderSpec(files: readonly SpecFile[]): string[] {
  if (files.length === 0) {
    return ["no tests found"];
  }
  const total = files.reduce((sum, file) => sum + file.cases.length, 0);
  const skipped = files.reduce(
    (sum, file) => sum + file.cases.filter((entry) => entry.skipped).length,
    0,
  );
  const suffix = skipped === 0 ? "" : ` (${skipped} skipped)`;
  const lines = [`spec: ${total} tests across ${files.length} files${suffix}`];
  for (const file of files) {
    lines.push(file.file);
    lines.push(...renderFile(file));
  }
  return lines;
}

/**
 * Render the property-based coverage section.
 *
 * Three shapes, and the distinction between the first two is the whole point:
 * "unavailable" when fast-check is absent, "no critical functions" when the
 * criticality graph has never been written, and the ranked list otherwise.
 * Neither of the first two is ever printed as `0/N`.
 */
export function renderPropertyReport(report: PropertyReport, cap: number): string[] {
  if (!report.available) {
    return [`property-based coverage: unavailable — ${report.reason}`];
  }
  if (report.rows.length === 0) {
    return [
      "property-based coverage: no critical functions " +
        "(run `kragg criticality --write`)",
    ];
  }
  const covered = report.rows.filter((row) => row.hasPropertyTest).length;
  const lines = [
    `property-based coverage: ${covered}/${report.rows.length} critical functions ` +
      "(property tests kill more mutants than example tests)",
  ];
  const gaps = report.rows.filter((row) => !row.hasPropertyTest);
  for (const row of gaps.slice(0, cap)) {
    lines.push(`  ${row.qualname} (fan-in ${row.fanIn}) — only example-based`);
  }
  if (gaps.length > cap) {
    lines.push(`  +${gaps.length - cap} more, ranked by fan-in`);
  }
  return lines;
}

/* --- Extraction ----------------------------------------------------------- */

function fileSpec(source: ParsedSource, api: TypeScriptApi): SpecFile | null {
  const cases = findTestCases(source.sourceFile, api).map((found) => ({
    title: found.title,
    line: found.line,
    skipped: found.skipped,
  }));
  if (cases.length === 0) {
    return null;
  }
  return { file: source.relative, suites: findSuites(source.sourceFile, api), cases };
}

/**
 * Every `describe`/`suite` call in a file, with the lines it spans.
 *
 * Detection is by callee NAME through `calleeChain`, exactly as
 * `testCases.ts` detects cases — all three supported runners expose
 * `describe` as a global, so requiring a resolved import would silently show
 * an empty tree for a large share of real projects.
 */
export function findSuites(
  sourceFile: bundledTs.SourceFile,
  api: TypeScriptApi,
): readonly SpecSuite[] {
  const suites: SpecSuite[] = [];
  const visit = (node: bundledTs.Node): void => {
    if (api.isCallExpression(node)) {
      const chain = calleeChain(node.expression, api);
      if (chain !== null && SUITE_HEADS.has(chain.head)) {
        const title = firstStringArgument(node, api);
        if (title !== null) {
          suites.push({
            title,
            line: lineOf(sourceFile, node.getStart(sourceFile)),
            endLine: lineOf(sourceFile, node.getEnd()),
          });
        }
      }
    }
    api.forEachChild(node, visit);
  };
  api.forEachChild(sourceFile, visit);
  return suites;
}

function firstStringArgument(
  node: bundledTs.CallExpression,
  api: TypeScriptApi,
): string | null {
  const first = node.arguments[0];
  if (first === undefined || !api.isStringLiteralLike(first)) {
    return null;
  }
  return first.text;
}

function lineOf(sourceFile: bundledTs.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

/* --- Rendering ------------------------------------------------------------ */

/** One entry in the flattened, line-ordered render of a file. */
interface RenderEntry {
  readonly line: number;
  readonly depth: number;
  readonly text: string;
  /** Suites sort before cases that open on the same line. */
  readonly isSuite: boolean;
}

/**
 * Flatten a file's suites and cases into indented lines, in source order.
 *
 * Nesting comes from line-span containment rather than from the AST, so a
 * `describe` opened inside a loop or a helper still groups the cases that
 * physically sit inside it — which is what a reader sees, and therefore what
 * a document of the suite should say.
 *
 * Suites holding no case are dropped. A `describe` whose contents are all in
 * another file, or which only sets up fixtures, is a heading over nothing.
 */
function renderFile(file: SpecFile): string[] {
  const kept = file.suites.filter((suite) =>
    file.cases.some((entry) => contains(suite, entry.line)),
  );
  const entries: RenderEntry[] = [
    ...kept.map((suite, index) => ({
      line: suite.line,
      depth: suiteDepth(kept, index),
      text: suite.title,
      isSuite: true,
    })),
    ...file.cases.map((entry) => ({
      line: entry.line,
      depth: caseDepth(kept, entry.line),
      text: `- ${entry.title}${entry.skipped ? "  [skip]" : ""}`,
      isSuite: false,
    })),
  ];
  entries.sort(byPosition);
  return entries.map((entry) => `${"  ".repeat(entry.depth + 1)}${entry.text}`);
}

function byPosition(left: RenderEntry, right: RenderEntry): number {
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  if (left.isSuite !== right.isSuite) {
    return left.isSuite ? -1 : 1;
  }
  return left.depth - right.depth;
}

/** How many kept suites enclose a case's opening line. */
function caseDepth(suites: readonly SpecSuite[], line: number): number {
  return suites.filter((suite) => contains(suite, line)).length;
}

/**
 * How many OTHER kept suites enclose this one.
 *
 * Identity is by index rather than by value: two sibling `describe("cases")`
 * blocks with the same title are genuinely distinct, and comparing titles
 * would collapse them into one level.
 */
function suiteDepth(suites: readonly SpecSuite[], index: number): number {
  const self = suites[index];
  if (self === undefined) {
    return 0;
  }
  return suites.filter(
    (other, position) => position !== index && contains(other, self.line),
  ).length;
}

function contains(suite: SpecSuite, line: number): boolean {
  return line >= suite.line && line <= suite.endLine;
}
