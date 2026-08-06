/**
 * The per-module import table: local binding -> what it refers to.
 *
 * Split out of `sourceFile.ts`, which re-exports `moduleImports`. This is the
 * data every name-resolving gate joins against, so the recorders below are
 * deliberately narrow: each handles exactly the syntax it can read statically
 * and records nothing for the rest.
 */

import type bundledTs from "typescript";

import type { TypeScriptApi } from "./compiler.ts";
import { resolveSpecifier } from "./modulePath.ts";

/**
 * Build the local-binding -> target table for one module.
 *
 * The analogue of `module_imports` in `criticality.py`. Targets are written
 * `"<module>#<exportedName>"`, with three reserved export names:
 *
 *  - `#default` for a default import,
 *  - `#*` for a namespace import (`import * as ns`),
 *  - `#=` for a CommonJS `const x = require("y")` whole-module binding.
 *
 * `<module>` is a module NAME for a relative specifier — resolved against the
 * importing file and normalized by the same rules as `moduleName`, so
 * `import { a } from "./foo.ts"` inside `src/bar.ts` becomes `src/foo#a` and
 * joins against the `module` field of another `ParsedSource`. A bare
 * specifier is kept verbatim (`node:fs#readFileSync`), which is what a
 * forbidden-call gate wants to match on.
 *
 * Handled: default, named (with `as` aliases), namespace, `import type` and
 * per-specifier `type` modifiers, `export ... from` re-exports, and
 * `require()` in the two shapes that are unambiguous.
 *
 * Type-only imports ARE recorded. They bind a name in type position, and the
 * gates that care most about the import table (layering, forbidden
 * dependencies) count a type-only edge as a dependency edge — importing a
 * type across a layer boundary is still a boundary crossing.
 *
 * FIRST WRITE WINS. Real local bindings are visited before re-export
 * aliases in source order only by luck, so the map refuses overwrites: a
 * genuine `import { x }` is never clobbered by an `export { y as x } from`
 * alias, which is the one collision that can actually occur.
 *
 * TODO(resolution): relative specifiers are resolved by path arithmetic, not
 * by real module resolution. That means tsconfig `paths` aliases (`@/foo`),
 * `baseUrl`, package `exports` subpaths, and barrel files (`./index.ts`
 * re-exporting a tree) are NOT resolved — an aliased specifier stays verbatim
 * and will not join against any module name. Fixing it properly means
 * `ts.resolveModuleName` with the parsed compiler options, which is the
 * program tier's data; the clean design is for `program.ts` to hand this
 * function a resolver callback once the program exists, and for the syntax
 * tier to keep the path-arithmetic behaviour when it does not. Half-solving
 * it — special-casing `@/` say — would silently mis-resolve the projects that
 * configure aliases differently, which is worse than not resolving at all.
 *
 * TODO(dynamic): `await import("./x")` and `require` behind a variable are
 * not recorded. They bind no name statically, so there is nothing to put in
 * the table; a gate that needs them wants a call-site walk, not this map.
 */
export function moduleImports(
  module: string,
  sourceFile: bundledTs.SourceFile,
  api: TypeScriptApi,
): ReadonlyMap<string, string> {
  const imports = new Map<string, string>();
  const record = (local: string, target: string): void => {
    if (local !== "" && !imports.has(local)) {
      imports.set(local, target);
    }
  };

  const visit = (node: bundledTs.Node): void => {
    if (api.isImportDeclaration(node)) {
      recordImportDeclaration(record, module, node, api);
    } else if (api.isExportDeclaration(node)) {
      recordExportDeclaration(record, module, node, api);
    } else if (api.isVariableDeclaration(node)) {
      recordRequire(record, module, node, api);
    }
    api.forEachChild(node, visit);
  };
  api.forEachChild(sourceFile, visit);
  return imports;
}

type Recorder = (local: string, target: string) => void;

