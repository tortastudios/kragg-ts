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
 * ── MATCHING IS BY SIMPLE NAME, AND SAYS SO WHEN IT CANNOT ─────────────────
 * `criticality.json` names a function `src/a#Client.send`, and both coverage
 * formats record it as `send` with no class. So the index below is keyed by
 * simple name too, and a name bound more than once in a file yields more than
 * one span. The caller then declines to attribute anything rather than picking
 * one — the same trade `criticalCoverage.ts` already makes for an ambiguous
 * `fnMap` entry, and for the same reason: blaming `Reader.close` for
 * `Writer.close`'s uncovered lines sends a reviewer to the wrong function.
 *
 * ── WHAT COUNTS AS A FUNCTION ──────────────────────────────────────────────
 * Every form that can carry a name a coverage report would record: declared
 * functions, methods, accessors, constructors, and function/arrow expressions
 * bound by a variable, a class property or an object-literal property. An
 * anonymous callback binds no name and is not indexed — nothing could look it
 * up.
 */

import type bundledTs from "typescript";

import { parseSourceFile } from "../analysis/sourceFile.ts";
import type { TypeScriptApi } from "../analysis/sourceFile.ts";

/** A 1-based inclusive line range. */
export interface SourceSpan {
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * One file's function-likes, keyed by SIMPLE name.
 *
 * A list per key rather than a single span, because a simple name is not
 * unique in a file — `Reader.close` and `Writer.close` land on the same key —
 * and collapsing them would silently pick one. `uniqueSpan` is how a caller
 * asks for the unambiguous case.
 */
export type SpanIndex = ReadonlyMap<string, readonly SourceSpan[]>;

/**
 * Every named function-like in one file, indexed by simple name.
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
  visit(parsed.sourceFile, parsed.sourceFile, api, index);
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

function visit(
  node: bundledTs.Node,
  sourceFile: bundledTs.SourceFile,
  api: TypeScriptApi,
  index: Map<string, SourceSpan[]>,
): void {
  const name = functionName(node, api);
  if (name !== null) {
    record(index, name, spanOf(node, sourceFile));
  }
  api.forEachChild(node, (child) => {
    visit(child, sourceFile, api, index);
  });
}

/**
 * The name a function-like node would be recorded under, or `null`.
 *
 * A named function/class member is read off the declaration; a function or
 * arrow EXPRESSION takes the name of whatever binds it, which is exactly what
 * istanbul does (`const send = () => {}` is recorded as `send`).
 */
function functionName(node: bundledTs.Node, api: TypeScriptApi): string | null {
  if (api.isFunctionDeclaration(node) || api.isMethodDeclaration(node)) {
    return node.name === undefined ? null : memberName(node.name, api);
  }
  if (api.isGetAccessorDeclaration(node) || api.isSetAccessorDeclaration(node)) {
    return memberName(node.name, api);
  }
  if (api.isConstructorDeclaration(node)) {
    return "constructor";
  }
  if (api.isFunctionExpression(node) && node.name !== undefined) {
    return node.name.text;
  }
  return boundName(node, api);
}

/**
 * The name of the binding a function/arrow EXPRESSION is assigned to.
 *
 * `const send = () => {}`, `send = function () {}` inside a class body, and
 * `{ send: () => {} }` in an object literal all bind a callable to a name a
 * coverage report records. The parent is consulted rather than the node,
 * because the expression itself has none.
 */
function boundName(node: bundledTs.Node, api: TypeScriptApi): string | null {
  if (!api.isArrowFunction(node) && !api.isFunctionExpression(node)) {
    return null;
  }
  const parent: bundledTs.Node | undefined = node.parent;
  if (parent === undefined) {
    return null;
  }
  if (api.isVariableDeclaration(parent) && api.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (api.isPropertyDeclaration(parent) || api.isPropertyAssignment(parent)) {
    return memberName(parent.name, api);
  }
  return null;
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

function record(index: Map<string, SourceSpan[]>, name: string, span: SourceSpan): void {
  const existing = index.get(name);
  if (existing === undefined) {
    index.set(name, [span]);
    return;
  }
  existing.push(span);
}
