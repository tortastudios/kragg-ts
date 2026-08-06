/**
 * Rule 2: arithmetic on an untyped external payload.
 *
 * This is the direct port of the Python gate's target, adapted to the way
 * JavaScript fails. `JSON.parse` returns `any`; `await response.json()`
 * returns `any`. Do arithmetic on a field of one and a missing or null value
 * does NOT raise — `null + 1` is `1`, `undefined * 2` is `NaN`, `"3" - 1` is
 * `2`. Python's version of this bug crashes with a `TypeError`; JavaScript's
 * version ships a wrong number into a database. The silent failure is the
 * worse one, which is why the rule is worth having.
 *
 * It is also the concrete form of the honesty in `KNOWN_LIMITATIONS.md`: the
 * production incident that motivated these gates "would itself have passed
 * strict mypy, because the payload was typed away as `dict[str, Any]` — and
 * `Any` defeats the checker". `JSON.parse` is exactly that hole in
 * TypeScript, and it is one the type checker can point at precisely.
 *
 * ── THE PRECISION RULES ────────────────────────────────────────────────────
 *  1. THE OPERATOR IS ARITHMETIC: `-`, `*`, `/`, `%`, `**` and their compound
 *     assignment forms. These coerce unconditionally, so any one of them on
 *     an untyped value is a coercion nobody wrote.
 *  2. `+` IS ONLY REPORTED AGAINST A NUMBER. `payload.name + " (new)"` is
 *     string concatenation and is everywhere; `payload.count + 1` is
 *     arithmetic. The other operand must be numeric for `+` to count.
 *  3. THE OPERAND MUST BE `any`, PER THE CHECKER. `JSON.parse(body) as
 *     Config` is not reported: the project asserted a type, which is a
 *     reviewable act, and the gate's business is with values nobody typed at
 *     all.
 *  4. THE OPERAND MUST SYNTACTICALLY DESCEND FROM A PAYLOAD CALL —
 *     `JSON.parse(...)` or a zero-argument `.json()` — either directly,
 *     through property/element access, or through a variable whose single
 *     declaration initializes from one. Every other `any` in the repo is left
 *     alone; that is the `typing-strictness` gate's job, and duplicating it
 *     here would produce one violation per untyped line.
 *
 * ── WHAT THIS MISSES ───────────────────────────────────────────────────────
 * A payload passed through a function parameter, stored on an object, or
 * reassigned is not followed — there is no data-flow analysis here, only
 * declarations. Comparison (`payload.n > 10`), indexing (`rows[payload.i]`)
 * and truthiness on an untyped payload are all real bugs of the same family
 * and are all deliberately out of scope, exactly as the Python gate restricts
 * itself to arithmetic. The scope is the price of the hit count.
 */

import type bundledTs from "typescript";

import type { TypeScriptApi } from "../../analysis/sourceFile.ts";
import { MAX_DEPTH, shortText, unwrap, type NullableFinding } from "./finding.ts";

/** Calls whose result is an unmodeled external payload. */
const PAYLOAD_DESCRIPTION = "`JSON.parse` / `.json()`";

/** One operand paired with the other, so both orderings can be tried. */
type OperandPair = readonly [bundledTs.Expression, bundledTs.Expression];

/** Report arithmetic where one operand is untyped external data. */
export function untypedPayloadFinding(
  node: bundledTs.Node,
  api: TypeScriptApi,
  checker: bundledTs.TypeChecker,
): NullableFinding | null {
  if (!api.isBinaryExpression(node)) {
    return null;
  }
  const operator = arithmeticKind(node.operatorToken.kind, api);
  if (operator === null) {
    return null;
  }
  const sides: readonly OperandPair[] = [
    [node.left, node.right],
    [node.right, node.left],
  ];
  for (const [operand, other] of sides) {
    if (operator === "add" && !isNumeric(other, api, checker)) {
      continue;
    }
    if (!isUntypedPayload(operand, api, checker, 0)) {
      continue;
    }
    return {
      node,
      message:
        `arithmetic on the untyped ${PAYLOAD_DESCRIPTION} value ` +
        `\`${shortText(operand)}\`: a null or missing field becomes \`NaN\` ` +
        "or a silently wrong number, never an error",
      fixHint:
        "validate the payload at the boundary and give it a real type — " +
        "`any` defeats the checker exactly as `Any` defeats mypy",
    };
  }
  return null;
}

