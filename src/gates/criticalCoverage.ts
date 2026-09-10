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
 * so this gate runs under EVERY supported runner.
 *
 * THE REPORT ARRIVES PARSED. This gate never runs a coverage tool and never
 * reads a well-known path; the caller passes the parsed document, or the lcov
 * text. That keeps the gate testable with a literal, and leaves the question
 * of HOW coverage gets produced to the adapter phase that owns it.
 *
 * ── UNMEASURED IS A FINDING, NOT A PASS ────────────────────────────────────
 * Python's gate treats a critical function the report never mentions as
 * `measured=False` and does not fail it, on the reasoning that the likeliest
 * cause is a measurement-key mismatch. That reasoning does not hold here: the
 * `check` pipeline hands this gate the document ITS OWN test run just wrote,
 * keyed under this root, so a file with no entry was not mis-keyed — it was
 * never loaded, because no test imports it. A critical function no test
 * imports is the exact thing this gate exists to notice, and reporting it as
 * a pass would let the highest-fan-in function in the project go untested
 * without a word. So every critical function must be MEASURED — its file in
 * the report, its extent known, and something in the report saying whether
 * it ran — or it is reported as UNMEASURED: a violation with its own code,
 * `critical-unmeasured`, whose message states the cause (never loaded, a
 * name the source could not disambiguate, or a body the report is silent on)
 * so a reader can tell "write a test that imports this" from "cover lines 4
 * and 5". This is a deliberate divergence from Python; `kragg coverage`
 * lists the same functions under the same causes.
 *
 * ── WHERE THE FUNCTION'S EXTENT COMES FROM ─────────────────────────────────
 * The SOURCE, first (`coverage/spans.ts`): its index is keyed the way
 * `criticality.json` spells a name, so `Reader.close` and `Writer.close`
 * resolve to their own bodies even though every report records both as
 * `close`. Only a function the source cannot bound falls back to the span
 * the report states (istanbul's `fnMap.loc`; lcov states none). A line is
 * attributed to exactly one function's span, and a class node — `new Foo()`
 * on a class without a constructor — owns only the lines outside its member
 * functions, so no function is ever blamed for another's lines.
 *
 * STATED LIMIT of the class node: what it can observe is its own lines and
 * V8's `<instance_members_initializer>` record (which counts constructions).
 * A class with no field initializer leaves no such record, and its header
 * line runs when the MODULE loads, so such a class reads as clean once its
 * module is imported even if no test ever constructed it. That is what line
 * coverage states, and this gate does not claim more.
 *
 * ── LINE COVERAGE, NOT BRANCH COVERAGE ─────────────────────────────────────
 * "No uncovered lines" is a statement about LINES. `if (broken) fix();` on
 * one line counts as covered once the `if` ran, whether or not `fix()` did;
 * `coverage/model.ts` states why branch facts stay out of the line model.
 * Nothing this gate prints should be read as a branch verdict.
 */

import { join } from "node:path";

import { resolveTypeScript, type TypeScriptApi } from "../analysis/sourceFile.ts";
import { normalizeIstanbul } from "../coverage/istanbul.ts";
import { normalizeLcov } from "../coverage/lcov.ts";
import {
  functionsNamed,
  ranWithin,
  uncoveredWithin,
  type FileCoverage,
  type FunctionSpan,
  type LineCoverageReport,
  type NormalizedCoverage,
} from "../coverage/model.ts";
import {
  functionSpans,
  ownsLine,
  uniqueSpan,
  type SourceSpan,
  type SpanIndex,
} from "../coverage/spans.ts";
import { parseLcov } from "../adapters/support/lcov.ts";
import type { Violation } from "../engine/models.ts";
import {
  criticalFunctions,
  declarationProblem,
  hasCriticalityData,
  simpleName,
  type CriticalFunction,
} from "./testDepth/criticalFunctions.ts";
import {
  failed,
  NO_CRITICALITY_REASON,
  ran,
  skipped,
  type TestDepthOutcome,
} from "./testDepth/outcome.ts";

/** `Violation.code` for a critical function with uncovered lines. */
export const CRITICAL_COVERAGE_CODE = "critical-coverage";

/** `Violation.code` for a critical function the report says nothing usable about. */
export const CRITICAL_UNMEASURED_CODE = "critical-unmeasured";

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
   * An lcov tracefile — its TEXT, or the report `adapters/support/lcov.ts`
   * already parsed from it — which is all `node --test` and `bun test` can
   * produce.
   *
   * ISTANBUL WINS when both are present, and that is not arbitrary: istanbul
   * states each function's full body span while lcov states only where it
   * starts, so the richer document produces the better attribution. The
   * caller is responsible for passing only documents from one run; the
   * `check` pipeline passes exactly the one its test gate just produced.
   */
  readonly lcov?: string | LineCoverageReport | undefined;
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
  /** False when the report says nothing usable about this function. */
  readonly measured: boolean;
  /** When `measured` is false: the cause, in the words a reader needs. */
  readonly reason?: string | undefined;
  /** The declaration's 1-based line in the source, when the source states it. */
  readonly line?: number | undefined;
  /** Why a reviewer declared it critical, when one did; see the policy. */
  readonly declaredReason?: string;
}

