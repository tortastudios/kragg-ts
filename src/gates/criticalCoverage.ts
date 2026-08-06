/**
 * Gate: public critical functions must have no uncovered lines.
 *
 * The port of `kragg/src/kragg/gates/critical_coverage.py`, and its reasoning
 * is the reason the whole test-depth family exists: a coverage PERCENTAGE is
 * gameable and kragg refuses to gate on one, so instead it applies the
 * strictest possible bar — not a single uncovered line — to the smallest set
 * where it is worth paying for: the highest-fan-in functions.
 *
 * ── THE PART THAT IS NOT A PORT ────────────────────────────────────────────
 * Python reads coverage.py's JSON, which hands it `missing_lines` per function.
 * There is no such report in the JavaScript ecosystem, and no agreement about
 * formats either: vitest writes istanbul's `coverage-final.json`, while `node
 * --test` and `bun test` can only write lcov. `coverage/istanbul.ts` and
 * `coverage/lcov.ts` normalize both into the one model in `coverage/model.ts`,
 * so this gate runs under EVERY supported runner. It used to skip under two of
 * the three, which meant the report said `SKIP` on a `node --test` project
 * every single run.
 *
 * THE REPORT ARRIVES PARSED. This gate never runs a coverage tool and never
 * reads a well-known path; the caller passes the parsed document, or the lcov
 * text. That keeps the gate testable with a literal, and leaves the question
 * of HOW coverage gets produced (`vitest --coverage`, `c8`, a CI artifact) to
 * the adapter phase that owns it.
 *
 * ── WHERE THE FUNCTION'S EXTENT COMES FROM ─────────────────────────────────
 * istanbul states where a function ends; lcov does not. So for an lcov span
 * the extent is read off the SOURCE (`coverage/spans.ts`) rather than guessed
 * at from the next `FN:` record — see that module for why the guess is wrong
 * rather than merely imprecise. When neither the report nor the source can
 * bound the function, the gate falls back to the one thing lcov does state
 * unambiguously: whether it was ever entered.
 *
 * ── MATCHING A FUNCTION TO ITS COVERAGE ────────────────────────────────────
 * `criticality.json` names a function `src/a#Client.send`; istanbul's `fnMap`
 * records it as `send`, with no class and no module qualification. So matching
 * is by SIMPLE NAME within the already-resolved file, and it has one failure
 * mode: two functions in one file sharing a simple name — `Reader.close` and
 * `Writer.close` — are indistinguishable in the report.
 *
 * An ambiguous name is treated as UNMEASURED and produces no violation. The
 * alternative, unioning the candidates' spans, would blame `Reader.close` for
 * `Writer.close`'s uncovered lines and send a reviewer to the wrong function.
 * Understating is the safe failure — the same trade `criticality.ts` makes when
 * a call will not resolve — but it IS a recall gap, and a file with same-named
 * methods on two classes is where this gate quietly checks less than it looks.
 *
 * Python's `measured` flag is preserved for the same purpose: a critical
 * function absent from the report is not a violation, because the likely cause
 * is a measurement-key mismatch rather than an untested function. That is
 * exactly what `critical_coverage.py`'s docstring says, and it is why a repo
 * with a misconfigured coverage tool gets silence here rather than a wall of
 * false failures — and why `kragg coverage` is meant to surface the unmeasured
 * ones separately.
 */

import { join } from "node:path";

import { resolveTypeScript, type TypeScriptApi } from "../analysis/sourceFile.ts";
import { normalizeIstanbul } from "../coverage/istanbul.ts";
import { normalizeLcov } from "../coverage/lcov.ts";
import {
  functionsNamed,
  uncoveredWithin,
  type FileCoverage,
  type NormalizedCoverage,
} from "../coverage/model.ts";
import {
  functionSpans,
  uniqueSpan,
  type SourceSpan,
  type SpanIndex,
} from "../coverage/spans.ts";
import { parseLcov } from "../adapters/support/lcov.ts";
import type { Violation } from "../engine/models.ts";
import {
  criticalFunctions,
  hasCriticalityData,
  simpleName,
  type CriticalFunction,
} from "./testDepth/criticalFunctions.ts";
import {
  NO_CRITICALITY_REASON,
  ran,
  skipped,
  type TestDepthOutcome,
} from "./testDepth/outcome.ts";

