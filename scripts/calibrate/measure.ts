/**
 * Measure one sample with every metric gate, at the gate's own thresholds.
 *
 * ── WHAT THIS IS FOR ───────────────────────────────────────────────────────
 * The complexity, maintainability, Halstead and type-complexity thresholds in
 * this repository are radon's and Python kragg's, ported onto a language they
 * were never drawn against. Each gate's own doc comment records what it
 * measured on kragg-ts itself; that is one CLI-shaped repository written to
 * pass its own gates, which is the least informative sample available. This
 * module is how the same numbers get taken on somebody else's code.
 *
 * ── THE GATES ARE CALLED, NOT REIMPLEMENTED ────────────────────────────────
 * Every number here comes from the same function `catalog/check.ts` calls in a
 * real run — `fileComplexity`, `fileMaintainability`, `fileHalstead`,
 * `checkTypeComplexity`, `checkNullableDefaults` — over the same
 * `parsedSources` walk. A calibration harness that reimplemented the metric
 * would calibrate the harness. The one thing added is the DENOMINATOR: the
 * gates report only what failed, and a failure count without the population it
 * came from cannot tell a well-placed threshold from a lucky one.
 *
 * ── WHAT IS HERE AND WHAT IS NEXT DOOR ─────────────────────────────────────
 * This module holds `measureSample` and the three gates that are a straight
 * walk over the syntax tier: cyclomatic complexity, the maintainability index
 * and the three Halstead ceilings. `type-complexity` and `nullable-default`
 * each need something the walk cannot give them and live in
 * `measureTypes.ts`, which explains what.
 *
 * ── NOTHING FROM A SAMPLE IS COPIED OUT ────────────────────────────────────
 * Findings carry a path, a symbol name, a line and numbers — never an
 * expression, a message or a code excerpt. The samples are other people's
 * repositories and this output is committed.
 */

import {
  resolveTypeScript,
  parsedSources,
  type ParsedSource,
  type TypeScriptApi,
} from "../../src/analysis/sourceFile.ts";
import {
  ccExceeds,
  ccRank,
  CC_MAX_GRADE,
  fileComplexity,
  fileMaintainability,
  miExceeds,
  miRank,
  MI_MIN_GRADE,
} from "../../src/gates/complexity.ts";
import { fileHalstead, MAX_BUGS, MAX_DIFFICULTY, MAX_EFFORT } from "../../src/gates/halstead.ts";
import { lineSuppressed } from "../../src/util/suppress.ts";
import {
  bucketize,
  gate,
  round,
  type Finding,
  type GateMeasurement,
  type SampleMeasurement,
} from "./model.ts";
import { measureNullableDefault, measureTypeComplexity } from "./measureTypes.ts";
import type { SampleSpec } from "./spec.ts";

/** Measure every metric gate on one sample. */
export function measureSample(spec: SampleSpec, commit: string | null): SampleMeasurement {
  const resolution = resolveTypeScript(spec.root);
  const api = resolution.api;
  const sources = [...parsedSources(spec.root, spec.sourcePaths, { api })];

  return {
    label: spec.label,
    root: spec.root,
    commit,
    sourcePaths: [...spec.sourcePaths],
    sourcePathsFrom: spec.sourcePathsFrom,
    files: sources.length,
    lines: sources.reduce((total, source) => total + source.lines.length, 0),
    compiler: `typescript ${resolution.version} (${resolution.source})`,
    suppressions: countSuppressions(sources),
    gates: [
      measureComplexity(sources, api),
      measureMaintainability(sources, api),
      ...measureHalstead(sources, api),
      ...measureTypeComplexity(spec, api),
      measureNullableDefault(spec, sources, api),
    ],
  };
}

function countSuppressions(sources: readonly ParsedSource[]): number {
  let found = 0;
  for (const source of sources) {
    for (const line of source.lines) {
      if (lineSuppressed(line)) {
        found += 1;
      }
    }
  }
  return found;
}

// ── complexity ─────────────────────────────────────────────────────────────

/**
 * The worst cyclomatic score that still passes, derived from the bands rather
 * than written down: if `CC_MAX_GRADE` ever moves, this moves with it.
 */
