/**
 * The source half of `typing-strictness`: escape hatches written INTO the
 * code, where no config flag can reach them.
 *
 * Python has essentially one — `# type: ignore` — and audits it for being
 * bare rather than pinned to an error code. TypeScript has a whole family, and
 * enumerating it is where this gate beats its sibling:
 *
 *   `@ts-ignore`            suppresses whatever error happens to be there,
 *                           forever, without naming it, and stays silent when
 *                           the error is gone. Always a violation.
 *   `@ts-expect-error`      the ACCEPTABLE form — it fails the build once the
 *                           error it covers disappears, so it cannot rot. But
 *                           only with a description: an undescribed one is the
 *                           exact analogue of Python's bare `# type: ignore`,
 *                           and gets the analogous code.
 *   `@ts-nocheck`           turns the checker off for an entire file.
 *   `x as any`, `<any>x`    an assertion straight through the type system.
 *   `x as unknown as T`     the double cast: `unknown` is a legal target from
 *                           anything and a legal source to anything, so the
 *                           pair together launders any value into any type.
 *                           This is the idiom people reach for once `as any`
 *                           is banned, which is why it is named separately.
 *   explicit `any`          in an exported signature it escapes into every
 *                           caller; inside a module it does not.
 *   `Function`              callable with any arguments, returns `any`.
 *   `object`                any non-primitive, with no members.
 *   `x!`, `let x!: T`       assertions the checker cannot verify — the second
 *                           one specifically defeats `strictPropertyInitialization`.
 *
 * ── COMMENTS ARE READ AS TOKENS, NOT AS TEXT ───────────────────────────────
 * Python uses the `tokenize` module so that a directive inside a string
 * literal is not mistaken for a real one — a bug it deliberately avoided, and
 * one this module would hit on its first run, because it necessarily writes
 * the directives it detects inside its own doc comment and its own tests.
 *
 * The equivalent discipline here: comments are collected from the PARSER's
 * token stream — every token's leading trivia, walked from the parsed tree —
 * never by matching a pattern against the file text. A string literal, a
 * template literal and a regular expression are each a single token to the
 * parser, so their contents are never scanned. Every comment in a file is
 * leading trivia of exactly one token (including the end-of-file token), so
 * the coverage is total and the deduplication is by position.
 *
 * ONLY `//` COMMENTS CARRY A DIRECTIVE, which is not a limitation but the
 * compiler's own rule: `/* @ts-ignore *\/` suppresses nothing in `tsc`, so
 * flagging it would be flagging an inert comment. Likewise `@ts-nocheck` is
 * reported only where the compiler honours it — before the first statement.
 *
 * A reviewed-safe site is silenced with `// kragg: ignore` on a line it spans,
 * per `util/suppress.ts`. For a directive comment that means writing both on
 * one line: `// @ts-expect-error // kragg: ignore`, which is ugly on purpose.
 */

import type ts from "typescript";

import type { ParsedSource, TypeScriptApi } from "../../analysis/sourceFile.ts";
import type { Violation } from "../../engine/models.ts";
import { suppressed } from "../../util/suppress.ts";
import { TYPING_STRICTNESS_CODES as CODE } from "./codes.ts";

/** Findings from one file, split by whether they fail the gate. */
export interface SourceHatches {
  readonly violations: readonly Violation[];
  readonly advisories: readonly Violation[];
}

/**
 * `//` or `///`, then the directive, then whatever description follows it.
 *
 * Matches the compiler's own `commentDirectiveRegEx` in shape, so what is
 * reported is what tsc actually honours.
 */
const DIRECTIVE = /^\/\/\/?\s*@(ts-ignore|ts-expect-error|ts-nocheck)\b(.*)$/;

/** Punctuation people put between the directive and the actual reason. */
const DESCRIPTION_LEAD = /^[\s:—–-]+/;

