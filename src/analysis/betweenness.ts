/**
 * Betweenness centrality for directed graphs — Brandes' algorithm, BFS form.
 *
 * WHY THIS FILE IS A PORT AND NOT AN IMPLEMENTATION. The Python sibling calls
 * `networkx.betweenness_centrality(graph, normalized=True)`. kragg-ts has a
 * zero-runtime-dependency policy, so there is no networkx here — but the two
 * tools must classify the same codebase identically, because criticality is a
 * THRESHOLD on this float:
 *
 *     isCritical = betweenness >= 0.1 || fanIn >= 3
 *
 * A different normalization convention, or endpoints counted differently, does
 * not produce "slightly different numbers": it silently moves functions across
 * that threshold and the two tools start disagreeing about what is critical.
 * So this is a deliberate, verified reimplementation of networkx's exact
 * conventions, not a fresh take on the literature.
 *
 * THE CONVENTIONS THIS FILE COMMITS TO, all verified against networkx 3.6.1
 * (`networkx/algorithms/centrality/betweenness.py`) rather than assumed:
 *
 *  - ENDPOINTS ARE EXCLUDED. `endpoints=False` is networkx's default, so for a
 *    pair (s, t) neither s nor t receives credit for the path between them.
 *  - THE NORMALIZATION FACTOR IS `1 / ((n - 1) * (n - 2))`. networkx computes
 *    `N = n - 1` (n, not n-1, when endpoints are counted) and scales by
 *    `1 / (N * (N - 1))`. For a DIRECTED graph that is the count of ordered
 *    (s, t) pairs with s != t and neither equal to v, which is what the raw
 *    accumulation below sums over. An undirected graph accumulates each
 *    unordered pair twice, so the same divisor is effectively
 *    `2 / ((n - 1) * (n - 2))` over unordered pairs — that asymmetry is why
 *    "directed" has to be stated up front. WE ARE DIRECTED.
 *  - n < 3 IS NOT A DIVISION BY ZERO. networkx skips rescaling entirely when
 *    `N < 2`. It can do that safely because with fewer than three nodes there
 *    is no node that is neither source nor target, so every raw score is
 *    already 0.0. We take the same branch, for the same reason.
 *  - ISOLATED AND UNREACHABLE NODES SCORE 0.0 AND ARE STILL PRESENT in the
 *    result, and still count toward `n`. Adding a disconnected component
 *    therefore LOWERS every other node's centrality — that is networkx's
 *    behaviour and it is load-bearing for parity, not an oversight.
 *  - SELF-LOOPS CONTRIBUTE NOTHING. networkx's BFS admits `w` as a shortest-
 *    path successor of `v` only when `D[w] == D[v] + 1`; for `w === v` that is
 *    `D[v] == D[v] + 1`, which is false. The node still counts toward `n`.
 *  - EVERY EDGE HAS WEIGHT 1 and there are no parallel edges (a `DiGraph`, not
 *    a `MultiDiGraph`), so BFS is exact and Dijkstra is not needed.
 *
 * WHAT IS *NOT* PROMISED: bit-for-bit equality of the raw floats. Both
 * implementations sum in source-iteration order, and the Python side iterates
 * a `set` of qualified names whose order varies with `PYTHONHASHSEED`. So the
 * two agree to within floating-point summation reordering (~1e-16 on real
 * graphs), which is far below the 4-decimal rounding that
 * `.kragg/criticality.json` actually publishes. Agreement is asserted at 4+
 * decimals in `test/betweenness.test.ts` against real networkx output.
 *
 * Reference: Ulrik Brandes, "A Faster Algorithm for Betweenness Centrality",
 * Journal of Mathematical Sociology 25(2):163-177, 2001.
 */

