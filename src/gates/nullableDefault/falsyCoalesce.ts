/**
 * Rule 1: `||` used as a default over a value that can legitimately be falsy.
 *
 * `const port = config.port || 3000` reads as "use 3000 when port is not
 * set", but `||` does not test for "not set" — it tests for falsy, so a
 * configured port of `0` silently becomes 3000, a `retries: 0` becomes the
 * default retry count, and an explicit `enabled: false` becomes `true`. This
 * is the JavaScript analogue of the Python gate's `d.get(k, 0)` problem: a
 * value that IS present is replaced by the default anyway.
 *
 * ── THE FIVE PRECISION RULES ───────────────────────────────────────────────
 * All five must hold. Each one exists to remove a specific class of noise;
 * together they are what keeps the gate at a handful of hits per repo instead
 * of one per file.
 *
 *  1. THE OPERATOR IS `||` (or `||=`). `??` is the correct operator and is
 *     never reported — flagging the fix would be absurd.
 *  2. THE FALLBACK IS A TRUTHY LITERAL: `3000`, `-1`, `true`. A falsy literal
 *     is EXCLUDED because it is harmless: `x || 0` and `x ?? 0` agree for
 *     every number but `NaN`, and `x || ""` and `x ?? ""` agree for every
 *     string. A non-literal fallback (a call, another variable) is excluded
 *     because `a || b` between two computed values is usually a genuine
 *     choice, not a default.
 *  3. THE FALLBACK IS NUMERIC OR BOOLEAN. A string fallback — `name ||
 *     "Anonymous"` — is deliberately NOT reported even though `""` is
 *     swallowed there too, because replacing an empty string with a
 *     placeholder is usually exactly what the author meant. This mirrors the
 *     Python gate restricting itself to arithmetic "by design, to keep false
 *     positives low", and it is the single rule doing the most work here.
 *  4. THE LEFT TYPE ACTUALLY CONTAINS THE FALSY VALUE, per the type checker.
 *     `number | undefined` contains `0`, so it is reported; `1 | 2 |
 *     undefined` does not, so it is not; a non-nullable `number` is not a
 *     defaulting site at all. `any` and `unknown` are SKIPPED — the checker
 *     does not know, so neither do we. This is the rule that turns a
 *     heuristic into a fact, and it is why this gate needs a program.
 *  5. THE RESULT IS USED AS A VALUE, not as a condition. `if (a || b)` is a
 *     logical or. The value positions are enumerated rather than
 *     excluded-by-guess: initializer, assignment right-hand side, `return`,
 *     call argument, concise arrow body, property value, parameter default.
 *
 * ── WHAT THIS MISSES ───────────────────────────────────────────────────────
 * A value stored first and defaulted later (`const p = config.port; const
 * port = p || 3000`) is still caught, because rule 4 reads the type of
 * whatever the left operand is — but a field the project typed as
 * non-nullable `number` when the API can really send `null` is invisible, and
 * so is anything reached through `any`. That is the limitation
 * `KNOWN_LIMITATIONS.md` states for the whole class and this gate does not
 * escape it: static analysis can only see the nullability someone modeled.
 */

import type bundledTs from "typescript";

import type { TypeScriptApi } from "../../analysis/sourceFile.ts";
import { capText, constituents, shortText, unwrap, type NullableFinding } from "./finding.ts";

/** Which falsy value the fallback would displace. */
type DefaultKind = "number" | "boolean";

const FALSY: Readonly<Record<DefaultKind, string>> = {
  number: "0",
  boolean: "false",
};

/** Report `x || <truthy literal>` where `x` can legitimately be falsy. */
export function falsyCoalesceFinding(
  node: bundledTs.Node,
  api: TypeScriptApi,
  checker: bundledTs.TypeChecker,
): NullableFinding | null {
  if (!api.isBinaryExpression(node)) {
    return null;
  }
  const operator = node.operatorToken.kind;
  const compound = operator === api.SyntaxKind.BarBarEqualsToken;
  if (operator !== api.SyntaxKind.BarBarToken && !compound) {
    return null;
  }
  const kind = truthyDefault(node.right, api);
  if (kind === null) {
    return null;
  }
  // `a ||= 1` is a defaulting assignment by construction; there is no
  // surrounding expression whose position could make it a condition.
  if (!compound && !inValuePosition(node, api)) {
    return null;
  }
  const type = checker.getTypeAtLocation(node.left);
  if (!swallowsFalsy(type, kind, api, checker)) {
    return null;
  }
  return {
    node,
    message:
      `\`||\` also replaces a valid \`${FALSY[kind]}\` here: ` +
      `\`${shortText(node.left)}\` is \`${capText(checker.typeToString(type), 32)}\``,
    fixHint:
      "use `??` so only `null`/`undefined` take the default, " +
      "or test the missing case explicitly",
  };
}