function ccCeiling(): number {
  for (let score = 1; score <= 1000; score += 1) {
    if (ccExceeds(ccRank(score + 1), CC_MAX_GRADE)) {
      return score;
    }
  }
  return 1000;
}

function measureComplexity(
  sources: readonly ParsedSource[],
  api: TypeScriptApi,
): GateMeasurement {
  const ceiling = ccCeiling();
  const values: number[] = [];
  const grades: Record<string, number> = {};
  const findings: Finding[] = [];
  for (const source of sources) {
    for (const block of fileComplexity(source.sourceFile, api).blocks) {
      values.push(block.complexity);
      grades[block.grade] = (grades[block.grade] ?? 0) + 1;
      if (ccExceeds(block.grade, CC_MAX_GRADE)) {
        findings.push({
          file: source.relative,
          symbol: block.name,
          line: block.line,
          metric: `cyclomatic (grade ${block.grade})`,
          value: block.complexity,
          threshold: ceiling,
          ratio: block.complexity / ceiling,
        });
      }
    }
  }
  return gate("complexity", "block", values, grades, findings);
}

// ── maintainability ────────────────────────────────────────────────────────

/** The lowest maintainability index that still passes, to two decimals. */
function miFloor(): number {
  for (let step = 0; step <= 10_000; step += 1) {
    const score = step / 100;
    if (!miExceeds(miRank(score), MI_MIN_GRADE)) {
      return score;
    }
  }
  return 100;
}

function measureMaintainability(
  sources: readonly ParsedSource[],
  api: TypeScriptApi,
): GateMeasurement {
  const floor = miFloor();
  const values: number[] = [];
  const grades: Record<string, number> = {};
  const findings: Finding[] = [];
  for (const source of sources) {
    const report = fileMaintainability(source.sourceFile, api);
    values.push(round(report.mi, 1));
    grades[report.grade] = (grades[report.grade] ?? 0) + 1;
    if (miExceeds(report.grade, MI_MIN_GRADE)) {
      findings.push({
        file: source.relative,
        symbol: "",
        metric: `maintainability (grade ${report.grade})`,
        value: round(report.mi, 1),
        threshold: floor,
        // Lower is worse here, so the ratio inverts to stay "1.0 is on the
        // line, 2.0 is twice as bad". The floor on the divisor is not
        // cosmetic: MI is clamped at 0, real files reach it, and `Infinity`
        // serializes to `null` — which would put a hole in the JSON record
        // exactly where the worst file in the sample should be.
        ratio: floor / Math.max(report.mi, 0.1),
      });
    }
  }
  return gate("maintainability", "file", values, grades, findings);
}

// ── halstead ───────────────────────────────────────────────────────────────

/** The three Halstead ceilings, each measured as its own population. */
const HALSTEAD_METRICS = [
  { name: "halstead:effort", max: MAX_EFFORT, edges: [1_000, 5_000, 25_000, 50_000] },
  { name: "halstead:difficulty", max: MAX_DIFFICULTY, edges: [5, 10, 20, 30] },
  { name: "halstead:bugs", max: MAX_BUGS, edges: [0.05, 0.1, 0.2, 0.4] },
] as const;

function measureHalstead(
  sources: readonly ParsedSource[],
  api: TypeScriptApi,
): readonly GateMeasurement[] {
  const populations: number[][] = [[], [], []];
  const findings: Finding[][] = [[], [], []];
  for (const source of sources) {
    for (const block of fileHalstead(source.sourceFile, api).functions) {
      const measured = [block.metrics.effort, block.metrics.difficulty, block.metrics.bugs];
      for (const [index, metric] of HALSTEAD_METRICS.entries()) {
        const value = round(measured[index] ?? 0, 2);
        populations[index]?.push(value);
        if (value > metric.max) {
          findings[index]?.push({
            file: source.relative,
            symbol: block.name,
            line: block.line,
            metric: metric.name.slice("halstead:".length),
            value,
            threshold: metric.max,
            ratio: value / metric.max,
          });
        }
      }
    }
  }
  return HALSTEAD_METRICS.map((metric, index) =>
    gate(
      metric.name,
      "block",
      populations[index] ?? [],
      bucketize(populations[index] ?? [], metric.edges),
      findings[index] ?? [],
    ),
  );
}
