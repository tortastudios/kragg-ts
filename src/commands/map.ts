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
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { analysisProgram } from "../analysis/program.ts";
import {
  parsedSources,
  resolveTypeScript,
  type TypeScriptApi,
} from "../analysis/sourceFile.ts";
import { criticalityCache } from "../catalog/criticalityCache.ts";
import { EXIT_OK, EXIT_USAGE } from "../engine/report.ts";
import { readJson } from "../gates/criticality.ts";
import { loadPolicy, PolicyError, type KraggPolicy } from "../policy/policy.ts";
import { testScanDirectories } from "../util/testPaths.ts";
import { moduleSymbols, type MapSymbol } from "./map/symbols.ts";

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
  const analysis = analysisProgram({
    root,
    ...(options.api === undefined ? {} : { api: options.api }),
  });
  criticalityCache({
    root,
    // Sources AND tests, matching `catalogContext`: both are in the program,
    // so both contribute call-graph nodes and either can change the answer.
    scanPaths: [...policy.sourcePaths, ...testScanDirectories(policy.testPaths)],
    analysis,
  }).ensure();
  const lines = buildMap(root, policy, analysis.compiler.api);
  if (lines.length === 0) {
    process.stdout.write("no exported symbols found\n");
    return EXIT_OK;
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  if (options.write === true) {
    const output = join(root, MAP_RELATIVE);
    writeMap(lines, output);
    process.stdout.write(`Wrote ${output}\n`);
  }
  return EXIT_OK;
}

/**
 * Build the map lines: a module heading followed by its indented symbols.
 *
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
  const flags = criticalityFlags(root);
  const body: string[] = [];
  let modules = 0;
  let symbols = 0;
  for (const source of parsedSources(root, policy.sourcePaths, {
    api: compiler,
    includeDeclarations: true,
  })) {
    const found = moduleSymbols(source, compiler);
    if (found.length === 0) {
      continue;
    }
    modules += 1;
    symbols += found.length;
    body.push(source.module);
    for (const entry of found) {
      body.push(symbolLine(entry, source.module, flags));
    }
  }
  return body.length === 0 ? [] : [headerLine(symbols, modules), ...body];
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

/* --- Rendering ------------------------------------------------------------ */

function headerLine(symbols: number, modules: number): string {
  return `map: ${symbols} exported symbols across ${modules} modules`;
}

/**
 * One symbol line.
 *
 * Methods are indented one level deeper than their class so the containment
 * is visible without repeating the class name in a heading. Everything else
 * sits at one level under the module.
 */
function symbolLine(
  entry: MapSymbol,
  module: string,
  flags: ReadonlyMap<string, string>,
): string {
  const indent = entry.kind === "method" ? "    " : "  ";
  const risk = flags.get(`${module}#${entry.qualname}`);
  const suffix = risk === undefined ? "" : `  [${risk}]`;
  const doc = entry.doc === null ? "" : ` — ${entry.doc}`;
  return `${indent}${entry.signature}${doc}${suffix}`;
}
