/**
 * The operator/operand partition, and the type syntax excluded from it.
 *
 * WHAT COULD NOT BE PORTED. Radon's partition is defined over the Python AST
 * and is deliberately narrow: it counts operators for `BinOp`, `UnaryOp`,
 * `BoolOp`, `AugAssign` and `Compare` and nothing else — a call, an attribute
 * access and a plain assignment contribute no operator at all. Reproducing
 * that literally in TypeScript would measure almost nothing, so this module
 * uses the CLASSIC Halstead partition instead. It counts strictly more than
 * radon does, which means volume, difficulty and effort all read HIGHER here
 * than radon would report for equivalent Python.
 */

import type ts from "typescript";

import type { TypeScriptApi } from "../../analysis/sourceFile.ts";

/**
 * Nodes that vanish at compile time and must not be counted.
 *
 * TYPE SYNTAX IS NOT CODE. Type annotations, type parameters, interfaces,
 * type aliases and type-only imports are skipped entirely. They are erased
 * before anything runs, so counting them would make a well-annotated function
 * look mentally harder than an unannotated one — the exact opposite of the
 * truth.
 *
 * `ExpressionWithTypeArguments` is deliberately NOT skipped even though it is
 * a type node by kind: it is how `class A extends B` spells `B`, which is a
 * value. `implements` clauses are dropped by `isTypeOnlyDeclaration` instead.
 */
export function isTypeOnlyNode(node: ts.Node, api: TypeScriptApi): boolean {
  if (node.kind === api.SyntaxKind.ExpressionWithTypeArguments) {
    return false;
  }
  if (api.isTypeNode(node)) {
    return true;
  }
  return isTypeOnlyKind(node.kind, api) || isTypeOnlyDeclaration(node, api);
}

/** Declarations that are wholly type-level, by kind alone. */
function isTypeOnlyKind(kind: ts.SyntaxKind, api: TypeScriptApi): boolean {
  const syntax = api.SyntaxKind;
  return (
    kind === syntax.InterfaceDeclaration ||
    kind === syntax.TypeAliasDeclaration ||
    kind === syntax.TypeParameter ||
    kind === syntax.IndexSignature ||
    kind === syntax.PropertySignature ||
    kind === syntax.MethodSignature
  );
}

/** The forms that erase only because they carry a `type` marker. */
function isTypeOnlyDeclaration(node: ts.Node, api: TypeScriptApi): boolean {
  if (api.isImportDeclaration(node)) {
    return node.importClause?.isTypeOnly === true;
  }
  if (api.isExportDeclaration(node)) {
    return node.isTypeOnly;
  }
  if (api.isImportSpecifier(node) || api.isExportSpecifier(node)) {
    return node.isTypeOnly;
  }
  if (api.isHeritageClause(node)) {
    return node.token === api.SyntaxKind.ImplementsKeyword;
  }
  return false;
}

/**
 * The operators contributed by a node — zero, one or more symbols.
 *
 * THE PARTITION, stated once so it can be argued with:
 *
 *  - every binary, unary and update operator, spelled as it is written
 *    (`+`, `===`, `&&`, `??`, `=`, `+=`, `instanceof`, `in`, `,`); unary
 *    forms are distinguished from binary ones (`u-` vs `-`), because `-x` and
 *    `a - b` are different operators to a reader;
 *  - the ternary `?:`, counted once;
 *  - call `()`, construction `new`, member access `.`, index access `[]`, and
 *    their optional-chaining forms `?.`, `?.()`, `?.[]` — separate symbols,
 *    since a short-circuiting access is a different operation;
 *  - the expression keywords `await`, `yield`, `typeof`, `void`, `delete`,
 *    and the spread `...`;
 *  - the composite literals `{}` (object), `[…]` (array), `` ` `` (template)
 *    and `${}` (one per interpolation);
 *  - every statement keyword that changes what executes, one per statement
 *    node: `if`, the five loop forms, `switch`, `case`, `default`, `try`,
 *    `catch`, `throw`, `return`, `break`, `continue`, `label:`;
 *  - the declaration keywords `const`/`let`/`var` (from the declaration
 *    list's flags), `=` for an initializer, `class`, `extends`, `import`,
 *    `export`, `enum`, `namespace`, and `@` for a decorator.
 *
 * DELIBERATELY NOT OPERATORS. Grouping parentheses, semicolons and the braces
 * of a block: punctuation, not operations. A bare `else` and a `finally`:
 * neither is a choice, they are the continuation of the `if`/`try` already
 * counted. ALL MODIFIERS, including the `export` in `export function f` —
 * `async`, `static`, `readonly` and the visibility keywords are declaration
 * decoration with no Python analogue. (An `export`/`import` STATEMENT is a
 * different node and does count.) And the non-null `!`, `as` and `satisfies`,
 * which are type assertions erased before anything runs.
 */
