/**
 * Bound references: which critical functions a test file actually names.
 *
 * `critical-tests` and `test-quality` both need one fact about a test file —
 * does it reach a given critical function — and both used to answer it with
 * text. Any edited test file satisfied `critical-tests`, and a substring
 * search satisfied `test-quality`, so `// TODO verifyPassword`, the title
 * `it("verifyPassword works")` and an unrelated `send` on another class all
 * counted as evidence. This module answers with the TYPE CHECKER instead.
 *
 * ── WHAT A BOUND REFERENCE IS ──────────────────────────────────────────────
 * An identifier in the test file whose symbol — after `getAliasedSymbol`
 * has followed every import, `as` alias and `export ... from` re-export —
 * declares a function the criticality graph registered. The declaration is
 * mapped to its `<module>#<qualified.name>` by the SAME registration pass
 * (`criticality/register.ts`) that named the nodes in `criticality.json`, so
 * the two sides agree by construction. Comments and string literals have no
 * symbol; a same-named local, a fake's method, or a property on an unrelated
 * type resolves to a declaration the graph never registered. None of them
 * count.
 *
 * The reference need not be a call. `expectAuth(verifyPassword)` passes the
 * function to a helper, `const fn = vp` binds an alias, `helpers.run()` from
 * `test/helpers.ts` calls it one file away — every one of those is an
 * identifier bound to the function, and the gates accept them so that a
 * valid indirect test is not rejected for lacking a direct call.
 *
 * ── WHAT IT PROVES, AND WHAT IT DOES NOT ───────────────────────────────────
 * A bound reference is evidence that the test EXERCISES the function: the
 * test cannot run without touching it. It is not proof of behavioural
 * coverage. A test that calls the function and asserts nothing about the
 * result, or asserts only that it returned, still binds the name. Coverage
 * of the function's branches is `critical-coverage`'s question; whether the
 * assertions would catch a wrong answer is `kragg mutation`'s. This module
 * establishes the link between a change and a test, nothing further.
 *
 * ── SKIPPED TESTS ARE NOT EVIDENCE ─────────────────────────────────────────
 * Identifiers inside `it.skip`, `test.todo`, `describe.skip` and node:test's
 * `{ skip: true }` are recorded separately, because a skipped test exercises
 * nothing. They are kept so a gate can SAY the only reference is skipped,
 * which is a different fix from "no test names this at all".
 *
 * ── THE FILE MUST BE IN THE PROGRAM ────────────────────────────────────────
 * Symbols exist only for files the project's `tsconfig.json` includes. A test
 * file outside the program has no checker view and so yields no evidence;
 * that is reported as such, never guessed around, because the alternative is
 * the text search this module replaces. The fix is on the project's side:
 * include the test paths in `tsconfig.json`.
 *
 * ── TYPE POSITIONS DO NOT COUNT ────────────────────────────────────────────
 * `let x: Client`, `typeof verifyPassword` in a type, `satisfies Options` —
 * a name in a type position binds a symbol but runs nothing, and `import`/
 * `export` declarations are where names are bound rather than used. Both are
 * skipped, so importing a function is not yet evidence of exercising it.
 */

import { relative } from "node:path";

import type bundledTs from "typescript";

import { toPosix } from "../../analysis/modulePath.ts";
import { programSourceFiles, type AnalysisProgram } from "../../analysis/program.ts";
import { moduleName, type TypeScriptApi } from "../../analysis/sourceFile.ts";
import { registerNode } from "../criticality/register.ts";
import { newScope, type Scope } from "../criticality/scope.ts";
import { isSkippedTestCall } from "./testCases.ts";

/** What one or more test files bind, split by whether the test runs. */
export interface BoundReferences {
  /** `<module>#<name>` of every registered function bound outside a skipped test. */
  readonly functions: ReadonlySet<string>;
  /** Source modules any bound identifier resolves into, outside a skipped test. */
  readonly modules: ReadonlySet<string>;
  /** The same, for identifiers inside a skipped or todo test only. */
  readonly skippedFunctions: ReadonlySet<string>;
  readonly skippedModules: ReadonlySet<string>;
}

