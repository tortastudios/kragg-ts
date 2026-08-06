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
import { buildCallGraph, type SourceFileList } from "./graph.ts";

/** Callers at or above this count make a function critical. */
export const FAN_IN_THRESHOLD = 3;
/** Betweenness at or above this makes a function critical. */
export const BETWEENNESS_THRESHOLD = 0.1;
/** How many of the riskiest functions a report shows. */
export const TOP_N = 20;

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
  readonly topN?: number | undefined;
  readonly fanInThreshold?: number | undefined;
  readonly betweennessThreshold?: number | undefined;
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
      /** The riskiest functions, longest-first, capped at `topN`. */
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
 * Analyze call-graph centrality and return the riskiest functions.
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

  const fanInThreshold = options.fanInThreshold ?? FAN_IN_THRESHOLD;
  const betweennessThreshold = options.betweennessThreshold ?? BETWEENNESS_THRESHOLD;
  const centrality = betweennessCentrality(graph);
  const profiles: FunctionProfile[] = graph.nodes.map((node) => {
    const fanIn = inDegree(graph, node);
    const betweenness = centrality.get(node) ?? 0;
    return {
      name: node,
      fanIn,
      fanOut: outDegree(graph, node),
      betweenness,
      isCritical: fanIn >= fanInThreshold || betweenness >= betweennessThreshold,
    };
  });

  profiles.sort((a, b) => a.betweenness - b.betweenness || a.fanIn - b.fanIn);
  profiles.reverse();
  return { ok: true, profiles: profiles.slice(0, options.topN ?? TOP_N), graph };
}