function recordImportDeclaration(
  record: Recorder,
  module: string,
  node: bundledTs.ImportDeclaration,
  api: TypeScriptApi,
): void {
  const specifier = stringLiteralText(node.moduleSpecifier, api);
  if (specifier === null) {
    return;
  }
  const target = resolveSpecifier(module, specifier);
  const clause = node.importClause;
  if (clause === undefined) {
    // `import "./side-effect.ts"` binds nothing. Deliberately not recorded:
    // there is no local name, and inventing one would pollute the table.
    return;
  }
  if (clause.name !== undefined) {
    record(clause.name.text, `${target}#default`);
  }
  const bindings = clause.namedBindings;
  if (bindings === undefined) {
    return;
  }
  if (api.isNamespaceImport(bindings)) {
    record(bindings.name.text, `${target}#*`);
    return;
  }
  for (const element of bindings.elements) {
    const exported = element.propertyName?.text ?? element.name.text;
    record(element.name.text, `${target}#${exported}`);
  }
}

/**
 * `export { a as b } from "./x"` binds no LOCAL name — `b` is an export of
 * this module, not an identifier in its scope. It is recorded anyway, and
 * that is a deliberate, narrow choice: a name-based resolver looking up
 * `<this module>.b` needs the edge to `./x#a` or barrel files break every
 * cross-module lookup. `export * from` is skipped: it names nothing, and
 * expanding it needs the other module's export list, which is program-tier
 * information.
 */
function recordExportDeclaration(
  record: Recorder,
  module: string,
  node: bundledTs.ExportDeclaration,
  api: TypeScriptApi,
): void {
  const moduleSpecifier = node.moduleSpecifier;
  if (moduleSpecifier === undefined) {
    return;
  }
  const specifier = stringLiteralText(moduleSpecifier, api);
  if (specifier === null) {
    return;
  }
  const target = resolveSpecifier(module, specifier);
  const clause = node.exportClause;
  if (clause === undefined || !api.isNamedExports(clause)) {
    return;
  }
  for (const element of clause.elements) {
    const exported = element.propertyName?.text ?? element.name.text;
    record(element.name.text, `${target}#${exported}`);
  }
}

/**
 * `const x = require("y")` and `const { a, b: c } = require("y")`.
 *
 * Only these two shapes. `require` reached through a variable, computed, or
 * used as an expression argument is not statically a binding and is left to
 * a call-site walk.
 */
function recordRequire(
  record: Recorder,
  module: string,
  node: bundledTs.VariableDeclaration,
  api: TypeScriptApi,
): void {
  const specifier = requiredSpecifier(node.initializer, api);
  if (specifier === null) {
    return;
  }
  const target = resolveSpecifier(module, specifier);
  if (api.isIdentifier(node.name)) {
    record(node.name.text, `${target}#=`);
    return;
  }
  if (api.isObjectBindingPattern(node.name)) {
    recordRequireBindings(record, target, node.name, api);
  }
}

/**
 * The module specifier of a `require("y")` initializer, or `null` for
 * anything else.
 *
 * Everything that makes the call non-static is rejected here: a shadowed or
 * computed `require`, extra arguments, a template or concatenated specifier.
 * A `null` return means "this is not a require binding", never "we could not
 * be bothered".
 */
function requiredSpecifier(
  initializer: bundledTs.Expression | undefined,
  api: TypeScriptApi,
): string | null {
  if (initializer === undefined || !api.isCallExpression(initializer)) {
    return null;
  }
  if (!api.isIdentifier(initializer.expression) || initializer.expression.text !== "require") {
    return null;
  }
  if (initializer.arguments.length !== 1) {
    return null;
  }
  const argument = initializer.arguments[0];
  return argument === undefined ? null : stringLiteralText(argument, api);
}

/** The `{ a, b: c }` half of a destructuring `require`. */
function recordRequireBindings(
  record: Recorder,
  target: string,
  pattern: bundledTs.ObjectBindingPattern,
  api: TypeScriptApi,
): void {
  for (const element of pattern.elements) {
    if (!api.isIdentifier(element.name)) {
      continue;
    }
    const propertyName = element.propertyName;
    const named = propertyName !== undefined && api.isIdentifier(propertyName);
    record(element.name.text, `${target}#${named ? propertyName.text : element.name.text}`);
  }
}

function stringLiteralText(node: bundledTs.Node, api: TypeScriptApi): string | null {
  return api.isStringLiteralLike(node) ? node.text : null;
}
