/**
 * The gate entry point: which files are scanned, which nodes invoke something,
 * and what a matched call becomes.
 */

import { relative } from "node:path";

import type bundledTs from "typescript";

import {
  programSourceFiles,
  sourceFilesFor,
  type AnalysisProgram,
} from "../../analysis/program.ts";
import type { TypeScriptApi } from "../../analysis/sourceFile.ts";
import type { Violation } from "../../engine/models.ts";
import type { ForbiddenCall } from "../../policy/policy.ts";
import { suppression, unhonouredMessage } from "../../util/suppress.ts";
import { toPosix, type Resolver } from "./resolver.ts";
import {
  buildRules,
  matchRule,
  DEFAULT_FIX_HINT,
  FORBIDDEN_CALL_CODE,
} from "./rules.ts";
import { resolvedPaths } from "./symbols.ts";

export interface ForbiddenCallsOptions {
  /** The shared, lazy program handle. Loaded only if there are rules. */
  readonly program: AnalysisProgram;
  /** `[bannedPath, fixHint]` pairs, as `KraggPolicy.forbiddenCalls`. */
  readonly forbidden: readonly ForbiddenCall[];
  /**
   * Restrict the scan to these files — the `--changed` path. Paths may be
   * absolute or root-relative; ones the program does not contain are dropped.
   * Omit to scan the project's whole source set.
   */
  readonly paths?: readonly string[] | undefined;
}

/**
 * Either the findings, or the reason the gate could not run.
 *
 * A union rather than a throw, mirroring `ProgramLoad`: the caller has to turn
 * "I could not run" into a `GateResult` with `error: true`, and an exception
 * would make the normal path the one needing a try/catch.
 */
export type ForbiddenCallsOutcome =
  | { readonly ok: true; readonly violations: readonly Violation[] }
  | { readonly ok: false; readonly message: string };

/**
 * Report one violation per call that resolves to a forbidden path.
 *
 * Violations are ordered by file (program order) and, within a file, by line
 * then column — the ordering Python produces, so two runs over an unchanged
 * tree diff cleanly.
 *
 * With no rules configured this returns immediately and NEVER loads the
 * program, preserving the laziness contract in `analysis/program.ts`.
 */
export function checkForbiddenCalls(
  options: ForbiddenCallsOptions,
): ForbiddenCallsOutcome {
  const rules = buildRules(options.forbidden);
  if (rules.size === 0) {
    return { ok: true, violations: [] };
  }
  const load = options.program.load();
  if (!load.ok) {
    return { ok: false, message: load.message };
  }
  const resolver: Resolver = {
    api: options.program.compiler.api,
    checker: load.checker,
    root: options.program.root,
  };
  const violations: Violation[] = [];
  for (const file of filesToScan(load.program, options)) {
    violations.push(...scanFile(file, rules, resolver));
  }
  return { ok: true, violations };
}

/**
 * The project's own source files, optionally narrowed to a caller's list.
 *
 * The narrowed set is intersected with `programSourceFiles` rather than used
 * raw, so a changed `.d.ts` or a changed file under `node_modules` cannot
 * sneak into a scan the whole-project path would never look at.
 */
function filesToScan(
  program: bundledTs.Program,
  options: ForbiddenCallsOptions,
): readonly bundledTs.SourceFile[] {
  const own = programSourceFiles(program);
  if (options.paths === undefined) {
    return own;
  }
  const allowed = new Set(own);
  return sourceFilesFor(program, options.program.root, options.paths).filter((file) =>
    allowed.has(file),
  );
}

function scanFile(
  file: bundledTs.SourceFile,
  rules: ReadonlyMap<string, string>,
  resolver: Resolver,
): readonly Violation[] {
  const { api } = resolver;
  const lines = file.text.split(/\r?\n/);
  const relativePath = toPosix(relative(resolver.root, file.fileName));
  const found: Violation[] = [];

  const visit = (node: bundledTs.Node): void => {
    const callee = calleeOf(node, api);
    if (callee !== null) {
      const violation = checkCallee(node, callee, file, lines, relativePath, rules, resolver);
      if (violation !== null) {
        found.push(violation);
      }
    }
    api.forEachChild(node, visit);
  };
  api.forEachChild(file, visit);

  return found.sort(
    (left, right) => (left.line ?? 0) - (right.line ?? 0) || (left.column ?? 0) - (right.column ?? 0),
  );
}

/**
 * The expression being invoked, for every node shape that invokes one.
 *
 * `a?.b()`, `await f()` and a parenthesized callee need no special case: the
 * first is an ordinary call with an optional-chain token, and the other two
 * put the call somewhere the walk reaches anyway. A dynamic `import(...)` is
 * excluded — its "callee" is a keyword, not a value.
 */
function calleeOf(node: bundledTs.Node, api: TypeScriptApi): bundledTs.Expression | null {
  if (api.isCallExpression(node)) {
    return node.expression.kind === api.SyntaxKind.ImportKeyword ? null : node.expression;
  }
  if (api.isNewExpression(node)) {
    return node.expression;
  }
  if (api.isTaggedTemplateExpression(node)) {
    return node.tag;
  }
  return null;
}

function checkCallee(
  node: bundledTs.Node,
  callee: bundledTs.Expression,
  file: bundledTs.SourceFile,
  lines: readonly string[],
  relativePath: string,
  rules: ReadonlyMap<string, string>,
  resolver: Resolver,
): Violation | null {
  const paths = resolvedPaths(callee, resolver);
  const canonical = paths[0];
  if (canonical === undefined) {
    return null;
  }
  const match = matchRule(paths, rules);
  if (match === null) {
    return null;
  }
  const start = file.getLineAndCharacterOfPosition(node.getStart(file));
  const end = file.getLineAndCharacterOfPosition(node.getEnd());
  const marker = suppression(lines, start.line + 1, end.line + 1);
  if (marker.kind === "honoured") {
    return null;
  }
  const banned = match.entry === canonical ? "" : ` (banned: \`${match.entry}\`)`;
  return {
    message: unhonouredMessage(`forbidden call \`${canonical}\`${banned}`, marker),
    file: relativePath,
    line: start.line + 1,
    column: start.character + 1,
    code: FORBIDDEN_CALL_CODE,
    fixHint: match.hint === "" ? DEFAULT_FIX_HINT : match.hint,
  };
}
