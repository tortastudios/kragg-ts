/**
 * Decide what a module's PUBLIC SURFACE is, and enumerate it.
 *
 * This is the half of `kragg map` that `kragg/src/kragg/mapping.py` gets from
 * a naming convention, and the half where TypeScript is strictly better
 * information. Rendering lives in `render.ts`.
 *
 * ── WHY THIS BEATS THE PYTHON ORIGINAL ─────────────────────────────────────
 * `mapping.py` decides what is public by asking whether a name starts with
 * `_`. That is a guess dressed up as a rule: it lists module-private helpers
 * that merely lack an underscore, and it cannot see that a name IS the
 * package's API, because Python has no `export`. TypeScript states it. Every
 * symbol below is one a caller can actually `import`, established by the
 * `export` modifier or by an `export { ... }` clause naming a local
 * declaration — the same two spellings `gates/testDepth/criticalFunctions.ts`
 * already treats as authoritative, so the map and the critical-function gates
 * agree on what "public" means. That agreement is the point: a map that
 * advertised a symbol the gates consider unreachable would send an agent to
 * call something no test can address.
 *
 * ── WHAT IS DELIBERATELY NOT LISTED ────────────────────────────────────────
 * `private`/`protected` members, `#private` fields, and anything whose name
 * starts with `_`. None of them is callable from another module, so listing
 * them only teaches an agent about code it must not touch. Constructors are
 * dropped too: `new Client(...)` is implied by `class Client`, and the
 * parameter list is in the file the agent will open anyway.
 *
 * KNOWN GAP, stated rather than hidden: an `export * from "./other.ts"`
 * contributes nothing here. The names it forwards belong to another module,
 * where they are already indexed under their own heading — so they appear in
 * the map exactly once, at their definition, rather than twice or not at all.
 */

import type bundledTs from "typescript";

import type { ParsedSource, TypeScriptApi } from "../../analysis/sourceFile.ts";
import {
  aliasSuffix,
  callSignature,
  clamp,
  compact,
  docLine,
  enumMemberNames,
  MAX_SIGNATURE_CHARS,
  memberNames,
  typeParameters,
  typeSuffix,
} from "./render.ts";

/** What a symbol is, which also fixes how it is rendered and indented. */
export type SymbolKind =
  | "fn"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "enum"
  | "const";

/** One exported symbol, ready to render as a map line. */
export interface MapSymbol {
  readonly kind: SymbolKind;
  /**
   * Dotted name within the module — `parseSourceFile`, `Client.send`. Joined
   * to the module with `#` this is exactly the node name
   * `gates/criticality.ts` writes, which is how the risk flag is looked up.
   */
  readonly qualname: string;
  /** The rendered signature, without indentation, doc or risk suffix. */
  readonly signature: string;
  /** First prose line of the JSDoc, already truncated; `null` if undocumented. */
  readonly doc: string | null;
}

/**
 * Every exported symbol in a module, in source order, methods after their class.
 *
 * A module with no exports yields nothing, so the caller omits its heading
 * entirely rather than printing a bare module name — a line that costs tokens
 * and says only "this file exists".
 */
export function moduleSymbols(
  source: ParsedSource,
  api: TypeScriptApi,
): readonly MapSymbol[] {
  const file = source.sourceFile;
  const exported = exportClauseNames(file, api);
  const symbols: MapSymbol[] = [];
  for (const statement of file.statements) {
    if (isExportedStatement(statement, api, exported)) {
      collectStatement(statement, file, api, symbols);
    }
  }
  return symbols;
}

/* --- Statement dispatch --------------------------------------------------- */

function collectStatement(
  statement: bundledTs.Statement,
  file: bundledTs.SourceFile,
  api: TypeScriptApi,
  into: MapSymbol[],
): void {
  if (api.isFunctionDeclaration(statement)) {
    const name = statement.name?.text;
    if (name !== undefined) {
      const rendered = `fn ${name}${callSignature(statement, file, api)}`;
      into.push(symbol("fn", name, rendered, statement, file, api));
    }
    return;
  }
  if (api.isClassDeclaration(statement)) {
    collectClass(statement, file, api, into);
    return;
  }
  if (api.isInterfaceDeclaration(statement)) {
    const name = statement.name.text;
    const head = `interface ${name}${typeParameters(statement, api)}`;
    const rendered = `${head}${memberNames(statement.members, api)}`;
    into.push(symbol("interface", name, rendered, statement, file, api));
    return;
  }
  if (api.isTypeAliasDeclaration(statement)) {
    const name = statement.name.text;
    const head = `type ${name}${typeParameters(statement, api)}`;
    into.push(symbol("type", name, `${head}${aliasSuffix(statement, file)}`, statement, file, api));
    return;
  }
  if (api.isEnumDeclaration(statement)) {
    const name = statement.name.text;
    const rendered = `enum ${name}${enumMemberNames(statement, api)}`;
    into.push(symbol("enum", name, rendered, statement, file, api));
    return;
  }
  if (api.isVariableStatement(statement)) {
    collectVariables(statement, file, api, into);
  }
}

/** A class heading followed by its public instance surface. */
function collectClass(
  node: bundledTs.ClassDeclaration,
  file: bundledTs.SourceFile,
  api: TypeScriptApi,
  into: MapSymbol[],
): void {
  const name = node.name?.text;
  if (name === undefined) {
    return;
  }
  const head = `class ${name}${typeParameters(node, api)}`;
  into.push(symbol("class", name, head, node, file, api));
  for (const member of node.members) {
    const memberName = publicMemberName(member, api);
    if (memberName === null) {
      continue;
    }
    const qualname = `${name}.${memberName}`;
    const rendered = api.isMethodDeclaration(member)
      ? `${qualname}${callSignature(member, file, api)}`
      : `${qualname}${typeSuffix(member, file, api)}`;
    into.push(symbol("method", qualname, rendered, member, file, api));
  }
}

