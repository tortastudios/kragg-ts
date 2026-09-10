/**
 * Focused, bounded retrieval for the agent-facing inventories.
 *
 * `map`, `spec` and `brief` are the three commands whose whole job is to hand
 * a reader a picture of the repository. On this repository the unfiltered
 * `map` is ~95,000 characters and `spec` ~86,000 — several times a sensible
 * prompt budget, with no way to ask for one directory, one symbol or just
 * what changed. An inventory that cannot be narrowed is an inventory nobody
 * can afford to read, so it gets skipped and the agent reinvents what it
 * could not see. That is the exact failure `map` exists to prevent, arriving
 * through the back door.
 *
 * ── A DISPLAY BUDGET IS NOT A SCOPE ────────────────────────────────────────
 * Everything here is about what gets PRINTED. It never narrows what gets
 * derived, enforced or written:
 *
 *  - `kragg map` still derives the whole project's criticality graph through
 *    the same `ensure()` the check pipeline uses, whatever `--path` says;
 *  - `.kragg/map.md` (`map --write`) is always the complete inventory, and
 *    `--write` refuses the content filters outright rather than persisting a
 *    partial file that would read as "nothing else exists";
 *  - no gate reads any of this.
 *
 * ── AND A TRUNCATED VIEW MUST NEVER LOOK COMPLETE ──────────────────────────
 * Every budgeted render carries the TOTAL of the selection, not just what fit.
 * Text ends with `showing N of M … — pass --limit 0 for everything`; JSON
 * carries `total`, `shown` and `truncated` next to the entries. A reader who
 * only sees the entries can still tell there are more, which is the one
 * property that makes a budget safe to apply by default.
 */

import { changedFiles } from "../git/changes.ts";

/**
 * Entries printed when the caller names no budget.
 *
 * Chosen so the default `kragg map` and `kragg spec` on this repository land
 * around 12,000 and 8,000 characters — comfortably under a ~20,000-character
 * budget, and roughly an eighth of what they used to cost. It is a display
 * default, so raising it costs nothing but tokens and `--limit 0` turns it
 * off entirely.
 */
export const DEFAULT_LIMIT = 100;

/** What an inventory prints to stderr when `--changed` cannot be answered. */
export const CHANGED_UNAVAILABLE = "not a git repository (required for --changed)";

/** How an inventory renders. `json` is the structured, countable one. */
export type InventoryFormat = "text" | "json";

/** The resolved filters and budget an inventory command runs with. */
export interface InventoryOptions {
  /** Source/test path prefixes to keep. Empty means "no path filter". */
  readonly paths: readonly string[];
  /** Symbol/title selectors. Empty means "no symbol filter". */
  readonly symbols: readonly string[];
  /** Restrict to files changed against `HEAD`. */
  readonly changed: boolean;
  /** Entries to print; `0` is the deliberate full export. */
  readonly limit: number;
  readonly format: InventoryFormat;
}

/**
 * The parsed flags an inventory command was given.
 *
 * Structurally a subset of `parseArgs`' `values`, so `cli.ts` can pass that
 * record straight through instead of restating it per command — one place
 * decides what `--all` and a missing `--limit` mean.
 */
export interface InventoryRequest {
  readonly path?: readonly string[] | undefined;
  readonly symbol?: readonly string[] | undefined;
  readonly changed?: boolean | undefined;
  readonly all?: boolean | undefined;
  readonly limit?: string | undefined;
  readonly format?: string | undefined;
}

/**
 * Resolve raw flags into the options an inventory runs with.
 *
 * `--all` is exactly `--limit 0`; `cli.ts` rejects the two together rather
 * than picking a winner. `--limit` has already been vetted as a non-negative
 * integer by `invalidValue`, and the guard here keeps that true for any
 * caller that does not come through `dispatch`.
 */
