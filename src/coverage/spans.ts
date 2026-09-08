/**
 * A function's line extent, taken from the SOURCE.
 *
 * ── WHY THIS IS NOT INFERENCE ──────────────────────────────────────────────
 * istanbul's `fnMap` states where a function begins AND ends. lcov's
 * `FN:<line>,<name>` — the form `node --test`, `bun test` and istanbul's own
 * lcov writer all emit — states only where it begins. Attributing uncovered
 * lines to a function needs an extent, so under lcov there are three options
 * and only one of them is honest:
 *
 *  - guess the end from the next `FN:` record. WRONG, and not marginally: a
 *    function declared inside another one makes the next record land in the
 *    MIDDLE of the enclosing function's body, so the enclosing function's
 *    uncovered tail is attributed to nothing at all;
 *  - report nothing for functions the tracefile does not bound. Honest, but it
 *    reduces the strictest gate in the suite to "was this ever called?";
 *  - read the extent off the source file, which is where it actually is.
 *
 * The third is what this module does. It is not a guess about the coverage
 * report; it is the same fact the report's own producer read out of the same
 * file. Nothing here invents coverage data — hits always come from the report.
 *
 * ── THE INDEX IS KEYED THE WAY `criticality.json` SPELLS A NAME ────────────
 * `criticality.json` names a function `src/a#Reader.close`, and both coverage
 * formats record it as `close` with no class. Two classes in one file with a
 * same-named method are therefore indistinguishable IN THE REPORT — but not
 * in the source, where each method sits inside its own class. So every
 * function-like is indexed twice: under the QUALIFIED name `criticality.ts`
 * would write after the `#` (`Reader.close`, `Client.get token`,
 * `gate.run`, `Ns.helper`), built from the same containers `criticality/
 * register.ts` walks — classes, namespaces and object literals bound to a
 * name — and under its SIMPLE name, which is what a report records. A caller
 * looks the qualified name up first, so `Reader.close` and `Writer.close`
 * each get their own extent and neither is blamed for the other's lines. The
 * simple key is the fallback, and it stays honest: a name bound more than once
 * yields more than one span, and `uniqueSpan` declines rather than picking.
 *
 * ── WHAT COUNTS AS A FUNCTION ──────────────────────────────────────────────
 * Every form that can carry a name a coverage report would record: declared
 * functions, methods, accessors, constructors, and function/arrow expressions
 * bound by a variable, a class property or an object-literal property. Two
 * things are deliberately NOT indexed: an anonymous callback, which binds no
 * name anything could look up; and a declaration WITHOUT A BODY — an overload
 * signature, an abstract or ambient method — which no coverage report can
 * record, and which would otherwise make every overloaded function look like
 * a name bound twice. Functions nested inside another function's body are not
 * walked, exactly as `register.ts` never makes them nodes: their lines belong
 * to the enclosing function.
 *
 * ── A CLASS IS A SPAN TOO ──────────────────────────────────────────────────
 * `new Foo()` on a class with no declared constructor resolves to the CLASS
 * node (`criticality/graph.ts`), so a class can be critical. Its span is the
 * class declaration with HOLES cut out for every member function: the header,
 * the field initializers and any static block are the class's own lines; a
 * method's lines are the method's, and are never attributed to the class.
 */

import type bundledTs from "typescript";

import { parseSourceFile } from "../analysis/sourceFile.ts";
import type { TypeScriptApi } from "../analysis/sourceFile.ts";

/** A 1-based inclusive line range. */
export interface SourceSpan {
  readonly startLine: number;
  readonly endLine: number;
  /**
   * Line ranges inside this span that belong to OTHER nodes — the member
   * functions of a class. Present only on a class span; a line inside a hole
   * is the member's to answer for, never the class's.
   */
  readonly holes?: readonly SourceSpan[];
}

/**
 * One file's function-likes, keyed by qualified AND simple name.
 *
 * A list per key rather than a single span, because a simple name is not
 * unique in a file — `Reader.close` and `Writer.close` both land on `close` —
 * and collapsing them would silently pick one. `uniqueSpan` is how a caller
 * asks for the unambiguous case.
 */
export type SpanIndex = ReadonlyMap<string, readonly SourceSpan[]>;

/**
 * Every named function-like (and class) in one file, indexed by name.
 *
 * Returns an empty index for a file that cannot be read or does not parse —
 * "no extent known", which the caller must not read as "no uncovered lines".
 */
export function functionSpans(
  file: string,
  root: string,
  api: TypeScriptApi,
): SpanIndex {
  const parsed = parseSourceFile(file, root, api);
  if (parsed === null) {
    return new Map();
  }
  const index = new Map<string, SourceSpan[]>();
  const walk: Walk = { sourceFile: parsed.sourceFile, api, index };
  parsed.sourceFile.forEachChild((child) => {
    visit(child, walk, []);
  });
  return index;
}

/**
 * The ONE span a name unambiguously identifies, or `null`.
 *
 * `null` covers both "no such name" and "that name is bound twice here", which
 * the caller treats identically: it has no attributable extent either way.
 */