/** `"add"` for `+`/`+=`, `"coerce"` for the unconditional ones, else null. */
function arithmeticKind(
  kind: bundledTs.SyntaxKind,
  api: TypeScriptApi,
): "add" | "coerce" | null {
  const syntax = api.SyntaxKind;
  if (kind === syntax.PlusToken || kind === syntax.PlusEqualsToken) {
    return "add";
  }
  const coercing: readonly bundledTs.SyntaxKind[] = [
    syntax.MinusToken,
    syntax.AsteriskToken,
    syntax.SlashToken,
    syntax.PercentToken,
    syntax.AsteriskAsteriskToken,
    syntax.MinusEqualsToken,
    syntax.AsteriskEqualsToken,
    syntax.SlashEqualsToken,
    syntax.PercentEqualsToken,
    syntax.AsteriskAsteriskEqualsToken,
  ];
  return coercing.includes(kind) ? "coerce" : null;
}

/** True when the checker types this expression as a number. */
function isNumeric(
  expression: bundledTs.Expression,
  api: TypeScriptApi,
  checker: bundledTs.TypeChecker,
): boolean {
  const flags = checker.getTypeAtLocation(expression).flags;
  return (flags & (api.TypeFlags.Number | api.TypeFlags.NumberLiteral)) !== 0;
}

/**
 * True when this operand is `any` AND descends from a payload call.
 *
 * The syntactic test runs first: it is a handful of node-kind checks, while
 * `getTypeAtLocation` is the expensive half, and every `a + b` in the repo
 * reaches this function.
 */
function isUntypedPayload(
  expression: bundledTs.Expression,
  api: TypeScriptApi,
  checker: bundledTs.TypeChecker,
  depth: number,
): boolean {
  if (!descendsFromPayload(expression, api, checker, depth)) {
    return false;
  }
  return (checker.getTypeAtLocation(expression).flags & api.TypeFlags.Any) !== 0;
}

function descendsFromPayload(
  expression: bundledTs.Expression,
  api: TypeScriptApi,
  checker: bundledTs.TypeChecker,
  depth: number,
): boolean {
  if (depth > MAX_DEPTH) {
    return false;
  }
  let current: bundledTs.Expression = unwrap(expression, api);
  for (let step = 0; step < MAX_DEPTH; step += 1) {
    if (api.isAwaitExpression(current)) {
      current = unwrap(current.expression, api);
      continue;
    }
    if (api.isPropertyAccessExpression(current) || api.isElementAccessExpression(current)) {
      current = unwrap(current.expression, api);
      continue;
    }
    if (api.isCallExpression(current)) {
      return isPayloadCall(current, api);
    }
    if (api.isIdentifier(current)) {
      return declaredFromPayload(current, api, checker, depth + 1);
    }
    return false;
  }
  return false;
}

/** `JSON.parse(...)` or a zero-argument `.json()`. */
function isPayloadCall(call: bundledTs.CallExpression, api: TypeScriptApi): boolean {
  const callee = unwrap(call.expression, api);
  if (!api.isPropertyAccessExpression(callee)) {
    return false;
  }
  if (callee.name.text === "json") {
    return call.arguments.length === 0;
  }
  if (callee.name.text !== "parse") {
    return false;
  }
  const owner = unwrap(callee.expression, api);
  return api.isIdentifier(owner) && owner.text === "JSON";
}

/**
 * True when an identifier's ONE declaration initializes from a payload call.
 *
 * One declaration, because a name declared twice is a name the gate cannot
 * reason about without flow analysis. The initializer is re-entered through
 * `descendsFromPayload`, so `const rows = parsed.items` followed by
 * `rows.length * 2` still resolves back to the `JSON.parse`.
 */
function declaredFromPayload(
  identifier: bundledTs.Identifier,
  api: TypeScriptApi,
  checker: bundledTs.TypeChecker,
  depth: number,
): boolean {
  const symbol = checker.getSymbolAtLocation(identifier);
  const declarations = symbol?.declarations;
  if (declarations === undefined || declarations.length !== 1) {
    return false;
  }
  const declaration = declarations[0];
  if (declaration === undefined || !api.isVariableDeclaration(declaration)) {
    return false;
  }
  const initializer = declaration.initializer;
  if (initializer === undefined) {
    return false;
  }
  return descendsFromPayload(initializer, api, checker, depth);
}