/**
 * A directed graph over string node ids, with no parallel edges and no edge
 * weights — the `networkx.DiGraph` subset the call-graph analysis needs.
 *
 * Following the repo convention, this is plain data and the behaviour lives in
 * the free functions below. `nodes` is INSERTION-ORDERED and that order is
 * part of the contract: it fixes the source-iteration order of the algorithm
 * (and hence the floating-point summation order), and it is what callers use
 * to break ties reproducibly.
 */
export interface DirectedGraph {
  /** Every node, in insertion order, without duplicates. */
  readonly nodes: string[];
  /** node -> its successors. Every node is a key, possibly with an empty set. */
  readonly successors: Map<string, Set<string>>;
  /** node -> its predecessors. Every node is a key, possibly with an empty set. */
  readonly predecessors: Map<string, Set<string>>;
}

/** Options for {@link betweennessCentrality}. */
export interface BetweennessOptions {
  /**
   * Divide by the number of ordered (s, t) pairs, as
   * `networkx.betweenness_centrality(..., normalized=True)` does. Defaults to
   * `true`, which is both networkx's default and the only mode the criticality
   * thresholds are calibrated for.
   *
   * `false` yields the raw path-fraction counts. For a DIRECTED graph that is
   * exactly the unscaled accumulation: networkx's unnormalized rescale factor
   * is `N / (N * 1)`, i.e. 1. (For an undirected graph it would be 1/2; we are
   * not undirected.) Raw counts are integers on graphs with unique shortest
   * paths, which is what makes the analytic tests readable.
   */
  readonly normalized?: boolean | undefined;
}

/** An empty, mutable directed graph. */
export function createDirectedGraph(): DirectedGraph {
  return { nodes: [], successors: new Map(), predecessors: new Map() };
}

/**
 * Add a node, if it is not already present.
 *
 * Isolated nodes matter: they raise `n` and therefore lower every other node's
 * normalized centrality. The Python sibling seeds the graph with every indexed
 * function before adding a single edge for exactly this reason, so a caller
 * that only ever calls {@link addEdge} is building a different graph.
 */
export function addNode(graph: DirectedGraph, node: string): void {
  if (graph.successors.has(node)) {
    return;
  }
  graph.nodes.push(node);
  graph.successors.set(node, new Set());
  graph.predecessors.set(node, new Set());
}

/**
 * Add a directed edge, creating either endpoint if it is new.
 *
 * Idempotent: this is a simple digraph, so a repeated edge is one edge. That
 * matches `networkx.DiGraph.add_edge` and it is why fan-in counts distinct
 * callers rather than call sites.
 */
export function addEdge(graph: DirectedGraph, source: string, target: string): void {
  addNode(graph, source);
  addNode(graph, target);
  neighbours(graph.successors, source).add(target);
  neighbours(graph.predecessors, target).add(source);
}

/** Whether the graph contains this node. */
export function hasNode(graph: DirectedGraph, node: string): boolean {
  return graph.successors.has(node);
}

/** Number of nodes — `n` in the normalization factor. */
export function nodeCount(graph: DirectedGraph): number {
  return graph.nodes.length;
}

/** Number of distinct edges. */
export function edgeCount(graph: DirectedGraph): number {
  let total = 0;
  for (const targets of graph.successors.values()) {
    total += targets.size;
  }
  return total;
}

/** Distinct callers of a node — `DiGraph.in_degree`. Unknown node -> 0. */
export function inDegree(graph: DirectedGraph, node: string): number {
  return graph.predecessors.get(node)?.size ?? 0;
}

/** Distinct callees of a node — `DiGraph.out_degree`. Unknown node -> 0. */
export function outDegree(graph: DirectedGraph, node: string): number {
  return graph.successors.get(node)?.size ?? 0;
}

/** A node's successors, in insertion order. Unknown node -> empty. */
export function successorsOf(graph: DirectedGraph, node: string): readonly string[] {
  const targets = graph.successors.get(node);
  return targets === undefined ? [] : [...targets];
}

