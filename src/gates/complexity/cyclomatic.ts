/**
 * Cyclomatic complexity — the `radon-cc` half of the complexity gate.
 *
 * The GRADE BANDS, the failure thresholds, the violation messages and the
 * `CC-x` codes are ported unchanged from `parse_radon_cc` in Python kragg's
 * `parsers.py`, so a polyglot repo sees one vocabulary from both siblings.
 * There is no radon for TypeScript and kragg-ts takes no dependencies, so the
 * counting itself is native: one walk of the TypeScript AST per file.
 */

import type ts from "typescript";

import { parsedSources, resolveTypeScript, type TypeScriptApi } from "../../analysis/sourceFile.ts";
import type { Violation } from "../../engine/models.ts";
import { functionBlockLabel, isFunctionBlock } from "../halstead/blocks.ts";
import { ccExceeds, ccRank, CC_MAX_GRADE, type CcGrade, type ComplexityOptions } from "./grades.ts";

/** One graded function block. */
export interface ComplexityBlock {
  /** Qualified name, e.g. `Runner.run`. Matches the Halstead gate's naming. */
  readonly name: string;
  /** 1-based line of the function's first token. */
  readonly line: number;
  /** 1-based column, kept for tooling; not emitted in violations. */
  readonly column: number;
  readonly complexity: number;
  readonly grade: CcGrade;
}

/**
 * The decision points, enumerated deliberately. Each adds 1 to the enclosing
 * block, which starts at 1.
 *
 *  - `if` — and therefore `else if`, which is a nested `IfStatement`. A bare
 *    `else` adds NOTHING: it is the path that already exists.
 *  - `for`, `for..in`, `for..of`, `while`, `do..while` — one each.
 *  - a `switch` statement — ONE, regardless of how many `case` clauses it
 *    carries. THIS IS A DELIBERATE DIVERGENCE from McCabe, from radon, and
 *    therefore from the Python sibling, which counts one per `case`.
 *
 *    It was made on measured evidence, not taste. Counting per-`case` failed
 *    18/351 blocks (5%) of this repo at grade C where the Python sibling
 *    failed zero, and the two worst offenders were pure dispatch tables — 25
 *    and 22 cases, nothing else — which no reader experiences as complex. A
 *    flat dispatch table does not accumulate reasoning burden the way nested
 *    conditionals do: adding a 26th case adds no new interaction to hold in
 *    your head. This is the same reasoning cognitive-complexity metrics use
 *    when they score a `switch` as a single structure.
 *
 *    The cost is honest and worth stating: a `switch` can now hide arbitrary
 *    breadth from this gate. The `structure` gate's file and symbol budgets
 *    are what bound that, not this one.
 *
 *  - `default` adds nothing, for the same reason a bare `else` does not.
 *  - `catch` — one per clause. `try` and `finally` add nothing: neither
 *    introduces a decision, and radon counts handlers only.
 *  - the ternary `?:`.
 *  - each `&&`, `||`, `??`. Radon adds `len(values) - 1` for a `BoolOp`,
 *    which is one per written operator — the same thing.
 *  - each `&&=`, `||=`, `??=`. These short-circuit exactly as their binary
 *    forms do; Python has no equivalent, so there is nothing to port, but the
 *    branch is real.
 *  - each optional chain `?.`, `?.()`, `?.[]`. THIS IS A JUDGEMENT CALL and
 *    the one place this gate is stricter than a literal reading of McCabe:
 *    `a?.b` is `a == null ? undefined : a.b`, an edge in the control-flow
 *    graph and a path a test must cover. Counting it makes a chain of six
 *    optional accesses read as the six-branch construct it is.
 *
 * NOT COUNTED: `try`, `finally`, `else`, `default`, individual `case` clauses
 * (the enclosing `switch` carries the single branch), `break`/`continue`, and
 * the nullish/logical operators appearing in a TYPE position, which cannot
 * exist at runtime.
 */
function decisionPoints(node: ts.Node, api: TypeScriptApi): number {
  const syntax = api.SyntaxKind;
  switch (node.kind) {
    case syntax.IfStatement:
    case syntax.ConditionalExpression:
    case syntax.ForStatement:
    case syntax.ForInStatement:
    case syntax.ForOfStatement:
    case syntax.WhileStatement:
    case syntax.DoStatement:
    case syntax.SwitchStatement:
    case syntax.CatchClause:
      return 1;
    default:
      break;
  }
  if (api.isBinaryExpression(node)) {
    return isBranchingOperator(node.operatorToken.kind, api) ? 1 : 0;
  }
  if (
    api.isPropertyAccessExpression(node) ||
    api.isElementAccessExpression(node) ||
    api.isCallExpression(node)
  ) {
    return node.questionDotToken === undefined ? 0 : 1;
  }
  return 0;
}

