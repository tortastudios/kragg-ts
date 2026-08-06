/**
 * Turning an import specifier into something the layer rule can judge.
 *
 * FAILING LOUD IS THE POINT. An alias-shaped specifier whose substitutions
 * cannot be pinned to a file, and whose candidates disagree about which layer
 * they land in, is reported as `layer-unresolved` rather than being silently
 * treated as unrestricted. A false pass is the failure mode that matters here,
 * so ambiguity becomes noise, never silence.
 */

import { dirname, resolve } from "node:path";

import {
  moduleName,
  parseSourceFile,
  type ParsedSource,
  type TypeScriptApi,
} from "../../analysis/sourceFile.ts";
import { existingFile, matchAlias, type AliasConfig } from "./aliases.ts";

/** How deep a chain of barrels re-exporting barrels is followed. */
export const MAX_BARREL_DEPTH = 8;

/** A specifier pinned to a module inside the repo. */
export interface ModuleTarget {
  readonly kind: "module";
  readonly module: string;
  /** The file it resolves to, or `null` when nothing on disk confirms it. */
  readonly file: string | null;
}

/** A specifier resolved to something the layer rule can be applied to. */
export type Target =
  | ModuleTarget
  /** A package, a Node builtin, or anything else outside the repo: unrestricted. */
  | { readonly kind: "external" }
  /** Alias-shaped but unpinnable, and the candidates disagree about the layer. */
  | { readonly kind: "unresolved"; readonly detail: string };

export interface ResolveContext {
  readonly root: string;
  readonly api: TypeScriptApi;
  readonly layers: readonly string[];
  readonly aliases: AliasConfig;
  /** Barrel files parsed during expansion, so a hub is parsed once per run. */
  readonly parsed: Map<string, ParsedSource | null>;
  /** Breach keys already reported, so a chain reaching one module twice reports once. */
  readonly seen: Set<string>;
}

/** Where the layer index of a module comes from. `/` replaces Python's `.`. */
export function layerIndex(module: string, layers: readonly string[]): number | null {
  for (const [index, layer] of layers.entries()) {
    if (module === layer || module.startsWith(`${layer}/`)) {
      return index;
    }
  }
  return null;
}

/**
 * Turn an import specifier into a target the layer rule can judge.
 *
 * The order below is the compiler's, narrowed to what a layer contract needs:
 * relative paths first (pure arithmetic, always confident), then `paths`
 * aliases, then `baseUrl`, then a last-resort check against the declared
 * layers themselves.
 *
 * That last step is deliberate and worth naming: a bare specifier that is
 * itself prefixed by a declared layer (`import ... from "src/services/x"`) is
 * treated as that module even when nothing on disk confirms it. The risk is a
 * published package whose name collides with a layer prefix, which is
 * vanishingly unlikely; the alternative is missing every breach in a project
 * that resolves through a bundler config kragg cannot read.
 */
export function resolveTarget(
  specifier: string,
  fromFile: string,
  context: ResolveContext,
): Target {
  if (specifier.startsWith(".")) {
    const absolute = resolve(dirname(fromFile), specifier);
    return {
      kind: "module",
      module: moduleName(absolute, context.root),
      file: existingFile(absolute),
    };
  }
  const aliased = resolveAlias(specifier, context);
  if (aliased !== null) {
    return aliased;
  }
  const baseUrl = context.aliases.baseUrl;
  if (baseUrl !== null) {
    const candidate = resolve(baseUrl, specifier);
    const file = existingFile(candidate);
    if (file !== null) {
      return { kind: "module", module: moduleName(file, context.root), file };
    }
  }
  if (layerIndex(specifier, context.layers) !== null) {
    return { kind: "module", module: specifier, file: null };
  }
  return { kind: "external" };
}

/**
 * Apply `tsconfig.json` `paths`, or `null` when no pattern matches.
 *
 * When no substitution exists on disk the candidates are compared by LAYER,
 * not by path: several substitutions that all land in the same layer (or all
 * land outside every layer) are unambiguous for this gate's purpose, so the
 * first is used. Only genuine disagreement becomes `unresolved`, which keeps
 * the fail-loud path rare enough that people read it.
 */
function resolveAlias(specifier: string, context: ResolveContext): Target | null {
  const pattern = matchAlias(specifier, context.aliases.patterns);
  if (pattern === null) {
    return null;
  }
  const star = pattern.wildcard
    ? specifier.slice(pattern.prefix.length, specifier.length - pattern.suffix.length)
    : "";
  const candidates = pattern.substitutions.map((substitution) =>
    resolve(context.aliases.base, substitution.replace("*", star)),
  );
  for (const candidate of candidates) {
    const file = existingFile(candidate);
    if (file !== null) {
      return { kind: "module", module: moduleName(file, context.root), file };
    }
  }
  return unpinnedAlias(pattern.literal, candidates, context);
}

/** No substitution exists on disk: judge the candidates by layer instead. */
function unpinnedAlias(
  literal: string,
  candidates: readonly string[],
  context: ResolveContext,
): Target {
  const modules = candidates.map((candidate) => moduleName(candidate, context.root));
  const first = modules[0];
  if (first === undefined) {
    return { kind: "unresolved", detail: `alias \`${literal}\` has no substitutions` };
  }
  const layer = layerIndex(first, context.layers);
  if (modules.every((module) => layerIndex(module, context.layers) === layer)) {
    return { kind: "module", module: first, file: null };
  }
  return {
    kind: "unresolved",
    detail:
      `alias \`${literal}\` maps to ${modules.join(", ")}, ` +
      "none of which exist on disk, and they are in different layers",
  };
}

/** Parse a file once per run, remembering the failures too. */
export function parseCached(file: string, context: ResolveContext): ParsedSource | null {
  const cached = context.parsed.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const parsed = parseSourceFile(file, context.root, context.api);
  context.parsed.set(file, parsed);
  return parsed;
}

/** Only index-named files are treated as re-export hubs. */
export function isBarrel(file: string): boolean {
  return /(^|[/\\])index\.(d\.)?[cm]?[jt]sx?$/.test(file);
}
