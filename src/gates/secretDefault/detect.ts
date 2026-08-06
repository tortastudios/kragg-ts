/**
 * Syntactic detectors for the secret-default gate.
 *
 * Every function here answers one question about ONE node and never looks at
 * data flow. That is the same discipline as the Python original: the gate
 * matches the configuration IDIOM at the places configuration is born, and a
 * shape it cannot read is skipped rather than guessed at.
 *
 * The public surface is `secretFindings` (one node in, zero or more findings
 * out) and `guardedByThrow` (does this env read fail loudly two lines later).
 * The caller owns walking, suppression and violation construction.
 */

import type bundledTs from "typescript";

import type { TypeScriptApi } from "../../analysis/sourceFile.ts";
import { isSecretName } from "./names.ts";

/** One secret-named binding that was given a silent fallback. */
export interface SecretFinding {
  /** The secret name as written — an env key, a field, a parameter. */
  readonly name: string;
  /** Literal text it falls back to. `""` means it defaults to empty. */
  readonly fallback: string;
  /** Node to report and to check for a suppression comment. */
  readonly node: bundledTs.Node;
  /** True for `process.env.X ?? "…"` and friends; false for a binding. */
  readonly fromEnv: boolean;
}

/**
 * Objects whose `.env` member is the process environment.
 *
 * `import.meta.env` (Vite) is handled separately because its owner is a
 * `MetaProperty`, not an identifier.
 */
const ENV_OWNERS: ReadonlySet<string> = new Set(["process", "Bun", "Deno"]);

/** How far a `.default()` search walks up a builder chain. */
const MAX_CHAIN_DEPTH = 12;

/**
 * Findings produced by this node alone.
 *
 * Dispatch is by node kind, and the kinds are chosen so that no two of them
 * can see the same fallback twice. In particular a `const t = process.env.T ??
 * ""` is reported ONCE, by the env-read detector: the declaration's
 * initializer is a binary expression, not a literal, so the binding detector
 * declines it.
 */
export function secretFindings(
  node: bundledTs.Node,
  api: TypeScriptApi,
  suffixes: readonly string[],
): readonly SecretFinding[] {
  if (api.isBinaryExpression(node)) {
    return binaryFindings(node, api, suffixes);
  }
  if (api.isVariableDeclaration(node) || api.isPropertyDeclaration(node)) {
    return binding(nameText(node.name, api), node.initializer, node, api, suffixes);
  }
  if (api.isPropertyAssignment(node)) {
    return binding(nameText(node.name, api), node.initializer, node, api, suffixes);
  }
  if (api.isParameter(node)) {
    return binding(nameText(node.name, api), node.initializer, node, api, suffixes);
  }
  if (api.isBindingElement(node)) {
    return destructured(node, api, suffixes);
  }
  return [];
}

/* -------------------------------------------------------------------------
 * Environment reads with a fallback
 * ---------------------------------------------------------------------- */

function binaryFindings(
  node: bundledTs.BinaryExpression,
  api: TypeScriptApi,
  suffixes: readonly string[],
): readonly SecretFinding[] {
  const kind = node.operatorToken.kind;
  const syntax = api.SyntaxKind;
  if (kind === syntax.BarBarToken || kind === syntax.QuestionQuestionToken) {
    return envFallback(node, api, suffixes);
  }
  if (
    kind === syntax.EqualsToken ||
    kind === syntax.BarBarEqualsToken ||
    kind === syntax.QuestionQuestionEqualsToken
  ) {
    return binding(assignedName(node.left, api), node.right, node, api, suffixes);
  }
  return [];
}

function envFallback(
  node: bundledTs.BinaryExpression,
  api: TypeScriptApi,
  suffixes: readonly string[],
): readonly SecretFinding[] {
  const key = envKeyName(node.left, api);
  if (key === null || !isSecretName(key, suffixes)) {
    return [];
  }
  const fallback = stringLiteralText(node.right, api);
  if (fallback === null) {
    return [];
  }
  return [{ name: key, fallback, node, fromEnv: true }];
}

