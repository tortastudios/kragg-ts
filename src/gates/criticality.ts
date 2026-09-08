/**
 * Call-graph criticality analysis, built on the shared `ts.Program`.
 *
 * The port of `kragg/src/kragg/gates/criticality.py`. It answers one question:
 * WHICH FUNCTIONS ARE LOAD-BEARING? A function with many callers, or one that
 * sits on many of the shortest call paths between other functions, is where a
 * careless edit does the most damage — so kragg demands full types, docs and
 * tests when one of them changes.
 *
 * The metrics, the thresholds and the JSON payload are identical to Python's,
 * because both tools write `.kragg/criticality.json` and the same downstream
 * gates and hooks read it. What differs is HOW A CALL IS RESOLVED.
 *
 * PYTHON RESOLVES BY NAME, BECAUSE IT HAS TO. `criticality.py` says so in its
 * own docstring: bare calls are looked up in the defining module then through
 * its imports, `self.method()` within the enclosing class, `obj.method()` only
 * when `obj`'s class is recoverable from a parameter annotation, an annotated
 * assignment or a direct constructor call. Everything else is dropped. That is
 * a deliberate precision-over-recall trade, forced by the absence of a type
 * checker at analysis time.
 *
 * TYPESCRIPT HAS A REAL TYPE CHECKER, SO WE USE IT. Every call site is
 * resolved with `checker.getSymbolAtLocation()`, alias-followed through
 * imports and re-exports with `getAliasedSymbol()`, and mapped back to the
 * declaration that produced it. That resolves receivers the Python heuristic
 * structurally cannot — an inherited method from a base class in another file,
 * a method on a value returned by a function, a destructured import, a barrel
 * re-export, a `this.helper()` in a subclass.
 *
 * THE "NEVER GUESS" DISCIPLINE IS KEPT, and it is the reason this is
 * trustworthy. A call is recorded only when its symbol resolves to a
 * declaration in the analyzed file set. Anything landing in `node_modules` or
 * a `lib.*.d.ts` is DROPPED, not invented — as is anything the checker cannot
 * resolve at all (`obj[name]()`, a call through an `any`, a dynamic dispatch).
 * A missing edge understates criticality; a fabricated edge sends a reviewer
 * to the wrong function. Understating is the safe failure.
 *
 * KNOWN RECALL GAP, stated rather than papered over: a call through an
 * INTERFACE-typed receiver (`service.run()` where `service: Service`) resolves
 * to the interface's method signature, not to any implementation, so no edge
 * is recorded. Walking from the signature to every implementing class would
 * be guessing about which one runs. Python has the same blind spot for the
 * same reason, so this does not widen the gap between the two tools.
 *
 * WHAT COUNTS AS A NODE. Module-level functions, class methods, constructors,
 * accessors, object-literal methods, and — deliberately — ARROW FUNCTIONS AND
 * FUNCTION EXPRESSIONS BOUND TO A MODULE-LEVEL `const` OR A CLASS PROPERTY.
 * `export const check = (): GateResult => ...` is the dominant idiom in
 * TypeScript; excluding it would gut the graph and make this gate report
 * confidently on a fiction. Functions nested INSIDE another function body are
 * not nodes — their calls are attributed to the enclosing node — which is also
 * what Python does (`_index_definitions` never recurses into a `FunctionDef`).
 *
 * NAMING. Nodes are `"<module>#<qualified.name>"`, e.g.
 * `src/gates/criticality/graph#buildCallGraph` or
 * `src/engine/gate#Pipeline.run`. The `#` separator is the same one
 * `moduleImports` already uses, and it is unambiguous in a world where module
 * names contain `/` and `.`. This diverges from Python's dotted
 * `kragg.gates.criticality.build_call_graph` because a TypeScript module
 * specifier is a path, not a dotted package name.
 *
 * THIS FILE IS THE PUBLIC ENTRY POINT and nothing else. The analysis lives in
 * six single-concern modules:
 *
 *  - `criticality/scope.ts` — what the registration pass learns, and the
 *    naming rules it learns it under;
 *  - `criticality/register.ts` — pass 1, which declarations are graph nodes;
 *  - `criticality/graph.ts` — pass 2, resolving each call against the checker;
 *  - `criticality/profile.ts` — the metrics, the thresholds and `analyze`;
 *  - `criticality/report.ts` — Markdown, the terminal table and the JSON
 *    cross-language contract. It also owns `TOP_N`, and owning it there is the
 *    point: the two RENDERINGS stop at twenty, while the JSON the gates
 *    enforce over carries the whole ranked population;
 *  - `criticality/freshness.ts` — whether the JSON on disk still describes
 *    THIS tree. The data is a cache of a derived fact, and a cache nobody
 *    validates is a gate reporting confidently on functions that no longer
 *    exist. `readJson` hands out nothing without it.
 *
 * WHAT THE FACADE RE-EXPORTS is what something outside `criticality/` names.
 * `printTable`, `TOP_N`, `CallGraphInput` and `CriticalityPayload` were re-
 * exported here and referenced by nothing, anywhere — surface, not API — and
 * the `structure` gate's symbol budget is exactly the mechanism that is meant
 * to force that conversation rather than let a facade accrete. They are still
 * exported by the modules that define them, so a future caller is one line
 * away; the names simply do not sit in the public door until someone opens it.
 */

export {
  criticalityFreshness,
  STALE_CRITICALITY_REASON,
  writeStamp,
} from "./criticality/freshness.ts";

export { buildCallGraph } from "./criticality/graph.ts";

export type {
  CriticalityAnalysis,
  CriticalityOptions,
  FunctionProfile,
} from "./criticality/profile.ts";
export {
  analyze,
  BETWEENNESS_THRESHOLD,
  FAN_IN_THRESHOLD,
  riskLabel,
} from "./criticality/profile.ts";

export {
  criticalityPath,
  formatReport,
  formatTable,
  readJson,
  toPayload,
  writeJson,
  writeReport,
} from "./criticality/report.ts";