function isBranchingOperator(kind: ts.SyntaxKind, api: TypeScriptApi): boolean {
  const syntax = api.SyntaxKind;
  return (
    kind === syntax.AmpersandAmpersandToken ||
    kind === syntax.BarBarToken ||
    kind === syntax.QuestionQuestionToken ||
    kind === syntax.AmpersandAmpersandEqualsToken ||
    kind === syntax.BarBarEqualsToken ||
    kind === syntax.QuestionQuestionEqualsToken
  );
}

interface CcWalkResult {
  readonly blocks: readonly ComplexityBlock[];
  /** 1 + every decision point in the file, matching `total_complexity`. */
  readonly total: number;
}

/** A block being accumulated by the walk, before it is graded. */
interface PendingBlock {
  readonly name: string;
  readonly line: number;
  readonly column: number;
  points: number;
}

/**
 * Grade every function block in a file.
 *
 * NESTED FUNCTIONS ARE NOT INCLUDED IN THEIR PARENT'S SCORE, matching radon:
 * `visit_FunctionDef` adds a closure's decision points to the closure, never
 * to the enclosing function. A function holding five callbacks is not
 * complex; the callbacks might be, and they are graded separately. (Radon
 * does not REPORT closures at all. This gate does — see `isFunctionBlock` in
 * `halstead.ts` for why an unreported callback would be a hole.)
 *
 * Top-level code outside any function is folded into `total` (the MI gate
 * needs it) but is never graded as a block, again matching `radon cc`.
 */
export function fileComplexity(
  sourceFile: ts.SourceFile,
  api: TypeScriptApi,
): CcWalkResult {
  const pending: PendingBlock[] = [];
  let decisions = 0;

  const walk = (node: ts.Node, current: PendingBlock | null, path: readonly string[]): void => {
    if (isFunctionBlock(node, api)) {
      const body: ts.Node | undefined = node.body;
      if (body === undefined) {
        return;
      }
      const label = functionBlockLabel(node, api);
      const start = api.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
      const block: PendingBlock = {
        name: [...path, label].join("."),
        line: start.line + 1,
        column: start.character + 1,
        points: 0,
      };
      pending.push(block);
      walk(body, block, [...path, label]);
      return;
    }
    const points = decisionPoints(node, api);
    if (current !== null) {
      current.points += points;
    }
    decisions += points;
    const nested = className(node, api);
    const childPath = nested === null ? path : [...path, nested];
    api.forEachChild(node, (child) => {
      walk(child, current, childPath);
    });
  };

  walk(sourceFile, null, []);
  const blocks: ComplexityBlock[] = pending.map((block) => ({
    name: block.name,
    line: block.line,
    column: block.column,
    complexity: 1 + block.points,
    grade: ccRank(1 + block.points),
  }));
  return { blocks, total: 1 + decisions };
}

function className(node: ts.Node, api: TypeScriptApi): string | null {
  if (api.isClassDeclaration(node) || api.isClassExpression(node)) {
    return node.name?.text ?? null;
  }
  return null;
}

/**
 * Cyclomatic violations, in the shape `parse_radon_cc` produces: message,
 * file, line, `CC-<grade>` code and the same fix hint. No column, because the
 * Python side has none and the two must stay diffable.
 */
export function cyclomaticViolations(
  root: string,
  sourcePaths: readonly string[],
  options: ComplexityOptions = {},
): Violation[] {
  const api = options.api ?? resolveTypeScript(root).api;
  const limit = options.maxGrade ?? CC_MAX_GRADE;
  const violations: Violation[] = [];
  for (const source of parsedSources(root, sourcePaths, { api })) {
    for (const block of fileComplexity(source.sourceFile, api).blocks) {
      if (!ccExceeds(block.grade, limit)) {
        continue;
      }
      violations.push({
        message:
          `${block.name} has cyclomatic complexity grade ${block.grade} ` +
          `(max allowed: ${limit})`,
        file: source.relative,
        line: block.line,
        code: `CC-${block.grade}`,
        fixHint: "split into smaller functions or use early returns",
      });
    }
  }
  return violations;
}