/**
 * Build a graph from an edge list, plus any nodes that have no edges.
 *
 * A convenience for tests and for callers that already have an adjacency
 * structure. Node insertion order is: every `isolated` entry and every edge
 * endpoint, in the order given.
 */
export function directedGraphFrom(
  edges: Iterable<readonly [string, string]>,
  isolated: Iterable<string> = [],
): DirectedGraph {
  const graph = createDirectedGraph();
  for (const node of isolated) {
    addNode(graph, node);
  }
  for (const [source, target] of edges) {
    addEdge(graph, source, target);
  }
  return graph;
}

/**
 * Shortest-path betweenness centrality for every node, matching
 * `networkx.betweenness_centrality(graph, normalized=True)` on a `DiGraph`.
 *
 * Brandes' algorithm in two phases per source `s`:
 *
 *  1. a BFS that records, for every reachable `w`, its distance `D[w]`, the
 *     number of shortest s-w paths `sigma[w]`, and the predecessors of `w` on
 *     those paths `P[w]`;
 *  2. a reverse sweep over the BFS order that accumulates the dependency
 *     `delta[v] = sum over w of sigma[v]/sigma[w] * (1 + delta[w])`.
 *
 * The source itself is skipped during accumulation (`w !== source`), which is
 * what "endpoints excluded" means operationally.
 *
 * Runs in O(n * (n + m)). Every node of the graph appears in the result, in
 * `graph.nodes` order, so a caller can index it unconditionally.
 */
export function betweennessCentrality(
  graph: DirectedGraph,
  options: BetweennessOptions = {},
): Map<string, number> {
  const betweenness = new Map<string, number>();
  for (const node of graph.nodes) {
    betweenness.set(node, 0);
  }
  // Sources are visited in `graph.nodes` order, which fixes the
  // floating-point summation order — see the header note on parity.
  for (const source of graph.nodes) {
    accumulateDependency(betweenness, source, shortestPathTree(graph, source));
  }
  return rescale(betweenness, graph.nodes.length, options.normalized ?? true);
}

/**
 * Phase one's output for a single source: the shortest-path DAG.
 *
 * Held as three parallel structures rather than a node-keyed record because
 * that is the shape phase two consumes, and because a `Map` per node would
 * allocate once per node per source on a graph where n sources are swept.
 */
interface ShortestPathTree {
  /** Reachable nodes in BFS discovery order — phase two sweeps it backwards. */
  readonly order: readonly string[];
  /** node -> its predecessors on shortest paths from the source (Brandes' `P`). */
  readonly paths: ReadonlyMap<string, readonly string[]>;
  /** node -> how many shortest paths reach it from the source (`sigma`). */
  readonly sigma: ReadonlyMap<string, number>;
}

/** BFS bookkeeping, threaded through `expandFrontier` as one value. */
interface BfsState {
  readonly order: string[];
  readonly paths: Map<string, string[]>;
  readonly sigma: Map<string, number>;
  readonly distance: Map<string, number>;
  readonly queue: string[];
}

/**
 * Brandes' phase one: one BFS from `source`, counting shortest paths.
 *
 * Every edge has weight 1, so BFS layers ARE shortest-path distances and no
 * priority queue is needed. Nodes unreachable from `source` never enter
 * `order` and therefore contribute nothing — which is how an unreachable node
 * ends up scoring 0.0 while still counting toward `n`.
 */
function shortestPathTree(graph: DirectedGraph, source: string): ShortestPathTree {
  const state: BfsState = {
    order: [],
    paths: new Map(),
    sigma: new Map([[source, 1]]),
    distance: new Map([[source, 0]]),
    // A read cursor rather than `shift()`: draining an array from the front is
    // O(n) per pop in V8, which turns the BFS quadratic on a wide graph.
    queue: [source],
  };
  for (let head = 0; head < state.queue.length; head += 1) {
    const node = state.queue[head];
    if (node === undefined) {
      break;
    }
    state.order.push(node);
    expandFrontier(graph, state, node);
  }
  return { order: state.order, paths: state.paths, sigma: state.sigma };
}

