/**
 * The layered import contract: a module in a layer may import its own layer or
 * lower layers, never a higher one.
 *
 * Layers are declared top-to-bottom in the policy's `layers` as module
 * prefixes, e.g. `["src/entrypoints", "src/services", "src/domain"]`. Modules
 * outside every layer are unrestricted. The only translation from Python is
 * the separator: a module name here is `/`-separated (see `moduleName` in
 * `analysis/sourceFile.ts`), not `.`-separated.
 *
 * `import type` IS STILL REPORTED. A type-only import erases at compile time
 * and creates no runtime edge, but a layering contract is about knowledge and
 * coupling, not emitted bytes: a domain module that names an entrypoint's type
 * has learned the entrypoint's shape, and the refactor that breaks one breaks
 * the other. It is a genuinely weaker breach than a runtime one, so it carries
 * its own code, `layer-breach-type`, and a project that wants to weigh the two
 * differently can. Mixed (`import { type A, b }`) counts as a value import —
 * `b` is real.
 */

import { resolve } from "node:path";

import {
  parsedSources,
  resolveTypeScript,
  type ParsedSource,
} from "../../analysis/sourceFile.ts";
import type { Violation } from "../../engine/models.ts";
import { loadAliases } from "./aliases.ts";
import { expandBarrel } from "./barrel.ts";
import { importEdges, type ImportEdge } from "./edges.ts";
import {
  isBarrel,
  layerIndex,
  resolveTarget,
  type ResolveContext,
} from "./resolve.ts";

/** Return one violation per import that crosses layers upward. */
export function checkLayers(
  root: string,
  sourcePaths: readonly string[],
  layers: readonly string[],
): readonly Violation[] {
  if (layers.length < 2) {
    return [];
  }
  const absoluteRoot = resolve(root);
  const api = resolveTypeScript(absoluteRoot).api;
  const context: ResolveContext = {
    root: absoluteRoot,
    api,
    layers,
    aliases: loadAliases(absoluteRoot, api),
    parsed: new Map<string, ParsedSource | null>(),
    seen: new Set<string>(),
  };

  const violations: Violation[] = [];
  for (const source of parsedSources(absoluteRoot, sourcePaths, { api })) {
    const layer = layerIndex(source.module, layers);
    if (layer !== null) {
      checkSource(violations, source, layer, context);
    }
  }
  return violations;
}

/** Every edge one file declares, judged against the layer it sits in. */
function checkSource(
  violations: Violation[],
  source: ParsedSource,
  layer: number,
  context: ResolveContext,
): void {
  const covered = new Set<string>();
  for (const edge of importEdges(source.sourceFile, context.api)) {
    covered.add(edge.specifier);
    const module = collectEdge(violations, source, layer, edge, context);
    if (module !== null) {
      covered.add(module);
    }
  }
  for (const edge of missedEdges(source, covered)) {
    collectEdge(violations, source, layer, edge, context);
  }
}

/**
 * Targets the shared import table knows about that this file's walk did not.
 *
 * FAIL CLOSED. `importEdges` is hand-written and could grow a blind spot; the
 * table in `ParsedSource.imports` is maintained by another module for other
 * gates. Folding it back in means a bug here can cost a line number, but not
 * an unchecked import. Recovered edges are assumed to be value imports, the
 * stricter reading, and in a correct run this yields nothing.
 */
function missedEdges(
  source: ParsedSource,
  covered: ReadonlySet<string>,
): readonly ImportEdge[] {
  const missed: ImportEdge[] = [];
  const seen = new Set<string>();
  for (const value of source.imports.values()) {
    const hash = value.lastIndexOf("#");
    const target = hash === -1 ? value : value.slice(0, hash);
    if (target === "" || covered.has(target) || seen.has(target)) {
      continue;
    }
    seen.add(target);
    missed.push({
      specifier: target,
      names: "all",
      typeOnly: false,
      line: undefined,
      reExport: false,
    });
  }
  return missed;
}

/**
 * Append every violation this one edge produces, barrel chain included, and
 * return the module the specifier resolved to so the caller can tell which
 * table entries the walk already covered.
 */
function collectEdge(
  violations: Violation[],
  source: ParsedSource,
  layer: number,
  edge: ImportEdge,
  context: ResolveContext,
): string | null {
  const target = resolveTarget(edge.specifier, source.path, context);
  if (target.kind === "external") {
    return null;
  }
  if (target.kind === "unresolved") {
    violations.push(unresolvedViolation(source, edge, target.detail));
    return null;
  }

  breachFor(violations, source, layer, edge, target.module, null, context);
  if (target.file === null || !isBarrel(target.file)) {
    return target.module;
  }
  for (const reached of expandBarrel(target.file, edge.names, context, new Set(), 0)) {
    breachFor(
      violations,
      source,
      layer,
      { ...edge, typeOnly: edge.typeOnly || reached.typeOnly },
      reached.module,
      target.module,
      context,
    );
  }
  return target.module;
}

/** An alias-shaped specifier nothing could pin down: an UNCHECKED import. */
function unresolvedViolation(
  source: ParsedSource,
  edge: ImportEdge,
  detail: string,
): Violation {
  return {
    message:
      `cannot resolve import \`${edge.specifier}\` to a module ` +
      `(${detail}); the layer contract was NOT checked for it`,
    file: source.relative,
    line: edge.line,
    code: "layer-unresolved",
    fixHint:
      "point the alias at one location in tsconfig `paths`, or import by a " +
      "resolvable specifier; an unresolved import is an unchecked import",
  };
}

/** Record the breach if this target really is in a higher layer. */
function breachFor(
  violations: Violation[],
  source: ParsedSource,
  layer: number,
  edge: ImportEdge,
  target: string,
  via: string | null,
  context: ResolveContext,
): void {
  const targetLayer = layerIndex(target, context.layers);
  if (targetLayer === null || targetLayer >= layer) {
    return;
  }
  const message =
    `${source.module} (layer \`${context.layers[layer]}\`) imports ` +
    `${target} (layer \`${context.layers[targetLayer]}\`)` +
    (via === null ? "" : ` via barrel ${via}`) +
    (edge.typeOnly ? " (type-only)" : "");
  const key = `${source.relative} ${message}`;
  if (context.seen.has(key)) {
    return;
  }
  context.seen.add(key);
  violations.push({
    message,
    file: source.relative,
    line: edge.line,
    code: edge.typeOnly ? "layer-breach-type" : "layer-breach",
    fixHint:
      "lower layers must not import higher layers; " +
      "invert the dependency or move the shared code down",
  });
}
