/**
 * Selecting, ordering and rendering the entries `kragg map` prints.
 *
 * Split from `map.ts` so the command module stays the policy — derive the
 * criticality graph, decide what `--write` may persist, choose an exit code —
 * while the shape of the inventory lives here. Read `commands/inventory.ts`
 * first: it holds the budget contract these renders honour.
 *
 * ── ORDERING IS (PATH, THEN NAME) ──────────────────────────────────────────
 * Entries sort by repo-relative file path and then by qualified name, in both
 * the text and the JSON render, so the two agree line for line and two runs
 * of the same tree are byte-identical. This diverges from `mapping.py`, which
 * emits source order: with a limit in play, source order means a symbol
 * appears or disappears from the printed window depending on where in the
 * file its author happened to declare it, and a re-ordered file produces a
 * spurious `.kragg/map.md` diff.
 *
 * Sorting by qualname keeps methods under their class for free — `Client`
 * sorts before `Client.send`, because a prefix sorts before any extension of
 * it — which is what the deeper indent on a method line depends on.
 */

import { parsedSources, type TypeScriptApi } from "../../analysis/sourceFile.ts";
import type { KraggPolicy } from "../../policy/policy.ts";
import {
  applyBudget,
  inventoryJson,
  truncationNote,
  underAnyPath,
  type Budgeted,
  type InventoryOptions,
} from "../inventory.ts";
import { moduleSymbols, type MapSymbol } from "./symbols.ts";

/** One exported symbol, located and risk-flagged, ready to render or select. */
export interface MapEntry {
  /** Extension-stripped module name, e.g. `src/analysis/sourceFile`. */
  readonly module: string;
  /** Repo-relative file path, e.g. `src/analysis/sourceFile.ts`. */
  readonly relative: string;
  readonly symbol: MapSymbol;
  /** Risk band from `.kragg/criticality.json`, or `null` when not critical. */
  readonly risk: string | null;
}

/**
 * Every exported symbol in the project, ordered by path and then by name.
 *
 * The complete inventory, always: filters apply afterwards, in
 * {@link selectMapEntries}, so the criticality derivation and `--write` keep
 * seeing everything no matter what the caller asked to look at.
 */
export function mapEntries(
  root: string,
  policy: KraggPolicy,
  api: TypeScriptApi,
  flags: ReadonlyMap<string, string>,
): readonly MapEntry[] {
  const entries: MapEntry[] = [];
  for (const source of parsedSources(root, policy.sourcePaths, {
    api,
    includeDeclarations: true,
  })) {
    for (const symbol of moduleSymbols(source, api)) {
      entries.push({
        module: source.module,
        relative: source.relative,
        symbol,
        risk: flags.get(`${source.module}#${symbol.qualname}`) ?? null,
      });
    }
  }
  return [...entries].sort(byPathThenName);
}

/**
 * The entries a `--path` / `--symbol` / `--changed` selection keeps.
 *
 * The three filters intersect (a symbol must satisfy every filter that was
 * given); repeats of one flag union (`--path src/a --path src/b` is either).
 * That is the combination an agent reaches for — "the exported surface of the
 * directory I am editing" — and it is the only one where each additional flag
 * makes the answer smaller, which is what a filter is for.
 */
export function selectMapEntries(
  entries: readonly MapEntry[],
  options: InventoryOptions,
  changed: ReadonlySet<string> | null,
): readonly MapEntry[] {
  return entries.filter((entry) => {
    if (options.paths.length > 0 && !matchesPath(entry, options.paths)) {
      return false;
    }
    if (options.symbols.length > 0 && !matchesSymbol(entry, options.symbols)) {
      return false;
    }
    return changed === null || changed.has(entry.relative);
  });
}

/**
 * Whether a `--path` prefix selects this entry.
 *
 * Both spellings work: `--path src/cli` selects the file `src/cli.ts` (by its
 * module name) and everything under the directory `src/cli/` (by its path).
 * Requiring the caller to know which of the two a name is would be a filter
 * that silently returns nothing half the time.
 */