export function uniqueSpan(spans: SpanIndex, name: string): SourceSpan | null {
  const found = spans.get(name);
  return found !== undefined && found.length === 1 ? (found[0] ?? null) : null;
}

/** Whether `line` lies inside the span and outside every hole. */
export function ownsLine(span: SourceSpan, line: number): boolean {
  if (line < span.startLine || line > span.endLine) {
    return false;
  }
  return !(span.holes ?? []).some((hole) => line >= hole.startLine && line <= hole.endLine);
}

interface Walk {
  readonly sourceFile: bundledTs.SourceFile;
  readonly api: TypeScriptApi;
  readonly index: Map<string, SourceSpan[]>;
}

/**
 * Walk one node with the container `path` `register.ts` would have reached it
 * under. Containers extend the path; a function-like is recorded and never
 * entered; everything else is descended through unchanged.
 */
function visit(node: bundledTs.Node, walk: Walk, path: readonly string[]): void {
  if (visitContainer(node, walk, path)) {
    return;
  }
  if (isFunctionLike(node, walk.api)) {
    const leaf = functionLeaf(node, walk.api);
    if (leaf !== null && hasBody(node, walk.api)) {
      record(walk.index, path, leaf, reportedName(leaf), spanOf(node, walk.sourceFile));
    }
    return;
  }
  walk.api.forEachChild(node, (child) => {
    visit(child, walk, path);
  });
}

/**
 * The three containers that qualify what they hold: a class, a namespace
 * with a block body, and an object literal bound to a name. Returns whether
 * `node` was one — a class or namespace that binds no name is still a
 * container, and is not walked into.
 */
function visitContainer(node: bundledTs.Node, walk: Walk, path: readonly string[]): boolean {
  const api = walk.api;
  if (api.isClassDeclaration(node) || api.isClassExpression(node)) {
    const name = className(node, api);
    if (name !== null) {
      record(walk.index, path, name, name, classSpan(node, walk));
      visitAll(node.members, walk, [...path, name]);
    }
    return true;
  }
  if (api.isModuleDeclaration(node)) {
    const body = node.body;
    if (body !== undefined && api.isModuleBlock(body)) {
      visitAll(body.statements, walk, [...path, node.name.text]);
    }
    return true;
  }
  const literal = boundObjectLiteral(node, api);
  if (literal !== null) {
    visitAll(literal.literal.properties, walk, [...path, literal.name]);
    return true;
  }
  return false;
}

function visitAll(nodes: readonly bundledTs.Node[], walk: Walk, path: readonly string[]): void {
  for (const node of nodes) {
    visit(node, walk, path);
  }
}

function isFunctionLike(node: bundledTs.Node, api: TypeScriptApi): boolean {
  return (
    api.isFunctionDeclaration(node) ||
    api.isMethodDeclaration(node) ||
    api.isGetAccessorDeclaration(node) ||
    api.isSetAccessorDeclaration(node) ||
    api.isConstructorDeclaration(node) ||
    api.isFunctionExpression(node) ||
    api.isArrowFunction(node)
  );
}

/** An overload signature, abstract or ambient member has no body to cover. */
function hasBody(node: bundledTs.Node, api: TypeScriptApi): boolean {
  if (api.isArrowFunction(node)) {
    return true;
  }
  return (
    (api.isFunctionDeclaration(node) ||
      api.isMethodDeclaration(node) ||
      api.isGetAccessorDeclaration(node) ||
      api.isSetAccessorDeclaration(node) ||
      api.isConstructorDeclaration(node) ||
      api.isFunctionExpression(node)) &&
    node.body !== undefined
  );
}

/**
 * The last qualified segment `register.ts` would write for this node, or
 * `null` when it binds no name a report or the graph could record.
 *
 * Accessors keep their `get `/`set ` prefix here, as `criticality.ts` writes
 * them; `reportedName` strips it for the simple key.
 */
function functionLeaf(node: bundledTs.Node, api: TypeScriptApi): string | null {
  if (api.isFunctionDeclaration(node)) {
    return node.name?.text ?? (isDefaultExport(node, api) ? "default" : null);
  }
  if (api.isConstructorDeclaration(node)) {
    return "constructor";
  }
  if (api.isMethodDeclaration(node) || api.isAccessor(node)) {
    return memberLeaf(node, api);
  }
  return boundName(node, api);
}

/** A class or object-literal member that carries a body. */
type Member = bundledTs.MethodDeclaration | bundledTs.AccessorDeclaration;

/** A member's leaf: its name, prefixed the way `criticality.ts` spells an accessor. */
function memberLeaf(node: Member, api: TypeScriptApi): string | null {
  const name = memberName(node.name, api);
  if (name === null) {
    return null;
  }
  if (api.isGetAccessorDeclaration(node)) {
    return `get ${name}`;
  }
  return api.isSetAccessorDeclaration(node) ? `set ${name}` : name;
}

/** What a coverage report calls it: the leaf without an accessor prefix. */
function reportedName(leaf: string): string {
  for (const prefix of ["get ", "set "]) {
    if (leaf.startsWith(prefix)) {
      return leaf.slice(prefix.length);
    }
  }
  return leaf;
}

