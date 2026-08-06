/**
 * Pass 1 of the call graph: find every declaration that is a graph node.
 *
 * WHAT COUNTS AS A NODE. Module-level functions, class methods, constructors,
 * accessors, object-literal methods, and — deliberately — ARROW FUNCTIONS AND
 * FUNCTION EXPRESSIONS BOUND TO A MODULE-LEVEL `const` OR A CLASS PROPERTY.
 * `export const check = (): GateResult => ...` is the dominant idiom in
 * TypeScript; excluding it would gut the graph and make this gate report
 * confidently on a fiction. Functions nested INSIDE another function body are
 * not nodes — their calls are attributed to the enclosing node — which is also
 * what Python does (`_index_definitions` never recurses into a `FunctionDef`).
 */

import type bundledTs from "typescript";

import {
  functionDeclarationName,
  isDefaultExport,
  isFunctionLike,
  propertyName,
  qualify,
  recordFunction,
  type Scope,
} from "./scope.ts";

/**
 * Register the declarations under one node.
 *
 * Descent stops at any function-like node that was not reached through a
 * recognised binding. That is what keeps a locally-scoped
 * `const helper = () => {}` inside a function body out of the graph while
 * keeping the module-level one in — and it matches Python, whose
 * `_index_definitions` never recurses into a `FunctionDef`.
 */
export function registerNode(
  scope: Scope,
  node: bundledTs.Node,
  module: string,
  path: readonly string[],
): void {
  const api = scope.api;
  if (api.isFunctionDeclaration(node)) {
    registerFunction(scope, node, module, path);
    return;
  }
  if (api.isClassDeclaration(node)) {
    registerClassDeclaration(scope, node, module, path);
    return;
  }
  if (api.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      registerVariable(scope, declaration, module, path);
    }
    return;
  }
  if (api.isExportAssignment(node)) {
    registerExportAssignment(scope, node, module, path);
    return;
  }
  if (api.isModuleDeclaration(node)) {
    registerModule(scope, node, module, path);
    return;
  }
  if (isFunctionLike(api, node)) {
    // An anonymous body reached by generic descent — an inline callback, an
    // IIFE. Nothing inside it is a graph node, so do not walk in.
    return;
  }
  api.forEachChild(node, (child) => {
    registerNode(scope, child, module, path);
  });
}

function registerFunction(
  scope: Scope,
  node: bundledTs.FunctionDeclaration,
  module: string,
  path: readonly string[],
): void {
  const name = functionDeclarationName(scope.api, node);
  if (name !== null) {
    recordFunction(scope, node, node, qualify(module, path, name));
  }
}

function registerClassDeclaration(
  scope: Scope,
  node: bundledTs.ClassDeclaration,
  module: string,
  path: readonly string[],
): void {
  const name = node.name?.text ?? (isDefaultExport(scope.api, node) ? "default" : null);
  if (name !== null) {
    registerClass(scope, node, [node], module, path, name);
  }
}

/** `namespace Foo { ... }` is a container, exactly like a class. */
function registerModule(
  scope: Scope,
  node: bundledTs.ModuleDeclaration,
  module: string,
  path: readonly string[],
): void {
  const body = node.body;
  if (body === undefined || !scope.api.isModuleBlock(body)) {
    return;
  }
  const inner = [...path, node.name.text];
  for (const statement of body.statements) {
    registerNode(scope, statement, module, inner);
  }
}

/**
 * Register a `const`/`let`/`var` binding, when it binds something callable.
 *
 * Destructuring binds no single name we could qualify, so it is skipped — a
 * `const { a } = require("x")` re-export is not a function DEFINITION here.
 */
function registerVariable(
  scope: Scope,
  declaration: bundledTs.VariableDeclaration,
  module: string,
  path: readonly string[],
): void {
  const api = scope.api;
  const initializer = declaration.initializer;
  if (!api.isIdentifier(declaration.name) || initializer === undefined) {
    return;
  }
  const name = declaration.name.text;
  if (api.isArrowFunction(initializer) || api.isFunctionExpression(initializer)) {
    recordFunction(scope, declaration, initializer, qualify(module, path, name));
    return;
  }
  if (api.isClassExpression(initializer)) {
    // Both nodes are registered: the checker reports the VARIABLE declaration
    // for `const Foo = class {}`, never the class expression.
    registerClass(scope, initializer, [declaration, initializer], module, path, name);
    return;
  }
  if (api.isObjectLiteralExpression(initializer)) {
    registerObjectLiteral(scope, initializer, module, [...path, name]);
  }
}

