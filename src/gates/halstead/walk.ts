/**
 * The single AST walk that measures a file and every function block in it.
 */

import type ts from "typescript";

import type { TypeScriptApi } from "../../analysis/sourceFile.ts";
import { functionBlockLabel, isFunctionBlock } from "./blocks.ts";
import {
  halsteadMetrics,
  type HalsteadCounts,
  type HalsteadFileReport,
} from "./metrics.ts";
import { isTypeOnlyNode, operandsOf, operatorsOf } from "./partition.ts";

/** Mutable tallies for one block. Keys are the operator/operand symbols. */
interface Tally {
  readonly operators: Map<string, number>;
  readonly operands: Map<string, number>;
}

function newTally(): Tally {
  return { operators: new Map(), operands: new Map() };
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function countsOf(tally: Tally): HalsteadCounts {
  return {
    distinctOperators: tally.operators.size,
    distinctOperands: tally.operands.size,
    totalOperators: sum(tally.operators),
    totalOperands: sum(tally.operands),
  };
}

function sum(counts: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const value of counts.values()) {
    total += value;
  }
  return total;
}

interface PendingBlock {
  readonly name: string;
  readonly line: number;
  readonly tally: Tally;
}

/**
 * Measure one file: the whole file, plus every function block in it.
 *
 * TWO RADON BEHAVIOURS ARE PRESERVED DELIBERATELY.
 *
 *  1. A block's counts INCLUDE the functions nested inside it, because
 *     `HalsteadVisitor.visit_FunctionDef` recurses into the body it is
 *     summarising. (The cyclomatic gate does the opposite, also following
 *     radon. The asymmetry is radon's, not ours.)
 *  2. Only the BODY is counted. Parameters, the name and the `function`/`=>`
 *     syntax itself contribute nothing, matching radon's `for child in
 *     node.body`.
 *
 * ONE IS NOT. Radon reports only top-level functions and methods; a closure
 * gets no entry of its own. Every function block is reported here, nested or
 * not, because in TypeScript the closure IS the unit of work — a gate blind
 * to callbacks would be blind to most of the language.
 */
export function fileHalstead(
  sourceFile: ts.SourceFile,
  api: TypeScriptApi,
): HalsteadFileReport {
  const total = newTally();
  const blocks: PendingBlock[] = [];

  const walk = (node: ts.Node, stack: readonly Tally[], path: readonly string[]): void => {
    if (isTypeOnlyNode(node, api)) {
      return;
    }
    if (isFunctionBlock(node, api)) {
      const body: ts.Node | undefined = node.body;
      if (body === undefined) {
        return;
      }
      const label = functionBlockLabel(node, api);
      const tally = newTally();
      blocks.push({
        name: [...path, label].join("."),
        line: lineOf(node, sourceFile, api),
        tally,
      });
      walk(body, [...stack, tally], [...path, label]);
      return;
    }
    tallyNode(node, api, stack);
    const nested = classLabel(node, api);
    const childPath = nested === null ? path : [...path, nested];
    api.forEachChild(node, (child) => {
      walk(child, stack, childPath);
    });
  };

  walk(sourceFile, [total], []);
  return {
    total: halsteadMetrics(countsOf(total)),
    functions: blocks.map((block) => ({
      name: block.name,
      line: block.line,
      metrics: halsteadMetrics(countsOf(block.tally)),
    })),
  };
}

/** Add one node's operators and operands to every enclosing block. */
function tallyNode(node: ts.Node, api: TypeScriptApi, stack: readonly Tally[]): void {
  for (const operator of operatorsOf(node, api)) {
    for (const tally of stack) {
      bump(tally.operators, operator);
    }
  }
  for (const operand of operandsOf(node, api)) {
    for (const tally of stack) {
      bump(tally.operands, operand);
    }
  }
}

function classLabel(node: ts.Node, api: TypeScriptApi): string | null {
  if (api.isClassDeclaration(node) || api.isClassExpression(node)) {
    return node.name?.text ?? null;
  }
  return null;
}

function lineOf(node: ts.Node, sourceFile: ts.SourceFile, api: TypeScriptApi): number {
  return api.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile)).line + 1;
}
