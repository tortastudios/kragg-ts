/**
 * Selecting, ordering and structuring the test cases `kragg spec` prints.
 *
 * Split from `spec.ts` so the command module keeps the extraction and the
 * tree render while the filters and the output budget live here. Read
 * `commands/inventory.ts` first for the budget contract.
 *
 * ── THE ENTRY IS A TEST CASE, NOT A LINE ───────────────────────────────────
 * `--limit` counts cases. Suite headings are structure, not content: a budget
 * that counted them would print a different number of tests depending on how
 * deeply the author nested their `describe`s, and two files with the same
 * tests would report different totals.
 *
 * ── ORDERING IS (PATH, THEN SOURCE ORDER) ──────────────────────────────────
 * Files sort by repo-relative path; cases keep the order they appear in the
 * file. That second half is not a shortcut — the document IS the file's
 * structure, and sorting cases by title would detach them from the `describe`
 * blocks that give them meaning. Both halves are stable, so two runs over the
 * same tree are byte-identical and the JSON entry order is the text order.
 */

import {
  inventoryJson,
  underAnyPath,
  type Budgeted,
  type InventoryOptions,
} from "../inventory.ts";
import type { PropertyReport } from "./property.ts";
import type { SpecCase, SpecFile } from "../spec.ts";

/** One test case, with the file and the suite titles that enclose it. */
export interface SpecEntry {
  /** Repo-relative POSIX path of the test file. */
  readonly file: string;
  /** Enclosing `describe`/`suite` titles, outermost first. */
  readonly suites: readonly string[];
  readonly testCase: SpecCase;
}

/** Totals for a selection, printed in the header so a budget cannot hide them. */
export interface SpecCounts {
  readonly total: number;
  readonly files: number;
  readonly skipped: number;
}

/** Flatten the extracted files into ordered, individually selectable cases. */
export function specEntries(files: readonly SpecFile[]): readonly SpecEntry[] {
  const entries: SpecEntry[] = [];
  for (const file of [...files].sort(byFile)) {
    for (const testCase of file.cases) {
      entries.push({ file: file.file, suites: enclosing(file, testCase), testCase });
    }
  }
  return entries;
}

/**
 * The cases a `--path` / `--symbol` / `--changed` selection keeps.
 *
 * The filters intersect; repeats of one flag union. `--symbol` is the one
 * whose meaning had to be chosen rather than inherited — see
 * {@link matchesTitle}.
 */
export function selectSpecEntries(
  entries: readonly SpecEntry[],
  options: InventoryOptions,
  changed: ReadonlySet<string> | null,
): readonly SpecEntry[] {
  return entries.filter((entry) => {
    if (options.paths.length > 0 && !underAnyPath(entry.file, options.paths)) {
      return false;
    }
    if (options.symbols.length > 0 && !matchesTitle(entry, options.symbols)) {
      return false;
    }
    return changed === null || changed.has(entry.file);
  });
}

/**
 * Whether a `--symbol` selector names this case.
 *
 * CASE-INSENSITIVE SUBSTRING of the case title or of any enclosing `describe`
 * title — deliberately not the exact match `map --symbol` uses. A test is not
 * named by an identifier; it is named by a sentence its author wrote
 * (`it("refuses a scoped criticality report")`). Nobody can type one from
 * memory, and matching an enclosing suite is what makes
 * `--symbol "property coverage"` return that whole group, which is how a
 * reader thinks about a suite. The flag keeps its name across both commands
 * because it answers the same question — "show me the entries about X" — and
 * `--help` states each meaning.
 */
function matchesTitle(entry: SpecEntry, selectors: readonly string[]): boolean {
  const haystacks = [...entry.suites, entry.testCase.title].map((text) =>
    text.toLowerCase(),
  );
  return selectors.some((selector) => {
    const needle = selector.toLowerCase();
    return haystacks.some((text) => text.includes(needle));
  });
}

/** Totals for a selection: cases, distinct files, and skipped cases. */
export function specCounts(entries: readonly SpecEntry[]): SpecCounts {
  return {
    total: entries.length,
    files: new Set(entries.map((entry) => entry.file)).size,
    skipped: entries.filter((entry) => entry.testCase.skipped).length,
  };
}

/**
 * Rebuild renderable files from the cases that survived selection and budget.
 *
 * The suites come from the ORIGINAL extraction, not from the kept cases, so a
 * surviving case keeps the headings it sits under; `renderFile` in `spec.ts`
 * then drops any suite left holding nothing. That is what makes a filtered
 * tree still read as a tree instead of a flat list of sentences.
 */
export function regroupSpec(
  files: readonly SpecFile[],
  entries: readonly SpecEntry[],
): readonly SpecFile[] {
  const suites = new Map(files.map((file) => [file.file, file.suites]));
  const kept: SpecFile[] = [];
  for (const entry of entries) {
    const last = kept.at(-1);
    if (last?.file === entry.file) {
      kept[kept.length - 1] = { ...last, cases: [...last.cases, entry.testCase] };
      continue;
    }
    kept.push({
      file: entry.file,
      suites: suites.get(entry.file) ?? [],
      cases: [entry.testCase],
    });
  }
  return kept;
}

/**
 * The structured render.
 *
 * Carries the same three numbers every budgeted inventory carries, plus the
 * property-coverage summary the text render prints — a machine format that
 * said less than the human one would just push the caller back to parsing
 * prose. `available: false` keeps its reason and reports no counts at all,
 * because "not measured" is not "zero".
 */
export function renderSpecJson(
  budget: Budgeted<SpecEntry>,
  counts: SpecCounts,
  report: PropertyReport,
): string {
  return inventoryJson({
    command: "spec",
    total: counts.total,
    shown: budget.shown,
    truncated: budget.truncated,
    files: counts.files,
    skipped: counts.skipped,
    entries: budget.entries.map((entry) => ({
      file: entry.file,
      suites: entry.suites,
      title: entry.testCase.title,
      line: entry.testCase.line,
      skipped: entry.testCase.skipped,
    })),
    property: propertySummary(report),
  });
}

/** The property section, reduced to counts a caller can branch on. */
function propertySummary(report: PropertyReport): Readonly<Record<string, unknown>> {
  if (!report.available) {
    return { available: false, reason: report.reason };
  }
  return {
    available: true,
    reason: null,
    covered: report.rows.filter((row) => row.hasPropertyTest).length,
    total: report.rows.length,
  };
}

/** The `describe`/`suite` titles enclosing a case, outermost first. */
function enclosing(file: SpecFile, testCase: SpecCase): readonly string[] {
  return file.suites
    .filter((suite) => testCase.line >= suite.line && testCase.line <= suite.endLine)
    .sort((left, right) => left.line - right.line)
    .map((suite) => suite.title);
}

function byFile(left: SpecFile, right: SpecFile): number {
  if (left.file === right.file) {
    return 0;
  }
  return left.file < right.file ? -1 : 1;
}