/** `Violation.code` for every finding this gate produces. */
export const CRITICAL_COVERAGE_CODE = "critical-coverage";

/** Skip reason when no coverage report of either format was supplied. */
export const NO_COVERAGE_REASON =
  "no coverage report (run the test suite with coverage — `vitest run --coverage` " +
  "writes coverage-final.json; `node --test` and `bun test` write lcov.info)";

/** How many uncovered lines the fix hint previews, as in Python. */
const PREVIEW_LIMIT = 6;

export interface CriticalCoverageOptions {
  readonly root: string;
  /** Policy `sourcePaths`. */
  readonly sourcePaths: readonly string[];
  /**
   * A PARSED istanbul `coverage-final.json`. `null` — or anything that is not
   * an object — means vitest wrote nothing, and {@link lcov} is tried instead.
   */
  readonly report: unknown;
  /**
   * The TEXT of an lcov tracefile, which is all `node --test` and `bun test`
   * can produce.
   *
   * ISTANBUL WINS when both are present, and that is not arbitrary: istanbul
   * states each function's full body span while lcov states only where it
   * starts, so the richer document produces the better attribution. A project
   * that has both has run vitest, and the lcov beside it is the older artifact
   * more often than not.
   */
  readonly lcov?: string | undefined;
  /** Compiler used to map modules to files. Defaults to the project's own. */
  readonly api?: TypeScriptApi | undefined;
}

/** Coverage outcome for one public critical function. */
export interface CriticalCoverageGap {
  readonly qualname: string;
  readonly file: string;
  readonly fanIn: number;
  /** 1-based uncovered lines inside the function, ascending. */
  readonly missingLines: readonly number[];
  /** False when the report has no unambiguous entry for this function. */
  readonly measured: boolean;
}

/** Return violations for critical functions with uncovered lines. */
export function checkCriticalCoverage(
  options: CriticalCoverageOptions,
): TestDepthOutcome {
  if (!hasCriticalityData(options.root)) {
    return skipped(NO_CRITICALITY_REASON);
  }
  if (normalize(options) === null) {
    return skipped(NO_COVERAGE_REASON);
  }
  const violations: Violation[] = [];
  for (const gap of criticalCoverageGaps(options)) {
    if (gap.measured && gap.missingLines.length > 0) {
      violations.push(toViolation(gap));
    }
  }
  return ran(violations);
}

/**
 * Uncovered lines per public critical function, ranked by fan-in.
 *
 * Includes the unmeasured ones, which the gate ignores and the planned
 * `kragg coverage` command reports separately — the same split Python makes
 * between `critical_gaps` and `check_critical_coverage`.
 */
export function criticalCoverageGaps(
  options: CriticalCoverageOptions,
): readonly CriticalCoverageGap[] {
  const coverage = normalize(options);
  if (coverage === null) {
    return [];
  }
  const api = options.api ?? resolveTypeScript(options.root).api;
  const extents = new SourceExtents(options.root, api);
  const rows = criticalFunctions(options.root, options.sourcePaths, { api }).map((critical) =>
    measure(critical, coverage.files.get(critical.file), extents),
  );
  return [...rows].sort((left, right) => right.fanIn - left.fanIn);
}

/**
 * Whichever coverage document was supplied, in the one model, or `null`.
 *
 * `null` is "nothing was measured" and must never be confused with "nothing is
 * uncovered": every caller turns it into a visible skip.
 */