/**
 * A truthy numeric or boolean literal fallback, or `null`.
 *
 * `-1` is a `PrefixUnaryExpression`, not a numeric literal, and it is a very
 * common sentinel default — so the unary form is read too.
 */
function truthyDefault(
  expression: bundledTs.Expression,
  api: TypeScriptApi,
): DefaultKind | null {
  const node = unwrap(expression, api);
  if (api.isNumericLiteral(node)) {
    return Number(node.text) === 0 ? null : "number";
  }
  if (
    api.isPrefixUnaryExpression(node) &&
    (node.operator === api.SyntaxKind.MinusToken ||
      node.operator === api.SyntaxKind.PlusToken)
  ) {
    const operand = unwrap(node.operand, api);
    return api.isNumericLiteral(operand) && Number(operand.text) !== 0 ? "number" : null;
  }
  return node.kind === api.SyntaxKind.TrueKeyword ? "boolean" : null;
}

/**
 * True when the type is nullable AND contains the falsy value the fallback
 * would displace.
 *
 * Both halves matter. Without nullability the `||` is not a defaulting idiom
 * at all — it is dead code or a deliberate truthiness test. Without the falsy
 * member there is no bug: `||` and `??` agree on every value the type admits.
 */
function swallowsFalsy(
  type: bundledTs.Type,
  kind: DefaultKind,
  api: TypeScriptApi,
  checker: bundledTs.TypeChecker,
): boolean {
  const flags = api.TypeFlags;
  if ((type.flags & (flags.Any | flags.Unknown)) !== 0) {
    return false;
  }
  const parts = constituents(type);
  const nullish = parts.some(
    (part) => (part.flags & (flags.Undefined | flags.Null | flags.Void)) !== 0,
  );
  if (!nullish) {
    return false;
  }
  return parts.some((part) =>
    kind === "number" ? isFalsyNumber(part, api) : isFalse(part, api, checker),
  );
}

function isFalsyNumber(type: bundledTs.Type, api: TypeScriptApi): boolean {
  if ((type.flags & api.TypeFlags.Number) !== 0) {
    return true;
  }
  return type.isNumberLiteral() && type.value === 0;
}

function isFalse(
  type: bundledTs.Type,
  api: TypeScriptApi,
  checker: bundledTs.TypeChecker,
): boolean {
  if ((type.flags & api.TypeFlags.Boolean) !== 0) {
    return true;
  }
  return (
    (type.flags & api.TypeFlags.BooleanLiteral) !== 0 && checker.typeToString(type) === "false"
  );
}

/**
 * True when this expression's VALUE is consumed — the defaulting positions,
 * enumerated.
 *
 * A whitelist rather than a blacklist of boolean contexts, because precision
 * is the point: an unrecognised position is not reported, and the cost of
 * that is a miss rather than noise.
 */
function inValuePosition(node: bundledTs.Node, api: TypeScriptApi): boolean {
  const site = valueSite(node, api);
  if (site === null) {
    return false;
  }
  return initializes(site, api) || consumesValue(site, api);
}

/** An expression paired with the parent that decides what it is used for. */
interface ValueSite {
  /** The outermost expression, once parentheses are stepped out of. */
  readonly current: bundledTs.Node;
  readonly parent: bundledTs.Node;
}

/**
 * The expression and its first parent that is not a parenthesis, or `null`
 * when there is no parent at all.
 *
 * `(a ?? b)` is `a ?? b`: the parentheses change nothing about the position
 * the value ends up in, so they are stepped over before anything is judged.
 */
function valueSite(node: bundledTs.Node, api: TypeScriptApi): ValueSite | null {
  let current: bundledTs.Node = node;
  let parent: bundledTs.Node | undefined = current.parent;
  while (parent !== undefined && api.isParenthesizedExpression(parent)) {
    current = parent;
    parent = parent.parent;
  }
  return parent === undefined ? null : { current, parent };
}

/** The positions that give a value a NAME: every kind of initializer. */
function initializes(site: ValueSite, api: TypeScriptApi): boolean {
  const { parent } = site;
  if (
    api.isVariableDeclaration(parent) ||
    api.isPropertyDeclaration(parent) ||
    api.isParameter(parent) ||
    api.isBindingElement(parent) ||
    api.isPropertyAssignment(parent)
  ) {
    return parent.initializer === site.current;
  }
  return false;
}

/** The positions that consume a value without declaring one. */
function consumesValue(site: ValueSite, api: TypeScriptApi): boolean {
  const { current, parent } = site;
  if (api.isReturnStatement(parent)) {
    return parent.expression === current;
  }
  if (api.isArrowFunction(parent)) {
    return parent.body === current;
  }
  if (api.isCallExpression(parent) || api.isNewExpression(parent)) {
    return parent.arguments?.some((argument) => argument === current) === true;
  }
  if (api.isBinaryExpression(parent)) {
    return (
      parent.operatorToken.kind === api.SyntaxKind.EqualsToken && parent.right === current
    );
  }
  return false;
}
