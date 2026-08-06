/**
 * The source-tree walk shared by every syntax-tier gate.
 *
 * Split out of `sourceFile.ts`. What this file decides — which directories are
 * never our code, and which are generated — decides what the whole tool ever
 * looks at, so the two skip rules are documented at length below and are NOT
 * interchangeable.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Extensions walked unless a caller says otherwise: the TypeScript family
 * only. A gate that reports on `.js` in a TypeScript project is usually
 * reporting on build output or vendored code.
 */
export const DEFAULT_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".mts", ".cts"];

/**
 * Directories never worth walking, at ANY depth. Neither is ever our code:
 * nested `node_modules` are real (pnpm, workspaces) and `.git` appears again
 * inside submodules, so both must be matched by name wherever they occur.
 */
const SKIP_DIRS_ANY_DEPTH: ReadonlySet<string> = new Set(["node_modules", ".git"]);

/**
 * Build-output directory names — skipped ONLY as immediate children of the
 * REPO ROOT, never by name at arbitrary depth.
 *
 * These are generated, and reporting violations in generated code trains
 * people to ignore the tool. But the names are also perfectly ordinary for
 * real source directories: this repo's own `src/coverage/istanbul.ts` was
 * silently invisible to every gate because a depth-agnostic name match ate
 * the whole directory. A skip rule that quietly removes real source from
 * analysis is the worst failure this tool has — it reports green over code
 * it never read.
 *
 * The boundary is the repo root, NOT the walk base. With the default
 * `sourcePaths: ["src"]` the walk base is `src/` itself, so keying off the
 * walk would skip `src/coverage/` all over again — the first attempt at this
 * fix did exactly that, and the regression test in `program.test.ts` caught
 * it. Root-relative keeps the intent (a repo-root `dist/` or `coverage/`
 * under `sourcePaths: ["."]` is still skipped) without claiming that any
 * directory *named* `build` anywhere is generated.
 */
const OUTPUT_DIRS: ReadonlySet<string> = new Set(["dist", "build", "out", "coverage"]);

/**
 * The subset of `fs.Dirent` the walk uses.
 *
 * Named rather than inlined so the annotation below stays readable, and
 * structural rather than `Dirent` so the walk does not depend on which
 * generic parameters the running Node's typings give that class.
 */
interface DirectoryEntry {
  readonly name: string;
  isDirectory: () => boolean;
  isFile: () => boolean;
}

/**
 * Recursively yield candidate files under `base`, sorted, deterministically.
 *
 * Sorted at every level so two runs over the same tree report violations in
 * the same order — a gate whose output reorders between runs makes every
 * diff unreadable. A `base` that is not a directory yields nothing.
 */
export function* walkFiles(
  base: string,
  extensions: readonly string[],
  includeDeclarations: boolean,
  root: string,
): Generator<string> {
  let entries: readonly DirectoryEntry[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return;
  }
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of sorted) {
    const path = join(base, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirectory(entry.name, base === root)) {
        yield* walkFiles(path, extensions, includeDeclarations, root);
      }
      continue;
    }
    if (entry.isFile() && wanted(entry.name, extensions, includeDeclarations)) {
      yield path;
    }
  }
}

/** Whether a file name is one this walk should hand to the parser. */
function wanted(
  name: string,
  extensions: readonly string[],
  includeDeclarations: boolean,
): boolean {
  if (!extensions.some((extension) => name.endsWith(extension))) {
    return false;
  }
  return includeDeclarations || !/\.d\.[cm]?ts$/.test(name);
}

/**
 * Whether to skip a directory during the walk.
 *
 * `node_modules`, `.git` and dot-directories are skipped wherever they occur.
 * Build-output names are skipped ONLY as immediate children of the REPO ROOT
 * — not of the walk base, which for `sourcePaths: ["src"]` is `src/` itself
 * and would skip `src/coverage/` all over again.
 */
function skipDirectory(name: string, atRepoRoot: boolean): boolean {
  if (SKIP_DIRS_ANY_DEPTH.has(name) || name.startsWith(".")) {
    return true;
  }
  return atRepoRoot && OUTPUT_DIRS.has(name);
}
