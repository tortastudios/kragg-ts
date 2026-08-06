/**
 * Find the test cases in a parsed test file.
 *
 * Python has it easy: a pytest test is a `def test_*` and `ast` finds it in one
 * walk. A JavaScript test is a CALL — `it("...", () => {})` — written in one of
 * a dozen spellings, so this module exists to answer "which calls are tests,
 * which of them are skipped, and where is the body" before `assertions.ts`
 * decides whether the body can fail.
 *
 * ── WHICH RUNNERS ──────────────────────────────────────────────────────────
 * The three that matter, and they agree on the syntax that counts here:
 * **vitest**, **node:test** and **bun:test** all spell a case `it(...)` or
 * `test(...)` and a group `describe(...)`. So detection is by NAME, not by
 * resolved import: all three are usable as globals (node:test's `test` is also
 * global under `node --test`, vitest has `globals: true`, bun:test injects
 * them), and requiring an import would silently see no tests in a large share
 * of real projects — the fail-open direction.
 *
 * The cost of the name rule is a false positive on a non-runner function that
 * happens to be called `test` or `it` AND is passed a function literal. In a
 * file under the policy's test paths that is rare enough to accept, and the
 * result is a violation on a real line that a reviewer can suppress.
 *
 * ── SPELLINGS HANDLED ──────────────────────────────────────────────────────
 * `it.only`, `test.concurrent`, `it.each([...])(name, fn)` and its tagged
 * template form, `it.skipIf(cond)(...)`, `it.for(...)(...)` — the callee is
 * unwrapped through property accesses, intermediate calls and template tags
 * down to the root identifier, so every chained modifier is seen.
 *
 * ── SKIPPED IS NOT BROKEN ──────────────────────────────────────────────────
 * `it.skip`, `test.todo`, `describe.skip` and node:test's options-object forms
 * (`test("x", { skip: true }, fn)`, `{ todo: "reason" }`) mark a case as
 * deliberately not running. An empty body there is a placeholder, not a test
 * that cannot fail, and flagging it is the single most obvious false positive
 * this gate could ship. A skipped `describe` marks everything inside it, since
 * the inner cases do not run either.
 *
 * `it.fails` / `it.failing` are NOT skips — the case runs and is expected to
 * throw, so it still has to assert something.
 *
 * A case with no function-literal argument (`it.todo("later")`, or
 * `it("x", namedFn)`) has no body to inspect and is not reported. Following a
 * named callback to its declaration would be the assertion analyser's job, and
 * not reporting is the safe direction.
 */

import type bundledTs from "typescript";

import type { TypeScriptApi } from "../../analysis/sourceFile.ts";

/** One test case found in a file. */
export interface TestCase {
  /** The string title when there is one, else the callee as written. */
  readonly title: string;
  /** 1-based line of the call. */
  readonly line: number;
  /** 1-based last line of the call, for suppression-comment matching. */
  readonly endLine: number;
  /** The function literal whose body must contain an assertion. */
  readonly body: bundledTs.Node;
  /** Deliberately not running: skipped, todo, or inside a skipped group. */
  readonly skipped: boolean;
}

/** A callee expression reduced to its root identifier plus its modifiers. */
export interface CalleeChain {
  /** The root identifier, e.g. `it` in `it.each([1])`. */
  readonly head: string;
  /** Property names between the root and the call, outermost last. */
  readonly props: readonly string[];
}

const TEST_HEADS: ReadonlySet<string> = new Set(["it", "test"]);
const SUITE_HEADS: ReadonlySet<string> = new Set(["describe", "suite"]);
const SKIP_MODIFIERS: ReadonlySet<string> = new Set(["skip", "todo"]);

/** Every test case in a file, in source order. */
export function findTestCases(
  sourceFile: bundledTs.SourceFile,
  api: TypeScriptApi,
): readonly TestCase[] {
  const found: TestCase[] = [];

  const visit = (node: bundledTs.Node, inSkippedSuite: boolean): void => {
    let childrenSkipped = inSkippedSuite;
    if (api.isCallExpression(node)) {
      const chain = calleeChain(node.expression, api);
      if (chain !== null) {
        const marked = inSkippedSuite || isSkipCall(chain, node, api);
        if (TEST_HEADS.has(chain.head)) {
          const body = testBody(node, api);
          if (body !== null) {
            found.push(describeCase(node, body, sourceFile, marked));
          }
        }
        if (SUITE_HEADS.has(chain.head) && marked) {
          childrenSkipped = true;
        }
      }
    }
    api.forEachChild(node, (child) => {
      visit(child, childrenSkipped);
    });
  };
  api.forEachChild(sourceFile, (child) => {
    visit(child, false);
  });

  return found;
}

