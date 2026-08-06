/**
 * Shared vocabulary for the nullable-default rules.
 *
 * Each rule module answers one question about one node and returns a
 * `NullableFinding` or `null`. The gate entry point owns walking,
 * suppression, and turning findings into `Violation`s, so a rule never needs
 * a source file, a path, or a line number.
 */

import type bundledTs from "typescript";

import type { TypeScriptApi } from "../../analysis/sourceFile.ts";

/** One place external/nullable data is consumed as a concrete value. */
export interface NullableFinding {
  /** Node to report and to check for a suppression comment. */
  readonly node: bundledTs.Node;
  readonly message: string;
  readonly fixHint: string;
}

/** Bound on every syntactic chain walk, so no shape can loop the gate. */
export const MAX_DEPTH = 12;

/** Strip wrappers that change nothing at runtime. */
export function unwrap(
  expression: bundledTs.Expression,
  api: TypeScriptApi,
): bundledTs.Expression {
  let node: bundledTs.Expression = expression;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (api.isParenthesizedExpression(node) || api.isNonNullExpression(node)) {
      node = node.expression;
      continue;
    }
    return node;
  }
  return node;
}

/** A union's members, or the type itself when it is not a union. */
export function constituents(type: bundledTs.Type): readonly bundledTs.Type[] {
  return type.isUnion() ? type.types : [type];
}

/**
 * Render an expression for a message, capped.
 *
 * A violation that names the operand is actionable without opening the file;
 * one that pastes forty columns of source into a terminal is not.
 */
export function shortText(node: bundledTs.Node, limit = 40): string {
  return capText(node.getText(), limit);
}

/** Collapse whitespace and cap a rendered string for a message. */
export function capText(value: string, limit = 40): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
