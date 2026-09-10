/**
 * `tsconfig.json` path aliases, and pinning a resolved specifier to a file.
 *
 * PATH ALIASES ARE THE FIRST PROBLEM TYPESCRIPT HAS AND PYTHON DOES NOT. A
 * Python import specifier IS the module name, so a prefix match is exact. A
 * TypeScript specifier is whatever `tsconfig.json` `paths`/`baseUrl` says it
 * is: `@/services/foo` is `src/services/foo`, and a prefix match on the raw
 * text sees neither layer.
 *
 * WHICH TSCONFIG: the one the caller selected — the policy's `tsconfig`,
 * resolved by `projectTsconfig`, the same file the program and the `tsc` gate
 * read — never a root `tsconfig.json` looked up here. A monorepo member is
 * covered by a package-level run (`--package`), whose root is the member and
 * whose tsconfig is the member's.
 *
 * Known gaps, stated rather than hidden: package `exports` subpath maps and
 * bundler-only aliases (vite, webpack) are not read; and `paths` is applied
 * relative to `baseUrl ?? dirname(<tsconfig>)` rather than to the
 * compiler-internal `pathsBasePath`, so a `paths` table inherited through
 * `extends` from a tsconfig in ANOTHER directory, with no `baseUrl`, resolves
 * against the wrong base.
 */

import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type bundledTs from "typescript";

import type { TypeScriptApi } from "../../analysis/sourceFile.ts";

/**
 * Suffixes tried when pinning a resolved specifier to a real file, in the
 * compiler's own preference order (`foo.ts` wins over `foo/index.ts`). The
 * empty suffix is first so a specifier that already carries an extension
 * matches itself.
 */
const FILE_SUFFIXES: readonly string[] = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".d.ts",
  "/index.ts",
  "/index.tsx",
  "/index.mts",
  "/index.d.ts",
  ".js",
  ".jsx",
  "/index.js",
];

/** One `paths` entry, pre-split around its single `*`. */
export interface AliasPattern {
  readonly literal: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly wildcard: boolean;
  readonly substitutions: readonly string[];
}

export interface AliasConfig {
  /** Directory `paths` substitutions are resolved against. */
  readonly base: string;
  /** Absolute `baseUrl`, or `null` when the project does not set one. */
  readonly baseUrl: string | null;
  readonly patterns: readonly AliasPattern[];
}

const EMPTY_ALIASES: AliasConfig = { base: "", baseUrl: null, patterns: [] };

/** Resolved alias tables, keyed by tsconfig path; reading one hits disk. */
const aliasCache = new Map<string, AliasConfig>();

/** Drop cached tsconfig alias tables. For tests and long-lived processes only. */
export function clearAliasCache(): void {
  aliasCache.clear();
}

/**
 * Read `paths`/`baseUrl` from the tsconfig at `tsconfigPath`.
 *
 * Parsed through the project's own compiler rather than `JSON.parse`, so
 * `extends` chains, comments and trailing commas all behave the way the
 * project's `tsc` behaves. `readDirectory` is stubbed to return nothing
 * because `parseJsonConfigFileContent` would otherwise enumerate the entire
 * `include` glob — seconds of work for a table we read two fields from.
 *
 * A missing or unreadable tsconfig yields no aliases rather than an error:
 * plenty of projects have none, and the layer gate is still meaningful for
 * relative imports.
 */
export function loadAliases(tsconfigPath: string, api: TypeScriptApi): AliasConfig {
  const configPath = resolve(tsconfigPath);
  const cached = aliasCache.get(configPath);
  if (cached !== undefined) {
    return cached;
  }
  const config = readAliases(configPath, api);
  aliasCache.set(configPath, config);
  return config;
}

function readAliases(configPath: string, api: TypeScriptApi): AliasConfig {
  const root = dirname(configPath);
  if (existingFile(configPath) === null) {
    return EMPTY_ALIASES;
  }
  const host: bundledTs.ParseConfigHost = {
    useCaseSensitiveFileNames: api.sys.useCaseSensitiveFileNames,
    readDirectory: () => [],
    fileExists: (path: string) => api.sys.fileExists(path),
    readFile: (path: string) => api.sys.readFile(path),
  };
  // `readConfigFile` returns the parsed JSON as `any`; pinning it to `unknown`
  // here is what keeps that `any` from leaking into the rest of this module.
  const raw: unknown = api.readConfigFile(configPath, host.readFile).config;
  if (raw === undefined) {
    return EMPTY_ALIASES;
  }
  const options = api.parseJsonConfigFileContent(raw, host, root, undefined, configPath).options;
  const baseUrl = options.baseUrl === undefined ? null : resolve(root, options.baseUrl);
  const paths = options.paths;
  if (paths === undefined) {
    return { base: baseUrl ?? root, baseUrl, patterns: [] };
  }
  return {
    base: baseUrl ?? dirname(configPath),
    baseUrl,
    patterns: Object.entries(paths).map(([literal, substitutions]) =>
      aliasPattern(literal, substitutions),
    ),
  };
}

function aliasPattern(literal: string, substitutions: readonly string[]): AliasPattern {
  const star = literal.indexOf("*");
  return star === -1
    ? { literal, prefix: literal, suffix: "", wildcard: false, substitutions }
    : {
        literal,
        prefix: literal.slice(0, star),
        suffix: literal.slice(star + 1),
        wildcard: true,
        substitutions,
      };
}

/**
 * The pattern a specifier matches, exact before wildcard and longest prefix
 * first — the compiler's own precedence, so `@/util/*` beats `@/*`.
 */
export function matchAlias(
  specifier: string,
  patterns: readonly AliasPattern[],
): AliasPattern | null {
  let best: AliasPattern | null = null;
  for (const pattern of patterns) {
    if (!pattern.wildcard) {
      if (pattern.literal === specifier) {
        return pattern;
      }
      continue;
    }
    const fits =
      specifier.length >= pattern.prefix.length + pattern.suffix.length &&
      specifier.startsWith(pattern.prefix) &&
      specifier.endsWith(pattern.suffix);
    if (fits && (best === null || pattern.prefix.length > best.prefix.length)) {
      best = pattern;
    }
  }
  return best;
}

/** The first extension-probed path that is a real file, or `null`. */
export function existingFile(base: string): string | null {
  for (const suffix of FILE_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile() === true) {
      return candidate;
    }
  }
  return null;
}
