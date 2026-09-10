/**
 * `kragg map` — the inventory an agent reads before it writes anything.
 *
 * The port of `kragg/src/kragg/mapping.py` and its `cmd_map`. The premise is
 * stated in the Python module's own docstring and in kragg's README: AGENTS
 * REINVENT WHAT THEY CANNOT SEE. A session that cannot cheaply discover
 * `resolveTypeScript` writes a second, worse one. So the map is injected at
 * session start, and its entire design constraint is that it must be worth
 * the tokens it displaces — a few hundred lines that prevent a re-implementation,
 * not a directory listing.
 *
 * ── WHAT IS ON A LINE, AND WHY ─────────────────────────────────────────────
 *     src/analysis/sourceFile
 *       fn resolveTypeScript(root: string): CompilerResolution — Resolve the…  [HIGH]
 *
 * Module heading, then one indented line per exported symbol: signature, a
 * 60-character doc excerpt (`MAX_DOC_CHARS`, copied from Python) and a risk
 * flag when `.kragg/criticality.json` marks the symbol critical. The flag is
 * the load-bearing part — it tells an agent which of these it must not edit
 * casually, which is information no amount of reading the file would give it.
 *
 * ── DIVERGENCES FROM `mapping.py` ──────────────────────────────────────────
 *  - PUBLIC MEANS EXPORTED, not "no leading underscore". See `map/symbols.ts`.
 *  - Types are first-class entries. `interface`, `type` and `enum` have no
 *    Python equivalent, and in a TypeScript codebase they are frequently the
 *    thing being reinvented — two hand-rolled `CoverageEntry` shapes is a real
 *    failure mode that Python's map could not have prevented and this one can.
 *  - A COUNT HEADER is printed first. Python emits only the lines. One line
 *    that says how much of the map there is lets an agent judge whether it has
 *    the whole surface or a truncated view, which matters precisely because
 *    this text arrives through a context-window budget.
 *  - `.d.ts` files are walked (`includeDeclarations`), because in TypeScript a
 *    declaration file IS public surface. Python has no such category.
 *  - ORDER IS (PATH, THEN NAME), not source order, and the inventory can be
 *    FILTERED and BUDGETED — see `map/select.ts` and `commands/inventory.ts`.
 *
 * ── WHAT A FILTER MAY AND MAY NOT NARROW ───────────────────────────────────
 * `--path`, `--symbol`, `--changed` and `--limit` decide what is PRINTED and
 * nothing else. The criticality graph is still derived over the whole project
 * (`ensure()` below, with the policy's paths, never the caller's), so the risk
 * flags on a one-directory map are the same flags the check pipeline would
 * compute, and no gate can be made quieter by asking for a smaller map.
 *
 * `.kragg/map.md` is held to a stricter rule still. `--limit` only trims the
 * terminal; the file is always the complete inventory. The content filters
 * are refused outright alongside `--write` — same reasoning as
 * `criticality --write --path`: the file is injected at session start as THE
 * inventory, so a scoped one does not read as "part of the map", it reads as
 * "nothing else exists", and the agent reinvents what was filtered out.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { analysisProgram } from "../analysis/program.ts";
import { resolveTypeScript, type TypeScriptApi } from "../analysis/sourceFile.ts";
import { projectTsconfig } from "../environment/project.ts";
import { criticalityCache } from "../catalog/criticalityCache.ts";
import { EXIT_ENVIRONMENT, EXIT_OK, EXIT_USAGE } from "../engine/report.ts";
import { readJson } from "../gates/criticality.ts";
import { loadPolicy, PolicyError, type KraggPolicy } from "../policy/policy.ts";
import {
  applyBudget,
  changedSet,
  CHANGED_UNAVAILABLE,
  DEFAULT_LIMIT,
  isFiltered,
  type InventoryFormat,
  type InventoryOptions,
} from "./inventory.ts";
import {
  mapEntries,
  moduleCount,
  renderFullMap,
  renderMapJson,
  renderMapText,
  selectMapEntries,
  type MapEntry,
} from "./map/select.ts";

/** Where `--write` puts the map, matching `cmd_map`'s `.kragg/map.md`. */
export const MAP_RELATIVE = join(".kragg", "map.md");

