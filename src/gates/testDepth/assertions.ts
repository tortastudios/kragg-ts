/**
 * Decide whether a test body contains an assertion.
 *
 * This is the port of `_has_assertion` in `kragg/src/kragg/gates/
 * test_quality.py`, whose rule is "an `assert` statement, a `pytest.raises`,
 * or a call to an `assert*` method". JavaScript has no assert STATEMENT, so
 * every assertion is a call and the whole question becomes: which calls?
 *
 * ── WHAT COUNTS, AND WHY EACH ONE ──────────────────────────────────────────
 *  1. the root identifier is `expect` — vitest, bun:test and jest-style
 *     `expect(x).toBe(1)`, `expect.soft(x)`, `expect.assertions(2)`, and
 *     crucially `await expect(p).rejects.toThrow()` and
 *     `expect(x).toMatchSnapshot()`, which are assertions with no `assert` in
 *     sight. Any `expect(...)` counts, even without a matcher: a bare
 *     `expect(x)` asserts nothing, but treating it as an assertion only ever
 *     MISSES a violation, and this gate would rather miss one than invent one;
 *  2. the root identifier is `assert` — `node:assert` in all its spellings:
 *     `assert(value)` called directly, `assert.equal`, `assert.strict.equal`,
 *     `assert.rejects`, and `import assert from "node:assert/strict"`;
 *  3. a property named `assert` anywhere in the chain — node:test's
 *     `t.assert.ok(...)`, `t.assert.snapshot(...)`, and `chai.assert.equal`;
 *  4. a chain ending in a name that STARTS with `assert` — the ported half of
 *     Python's `func.attr.startswith("assert")`, which also catches the
 *     convention-named local helper `assertEdge(...)`;
 *  5. an identifier IMPORTED from an assert module — `import { strictEqual }
 *     from "node:assert"` then `strictEqual(a, b)`. The import table from
 *     `ParsedSource` makes this exact rather than a name guess;
 *  6. a property named `expect` in the chain — `chai.expect(x)`, `vi.expect`.
 *
 * ── THE HARD CASE: ASSERTIONS INSIDE A LOCAL HELPER ────────────────────────
 * A test whose body is `assertShapeOf(result)` where `assertShapeOf` is a
 * function in the same file asserts perfectly well, and flagging it would be a
 * false positive of exactly the kind that gets a gate switched off. So calls to
 * LOCALLY DECLARED functions are FOLLOWED — transitively, with a visited set,
 * across every named function declaration and `const name = () => {}` in the
 * file at any nesting depth. Transitive rather than one level because each
 * extra hop can only ever REMOVE a violation, and an understating gate is the
 * safe failure; termination is bounded by the number of named functions in the
 * file.
 *
 * ── WHAT IS STILL MISSED, ON PURPOSE ───────────────────────────────────────
 *  - an assertion helper imported from ANOTHER file. Following it would mean
 *    parsing and resolving across the test tree, and the honest answer is that
 *    this gate does not do it. Such a test is reported, and the fix is either
 *    to name the helper `assert*` (rule 4) or to mark the site with a visible
 *    `// kragg: ignore -- <reason>`;
 *  - a helper reached as a property (`helpers.assertShape()` where `helpers`
 *    is an imported object) unless its name starts with `assert`;
 *  - chai's property-getter style (`expect(x).to.be.true`) is caught by rule 1
 *    but a bare `x.should.equal(1)` is not — `should` is not in any of the
 *    three supported runners.
 */

import type bundledTs from "typescript";

import type { ParsedSource, TypeScriptApi } from "../../analysis/sourceFile.ts";
import { calleeChain, type CalleeChain } from "./testCases.ts";

/** Module specifiers whose every export is an assertion function. */
const ASSERT_MODULES: ReadonlySet<string> = new Set([
  "assert",
  "node:assert",
  "assert/strict",
  "node:assert/strict",
]);

/** Root identifiers that are assertion entry points in every runner. */
const ASSERT_ROOTS: ReadonlySet<string> = new Set(["assert", "expect"]);

/** Everything the analysis needs from the file the body came from. */
export interface AssertionContext {
  readonly api: TypeScriptApi;
  /** Function name -> its declaration node, for local-helper following. */
  readonly helpers: ReadonlyMap<string, bundledTs.Node>;
  /** Local binding -> `"<module>#<export>"`, from `ParsedSource.imports`. */
  readonly imports: ReadonlyMap<string, string>;
}

/** Build the per-file context once, and reuse it for every case in the file. */
export function assertionContext(
  source: ParsedSource,
  api: TypeScriptApi,
): AssertionContext {
  return { api, helpers: helperIndex(source.sourceFile, api), imports: source.imports };
}