/** A test file's evidence, or the reason it could not give any. */
export type FileEvidence =
  | { readonly kind: "resolved"; readonly references: BoundReferences }
  | { readonly kind: "outside-program" };

/** Why an out-of-program test file yields nothing, in a gate message. */
export const OUTSIDE_PROGRAM_NOTE =
  "outside the tsconfig.json program, so its references could not be resolved";

/** Program file -> module name, for the files under the source paths. */
type ModuleByFile = ReadonlyMap<bundledTs.SourceFile, string>;

/** Repo-relative POSIX path -> the program's file, for every project file. */
type FileByPath = ReadonlyMap<string, bundledTs.SourceFile>;

/** The checker, the registered declarations, and the file lookup. */
export interface ReferenceResolver {
  readonly api: TypeScriptApi;
  readonly checker: bundledTs.TypeChecker;
  /** Declaration node -> qualified name, over the files under the source paths. */
  readonly scope: Scope;
  readonly sourceModules: ModuleByFile;
  readonly byRelative: FileByPath;
}

/** A resolver, or the program's own reason it could not be built. */
export type ResolverLoad =
  | { readonly ok: true; readonly resolver: ReferenceResolver }
  | { readonly ok: false; readonly message: string };

/**
 * Build the resolver on the run's shared program.
 *
 * Loads the program (a memoised call: the pipeline built it for the
 * type-aware gates and the criticality derivation already) and registers the
 * declarations of every project file under `sourcePaths`, exactly as
 * `buildCallGraph` does, so the names match the sidecar's.
 */
export function referenceResolver(
  program: AnalysisProgram,
  sourcePaths: readonly string[],
): ResolverLoad {
  const loaded = program.load();
  if (!loaded.ok) {
    return { ok: false, message: loaded.message };
  }
  const api = program.compiler.api;
  const scope = newScope(api);
  const sourceModules = new Map<bundledTs.SourceFile, string>();
  const byRelative = new Map<string, bundledTs.SourceFile>();
  for (const file of programSourceFiles(loaded.program)) {
    const relativePath = toPosix(relative(program.root, file.fileName));
    byRelative.set(relativePath, file);
    if (!isUnderAny(relativePath, sourcePaths)) {
      continue;
    }
    const module = moduleName(file.fileName, program.root);
    sourceModules.set(file, module);
    api.forEachChild(file, (node) => {
      registerNode(scope, node, module, []);
    });
  }
  return {
    ok: true,
    resolver: { api, checker: loaded.checker, scope, sourceModules, byRelative },
  };
}

/** The evidence one repo-relative test file gives, or why it gives none. */
export function fileEvidence(resolver: ReferenceResolver, relativePath: string): FileEvidence {
  const file = resolver.byRelative.get(relativePath);
  if (file === undefined) {
    return { kind: "outside-program" };
  }
  return { kind: "resolved", references: boundReferences(resolver, file) };
}

/** Every bound reference in one program file. */
export function boundReferences(
  resolver: ReferenceResolver,
  file: bundledTs.SourceFile,
): BoundReferences {
  const into: MutableReferences = {
    functions: new Set(),
    modules: new Set(),
    skippedFunctions: new Set(),
    skippedModules: new Set(),
  };
  resolver.api.forEachChild(file, (node) => {
    collect(node, resolver, into, false);
  });
  return into;
}

/** The union of several files' evidence — a test plus the helpers it imports. */
export function mergeReferences(parts: readonly BoundReferences[]): BoundReferences {
  const merged: MutableReferences = {
    functions: new Set(),
    modules: new Set(),
    skippedFunctions: new Set(),
    skippedModules: new Set(),
  };
  for (const part of parts) {
    for (const name of part.functions) merged.functions.add(name);
    for (const name of part.modules) merged.modules.add(name);
    for (const name of part.skippedFunctions) merged.skippedFunctions.add(name);
    for (const name of part.skippedModules) merged.skippedModules.add(name);
  }
  return merged;
}

/**
 * Whether a repo-relative path sits at, or under, one of the prefixes.
 *
 * Segment-aware — `test` matches `test/a.ts` but not `testing/a.ts` — like
 * `isAllowed` in `git/changes.ts`, which produced the change set this is
 * applied to. An empty or `.` prefix matches everything.
 */