/** Return violations for critical functions with uncovered or unmeasured lines. */
export function checkCriticalCoverage(
  options: CriticalCoverageOptions,
): TestDepthOutcome {
  if (!hasCriticalityData(options.root)) {
    return skipped(NO_CRITICALITY_REASON);
  }
  // A `critical_functions` entry that names nothing means this gate would
  // measure a population a reviewer believes is larger. Error, not silence.
  const stale = declarationProblem(options.root);
  if (stale !== null) {
    return failed(stale);
  }
  const coverage = coverageModel(options);
  if (coverage === null) {
    return skipped(NO_COVERAGE_REASON);
  }
  const problem = coverageEvidenceProblem(coverage, options.sourcePaths);
  if (problem !== null) {
    return failed(problem);
  }
  const violations: Violation[] = [];
  for (const gap of criticalCoverageGaps(options)) {
    if (!gap.measured) {
      violations.push(unmeasuredViolation(gap));
    } else if (gap.missingLines.length > 0) {
      violations.push(toViolation(gap));
    }
  }
  return ran(violations);
}

/**
 * Uncovered lines per public critical function, ranked by fan-in.
 *
 * Includes the unmeasured ones with their cause — the gate reports them and
 * `kragg coverage` lists them, off the same rows, so the two never disagree.
 */