/**
 * Whether this body — or any local helper it calls — asserts anything.
 *
 * The walk descends into nested callbacks and closures, because an assertion
 * inside `items.forEach(...)` or inside an `await run(() => { ... })` is still
 * an assertion the test performs.
 */
export function hasAssertion(body: bundledTs.Node, context: AssertionContext): boolean {
  const queue: bundledTs.Node[] = [body];
  const followed = new Set<string>();

  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) {
      break;
    }
    if (scanForAssertion(next, context, queue, followed)) {
      return true;
    }
  }
  return false;
}

/**
 * Walk one function body; `true` on the first assertion found.
 *
 * Calls to local helpers are pushed onto `queue` as we go, so a body that
 * turns out to assert only through its third helper still resolves — without
 * recursion into the scan itself, which keeps the visited bookkeeping in one
 * place.
 */
function scanForAssertion(
  root: bundledTs.Node,
  context: AssertionContext,
  queue: bundledTs.Node[],
  followed: Set<string>,
): boolean {
  const { api } = context;
  let found = false;

  const visit = (node: bundledTs.Node): void => {
    if (found) {
      return;
    }
    const callee = calleeOf(node, api);
    if (callee !== null) {
      const chain = calleeChain(callee, api);
      if (chain !== null) {
        if (isAssertion(chain, context)) {
          found = true;
          return;
        }
        queueHelper(chain, context, queue, followed);
      }
    }
    api.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** The expression being invoked, for the node shapes that invoke one. */
function calleeOf(
  node: bundledTs.Node,
  api: TypeScriptApi,
): bundledTs.Expression | null {
  if (api.isCallExpression(node)) {
    return node.expression.kind === api.SyntaxKind.ImportKeyword ? null : node.expression;
  }
  if (api.isTaggedTemplateExpression(node)) {
    return node.tag;
  }
  return null;
}

/** Rules 1-6 from this module's header. */
function isAssertion(chain: CalleeChain, context: AssertionContext): boolean {
  if (ASSERT_ROOTS.has(chain.head) || chain.head.startsWith("assert")) {
    return true;
  }
  if (chain.props.some((prop) => ASSERT_ROOTS.has(prop))) {
    return true;
  }
  const last = chain.props[chain.props.length - 1];
  if (last !== undefined && last.startsWith("assert")) {
    return true;
  }
  return isAssertImport(chain.head, context);
}

/** Whether a local binding came from `node:assert` (in any spelling). */
function isAssertImport(name: string, context: AssertionContext): boolean {
  const target = context.imports.get(name);
  if (target === undefined) {
    return false;
  }
  const separator = target.lastIndexOf("#");
  const module = separator < 0 ? target : target.slice(0, separator);
  return ASSERT_MODULES.has(module);
}

/** Queue an unqualified call to a function declared in this file. */
function queueHelper(
  chain: CalleeChain,
  context: AssertionContext,
  queue: bundledTs.Node[],
  followed: Set<string>,
): void {
  if (chain.props.length > 0 || followed.has(chain.head)) {
    return;
  }
  const helper = context.helpers.get(chain.head);
  if (helper !== undefined) {
    followed.add(chain.head);
    queue.push(helper);
  }
}

/**
 * Index every named function in the file, at any nesting depth.
 *
 * Depth matters: helpers written inside a `describe` callback are the common
 * shape, and a module-level-only index would miss them. Names are flat, so two
 * helpers with the same name in different scopes collapse — that can only make
 * the gate more lenient, never wrongly strict.
 */
function helperIndex(
  sourceFile: bundledTs.SourceFile,
  api: TypeScriptApi,
): ReadonlyMap<string, bundledTs.Node> {
  const helpers = new Map<string, bundledTs.Node>();

  const visit = (node: bundledTs.Node): void => {
    if (api.isFunctionDeclaration(node) && node.name !== undefined) {
      register(helpers, node.name.text, node);
    } else if (api.isVariableDeclaration(node) && api.isIdentifier(node.name)) {
      const initializer = node.initializer;
      if (
        initializer !== undefined &&
        (api.isArrowFunction(initializer) || api.isFunctionExpression(initializer))
      ) {
        register(helpers, node.name.text, initializer);
      }
    }
    api.forEachChild(node, visit);
  };
  api.forEachChild(sourceFile, visit);
  return helpers;
}

function register(
  helpers: Map<string, bundledTs.Node>,
  name: string,
  node: bundledTs.Node,
): void {
  if (!helpers.has(name)) {
    helpers.set(name, node);
  }
}