/** What `runMap` needs. Everything is optional so the CLI can pass a subset. */
export interface MapOptions {
  /** Project root. Defaults to the current working directory. */
  readonly root?: string | undefined;
  /** Also write `.kragg/map.md`, as `kragg map --write` does. */
  readonly write?: boolean | undefined;
  /** Pre-loaded policy. Loaded from the root when absent. */
  readonly policy?: KraggPolicy | undefined;
  /** Compiler to parse with. Defaults to the project's own. */
  readonly api?: TypeScriptApi | undefined;
  /** `--path`: file or directory prefixes to print. Empty prints all. */
  readonly paths?: readonly string[] | undefined;
  /** `--symbol`: exported names or `<module>#<name>`. Empty prints all. */
  readonly symbols?: readonly string[] | undefined;
  /** `--changed`: print only symbols in files changed against `HEAD`. */
  readonly changed?: boolean | undefined;
  /** `--limit`: entries to print. `0` is the full export. */
  readonly limit?: number | undefined;
  /** `--format`. Defaults to `text`. */
  readonly format?: InventoryFormat | undefined;
}

/**
 * Render the map to stdout, optionally persisting it.
 *
 * Returns `0` always except on a malformed `kragg.json`, which is a usage
 * error and not this command's to interpret. `map` is a REPORT: it never
 * fails a build, and an empty map is a fact about the repo, not an error.
 *
 * ── WHY THIS DERIVES CRITICALITY DATA ──────────────────────────────────────
 * The risk flags are the load-bearing half of the map, and `readJson` refuses
 * data that no longer describes the tree (`gates/criticality/freshness.ts`).
 * Any edit invalidates the stamp — which, in an agent's inner loop, is every
 * run — so a map that only READ the file would have quietly dropped every flag
 * from the moment the session's first edit landed, and said nothing about it.
 * That is the same silent-wrong-answer the freshness work exists to kill, one
 * layer out. So `map` derives, through the SAME `ensure()` the check pipeline
 * uses: two answers to "what is critical" is one too many.
 *
 * IT STAYS LAZY. `ensure()` checks freshness first and returns before it
 * touches the analysis handle, and the handle builds its `ts.Program` only on
 * `load()`. A `kragg map` on a repo whose data is already current therefore
 * compiles nothing — it costs one `readdirSync` pass more than it used to.
 * `analysisProgram` is also where the compiler now comes from, so the map is
 * parsed with the same compiler any derivation would have used.
 */