/** Scan one parsed file for source-level escape hatches. */
export function scanSourceHatches(
  source: ParsedSource,
  api: TypeScriptApi,
): SourceHatches {
  const sink = createSink(source);
  scanComments(sink, source, api);
  scanNodes(sink, source, api);
  return sink.result();
}

/** A span of the file's text, as raw character offsets. */
interface Span {
  readonly start: number;
  readonly end: number;
}

/** One finding, before it knows where it is. */
interface Finding {
  readonly code: string;
  readonly message: string;
  readonly fixHint: string;
}

/** Collects findings, applies `// kragg: ignore`, and fills in the location. */
interface Sink {
  /** Record a finding spanning `[start, end)`; `advisory` never fails the gate. */
  add(span: Span, finding: Finding, advisory: boolean): void;
  result(): SourceHatches;
}

function createSink(source: ParsedSource): Sink {
  const violations: Violation[] = [];
  const advisories: Violation[] = [];
  const file = source.sourceFile;
  return {
    add(span: Span, finding: Finding, advisory: boolean): void {
      const from = file.getLineAndCharacterOfPosition(span.start);
      const to = file.getLineAndCharacterOfPosition(span.end);
      if (suppressed(source.lines, from.line + 1, to.line + 1)) {
        return;
      }
      (advisory ? advisories : violations).push({
        message: finding.message,
        file: source.relative,
        line: from.line + 1,
        column: from.character + 1,
        code: finding.code,
        fixHint: finding.fixHint,
      });
    },
    result(): SourceHatches {
      return { violations: violations.sort(byPosition), advisories: advisories.sort(byPosition) };
    },
  };
}

function byPosition(left: Violation, right: Violation): number {
  return (left.line ?? 0) - (right.line ?? 0) || (left.column ?? 0) - (right.column ?? 0);
}

/* -------------------------------------------------------------------------
 * Comment directives
 * ---------------------------------------------------------------------- */

function scanComments(sink: Sink, source: ParsedSource, api: TypeScriptApi): void {
  const file = source.sourceFile;
  const text = file.text;
  const firstStatement = file.statements[0]?.getStart(file) ?? text.length;
  const seen = new Set<number>();

  for (const token of eachToken(file, file)) {
    for (const range of api.getLeadingCommentRanges(text, token.pos) ?? []) {
      if (seen.has(range.pos)) {
        continue;
      }
      seen.add(range.pos);
      if (range.kind !== api.SyntaxKind.SingleLineCommentTrivia) {
        continue;
      }
      inspectComment(sink, text.slice(range.pos, range.end), range, firstStatement);
    }
  }
}

function inspectComment(
  sink: Sink,
  raw: string,
  range: ts.CommentRange,
  firstStatement: number,
): void {
  const match = DIRECTIVE.exec(raw.trimEnd());
  const directive = match?.[1];
  if (match === null || directive === undefined) {
    return;
  }
  const span = { start: range.pos, end: range.end };
  if (directive === "ts-ignore") {
    sink.add(
      span,
      {
        code: CODE.tsIgnore,
        message: "`@ts-ignore` suppresses an unnamed error and never expires",
        fixHint:
          "use `@ts-expect-error <why this is safe>`, which fails the build " +
          "once the error it covers is gone — then fix the type",
      },
      false,
    );
    return;
  }
  if (directive === "ts-expect-error") {
    const description = (match[2] ?? "").replace(DESCRIPTION_LEAD, "").trim();
    if (description === "") {
      sink.add(
        span,
        {
          code: CODE.bareTsExpectError,
          message: "bare `@ts-expect-error` hides an unknown error",
          fixHint: "say what is being suppressed: `@ts-expect-error <reason>`",
        },
        false,
      );
    }
    return;
  }
  if (range.pos < firstStatement) {
    sink.add(
      span,
      {
        code: CODE.tsNocheck,
        message: "`@ts-nocheck` disables type checking for this ENTIRE file",
        fixHint: "delete it and fix the file; suppress single sites if you must",
      },
      false,
    );
  }
}

