/**
 * Reading Stryker's JSON report — the `mutation-testing-elements` schema.
 *
 * ── WHAT THIS PARSES, AND HOW IT WAS VERIFIED ──────────────────────────────
 * Everything below was read out of the tool's own source, not inferred:
 *
 *  - `@stryker-mutator/core@9.6.1` (npm `dist-tags.latest`), whose `bin` entry
 *    is `stryker`.
 *  - Its `json` reporter writes `JSON.stringify(report)` to
 *    `jsonReporter.fileName`, whose schema default is
 *    `reports/mutation/mutation.json`, resolved against the process cwd
 *    (`packages/core/src/reporters/json-reporter.ts`).
 *  - `MutationTestResult` comes from `mutation-testing-report-schema` (3.7.3
 *    in the published core; 3.8.4 on master — the shape below is byte-identical
 *    in both). Stryker writes `schemaVersion: "1.0"`
 *    (`packages/core/src/reporters/mutation-test-report-helper.ts`).
 *  - `files` is a dictionary keyed by the file path RELATIVE TO THE PROCESS CWD
 *    with `\` normalized to `/` (`normalizeReportFileName` ->
 *    `path.relative(process.cwd(), fileName)` -> `normalizeFileName`).
 *  - Each mutant carries `id`, `mutatorName`, `location`, `status` and the
 *    optional `replacement`, `description`, `statusReason`, `coveredBy`,
 *    `killedBy`, `testsCompleted`, `static`, `duration`.
 *  - `location` is `{ start: { line, column }, end: { line, column } }`, LINES
 *    AND COLUMNS BOTH START AT ONE, start inclusive and end exclusive.
 *  - The eight `status` values, exactly capitalized:
 *    `Killed`, `Survived`, `NoCoverage`, `CompileError`, `RuntimeError`,
 *    `Timeout`, `Ignored`, `Pending`.
 *
 * ── WHAT COUNTS AS A SURVIVOR ──────────────────────────────────────────────
 * `Survived` is the direct analogue of cosmic-ray's `survived` outcome: tests
 * ran and none of them noticed.
 *
 * `NoCoverage` is ALSO undetected — no test even executed the mutated code —
 * and the mutation-testing-elements metrics count it as such. It is reported
 * here, but under its OWN violation code, because the two need different work:
 * a survivor needs a better assertion, a no-coverage mutant needs a test at
 * all. Collapsing them would send a reader to strengthen an assertion that
 * does not exist.
 *
 * Everything else is not a survivor. `Timeout` means the mutant hung, which IS
 * detection. `CompileError` means the mutant did not typecheck, so it could
 * never ship. `RuntimeError`, `Ignored` and `Pending` are states of the tool,
 * not verdicts about the test suite.
 */

/** A mutant the test suite failed to kill. */
export interface Survivor {
  /** Repo-relative POSIX path, as the report keyed it. */
  readonly file: string;
  /** 1-based. */
  readonly line: number;
  /** 1-based. */
  readonly column: number;
  /** Stryker's mutator category, e.g. `ConditionalExpression`. */
  readonly mutatorName: string;
  /** The code Stryker substituted, when it recorded one. */
  readonly replacement: string;
  /** `"Survived"` or `"NoCoverage"`. */
  readonly status: SurvivingStatus;
  /**
   * Index among survivors in the same file with the same mutator and
   * replacement, in report order. See `baseline.ts` — this, not Stryker's
   * `id`, is what makes a baseline entry survive an unrelated edit.
   */
  readonly occurrence: number;
}

/** The two statuses that mean "the suite would not have noticed". */
export type SurvivingStatus = "Survived" | "NoCoverage";

/** Counts across the whole run, for the summary line. */
export interface MutationTotals {
  readonly mutants: number;
  readonly killed: number;
  readonly survived: number;
  readonly noCoverage: number;
  readonly timeout: number;
  readonly compileError: number;
  readonly ignored: number;
  readonly files: number;
}

