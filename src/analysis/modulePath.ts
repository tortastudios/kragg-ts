/**
 * Path <-> module-name arithmetic for the syntax tier.
 *
 * Split out of `sourceFile.ts`, which re-exports the public pieces. Two rules
 * live here and must stay agreed with each other: how a FILE becomes a module
 * name (`moduleName`), and how an import SPECIFIER becomes the same module
 * name (`resolveSpecifier`). If those two disagree, the import table stops
 * joining against the file table and every cross-module gate goes quietly
 * blind.
 *
 * Everything here is pure string work — no filesystem access, so a specifier
 * pointing at a file that does not exist normalizes just the same.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * The module name for a file, relative to `moduleBase`.
 *
 * `parsedSources` always passes the repo root — see `parseSourceFile` for
 * why. The parameter stays because the helper is also the ported analogue of
 * `module_name` in `criticality.py`, which names modules relative to a
 * package root.
 *
 * Two deliberate translations from the Python original:
 *
 *  - separators are `/`, not `.`, because that is what a TypeScript import
 *    specifier looks like and the import table has to join against it;
 *  - `index` is dropped the way Python drops `__init__`, since `./foo` and
 *    `./foo/index.ts` are the same module to the resolver. A bare `index` at
 *    the root of the source path becomes the source directory's own name,
 *    exactly as Python falls back to `src_dir.name`.
 *
 * Every recognised extension is stripped, including the compound `.d.ts`.
 */
export function moduleName(path: string, moduleBase: string): string {
  const rel = toPosix(relative(resolve(moduleBase), resolve(path)));
  const withoutExtension = stripExtension(rel);
  const parts = withoutExtension.split("/").filter((part) => part !== "");
  if (parts[parts.length - 1] === "index") {
    parts.pop();
  }
  if (parts.length === 0) {
    return baseName(resolve(moduleBase));
  }
  return parts.join("/");
}

/**
 * Turn an import specifier into the target module's name.
 *
 * Relative specifiers are joined onto the importing module's directory and
 * normalized the same way `moduleName` normalizes a path, so the two agree.
 * Everything else — bare packages, `node:` builtins, tsconfig aliases,
 * absolute paths — is returned verbatim. See the TODO(resolution) on
 * `moduleImports` for why aliases are deliberately left alone.
 */
export function resolveSpecifier(module: string, specifier: string): string {
  if (!specifier.startsWith(".")) {
    return specifier;
  }
  const dir = module.includes("/") ? module.slice(0, module.lastIndexOf("/")) : "";
  const joined = normalizePosix(dir === "" ? specifier : `${dir}/${specifier}`);
  const stripped = stripExtension(joined);
  return stripped.endsWith("/index") ? stripped.slice(0, -"/index".length) : stripped;
}

/** Absolute-path form used when matching a caller's `--changed` list. */
export function absolutePath(root: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(root, path);
}

/** Native separators to `/`, so every reported path looks the same on Windows. */
export function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/**
 * Drop a TypeScript-family extension, compound `.d.ts` forms included.
 *
 * One function so `moduleName` and `resolveSpecifier` cannot drift apart on
 * which extensions they recognise.
 */
function stripExtension(path: string): string {
  return path.replace(/\.d\.[cm]?ts$/, "").replace(/\.[cm]?[jt]sx?$/, "");
}

/** `.`/`..` resolution on a `/`-separated specifier, with no filesystem access. */
function normalizePosix(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else {
        out.push("..");
      }
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

function baseName(path: string): string {
  const parts = toPosix(path).split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? path;
}