/**
 * The environment key this expression reads, or `null`.
 *
 * Covers the three spellings that actually appear: `env.KEY`, `env["KEY"]`
 * (the form a project with `noPropertyAccessFromIndexSignature` is forced to
 * write) and `env.get("KEY")` (Deno). A computed key is `null` — the gate
 * cannot name a secret it cannot read.
 */
export function envKeyName(
  expression: bundledTs.Expression,
  api: TypeScriptApi,
): string | null {
  const node = unwrap(expression, api);
  if (api.isPropertyAccessExpression(node)) {
    return isEnvContainer(node.expression, api) ? node.name.text : null;
  }
  if (api.isElementAccessExpression(node)) {
    return isEnvContainer(node.expression, api)
      ? stringLiteralText(node.argumentExpression, api)
      : null;
  }
  if (api.isCallExpression(node)) {
    const callee = unwrap(node.expression, api);
    if (!api.isPropertyAccessExpression(callee) || callee.name.text !== "get") {
      return null;
    }
    if (!isEnvContainer(callee.expression, api)) {
      return null;
    }
    const first = node.arguments[0];
    return first === undefined ? null : stringLiteralText(first, api);
  }
  return null;
}

function isEnvContainer(expression: bundledTs.Expression, api: TypeScriptApi): boolean {
  const node = unwrap(expression, api);
  if (!api.isPropertyAccessExpression(node) || node.name.text !== "env") {
    return false;
  }
  const owner = unwrap(node.expression, api);
  if (api.isIdentifier(owner)) {
    return ENV_OWNERS.has(owner.text);
  }
  return api.isMetaProperty(owner);
}

/* -------------------------------------------------------------------------
 * Bindings given a literal default
 * ---------------------------------------------------------------------- */

function binding(
  name: string | null,
  value: bundledTs.Expression | undefined,
  node: bundledTs.Node,
  api: TypeScriptApi,
  suffixes: readonly string[],
): readonly SecretFinding[] {
  if (name === null || value === undefined || !isSecretName(name, suffixes)) {
    return [];
  }
  const fallback = bindingDefault(value, api, 0);
  return fallback === null ? [] : [{ name, fallback, node, fromEnv: false }];
}

/**
 * Destructuring defaults: `const { apiSecret = "" } = process.env`.
 *
 * Both halves of a renaming pattern are checked (`{ API_TOKEN: t = "" }`), so
 * a secret is caught whether the source key or the local name carries the
 * suffix. The source key is what gets reported, because that is the name an
 * operator has to go and set.
 */
function destructured(
  node: bundledTs.BindingElement,
  api: TypeScriptApi,
  suffixes: readonly string[],
): readonly SecretFinding[] {
  const initializer = node.initializer;
  if (initializer === undefined) {
    return [];
  }
  const property = node.propertyName === undefined ? null : nameText(node.propertyName, api);
  const bound = nameText(node.name, api);
  const secret =
    (property !== null && isSecretName(property, suffixes)) ||
    (bound !== null && isSecretName(bound, suffixes));
  const name = property ?? bound;
  if (!secret || name === null) {
    return [];
  }
  const fallback = bindingDefault(initializer, api, 0);
  return fallback === null ? [] : [{ name, fallback, node, fromEnv: false }];
}

/**
 * The literal a binding silently falls back to, or `null`.
 *
 * Three shapes count, and nothing else does:
 *
 *  - a string literal (or a substitution-free template);
 *  - the tail of a chained assignment, so `a = b = ""` is seen at both
 *    targets — the recall gap review found in the Python original;
 *  - a schema builder's `.default("…")`, anywhere in the call chain. This is
 *    the one place the TypeScript gate is strictly better than Python's,
 *    which documents Pydantic's `Field(default="")` as a miss. `z.string()
 *    .default("")` is purely syntactic, so reading it is not a guess.
 *
 * `?? someConstant`, a call, and `null`/`undefined` are all skipped:
 * resolving them needs data flow, and `null` is an honest way to say
 * "absent".
 */
