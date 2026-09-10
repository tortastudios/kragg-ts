/**
 * Tests for what the PUBLISHED package promises.
 *
 * `pnpm test` imports `src/*.ts`. It never builds, never packs and never
 * installs, so four claims in `package.json` — `bin`, `main`, `types` and
 * `exports` — had no test behind them at all, and the entry-point guard at the
 * bottom of `src/cli.ts` was only ever exercised through a path with no
 * symlink in it. Both gaps shipped a real defect:
 *
 *   $ node node_modules/@tortastudios/kragg-ts/dist/cli.js --version
 *   $ echo $?
 *   0
 *
 * — no output, exit 0, nothing ran. pnpm links `node_modules/<name>` at a
 * store directory under `node_modules/.pnpm/`, Node resolved `import.meta.url`
 * through that link, `process.argv[1]` did not go through it, and the string
 * comparison the guard used said "imported, not invoked". A CLI that does
 * nothing while reporting success is the one outcome this codebase exists to
 * prevent, so it gets a regression test that runs on every suite.
 *
 * WHAT THESE TESTS DELIBERATELY DO NOT DO: build, pack or install. That is
 * `scripts/compat.ts`'s `packaged` lane and `.github/workflows/compat.yml`,
 * which run it on ubuntu and windows across Node 20, 22 and 24. The
 * assertions here are the ones that must hold with no build present, so the
 * suite stays runnable with `pnpm test` alone.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { publishedEntryPoints, readManifest } from "../scripts/compat/manifest.ts";
import { isEntryPoint } from "../src/cli/entry.ts";
import { runCommand } from "../src/engine/runner.ts";
import { kraggVersion } from "../src/engine/report.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-packaging-"));
  roots.push(root);
  return root;
}

describe("published entry points", () => {
  const manifest = readManifest(REPO_ROOT);
  const entries = publishedEntryPoints(manifest);

  it("names bin, main, types and both export conditions", () => {
    const fields = entries.map((entry) => entry.field);
    for (const field of ["bin.kragg", "main", "types"]) {
      assert.ok(fields.includes(field), `${field} is not a published entry point`);
    }
    // `exports["."]` is where a modern consumer resolves the package, and its
    // `types` and `default` conditions are separate promises. `publishedEntryPoints`
    // deduplicates by PATH, so at least one of the two must survive under an
    // `exports` field name even when it repeats `main`/`types`.
    assert.ok(
      fields.some((field) => field.startsWith("exports")),
      `no exports path was collected from ${JSON.stringify(manifest["exports"])}`,
    );
  });

  it("maps every dist path back to a source file the build compiles", () => {
    // The build is `rootDir: src` -> `outDir: dist` (tsconfig.build.json), so
    // `dist/cli.js` can only exist if `src/cli.ts` does. Checking the source
    // side is what makes this assertion true with no build present, and it is
    // the half that actually rots: deleting or renaming a source entry point
    // is a source edit, and nothing else would notice.
    for (const entry of entries) {
      if (!entry.path.startsWith("dist/")) {
        assert.ok(existsSync(join(REPO_ROOT, entry.path)), `${entry.path} does not exist`);
        continue;
      }
      const source = entry.path.replace(/^dist\//u, "src/").replace(/\.d\.ts$|\.js$/u, ".ts");
      assert.ok(
        existsSync(join(REPO_ROOT, source)),
        `${entry.field} promises ${entry.path}, but ${source} does not exist`,
      );
    }
  });

  it("allowlists every published path in `files`", () => {
    // npm ships only what `files` permits. A `types` entry outside it resolves
    // for the author and 404s for everyone else.
    const files = manifest["files"];
    assert.ok(Array.isArray(files), "package.json has no files array");
    const allowed = files.filter((one): one is string => typeof one === "string");
    for (const entry of entries) {
      const covered =
        entry.path === "package.json" ||
        allowed.some((pattern) => entry.path === pattern || entry.path.startsWith(`${pattern}/`));
      assert.ok(covered, `${entry.field} (${entry.path}) is not covered by files: ${allowed.join(", ")}`);
    }
  });

  it("puts the declared runtime floor in the compatibility matrix", () => {
    // `engines.node` is the package's loudest compatibility claim and the one
    // with the least evidence behind it — the suite runs on exactly one Node.
    // `.github/workflows/compat.yml` supplies that evidence by running the
    // PACKED package on each version, so the floor moving without the matrix
    // moving would put the claim back where it started. Both ends are read
    // here so they cannot drift apart silently.
    const engines = manifest["engines"];
    assert.ok(typeof engines === "object" && engines !== null, "no engines field");
    const range = String((engines as Record<string, unknown>)["node"]);
    const floor = /(\d+)/u.exec(range)?.[1];
    assert.ok(floor !== undefined, `unreadable engines.node: ${range}`);

    const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/compat.yml"), "utf8");
    const matrix = /^\s*node:\s*\[(?<versions>[^\]]*)\]/mu.exec(workflow)?.groups?.["versions"];
    assert.ok(matrix !== undefined, "compat.yml declares no `node:` matrix");
    const versions = matrix.split(",").map((one) => one.trim().replaceAll('"', ""));
    assert.ok(versions.includes(floor), `engines.node floor ${floor} is not in the matrix ${matrix}`);

    const development = readFileSync(join(REPO_ROOT, ".node-version"), "utf8").trim();
    assert.ok(
      versions.includes(development),
      `.node-version ${development} is not in the matrix ${matrix}`,
    );
  });
});

describe("the CLI entry-point guard", () => {
  it("says no when there is no entry at all", () => {
    // `node --eval` and the REPL: argv[1] is undefined and nothing was invoked.
    assert.equal(isEntryPoint(import.meta.url, undefined), false);
  });

  it("says yes for the module the process was started with", () => {
    assert.equal(isEntryPoint(pathToFileURL(CLI).href, CLI), true);
  });

  it("says no for a module that was merely imported", () => {
    // This is the property `test/cli.test.ts` depends on: importing `main`
    // must not run it.
    assert.equal(isEntryPoint(pathToFileURL(CLI).href, fileURLToPath(import.meta.url)), false);
  });

  it("says yes when argv[1] reaches the module through a symlink", () => {
    // THE REGRESSION. This is pnpm's `node_modules/<name>` -> `.pnpm/...`
    // layout, and npm/yarn workspace links, and `/var` -> `/private/var` on
    // macOS. The old guard compared `import.meta.url` (resolved) against
    // `pathToFileURL(argv[1])` (not resolved) and answered false for all three.
    const root = temporary();
    const target = join(root, "real.mjs");
    const link = join(root, "linked.mjs");
    writeFileSync(target, "export const x = 1;\n");
    symlinkSync(target, link);
    assert.equal(isEntryPoint(pathToFileURL(target).href, link), true);
  });

  it("falls back to a literal comparison when a path cannot be resolved", () => {
    // `realpathSync` throws for a path that does not exist. Answering from the
    // raw strings then is conservative: it cannot turn an import into a run.
    const missing = join(temporary(), "gone.mjs");
    assert.equal(isEntryPoint(pathToFileURL(missing).href, missing), true);
    assert.equal(isEntryPoint(pathToFileURL(`${missing}.other`).href, missing), false);
  });

  it("runs the real CLI when it is invoked through a symlink", async () => {
    // End to end, through a real spawn, because the unit assertions above
    // cannot catch a caller that stops consulting `isEntryPoint`.
    const root = temporary();
    const link = join(root, "kragg-cli.ts");
    symlinkSync(CLI, link);
    const result = await runCommand("kragg", [process.execPath, link, "--version"], root);
    assert.equal(result.returncode, 0, result.stderr);
    assert.equal(result.stdout.trim(), kraggVersion());
  });
});