/** A parsed Stryker report. */
export interface MutationReport {
  readonly survivors: readonly Survivor[];
  readonly totals: MutationTotals;
  /** `schemaVersion` as written; kept so a future break is diagnosable. */
  readonly schemaVersion: string;
}

/** Violation code for a mutant that ran and was not detected. */
export const SURVIVING_MUTANT = "surviving-mutant";
/** Violation code for a mutant no test executed at all. */
export const UNCOVERED_MUTANT = "uncovered-mutant";

/**
 * Parse a Stryker JSON report.
 *
 * Returns `null` for anything that is not a readable report — unparsable JSON,
 * a non-object, a missing `files` dictionary. `null` is NOT an empty report:
 * the caller must render "we could not tell" and exit 3, never "no survivors"
 * and exit 0.
 *
 * Individual malformed MUTANTS, by contrast, are skipped rather than fatal.
 * The report is written by a tool at a version we do not pin, and refusing to
 * report ninety-nine good survivors because the hundredth lacks a `location`
 * would be the wrong trade.
 */
export function parseReport(raw: string): MutationReport | null {
  const body = reportBody(raw);
  if (body === null) {
    return null;
  }
  const walk = walkMutants(body.files);
  return {
    survivors: walk.survivors,
    totals: totalsOf(walk),
    schemaVersion: body.schemaVersion,
  };
}

/** The two top-level fields a readable report must have. */
interface ReportBody {
  /** The `files` dictionary, keyed by report-relative path. */
  readonly files: JsonObject;
  /** `schemaVersion` as written, or `""` when it is missing. */
  readonly schemaVersion: string;
}

/** The outer shape, or `null` for anything that is not a readable report. */
function reportBody(raw: string): ReportBody | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data)) {
    return null;
  }
  const files = data["files"];
  if (!isRecord(files)) {
    return null;
  }
  return { files, schemaVersion: asString(data["schemaVersion"]) ?? "" };
}

/** Everything one pass over the report's files produced. */
interface MutantWalk {
  readonly survivors: readonly Survivor[];
  /** Mutants seen per `status`, spelled as the report spelled it. */
  readonly counts: ReadonlyMap<string, number>;
  readonly mutants: number;
  readonly files: number;
}

/**
 * Walk every mutant, in sorted file order.
 *
 * Individual malformed entries are skipped rather than fatal — see
 * {@link parseReport} for why one bad mutant must not lose the rest.
 */
function walkMutants(files: JsonObject): MutantWalk {
  const survivors: Survivor[] = [];
  const occurrences = new Map<string, number>();
  const counts = new Map<string, number>();
  let mutants = 0;
  let fileCount = 0;

  for (const name of Object.keys(files).sort()) {
    const entry = files[name];
    if (!isRecord(entry)) {
      continue;
    }
    const list = entry["mutants"];
    if (!Array.isArray(list)) {
      continue;
    }
    fileCount += 1;
    for (const mutant of list) {
      mutants += 1;
      const status = statusOf(mutant);
      counts.set(status, (counts.get(status) ?? 0) + 1);
      const survivor = toSurvivor(name, mutant, status, occurrences);
      if (survivor !== null) {
        survivors.push(survivor);
      }
    }
  }
  return { survivors, counts, mutants, files: fileCount };
}

/** The summary counts, with every status the schema defines pinned to zero. */
function totalsOf(walk: MutantWalk): MutationTotals {
  const seen = (status: string): number => walk.counts.get(status) ?? 0;
  return {
    mutants: walk.mutants,
    files: walk.files,
    killed: seen("Killed"),
    survived: seen("Survived"),
    noCoverage: seen("NoCoverage"),
    timeout: seen("Timeout"),
    compileError: seen("CompileError"),
    ignored: seen("Ignored"),
  };
}

function statusOf(mutant: unknown): string {
  return isRecord(mutant) ? (asString(mutant["status"]) ?? "") : "";
}

