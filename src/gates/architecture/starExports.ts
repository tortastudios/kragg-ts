/**
 * The COMPLETE public surface of a module — local declarations plus every name
 * a bare `export * from "./other.ts"` forwards.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `exports.ts` counts what a file declares. That is the whole surface right up
 * until someone writes
 *
 *     export * from "./everythingElse.ts";
 *
 * at which point the module's real surface is unbounded and its counted
 * surface is one line long. An agent working in this repo found that hole,
 * used it to slip a module under `maxPublicSymbols`, and disclosed it. The
 * budget was not measuring public API; it was measuring how many `export`
 * keywords happened to be in one file.
 *
 * So the star is resolved and its names are counted. The module is separate
 * from `exports.ts` because enumerating a star means touching the FILESYSTEM —
 * resolving a specifier, parsing another file, guarding cycles — and none of
 * that belongs in the pure syntactic counter that `barrel.ts` also calls.
 *
 * ── FOUR RULES THAT ARE EASY TO GET WRONG ──────────────────────────────────
 *
 * 1. `export * as ns from "./x"` contributes EXACTLY ONE name, `ns`. It binds
 *    a namespace object; the target's members are properties of that object,
 *    not importable names. Counting the target's surface there would be the
 *    same error in the opposite direction. `exports.ts` already handles it, and
 *    this module deliberately does not touch it.
 *
 * 2. A star does NOT forward `default` (or a CommonJS `export =`). That is
 *    ECMAScript, not a simplification: `export * from "./x"` re-exports every
 *    named export of `./x` and never its default. Both are dropped when a
 *    target's surface is merged in.
 *
 * 3. A name that is both re-exported and declared locally counts ONCE. The
 *    surface is a `Set`, so this falls out — but it is the reason it is a Set.
 *
 * 4. CYCLES ARE REAL. `a` stars `b` and `b` stars `a` is legal TypeScript and
 *    appears in real barrel trees. A visited set breaks the loop, and because
 *    the recursion unions, the answer is still exactly `own(a) ∪ own(b)` — the
 *    second visit contributes nothing it has not already contributed. Depth is
 *    capped at `MAX_BARREL_DEPTH`, as in `expandBarrel`.
 *
 * ── UNRESOLVABLE STARS ARE REPORTED, NEVER COUNTED AS ZERO ─────────────────
 * `export * from "some-package"` and `export * from "./deleted.ts"` cannot be
 * enumerated: the first leaves the repo, the second is not there. Silently
 * contributing zero is precisely the bug this module exists to fix, so those
 * specifiers come back in `opaque` and the caller reports them. The surface is
 * then a LOWER BOUND, and every message built from it says so.
 */

import type { ParsedSource } from "../../analysis/sourceFile.ts";
import type { TypeScriptApi } from "../../analysis/sourceFile.ts";
import { exportedNames } from "./exports.ts";
import { MAX_BARREL_DEPTH, parseCached, resolveTarget } from "./resolve.ts";
import type { ResolveContext } from "./resolve.ts";

import type bundledTs from "typescript";

/** Names a bare `export *` never forwards, whatever the target declares. */
const NOT_FORWARDED: ReadonlySet<string> = new Set(["default", "export="]);

/** A module's public surface, and what could not be counted. */
export interface ExportSurface {
  /** Every name an importer could take from this module, `export *` included. */
  readonly names: ReadonlySet<string>;
  /**
   * Specifiers of `export *` statements whose own surface could not be read —
   * a package outside the repo, a target that is not on disk, a file that does
   * not parse, or a chain deeper than `MAX_BARREL_DEPTH`. Non-empty means
   * `names` is a lower bound.
   */
  readonly opaque: readonly string[];
}

/**
 * The full surface of one parsed module.
 *
 * `context.parsed` caches the files this walks, so a hub re-exported by twenty
 * modules is parsed once per run — pass the SAME context across a whole gate
 * run, not a fresh one per file.
 */
export function exportSurface(
  source: ParsedSource,
  context: ResolveContext,
): ExportSurface {
  return walk(source, context, new Set<string>(), 0);
}

function walk(
  source: ParsedSource,
  context: ResolveContext,
  seen: Set<string>,
  depth: number,
): ExportSurface {
  seen.add(source.path);
  const names = new Set(exportedNames(source.sourceFile, context.api));
  const opaque: string[] = [];
  for (const specifier of starSpecifiers(source.sourceFile, context.api)) {
    merge(specifier, source.path, context, seen, depth, names, opaque);
  }
  return { names, opaque };
}

/** Fold one `export * from "spec"` into the surface being built. */
function merge(
  specifier: string,
  fromFile: string,
  context: ResolveContext,
  seen: Set<string>,
  depth: number,
  names: Set<string>,
  opaque: string[],
): void {
  const target = resolveTarget(specifier, fromFile, context);
  const file = target.kind === "module" ? target.file : null;
  if (file === null) {
    // Outside the repo, or alias-shaped and unpinnable. Its names are real and
    // uncountable here; saying so is the whole point.
    opaque.push(specifier);
    return;
  }
  if (seen.has(file)) {
    // A cycle. Everything it forwards has already been unioned in.
    return;
  }
  if (depth + 1 >= MAX_BARREL_DEPTH) {
    opaque.push(specifier);
    return;
  }
  const parsed = parseCached(file, context);
  if (parsed === null) {
    opaque.push(specifier);
    return;
  }
  const inner = walk(parsed, context, seen, depth + 1);
  for (const name of inner.names) {
    if (!NOT_FORWARDED.has(name)) {
      names.add(name);
    }
  }
  opaque.push(...inner.opaque);
}

/**
 * The module specifiers of BARE `export *` statements.
 *
 * `export * as ns from "./x"` and `export { a } from "./x"` are excluded by
 * the `exportClause === undefined` test: both name their own bindings, and
 * `exports.ts` has already counted them.
 */
function starSpecifiers(
  sourceFile: bundledTs.SourceFile,
  api: TypeScriptApi,
): readonly string[] {
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!api.isExportDeclaration(statement) || statement.exportClause !== undefined) {
      continue;
    }
    const moduleSpecifier = statement.moduleSpecifier;
    if (moduleSpecifier !== undefined && api.isStringLiteral(moduleSpecifier)) {
      specifiers.push(moduleSpecifier.text);
    }
  }
  return specifiers;
}