function matchesPath(entry: MapEntry, prefixes: readonly string[]): boolean {
  return underAnyPath(entry.relative, prefixes) || underAnyPath(entry.module, prefixes);
}

/**
 * Whether a `--symbol` selector names this entry.
 *
 * EXACT, not substring, and case-sensitive — the identifier is the thing the
 * caller already has in hand. Three accepted spellings, in the order an agent
 * tends to know them: the fully qualified `src/analysis/sourceFile#parsedSources`
 * (which is also the key `.kragg/criticality.json` uses), the in-module
 * `Client.send`, and the bare member name `send`. A bare name that two modules
 * share returns both, which is a useful answer rather than a wrong one — the
 * `#` form is there for when it is not.
 */
function matchesSymbol(entry: MapEntry, selectors: readonly string[]): boolean {
  const qualname = entry.symbol.qualname;
  const last = qualname.slice(qualname.lastIndexOf(".") + 1);
  return selectors.some((selector) =>
    selector.includes("#")
      ? `${entry.module}#${qualname}` === selector
      : qualname === selector || last === selector,
  );
}

/** Distinct modules represented by a selection, for the count header. */
export function moduleCount(entries: readonly MapEntry[]): number {
  return new Set(entries.map((entry) => entry.module)).size;
}

/**
 * The text render: count header, module headings, symbol lines, budget note.
 *
 * The header counts the whole SELECTION and the note says how much of it was
 * printed, so the two together can never be read as "this is all there is".
 */
export function renderMapText(budget: Budgeted<MapEntry>, modules: number): string[] {
  const lines = [`map: ${budget.total} exported symbols across ${modules} modules`];
  let current: string | null = null;
  for (const entry of budget.entries) {
    if (entry.module !== current) {
      lines.push(entry.module);
      current = entry.module;
    }
    lines.push(symbolLine(entry));
  }
  const note = truncationNote(budget, "exported symbols");
  if (note !== null) {
    lines.push(note);
  }
  return lines;
}

/**
 * The structured render.
 *
 * `total`, `shown` and `truncated` sit beside the entries rather than being
 * inferable from them: a consumer that reads only `entries` still has to see
 * `truncated` to believe it has everything.
 */
export function renderMapJson(budget: Budgeted<MapEntry>, modules: number): string {
  return inventoryJson({
    command: "map",
    total: budget.total,
    shown: budget.shown,
    truncated: budget.truncated,
    modules,
    entries: budget.entries.map((entry) => ({
      module: entry.module,
      file: entry.relative,
      kind: entry.symbol.kind,
      name: entry.symbol.qualname,
      signature: entry.symbol.signature,
      doc: entry.symbol.doc,
      risk: entry.risk,
    })),
  });
}

/** Render the complete inventory, unbudgeted — what `--write` persists. */
export function renderFullMap(entries: readonly MapEntry[]): string[] {
  return entries.length === 0
    ? []
    : renderMapText(applyBudget(entries, 0), moduleCount(entries));
}

/**
 * One symbol line.
 *
 * Methods are indented one level deeper than their class so the containment
 * is visible without repeating the class name in a heading. Everything else
 * sits at one level under the module.
 */
function symbolLine(entry: MapEntry): string {
  const indent = entry.symbol.kind === "method" ? "    " : "  ";
  const suffix = entry.risk === null ? "" : `  [${entry.risk}]`;
  const doc = entry.symbol.doc === null ? "" : ` — ${entry.symbol.doc}`;
  return `${indent}${entry.symbol.signature}${doc}${suffix}`;
}

/** Path first, then qualified name; plain comparisons, so no locale gets a vote. */
function byPathThenName(left: MapEntry, right: MapEntry): number {
  if (left.relative !== right.relative) {
    return left.relative < right.relative ? -1 : 1;
  }
  const leftName = left.symbol.qualname;
  const rightName = right.symbol.qualname;
  if (leftName === rightName) {
    return 0;
  }
  return leftName < rightName ? -1 : 1;
}