/**
 * Every leaf token of a parsed file, in source order.
 *
 * A leaf is a node with no children — the parser's own tokenization. Walking
 * to the leaves (rather than over `forEachChild`, which skips punctuation) is
 * what guarantees that a comment sitting before a lone `)` or after the last
 * statement is still somebody's leading trivia.
 */
function* eachToken(node: ts.Node, file: ts.SourceFile): Generator<ts.Node> {
  const children = node.getChildren(file);
  if (children.length === 0) {
    yield node;
    return;
  }
  for (const child of children) {
    yield* eachToken(child, file);
  }
}

/* -------------------------------------------------------------------------
 * Syntax-level hatches
 * ---------------------------------------------------------------------- */

function scanNodes(sink: Sink, source: ParsedSource, api: TypeScriptApi): void {
  const file = source.sourceFile;
  // Inner casts already reported as half of a double cast. The walk is
  // parent-first, so the outer expression always claims them first.
  const claimed = new Set<ts.Node>();

  const visit = (node: ts.Node): void => {
    const span = { start: node.getStart(file), end: node.getEnd() };
    if (isAssertion(node, api)) {
      inspectAssertion(sink, node, span, claimed, api);
    } else if (node.kind === api.SyntaxKind.AnyKeyword) {
      inspectAny(sink, node, span, api);
    } else if (node.kind === api.SyntaxKind.ObjectKeyword) {
      sink.add(
        span,
        {
          code: CODE.weakObjectType,
          message: "`object` as a type means any non-primitive, with no members",
          fixHint:
            "name the shape you mean (`interface`/`type`), or use " +
            "`Record<string, unknown>` for an arbitrary object",
        },
        true,
      );
    } else if (isFunctionTypeReference(node, api)) {
      sink.add(
        span,
        {
          code: CODE.unsafeFunctionType,
          message: "`Function` as a type accepts any arguments and returns `any`",
          fixHint: "write the call signature: `(a: A) => R`",
        },
        false,
      );
    } else if (api.isNonNullExpression(node)) {
      sink.add(
        span,
        {
          code: CODE.nonNullAssertion,
          message: "non-null assertion `!` — the checker cannot verify this is not null",
          fixHint:
            "narrow with a check the checker can follow, or make the type " +
            "honest; if it is genuinely provable, `// kragg: ignore` it with a reason",
        },
        true,
      );
    }
    inspectDefiniteAssignment(sink, node, file, api);
    api.forEachChild(node, visit);
  };
  api.forEachChild(file, visit);
}

type Assertion = ts.AsExpression | ts.TypeAssertion;

function isAssertion(node: ts.Node, api: TypeScriptApi): node is Assertion {
  return api.isAsExpression(node) || api.isTypeAssertionExpression(node);
}

/** `as any` and the `as unknown as T` laundering pair. */
function inspectAssertion(
  sink: Sink,
  node: Assertion,
  span: Span,
  claimed: Set<ts.Node>,
  api: TypeScriptApi,
): void {
  const inner = unwrapParentheses(node.expression, api);
  if (isAssertion(inner, api) && isAnyOrUnknown(inner.type, api)) {
    claimed.add(inner);
    sink.add(
      span,
      {
        code: CODE.doubleCast,
        message:
          "double cast through `unknown`/`any` — this launders a value into an unrelated type",
        fixHint:
          "if the value really is that type, prove it with a type guard; if it " +
          "is not, fix the source of the value",
      },
      false,
    );
    return;
  }
  if (claimed.has(node) || !isAnyKeyword(node.type, api)) {
    return;
  }
  sink.add(
    span,
    {
      code: CODE.asAny,
      message: "`as any` asserts straight through the type system",
      fixHint: "assert to the narrowest real type, or narrow `unknown` with a type guard",
    },
    false,
  );
}

