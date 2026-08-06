/**
 * Render a declaration as one scannable map line.
 *
 * Split from `symbols.ts` so that file answers only "what is public" and this
 * one only "how does it read". Both halves matter to `kragg map` for different
 * reasons, and mixing them produced a module no one could keep under budget.
 *
 * ── THE SIGNATURE IS WHY THIS BEATS `mapping.py` ───────────────────────────
 * Python's map emits parameter NAMES, because that is all an unannotated
 * `def` carries. Here the annotations are in the source and are the single
 * most useful thing an agent can read without opening the file:
 * `resolveTypeScript(root: string): CompilerResolution` answers "can I call
 * this with what I have" outright, where `resolve_typescript(root)` only
 * answers "there is something called that".
 *
 * ── DELIBERATELY LOSSY, IN TWO WAYS ────────────────────────────────────────
 * 1. TYPES ARE RENDERED AS WRITTEN, never as the checker would widen or
 *    resolve them. This lives in the syntax tier (`analysis/sourceFile.ts`)
 *    with no `ts.Program` behind it, which is what keeps `kragg map`
 *    sub-second on a real repo. An unannotated return type is therefore
 *    ABSENT rather than inferred — an omission a reader correctly interprets
 *    as "not annotated", where a half-inferred one would read as fact.
 * 2. EVERYTHING IS CAPPED. The map is injected into an agent's context at
 *    session start, so a 300-character generic signature that pushes three
 *    other modules out of the window is a real cost, not a cosmetic one. The
 *    three limits below were each set against this repo's own output: they
 *    are the points past which a line stopped carrying information and
 *    started carrying syntax.
 */

import type bundledTs from "typescript";

import type { TypeScriptApi } from "../../analysis/sourceFile.ts";

/** Longest rendered signature before it is elided with `…`. */
export const MAX_SIGNATURE_CHARS = 96;

/** Longest doc excerpt, matching `MAX_DOC_CHARS` in `mapping.py`. */
export const MAX_DOC_CHARS = 60;

/** Members listed inside an `interface`/`enum` summary before `, +N more`. */
export const MAX_MEMBER_NAMES = 8;

/** Longest `type X = …` definition inlined before it is dropped entirely. */
export const MAX_ALIAS_CHARS = 60;

/**
 * `<T, U>(a: string, b?: number): R`, with the return type only if written.
 *
 * Used for declared functions, methods and exported arrow constants alike —
 * a caller cannot tell those apart at the call site, so the map does not
 * either.
 */
export function callSignature(
  node: bundledTs.SignatureDeclaration,
  file: bundledTs.SourceFile,
  api: TypeScriptApi,
): string {
  const parameters = node.parameters.map((parameter) => renderParameter(parameter, file, api));
  const returns = node.type === undefined ? "" : `: ${compact(node.type.getText(file))}`;
  return `${typeParameters(node, api)}(${parameters.join(", ")})${returns}`;
}

/**
 * `<T, U>` when a declaration is generic, else nothing.
 *
 * Constraints and defaults are dropped: `<T extends Record<string, unknown> =
 * never>` is three times the width of `<T>` and says nothing an agent acts on
 * at the point of deciding whether this function already exists.
 */
export function typeParameters(node: bundledTs.Node, api: TypeScriptApi): string {
  const parameters = typeParameterList(node, api);
  if (parameters === undefined || parameters.length === 0) {
    return "";
  }
  return `<${parameters.map((parameter) => parameter.name.text).join(", ")}>`;
}

/** `: Type` when the declaration carries an annotation, else nothing. */
export function typeSuffix(
  node: bundledTs.Node,
  file: bundledTs.SourceFile,
  api: TypeScriptApi,
): string {
  if (
    api.isVariableDeclaration(node) ||
    api.isPropertyDeclaration(node) ||
    api.isGetAccessor(node)
  ) {
    return node.type === undefined ? "" : `: ${compact(node.type.getText(file))}`;
  }
  return "";
}

/**
 * ` = <definition>`, but only when the definition is short enough to help.
 *
 * A discriminated union of two object literals renders as 300 characters of
 * `| { readonly ok: true; readonly tool: LintTool; readonly command: rea…` —
 * a line that costs real context and tells the reader nothing they could act
 * on. Above `MAX_ALIAS_CHARS` the definition is dropped entirely and the doc
 * comment carries the meaning, which is what a reader would have used anyway.
 * Short aliases (`type Severity = "low" | "high"`) are exactly the ones worth
 * inlining, and they survive.
 */
export function aliasSuffix(
  node: bundledTs.TypeAliasDeclaration,
  file: bundledTs.SourceFile,
): string {
  const alias = compact(node.type.getText(file));
  return alias.length > MAX_ALIAS_CHARS ? "" : ` = ${alias}`;
}

