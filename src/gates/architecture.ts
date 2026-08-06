/**
 * Architecture gates: layered import contracts and structural budgets.
 *
 * Ported from `kragg/src/kragg/gates/architecture.py`.
 *
 * Layers are declared top-to-bottom in the policy's `layers` as module
 * prefixes, e.g. `["src/entrypoints", "src/services", "src/domain"]`. A module
 * in a layer may import its own layer or lower layers, never a higher one.
 * Modules outside every layer are unrestricted. The only translation from
 * Python is the separator: a module name here is `/`-separated (see
 * `moduleName` in `analysis/sourceFile.ts`), not `.`-separated.
 *
 * Structural budgets cap file length and public symbols per module so
 * god-files mechanically cannot accumulate. Flat or generated files that
 * legitimately exceed the budgets can be exempted with `structureExclude`
 * (repo-root-relative fnmatch patterns); exempted files skip both budgets
 * but remain subject to every other gate, so the cap stays meaningful
 * repo-wide.
 *
 * ---------------------------------------------------------------------------
 * THREE PROBLEMS TYPESCRIPT HAS AND PYTHON DOES NOT
 * ---------------------------------------------------------------------------
 *
 * 1. PATH ALIASES. A Python import specifier IS the module name, so a prefix
 *    match is exact. A TypeScript specifier is whatever `tsconfig.json`
 *    `paths`/`baseUrl` says it is: `@/services/foo` is `src/services/foo`, and
 *    a prefix match on the raw text sees neither layer. `resolveTarget` reads
 *    the project's tsconfig (through the compiler, so `extends` is honoured)
 *    and substitutes aliases before layer matching.
 *
 *    AIRTIGHT? No — best-effort, but it FAILS LOUD. An alias-shaped specifier
 *    whose substitutions cannot be pinned to a file, and whose candidates
 *    disagree about which layer they land in, is reported as `layer-unresolved`
 *    rather than being silently treated as unrestricted. A false pass is the
 *    failure mode that matters here, so ambiguity becomes noise, never
 *    silence. The known gaps are enumerated on `architecture/aliases.ts`.
 *
 * 2. BARREL FILES. `import { x } from "@/services"` reaches
 *    `src/services/index.ts`, which re-exports from elsewhere. Prefix matching
 *    sees `src/services`, is satisfied, and misses that `x` actually lives in
 *    a higher layer. `expandBarrel` follows the re-export chain, name-aware:
 *    an explicit `export { a as b } from "./z"` is followed only when `b` is
 *    one of the names actually imported, and `export * from "./z"` is followed
 *    only when `./z` really exports one of them (its export list is parsed).
 *    Its bounds are enumerated on `architecture/barrel.ts`.
 *
 * 3. `import type`. A type-only import erases at compile time and creates no
 *    runtime edge. It is still reported, because a layering contract is about
 *    knowledge and coupling, not emitted bytes: a domain module that names an
 *    entrypoint's type has learned the entrypoint's shape, and the refactor
 *    that breaks one breaks the other. But it is a genuinely weaker breach
 *    than a runtime one, so it carries its own code, `layer-breach-type`,
 *    and a project that wants to weigh the two differently can. Mixed
 *    (`import { type A, b }`) counts as a value import — `b` is real.
 *
 * THIS FILE IS THE PUBLIC ENTRY POINT and nothing else. The two gates and the
 * machinery they share live in six single-concern modules:
 *
 *  - `architecture/exports.ts` — every name a module DECLARES public;
 *  - `architecture/starExports.ts` — that plus the names a bare `export *`
 *    forwards, which is the symbol budget's real input and the filter a star
 *    re-export is narrowed by;
 *  - `architecture/edges.ts` — every module-to-module edge a file declares;
 *  - `architecture/aliases.ts` — tsconfig `paths`/`baseUrl`, and pinning a
 *    specifier to a real file;
 *  - `architecture/resolve.ts` — a specifier to a judgeable target, or a
 *    loud `layer-unresolved`;
 *  - `architecture/barrel.ts` — following a re-export chain, name-aware;
 *  - `architecture/layers.ts` — the layer contract itself;
 *  - `architecture/structure.ts` — the file and symbol budgets.
 */

export { clearAliasCache } from "./architecture/aliases.ts";
export { checkLayers } from "./architecture/layers.ts";
export { checkStructure } from "./architecture/structure.ts";