function bindingDefault(
  expression: bundledTs.Expression,
  api: TypeScriptApi,
  depth: number,
): string | null {
  if (depth > MAX_CHAIN_DEPTH) {
    return null;
  }
  const node = unwrap(expression, api);
  const literal = stringLiteralText(node, api);
  if (literal !== null) {
    return literal;
  }
  if (
    api.isBinaryExpression(node) &&
    node.operatorToken.kind === api.SyntaxKind.EqualsToken
  ) {
    return bindingDefault(node.right, api, depth + 1);
  }
  return schemaDefault(node, api);
}

/** `z.string().default("")` and any other `.default(<literal>)` in a chain. */
function schemaDefault(expression: bundledTs.Expression, api: TypeScriptApi): string | null {
  let current: bundledTs.Expression = expression;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth += 1) {
    if (!api.isCallExpression(current)) {
      return null;
    }
    const callee = unwrap(current.expression, api);
    if (!api.isPropertyAccessExpression(callee)) {
      return null;
    }
    const argument = current.arguments[0];
    if (
      callee.name.text === "default" &&
      current.arguments.length === 1 &&
      argument !== undefined
    ) {
      const literal = stringLiteralText(argument, api);
      if (literal !== null) {
        return literal;
      }
    }
    current = unwrap(callee.expression, api);
  }
  return null;
}

/* -------------------------------------------------------------------------
 * The validate-after guard
 * ---------------------------------------------------------------------- */

/**
 * True when an empty env fallback is immediately proven fatal.
 *
 * This is the deliberate improvement over Python, which flags the read in
 * `x = getenv("X_SECRET", ""); if not x: raise` and tells you to restructure.
 * That code already does what the gate wants — it fails loudly at startup —
 * so reporting it trains people to suppress.
 *
 * The check is narrow enough to be sound in the flagging direction: the
 * fallback must be the initializer of a variable declaration, and the very
 * next statement in the same statement list must be an `if` that tests that
 * exact identifier for emptiness and unconditionally throws. Anything less
 * direct — a guard three statements later, a guard behind a helper, a guard
 * that logs instead of throwing — is NOT recognised and the finding stands.
 * Failing open on a secret is the outcome this gate exists to prevent.
 *
 * It applies only to an EMPTY fallback. After `?? "dev"` the same guard never
 * fires, so the read is still broken and is still reported.
 */
export function guardedByThrow(node: bundledTs.Node, api: TypeScriptApi): boolean {
  let current: bundledTs.Node = node;
  let parent: bundledTs.Node | undefined = current.parent;
  while (parent !== undefined && api.isParenthesizedExpression(parent)) {
    current = parent;
    parent = parent.parent;
  }
  if (parent === undefined || !api.isVariableDeclaration(parent)) {
    return false;
  }
  if (parent.initializer !== current || !api.isIdentifier(parent.name)) {
    return false;
  }
  const statement = parent.parent.parent;
  if (!api.isVariableStatement(statement)) {
    return false;
  }
  const next = statementAfter(statement, api);
  return next !== null && isEmptinessThrow(next, parent.name.text, api);
}

function statementAfter(
  statement: bundledTs.Statement,
  api: TypeScriptApi,
): bundledTs.Statement | null {
  const container = statement.parent;
  const statements =
    api.isBlock(container) || api.isSourceFile(container) || api.isModuleBlock(container)
      ? container.statements
      : null;
  if (statements === null) {
    return null;
  }
  const index = statements.indexOf(statement);
  if (index < 0) {
    return null;
  }
  return statements[index + 1] ?? null;
}

function isEmptinessThrow(
  statement: bundledTs.Statement,
  name: string,
  api: TypeScriptApi,
): boolean {
  if (!api.isIfStatement(statement)) {
    return false;
  }
  return testsEmpty(statement.expression, name, api) && throws(statement.thenStatement, api);
}