/** `export default function`/`class` reach here already named; this is the rest. */
function registerExportAssignment(
  scope: Scope,
  node: bundledTs.ExportAssignment,
  module: string,
  path: readonly string[],
): void {
  const api = scope.api;
  const expression = node.expression;
  if (api.isArrowFunction(expression) || api.isFunctionExpression(expression)) {
    recordFunction(scope, node, expression, qualify(module, path, "default"));
    return;
  }
  if (api.isClassExpression(expression)) {
    registerClass(scope, expression, [node, expression], module, path, "default");
    return;
  }
  if (api.isObjectLiteralExpression(expression)) {
    registerObjectLiteral(scope, expression, module, [...path, "default"]);
  }
}

/**
 * Register a class and its callable members.
 *
 * `declarations` is every node the checker might report for this class, so a
 * `new Foo()` resolves whichever way the class was written.
 *
 * Constructors become `<Class>.constructor`, the analogue of Python's
 * `Class.__init__`. A `new Foo()` on a class with NO declared constructor
 * points at the class node itself, again mirroring Python's `_constructor`
 * fallback — which means such a class becomes a graph node the moment anyone
 * constructs it, and stays absent otherwise.
 */
function registerClass(
  scope: Scope,
  node: bundledTs.ClassLikeDeclaration,
  declarations: readonly bundledTs.Node[],
  module: string,
  path: readonly string[],
  name: string,
): void {
  const qualified = qualify(module, path, name);
  for (const declaration of declarations) {
    scope.classes.set(declaration, qualified);
  }
  const inner = [...path, name];

  for (const member of node.members) {
    if (scope.api.isConstructorDeclaration(member)) {
      registerConstructor(scope, member, declarations, module, inner);
      continue;
    }
    registerMember(scope, member, module, inner);
  }
}

function registerConstructor(
  scope: Scope,
  member: bundledTs.ConstructorDeclaration,
  declarations: readonly bundledTs.Node[],
  module: string,
  inner: readonly string[],
): void {
  const constructorName = qualify(module, inner, "constructor");
  recordFunction(scope, member, member, constructorName);
  for (const declaration of declarations) {
    scope.constructors.set(declaration, constructorName);
  }
}

/**
 * Register one non-constructor class member, if it is callable.
 *
 * Accessors are prefixed so a `get x` and a `set x` on the same class stay
 * distinct nodes; collapsing them would merge two different bodies.
 */
function registerMember(
  scope: Scope,
  member: bundledTs.ClassElement,
  module: string,
  inner: readonly string[],
): void {
  const api = scope.api;
  const memberName = propertyName(api, member.name);
  if (memberName === null) {
    return;
  }
  if (api.isMethodDeclaration(member)) {
    recordFunction(scope, member, member, qualify(module, inner, memberName));
    return;
  }
  if (api.isGetAccessorDeclaration(member)) {
    recordFunction(scope, member, member, qualify(module, inner, `get ${memberName}`));
    return;
  }
  if (api.isSetAccessorDeclaration(member)) {
    recordFunction(scope, member, member, qualify(module, inner, `set ${memberName}`));
    return;
  }
  if (!api.isPropertyDeclaration(member)) {
    return;
  }
  const initializer = member.initializer;
  if (
    initializer !== undefined &&
    (api.isArrowFunction(initializer) || api.isFunctionExpression(initializer))
  ) {
    recordFunction(scope, member, initializer, qualify(module, inner, memberName));
  }
}

/**
 * Register the methods of an object literal bound to a name.
 *
 * `const gate = { run() {}, help: () => {} }` is a common shape for a
 * collection of related functions, and both spellings are nodes. A
 * shorthand property (`{ run }`) is an alias for a binding registered
 * elsewhere, so it is not a second definition.
 */
function registerObjectLiteral(
  scope: Scope,
  literal: bundledTs.ObjectLiteralExpression,
  module: string,
  path: readonly string[],
): void {
  for (const property of literal.properties) {
    registerProperty(scope, property, module, path);
  }
}

function registerProperty(
  scope: Scope,
  property: bundledTs.ObjectLiteralElementLike,
  module: string,
  path: readonly string[],
): void {
  const api = scope.api;
  const name = propertyName(api, property.name);
  if (name === null) {
    return;
  }
  if (api.isMethodDeclaration(property)) {
    recordFunction(scope, property, property, qualify(module, path, name));
    return;
  }
  if (api.isGetAccessorDeclaration(property)) {
    recordFunction(scope, property, property, qualify(module, path, `get ${name}`));
    return;
  }
  if (api.isSetAccessorDeclaration(property)) {
    recordFunction(scope, property, property, qualify(module, path, `set ${name}`));
    return;
  }
  if (!api.isPropertyAssignment(property)) {
    return;
  }
  const initializer = property.initializer;
  if (api.isArrowFunction(initializer) || api.isFunctionExpression(initializer)) {
    recordFunction(scope, property, initializer, qualify(module, path, name));
    return;
  }
  if (api.isObjectLiteralExpression(initializer)) {
    registerObjectLiteral(scope, initializer, module, [...path, name]);
  }
}
