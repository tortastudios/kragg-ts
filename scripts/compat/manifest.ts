/**
 * What `package.json` promises a consumer, as data.
 *
 * `bin`, `main`, `types` and `exports` are four independent claims about files
 * that only exist after `tsc -p tsconfig.build.json` has run, and `files`
 * decides which of them survive into the tarball. Nothing checked any of them:
 * the build could stop emitting `dist/index.d.ts` and `pnpm test` would stay
 * green, because the test suite imports `src/`.
 *
 * This module is the single definition of "the published entry points", used
 * by `test/packaging.test.ts` (which asserts they exist in the build output,
 * on every run of the suite) and by `scripts/compat/packaged.ts` (which
 * asserts they survived into an INSTALLED tarball, on every matrix row). One
 * definition, two levels of evidence.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** One published path, and the manifest field that promised it. */
export interface PublishedEntry {
  /** Dotted field path, e.g. `bin.kragg` or `exports["."].types`. */
  readonly field: string;
  /** Repository-relative path with any `./` prefix removed. */
  readonly path: string;
}

/** Read a `package.json` as an untyped record. */
export function readManifest(repoRoot: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("package.json is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Every path the manifest publishes, deduplicated by path.
 *
 * `exports` is walked rather than read at a fixed depth: conditional exports
 * nest arbitrarily, and a path that only appears under a condition nobody
 * enumerated is exactly the one that rots. `"./package.json"` is included —
 * it is a real published path and consumers do import it.
 */
export function publishedEntryPoints(manifest: Record<string, unknown>): readonly PublishedEntry[] {
  const entries: PublishedEntry[] = [];
  const seen = new Set<string>();
  const add = (field: string, value: unknown): void => {
    if (typeof value !== "string" || seen.has(value)) {
      return;
    }
    seen.add(value);
    entries.push({ field, path: value.replace(/^\.\//u, "") });
  };

  add("main", manifest["main"]);
  add("types", manifest["types"]);

  const bin = manifest["bin"];
  if (typeof bin === "string") {
    add("bin", bin);
  } else if (typeof bin === "object" && bin !== null && !Array.isArray(bin)) {
    for (const [name, value] of Object.entries(bin)) {
      add(`bin.${name}`, value);
    }
  }

  walkExports("exports", manifest["exports"], add);
  return entries;
}

/** Depth-first walk of the `exports` tree, collecting every string leaf. */
function walkExports(
  field: string,
  node: unknown,
  add: (field: string, value: unknown) => void,
): void {
  if (typeof node === "string") {
    add(field, node);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child, index) => {
      walkExports(`${field}[${String(index)}]`, child, add);
    });
    return;
  }
  if (typeof node === "object" && node !== null) {
    for (const [key, child] of Object.entries(node)) {
      walkExports(`${field}[${JSON.stringify(key)}]`, child, add);
    }
  }
}
