/**
 * From a callee expression to every path it can be banned under.
 *
 * WHY THIS IS THE TYPE-AWARE GATE. The Python sibling reconstructs types by
 * hand from annotations. Here the tool exists, so resolution is
 * `getSymbolAtLocation` on the callee, follow aliases, then derive a path from
 * the DECLARATION the checker points at. The discipline is preserved exactly:
 * when the checker cannot resolve a symbol, the call is SKIPPED. Nothing is
 * ever guessed.
 */

import type bundledTs from "typescript";

import { declarationPath } from "./declarationPath.ts";
import { GLOBAL_PREFIX, type Resolver } from "./resolver.ts";

/** How far up a heritage chain an overridden member is matched. */
const MAX_INHERITANCE_DEPTH = 8;

/**
 * Every path this callee can be banned under, canonical spelling first.
 *
 * Order is: the original declaration, then each re-export spelling from
 * nearest-to-original outward, then inherited base-member spellings. An empty
 * result means "unresolvable" and the call is skipped.
 */
export function resolvedPaths(
  callee: bundledTs.Expression,
  resolver: Resolver,
): readonly string[] {
  const symbol = symbolAt(callee, resolver);
  if (symbol === undefined) {
    return [];
  }
  const chain = aliasChain(symbol, resolver);
  const paths: string[] = [];
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const link = chain[index];
    if (link !== undefined) {
      paths.push(...symbolPaths(link, resolver));
    }
  }
  const original = chain[chain.length - 1];
  if (original !== undefined) {
    paths.push(...inheritedPaths(original, resolver, new Set([original]), MAX_INHERITANCE_DEPTH));
  }
  // A global is bannable under both spellings. The qualified one stays first,
  // so `globalThis.eval` is what a report shows however the ban was written.
  const bare = paths
    .filter((path) => path.startsWith(GLOBAL_PREFIX))
    .map((path) => path.slice(GLOBAL_PREFIX.length));
  return [...new Set([...paths, ...bare])];
}

/**
 * The symbol a callee expression denotes, or `undefined` when the checker
 * cannot say.
 *
 * The fallback to the property NAME of a property access matters for optional
 * chains and for some synthesized members, where asking about the whole
 * expression yields nothing. `isUnknownSymbol` filters the checker's
 * placeholder for an unresolved name, which otherwise resolves to a path built
 * from the error location.
 */
function symbolAt(
  callee: bundledTs.Expression,
  resolver: Resolver,
): bundledTs.Symbol | undefined {
  const { api, checker } = resolver;
  let symbol = checker.getSymbolAtLocation(callee);
  if (symbol === undefined && api.isPropertyAccessExpression(callee)) {
    symbol = checker.getSymbolAtLocation(callee.name);
  }
  if (symbol === undefined || checker.isUnknownSymbol(symbol)) {
    return undefined;
  }
  return symbol;
}

/**
 * Walk import/export aliases one hop at a time, local binding first.
 *
 * `getImmediateAliasedSymbol` rather than `getAliasedSymbol` because the
 * single-hop walk is what exposes the INTERMEDIATE re-export spellings a
 * project may have banned. `getAliasedSymbol` is the fallback for a hop the
 * immediate walk cannot take, so the original is still reached.
 */
function aliasChain(
  symbol: bundledTs.Symbol,
  resolver: Resolver,
): readonly bundledTs.Symbol[] {
  const { api, checker } = resolver;
  const chain: bundledTs.Symbol[] = [symbol];
  const seen = new Set<bundledTs.Symbol>([symbol]);
  let current = symbol;
  while ((current.flags & api.SymbolFlags.Alias) !== 0) {
    let next: bundledTs.Symbol | undefined;
    try {
      next = checker.getImmediateAliasedSymbol(current) ?? checker.getAliasedSymbol(current);
    } catch {
      // An alias whose target does not exist. Stop where we are rather than
      // letting one broken import take down the file's scan.
      break;
    }
    if (next === undefined || seen.has(next)) {
      break;
    }
    chain.push(next);
    seen.add(next);
    current = next;
  }
  return chain;
}

/** Every declaration of a symbol, as a path. Import bindings contribute none. */
function symbolPaths(symbol: bundledTs.Symbol, resolver: Resolver): readonly string[] {
  const name = symbol.getName();
  const paths: string[] = [];
  for (const declaration of symbol.declarations ?? []) {
    const path = declarationPath(declaration, name, resolver);
    if (path !== null) {
      paths.push(path);
    }
  }
  return paths;
}

/**
 * Paths for the base-type members this symbol overrides.
 *
 * Heritage clauses are read syntactically, so `extends` and `implements` are
 * both followed. `visited` and the depth cap make a cyclic or pathological
 * hierarchy terminate rather than hang the run.
 */
function inheritedPaths(
  symbol: bundledTs.Symbol,
  resolver: Resolver,
  visited: Set<bundledTs.Symbol>,
  depth: number,
): readonly string[] {
  if (depth <= 0) {
    return [];
  }
  const name = symbol.getName();
  const paths: string[] = [];
  for (const declaration of symbol.declarations ?? []) {
    paths.push(...overriddenPaths(declaration, name, resolver, visited, depth));
  }
  return paths;
}

/** The base-member paths reachable through one declaration's heritage. */
function overriddenPaths(
  declaration: bundledTs.Declaration,
  name: string,
  resolver: Resolver,
  visited: Set<bundledTs.Symbol>,
  depth: number,
): readonly string[] {
  const { api } = resolver;
  const container: bundledTs.Node | undefined = declaration.parent;
  if (container === undefined) {
    return [];
  }
  if (!api.isClassLike(container) && !api.isInterfaceDeclaration(container)) {
    return [];
  }
  const paths: string[] = [];
  for (const clause of container.heritageClauses ?? []) {
    for (const typeNode of clause.types) {
      paths.push(...basePaths(typeNode, name, resolver, visited, depth));
    }
  }
  return paths;
}

/** The member `name` as declared by one heritage clause entry's base types. */
function basePaths(
  typeNode: bundledTs.ExpressionWithTypeArguments,
  name: string,
  resolver: Resolver,
  visited: Set<bundledTs.Symbol>,
  depth: number,
): readonly string[] {
  const paths: string[] = [];
  for (const base of baseTypes(typeNode, resolver)) {
    const property = resolver.checker.getPropertyOfType(base, name);
    if (property === undefined || visited.has(property)) {
      continue;
    }
    visited.add(property);
    paths.push(...symbolPaths(property, resolver));
    paths.push(...inheritedPaths(property, resolver, visited, depth - 1));
  }
  return paths;
}

/**
 * Each clause type is probed as written and, when that yields nothing, through
 * its construct signatures' return type — a class's `extends` clause denotes
 * the constructor, and the member lives on the instance.
 */
function baseTypes(
  typeNode: bundledTs.ExpressionWithTypeArguments,
  resolver: Resolver,
): readonly bundledTs.Type[] {
  const type = resolver.checker.getTypeAtLocation(typeNode);
  const instances = type.getConstructSignatures().map((signature) => signature.getReturnType());
  return [type, ...instances];
}
