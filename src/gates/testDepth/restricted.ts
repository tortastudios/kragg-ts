/**
 * Members TypeScript's own visibility keywords put out of a test's reach, and
 * what counts as evidence that one of them ran anyway.
 *
 * ── THE PROBLEM THIS SOLVES ────────────────────────────────────────────────
 * `test-quality` asks every PUBLIC critical function for a DIRECT bound
 * reference: some identifier in the test tree that the checker resolves to
 * that exact declaration. For an exported function that is the right bar. For
 * a `private sign()` on an exported class it is an impossible one — the
 * compiler refuses `client.sign(...)` from a test file — so the only two ways
 * to satisfy the gate were to export the helper purely so a test could name
 * it, or to write a reference that binds the name without testing anything.
 * Both make the codebase worse to satisfy a checker, which is the failure mode
 * this whole family of gates exists to avoid.
 *
 * An ECMAScript `#private` member never had that problem: `criticality.ts`
 * records it with its `#`, and `isPrivateQualname` reads that `#` as the
 * visibility marker it is, so the member never reaches the demand. TypeScript's
 * `private`/`protected` leave no trace in a name, so nothing downstream could
 * tell such a member from a public one. This module supplies the missing fact —
 * from the DECLARATIONS the checker already handed us, never from the name.
 *
 * ── WHAT IS EXEMPTED, AND WHAT IS NOT ──────────────────────────────────────
 * Only the DIRECT-REFERENCE demand is relaxed, and only for a member that the
 * test suite demonstrably reaches. `exercisedFunctions` starts from what the
 * tests actually bind and follows the call graph — the same graph, built by the
 * same `buildCallGraph` with the same checker-resolved edges, that decided
 * these functions were critical in the first place. A private member on a path
 * from an exercised public entry point is evidence; a private member on no such
 * path is still reported, because it is exactly the untested critical logic the
 * gate is for.
 *
 * Nothing else changes. Such a member stays in `criticalFunctions`, so
 * `critical-coverage` still demands that not one of its lines is uncovered and
 * `critical-tests` still demands a relevant test change when its file is
 * edited. "Reachable through the class's exported surface" is a statement about
 * what counts as EVIDENCE, not a smaller population to enforce on.
 *
 * ── WHY THE WHOLE GRAPH, NOT JUST THE CLASS BODY ───────────────────────────
 * A `private` member can only be called from inside its own class, so its
 * immediate callers are always one file away. Its callers' callers are not:
 * the public method that reaches it may itself be called from another module,
 * and a `protected` member is reachable from any subclass anywhere. Walking the
 * real graph gets all three cases right for the same code, and it costs one
 * graph build on a program that is already compiled — paid only when a
 * restricted member is unbound and would otherwise be a finding.
 */

import type bundledTs from "typescript";

import { successorsOf, type DirectedGraph } from "../../analysis/betweenness.ts";
import { buildCallGraph } from "../criticality/graph.ts";
import type { ReferenceResolver } from "./references.ts";

/**
 * The registered functions declared `private` or `protected`, by qualified name.
 *
 * Read off the SAME registration that named the nodes in `criticality.json`
 * (`resolver.scope`), so the two sides cannot drift: every key is a declaration
 * node the criticality pass already mapped to a name, and the only question
 * asked of it is which modifiers it carries. `getCombinedModifierFlags` is the
 * compiler's own answer, taken from the project's compiler, never a keyword
 * scanned out of the source text.
 *
 * `#private` members are absent from this set and do not need to be in it:
 * their `#` is part of the recorded name and `isPrivateQualname` has always
 * caught them.
 */
export function restrictedNames(resolver: ReferenceResolver): ReadonlySet<string> {
  const { api } = resolver;
  const restrictive = api.ModifierFlags.Private | api.ModifierFlags.Protected;
  const names = new Set<string>();
  for (const [declaration, qualname] of resolver.scope.functions) {
    const node = declaration as bundledTs.Declaration;
    if ((api.getCombinedModifierFlags(node) & restrictive) !== 0) {
      names.add(qualname);
    }
  }
  return names;
}

/**
 * Everything the test suite reaches: what it binds, plus what that transitively
 * calls.
 *
 * The seeds are bound references only — never a skipped test's, which
 * `references.ts` keeps in a separate set precisely so it cannot leak into
 * evidence. Edges come from `buildCallGraph` over the same source files the
 * resolver registered, so a name in the result is spelled exactly as
 * `criticality.json` spells it.
 *
 * A call the checker cannot resolve contributes no edge, here as everywhere in
 * the call graph: the closure UNDERSTATES what ran, which leaves a genuinely
 * exercised member reported rather than an unexercised one excused.
 */
export function exercisedFunctions(
  resolver: ReferenceResolver,
  bound: ReadonlySet<string>,
): ReadonlySet<string> {
  const graph = buildCallGraph({
    api: resolver.api,
    program: resolver.program,
    checker: resolver.checker,
    root: resolver.root,
    files: [...resolver.sourceModules.keys()],
  });
  return reachable(graph, bound);
}

/** Breadth-first closure over the call graph from a set of seeds. */
function reachable(graph: DirectedGraph, seeds: ReadonlySet<string>): ReadonlySet<string> {
  const reached = new Set<string>(seeds);
  const queue = [...seeds];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current === undefined) {
      continue;
    }
    for (const next of successorsOf(graph, current)) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  return reached;
}
