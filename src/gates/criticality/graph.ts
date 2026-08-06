/**
 * Pass 2 of the call graph: attribute every resolvable call to its caller.
 *
 * PYTHON RESOLVES BY NAME, BECAUSE IT HAS TO. TYPESCRIPT HAS A REAL TYPE
 * CHECKER, SO WE USE IT — every call site is resolved with
 * `checker.getSymbolAtLocation()`, alias-followed through imports and
 * re-exports with `getAliasedSymbol()`, and mapped back to the declaration
 * that produced it.
 *
 * THE "NEVER GUESS" DISCIPLINE IS KEPT, and it is the reason this is
 * trustworthy. A call is recorded only when its symbol resolves to a
 * declaration in the analyzed file set. Anything landing in `node_modules` or
 * a `lib.*.d.ts` is DROPPED, not invented. A missing edge understates
 * criticality; a fabricated edge sends a reviewer to the wrong function.
 */

import type bundledTs from "typescript";

import {
  addEdge,
  addNode,
  createDirectedGraph,
  type DirectedGraph,
} from "../../analysis/betweenness.ts";
import { programSourceFiles } from "../../analysis/program.ts";
import { moduleName, type TypeScriptApi } from "../../analysis/sourceFile.ts";
import { registerNode } from "./register.ts";
import { newScope, type Scope } from "./scope.ts";

/** A caller-supplied file list, or the program's own source files. */
export type SourceFileList = readonly bundledTs.SourceFile[];

/** Everything {@link buildCallGraph} needs, with the program already built. */
export interface CallGraphInput {
  /**
   * The compiler that produced `program`. Predicates must come from it and
   * never from a `typescript` import of this module's own — see
   * `resolveTypeScript`.
   */
  readonly api: TypeScriptApi;
  readonly program: bundledTs.Program;
  readonly checker: bundledTs.TypeChecker;
  /** Repo root. Module names are taken relative to it, as `moduleName` does. */
  readonly root: string;
  /** Files to analyze. Defaults to `programSourceFiles(program)`. */
  readonly files?: SourceFileList | undefined;
}

/**
 * Build the directed call graph for a set of source files.
 *
 * Two passes, and the split is not incidental: a call may target a function
 * declared later in the file or in a file not yet visited, so nothing can be
 * resolved until every declaration is known.
 *
 *  1. REGISTER every declaration that is a graph node, recording both the node
 *     a symbol would point at and the node whose body's calls belong to it —
 *     for `const f = () => {}` those are the variable declaration and the
 *     arrow, and they are different nodes.
 *  2. WALK every file, tracking the innermost registered enclosing function,
 *     and resolve each call and `new` against the registration.
 *
 * Every registered function is seeded as a node BEFORE any edge is added, so
 * functions nobody calls still count toward `n` and dilute everyone else's
 * centrality — the same reason Python calls `add_nodes_from(index.functions)`
 * first. Self-edges are dropped, as Python drops `callee != body.qualname`.
 */
export function buildCallGraph(input: CallGraphInput): DirectedGraph {
  const files = input.files ?? programSourceFiles(input.program);
  const scope = newScope(input.api);

  for (const file of files) {
    input.api.forEachChild(file, (node) => {
      registerNode(scope, node, moduleName(file.fileName, input.root), []);
    });
  }

  const graph = createDirectedGraph();
  // Sorted, so the node order — and therefore every tie-break downstream — is
  // reproducible regardless of the order the program hands back its files.
  for (const name of [...scope.names].sort()) {
    addNode(graph, name);
  }
  for (const file of files) {
    scanCalls(scope, input.checker, graph, file, null);
  }
  return graph;
}

/**
 * Walk a subtree, attributing every resolvable call to the innermost
 * registered enclosing function.
 *
 * Calls at module top level have no owner and are IGNORED, matching Python,
 * which only ever walks function bodies. A decorator on a method, by contrast,
 * is a child of that method's node and so is attributed to it — which is also
 * what Python does, since `decorator_list` hangs off the `FunctionDef`.
 */
function scanCalls(
  scope: Scope,
  checker: bundledTs.TypeChecker,
  graph: DirectedGraph,
  node: bundledTs.Node,
  owner: string | null,
): void {
  const api = scope.api;
  if (owner !== null && (api.isCallExpression(node) || api.isNewExpression(node))) {
    const callee = resolveCallee(scope, checker, node.expression);
    if (callee !== null && callee !== owner) {
      addEdge(graph, owner, callee);
    }
  }
  const inner = scope.bodies.get(node) ?? owner;
  api.forEachChild(node, (child) => {
    scanCalls(scope, checker, graph, child, inner);
  });
}

/**
 * Resolve a call target to a graph node, or `null` when it cannot be resolved
 * to a declaration in the analyzed file set.
 *
 * `null` is the honest answer for a call into `node_modules`, into
 * `lib.*.d.ts`, through an interface, through `any`, or through a computed
 * member — and it is returned rather than a plausible-looking guess. See
 * `gates/criticality.ts` for why understating is the safe failure.
 */
function resolveCallee(
  scope: Scope,
  checker: bundledTs.TypeChecker,
  target: bundledTs.Expression,
): string | null {
  const api = scope.api;
  let symbol = checker.getSymbolAtLocation(unwrap(api, target));
  if (symbol === undefined) {
    return null;
  }
  if ((symbol.flags & api.SymbolFlags.Alias) !== 0) {
    // Follows the whole chain: `import { a } from "./b"` where `./b` itself
    // re-exports from `./c` lands on the definition in `./c`.
    symbol = checker.getAliasedSymbol(symbol);
  }
  const declarations = symbol.declarations;
  if (declarations === undefined) {
    return null;
  }
  for (const declaration of declarations) {
    const callee = scope.functions.get(declaration);
    if (callee !== undefined) {
      return callee;
    }
  }
  for (const declaration of declarations) {
    const className = scope.classes.get(declaration);
    if (className !== undefined) {
      return scope.constructors.get(declaration) ?? className;
    }
  }
  return null;
}

/**
 * Strip the wrappers that sit between a call and its real target.
 *
 * `(foo)()`, `foo!()`, `(foo as Handler)()` and `(foo satisfies Handler)()`
 * all call `foo`; without this they would resolve to no symbol at all and be
 * silently dropped.
 */
function unwrap(api: TypeScriptApi, node: bundledTs.Expression): bundledTs.Expression {
  let current = node;
  for (;;) {
    if (
      api.isParenthesizedExpression(current) ||
      api.isNonNullExpression(current) ||
      api.isAsExpression(current) ||
      api.isSatisfiesExpression(current) ||
      api.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}