/**
 * The name of the binding a function/arrow EXPRESSION is assigned to.
 *
 * `const send = () => {}`, `send = function () {}` inside a class body,
 * `{ send: () => {} }` in an object literal and `export default () => {}` all
 * bind a callable to a name both the graph and a coverage report record. The
 * parent is consulted first, because the expression itself usually has no
 * name; a named function expression bound nowhere keeps its own.
 */
function boundName(node: bundledTs.Node, api: TypeScriptApi): string | null {
  if (!api.isArrowFunction(node) && !api.isFunctionExpression(node)) {
    return null;
  }
  const parent: bundledTs.Node | undefined = node.parent;
  if (parent === undefined) {
    return ownName(node, api);
  }
  if (api.isVariableDeclaration(parent) && api.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (api.isPropertyDeclaration(parent) || api.isPropertyAssignment(parent)) {
    return memberName(parent.name, api);
  }
  return api.isExportAssignment(parent) ? "default" : ownName(node, api);
}

/** A function expression's own name (`const a = function b() {}` records `b`). */
function ownName(node: bundledTs.Node, api: TypeScriptApi): string | null {
  return api.isFunctionExpression(node) && node.name !== undefined ? node.name.text : null;
}

/** The name `register.ts` gives a class, or `null` for an unbound expression. */
function className(node: bundledTs.ClassLikeDeclaration, api: TypeScriptApi): string | null {
  if (node.name !== undefined) {
    return node.name.text;
  }
  if (api.isClassDeclaration(node)) {
    return isDefaultExport(node, api) ? "default" : null;
  }
  const parent: bundledTs.Node | undefined = node.parent;
  if (parent !== undefined && api.isVariableDeclaration(parent) && api.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return parent !== undefined && api.isExportAssignment(parent) ? "default" : null;
}

/** An object literal and the name it is bound to. */
interface BoundLiteral {
  readonly name: string;
  readonly literal: bundledTs.ObjectLiteralExpression;
}

/** An object literal bound to a name — a container `register.ts` walks into. */
function boundObjectLiteral(node: bundledTs.Node, api: TypeScriptApi): BoundLiteral | null {
  if (api.isVariableDeclaration(node)) {
    const initializer = node.initializer;
    if (
      initializer !== undefined &&
      api.isIdentifier(node.name) &&
      api.isObjectLiteralExpression(initializer)
    ) {
      return { name: node.name.text, literal: initializer };
    }
    return null;
  }
  if (api.isPropertyAssignment(node) && api.isObjectLiteralExpression(node.initializer)) {
    const name = memberName(node.name, api);
    return name === null ? null : { name, literal: node.initializer };
  }
  if (api.isExportAssignment(node) && api.isObjectLiteralExpression(node.expression)) {
    return { name: "default", literal: node.expression };
  }
  return null;
}

function isDefaultExport(node: bundledTs.Declaration, api: TypeScriptApi): boolean {
  return (api.getCombinedModifierFlags(node) & api.ModifierFlags.Default) !== 0;
}

/** A member name as a coverage report would spell it, or `null`. */
function memberName(name: bundledTs.Node, api: TypeScriptApi): string | null {
  if (api.isIdentifier(name) || api.isPrivateIdentifier(name)) {
    return name.text;
  }
  return api.isStringLiteral(name) ? name.text : null;
}

/**
 * The node's 1-based inclusive line span.
 *
 * `getStart()` skips leading trivia, so a documented function's span begins at
 * its own first token rather than at the top of its doc comment — otherwise
 * every uncovered line in the comment block above it would be attributed to it.
 */
function spanOf(node: bundledTs.Node, sourceFile: bundledTs.SourceFile): SourceSpan {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const end = sourceFile.getLineAndCharacterOfPosition(node.end).line + 1;
  return { startLine: start, endLine: Math.max(start, end) };
}

/** The class's own lines: its span with every member function cut out. */
function classSpan(node: bundledTs.ClassLikeDeclaration, walk: Walk): SourceSpan {
  const holes: SourceSpan[] = [];
  for (const member of node.members) {
    const body = walk.api.isPropertyDeclaration(member) ? member.initializer : member;
    if (body !== undefined && isFunctionLike(body, walk.api) && hasBody(body, walk.api)) {
      holes.push(spanOf(body, walk.sourceFile));
    }
  }
  return { ...spanOf(node, walk.sourceFile), holes };
}

/** Index under the qualified key, and under the simple key when it differs. */
function record(
  index: Map<string, SourceSpan[]>,
  path: readonly string[],
  leaf: string,
  simple: string,
  span: SourceSpan,
): void {
  const qualified = [...path, leaf].join(".");
  push(index, qualified, span);
  if (simple !== qualified) {
    push(index, simple, span);
  }
}

function push(index: Map<string, SourceSpan[]>, key: string, span: SourceSpan): void {
  const existing = index.get(key);
  if (existing === undefined) {
    index.set(key, [span]);
    return;
  }
  existing.push(span);
}
