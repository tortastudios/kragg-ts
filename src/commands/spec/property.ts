/**
 * Property-based coverage of critical functions — the fast-check analogue of
 * `spec.py`'s `property_coverage`.
 *
 * ── THE PYTHON SIGNAL, AND WHY IT PORTS AT ALL ─────────────────────────────
 * `spec.py` asks one question per public critical function: does ANY test
 * exercise it with Hypothesis (`@given`), or only with hand-picked examples?
 * The claim behind it is in kragg's README under "Test depth": property tests
 * kill more mutants than example tests, so a high-fan-in function defended
 * only by examples is a soft spot that a green suite hides. That claim is
 * about generative testing, not about Python, so it ports.
 *
 * ── WHY fast-check, AND WHY IT IS NOT BUNDLED ──────────────────────────────
 * fast-check is the JavaScript ecosystem's Hypothesis: the same shrinking
 * generative model, and the one library the vitest/node:test/bun world has
 * actually standardised on (`@fast-check/vitest` binds it as `test.prop`).
 * Nothing else is close enough to be worth detecting.
 *
 * kragg-ts does NOT depend on it and must not. kragg has exactly two
 * dependencies — `typescript` and `@types/node` — and the point of a
 * guardrails tool is that installing it does not reshape the project's
 * dependency tree. More directly: kragg does not RUN property tests, it
 * observes whether the project writes them. An observer that installs the
 * thing it observes has made the measurement meaningless.
 *
 * ── THE FAILURE MODE THIS EXISTS TO AVOID ──────────────────────────────────
 * The tempting implementation reports `0/41 critical functions` on a project
 * without fast-check. That number is a LIE OF THE MOST EXPENSIVE KIND: it
 * looks like a measurement, it looks terrible, and it is unactionable, so the
 * whole section gets ignored — and with it the real finding on projects that
 * DO use fast-check. So absence of the library is reported as UNAVAILABLE,
 * with the one-line remedy, and never as a zero. "We did not measure" and
 * "we measured zero" are different facts and are printed differently. The
 * union returned by {@link propertyCoverage} makes conflating them impossible.
 *
 * ── HOW A PROPERTY TEST IS RECOGNISED ──────────────────────────────────────
 * Two idioms, because the ecosystem has two:
 *  - `fc.assert(fc.property(...))` — the library's own runner, called from
 *    inside an ordinary `it`/`test` body;
 *  - `test.prop([...])("name", fn)` — the `@fast-check/vitest` binding, where
 *    the arbitraries sit on the CALLEE and never appear in the body.
 *
 * Both are found through `calleeChain`, the same unwrapper `testCases.ts` uses
 * for `it.each`, so every chained modifier (`test.prop([...]).only`) is seen
 * and nothing about test detection is reimplemented here.
 *
 * ── WHAT THE SIGNAL PROVES, AND WHAT IT DOES NOT ───────────────────────────
 * Recognition is syntactic and exact: a `test.prop(...)` callee or an `fc.*`
 * call inside a test body IS a property-based test, and nothing else is
 * counted as one. Attribution is not: a function is credited when its simple
 * name occurs, on a word boundary, anywhere in the TEXT of such a test —
 * title, comment, string or code — exactly as `spec.py` does it
 * (`_simple_name(fn.qualname) in corpus`). So `hasPropertyTest: true` means
 * "the project has a property-based test whose text names this function".
 * It does not establish that the property calls the function, that the
 * arbitraries reach its interesting inputs, that the test is not skipped, or
 * that the property asserts anything about the result — `critical-coverage`
 * and `kragg mutation` are the surfaces for those questions. The gates use
 * checker-bound references for the same question (`testDepth/references.ts`);
 * this section keeps the ported text signal because it fails nothing, and a
 * false "covered" here is quieter than a false "you have no property tests".
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type bundledTs from "typescript";

import { resolveTypeScript, type TypeScriptApi } from "../../analysis/sourceFile.ts";
import { criticalFunctions } from "../../gates/testDepth/criticalFunctions.ts";
import { calleeChain } from "../../gates/testDepth/testCases.ts";
import { parsedTestSources } from "../../gates/testDepth/testFiles.ts";

/** Package names that mean the project has adopted fast-check. */
export const FAST_CHECK_PACKAGES: readonly string[] = [
  "fast-check",
  "@fast-check/vitest",
  "@fast-check/jest",
  "@fast-check/ava",
];

/** Whether one public critical function has any property-based test. */
export interface PropertyCoverage {
  /** Full node name, as `.kragg/criticality.json` spells it. */
  readonly qualname: string;
  readonly fanIn: number;
  readonly hasPropertyTest: boolean;
}

/**
 * The result of looking for property-based coverage.
 *
 * A discriminated union rather than an empty list, so a caller cannot render
 * "0 covered" for a project that was never measured. See the module header.
 */
export type PropertyReport =
  | {
      readonly available: false;
      /** Why nothing was measured, phrased for the reader who can fix it. */
      readonly reason: string;
    }
  | {
      readonly available: true;
      /** One row per public critical function, ranked by fan-in, descending. */
      readonly rows: readonly PropertyCoverage[];
    };

/** Inputs for {@link propertyCoverage}. */
export interface PropertyOptions {
  readonly root: string;
  /** Policy `sourcePaths`. */
  readonly sourcePaths: readonly string[];
  /** Policy `testPaths`. */
  readonly testPaths: readonly string[];
  /** Compiler to parse with. Defaults to the project's own. */
  readonly api?: TypeScriptApi | undefined;
}