export function criticalCoverageGaps(
  options: CriticalCoverageOptions,
): readonly CriticalCoverageGap[] {
  const coverage = coverageModel(options);
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
 * `null` is "nothing was supplied" and must never be confused with "nothing
 * is uncovered": every caller turns it into a visible skip.
 */
export function coverageModel(options: CriticalCoverageOptions): NormalizedCoverage | null {
  if (typeof options.report === "object" && options.report !== null) {
    return normalizeIstanbul(options.report, options.root);
  }
  if (typeof options.lcov === "string" && options.lcov !== "") {
    return normalizeLcov(parseLcov(options.lcov, "lcov.info"), options.root);
  }
  if (typeof options.lcov === "object") {
    return normalizeLcov(options.lcov, options.root);
  }
  return null;
}

/**
 * Why a document that WAS supplied cannot serve as evidence, or `null`.
 *
 * An empty document, or one naming only files outside `sourcePaths`, is not
 * "every critical function is unmeasured" — that would be a wall of findings
 * about a broken input. It is an ERROR naming what was expected: the run's
 * coverage over the project's source. The gate maps it to exit 3.
 */
export function coverageEvidenceProblem(
  coverage: NormalizedCoverage,
  sourcePaths: readonly string[],
): string | null {
  const expected = `expected an entry for every file under ${sourcePaths.join(", ")} the tests loaded`;
  if (coverage.files.size === 0) {
    return `the coverage report names no files (${expected})`;
  }
  const prefixes = sourcePaths.map((path) => `${path.replace(/\/+$/u, "")}/`);
  const paths = [...coverage.files.keys()];
  if (!paths.some((path) => prefixes.some((prefix) => path.startsWith(prefix)))) {
    return (
      `the coverage report names ${paths.length} files but none under ` +
      `${sourcePaths.join(", ")} — its keys do not resolve inside this project root ` +
      `(first: ${paths[0] ?? ""}; ${expected})`
    );
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

  /**
   * The one span `critical` identifies in its file, or `null` if it is absent
   * or ambiguous. The qualified name is tried first — it is what tells
   * `Reader.close` from `Writer.close` — and the simple name only after it.
   */
  spanOf(critical: CriticalFunction): SourceSpan | null {
    const cached =
      this.#cache.get(critical.file) ??
      functionSpans(join(this.#root, critical.file), this.#root, this.#api);
    this.#cache.set(critical.file, cached);
    const qualified = critical.qualname.slice(critical.module.length + 1);
    return uniqueSpan(cached, qualified) ?? uniqueSpan(cached, critical.name);
  }
}

/**
 * Resolve one critical function against the report.
 *
 * THREE WAYS THIS IS UNMEASURED, and every one is reported rather than passed:
 * the file has no entry (never loaded), the function's extent is known from
 * neither the source nor the report, or the extent is known but the report
 * has neither a function record for it nor an executable line inside it — a
 * one-expression arrow the report never recorded — so nothing says whether
 * it ran.
 *
 * Whether the function RAN comes from its own function record when the report
 * has one (matched by name, or by the line it starts on when the report names
 * it differently — V8 names a constructor after its class), and otherwise
 * from an executable line inside its span having run. A function that never
 * ran and holds no uncovered statement line is reported as missing its
 * declaration line: without that, a critical function no test ever calls
 * could pass a gate whose entire purpose is to notice exactly that.
 */
function measure(
  critical: CriticalFunction,
  file: FileCoverage | undefined,
  extents: SourceExtents,
): CriticalCoverageGap {
  const source = extents.spanOf(critical);
  const row = new Row(critical, source?.startLine);
  if (file === undefined) {
    return row.unmeasured(
      `the test run never loaded ${critical.file} (no entry in the coverage report)`,
    );
  }
  const named = functionsNamed(file, critical.name);
  const only = named.length === 1 ? named[0] : undefined;
  const span = source ?? reportedSpan(only);
  if (span === null) {
    // Nothing can bound the body, but the report may state the one fact that
    // needs no extent: the function was never entered.
    return only !== undefined && only.hits === 0
      ? row.measured([only.startLine])
      : row.unmeasured(unbounded(critical, only, named));
  }
  return withinExtent(row, file, named, span);
}

/** The extent is known: its uncovered lines, or the one fact that it never ran. */
function withinExtent(
  row: Row,
  file: FileCoverage,
  named: readonly FunctionSpan[],
  span: SourceSpan,
): CriticalCoverageGap {
  const record = recordFor(file, named, span);
  const missing = uncoveredWithin(file, span.startLine, span.endLine).filter((at) =>
    ownsLine(span, at),
  );
  const entered =
    record === undefined ? ranWithin(file, span.startLine, span.endLine) : record.hits > 0;
  if (missing.length > 0 || entered) {
    return row.measured(missing);
  }
  return record === undefined
    ? row.unmeasured(
        "the coverage report records neither a function nor an executable line at " +
          `${row.file}:${span.startLine}-${span.endLine}, so it does not say whether it ran`,
      )
    : row.measured([span.startLine]);
}

/** One critical function's row, built from whichever outcome `measure` reaches. */
class Row {
  readonly #critical: CriticalFunction;
  readonly #line: number | undefined;

  constructor(critical: CriticalFunction, line: number | undefined) {
    this.#critical = critical;
    this.#line = line;
  }

  get file(): string {
    return this.#critical.file;
  }

  measured(missingLines: readonly number[]): CriticalCoverageGap {
    return { ...this.base(), missingLines, measured: true };
  }

  unmeasured(reason: string): CriticalCoverageGap {
    return { ...this.base(), missingLines: [], measured: false, reason };
  }

  private base(): RowBase {
    const { qualname, file, fanIn, declaredReason } = this.#critical;
    return {
      qualname,
      file,
      fanIn,
      line: this.#line,
      ...(declaredReason === undefined ? {} : { declaredReason }),
    };
  }
}

/** The fields every row carries, whichever way it was measured. */
interface RowBase {
  readonly qualname: string;
  readonly file: string;
  readonly fanIn: number;
  readonly line: number | undefined;
  /** Why a reviewer declared it critical; absent when the graph selected it. */
  readonly declaredReason?: string;
}

/** The span the report itself states — istanbul's `loc`; lcov states none. */
function reportedSpan(only: FunctionSpan | undefined): SourceSpan | null {
  return only === undefined || only.endLine === null
    ? null
    : { startLine: only.startLine, endLine: only.endLine };
}

/** Why neither the source nor the report could bound this function. */
function unbounded(
  critical: CriticalFunction,
  only: FunctionSpan | undefined,
  named: readonly FunctionSpan[],
): string {
  if (named.length > 1) {
    return (
      `${critical.name} is bound ${named.length} times in ${critical.file} and the ` +
      "source could not tell them apart"
    );
  }
  if (only !== undefined) {
    return (
      `${critical.name} was entered ${only.hits} times, but neither the source nor the ` +
      "tracefile states where its body ends, so its lines could not be checked"
    );
  }
  return (
    `the coverage report records no function named ${critical.name} in ` +
    `${critical.file}, and the source could not bound it`
  );
}

/**
 * The function record that describes `span`, if the report has one.
 *
 * By name when the name is unique in the span (the report and the source
 * agree), then by the line the span starts on (the report names it
 * differently — V8 calls a constructor by its class). A class span accepts
 * any record in its own lines — V8's `<instance_members_initializer>` — since
 * that is what runs when the class is constructed.
 */
function recordFor(
  file: FileCoverage,
  named: readonly FunctionSpan[],
  span: SourceSpan,
): FunctionSpan | undefined {
  const inside = (record: FunctionSpan): boolean => ownsLine(span, record.startLine);
  const byName = named.filter(inside);
  if (byName.length === 1) {
    return byName[0];
  }
  const atStart = file.functions.find((record) => record.startLine === span.startLine);
  if (atStart !== undefined) {
    return atStart;
  }
  return span.holes === undefined ? undefined : file.functions.find(inside);
}

/** Message, hint and location copied from Python's `_violation`. */
function toViolation(gap: CriticalCoverageGap): Violation {
  const simple = simpleName(gap.qualname);
  const preview = gap.missingLines.slice(0, PREVIEW_LIMIT).join(", ");
  // A declared function is named with the reviewer's reason, for the same
  // purpose as in `critical-tests`: "fan-in 1, why is this gated" is the
  // question the message has to answer before anybody acts on it.
  const why = gap.declaredReason === undefined ? "" : ` (declared: ${gap.declaredReason})`;
  return {
    message:
      `critical function ${gap.qualname}${why} has ` +
      `${gap.missingLines.length} uncovered lines`,
    file: gap.file,
    line: gap.missingLines[0] ?? 1,
    code: CRITICAL_COVERAGE_CODE,
    fixHint: `add a test exercising ${simple} (uncovered: ${preview})`,
  };
}

/** An unmeasured function: its own code, and the cause in the message. */
function unmeasuredViolation(gap: CriticalCoverageGap): Violation {
  const simple = simpleName(gap.qualname);
  // Same reason `toViolation` quotes it: a declared function is gated because
  // a reviewer said so, and a reader asked to write a test for a fan-in-1
  // function needs to be told that before deciding it is a false positive.
  const why = gap.declaredReason === undefined ? "" : ` (declared: ${gap.declaredReason})`;
  return {
    message: `critical function ${gap.qualname}${why} has no coverage data: ${gap.reason ?? ""}`,
    file: gap.file,
    line: gap.line ?? 1,
    code: CRITICAL_UNMEASURED_CODE,
    fixHint: `add a test that imports ${gap.file} and exercises ${simple}`,
  };
}