/** Explicit `any` in a type position, graded by whether it is exported. */
function inspectAny(
  sink: Sink,
  node: ts.Node,
  span: Span,
  api: TypeScriptApi,
): void {
  const parent: ts.Node | undefined = node.parent;
  if (parent !== undefined && (isAssertion(parent, api) || api.isSatisfiesExpression(parent))) {
    // Already reported, more specifically, as `as-any`.
    return;
  }
  if (isExportedSurface(node, api)) {
    sink.add(
      span,
      {
        code: CODE.exportedAny,
        message: "`any` in an exported signature — it escapes into every caller",
        fixHint:
          "model the real type at the boundary; use `unknown` and narrow if " +
          "the shape is genuinely not known",
      },
      false,
    );
    return;
  }
  sink.add(
    span,
    {
      code: CODE.internalAny,
      message: "explicit `any` disables checking for this value",
      fixHint: "use `unknown` and narrow it, or write the type you mean",
    },
    true,
  );
}

/** `let x!: T` and `prop!: T` — a promise to the checker, not a proof. */
function inspectDefiniteAssignment(
  sink: Sink,
  node: ts.Node,
  file: ts.SourceFile,
  api: TypeScriptApi,
): void {
  if (!api.isPropertyDeclaration(node) && !api.isVariableDeclaration(node)) {
    return;
  }
  const token = node.exclamationToken;
  if (token === undefined) {
    return;
  }
  sink.add(
    { start: node.getStart(file), end: token.getEnd() },
    {
      code: CODE.nonNullAssertion,
      message: "definite assignment assertion `!` bypasses `strictPropertyInitialization`",
      fixHint: "initialise it in the constructor, or type it `T | undefined` and narrow",
    },
    true,
  );
}

function unwrapParentheses(node: ts.Expression, api: TypeScriptApi): ts.Expression {
  let current = node;
  while (api.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function isAnyKeyword(node: ts.TypeNode, api: TypeScriptApi): boolean {
  return node.kind === api.SyntaxKind.AnyKeyword;
}

function isAnyOrUnknown(node: ts.TypeNode, api: TypeScriptApi): boolean {
  return isAnyKeyword(node, api) || node.kind === api.SyntaxKind.UnknownKeyword;
}

/**
 * A bare `Function` in type position.
 *
 * Matched by name, because this tier has no type checker. A project that
 * declares its own type called `Function` is shadowing a global with a name
 * that means "unsafe" to every reader, which is worth a report of its own.
 * `new Function(...)` is an expression, not a type reference, and is not
 * matched here — that is the forbidden-calls gate's business.
 */
function isFunctionTypeReference(node: ts.Node, api: TypeScriptApi): boolean {
  return (
    api.isTypeReferenceNode(node) &&
    api.isIdentifier(node.typeName) &&
    node.typeName.text === "Function"
  );
}

/**
 * Whether this node sits in an exported declaration's public surface.
 *
 * The walk stops at a `Block`, so a local inside an exported function is
 * INTERNAL — the `any` in `export function f() { const x: any = ... }` never
 * reaches a caller, while the one in `export function f(x: any)` reaches all
 * of them. It also stops at a `private` member, whose types are not surface
 * either.
 *
 * KNOWN GAP: a declaration exported by a separate `export { thing }` statement
 * is NOT seen as exported, because that requires resolving the name back to
 * its declaration and this tier does not resolve names. Such an `any` is
 * reported as internal — under-reporting rather than guessing.
 */
function isExportedSurface(node: ts.Node, api: TypeScriptApi): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (api.isSourceFile(current) || api.isBlock(current)) {
      return false;
    }
    if (api.isExportAssignment(current)) {
      return true;
    }
    if (api.canHaveModifiers(current)) {
      for (const modifier of api.getModifiers(current) ?? []) {
        if (modifier.kind === api.SyntaxKind.ExportKeyword) {
          return true;
        }
        if (modifier.kind === api.SyntaxKind.PrivateKeyword) {
          return false;
        }
      }
    }
    current = current.parent;
  }
  return false;
}