/**
 * Reduce a callee expression to its root identifier and property chain.
 *
 * `null` when the root is not a plain identifier — a call on a computed
 * member, on a `this`, on a literal. Those are never a runner's entry point,
 * and guessing at one would invent tests that are not there.
 */
export function calleeChain(
  expression: bundledTs.Expression,
  api: TypeScriptApi,
): CalleeChain | null {
  const props: string[] = [];
  let current: bundledTs.Expression = expression;
  for (;;) {
    if (api.isPropertyAccessExpression(current)) {
      props.unshift(current.name.text);
      current = current.expression;
      continue;
    }
    if (api.isElementAccessExpression(current)) {
      const argument = current.argumentExpression;
      if (!api.isStringLiteralLike(argument)) {
        return null;
      }
      props.unshift(argument.text);
      current = current.expression;
      continue;
    }
    const inner = unwrapCallee(current, api);
    if (inner !== null) {
      current = inner;
      continue;
    }
    return api.isIdentifier(current) ? { head: current.text, props } : null;
  }
}

/**
 * Strip one layer that carries no name of its own, or `null` at the root.
 *
 * `it.each([1, 2])(...)` and `` it.each`...`(...) `` make the callee itself a
 * call or a tagged template, with the modifiers on its own callee. Parentheses,
 * `!`, `as` and `satisfies` are syntax around an expression, never part of it.
 */
function unwrapCallee(
  expression: bundledTs.Expression,
  api: TypeScriptApi,
): bundledTs.Expression | null {
  if (api.isCallExpression(expression)) {
    return expression.expression;
  }
  if (api.isTaggedTemplateExpression(expression)) {
    return expression.tag;
  }
  if (
    api.isParenthesizedExpression(expression) ||
    api.isNonNullExpression(expression) ||
    api.isAsExpression(expression) ||
    api.isSatisfiesExpression(expression)
  ) {
    return expression.expression;
  }
  return null;
}

function describeCase(
  node: bundledTs.CallExpression,
  body: bundledTs.Node,
  sourceFile: bundledTs.SourceFile,
  skipped: boolean,
): TestCase {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    title: caseTitle(node, sourceFile),
    line: start.line + 1,
    endLine: end.line + 1,
    body,
    skipped,
  };
}

/**
 * The last function-literal argument, which is the body in every runner.
 *
 * Taken from the END so that node:test's `test(name, options, fn)` and
 * vitest's `it(name, fn, timeout)` both land on the function.
 */
function testBody(
  node: bundledTs.CallExpression,
  api: TypeScriptApi,
): bundledTs.Node | null {
  for (let index = node.arguments.length - 1; index >= 0; index -= 1) {
    const argument = node.arguments[index];
    if (argument === undefined) {
      continue;
    }
    if (api.isArrowFunction(argument) || api.isFunctionExpression(argument)) {
      return argument;
    }
  }
  return null;
}

/** The title as written, falling back to the callee text for an unnamed case. */
function caseTitle(
  node: bundledTs.CallExpression,
  sourceFile: bundledTs.SourceFile,
): string {
  const first = node.arguments[0];
  if (first !== undefined) {
    const literal = literalText(first, sourceFile);
    if (literal !== null) {
      return literal;
    }
  }
  return node.expression.getText(sourceFile);
}

function literalText(
  node: bundledTs.Node,
  sourceFile: bundledTs.SourceFile,
): string | null {
  const text = node.getText(sourceFile);
  const quoted =
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith("`") && text.endsWith("`"));
  return quoted && text.length >= 2 ? text.slice(1, -1) : null;
}

/** A `.skip`/`.todo` modifier, or an options object asking for the same. */
function isSkipCall(
  chain: CalleeChain,
  node: bundledTs.CallExpression,
  api: TypeScriptApi,
): boolean {
  if (chain.props.some((prop) => SKIP_MODIFIERS.has(prop))) {
    return true;
  }
  return node.arguments.some((argument) => isSkipOptions(argument, api));
}

/**
 * node:test's options object.
 *
 * `{ skip: true }`, `{ todo: "why" }` and the shorthand `{ skip }` all count;
 * an explicit `{ skip: false }` does not, because it says the case runs.
 */
function isSkipOptions(node: bundledTs.Node, api: TypeScriptApi): boolean {
  if (!api.isObjectLiteralExpression(node)) {
    return false;
  }
  return node.properties.some((property) => {
    const name = property.name;
    if (name === undefined || !api.isIdentifier(name) || !SKIP_MODIFIERS.has(name.text)) {
      return false;
    }
    if (api.isPropertyAssignment(property)) {
      return property.initializer.kind !== api.SyntaxKind.FalseKeyword;
    }
    return api.isShorthandPropertyAssignment(property);
  });
}
