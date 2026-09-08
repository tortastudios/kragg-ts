/**
 * The source files a coverage report is EXPECTED to describe.
 *
 * ── THE FILE THAT IS NOT THERE ─────────────────────────────────────────────
 * Every runner kragg drives reports only the files the test run LOADED.
 * `node --test --experimental-test-coverage` and `bun test --coverage` have no
 * other mode; vitest reports unloaded files only when `coverage.include` is
 * configured (vitest 4 removed the `coverage.all` default that used to do it).
 * So a module no test imports is not "0% covered" in any of those reports —
 * it is ABSENT, and a percentage computed over what is present is a
 * percentage over whichever files happened to load. A project whose tests
 * import three of forty modules can report 100%.
 *
 * `coverage_fail_under` is a floor for the PROJECT. So the denominator is
 * reconciled against the project: every TypeScript file under `source_paths`
 * that the report does not mention is counted as never loaded, with every one
 * of its statement lines uncovered. The line count for such a file has to come
 * from somewhere, and the only honest source is the file itself: kragg parses
 * it with the project's compiler and counts the lines on which a statement
 * starts — the same "a line is executable when a statement starts on it" rule
 * `coverage/model.ts` applies to what a report states. It is kragg's count,
 * not the runner's, and the gate's output says so; what it is NOT is a claim
 * that the file was measured. A file that never loaded has no covered lines,
 * and that part is not an estimate.
 *
 * ── WHAT COUNTS AS A STATEMENT LINE ────────────────────────────────────────
 * The rule follows istanbul's instrumenter, which is what `coverage-final.json`
 * and the lcov derived from it count: expression, return, throw, control-flow
 * and `debugger` statements, plus a variable declarator WITH an initializer.
 * Declarations (functions, classes, types, interfaces, imports, exports,
 * namespaces, enums) are not statements in that sense and are not counted;
 * neither is anything under `declare`. Nested function bodies ARE walked,
 * because their statements are executable lines of the file. Two statements
 * starting on one line count once — the model is per line.
 */

import { relative, resolve } from "node:path";

import type bundledTs from "typescript";

import { parseSourceFile, resolveTypeScript } from "../analysis/sourceFile.ts";
import type { TypeScriptApi } from "../analysis/sourceFile.ts";
import { toPosix } from "../analysis/modulePath.ts";
import { DEFAULT_EXTENSIONS, walkFiles } from "../analysis/walk.ts";

/** One source file the report should have described. */
export interface SourceFileEntry {
  /** Repo-relative POSIX path, the key a normalized report uses. */
  readonly path: string;
  /**
   * Lines on which a statement starts, read from the source. `0` for a file
   * that could not be parsed — still listed, because "never loaded" is a fact
   * about the run whether or not kragg can count the file.
   */
  readonly statementLines: number;
}

/**
 * Every TypeScript source file under `sourcePaths`, with its statement-line
 * count. Declaration files are excluded: they hold no executable line.
 */
export function sourceInventory(
  root: string,
  sourcePaths: readonly string[],
  api?: TypeScriptApi | undefined,
): readonly SourceFileEntry[] {
  const absoluteRoot = resolve(root);
  const compiler = api ?? resolveTypeScript(absoluteRoot).api;
  const entries: SourceFileEntry[] = [];
  for (const sourcePath of sourcePaths) {
    const base = resolve(absoluteRoot, sourcePath);
    for (const path of walkFiles(base, DEFAULT_EXTENSIONS, false, absoluteRoot)) {
      const parsed = parseSourceFile(path, absoluteRoot, compiler);
      entries.push({
        path: toPosix(relative(absoluteRoot, path)),
        statementLines: parsed === null ? 0 : statementLineCount(parsed.sourceFile, compiler),
      });
    }
  }
  return entries;
}

/** The number of distinct lines on which a statement starts. */
export function statementLineCount(
  sourceFile: bundledTs.SourceFile,
  api: TypeScriptApi,
): number {
  const lines = new Set<number>();
  const visit = (node: bundledTs.Node): void => {
    if (isAmbient(node, api)) {
      return;
    }
    if (isStatementLike(node, api)) {
      lines.add(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
    }
    api.forEachChild(node, visit);
  };
  api.forEachChild(sourceFile, visit);
  return lines.size;
}

type NodePredicate = (node: bundledTs.Node) => boolean;

/** The statement kinds istanbul instruments, by their predicate. */
function isStatementLike(node: bundledTs.Node, api: TypeScriptApi): boolean {
  if (api.isVariableDeclaration(node)) {
    return node.initializer !== undefined;
  }
  return statementPredicates(api).some((is) => is(node));
}

/**
 * The `ts.isXxx` predicates of the instrumented statement kinds. Taken off
 * the project's compiler, never a bundled one: node shapes are internal to a
 * compiler build. They are free functions on the namespace, not methods.
 */
function statementPredicates(api: TypeScriptApi): readonly NodePredicate[] {
  return [
    api.isExpressionStatement,
    api.isReturnStatement,
    api.isThrowStatement,
    api.isIfStatement,
    api.isForStatement,
    api.isForInStatement,
    api.isForOfStatement,
    api.isWhileStatement,
    api.isDoStatement,
    api.isSwitchStatement,
    api.isTryStatement,
    api.isBreakStatement,
    api.isContinueStatement,
    api.isLabeledStatement,
    api.isDebuggerStatement,
  ];
}

/** `declare …` and type-only declarations emit nothing to run. */
function isAmbient(node: bundledTs.Node, api: TypeScriptApi): boolean {
  if (
    api.isInterfaceDeclaration(node) ||
    api.isTypeAliasDeclaration(node) ||
    api.isImportDeclaration(node) ||
    api.isImportEqualsDeclaration(node) ||
    api.isExportDeclaration(node)
  ) {
    return true;
  }
  if (!api.canHaveModifiers(node)) {
    return false;
  }
  return (api.getCombinedModifierFlags(node as bundledTs.Declaration) & api.ModifierFlags.Ambient) !== 0;
}
