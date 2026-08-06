/**
 * Syntax tier: parse individual files, cheaply, with no type information.
 *
 * The analogue of `kragg/src/kragg/gates/sources.py`. One walk over the
 * policy's source paths yields each file with the pieces a name-resolving
 * gate needs (module specifier, import table, raw lines for suppression
 * comments), so every gate sharing this walk is guaranteed to scan the same
 * file set for the same policy.
 *
 * WHY THIS TIER EXISTS AT ALL. In Python `ast.parse` is free, so twelve gates
 * each doing their own walk costs nothing. In TypeScript the equivalent of
 * "parse" is cheap but the equivalent of "understand" — a `ts.Program` with a
 * type checker — takes SECONDS on a real repo. Splitting the two lets
 * `kragg check --changed` run every syntax-only gate over a handful of files
 * without ever paying for a program. See `program.ts` for the other tier.
 *
 * THIS MODULE IS THE TIER'S ENTRY POINT. The parts it is built from are
 * separate modules, and it re-exports their public surface so no importer
 * needs to know which one a symbol lives in:
 *
 *  - `compiler.ts`   — resolving the compiler to analyze WITH,
 *  - `walk.ts`       — which files exist and which are never our code,
 *  - `modulePath.ts` — file path <-> module name arithmetic,
 *  - `imports.ts`    — the local-binding -> target table.
 *
 * THE COMPILER INSTANCE IS RESOLVED, NOT IMPORTED. `resolveTypeScript` lives
 * in `compiler.ts`, in the cheaper tier, because both tiers need it and this
 * one must not depend on the expensive one. Read its doc comment before
 * calling any `ts.*` function anywhere in a gate — the rule it establishes is
 * not optional.
 */

import { readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";

import type bundledTs from "typescript";

import { resolveTypeScript, type TypeScriptApi } from "./compiler.ts";
import { moduleImports } from "./imports.ts";
import { moduleName, toPosix } from "./modulePath.ts";
import { DEFAULT_EXTENSIONS, walkFiles } from "./walk.ts";

export type { CompilerResolution, TypeScriptApi } from "./compiler.ts";
export { clearCompilerCache, resolveTypeScript } from "./compiler.ts";
export { moduleImports } from "./imports.ts";
export { absolutePath, moduleName } from "./modulePath.ts";

/** One parsed source file with everything a name-resolving gate needs. */
export interface ParsedSource {
  /** Absolute path on disk. */
  readonly path: string;
  /** Path relative to the repo root, always with `/` separators. */
  readonly relative: string;
  /** Repo-relative, extension-stripped module name — see `moduleName`. */
  readonly module: string;
  readonly sourceFile: bundledTs.SourceFile;
  /** Raw lines, for suppression-comment and line-length checks. */
  readonly lines: readonly string[];
  /** Local binding -> `"<module>#<exportedName>"`. See `moduleImports`. */
  readonly imports: ReadonlyMap<string, string>;
}

export interface ParseOptions {
  /**
   * Extensions to walk. Defaults to the TypeScript family only: a gate that
   * reports on `.js` in a TypeScript project is usually reporting on build
   * output or vendored code.
   */
  readonly extensions?: readonly string[] | undefined;
  /**
   * Include `.d.ts` files. Off by default — declaration files contain no
   * runtime code, so complexity, forbidden-call and secret gates have nothing
   * to say about them. A public-surface gate wants them, and turns this on.
   */
  readonly includeDeclarations?: boolean | undefined;
  /** Compiler to parse with. Defaults to `resolveTypeScript(root).api`. */
  readonly api?: TypeScriptApi | undefined;
}

/**
 * Yield parsed files under the source paths, skipping anything unreadable or
 * broken — never crashing the run on one bad file.
 *
 * A generator, so `--changed` callers can stop early and a gate that only
 * needs the first N files does not parse the rest.
 *
 * `sourcePaths` that do not exist are skipped silently, matching the Python
 * version's `if not base.is_dir(): continue` — a policy listing `src` and
 * `lib` should not fail on a repo that has only `src`.
 */
export function* parsedSources(
  root: string,
  sourcePaths: readonly string[],
  options: ParseOptions = {},
): Generator<ParsedSource> {
  const absoluteRoot = resolve(root);
  const api = options.api ?? resolveTypeScript(absoluteRoot).api;
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const includeDeclarations = options.includeDeclarations ?? false;

  for (const sourcePath of sourcePaths) {
    const base = resolve(absoluteRoot, sourcePath);
    for (const path of walkFiles(base, extensions, includeDeclarations, absoluteRoot)) {
      const parsed = parseSourceFile(path, absoluteRoot, api);
      if (parsed !== null) {
        yield parsed;
      }
    }
  }
}

/**
 * Parse one file into a `ParsedSource`, or `null` if it cannot be used.
 *
 * `null` covers both of Python's skip cases and one it does not have:
 * unreadable file (I/O error), and a file with syntax errors. Note the
 * asymmetry with Python — `ast.parse` RAISES on bad syntax while
 * `ts.createSourceFile` recovers and hands back a partial tree. Silently
 * analyzing that partial tree would produce violations that point at code the
 * author never wrote, so we detect the errors and skip, matching Python's
 * behaviour rather than the compiler's.
 *
 * Module names are taken relative to the REPO ROOT, not relative to the
 * source path the file was found under. This diverges from Python, and it is
 * the divergence that makes the import table usable: Python names modules
 * relative to the package root because that is what a Python import
 * specifier is, while a TypeScript relative specifier is a filesystem path.
 * Naming `src/a.ts` as `a` would make `import "../lib/util.ts"` resolve to
 * `../lib/util`, joining against nothing, and would collide `src/a.ts` with
 * `lib/a.ts` whenever a policy lists two source paths.
 */
export function parseSourceFile(
  path: string,
  root: string,
  api: TypeScriptApi,
): ParsedSource | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const sourceFile = api.createSourceFile(
    path,
    text,
    api.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindOf(api, path),
  );
  if (hasParseErrors(sourceFile)) {
    return null;
  }
  const module = moduleName(path, root);
  return {
    path,
    relative: toPosix(relative(root, path)),
    module,
    sourceFile,
    lines: text.split(/\r?\n/),
    imports: moduleImports(module, sourceFile, api),
  };
}

function scriptKindOf(api: TypeScriptApi, path: string): bundledTs.ScriptKind {
  switch (extname(path)) {
    case ".tsx":
      return api.ScriptKind.TSX;
    case ".jsx":
      return api.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return api.ScriptKind.JS;
    default:
      return api.ScriptKind.TS;
  }
}

/**
 * Whether the parser reported syntax errors.
 *
 * `parseDiagnostics` is on `SourceFile` at runtime but not in the public
 * `.d.ts`, and it is the ONLY way to get syntactic diagnostics without
 * building a `ts.Program` — which is precisely the cost this tier exists to
 * avoid. It is read through an `unknown` narrowing so that a compiler version
 * without the field degrades to "no errors" (keep the file) rather than
 * throwing. Best-effort by construction: over-skipping a file is worse than
 * analyzing a recovered tree, so absence means keep.
 *
 * THE DOUBLE CAST IS THE POINT, AND IT IS SUPPRESSED ON PURPOSE. There is no
 * declared type to reach the field through, so `unknown` is the only honest
 * intermediate; the result is immediately re-narrowed with `Array.isArray`
 * before anything is read off it, so nothing is laundered into a type it does
 * not have. The `// kragg: ignore` keeps that exemption in the diff, where a
 * reviewer sees it, rather than in a config file where nobody does.
 */
function hasParseErrors(sourceFile: bundledTs.SourceFile): boolean {
  const fields = sourceFile as unknown as Readonly<Record<string, unknown>>; // kragg: ignore
  const diagnostics: unknown = fields["parseDiagnostics"];
  return Array.isArray(diagnostics) && diagnostics.length > 0;
}