function toSurvivor(
  file: string,
  mutant: unknown,
  status: string,
  occurrences: Map<string, number>,
): Survivor | null {
  if (!isRecord(mutant) || !isSurvivingStatus(status)) {
    return null;
  }
  const start = startOf(mutant);
  const mutatorName = asString(mutant["mutatorName"]) ?? "";
  if (start === null || mutatorName === "") {
    // Without a pointer or a category there is nothing actionable to say, and
    // a violation with neither is noise in an agent's context window.
    return null;
  }
  const replacement = asString(mutant["replacement"]) ?? "";
  const key = `${file} ${mutatorName} ${replacement}`;
  const occurrence = occurrences.get(key) ?? 0;
  occurrences.set(key, occurrence + 1);
  return {
    file,
    line: start.line,
    column: start.column,
    mutatorName,
    replacement,
    status,
    occurrence,
  };
}

/** A mutant's 1-based start, with both halves resolved. */
interface MutantStart {
  readonly line: number;
  readonly column: number;
}

/**
 * `location.start`, or `null` when the report gave no usable line.
 *
 * A missing COLUMN falls back to 1 — a pointer at the start of the right line
 * is still actionable. A missing LINE is not recoverable, and the mutant is
 * dropped rather than pointed at the top of the file.
 */
function startOf(mutant: JsonObject): MutantStart | null {
  const location = mutant["location"];
  const start = isRecord(location) ? location["start"] : undefined;
  if (!isRecord(start)) {
    return null;
  }
  const line = asInt(start["line"]);
  return line === null ? null : { line, column: asInt(start["column"]) ?? 1 };
}

function isSurvivingStatus(status: string): status is SurvivingStatus {
  return status === "Survived" || status === "NoCoverage";
}

/**
 * Render survivors as token-efficient `file:line:column` lines.
 *
 * kragg's output philosophy, inherited from `render_survivors` in the Python
 * sibling: ACTIONABLE POINTERS, NOT A TOOL DUMP. Stryker's own `clear-text`
 * reporter prints the surrounding source and a diff per mutant, which is the
 * right choice for a human at a terminal and the wrong one for the agent this
 * output is usually read by. One line per survivor, with the replacement that
 * went unnoticed, is what someone needs to write the missing assertion.
 */
export function renderSurvivors(survivors: readonly Survivor[]): string[] {
  if (survivors.length === 0) {
    return ["no surviving mutants"];
  }
  const files = new Set(survivors.map((survivor) => survivor.file)).size;
  const lines = [
    `mutation: ${survivors.length} undetected mutants in ${files} files`,
  ];
  for (const survivor of survivors) {
    lines.push(`  ${describe(survivor)}`);
  }
  return lines;
}

function describe(survivor: Survivor): string {
  const where = `${survivor.file}:${survivor.line}:${survivor.column}`;
  const what =
    survivor.replacement === ""
      ? survivor.mutatorName
      : `${survivor.mutatorName} -> ${condense(survivor.replacement)}`;
  const prefix = survivor.status === "NoCoverage" ? "uncovered mutant" : "surviving mutant";
  return `${where} ${prefix} (${what})`;
}

/** One line, whitespace-collapsed, capped — a replacement may be a whole block. */
export function condense(replacement: string, maxLength = 60): string {
  const flat = replacement.replace(/\s+/gu, " ").trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
}

/** The one-line score summary, printed above the pointers. */
export function renderTotals(totals: MutationTotals): string {
  const detected = totals.killed + totals.timeout;
  const valid = detected + totals.survived + totals.noCoverage;
  const score = valid === 0 ? "n/a" : `${Math.round((detected / valid) * 1000) / 10}%`;
  return (
    `${totals.mutants} mutants across ${totals.files} files: ` +
    `${totals.killed} killed, ${totals.timeout} timed out, ` +
    `${totals.survived} survived, ${totals.noCoverage} uncovered, ` +
    `${totals.compileError} compile errors, ${totals.ignored} ignored ` +
    `(score ${score})`
  );
}

/** The violation `code` a survivor maps to. */
export function survivorCode(survivor: Survivor): string {
  return survivor.status === "NoCoverage" ? UNCOVERED_MUTANT : SURVIVING_MUTANT;
}

/** A parsed JSON object, before any of its fields have been checked. */
type JsonObject = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}
