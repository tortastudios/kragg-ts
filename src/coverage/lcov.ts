/**
 * Normalize an lcov tracefile into the shared line model — the reason
 * `critical-coverage` and `kragg coverage` work under `node --test` and
 * `bun test` and not only under vitest.
 *
 * ── THE BLIND SPOT THIS CLOSES ─────────────────────────────────────────────
 * `critical-coverage` needed a parsed istanbul `coverage-final.json`. Two of
 * the three runners kragg drives cannot produce one — node's built-in reporters
 * are `spec`/`dot`/`tap`/`junit`/`lcov`, and bun's coverage reporters are
 * `text` and `lcov`, full stop. `adapters/support/lcov.ts` has always read
 * those tracefiles for the coverage PERCENTAGE, and that data simply never
 * reached the gate. So on a `node --test` project the strictest gate in the
 * suite skipped, every run, and the report said `SKIP` where the user reads
 * `fine`.
 *
 * ── IT IS A MAPPING, NOT AN INFERENCE ──────────────────────────────────────
 * Nothing here is derived, estimated or filled in. lcov states line coverage
 * directly:
 *
 *     DA:<line>,<hits>     this line is executable, and it ran <hits> times
 *     FN:<line>,<name>     a function called <name> starts at <line>
 *     FN:<start>,<end>,<name>   the lcov 2.x form, which also states the end
 *     FNDA:<hits>,<name>   <name> was entered <hits> times
 *
 * `DA:` maps onto uncovered lines one-for-one. `FN:`/`FNDA:` map onto a
 * `FunctionSpan`. Where the tracefile gives no end line — which is the common
 * case, since node, bun and istanbul's own lcov writer all emit the two-field
 * `FN:` — `endLine` is `null` and stays `null`. Deriving it from the next
 * `FN:` record would be a guess that is simply wrong for a nested function,
 * and a wrong span attributes one function's uncovered lines to another.
 * `coverage/spans.ts` gets the extent from the source instead, which is a fact
 * rather than an inference.
 *
 * `BRDA:`/`BRF:`/`BRH:` — branch data — are IGNORED, deliberately and
 * completely. They have no place in a line model; see `coverage/model.ts`.
 * `LF:`/`LH:`/`FNF:`/`FNH:` are the writer's own summaries and are ignored for
 * the reason `adapters/support/lcov.ts` gives: they disagree with the records
 * they summarize in a merged tracefile, and counting the records is what every
 * other consumer does.
 *
 * ── MERGED RECORDS ─────────────────────────────────────────────────────────
 * Both node and bun emit one record per source file PER TEST FILE, so a
 * tracefile routinely holds the same `SF:` several times. `parseLcov` already
 * sums `DA:` counts across them — the line ran in one test or another, so it
 * is covered — and this module sums `FNDA:` the same way. A function entered
 * by any test is entered.
 */

import { relativeKey } from "./model.ts";
import type {
  FileCoverage,
  FunctionSpan,
  LineCoverageReport,
  NormalizedCoverage,
} from "./model.ts";

/**
 * Convert a parsed lcov tracefile into the line model.
 *
 * `report` is the parsed shape `parseLcov` produces, not a path or a blob of
 * text: exactly as `normalizeIstanbul` takes a parsed document, so the gate is
 * testable with a literal and there is only ever one lcov PARSER in the tree.
 *
 * Two records that normalize to the same repo-relative path are MERGED rather
 * than clobbering each other — the same rule `normalizeIstanbul` follows, for
 * the same reason: dropping one would silently discard real coverage data.
 */
export function normalizeLcov(report: LineCoverageReport, root: string): NormalizedCoverage {
  const merged = new Map<string, Accumulator>();
  for (const file of report.files) {
    const path = relativeKey(file.path, root);
    const into = merged.get(path) ?? { counts: new Map(), functions: new Map() };
    for (const [line, hits] of file.lineHits) {
      into.counts.set(line, (into.counts.get(line) ?? 0) + hits);
    }
    for (const record of file.functions) {
      addFunction(into, record.name, record.startLine, record.endLine, record.hits);
    }
    merged.set(path, into);
  }
  return { files: finalize(merged) };
}

/** One file's records while they are still being merged. */
interface Accumulator {
  /** 1-based line -> summed hit count across every record for this file. */
  readonly counts: Map<number, number>;
  /** `<name>@<startLine>` -> the span being accumulated, insertion-ordered. */
  readonly functions: Map<string, Mutable>;
}

interface Mutable {
  readonly name: string;
  readonly startLine: number;
  endLine: number | null;
  hits: number;
}

/**
 * Fold one `FN:`/`FNDA:` pair in.
 *
 * Keyed by name AND start line, so a tracefile that mentions two different
 * functions with the same simple name keeps both — which is what makes the
 * consumer able to notice the ambiguity and decline to guess, instead of
 * silently attributing one function's coverage to the other.
 */
function addFunction(
  into: Accumulator,
  name: string,
  startLine: number,
  endLine: number | null,
  hits: number,
): void {
  const key = `${name}@${startLine}`;
  const existing = into.functions.get(key);
  if (existing === undefined) {
    into.functions.set(key, { name, startLine, endLine, hits });
    return;
  }
  existing.hits += hits;
  if (existing.endLine === null) {
    existing.endLine = endLine;
  }
}

function finalize(merged: ReadonlyMap<string, Accumulator>): Map<string, FileCoverage> {
  const files = new Map<string, FileCoverage>();
  for (const [path, accumulator] of merged) {
    const uncovered = [...accumulator.counts]
      .filter(([, count]) => count === 0)
      .map(([line]) => line)
      .sort((left, right) => left - right);
    const functions: FunctionSpan[] = [...accumulator.functions.values()].map((span) => ({
      name: span.name,
      startLine: span.startLine,
      endLine: span.endLine,
      hits: span.hits,
    }));
    files.set(path, { path, uncoveredLines: uncovered, functions });
  }
  return files;
}