export function isUnderAny(path: string, prefixes: readonly string[]): boolean {
  const normalized = normalizePath(path);
  return prefixes.some((prefix) => {
    const base = normalizePath(prefix);
    if (base === "" || base === ".") {
      return true;
    }
    return normalized === base || normalized.startsWith(`${base}/`);
  });
}

/** Repo-relative POSIX normalisation: `/` separators, no `./`, no trailing `/`. */
export function normalizePath(value: string): string {
  let path = value.replaceAll("\\", "/");
  while (path.startsWith("./")) {
    path = path.slice(2);
  }
  while (path.endsWith("/") && path.length > 1) {
    path = path.slice(0, -1);
  }
  return path;
}

/* --- Internals ------------------------------------------------------------ */

interface MutableReferences {
  readonly functions: Set<string>;
  readonly modules: Set<string>;
  readonly skippedFunctions: Set<string>;
  readonly skippedModules: Set<string>;
}

/**
 * Walk a subtree, recording every identifier that binds a registered
 * declaration, and marking the ones inside a skipped test or suite.
 */
function collect(
  node: bundledTs.Node,
  resolver: ReferenceResolver,
  into: MutableReferences,
  skipped: boolean,
): void {
  const { api } = resolver;
  if (
    api.isImportDeclaration(node) ||
    api.isImportEqualsDeclaration(node) ||
    api.isExportDeclaration(node) ||
    api.isTypeNode(node)
  ) {
    return;
  }
  if (api.isIdentifier(node)) {
    record(node, resolver, into, skipped);
    return;
  }
  const inner = skipped || (api.isCallExpression(node) && isSkippedTestCall(node, api));
  api.forEachChild(node, (child) => {
    collect(child, resolver, into, inner);
  });
}

/** Resolve one identifier through the checker and file what it declares. */
function record(
  identifier: bundledTs.Identifier,
  resolver: ReferenceResolver,
  into: MutableReferences,
  skipped: boolean,
): void {
  const symbol = symbolOf(identifier, resolver);
  const declarations = symbol?.declarations;
  if (declarations === undefined) {
    return;
  }
  for (const declaration of declarations) {
    const qualname = registeredName(resolver.scope, declaration);
    if (qualname !== undefined) {
      (skipped ? into.skippedFunctions : into.functions).add(qualname);
    }
    const module = resolver.sourceModules.get(declaration.getSourceFile());
    if (module !== undefined) {
      (skipped ? into.skippedModules : into.modules).add(module);
    }
  }
}

/**
 * The graph node a declaration is, if it is one.
 *
 * The same lookup order as `resolveCallee` in `criticality/graph.ts`: a
 * function first; then a class, which the graph names after its declared
 * constructor when it has one and after the class itself otherwise. So
 * `new PolicyError("…")` in a test binds the node `criticality.json` holds
 * for `PolicyError`, whichever spelling that is.
 */
function registeredName(scope: Scope, declaration: bundledTs.Node): string | undefined {
  const asFunction = scope.functions.get(declaration);
  if (asFunction !== undefined) {
    return asFunction;
  }
  const asClass = scope.classes.get(declaration);
  return asClass === undefined ? undefined : (scope.constructors.get(declaration) ?? asClass);
}

/**
 * The symbol an identifier denotes, aliases followed to the definition.
 *
 * `{ verifyPassword }` in an object literal is the one shape where the
 * identifier's own symbol is the PROPERTY it creates; the value it reads is
 * asked for separately. An alias — an import, an `as` rename, a re-export —
 * is followed the whole way, as the call graph follows it.
 */
function symbolOf(
  identifier: bundledTs.Identifier,
  resolver: ReferenceResolver,
): bundledTs.Symbol | undefined {
  const { api, checker } = resolver;
  const parent = identifier.parent;
  const symbol =
    api.isShorthandPropertyAssignment(parent) && parent.name === identifier
      ? checker.getShorthandAssignmentValueSymbol(parent)
      : checker.getSymbolAtLocation(identifier);
  if (symbol === undefined || (symbol.flags & api.SymbolFlags.Alias) === 0) {
    return symbol;
  }
  return checker.getAliasedSymbol(symbol);
}