export async function runMap(options: MapOptions = {}): Promise<number> {
  const root = options.root ?? process.cwd();
  let policy: KraggPolicy;
  try {
    policy = options.policy ?? loadPolicy(root);
  } catch (error) {
    if (error instanceof PolicyError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }
  return mapReport(root, policy, options);
}

/**
 * The command proper, once the policy is known.
 *
 * Split from {@link runMap} so the policy's failure mode — the one thing here
 * that is a usage error rather than a report — stays a two-line function and
 * this one stays under the complexity budget the repo enforces on itself.
 */
async function mapReport(
  root: string,
  policy: KraggPolicy,
  options: MapOptions,
): Promise<number> {
  const view = mapView(options);
  const write = options.write === true;
  if (write && isFiltered(view)) {
    process.stderr.write(`${scopedWriteRefusal()}\n`);
    return EXIT_USAGE;
  }
  const analysis = analysisProgram({
    root,
    tsconfigPath: projectTsconfig(root, policy.tsconfig),
    ...(options.api === undefined ? {} : { api: options.api }),
  });
  criticalityCache({
    root,
    // Sources AND tests, matching `catalogContext`: both are in the program,
    // so both contribute call-graph nodes and either can change the answer.
    // NOT the caller's `--path`: a display filter must never narrow what the
    // gates are told is critical.
    scanPaths: [...policy.sourcePaths, ...policy.testPaths],
    analysis,
  }).ensure();
  const changed = view.changed ? await changedSet(root, policy.sourcePaths) : null;
  if (view.changed && changed === null) {
    process.stderr.write(`${CHANGED_UNAVAILABLE}\n`);
    return EXIT_ENVIRONMENT;
  }
  const all = mapEntries(root, policy, analysis.compiler.api, criticalityFlags(root));
  printMap(all, view, changed);
  if (write && all.length > 0) {
    persistMap(root, all, view.format);
  }
  return EXIT_OK;
}

/**
 * Write `.kragg/map.md` and announce it.
 *
 * The FULL inventory, not the printed window: this file is what a session
 * start reads, and a budget is a property of a terminal. The notice goes to
 * stderr under `--format json`, because a machine reading that stream must
 * not have to strip a sentence off the end of the document.
 */
function persistMap(
  root: string,
  all: readonly MapEntry[],
  format: InventoryFormat,
): void {
  const output = join(root, MAP_RELATIVE);
  writeMap(renderFullMap(all), output);
  const stream = format === "json" ? process.stderr : process.stdout;
  stream.write(`Wrote ${output}\n`);
}

/** Resolve the filters and budget, defaulting everything the caller omitted. */
function mapView(options: MapOptions): InventoryOptions {
  return {
    paths: options.paths ?? [],
    symbols: options.symbols ?? [],
    changed: options.changed === true,
    limit: options.limit ?? DEFAULT_LIMIT,
    format: options.format ?? "text",
  };
}

/**
 * Print the selection in the requested format.
 *
 * The two empty cases stay distinguishable, because they call for different
 * actions: a repository with no exports at all, and a filter that matched
 * none of the exports there are. Both are exit 0 — `map` is a report, and an
 * empty answer is a fact about the selection, not a failure.
 */
function printMap(
  all: readonly MapEntry[],
  view: InventoryOptions,
  changed: ReadonlySet<string> | null,
): void {
  const selection = selectMapEntries(all, view, changed);
  const budget = applyBudget(selection, view.limit);
  const modules = moduleCount(selection);
  if (view.format === "json") {
    process.stdout.write(renderMapJson(budget, modules));
    return;
  }
  if (all.length === 0) {
    process.stdout.write("no exported symbols found\n");
    return;
  }
  if (selection.length === 0) {
    process.stdout.write("no symbols match the selection\n");
    return;
  }
  process.stdout.write(`${renderMapText(budget, modules).join("\n")}\n`);
}

/**
 * Why `--write` refuses `--path`, `--symbol` and `--changed`.
 *
 * The same fail-closed rule as `criticality --write --path`. `.kragg/map.md`
 * is injected at session start as the inventory of what exists, so a file
 * holding one directory does not read as "a scoped map" — it reads as the
 * whole surface, and the agent confidently reinvents everything that was
 * filtered out. `--limit` is deliberately NOT in this list: it trims the
 * terminal only, and the written file stays complete.
 */
function scopedWriteRefusal(): string {
  return (
    "--write cannot be combined with --path, --symbol or --changed: " +
    ".kragg/map.md is the whole project's inventory, and a scoped one would " +
    "read as `nothing else exists` to the session that loads it. Drop --write " +
    "for the scoped view, or the filters to write the full map. (--limit is " +
    "fine: it trims the terminal, never the file.)"
  );
}

/**
 * Build the map lines: a module heading followed by its indented symbols.
 *
 * The complete, unbudgeted inventory — the same text `--write` persists.
 * Modules contributing no exported symbol are omitted entirely — a heading
 * with nothing under it costs tokens to say "this file exists", which the
 * agent could have learned from `ls`.
 */
export function buildMap(
  root: string,
  policy: KraggPolicy,
  api?: TypeScriptApi | undefined,
): string[] {
  const compiler = api ?? resolveTypeScript(root).api;
  return renderFullMap(mapEntries(root, policy, compiler, criticalityFlags(root)));
}

/** Write the map where hooks and session-start injection read it. */
export function writeMap(lines: readonly string[], outputPath: string): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
}

/**
 * Critical symbol name -> risk label, read from `.kragg/criticality.json`.
 *
 * Keys are the full node names `gates/criticality.ts` writes
 * (`src/engine/gate#Pipeline.run`), so the lookup is exact rather than a
 * name match — two modules with a `run` do not contaminate each other, which
 * is a real limitation of the Python version's dotted qualnames in a repo
 * with parallel package trees.
 *
 * An absent or malformed file yields no flags and no error: a repo that has
 * never run `kragg criticality --write` still gets a useful map.
 */
export function criticalityFlags(root: string): ReadonlyMap<string, string> {
  const flags = new Map<string, string>();
  for (const record of readJson(root)) {
    if (record["is_critical"] !== true) {
      continue;
    }
    const name = record["name"];
    if (typeof name !== "string" || name === "") {
      continue;
    }
    const risk = record["risk"];
    flags.set(name, typeof risk === "string" && risk !== "" ? risk : "MED");
  }
  return flags;
}
