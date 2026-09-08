/**
 * What a calibration run records, and the two summaries it records it with.
 *
 * SHAPES ONLY — no measurement, no rendering. Kept separate so the JSON this
 * script emits has one authoritative definition that both the measurer and the
 * markdown renderer are checked against.
 *
 * ── WHY A DISTRIBUTION AND NOT JUST A COUNT ────────────────────────────────
 * "12 violations" answers nothing on its own. A threshold is well-placed when
 * the things above it are far above it and the things below it are far below;
 * it is badly placed when the population piles up on the line. So every gate
 * records the whole population it measured (`values`) alongside the findings,
 * and every finding records how far past the line it landed (`ratio`). A
 * reader can then see whether a proposed threshold move would reclassify two
 * blocks or two hundred, which is the only honest basis for moving one.
 *
 * ── NO SOURCE EVER LEAVES THE SAMPLE ───────────────────────────────────────
 * A `Finding` carries a path, a symbol name and numbers. It deliberately has
 * no field for the offending expression, the message text or a code excerpt:
 * these samples are other people's repositories, this output is committed, and
 * a metric is reproducible from the path and the symbol anyway.
 */

/** Nearest-rank order statistics over one population. */
export interface Summary {
  readonly count: number;
  readonly min: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly max: number;
}

/** One violation, reduced to what may be published about it. */
export interface Finding {
  /** Path relative to the sample root. */
  readonly file: string;
  /** Qualified block name, or `""` for a file-level finding. */
  readonly symbol: string;
  /** 1-based line, when the finding has one. A file-level finding does not. */
  readonly line?: number | undefined;
  /** Which number was over budget: `cyclomatic`, `effort`, `length`, ... */
  readonly metric: string;
  readonly value: number;
  readonly threshold: number;
  /**
   * How far past the line, as a multiple. `2.0` is twice the budget; `1.02` is
   * a finding that would vanish under a 2% threshold change. Maintainability
   * inverts (lower is worse), so its ratio is `threshold / value`.
   */
  readonly ratio: number;
}

/** One gate's result on one sample. */
export interface GateMeasurement {
  readonly gate: string;
  /** What was counted: `block`, `file`, `annotation`, `site`. */
  readonly unit: string;
  /** Size of the population the gate judged. */
  readonly measured: number;
  readonly violations: number;
  /** `violations / measured`, or 0 when nothing was measured. */
  readonly rate: number;
  /** Named buckets over the whole population — grades, or value ranges. */
  readonly buckets: Readonly<Record<string, number>>;
  /** Order statistics over the whole population, when it is numeric. */
  readonly summary: Summary | null;
  /** Every finding, capped; `findingsTruncated` says how many were dropped. */
  readonly findings: readonly Finding[];
  readonly findingsTruncated: number;
  /**
   * Set when the gate could not run at all. A measurement with a `blocked`
   * reason is NOT a zero-violation measurement, and the renderer must never
   * present it as one.
   */
  readonly blocked?: string | undefined;
}

/** One sample, measured by every metric gate. */
export interface SampleMeasurement {
  readonly label: string;
  readonly root: string;
  /** `git rev-parse --short HEAD`, or `null` when the sample is not a repo. */
  readonly commit: string | null;
  readonly sourcePaths: readonly string[];
  readonly sourcePathsFrom: string;
  /** Files `parsedSources` actually parsed. */
  readonly files: number;
  /** Total physical lines across those files. */
  readonly lines: number;
  /** Which TypeScript built the numbers, and whether it was the sample's own. */
  readonly compiler: string;
  /** `// kragg: ignore` markers found in the walked files. */
  readonly suppressions: number;
  readonly gates: readonly GateMeasurement[];
}

/** A whole run: the samples, and the thresholds they were judged against. */
export interface CalibrationRun {
  /** ISO date, so a committed table says when it was true. */
  readonly date: string;
  /** Short commit of the kragg checkout that produced the numbers. */
  readonly kraggCommit: string;
  readonly thresholds: Readonly<Record<string, string>>;
  readonly samples: readonly SampleMeasurement[];
}

/** Nearest-rank percentiles. An empty population has no summary. */
export function summarize(values: readonly number[]): Summary | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    min: at(sorted, 0),
    p50: at(sorted, rank(sorted.length, 50)),
    p90: at(sorted, rank(sorted.length, 90)),
    p99: at(sorted, rank(sorted.length, 99)),
    max: at(sorted, sorted.length - 1),
  };
}

/** Nearest-rank index: `ceil(p/100 * n) - 1`, clamped into the array. */
function rank(length: number, percentile: number): number {
  return Math.min(Math.max(Math.ceil((percentile / 100) * length) - 1, 0), length - 1);
}

function at(sorted: readonly number[], index: number): number {
  return sorted[index] ?? 0;
}

/**
 * Count values into ordered buckets by an upper-bound ladder.
 *
 * Buckets are half-open and named for exactly what they hold: the first is
 * `<=e0`, the rest are `(e(n-1), e(n)]`, and everything past the last edge
 * lands in `>elast`. Spelling the interval out is worth the extra characters —
 * a table that says `0-1` leaves the reader guessing which end is closed, and
 * for an integer metric like nesting depth that guess changes the conclusion.
 */
export function bucketize(
  values: readonly number[],
  edges: readonly number[],
): Readonly<Record<string, number>> {
  const labels = edges.map((edge, index) =>
    index === 0 ? `<=${edge}` : `(${edges[index - 1] ?? 0}, ${edge}]`,
  );
  const overflow = `>${edges[edges.length - 1] ?? 0}`;
  const counts: Record<string, number> = {};
  for (const label of [...labels, overflow]) {
    counts[label] = 0;
  }
  for (const value of values) {
    const index = edges.findIndex((bound) => value <= bound);
    const key = index === -1 ? overflow : (labels[index] ?? overflow);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Cap a finding list, keeping the worst offenders and counting the rest. */
export function capFindings(
  findings: readonly Finding[],
  limit: number,
): { kept: readonly Finding[]; truncated: number } {
  const ordered = [...findings].sort((left, right) => right.ratio - left.ratio);
  return {
    kept: ordered.slice(0, limit),
    truncated: Math.max(ordered.length - limit, 0),
  };
}

/** At most this many findings per gate reach the report; the rest are counted. */
const FINDING_CAP = 60;

/**
 * Assemble one measurement.
 *
 * `measured` defaults to the population size, which is right whenever the
 * population IS the thing judged (one value per block, per file). The gates
 * whose population and denominator differ pass both explicitly.
 */
export function gate(
  name: string,
  unit: string,
  values: readonly number[],
  buckets: Readonly<Record<string, number>>,
  findings: readonly Finding[],
  measured?: number,
  violations?: number,
): GateMeasurement {
  const total = measured ?? values.length;
  const failed = violations ?? findings.length;
  const capped = capFindings(findings, FINDING_CAP);
  return {
    gate: name,
    unit,
    measured: total,
    violations: failed,
    rate: total === 0 ? 0 : failed / total,
    buckets,
    summary: summarize(values),
    findings: capped.kept,
    findingsTruncated: capped.truncated,
  };
}

/** Round to `digits` decimals, so the JSON record is not full of float noise. */
export function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
