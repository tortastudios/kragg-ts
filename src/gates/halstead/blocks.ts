/**
 * What counts as a measurable function block, and what it is called.
 *
 * Shared with the complexity gate, which needs the same notion of "a block" so
 * that `radon-cc` and `halstead` never disagree about what a function is, and
 * report the same identifiers when they do disagree about a score.
 */

import type ts from "typescript";

import type { TypeScriptApi } from "../../analysis/sourceFile.ts";

/** A function-like node that has a body, and so can be measured. */
export type FunctionBlockNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

/**
 * Whether this node is a measurable function block.
 *
 * Overload signatures and ambient declarations have no body and are excluded:
 * there is nothing in them to measure.
 */
export function isFunctionBlock(
  node: ts.Node,
  api: TypeScriptApi,
): node is FunctionBlockNode {
  return (
    api.isFunctionDeclaration(node) ||
    api.isFunctionExpression(node) ||
    api.isArrowFunction(node) ||
    api.isMethodDeclaration(node) ||
    api.isConstructorDeclaration(node) ||
    api.isGetAccessorDeclaration(node) ||
    api.isSetAccessorDeclaration(node)
  );
}

/**
 * The local name of a function block.
 *
 * TypeScript's most common function is anonymous — an arrow bound to a
 * `const`, a property or a callback argument — so a name is INFERRED from the
 * parent binding wherever one exists. `<anonymous>` is the honest answer for a
 * callback passed inline, and it is far better than dropping the block: an
 * unnamed 200-line callback is exactly the code this gate exists to find.
 */
export function functionBlockLabel(
  node: FunctionBlockNode,
  api: TypeScriptApi,
): string {
  if (api.isConstructorDeclaration(node)) {
    return "constructor";
  }
  const own = node.name;
  if (own !== undefined) {
    const text = propertyNameText(own, api);
    const bare = text ?? "<computed>";
    if (api.isGetAccessorDeclaration(node)) {
      return `get ${bare}`;
    }
    if (api.isSetAccessorDeclaration(node)) {
      return `set ${bare}`;
    }
    return bare;
  }
  return inferredLabel(node, api);
}

function propertyNameText(name: ts.PropertyName, api: TypeScriptApi): string | null {
  if (api.isIdentifier(name) || api.isPrivateIdentifier(name)) {
    return name.text;
  }
  if (api.isStringLiteral(name) || api.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

/**
 * The name of the binding an anonymous function is attached to.
 *
 * Two shapes, kept apart because they answer different questions: a
 * DECLARATION binds the function to a name it owns, while an ASSIGNMENT
 * writes it into a name that already exists.
 */
function inferredLabel(node: FunctionBlockNode, api: TypeScriptApi): string {
  const parent: ts.Node | undefined = node.parent;
  if (parent === undefined) {
    return "<anonymous>";
  }
  return declarationLabel(parent, api) ?? assignmentLabel(parent, api) ?? "<anonymous>";
}

/** `const f = () => {}`, `{ f: () => {} }`, `class { f = () => {} }`. */
function declarationLabel(parent: ts.Node, api: TypeScriptApi): string | null {
  if (api.isVariableDeclaration(parent) && api.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (api.isPropertyAssignment(parent) || api.isPropertyDeclaration(parent)) {
    return propertyNameText(parent.name, api);
  }
  return null;
}

/** `f = () => {}`, `a.f = () => {}`, `export default () => {}`. */
function assignmentLabel(parent: ts.Node, api: TypeScriptApi): string | null {
  if (api.isExportAssignment(parent)) {
    return "default";
  }
  if (!api.isBinaryExpression(parent)) {
    return null;
  }
  const left = parent.left;
  if (api.isIdentifier(left)) {
    return left.text;
  }
  return api.isPropertyAccessExpression(left) ? left.name.text : null;
}