function normalize(options: CriticalCoverageOptions): NormalizedCoverage | null {
  if (typeof options.report === "object" && options.report !== null) {
    return normalizeIstanbul(options.report, options.root);
  }
  if (options.lcov !== undefined && options.lcov !== "") {
    return normalizeLcov(parseLcov(options.lcov, "lcov.info"), options.root);
  }
  return null;
}

/** Per-file source spans, parsed once per run and only for files we need. */
class SourceExtents {
  readonly #root: string;
  readonly #api: TypeScriptApi;
  readonly #cache = new Map<string, SpanIndex>();

  constructor(root: string, api: TypeScriptApi) {
    this.#root = root;
    this.#api = api;
  }

  /** The one span `name` identifies in `file`, or `null` if it is ambiguous. */
  spanOf(file: string, name: string): SourceSpan | null {
    const cached =
      this.#cache.get(file) ??
      functionSpans(join(this.#root, file), this.#root, this.#api);
    this.#cache.set(file, cached);
    return uniqueSpan(cached, name);
  }
}

/**
 * Resolve one critical function against the report.
 *
 * THREE WAYS THIS DECLINES TO GUESS, and each is a recall gap paid on purpose:
 * a file with no entry, a name the report records twice, and a function whose
 * extent neither the report nor the source can pin down are all UNMEASURED —
 * never a violation. Python's gate makes the same call, and its reasoning
 * holds here too: the likeliest cause is a measurement-key mismatch, and a
 * wall of false failures from a misconfigured coverage tool is how a gate gets
 * switched off.
 *
 * A function that WAS matched but never entered (`hits === 0`) and whose span
 * holds no uncovered statement line — a one-expression arrow, whose body a
 * report records as a function and not as a statement — is reported as missing
 * its declaration line. Without that, a critical function no test ever calls
 * could pass a gate whose entire purpose is to notice exactly that.
 */
function measure(
  critical: CriticalFunction,
  file: FileCoverage | undefined,
  extents: SourceExtents,
): CriticalCoverageGap {
  const base = { qualname: critical.qualname, file: critical.file, fanIn: critical.fanIn };
  if (file === undefined) {
    return { ...base, missingLines: [], measured: false };
  }
  const spans = functionsNamed(file, critical.name);
  const span = spans.length === 1 ? spans[0] : undefined;
  if (span === undefined) {
    return { ...base, missingLines: [], measured: false };
  }
  // lcov states no end line, so the extent comes from the source. `startLine`
  // comes with it: where the report and the source disagree by a line (a
  // decorated or overloaded declaration), the source is the one that matches
  // the file a reviewer will open.
  const extent =
    span.endLine !== null
      ? { startLine: span.startLine, endLine: span.endLine }
      : extents.spanOf(critical.file, critical.name);
  if (extent === null) {
    // Entered at least once, and nothing can bound its body: reporting zero
    // uncovered lines here would claim a check that was never made. Only the
    // never-entered case is stated, because only it is stated by the report.
    return span.hits === 0
      ? { ...base, missingLines: [span.startLine], measured: true }
      : { ...base, missingLines: [], measured: false };
  }
  const missing = uncoveredWithin(file, extent.startLine, extent.endLine);
  if (missing.length === 0 && span.hits === 0) {
    return { ...base, missingLines: [extent.startLine], measured: true };
  }
  return { ...base, missingLines: missing, measured: true };
}

/** Message, hint and location copied from Python's `_violation`. */
function toViolation(gap: CriticalCoverageGap): Violation {
  const simple = simpleName(gap.qualname);
  const preview = gap.missingLines.slice(0, PREVIEW_LIMIT).join(", ");
  return {
    message:
      `critical function ${gap.qualname} has ` +
      `${gap.missingLines.length} uncovered lines`,
    file: gap.file,
    line: gap.missingLines[0] ?? 1,
    code: CRITICAL_COVERAGE_CODE,
    fixHint: `add a test exercising ${simple} (uncovered: ${preview})`,
  };
}
