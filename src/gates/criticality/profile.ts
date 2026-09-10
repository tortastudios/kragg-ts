/**
 * Call-graph metrics per function, and the thresholds that make one critical.
 *
 * The metrics, the thresholds and the risk bands are identical to Python's,
 * because both tools write `.kragg/criticality.json` and the same downstream
 * gates and hooks read it.
 */

import {
  betweennessCentrality,
  inDegree,
  nodeCount,
  outDegree,
  type DirectedGraph,
} from "../../analysis/betweenness.ts";
import type { AnalysisProgram } from "../../analysis/program.ts";
import type { CriticalDeclarations } from "../../policy/policy.ts";
import { declaredReasons } from "./declared.ts";
import { buildCallGraph, type SourceFileList } from "./graph.ts";

/** Callers at or above this count make a function critical. */
export const FAN_IN_THRESHOLD = 3;
/** Betweenness at or above this makes a function critical. */
export const BETWEENNESS_THRESHOLD = 0.1;

/**
 * Call-graph metrics for one function or method.
 *
 * A plain interface, not a class, per the repo convention: Python's
 * `risk_label` property lives here as the free function {@link riskLabel},
 * exactly as `Violation.location()` became `violationLocation`.
 */
export interface FunctionProfile {
  /** `"<module>#<qualified.name>"`. */
  readonly name: string;
  /** Distinct functions that call this one. */
  readonly fanIn: number;
  /** Distinct functions this one calls. */
  readonly fanOut: number;
  /** Normalized betweenness centrality; see `analysis/betweenness.ts`. */
  readonly betweenness: number;
  readonly isCritical: boolean;
  /**
   * Why a REVIEWER declared this function critical, when one did.
   *
   * Absent on every graph-selected function, which is why it is optional
   * rather than an empty string: the key's presence is what says "a human
   * decided this", and `policy.criticalFunctions` is where the decision lives.
   * It never reaches `.kragg/criticality.json` — that record shape is a
   * cross-language contract and does not grow a key — so it is re-derived from
   * the policy wherever it is shown. See `declared.ts`.
   */
  readonly declaredReason?: string;
}

/**
 * Risk band for a profile — the analogue of Python's `risk_label` property.
 *
 * Deliberately coarser than `isCritical`: `HIGH` marks the handful of
 * functions worth a second reviewer, `MED` the ones that merely need tests.
 * The thresholds are duplicated from Python on purpose, because the label is
 * written into the shared JSON.
 */
export function riskLabel(profile: FunctionProfile): string {
  if (profile.betweenness >= 0.2 || profile.fanIn >= 5) {
    return "HIGH";
  }
  if (profile.betweenness >= BETWEENNESS_THRESHOLD || profile.fanIn >= FAN_IN_THRESHOLD) {
    return "MED";
  }
  return "low";
}

/** Options for {@link analyze}. */
export interface CriticalityOptions {
  /**
   * The SHARED, lazy program handle.
   *
   * This gate takes a handle rather than a root path precisely so a caller can
   * build one `ts.Program` and hand it to every type-aware gate in the run.
   * Constructing a program is seconds of work on a real repo; see
   * `analysis/program.ts` for why that makes sharing structural rather than an
   * optimization.
   */
  readonly analysis: AnalysisProgram;
  /** Narrow the analysis to specific files. Defaults to the whole program. */
  readonly files?: SourceFileList | undefined;
  readonly fanInThreshold?: number | undefined;
  readonly betweennessThreshold?: number | undefined;
  /**
   * Reviewed declarations from the policy, which make a function critical in
   * ADDITION to the graph's own selection.
   *
   * Passed in rather than read from disk here so that `analyze` stays a
   * function of its inputs; the callers that persist or print the result read
   * them with `declaredCritical(root)`.
   */
  readonly declared?: CriticalDeclarations | undefined;
}

/**
 * The outcome of {@link analyze}.
 *
 * A discriminated union rather than a throw, mirroring `ProgramLoad`: the
 * caller has to turn "I could not run" into a `GateResult` with `error: true`,
 * and an exception would make the normal path the one needing a try/catch.
 * Python raises `RuntimeError` here because it has no equivalent obligation.
 */
