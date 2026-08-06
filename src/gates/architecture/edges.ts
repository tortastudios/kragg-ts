/**
 * Every module-to-module dependency edge a file declares.
 *
 * WHY NOT JUST `ParsedSource.imports`. The shared import table is
 * local-binding -> `"<module>#<name>"`, which is the right shape for a
 * name-resolving gate and the wrong shape for this one: it carries no
 * type-only flag (so `layer-breach-type` could not exist), no source
 * positions (so every violation would point at the file and not the line),
 * and it deliberately drops side-effect imports, bare `export * from` and
 * dynamic `import()` because none of them bind a name. All three are real
 * dependency edges. So this walk collects edges directly — and `checkLayers`
 * then folds the shared table back in as a fail-closed cross-check, so a form
 * this walk misses still gets layer-checked. When `moduleImports` grows
 * position and type-only metadata, this walk should collapse into it.
 */

import type bundledTs from "typescript";

import type { TypeScriptApi } from "../../analysis/sourceFile.ts";

/** One name as it appears on both sides of a re-export or import. */
export interface NameLink {
  /** The name bound or exported in the importing module. */
  readonly here: string;
  /** The name as the TARGET module exports it. */
  readonly there: string;
}

/** The names an edge carries, or `"all"` when it cannot be narrowed. */
export type EdgeNames = readonly NameLink[] | "all";

/** A dependency on another module, with the metadata the layer rule needs. */
export interface ImportEdge {
  readonly specifier: string;
  /** `"all"` for namespace, default-only, side-effect, dynamic and `require` forms. */
  readonly names: EdgeNames;
  /** True when nothing is emitted: `import type`, or an all-`type` clause. */
  readonly typeOnly: boolean;
  /** 1-based line of the statement, or `undefined` when it is not known. */
  readonly line: number | undefined;
  /** True for `export ... from`, which is a layer breach exactly like an import. */
  readonly reExport: boolean;
}

/** How an edge learns the line it sits on. */
type LineOf = (node: bundledTs.Node) => number;

/** Every module-to-module edge in one file. */
export function importEdges(
  sourceFile: bundledTs.SourceFile,
  api: TypeScriptApi,
): readonly ImportEdge[] {
  const edges: ImportEdge[] = [];
  const lineOf: LineOf = (node) =>
    api.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile)).line + 1;

  const visit = (node: bundledTs.Node): void => {
    const edge = edgeFor(node, api, lineOf);
    if (edge !== null) {
      edges.push(edge);
    }
    api.forEachChild(node, visit);
  };
  api.forEachChild(sourceFile, visit);
  return edges;
}

/**
 * Classify one node as a dependency edge, or `null` if it is not one.
 *
 * Four shapes, one function each, because each reads a different clause off a
 * different node and they share nothing but their result.
 */
function edgeFor(
  node: bundledTs.Node,
  api: TypeScriptApi,
  lineOf: LineOf,
): ImportEdge | null {
  if (api.isImportDeclaration(node)) {
    return importEdge(node, api, lineOf);
  }
  if (api.isExportDeclaration(node)) {
    return reExportEdge(node, api, lineOf);
  }
  if (api.isImportEqualsDeclaration(node)) {
    return importEqualsEdge(node, api, lineOf);
  }
  if (api.isCallExpression(node)) {
    return callEdge(node, api, lineOf);
  }
  return null;
}

/** `import ... from "./x"`, in every clause form including the bare one. */
function importEdge(
  node: bundledTs.ImportDeclaration,
  api: TypeScriptApi,
  lineOf: LineOf,
): ImportEdge | null {
  const specifier = literalText(node.moduleSpecifier, api);
  if (specifier === null) {
    return null;
  }
  const clause = node.importClause;
  return {
    specifier,
    names: clause === undefined ? "all" : clauseNames(clause, api),
    typeOnly: clause !== undefined && isClauseTypeOnly(clause, api),
    line: lineOf(node),
    reExport: false,
  };
}

/**
 * `export ... from "./x"` — a layer breach exactly like an import, because the
 * re-exporting module has taken on the target's shape.
 *
 * An `export { a }` with no `from` is not an edge at all and yields `null`.
 */