export function operatorsOf(node: ts.Node, api: TypeScriptApi): readonly string[] {
  const expression = expressionOperators(node, api);
  if (expression !== null) {
    return expression;
  }
  const keyword = keywordOperator(node, api);
  return keyword === null ? [] : [keyword];
}

/** The operator an expression node spells, or `null` if it is not one. */
function expressionOperators(node: ts.Node, api: TypeScriptApi): readonly string[] | null {
  return arityOperators(node, api) ?? accessOperators(node, api);
}

/** Operators identified by how many operands they take. */
function arityOperators(node: ts.Node, api: TypeScriptApi): readonly string[] | null {
  if (api.isBinaryExpression(node)) {
    return [api.tokenToString(node.operatorToken.kind) ?? "?"];
  }
  if (api.isPrefixUnaryExpression(node)) {
    return [`u${api.tokenToString(node.operator) ?? "?"}`];
  }
  if (api.isPostfixUnaryExpression(node)) {
    return [`${api.tokenToString(node.operator) ?? "?"}u`];
  }
  return api.isConditionalExpression(node) ? ["?:"] : null;
}

/** Call, member and index access, plus the template literal that reads alike. */
function accessOperators(node: ts.Node, api: TypeScriptApi): readonly string[] | null {
  if (api.isCallExpression(node)) {
    return [node.questionDotToken === undefined ? "()" : "?.()"];
  }
  if (api.isPropertyAccessExpression(node)) {
    return [node.questionDotToken === undefined ? "." : "?."];
  }
  if (api.isElementAccessExpression(node)) {
    return [node.questionDotToken === undefined ? "[]" : "?.[]"];
  }
  if (api.isTemplateExpression(node)) {
    return ["`", ...node.templateSpans.map(() => "${}")];
  }
  return null;
}

/**
 * Keyword- and literal-form operators, resolved by node kind.
 *
 * A `switch` over `api.SyntaxKind` values rather than a lookup table, because
 * the kind numbers belong to the resolved compiler instance and must not be
 * captured in module-level state that could outlive it.
 */
function keywordOperator(node: ts.Node, api: TypeScriptApi): string | null {
  const kind = node.kind;
  const syntax = api.SyntaxKind;
  if (api.isVariableDeclarationList(node)) {
    return declarationKeyword(node, api);
  }
  if (api.isVariableDeclaration(node) || api.isBindingElement(node)) {
    // The binding itself is not an operator; its initializer's `=` is.
    return node.initializer === undefined ? null : "=";
  }
  switch (kind) {
    case syntax.NewExpression:
      return "new";
    case syntax.TaggedTemplateExpression:
      return "tag``";
    case syntax.AwaitExpression:
      return "await";
    case syntax.YieldExpression:
      return "yield";
    case syntax.TypeOfExpression:
      return "typeof";
    case syntax.VoidExpression:
      return "void";
    case syntax.DeleteExpression:
      return "delete";
    case syntax.SpreadElement:
    case syntax.SpreadAssignment:
      return "...";
    case syntax.ObjectLiteralExpression:
      return "{}";
    case syntax.ArrayLiteralExpression:
      return "[…]";
    case syntax.PropertyAssignment:
      return ":";
    case syntax.Decorator:
      return "@";
    default:
      return statementOperator(kind, api);
  }
}

