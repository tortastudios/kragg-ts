/**
 * Line accounting — the `radon.raw.analyze` half of the complexity gate.
 *
 * Two numbers come out of here and both feed the maintainability index: the
 * physical classification of every line as code, comment or blank, and the
 * LOGICAL line count that the MI formula is actually parameterised by.
 */

import type ts from "typescript";

import type { TypeScriptApi } from "../../analysis/sourceFile.ts";

/** Line accounting for one file, the analogue of `radon.raw.analyze`. */
export interface LineMetrics {
  /** Every line in the file. */
  readonly loc: number;
  /** Lines carrying at least one non-comment token. */
  readonly sloc: number;
  /** Logical lines — see `logicalLines`. */
  readonly lloc: number;
  /** Lines carrying at least one comment character. */
  readonly commentLines: number;
  /** Lines that are neither code nor comment. */
  readonly blank: number;
}

/** What one physical line holds. Both flags are true for `code // note`. */
interface LineKind {
  readonly hasCode: boolean;
  readonly hasComment: boolean;
}

/** The running physical-line counters, before `lloc` is folded in. */
interface LineTally {
  loc: number;
  sloc: number;
  commentLines: number;
  blank: number;
}

/**
 * Classify every line of a file as code, comment or blank.
 *
 * The analogue of `radon.raw.analyze`. Comments are found by asking the
 * compiler for the trivia in front of every token, so a `//` inside a string
 * or a regular expression is never mistaken for one — the parser has already
 * settled that ambiguity, which a re-scan of the raw text could not.
 *
 * A line counts as CODE if it holds any non-whitespace character outside a
 * comment, and as COMMENT if it holds any character inside one. A line with
 * code and a trailing comment counts as both, matching radon, where `sloc`
 * and `comments` overlap on exactly those lines.
 */
export function lineMetrics(sourceFile: ts.SourceFile, api: TypeScriptApi): LineMetrics {
  const text = sourceFile.getFullText();
  const inComment = new Uint8Array(text.length);
  markComments(sourceFile, sourceFile, api, text, inComment);

  const tally: LineTally = { loc: 0, sloc: 0, commentLines: 0, blank: 0 };
  let lineStart = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index !== text.length && text[index] !== "\n") {
      continue;
    }
    tally.loc += 1;
    record(tally, classifyLine(text, lineStart, index, inComment));
    lineStart = index + 1;
  }

  return { ...tally, lloc: logicalLines(sourceFile, api) };
}

/** What one line's span holds, ignoring whitespace. */
function classifyLine(
  text: string,
  start: number,
  end: number,
  inComment: Uint8Array,
): LineKind {
  let hasCode = false;
  let hasComment = false;
  for (let cursor = start; cursor < end; cursor += 1) {
    const char = text[cursor];
    if (char === undefined || char === " " || char === "\t" || char === "\r") {
      continue;
    }
    if (inComment[cursor] === 1) {
      hasComment = true;
    } else {
      hasCode = true;
    }
  }
  return { hasCode, hasComment };
}

/** Fold one classified line into the running counters. */
function record(tally: LineTally, kind: LineKind): void {
  if (kind.hasCode) {
    tally.sloc += 1;
  }
  if (kind.hasComment) {
    tally.commentLines += 1;
  }
  if (!kind.hasCode && !kind.hasComment) {
    tally.blank += 1;
  }
}

/**
 * Mark every character belonging to a comment.
 *
 * Every comment in a file is leading trivia of exactly one token, so walking
 * the leaves of the tree finds all of them — including the ones no node
 * starts with, such as a note before a closing brace. JSDoc nodes are skipped
 * because their contents live INSIDE a comment already accounted for.
 */
function markComments(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  api: TypeScriptApi,
  text: string,
  inComment: Uint8Array,
): void {
  if (node.kind >= api.SyntaxKind.FirstJSDocNode && node.kind <= api.SyntaxKind.LastJSDocNode) {
    return;
  }
  const children = node.getChildren(sourceFile);
  if (children.length === 0) {
    // BOTH lists are needed. `getLeadingCommentRanges` only starts collecting
    // after a line break, so a comment sitting at the end of the PREVIOUS
    // line — the trailing `// note` case — is only ever returned by
    // `getTrailingCommentRanges` on the same position. Asking for one and not
    // the other silently loses every end-of-line comment in the file.
    const start = node.getFullStart();
    const ranges = [
      ...(api.getTrailingCommentRanges(text, start) ?? []),
      ...(api.getLeadingCommentRanges(text, start) ?? []),
    ];
    for (const range of ranges) {
      inComment.fill(1, range.pos, Math.min(range.end, text.length));
    }
    return;
  }
  for (const child of children) {
    markComments(child, sourceFile, api, text, inComment);
  }
}

/**
 * Logical lines of code — the count radon's LLOC approximates by looking for
 * a `:` or `;` in each physical line.
 *
 * Here it is exact instead of heuristic: one logical line per STATEMENT
 * (`Block` and `;` are containers and punctuation, not statements), plus one
 * per declaration that Python would spell with a colon-terminated header
 * (`function`, `class`, `import`, `export`, a class member, an enum member).
 * `const a = 1, b = 2` is one logical line, exactly as `a, b = 1, 2` is in
 * Python.
 *
 * Interface and type-alias declarations and their members ARE counted. They
 * have no runtime existence, but they are lines a maintainer reads and
 * changes, and Python's equivalent — a `TypedDict` or a `@dataclass` — counts
 * every field. Excluding them would make a heavily-typed file look shorter
 * than the file a human sees, which is the opposite of what MI is for.
 */
export function logicalLines(sourceFile: ts.SourceFile, api: TypeScriptApi): number {
  let count = 0;
  const walk = (node: ts.Node): void => {
    if (isLogicalLine(node, api)) {
      count += 1;
    }
    api.forEachChild(node, walk);
  };
  api.forEachChild(sourceFile, walk);
  return count;
}

function isLogicalLine(node: ts.Node, api: TypeScriptApi): boolean {
  const syntax = api.SyntaxKind;
  const kind = node.kind;
  if (kind >= syntax.FirstStatement && kind <= syntax.LastStatement) {
    return true;
  }
  switch (kind) {
    case syntax.FunctionDeclaration:
    case syntax.ClassDeclaration:
    case syntax.InterfaceDeclaration:
    case syntax.TypeAliasDeclaration:
    case syntax.EnumDeclaration:
    case syntax.EnumMember:
    case syntax.ModuleDeclaration:
    case syntax.ImportDeclaration:
    case syntax.ImportEqualsDeclaration:
    case syntax.ExportDeclaration:
    case syntax.ExportAssignment:
    case syntax.PropertyDeclaration:
    case syntax.PropertySignature:
    case syntax.MethodDeclaration:
    case syntax.MethodSignature:
    case syntax.Constructor:
    case syntax.GetAccessor:
    case syntax.SetAccessor:
    case syntax.IndexSignature:
    case syntax.CaseClause:
    case syntax.DefaultClause:
    case syntax.CatchClause:
      return true;
    default:
      return false;
  }
}