function reExportEdge(
  node: bundledTs.ExportDeclaration,
  api: TypeScriptApi,
  lineOf: LineOf,
): ImportEdge | null {
  const moduleSpecifier = node.moduleSpecifier;
  if (moduleSpecifier === undefined) {
    return null;
  }
  const specifier = literalText(moduleSpecifier, api);
  if (specifier === null) {
    return null;
  }
  const clause = node.exportClause;
  const named = clause !== undefined && api.isNamedExports(clause);
  return {
    specifier,
    // `export * from` and `export * as ns from` both forward everything.
    names: named ? exportLinks(clause) : "all",
    typeOnly: node.isTypeOnly || (named && allTypeOnly(clause.elements)),
    line: lineOf(node),
    reExport: true,
  };
}

/** `import x = require("./y")`. */
function importEqualsEdge(
  node: bundledTs.ImportEqualsDeclaration,
  api: TypeScriptApi,
  lineOf: LineOf,
): ImportEdge | null {
  const reference = node.moduleReference;
  if (!api.isExternalModuleReference(reference)) {
    return null;
  }
  const specifier = literalText(reference.expression, api);
  return specifier === null
    ? null
    : { specifier, names: "all", typeOnly: node.isTypeOnly, line: lineOf(node), reExport: false };
}

/** `import("./x")` and `require("./x")` — both real runtime dependencies. */
function callEdge(
  node: bundledTs.CallExpression,
  api: TypeScriptApi,
  lineOf: LineOf,
): ImportEdge | null {
  const dynamic = node.expression.kind === api.SyntaxKind.ImportKeyword;
  const required =
    api.isIdentifier(node.expression) && node.expression.text === "require";
  if (!dynamic && !required) {
    return null;
  }
  const argument = node.arguments[0];
  if (argument === undefined) {
    return null;
  }
  const specifier = literalText(argument, api);
  return specifier === null
    ? null
    : { specifier, names: "all", typeOnly: false, line: lineOf(node), reExport: false };
}

function clauseNames(clause: bundledTs.ImportClause, api: TypeScriptApi): EdgeNames {
  const bindings = clause.namedBindings;
  if (bindings !== undefined && api.isNamespaceImport(bindings)) {
    // `import * as ns` depends on everything the target exports, so a barrel
    // chain reached this way cannot be narrowed by name.
    return "all";
  }
  if (bindings === undefined) {
    return clause.name === undefined ? "all" : [{ here: clause.name.text, there: "default" }];
  }
  const links: NameLink[] = bindings.elements.map((element) => ({
    here: element.name.text,
    there: element.propertyName?.text ?? element.name.text,
  }));
  if (clause.name !== undefined) {
    links.push({ here: clause.name.text, there: "default" });
  }
  return links;
}

function exportLinks(clause: bundledTs.NamedExports): readonly NameLink[] {
  return clause.elements.map((element) => ({
    // `export { a as b } from "./x"`: this module exports `b`, `./x` exports `a`.
    here: element.name.text,
    there: element.propertyName?.text ?? element.name.text,
  }));
}

/**
 * Whether an import clause emits nothing.
 *
 * `import type { A }` is type-only outright. `import { type A, type B }` is
 * type-only too — every specifier erases. `import { type A, b }` is NOT: `b`
 * is a runtime binding, so the edge is a value edge and gets the stronger
 * code.
 */
function isClauseTypeOnly(clause: bundledTs.ImportClause, api: TypeScriptApi): boolean {
  if (clause.isTypeOnly) {
    return true;
  }
  const bindings = clause.namedBindings;
  if (clause.name !== undefined || bindings === undefined || !api.isNamedImports(bindings)) {
    return false;
  }
  return allTypeOnly(bindings.elements);
}

/** An import or export specifier, reduced to the one flag that matters here. */
interface TypeOnlyFlagged {
  readonly isTypeOnly: boolean;
}

function allTypeOnly(elements: readonly TypeOnlyFlagged[]): boolean {
  return elements.length > 0 && elements.every((element) => element.isTypeOnly);
}

function literalText(node: bundledTs.Node, api: TypeScriptApi): string | null {
  return api.isStringLiteralLike(node) ? node.text : null;
}
