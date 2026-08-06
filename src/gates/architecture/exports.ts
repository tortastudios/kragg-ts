/**
 * Every name a module DECLARES public — the syntactic half of a module's
 * surface.
 *
 * This module is pure: it reads one already-parsed file and touches nothing
 * else. A bare `export * from "./x"` therefore contributes nothing HERE,
 * because enumerating it means resolving and parsing another file. That is
 * `starExports.ts`'s job, and `exportSurface` there is what the symbol budget
 * and the barrel walk both call — this function alone is a LOWER BOUND on a
 * module's surface and must not be used as a budget input on its own.
 */

import type bundledTs from "typescript";

import type { TypeScriptApi } from "../../analysis/sourceFile.ts";

/**
 * Every name this module makes public, as the names an importer would write.
 *
 * THIS IS ONE OF THE PLACES TYPESCRIPT IS STRONGER THAN THE PYTHON ORIGINAL.
 * `_public_symbols` in `architecture.py` guesses: it counts module-level
 * `def`/`class` whose name does not start with `_`, which is a naming
 * convention, not a declaration. It over-counts anything absent from
 * `__all__` and under-counts a re-export. TypeScript has a real `export`
 * keyword, so this counts declared public API rather than inferring it, and
 * the budget means what it says.
 *
 * Types and interfaces COUNT. `export interface Foo` is public API surface in
 * every sense that matters — it is imported by name, it appears in the
 * `.d.ts`, and changing it breaks consumers. A budget that ignored it would
 * be trivially gamed by a module that exposes twenty types and one function.
 *
 * A Set, so a symbol both declared and listed (`export function a` plus
 * `export { a }`) counts once, and so `export *` can be intersected against
 * it when a barrel chain is followed.
 *
 * `default` and `export=` appear in this set as themselves. `starExports.ts`
 * drops them when it merges a target's surface, because a bare `export *`
 * forwards neither.
 */
export function exportedNames(
  sourceFile: bundledTs.SourceFile,
  api: TypeScriptApi,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (api.isExportAssignment(statement)) {
      // `export default expr` and the CommonJS `export = expr`.
      names.add(statement.isExportEquals === true ? "export=" : "default");
      continue;
    }
    if (api.isExportDeclaration(statement)) {
      addExportClause(names, statement, api);
      continue;
    }
    if (!hasModifier(statement, api, api.SyntaxKind.ExportKeyword)) {
      continue;
    }
    if (hasModifier(statement, api, api.SyntaxKind.DefaultKeyword)) {
      names.add("default");
      continue;
    }
    addDeclaredName(names, statement, api);
  }
  return names;
}

/**
 * `export { a as b }` / `export * as ns from "./x"`.
 *
 * `export * as ns` adds EXACTLY ONE name — `ns` — because it binds a namespace
 * object whose members are properties, not importable names. A bare
 * `export *` has no clause and is left to `starExports.ts`.
 */
function addExportClause(
  names: Set<string>,
  node: bundledTs.ExportDeclaration,
  api: TypeScriptApi,
): void {
  const clause = node.exportClause;
  if (clause === undefined) {
    return;
  }
  if (api.isNamespaceExport(clause)) {
    names.add(clause.name.text);
    return;
  }
  for (const element of clause.elements) {
    // The EXPORTED name, not the local one: that is what an importer writes.
    names.add(element.name.text);
  }
}

/** The name bound by an exported declaration statement, if it has one. */
function addDeclaredName(
  names: Set<string>,
  statement: bundledTs.Statement,
  api: TypeScriptApi,
): void {
  if (api.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      addBindingNames(names, declaration.name, api);
    }
    return;
  }
  const name = declaredName(statement, api);
  if (name !== null) {
    names.add(name);
  }
}

/** The single name an exported non-variable declaration binds. */
function declaredName(
  statement: bundledTs.Statement,
  api: TypeScriptApi,
): string | null {
  if (api.isFunctionDeclaration(statement) || api.isClassDeclaration(statement)) {
    return statement.name?.text ?? null;
  }
  if (
    api.isInterfaceDeclaration(statement) ||
    api.isTypeAliasDeclaration(statement) ||
    api.isEnumDeclaration(statement) ||
    api.isImportEqualsDeclaration(statement)
  ) {
    return statement.name.text;
  }
  return api.isModuleDeclaration(statement) ? statement.name.text : null;
}

/** Every identifier bound by a binding name, destructuring patterns included. */
function addBindingNames(
  names: Set<string>,
  name: bundledTs.BindingName,
  api: TypeScriptApi,
): void {
  if (api.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!api.isOmittedExpression(element)) {
      addBindingNames(names, element.name, api);
    }
  }
}

/** True when a statement carries the given modifier keyword. */
function hasModifier(
  node: bundledTs.Node,
  api: TypeScriptApi,
  kind: bundledTs.SyntaxKind,
): boolean {
  if (!api.canHaveModifiers(node)) {
    return false;
  }
  return api.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true;
}