/**
 * Exported `const`/`let` bindings.
 *
 * An arrow or function initializer is rendered as a FUNCTION, because that is
 * what a caller uses it as; `export const run = (x: string) => …` is
 * indistinguishable from a declared function at the call site, and rendering
 * it as `const run` would hide the only thing worth knowing about it.
 */
function collectVariables(
  statement: bundledTs.VariableStatement,
  file: bundledTs.SourceFile,
  api: TypeScriptApi,
  into: MapSymbol[],
): void {
  for (const declaration of statement.declarationList.declarations) {
    if (!api.isIdentifier(declaration.name)) {
      continue;
    }
    const name = declaration.name.text;
    const initializer = declaration.initializer;
    if (
      initializer !== undefined &&
      (api.isArrowFunction(initializer) || api.isFunctionExpression(initializer))
    ) {
      const rendered = `fn ${name}${callSignature(initializer, file, api)}`;
      into.push(symbol("fn", name, rendered, statement, file, api));
      continue;
    }
    const rendered = `const ${name}${typeSuffix(declaration, file, api)}`;
    into.push(symbol("const", name, rendered, statement, file, api));
  }
}

function symbol(
  kind: SymbolKind,
  qualname: string,
  signature: string,
  node: bundledTs.Node,
  file: bundledTs.SourceFile,
  api: TypeScriptApi,
): MapSymbol {
  return {
    kind,
    qualname,
    signature: clamp(compact(signature), MAX_SIGNATURE_CHARS),
    doc: docLine(node, file, api),
  };
}

/* --- Export detection ----------------------------------------------------- */

/**
 * Whether a top-level statement contributes to the module's public surface.
 *
 * Two spellings, both authoritative: an `export` modifier, or a name listed in
 * an `export { ... }` clause elsewhere in the file. The second matters more
 * than it looks — a module that declares everything privately and re-exports
 * at the bottom is a common style, and missing it would print an empty map
 * for the file.
 */
function isExportedStatement(
  statement: bundledTs.Statement,
  api: TypeScriptApi,
  exported: ReadonlySet<string>,
): boolean {
  if (hasExportModifier(statement, api)) {
    return true;
  }
  return declaredNames(statement, api).some((name) => exported.has(name));
}

/**
 * An `export` keyword directly on a statement.
 *
 * Read through `canHaveModifiers`/`getModifiers` rather than
 * `getCombinedModifierFlags`, which takes a `Declaration` and would need a
 * cast from `Statement` that the compiler correctly refuses. These two are
 * public API, total over any node, and say exactly what is being asked.
 */
function hasExportModifier(node: bundledTs.Node, api: TypeScriptApi): boolean {
  if (!api.canHaveModifiers(node)) {
    return false;
  }
  const modifiers = api.getModifiers(node);
  return (
    modifiers?.some((modifier) => modifier.kind === api.SyntaxKind.ExportKeyword) ?? false
  );
}

function declaredNames(
  statement: bundledTs.Statement,
  api: TypeScriptApi,
): readonly string[] {
  if (
    api.isFunctionDeclaration(statement) ||
    api.isClassDeclaration(statement) ||
    api.isInterfaceDeclaration(statement) ||
    api.isTypeAliasDeclaration(statement) ||
    api.isEnumDeclaration(statement)
  ) {
    const name = statement.name;
    return name === undefined ? [] : [name.text];
  }
  if (api.isVariableStatement(statement)) {
    const names: string[] = [];
    for (const declaration of statement.declarationList.declarations) {
      if (api.isIdentifier(declaration.name)) {
        names.push(declaration.name.text);
      }
    }
    return names;
  }
  return [];
}

/**
 * Local names re-exported by an `export { a, b as c }` clause.
 *
 * The LOCAL name is recorded (`a`, not `c`), because that is what the
 * declaration is called and therefore what `criticality.ts` named it. A
 * clause carrying a module specifier (`export { a } from "./b.ts"`) is
 * skipped — it declares nothing in this file.
 */
function exportClauseNames(
  file: bundledTs.SourceFile,
  api: TypeScriptApi,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of file.statements) {
    if (!api.isExportDeclaration(statement) || statement.moduleSpecifier !== undefined) {
      continue;
    }
    const clause = statement.exportClause;
    if (clause === undefined || !api.isNamedExports(clause)) {
      continue;
    }
    for (const element of clause.elements) {
      names.add(element.propertyName?.text ?? element.name.text);
    }
  }
  return names;
}

/** The reportable name of a class member, or `null` when it is not public. */
function publicMemberName(
  member: bundledTs.ClassElement,
  api: TypeScriptApi,
): string | null {
  if (
    !api.isMethodDeclaration(member) &&
    !api.isPropertyDeclaration(member) &&
    !api.isGetAccessor(member)
  ) {
    return null;
  }
  const flags = api.getCombinedModifierFlags(member);
  if ((flags & (api.ModifierFlags.Private | api.ModifierFlags.Protected)) !== 0) {
    return null;
  }
  const name = member.name;
  if (api.isPrivateIdentifier(name)) {
    return null;
  }
  const text = api.isIdentifier(name) || api.isStringLiteral(name) ? name.text : null;
  return text === null || text.startsWith("_") ? null : text;
}
