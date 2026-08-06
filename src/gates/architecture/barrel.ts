/**
 * Following a barrel's re-exports to the modules that actually own the names.
 *
 * BARREL FILES ARE THE SECOND PROBLEM TYPESCRIPT HAS AND PYTHON DOES NOT.
 * `import { x } from "@/services"` reaches `src/services/index.ts`, which
 * re-exports from elsewhere. Prefix matching sees `src/services`, is
 * satisfied, and misses that `x` actually lives in a higher layer.
 *
 * AIRTIGHT? No. It is real chain-following, not a warning, but it is bounded:
 * only index-named files are treated as barrels, recursion stops at
 * `MAX_BARREL_DEPTH`, a re-export target that itself fails to resolve is
 * dropped rather than reported, and `export =` / CommonJS re-export shapes are
 * not followed. Note also that most of this hole is closed by the plain gate
 * anyway — a barrel that lives inside a layer commits the breach in its own
 * file and is caught when that file is scanned. Expansion matters for barrels
 * OUTSIDE every layer (a root `src/index.ts`) or outside `sourcePaths`, which
 * are exactly the ones nothing else looks at.
 */

import { exportSurface } from "./starExports.ts";
import { importEdges, type EdgeNames, type ImportEdge, type NameLink } from "./edges.ts";
import {
  isBarrel,
  parseCached,
  resolveTarget,
  MAX_BARREL_DEPTH,
  type ModuleTarget,
  type ResolveContext,
} from "./resolve.ts";

/** One module reached through a barrel, and whether the whole chain erased. */
export interface ReachedTarget {
  readonly module: string;
  readonly typeOnly: boolean;
}

/**
 * Follow a barrel's re-exports to the modules that actually own the names.
 *
 * Name-aware: with `wanted` narrowed to specific names, only the re-exports
 * that could supply one of them are followed, so a barrel re-exporting a
 * higher layer does not implicate every importer of that barrel — only the
 * ones that actually take a symbol from up there. `export * from "./z"` is
 * narrowed by parsing `./z` and intersecting its real export list. With
 * `wanted === "all"` (a namespace, default or side-effect import) everything
 * is followed, which is correct: those forms genuinely depend on the whole
 * module.
 *
 * `seen` breaks re-export cycles; `depth` bounds a pathological chain. Both
 * failure modes end the walk quietly — an under-report at depth 9 is
 * acceptable where an infinite loop is not.
 */
export function expandBarrel(
  file: string,
  wanted: EdgeNames,
  context: ResolveContext,
  seen: Set<string>,
  depth: number,
): readonly ReachedTarget[] {
  if (depth >= MAX_BARREL_DEPTH || seen.has(file)) {
    return [];
  }
  seen.add(file);
  const barrel = parseCached(file, context);
  if (barrel === null) {
    return [];
  }
  const wantedNames = wanted === "all" ? null : new Set(wanted.map((link) => link.there));

  const reached: ReachedTarget[] = [];
  for (const edge of importEdges(barrel.sourceFile, context.api)) {
    reached.push(...reachedThrough(edge, wantedNames, barrel.path, context, seen, depth));
  }
  return reached;
}

/** The modules one of a barrel's re-export statements leads to. */
function reachedThrough(
  edge: ImportEdge,
  wantedNames: ReadonlySet<string> | null,
  fromFile: string,
  context: ResolveContext,
  seen: Set<string>,
  depth: number,
): readonly ReachedTarget[] {
  if (!edge.reExport) {
    return [];
  }
  const target = resolveTarget(edge.specifier, fromFile, context);
  if (target.kind !== "module") {
    return [];
  }
  const forwarded = forwardedNames(edge, wantedNames, target, context);
  if (forwarded === null) {
    return [];
  }
  const reached: ReachedTarget[] = [{ module: target.module, typeOnly: edge.typeOnly }];
  if (target.file !== null && isBarrel(target.file)) {
    for (const deeper of expandBarrel(target.file, forwarded, context, seen, depth + 1)) {
      reached.push({ module: deeper.module, typeOnly: edge.typeOnly || deeper.typeOnly });
    }
  }
  return reached;
}

/**
 * Which names to keep chasing through this re-export, or `null` to stop.
 *
 * `null` means "this re-export cannot supply anything the importer asked
 * for", which is the whole reason the expansion does not over-report.
 */
function forwardedNames(
  edge: ImportEdge,
  wantedNames: ReadonlySet<string> | null,
  target: ModuleTarget,
  context: ResolveContext,
): EdgeNames | null {
  if (wantedNames === null) {
    return edge.names;
  }
  if (edge.names !== "all") {
    const matched = edge.names.filter((link) => wantedNames.has(link.here));
    return matched.length === 0 ? null : matched;
  }
  // `export * from "./z"`: only follow it if `./z` really exports one of the
  // wanted names. Without this the star would implicate every importer of the
  // barrel, which is the false positive that makes a gate get switched off.
  return starNames(wantedNames, target, context);
}

/**
 * The wanted names that `export * from "./z"` really forwards.
 *
 * `exportSurface`, not `exportedNames`: `./z` may itself be a star re-export,
 * and stopping at its own declarations would miss a name it forwards from one
 * more file down — a false NEGATIVE in a layer contract, which is the
 * direction this gate cares about.
 */
function starNames(
  wantedNames: ReadonlySet<string>,
  target: ModuleTarget,
  context: ResolveContext,
): EdgeNames | null {
  if (target.file === null) {
    return null;
  }
  const parsed = parseCached(target.file, context);
  if (parsed === null) {
    return null;
  }
  const exported = exportSurface(parsed, context).names;
  const matched = [...wantedNames]
    .filter((name) => exported.has(name))
    .map((name): NameLink => ({ here: name, there: name }));
  return matched.length === 0 ? null : matched;
}