export function inventoryOptions(values: InventoryRequest): InventoryOptions {
  const raw = values.limit;
  const named = raw !== undefined && /^[0-9]+$/.test(raw) ? Number(raw) : DEFAULT_LIMIT;
  return {
    paths: values.path ?? [],
    symbols: values.symbol ?? [],
    changed: values.changed === true,
    limit: values.all === true ? 0 : named,
    format: values.format === "json" ? "json" : "text",
  };
}

/** Whether any filter is active, which is what makes an empty result news. */
export function isFiltered(options: InventoryOptions): boolean {
  return options.paths.length > 0 || options.symbols.length > 0 || options.changed;
}

/** A selection cut down to its budget, with the totals it was cut from. */
export interface Budgeted<T> {
  /** The entries to print: the first `limit` of the selection. */
  readonly entries: readonly T[];
  /** How many entries the selection held before the budget applied. */
  readonly total: number;
  /** How many are in `entries`. */
  readonly shown: number;
  /** Whether anything was withheld. */
  readonly truncated: boolean;
}

/** Apply an entry budget. `limit === 0` means print everything. */
export function applyBudget<T>(entries: readonly T[], limit: number): Budgeted<T> {
  const kept = limit === 0 ? entries : entries.slice(0, limit);
  return {
    entries: kept,
    total: entries.length,
    shown: kept.length,
    truncated: kept.length < entries.length,
  };
}

/**
 * The line a truncated text render ends with, or `null` when nothing was cut.
 *
 * It names the total and the escape hatch in one line, so a reader who scrolls
 * to the bottom — or an agent that reads the last line — cannot mistake the
 * printed entries for the whole selection.
 */
export function truncationNote(budget: Budgeted<unknown>, noun: string): string | null {
  if (!budget.truncated) {
    return null;
  }
  return `showing ${budget.shown} of ${budget.total} ${noun} — pass --limit 0 for everything`;
}

/**
 * Repo-relative paths changed against `HEAD`, or `null` when git cannot say.
 *
 * `null` is not an empty change set — the distinction `git/changes.ts` exists
 * to keep. An inventory that printed "nothing matches" outside a repository
 * would be a confident, wrong answer, so every caller turns `null` into
 * {@link CHANGED_UNAVAILABLE} and a non-zero exit instead.
 *
 * Declaration files are included: a `.d.ts` is public surface, which is
 * exactly what `map` reports on.
 */
export async function changedSet(
  root: string,
  allowed: readonly string[],
): Promise<ReadonlySet<string> | null> {
  const files = await changedFiles(root, null, allowed, { includeDeclarations: true });
  return files === null ? null : new Set(files);
}

/**
 * Whether a repo-relative path sits at, or under, one of the prefixes.
 *
 * Segment-aware, matching `isAllowed` in `git/changes.ts`: `src` selects
 * `src/a.ts` but not `srcfoo/a.ts`. An empty prefix list selects nothing, so
 * callers test `paths.length > 0` before filtering; `.` and `""` select
 * everything, matching how the policy names the repository root.
 */
export function underAnyPath(candidate: string, prefixes: readonly string[]): boolean {
  const path = normalizePath(candidate);
  return prefixes.some((prefix) => {
    const base = normalizePath(prefix);
    if (base === "" || base === ".") {
      return true;
    }
    return path === base || path.startsWith(`${base}/`);
  });
}

/** Repo-relative POSIX normalisation: `\` to `/`, no `./`, no trailing `/`. */
export function normalizePath(value: string): string {
  let path = value.replaceAll("\\", "/");
  while (path.startsWith("./")) {
    path = path.slice(2);
  }
  while (path.endsWith("/") && path.length > 1) {
    path = path.slice(0, -1);
  }
  return path;
}

/** Serialise a structured inventory. `indent: 1` matches every other payload. */
export function inventoryJson(document: Readonly<Record<string, unknown>>): string {
  return `${JSON.stringify(document, null, 1)}\n`;
}
