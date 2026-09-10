/**
 * Structural budgets: file length and public symbols per module.
 *
 * God-files mechanically cannot accumulate when both are capped. Flat or
 * generated files that legitimately exceed the budgets can be exempted with
 * `structureExclude` (repo-root-relative fnmatch patterns); exempted files
 * skip both budgets but remain subject to every other gate, so the cap stays
 * meaningful repo-wide.
 *
 * THE SYMBOL BUDGET COUNTS `export *`. It did not always, and the gap was
 * exploitable: a module could hold its declarations in a sibling file and
 * write `export * from "./sibling.ts"`, keeping its counted surface at one
 * while its real surface was whatever the sibling declared. `starExports.ts`
 * resolves the star and counts the names it forwards; the four rules that make
 * that correct (namespace stars, `default`, duplicates, cycles) are documented
 * there.
 *
 * A star that CANNOT be resolved is its own finding, `symbol-budget-unresolved`
 * — see `unresolvedStars` below for why that is a violation rather than a
 * shrug.
 */

import { resolve } from "node:path";

import { parsedSources, resolveTypeScript } from "../../analysis/sourceFile.ts";
import type { ParsedSource, TypeScriptApi } from "../../analysis/sourceFile.ts";
import type { Violation } from "../../engine/models.ts";
import { projectTsconfig } from "../../environment/project.ts";
import { matchesAny } from "../../util/globs.ts";
import { loadAliases } from "./aliases.ts";
import type { ResolveContext } from "./resolve.ts";
import { exportSurface } from "./starExports.ts";
import type { ExportSurface } from "./starExports.ts";

/**
 * Return violations for files exceeding structural budgets.
 *
 * Files whose repo-root-relative POSIX path matches an `exclude` pattern
 * (fnmatch, case-sensitive, `*` spans `/`) skip both the file- and
 * symbol-budget checks — but remain subject to every other gate, so the cap
 * stays meaningful repo-wide.
 */
export function checkStructure(
  root: string,
  sourcePaths: readonly string[],
  maxFileLines: number,
  maxPublicSymbols: number,
  exclude: readonly string[] = [],
  tsconfig?: string,
): readonly Violation[] {
  const absoluteRoot = resolve(root);
  const api = resolveTypeScript(absoluteRoot).api;
  const context = starContext(absoluteRoot, api, projectTsconfig(absoluteRoot, tsconfig));
  const violations: Violation[] = [];

  for (const source of parsedSources(absoluteRoot, sourcePaths, { api })) {
    if (matchesAny(source.relative, exclude)) {
      continue;
    }
    // Python counts `text.count("\n") + 1`; `lines` is that same split, so the
    // two implementations agree on every file including the empty one.
    const lines = source.lines.length;
    if (lines > maxFileLines) {
      violations.push({
        message: `file has ${lines} lines (max ${maxFileLines})`,
        file: source.relative,
        code: "file-budget",
        fixHint: "split into smaller modules with single concerns",
      });
    }
    const surface = exportSurface(source, context);
    if (surface.names.size > maxPublicSymbols) {
      violations.push(overBudget(source, surface, maxPublicSymbols));
    }
    const unresolved = unresolvedStars(source, surface);
    if (unresolved !== null) {
      violations.push(unresolved);
    }
  }
  return violations;
}

/**
 * The resolution context star expansion runs in.
 *
 * `layers: []` because the symbol budget has no layer opinion — it needs
 * `resolveTarget` only for the specifier-to-file arithmetic, which is why the
 * `paths`/`baseUrl` table is loaded: a barrel written as
 * `export * from "@/util"` must be countable too. One context per run, so its
 * parse cache spans the whole walk. The table is the SELECTED tsconfig's.
 */
function starContext(root: string, api: TypeScriptApi, tsconfig: string): ResolveContext {
  return {
    root,
    api,
    layers: [],
    aliases: loadAliases(tsconfig, api),
    parsed: new Map(),
    seen: new Set(),
  };
}

/**
 * The budget violation, phrased so a lower bound never reads as an exact count.
 *
 * With an unresolvable star in the file the surface is "at least" N — saying
 * plain "N" would be a precise-sounding claim the gate cannot make.
 */
function overBudget(
  source: ParsedSource,
  surface: ExportSurface,
  maxPublicSymbols: number,
): Violation {
  const count = surface.names.size;
  const bound = surface.opaque.length > 0 ? "at least " : "";
  return {
    message: `module exposes ${bound}${count} public symbols (max ${maxPublicSymbols})`,
    file: source.relative,
    code: "symbol-budget",
    fixHint: "split the module or prefix internals with underscores",
  };
}

/**
 * An `export *` whose names could not be counted.
 *
 * REPORTED, NOT SHRUGGED OFF. The old behaviour — count it as zero — is what
 * made the budget gameable in the first place, and "we could not count it"
 * must never render as "it contributed nothing". This follows the same
 * fail-loud rule as `layer-unresolved` in the sibling gate: an unverifiable
 * surface becomes noise, never silence. Its own code so a project can see the
 * two apart, and the fix hint offers the two honest ways out — name the
 * re-exports explicitly, or take the documented `structureExclude` exemption.
 */
function unresolvedStars(source: ParsedSource, surface: ExportSurface): Violation | null {
  if (surface.opaque.length === 0) {
    return null;
  }
  const listed = [...new Set(surface.opaque)].map((specifier) => `\`${specifier}\``).join(", ");
  return {
    message:
      `\`export *\` from ${listed} could not be enumerated, so this module's ` +
      `public surface is unbounded (counted ${surface.names.size})`,
    file: source.relative,
    code: "symbol-budget-unresolved",
    fixHint:
      "replace the star with an explicit `export { … } from` so the surface is " +
      "countable, or add this file to `structure_exclude` if it is a barrel " +
      "whose surface is deliberately not budgeted",
  };
}