/** One operand paired with the other, so both orderings can be tried. */
type OperandPair = readonly [bundledTs.Expression, bundledTs.Expression];

/** The declared name of a binding or of a property. */
type DeclaredName = bundledTs.BindingName | bundledTs.PropertyName;

/** `!name`, `name === ""`, `"" == name`, `name.length === 0`. */
function testsEmpty(
  expression: bundledTs.Expression,
  name: string,
  api: TypeScriptApi,
): boolean {
  const node = unwrap(expression, api);
  if (api.isPrefixUnaryExpression(node)) {
    return (
      node.operator === api.SyntaxKind.ExclamationToken && isNamed(node.operand, name, api)
    );
  }
  if (!api.isBinaryExpression(node)) {
    return false;
  }
  const kind = node.operatorToken.kind;
  if (
    kind !== api.SyntaxKind.EqualsEqualsEqualsToken &&
    kind !== api.SyntaxKind.EqualsEqualsToken
  ) {
    return false;
  }
  const sides: readonly OperandPair[] = [
    [node.left, node.right],
    [node.right, node.left],
  ];
  return sides.some(([subject, expected]) => {
    if (isNamed(subject, name, api)) {
      return stringLiteralText(expected, api) === "";
    }
    const target = unwrap(subject, api);
    if (!api.isPropertyAccessExpression(target) || target.name.text !== "length") {
      return false;
    }
    const zero = unwrap(expected, api);
    return (
      isNamed(target.expression, name, api) &&
      api.isNumericLiteral(zero) &&
      Number(zero.text) === 0
    );
  });
}

function isNamed(
  expression: bundledTs.Expression,
  name: string,
  api: TypeScriptApi,
): boolean {
  const node = unwrap(expression, api);
  return api.isIdentifier(node) && node.text === name;
}

/** A `throw`, or a block with a `throw` among its own statements. */
function throws(statement: bundledTs.Statement, api: TypeScriptApi): boolean {
  if (api.isThrowStatement(statement)) {
    return true;
  }
  return (
    api.isBlock(statement) && statement.statements.some((inner) => api.isThrowStatement(inner))
  );
}

/* -------------------------------------------------------------------------
 * Small shared readers
 * ---------------------------------------------------------------------- */

/** The name an assignment target binds: `x`, `this.x`, `o["x"]`. */
function assignedName(
  expression: bundledTs.Expression,
  api: TypeScriptApi,
): string | null {
  const node = unwrap(expression, api);
  if (api.isIdentifier(node) || api.isPrivateIdentifier(node)) {
    return node.text;
  }
  if (api.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  if (api.isElementAccessExpression(node)) {
    return stringLiteralText(node.argumentExpression, api);
  }
  return null;
}

/** The declared name of a binding or property, when it is a readable one. */
function nameText(name: DeclaredName, api: TypeScriptApi): string | null {
  if (api.isIdentifier(name) || api.isPrivateIdentifier(name)) {
    return name.text;
  }
  if (api.isStringLiteral(name) || api.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  if (api.isComputedPropertyName(name)) {
    return stringLiteralText(name.expression, api);
  }
  return null;
}

/** The text of a string literal or substitution-free template, else `null`. */
function stringLiteralText(
  expression: bundledTs.Expression,
  api: TypeScriptApi,
): string | null {
  const node = unwrap(expression, api);
  if (api.isStringLiteral(node) || api.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

/** Strip wrappers that change nothing at runtime. */
function unwrap(expression: bundledTs.Expression, api: TypeScriptApi): bundledTs.Expression {
  let node: bundledTs.Expression = expression;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth += 1) {
    if (
      api.isParenthesizedExpression(node) ||
      api.isAsExpression(node) ||
      api.isSatisfiesExpression(node) ||
      api.isNonNullExpression(node) ||
      api.isTypeAssertionExpression(node)
    ) {
      node = node.expression;
      continue;
    }
    return node;
  }
  return node;
}