/** `const`, `let` or `var`, read from the declaration list's node flags. */
function declarationKeyword(node: ts.VariableDeclarationList, api: TypeScriptApi): string {
  if ((node.flags & api.NodeFlags.Const) !== 0) {
    return "const";
  }
  if ((node.flags & api.NodeFlags.Let) !== 0) {
    return "let";
  }
  return "var";
}

function statementOperator(kind: ts.SyntaxKind, api: TypeScriptApi): string | null {
  const syntax = api.SyntaxKind;
  switch (kind) {
    case syntax.IfStatement:
      return "if";
    case syntax.ForStatement:
      return "for";
    case syntax.ForInStatement:
      return "for-in";
    case syntax.ForOfStatement:
      return "for-of";
    case syntax.WhileStatement:
      return "while";
    case syntax.DoStatement:
      return "do";
    case syntax.SwitchStatement:
      return "switch";
    case syntax.CaseClause:
      return "case";
    case syntax.DefaultClause:
      return "default";
    case syntax.TryStatement:
      return "try";
    case syntax.CatchClause:
      return "catch";
    case syntax.ThrowStatement:
      return "throw";
    case syntax.ReturnStatement:
      return "return";
    case syntax.BreakStatement:
      return "break";
    case syntax.ContinueStatement:
      return "continue";
    case syntax.LabeledStatement:
      return "label:";
    case syntax.ClassDeclaration:
    case syntax.ClassExpression:
      return "class";
    case syntax.HeritageClause:
      return "extends";
    case syntax.ImportDeclaration:
    case syntax.ImportEqualsDeclaration:
      return "import";
    case syntax.ExportDeclaration:
    case syntax.ExportAssignment:
      return "export";
    case syntax.EnumDeclaration:
      return "enum";
    case syntax.ModuleDeclaration:
      return "namespace";
    default:
      return null;
  }
}

/**
 * The operands contributed by a node: identifiers and literals, plus the
 * value keywords (`this`, `super`, `true`, `false`, `null`) which name a
 * value exactly as an identifier does.
 *
 * Operands are keyed by their SOURCE TEXT, so `count` in two different
 * functions is one distinct operand at file level and one in each block —
 * matching radon, which keys operands by `(context, value)`.
 *
 * String and template literals are keyed with a quote prefix so that the
 * string `"x"` and the identifier `x` are not conflated.
 */
export function operandsOf(node: ts.Node, api: TypeScriptApi): readonly string[] {
  if (api.isIdentifier(node) || api.isPrivateIdentifier(node)) {
    return [node.text];
  }
  if (api.isNumericLiteral(node) || api.isBigIntLiteral(node)) {
    return [node.text];
  }
  if (api.isStringLiteralLike(node)) {
    return [`"${node.text}"`];
  }
  if (api.isRegularExpressionLiteral(node)) {
    return [node.text];
  }
  if (api.isTemplateLiteralToken(node)) {
    // The literal chunks of a template: `` `a${x}b` `` has operands "a", x, "b".
    // Empty chunks name nothing and are dropped.
    return node.text === "" ? [] : [`"${node.text}"`];
  }
  return valueKeywordOperand(node.kind, api);
}

function valueKeywordOperand(kind: ts.SyntaxKind, api: TypeScriptApi): readonly string[] {
  const syntax = api.SyntaxKind;
  switch (kind) {
    case syntax.TrueKeyword:
      return ["true"];
    case syntax.FalseKeyword:
      return ["false"];
    case syntax.NullKeyword:
      return ["null"];
    case syntax.ThisKeyword:
      return ["this"];
    case syntax.SuperKeyword:
      return ["super"];
    default:
      return [];
  }
}
