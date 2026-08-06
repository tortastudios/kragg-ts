/**
 * Which TypeScript compiler kragg analyzes a project with, and how it got it.
 *
 * Split out of `sourceFile.ts`, which re-exports everything here; the syntax
 * tier and the program tier both need compiler resolution, and neither should
 * have to pull in the other's machinery to get it.
 *
 * Read `resolveTypeScript` before calling any `ts.*` function anywhere in a
 * gate — the rule it establishes is not optional.
 */

import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import bundledTs from "typescript";

/**
 * The TypeScript compiler API, as a value.
 *
 * Gates receive this and call through it. They must NOT `import ts from
 * "typescript"` themselves — see `resolveTypeScript` for why that is a
 * correctness rule and not a style preference.
 */
export type TypeScriptApi = typeof bundledTs;

/** Which compiler we are analyzing with, and how we got it. */
export interface CompilerResolution {
  readonly api: TypeScriptApi;
  readonly version: string;
  /** `"project"` is the good case; `"bundled"` always carries a `note`. */
  readonly source: "project" | "bundled";
  /** Absolute path to the resolved `typescript` entry point, when known. */
  readonly path: string | null;
  /** Human-readable caveat for the report; `null` when there is none. */
  readonly note: string | null;
}

/**
 * Resolved compilers, keyed by project root. Resolution hits the filesystem
 * and loads a multi-megabyte module; doing it once per gate would be absurd.
 */
const compilerCache = new Map<string, CompilerResolution>();

/**
 * Resolve the compiler to analyze a project with — the project's, if it has
 * one.
 *
 * THE PROBLEM. kragg-ts ships its own `typescript`, but the project under
 * check may be on a different major. Analyzing a TypeScript 5 project with a
 * TypeScript 6 compiler produces confident results about a language the
 * project is not written in: syntax the project's own `tsc` rejects parses
 * fine, and vice versa. This is the exact failure `environment.py` refuses to
 * commit in Python — kragg there will not run pytest on kragg's interpreter.
 * Same rule, same reason.
 *
 * THE RESOLUTION ORDER. The project's `typescript`, resolved from the
 * project root the way the project's own code would resolve it; then the
 * bundled one, WITH a `note` that every report must surface. A silent
 * fallback is the one outcome that is not allowed: a gate that analyzed with
 * the wrong compiler and said nothing about it is worse than a gate that did
 * not run.
 *
 * THE RULE THIS CREATES. `ts.SyntaxKind` values, flag bitmasks and node
 * shapes are internal to a compiler build and are NOT stable across versions.
 * A node produced by the project's compiler must only ever be inspected by
 * the same compiler's predicates. So: gates call `resolution.api.isCallExpression(node)`,
 * never `ts.isCallExpression(node)` from their own import. The static `import
 * bundledTs from "typescript"` in this file exists for the TYPES and for the
 * fallback instance, and is the only one in the analysis layer.
 *
 * TRUST NOTE. Loading the project's `typescript` executes code from the
 * project under check. That is the same trust boundary kragg already crosses
 * by running the project's `tsc`, `vitest` and auditors, and it is deliberate
 * — but it is a boundary, and it belongs in the threat model rather than
 * being discovered later.
 */
export function resolveTypeScript(root: string): CompilerResolution {
  const key = resolve(root);
  const cached = compilerCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const resolution = loadTypeScript(key);
  compilerCache.set(key, resolution);
  return resolution;
}

/** Drop cached compilers. For tests and long-lived processes only. */
export function clearCompilerCache(): void {
  compilerCache.clear();
}

function loadTypeScript(root: string): CompilerResolution {
  const bundled: CompilerResolution = {
    api: bundledTs,
    version: bundledTs.version,
    source: "bundled",
    path: null,
    note:
      `no project-local typescript found under ${root}; ` +
      `analyzed with kragg's bundled typescript ${bundledTs.version}, ` +
      `which may disagree with the project's own compiler`,
  };

  // `createRequire` anchored on the project's package.json gives us exactly
  // the resolution the project's own source would get, including workspace
  // hoisting. It is synchronous, which keeps every gate free of an await it
  // would otherwise need only for this.
  let entry: string;
  try {
    entry = createRequire(join(root, "package.json")).resolve("typescript");
  } catch {
    return bundled;
  }

  let loaded: unknown;
  try {
    loaded = createRequire(join(root, "package.json"))(entry);
  } catch (error: unknown) {
    return {
      ...bundled,
      note:
        `project typescript at ${entry} failed to load (${errorText(error)}); ` +
        `analyzed with kragg's bundled typescript ${bundledTs.version} instead`,
    };
  }

  if (!isTypeScriptApi(loaded)) {
    return {
      ...bundled,
      note:
        `project typescript at ${entry} does not expose the compiler API kragg uses; ` +
        `analyzed with kragg's bundled typescript ${bundledTs.version} instead`,
    };
  }
  if (loaded === bundledTs) {
    // The project resolved to the very module we bundle (a workspace member
    // of this repo, or a linked install). Report it honestly as bundled, with
    // no caveat, because there is no version disagreement to warn about.
    return { api: bundledTs, version: bundledTs.version, source: "bundled", path: entry, note: null };
  }
  return {
    api: loaded,
    version: loaded.version,
    source: "project",
    path: entry,
    note: majorOf(loaded.version) === majorOf(bundledTs.version)
      ? null
      : `analyzing with the project's typescript ${loaded.version} ` +
        `(kragg bundles ${bundledTs.version})`,
  };
}

/**
 * Structural check that a loaded module is the compiler API we need.
 *
 * `require()` is typed `any`; widening it to `unknown` and narrowing here is
 * the only honest way to type this boundary. The predicate checks the exact
 * surface both tiers call, so an incompatible module is rejected before it
 * can produce nodes we would then misread.
 */
function isTypeScriptApi(value: unknown): value is TypeScriptApi {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  if (typeof candidate["version"] !== "string") {
    return false;
  }
  const required = [
    "createSourceFile",
    "createProgram",
    "readConfigFile",
    "parseJsonConfigFileContent",
    "forEachChild",
    "sys",
  ];
  return required.every((name) => candidate[name] !== undefined);
}

function majorOf(version: string): string {
  return version.split(".")[0] ?? version;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