/** ` { a, b, +3 more }` — enough to recognise the shape, not to reproduce it. */
export function memberNames(
  members: readonly bundledTs.TypeElement[],
  api: TypeScriptApi,
): string {
  const names: string[] = [];
  for (const member of members) {
    const name = member.name;
    if (name !== undefined && (api.isIdentifier(name) || api.isStringLiteral(name))) {
      names.push(name.text);
    }
  }
  return names.length === 0 ? "" : ` { ${capped(names)} }`;
}

/** The same summary for an `enum`, whose members are values rather than types. */
export function enumMemberNames(
  node: bundledTs.EnumDeclaration,
  api: TypeScriptApi,
): string {
  const names: string[] = [];
  for (const member of node.members) {
    if (api.isIdentifier(member.name) || api.isStringLiteral(member.name)) {
      names.push(member.name.text);
    }
  }
  return names.length === 0 ? "" : ` { ${capped(names)} }`;
}

/**
 * The first prose line of the JSDoc immediately preceding a declaration.
 *
 * Read from the LEADING COMMENT RANGES rather than through `ts`'s JSDoc
 * accessors, which are not part of the public typings — and this file must
 * survive being handed a compiler resolved out of the project under check
 * (see `resolveTypeScript`), where the internal surface is not guaranteed.
 * `getLeadingCommentRanges` is public API and stable.
 *
 * Only the LAST leading comment counts, so a licence or module header at the
 * top of a file is not attributed to the first declaration under it. Tag-only
 * docs (`/** @internal *\/`) yield `null` rather than a line of annotation.
 */
export function docLine(
  node: bundledTs.Node,
  file: bundledTs.SourceFile,
  api: TypeScriptApi,
): string | null {
  const text = file.getFullText();
  const ranges = api.getLeadingCommentRanges(text, node.getFullStart());
  const last = ranges?.at(-1);
  if (last === undefined) {
    return null;
  }
  const raw = text.slice(last.pos, last.end);
  if (!raw.startsWith("/**")) {
    return null;
  }
  for (const line of stripJsDoc(raw)) {
    if (line !== "" && !line.startsWith("@")) {
      return clamp(line, MAX_DOC_CHARS);
    }
  }
  return null;
}

/** Collapse every run of whitespace, so a wrapped type renders on one line. */
export function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Truncate with an ellipsis, matching `mapping.py`'s `_doc_suffix`. */
export function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/* --- Internals ------------------------------------------------------------ */

function renderParameter(
  parameter: bundledTs.ParameterDeclaration,
  file: bundledTs.SourceFile,
  api: TypeScriptApi,
): string {
  const rest = parameter.dotDotDotToken === undefined ? "" : "...";
  const name = api.isIdentifier(parameter.name)
    ? parameter.name.text
    : // A destructured parameter has no name to report; `{…}` says so honestly
      // and costs three characters instead of reproducing the whole pattern.
      "{…}";
  // A default value and a `?` mean the same thing to a caller — this argument
  // may be omitted — so both render as `?` rather than reproducing the default.
  const optional =
    parameter.questionToken !== undefined || parameter.initializer !== undefined ? "?" : "";
  const type = parameter.type === undefined ? "" : `: ${compact(parameter.type.getText(file))}`;
  return `${rest}${name}${optional}${type}`;
}

/** A declaration's type parameters, as the compiler stores them. */
type TypeParameterList = readonly bundledTs.TypeParameterDeclaration[];

/**
 * `node.typeParameters` without a cast.
 *
 * The property exists on several unrelated declaration types and on none of
 * their common supertypes, so it is reached through the narrowing predicates
 * rather than by asserting a shape the compiler has not agreed to.
 */
function typeParameterList(
  node: bundledTs.Node,
  api: TypeScriptApi,
): TypeParameterList | undefined {
  if (
    api.isFunctionDeclaration(node) ||
    api.isMethodDeclaration(node) ||
    api.isArrowFunction(node) ||
    api.isFunctionExpression(node) ||
    api.isClassDeclaration(node) ||
    api.isInterfaceDeclaration(node) ||
    api.isTypeAliasDeclaration(node)
  ) {
    return node.typeParameters;
  }
  return undefined;
}

function capped(names: readonly string[]): string {
  const shown = names.slice(0, MAX_MEMBER_NAMES).join(", ");
  return names.length > MAX_MEMBER_NAMES
    ? `${shown}, +${names.length - MAX_MEMBER_NAMES} more`
    : shown;
}

function stripJsDoc(raw: string): string[] {
  return raw
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*/, "").trim());
}