/**
 * Which public critical functions a property test exercises, ranked by fan-in.
 *
 * Unavailable — never zero — when the project does not use fast-check.
 */
export function propertyCoverage(options: PropertyOptions): PropertyReport {
  const api = options.api ?? resolveTypeScript(options.root).api;
  if (!usesFastCheck(options.root, options.testPaths, api)) {
    return {
      available: false,
      reason:
        "fast-check is not a dependency of this project (kragg does not bundle " +
        "it — add fast-check or @fast-check/vitest to measure this)",
    };
  }
  const corpus = propertyCorpus(options.root, options.testPaths, api);
  const rows = criticalFunctions(options.root, options.sourcePaths, { api }).map(
    (critical) => ({
      qualname: critical.qualname,
      fanIn: critical.fanIn,
      hasPropertyTest: mentions(corpus, critical.name),
    }),
  );
  return {
    available: true,
    rows: [...rows].sort((left, right) => right.fanIn - left.fanIn),
  };
}

/**
 * Whether the project depends on fast-check, by manifest or by import.
 *
 * The manifest is checked first because it is the declaration of intent, but
 * an IMPORT in a test file counts too: a pnpm workspace can hoist the
 * dependency into a parent `package.json` this function never reads, and
 * refusing to measure a project that demonstrably imports the library would
 * be the wrong kind of strict.
 *
 * DETECTION IS SYNTACTIC, NEVER TEXTUAL, and that is not a stylistic
 * preference — an earlier revision also scanned raw file text for `fc.assert(`
 * to catch a dynamic import, and dogfooding caught it red-handed: kragg-ts's
 * OWN `test/spec.test.ts` writes that idiom inside string fixtures, so the
 * detector concluded kragg-ts uses fast-check and printed a fabricated
 * `0/103` section. A tool that reports a dependency a project does not have,
 * because a test mentioned it in a quoted string, is the same class of error
 * the "unavailable, never zero" rule exists to prevent. Import specifiers
 * come from the parsed import table, so a string that merely LOOKS like code
 * is not code.
 */
export function usesFastCheck(
  root: string,
  testPaths: readonly string[],
  api?: TypeScriptApi | undefined,
): boolean {
  if (declaresFastCheck(root)) {
    return true;
  }
  const compiler = api ?? resolveTypeScript(root).api;
  for (const source of parsedTestSources(root, testPaths, compiler)) {
    for (const specifier of source.imports.values()) {
      if (FAST_CHECK_PACKAGES.some((name) => specifier.startsWith(`${name}#`))) {
        return true;
      }
    }
  }
  return false;
}

/* --- Internals ------------------------------------------------------------ */

/**
 * The concatenated text of every property test under the test paths.
 *
 * An empty string is a legitimate, reportable zero — the project has
 * fast-check and has written no property test yet. That is only reached once
 * {@link usesFastCheck} has already said measurement is possible.
 */
function propertyCorpus(
  root: string,
  testPaths: readonly string[],
  api: TypeScriptApi,
): string {
  const chunks: string[] = [];
  for (const source of parsedTestSources(root, testPaths, api)) {
    chunks.push(...propertyChunks(source.sourceFile, api));
  }
  return chunks.join("\n");
}

/** Text of every property-based test case in one file. */
function propertyChunks(
  sourceFile: bundledTs.SourceFile,
  api: TypeScriptApi,
): string[] {
  const chunks: string[] = [];
  const visit = (node: bundledTs.Node): void => {
    if (api.isCallExpression(node)) {
      const chain = calleeChain(node.expression, api);
      if (chain !== null && chain.props.includes("prop")) {
        chunks.push(node.getText(sourceFile));
      } else if (chain !== null && chain.head === "fc") {
        chunks.push(enclosingText(node, sourceFile, api));
      }
    }
    api.forEachChild(node, visit);
  };
  api.forEachChild(sourceFile, visit);
  return chunks;
}

/**
 * The text of the `it`/`test` call surrounding an `fc.*` call, falling back to
 * the call itself.
 *
 * Climbing to the enclosing case is what makes name attribution work: the
 * function under test is usually named in the test title or in the setup above
 * the assertion, not inside `fc.assert(...)`. `setParentNodes` is on for
 * everything `parsedSources` produces, so the walk up is available.
 */
function enclosingText(
  node: bundledTs.Node,
  sourceFile: bundledTs.SourceFile,
  api: TypeScriptApi,
): string {
  let current: bundledTs.Node | undefined = node.parent;
  while (current !== undefined && !api.isSourceFile(current)) {
    if (api.isCallExpression(current)) {
      const chain = calleeChain(current.expression, api);
      if (chain !== null && (chain.head === "it" || chain.head === "test")) {
        return current.getText(sourceFile);
      }
    }
    current = current.parent;
  }
  return node.getText(sourceFile);
}

/** Word-boundary name match, so `run` does not match `runner`. */
function mentions(corpus: string, name: string): boolean {
  if (name === "") {
    return false;
  }
  return new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`).test(corpus);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Any dependency field of the root `package.json` naming fast-check. */
function declaresFastCheck(root: string): boolean {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return false;
  }
  if (!isJsonObject(manifest)) {
    return false;
  }
  const record = manifest;
  const fields = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ];
  return fields.some((field) => {
    const table = record[field];
    if (!isJsonObject(table)) {
      return false;
    }
    return FAST_CHECK_PACKAGES.some((name) => Object.hasOwn(table, name));
  });
}

/** A parsed JSON object, before any of its fields have been checked. */
type JsonObject = Readonly<Record<string, unknown>>;

/** Narrow untrusted JSON to a plain object, without a cast. */
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