/**
 * Visit `v`'s successors: discover new nodes, and record the ones that lie on
 * a shortest path.
 *
 * Only edges that advance the BFS frontier by exactly one lie on a shortest
 * path. A self-loop fails that test (`d === d + 1`), which is precisely how
 * networkx ends up ignoring them.
 */
function expandFrontier(graph: DirectedGraph, state: BfsState, v: string): void {
  const distanceV = count(state.distance, v);
  const sigmaV = count(state.sigma, v);
  for (const w of graph.successors.get(v) ?? EMPTY) {
    let distanceW = state.distance.get(w);
    if (distanceW === undefined) {
      distanceW = distanceV + 1;
      state.distance.set(w, distanceW);
      state.queue.push(w);
    }
    if (distanceW !== distanceV + 1) {
      continue;
    }
    state.sigma.set(w, count(state.sigma, w) + sigmaV);
    const predecessors = state.paths.get(w);
    if (predecessors === undefined) {
      state.paths.set(w, [v]);
    } else {
      predecessors.push(v);
    }
  }
}

/**
 * Brandes' phase two: sweep the BFS order backwards, accumulating
 * `delta[v] = sum over w of sigma[v]/sigma[w] * (1 + delta[w])` into
 * `betweenness`.
 *
 * The source itself is skipped (`w !== source`), which is what "endpoints
 * excluded" means operationally.
 */
function accumulateDependency(
  betweenness: Map<string, number>,
  source: string,
  tree: ShortestPathTree,
): void {
  const delta = new Map<string, number>();
  for (let index = tree.order.length - 1; index >= 0; index -= 1) {
    const w = tree.order[index];
    if (w === undefined) {
      continue;
    }
    const coefficient = (1 + count(delta, w)) / pathCount(tree.sigma, w);
    for (const v of tree.paths.get(w) ?? EMPTY_LIST) {
      delta.set(v, count(delta, v) + count(tree.sigma, v) * coefficient);
    }
    if (w !== source) {
      betweenness.set(w, count(betweenness, w) + count(delta, w));
    }
  }
}

/** A node's tally so far; absent means it has not been touched yet, i.e. 0. */
function count(tallies: ReadonlyMap<string, number>, node: string): number {
  return tallies.get(node) ?? 0;
}

/**
 * `sigma[w]`, defaulting to 1 rather than 0: every node in `order` was reached
 * by the BFS, so its path count is >= 1 and the default is unreachable. It
 * exists only so the division below can never produce `Infinity`.
 */
function pathCount(sigma: ReadonlyMap<string, number>, node: string): number {
  return sigma.get(node) ?? 1;
}

/**
 * networkx's `_rescale` for the directed, endpoints-excluded case.
 *
 * `N = n - 1` is the number of nodes that can serve as the source of a path
 * through `v`; `N - 1 = n - 2` is then the number of remaining targets. When
 * `N < 2` networkx returns the accumulation untouched — and that is safe
 * rather than lucky, because a graph with fewer than three nodes has no node
 * that is neither source nor target, so every raw score is already zero.
 *
 * Unnormalized is a no-op here: networkx's unnormalized factor is
 * `N / (N * correction)` with `correction === 1` for directed graphs.
 */
function rescale(
  betweenness: Map<string, number>,
  n: number,
  normalized: boolean,
): Map<string, number> {
  if (!normalized || n < 3) {
    return betweenness;
  }
  const scale = 1 / ((n - 1) * (n - 2));
  for (const [node, value] of betweenness) {
    betweenness.set(node, value * scale);
  }
  return betweenness;
}

function neighbours(map: Map<string, Set<string>>, node: string): Set<string> {
  const existing = map.get(node);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Set<string>();
  map.set(node, created);
  return created;
}

const EMPTY: ReadonlySet<string> = new Set();
const EMPTY_LIST: readonly string[] = [];
