/**
 * Turning a declaration into the fully-qualified path a ban is written
 * against.
 *
 * ── THE PATH SCHEME ────────────────────────────────────────────────────────
 * A resolved call is spelled `<module>.<container>...<name>`, where `<module>`
 * comes from the file that DECLARES the callable:
 *
 *  - ambient module (`declare module "child_process"`) -> its specifier;
 *  - anything under `node_modules` -> the PACKAGE name, taken after the last
 *    `node_modules/` segment, so pnpm's `.pnpm/foo@1/node_modules/foo/...`
 *    still yields `foo`. Scoped packages keep both segments (`@scope/pkg`);
 *  - a declaration in global scope — a non-module `lib.*.d.ts`, or a
 *    `declare global` block -> `globalThis`;
 *  - a first-party file -> its repo-relative, extension-stripped module name
 *    from `moduleName()`, so separators inside the module part are `/`:
 *    `src/services/runner.runCommand`.
 *
 * GRANULARITY IS THE PACKAGE, NOT THE ENTRY POINT. `foo` and `foo/server`
 * resolve into the same `foo` namespace, because a package's file layout is
 * not its import specifier once `exports` subpaths are involved. Banning a
 * single subpath is therefore not expressible; ban the package or the member.
 */

import type bundledTs from "typescript";

import { moduleName, type TypeScriptApi } from "../../analysis/sourceFile.ts";
import { canonicalPath, toPosix, GLOBAL_MODULE, type Resolver } from "./resolver.ts";

/**
 * A declaration's fully-qualified path, or `null` when it has none.
 *
 * Walks the syntactic containers rather than `symbol.parent`, because the
 * container chain is what distinguishes `pkg.Class.method` from a same-named
 * free function, and because it is where the ambient-module and
 * `declare global` wrappers live.
 *
 * `null` covers two cases, and both of them are the "never guess" rule:
 *
 *  - a local import binding (`import { x } from ...`) names a binding, not an
 *    API. Skipping it is what stops an UNRESOLVED import from being reported
 *    under the importing file's module path, where it could collide with a
 *    first-party ban;
 *  - a member of an anonymous structural type (`(): { exec(): void }`) has no
 *    name anywhere in the program to ban it by, so it resolves to nothing
 *    rather than to a bare `<module>.exec` that a first-party rule could hit
 *    by accident. A structural type that IS named — by a type alias, a
 *    variable, or an object literal's binding — keeps that name and stays
 *    bannable.
 */
export function declarationPath(
  declaration: bundledTs.Declaration,
  name: string,
  resolver: Resolver,
): string | null {
  const { api } = resolver;
  if (isImportBinding(declaration, api)) {
    return null;
  }
  const parts: string[] = [name];
  // The innermost structural literal crossed that nothing has named yet. It
  // clears only against its OWN direct parent: `const a = { x() {} }` names
  // the literal, while `const f = (): { x(): void } => ...` names the
  // function, and `f.x` would be a property `f` does not have.
  let unnamed: bundledTs.Node | null = null;
  let node: bundledTs.Node | undefined = declaration.parent;
  while (node !== undefined) {
    const module = moduleOf(node, resolver);
    if (module !== null) {
      return unnamed !== null ? null : [module, ...parts].join(".");
    }
    if (api.isTypeLiteralNode(node) || api.isObjectLiteralExpression(node)) {
      unnamed = node;
    } else {
      const container = containerName(node, api);
      if (container !== null) {
        parts.unshift(container);
        if (unnamed?.parent === node) {
          unnamed = null;
        }
      }
    }
    node = node.parent;
  }
  return null;
}

/**
 * The module part of a path, when this node is the thing that supplies one.
 *
 * The three ways a declaration's namespace ends: an ambient
 * `declare module "spec"`, a `declare global` augmentation, or the source file
 * itself — which is global scope unless the file is an external module.
 */
function moduleOf(node: bundledTs.Node, resolver: Resolver): string | null {
  const { api } = resolver;
  if (api.isSourceFile(node)) {
    return api.isExternalModule(node) ? moduleContainer(node, resolver) : GLOBAL_MODULE;
  }
  if (!api.isModuleDeclaration(node)) {
    return null;
  }
  if (api.isStringLiteral(node.name)) {
    return canonicalPath(node.name.text);
  }
  return (node.flags & api.NodeFlags.GlobalAugmentation) !== 0 || node.name.text === "global"
    ? GLOBAL_MODULE
    : null;
}

/** A local binding introduced by an import, which is not an API path. */
function isImportBinding(node: bundledTs.Node, api: TypeScriptApi): boolean {
  return (
    api.isImportSpecifier(node) ||
    api.isImportClause(node) ||
    api.isNamespaceImport(node) ||
    api.isImportEqualsDeclaration(node)
  );
}

/**
 * The name a container contributes to a path, or `null` if it contributes
 * none.
 *
 * Blocks and function bodies contribute nothing, so a nested local function
 * resolves to `<module>.<name>` exactly as it does in Python.
 */
function containerName(node: bundledTs.Node, api: TypeScriptApi): string | null {
  if (api.isClassLike(node)) {
    return node.name?.text ?? null;
  }
  if (api.isModuleDeclaration(node)) {
    // A `namespace Foo` — a string-literal or `global` name never reaches
    // here, because `moduleOf` claims those first.
    return api.isIdentifier(node.name) ? node.name.text : null;
  }
  if (
    api.isInterfaceDeclaration(node) ||
    api.isEnumDeclaration(node) ||
    api.isTypeAliasDeclaration(node)
  ) {
    return node.name.text;
  }
  return bindingContainerName(node, api);
}

/**
 * The name a BINDING contributes to a path.
 *
 * Object-literal containers (`VariableDeclaration`, `PropertyAssignment`) are
 * included so the common "namespace object" shape — `export const fsUtil = {
 * read() {} }` — is bannable as `mod.fsUtil.read`.
 */
function bindingContainerName(node: bundledTs.Node, api: TypeScriptApi): string | null {
  if (api.isVariableDeclaration(node)) {
    return api.isIdentifier(node.name) ? node.name.text : null;
  }
  if (
    api.isPropertyAssignment(node) &&
    (api.isIdentifier(node.name) || api.isStringLiteral(node.name))
  ) {
    return node.name.text;
  }
  return null;
}

/** The module a first-party or vendored source file contributes to a path. */
function moduleContainer(file: bundledTs.SourceFile, resolver: Resolver): string {
  return packageName(file.fileName) ?? moduleName(file.fileName, resolver.root);
}

/**
 * The npm package a file belongs to, or `null` for a first-party file.
 *
 * Taken after the LAST `node_modules/` segment, which is what makes pnpm's
 * `node_modules/.pnpm/foo@1.0.0/node_modules/foo/index.d.ts` resolve to `foo`
 * rather than to `.pnpm`.
 */
function packageName(fileName: string): string | null {
  const path = toPosix(fileName);
  const marker = "/node_modules/";
  const index = path.lastIndexOf(marker);
  if (index < 0) {
    return null;
  }
  const parts = path.slice(index + marker.length).split("/");
  const first = parts[0];
  if (first === undefined || first === "") {
    return null;
  }
  if (!first.startsWith("@")) {
    return first;
  }
  const second = parts[1];
  return second === undefined ? null : `${first}/${second}`;
}