export type CriticalityAnalysis =
  | {
      readonly ok: true;
      /**
       * EVERY function in the graph, riskiest first — never a truncated slice.
       *
       * This list is what enforcement runs on: the cache writes it to
       * `.kragg/criticality.json`, and `critical-tests`, `critical-coverage`,
       * the test-depth gates and mutation targeting all read it back from
       * there. A cap applied here would silently shrink the enforced
       * population, which is why there is no `topN` option: `report.ts`
       * truncates when it RENDERS, and nowhere else. See `TOP_N` there.
       */
      readonly profiles: readonly FunctionProfile[];
      /** The full graph, so a caller need not rebuild it. */
      readonly graph: DirectedGraph;
    }
  | {
      readonly ok: false;
      /** Ready to show a human: what failed and how to fix it. */
      readonly message: string;
    };

/**
 * Analyze call-graph centrality and rank every function in the graph.
 *
 * `options.declared` adds the reviewed critical functions on top of the two
 * thresholds. They keep their real metrics and their real place in the
 * ranking — a declared entrypoint with one caller still reads `fan-in 1` — and
 * only `isCritical` changes, which is what makes the sidecar record shape
 * unchanged and the downstream gates need no special case. See `declared.ts`.
 *
 * The result is COMPLETE. Truncation is a presentation decision and lives in
 * `report.ts`; returning a top-N slice from here truncated enforcement too,
 * because the cache persists exactly what this returns and every criticality
 * gate reads that file.
 *
 * Ordering mirrors Python exactly: a STABLE ascending sort by
 * `(betweenness, fanIn)` which is then reversed, so the result is descending
 * and ties fall in reverse insertion order. Graph nodes are seeded in sorted
 * name order, which makes that tie-break reproducible here — on the Python
 * side it comes from a `set` and varies with `PYTHONHASHSEED`, so tied entries
 * may be ordered differently between the two tools. Their VALUES agree; only
 * the arrangement of exact ties does not.
 */
export function analyze(options: CriticalityOptions): CriticalityAnalysis {
  const loaded = options.analysis.load();
  if (!loaded.ok) {
    return { ok: false, message: loaded.message };
  }
  const graph = buildCallGraph({
    api: options.analysis.compiler.api,
    program: loaded.program,
    checker: loaded.checker,
    root: options.analysis.root,
    ...(options.files === undefined ? {} : { files: options.files }),
  });
  if (nodeCount(graph) === 0) {
    return { ok: true, profiles: [], graph };
  }

  const inputs: ProfileInputs = {
    graph,
    centrality: betweennessCentrality(graph),
    reasons: declaredReasons(options.declared ?? []),
    fanInThreshold: options.fanInThreshold ?? FAN_IN_THRESHOLD,
    betweennessThreshold: options.betweennessThreshold ?? BETWEENNESS_THRESHOLD,
  };
  const profiles: FunctionProfile[] = graph.nodes.map((node) => profileOf(node, inputs));

  profiles.sort((a, b) => a.betweenness - b.betweenness || a.fanIn - b.fanIn);
  profiles.reverse();
  return { ok: true, profiles, graph };
}

/** Everything one node's profile is computed from, gathered once per run. */
interface ProfileInputs {
  readonly graph: DirectedGraph;
  readonly centrality: ReadonlyMap<string, number>;
  /** Declared name -> the reviewer's reason; empty when nothing is declared. */
  readonly reasons: ReadonlyMap<string, string>;
  readonly fanInThreshold: number;
  readonly betweennessThreshold: number;
}

/**
 * One node's metrics and verdict.
 *
 * THE VERDICT IS A UNION. A declaration only ever adds: a function the
 * thresholds already selected stays critical whatever the policy says, and
 * there is no spelling of `critical_functions` that demotes one. The metrics
 * are the node's real ones either way — a declared entrypoint reads `fan-in
 * 1`, because that is true and pretending otherwise would corrupt the ranking
 * everything else depends on.
 */
function profileOf(node: string, inputs: ProfileInputs): FunctionProfile {
  const fanIn = inDegree(inputs.graph, node);
  const betweenness = inputs.centrality.get(node) ?? 0;
  const declaredReason = inputs.reasons.get(node);
  return {
    name: node,
    fanIn,
    fanOut: outDegree(inputs.graph, node),
    betweenness,
    isCritical:
      fanIn >= inputs.fanInThreshold ||
      betweenness >= inputs.betweennessThreshold ||
      declaredReason !== undefined,
    ...(declaredReason === undefined ? {} : { declaredReason }),
  };
}
