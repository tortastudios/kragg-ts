/**
 * "Was this module invoked as the program, or imported?"
 *
 * `src/cli.ts` needs the answer so that `test/cli.test.ts` can import `main`
 * without the module running itself. The obvious spelling —
 * `import.meta.url === pathToFileURL(process.argv[1]).href` — is what this
 * file exists to replace, because it compares two paths that are NOT the same
 * kind of thing:
 *
 *  - `import.meta.url` is where Node RESOLVED the module, with every symlink
 *    on the way already followed (Node does that unless `--preserve-symlinks`
 *    is passed, which nothing here passes);
 *  - `process.argv[1]` is the path the caller typed, symlinks and all.
 *
 * Any layout that links a package into place makes those differ, and the
 * default install layout of the package manager this project mandates is one:
 * pnpm links `node_modules/<name>` at a store directory under
 * `node_modules/.pnpm/`. So in a consumer's project,
 *
 *     node node_modules/kragg-ts/dist/cli.js --version
 *
 * printed NOTHING and exited 0 — the string comparison failed, `main` never
 * ran, and a CLI that does nothing while reporting success is the exact
 * fail-open outcome the rest of this codebase is built to refuse. macOS adds a
 * second instance for free (`/var` is a symlink to `/private/var`), and npm
 * and yarn workspace links a third.
 *
 * Comparing REAL paths fixes both directions at once: the store path and the
 * linked path resolve to one file, so a direct invocation runs, and an
 * `import` from a test file still does not — a test's `argv[1]` is the test.
 *
 * `realpathSync` throws only when a path does not exist (a deleted entry
 * point, a `argv[1]` that is not a file at all). Falling back to the literal
 * comparison there keeps the answer conservative rather than guessing.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Whether `moduleUrl` is the module Node was started with.
 *
 * @param moduleUrl the caller's own `import.meta.url`.
 * @param entry `process.argv[1]`, which is `undefined` under `node --eval`
 *   and in a REPL — neither of which is an entry-point invocation.
 */
export function isEntryPoint(moduleUrl: string, entry: string | undefined): boolean {
  if (entry === undefined) {
    return false;
  }
  const self = fileURLToPath(moduleUrl);
  return realPath(entry) === realPath(self);
}

/** `realpathSync`, or the path unchanged when it cannot be resolved. */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
