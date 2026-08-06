/**
 * What the registration pass learns, and the naming rules it learns it under.
 *
 * NAMING. Nodes are `"<module>#<qualified.name>"`, e.g.
 * `src/gates/criticality/graph#buildCallGraph` or `src/engine/gate#Pipeline.run`.
 * The `#` separator is the same one `moduleImports` already uses, and it is
 * unambiguous in a world where module names contain `/` and `.`. This diverges
 * from Python's dotted `kragg.gates.criticality.build_call_graph` because a
 * TypeScript module specifier is a path, not a dotted package name.
 */

import type bundledTs from "typescript";

import type { TypeScriptApi } from "../../analysis/sourceFile.ts";

/** Separator between a module name and a symbol's qualified name. */
const QUALIFIER = "#";

/**
 * What pass 1 learns, and pass 2 consults.
 *
 * `functions` and `bodies` are keyed by different nodes on purpose.
 * `functions` maps a node a SYMBOL can declare (`checker` hands back the
 * variable declaration for `const f = () => {}`, never the arrow), while
 * `bodies` maps the node whose subtree contains the calls to attribute.
 */
export interface Scope {
  readonly api: TypeScriptApi;
  /** Declaration node -> qualified name of the function it declares. */
  readonly functions: Map<bundledTs.Node, string>;
  /** Declaration node -> qualified name of the class it declares. */
  readonly classes: Map<bundledTs.Node, string>;
  /** Class declaration node -> qualified name of its declared constructor. */
  readonly constructors: Map<bundledTs.Node, string>;
  /** Function-like node -> the name its inner calls are attributed to. */
  readonly bodies: Map<bundledTs.Node, string>;
  /** Every registered function name, for seeding the graph. */
  readonly names: Set<string>;
}

/** An empty scope, ready for the registration pass. */
export function newScope(api: TypeScriptApi): Scope {
  return {
    api,
    functions: new Map(),
    classes: new Map(),
    constructors: new Map(),
    bodies: new Map(),
    names: new Set(),
  };
}

export function recordFunction(
  scope: Scope,
  declaration: bundledTs.Node,
  body: bundledTs.Node,
  name: string,
): void {
  // Overload signatures share a name with their implementation; every one of
  // them maps to the same node, which is what we want.
  scope.names.add(name);
  scope.functions.set(declaration, name);
  scope.bodies.set(body, name);
}

export function qualify(module: string, path: readonly string[], name: string): string {
  return `${module}${QUALIFIER}${[...path, name].join(".")}`;
}

export function functionDeclarationName(
  api: TypeScriptApi,
  node: bundledTs.FunctionDeclaration,
): string | null {
  return node.name?.text ?? (isDefaultExport(api, node) ? "default" : null);
}

export function isDefaultExport(api: TypeScriptApi, node: bundledTs.Declaration): boolean {
  return (api.getCombinedModifierFlags(node) & api.ModifierFlags.Default) !== 0;
}

/**
 * A member's name as written, or `null` for a computed one.
 *
 * A computed name (`[key]() {}`) is not statically a name, so the member is
 * not a node. Private names keep their `#`, which is exactly how they read in
 * a report.
 */
export function propertyName(
  api: TypeScriptApi,
  name: bundledTs.PropertyName | undefined,
): string | null {
  if (name === undefined) {
    return null;
  }
  if (api.isIdentifier(name) || api.isPrivateIdentifier(name)) {
    return name.text;
  }
  if (api.isStringLiteralLike(name) || api.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

export function isFunctionLike(api: TypeScriptApi, node: bundledTs.Node): boolean {
  return (
    api.isArrowFunction(node) ||
    api.isFunctionExpression(node) ||
    api.isFunctionDeclaration(node) ||
    api.isMethodDeclaration(node) ||
    api.isConstructorDeclaration(node) ||
    api.isGetAccessorDeclaration(node) ||
    api.isSetAccessorDeclaration(node)
  );
}
