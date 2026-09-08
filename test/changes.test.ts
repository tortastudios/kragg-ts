/**
 * Tests for changed-file detection.
 *
 * These drive real `git` against real throwaway repositories rather than
 * mocking the subprocess. The behaviour under test IS the interaction with
 * git — its diff filters, its untracked-file listing, its path quoting — and
 * a mock would only assert that we typed the flags we typed.
 *
 * The load-bearing distinction is `null` (not a repository / git could not
 * answer) versus `[]` (a repository with nothing changed). Collapsing them
 * makes `kragg check --changed` check nothing and report a confident pass.
 *
 * Every test is skipped when git is unavailable rather than failing, so the
 * suite stays honest on a machine without it.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { runCommand } from "../src/engine/runner.ts";
import {
  changedFiles,
  DECLARATION_SUFFIXES,
  gitDirty,
  gitSha,
  scanChanges,
  selectSourceFiles,
  SOURCE_EXTENSIONS,
  type ChangedPaths,
} from "../src/git/changes.ts";

const roots: string[] = [];
let gitAvailable = false;

before(async () => {
  const probe = await runCommand("git", ["git", "--version"], tmpdir());
  gitAvailable = probe.returncode === 0;
});

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Identity and signing flags, so a commit works on any developer machine. */
const COMMIT_FLAGS = [
  "-c",
  "user.name=kragg-test",
  "-c",
  "user.email=kragg-test@example.invalid",
  "-c",
  "commit.gpgsign=false",
];

async function git(root: string, args: readonly string[]): Promise<void> {
  const result = await runCommand("git", ["git", ...args], root);
  assert.equal(
    result.returncode,
    0,
    `git ${args.join(" ")} failed: ${result.stderr}`,
  );
}

function scratchDir(): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-changes-"));
  roots.push(root);
  return root;
}

function write(root: string, relative: string, contents = "export {};\n"): void {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

/** A repository with one committed file under `src/`. */
async function repo(): Promise<string> {
  const root = scratchDir();
  await git(root, ["init", "--initial-branch=main"]);
  write(root, "src/committed.ts");
  await git(root, ["add", "."]);
  await git(root, [...COMMIT_FLAGS, "commit", "-m", "initial"]);
  return root;
}

describe("SOURCE_EXTENSIONS", () => {
  it("covers every TypeScript and JavaScript module extension", () => {
    assert.deepEqual(SOURCE_EXTENSIONS, [
      ".ts",
      ".tsx",
      ".mts",
      ".cts",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
    ]);
  });

  it("lists the declaration suffixes separately", () => {
    assert.deepEqual(DECLARATION_SUFFIXES, [".d.ts", ".d.mts", ".d.cts"]);
  });
});

describe("changedFiles: not a repository", () => {
  it("returns null, which is not the same as no changes", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    const root = scratchDir();
    write(root, "src/a.ts");
    assert.equal(await changedFiles(root, null, ["src"]), null);
  });

  it("reports no sha and a clean tree off a repository", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    const root = scratchDir();
    assert.equal(await gitSha(root), null);
    assert.equal(await gitDirty(root), false);
  });
});

describe("changedFiles: inside a repository", () => {
  it("returns an empty array, not null, when nothing changed", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    assert.deepEqual(await changedFiles(await repo(), null, ["src"]), []);
  });

  it("reports a modified tracked file", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    const root = await repo();
    write(root, "src/committed.ts", "export const x = 1;\n");
    assert.deepEqual(await changedFiles(root, null, ["src"]), [
      "src/committed.ts",
    ]);
  });

  it("reports an untracked new file, which git diff alone would miss", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    const root = await repo();
    write(root, "src/brand-new.ts");
    assert.deepEqual(await changedFiles(root, null, ["src"]), [
      "src/brand-new.ts",
    ]);
  });

  it("does not report a deleted file, which cannot be checked", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    const root = await repo();
    rmSync(join(root, "src/committed.ts"));
    assert.deepEqual(await changedFiles(root, null, ["src"]), []);
  });

  it("de-duplicates a file listed by both diff and ls-files", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    const root = await repo();
    write(root, "src/committed.ts", "export const x = 1;\n");
    write(root, "src/extra.ts");
    const files = await changedFiles(root, null, ["src"]);
    assert.ok(files !== null);
    assert.equal(new Set(files).size, files.length);
    assert.deepEqual([...files].sort(), ["src/committed.ts", "src/extra.ts"]);
  });
});

describe("changedFiles: filtering", () => {
  it("keeps only JavaScript/TypeScript source extensions", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    const root = await repo();
    for (const extension of SOURCE_EXTENSIONS) {
      write(root, `src/keep${extension}`);
    }
    write(root, "src/README.md", "# no\n");
    write(root, "src/data.json", "{}\n");
    write(root, "src/style.css", "a{}\n");

    const files = await changedFiles(root, null, ["src"]);
    assert.ok(files !== null);
    assert.deepEqual(
      [...files].sort(),
      SOURCE_EXTENSIONS.map((extension) => `src/keep${extension}`).sort(),
    );
  });

  it("excludes ambient declarations by default", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    const root = await repo();
    write(root, "src/types.d.ts", "export {};\n");
    write(root, "src/real.ts");
    assert.deepEqual(await changedFiles(root, null, ["src"]), ["src/real.ts"]);
  });

  it("includes ambient declarations when asked", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    const root = await repo();
    write(root, "src/types.d.ts", "export {};\n");
    const files = await changedFiles(root, null, ["src"], {
      includeDeclarations: true,
    });
    assert.deepEqual(files, ["src/types.d.ts"]);
  });

  it("restricts results to the allowed prefixes", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    const root = await repo();
    write(root, "src/in.ts");
    write(root, "scripts/out.ts");
    assert.deepEqual(await changedFiles(root, null, ["src"]), ["src/in.ts"]);
  });

  it("matches whole path segments, not string prefixes", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    // `srcfoo/` starts with `src` but is not under it. A naive startsWith
    // check would pull it in and check files the caller excluded.
    const root = await repo();
    write(root, "srcfoo/sneaky.ts");
    write(root, "src/legit.ts");
    assert.deepEqual(await changedFiles(root, null, ["src"]), ["src/legit.ts"]);
  });

  it("allows a file that IS an allowed path", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    const root = await repo();
    write(root, "single.ts");
    assert.deepEqual(await changedFiles(root, null, ["single.ts"]), ["single.ts"]);
  });

  it("allows nothing when the allowed list is empty", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    const root = await repo();
    write(root, "src/a.ts");
    assert.deepEqual(await changedFiles(root, null, []), []);
  });

  it("tolerates a trailing slash or `./` on an allowed prefix", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    const root = await repo();
    write(root, "src/a.ts");
    assert.deepEqual(await changedFiles(root, null, ["src/"]), ["src/a.ts"]);
    assert.deepEqual(await changedFiles(root, null, ["./src"]), ["src/a.ts"]);
  });
});

describe("changedFiles: --since", () => {
  it("reports what this branch changed, via merge-base", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    const root = await repo();
    await git(root, ["checkout", "-b", "feature"]);
    write(root, "src/feature.ts");
    await git(root, ["add", "."]);
    await git(root, [...COMMIT_FLAGS, "commit", "-m", "feature work"]);

    assert.deepEqual(await changedFiles(root, "main", ["src"]), [
      "src/feature.ts",
    ]);
    // Against HEAD there is nothing outstanding: the work is committed.
    assert.deepEqual(await changedFiles(root, null, ["src"]), []);
  });

  it("returns null for a ref that does not exist", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    // Better to say "cannot answer" than to silently diff against everything.
    assert.equal(await changedFiles(await repo(), "no-such-ref", ["src"]), null);
  });

  it("treats a shell-ish ref as one argument, never as a command", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    const root = await repo();
    const canary = join(root, "canary.txt");
    writeFileSync(canary, "intact\n");
    const result = await changedFiles(root, `main; rm -f ${canary}`, ["src"]);
    assert.equal(result, null, "git must reject the ref, not run it");
    assert.equal(
      await gitDirty(root),
      true,
      "the untracked canary must still exist",
    );
  });
});

/** `scanChanges`, asserted to have succeeded. */
async function scanned(root: string, since: string | null = null): Promise<ChangedPaths> {
  const scan = await scanChanges(root, since);
  assert.ok(scan.ok, `scanChanges failed: ${scan.ok ? "" : scan.message}`);
  return scan.paths;
}

describe("changedFiles: names git would otherwise mangle", () => {
  it("keeps a non-ASCII path, which core.quotePath used to hide", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    // THE SILENT LOSS. With `core.quotePath` on — the default — git renders
    // this name as `"src/caf\303\251.ts"`, quotes included. That string is not
    // a path on disk, so the file was dropped from the selection and
    // `--changed` reported a confident pass over a file it never looked at.
    const root = await repo();
    write(root, "src/café.ts");
    await git(root, ["add", "."]);
    await git(root, [...COMMIT_FLAGS, "commit", "-m", "unicode"]);
    write(root, "src/café.ts", "export const x = 1;\n");
    assert.deepEqual(await changedFiles(root, null, ["src"]), ["src/café.ts"]);
  });

  it("keeps a path with a space and one with a quote", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    const root = await repo();
    write(root, "src/two words.ts");
    write(root, 'src/it"s.ts');
    assert.deepEqual([...(await changedFiles(root, null, ["src"]) ?? [])].sort(), [
      'src/it"s.ts',
      "src/two words.ts",
    ]);
  });
});

describe("scanChanges: what changed, including what is gone", () => {
  it("reports nothing changed as an empty change set, not a failure", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    assert.deepEqual(await scanned(await repo()), { present: [], removed: [] });
  });

  it("separates a deletion from an edit", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    // A deleted file cannot be handed to a per-file tool, and must equally not
    // vanish: deleting the module half the tree imports is the change most
    // likely to break the build.
    const root = await repo();
    write(root, "src/other.ts");
    await git(root, ["add", "."]);
    await git(root, [...COMMIT_FLAGS, "commit", "-m", "second file"]);
    rmSync(join(root, "src/committed.ts"));
    const paths = await scanned(root);
    assert.deepEqual(paths.present, []);
    assert.deepEqual(paths.removed, ["src/committed.ts"]);
  });

  it("puts a rename's destination in present and its source in removed", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    const root = await repo();
    await git(root, ["mv", "src/committed.ts", "src/renamed.ts"]);
    const paths = await scanned(root);
    assert.deepEqual(paths.present, ["src/renamed.ts"]);
    assert.deepEqual(paths.removed, ["src/committed.ts"]);
  });

  it("includes untracked files, which git diff alone never sees", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    const root = await repo();
    write(root, "src/brand-new.ts");
    assert.deepEqual(await scanned(root), {
      present: ["src/brand-new.ts"],
      removed: [],
    });
  });

  it("reports every changed path, config files included", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    // Unfiltered on purpose: `tsconfig.json` is not a source file and still
    // changes what every gate concludes. The caller decides what counts.
    const root = await repo();
    write(root, "tsconfig.json", "{}\n");
    assert.deepEqual((await scanned(root)).present, ["tsconfig.json"]);
  });

  it("resolves --since through the merge base", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    const root = await repo();
    await git(root, ["checkout", "-q", "-b", "feature"]);
    write(root, "src/feature.ts");
    await git(root, ["add", "."]);
    await git(root, [...COMMIT_FLAGS, "commit", "-m", "feature work"]);
    assert.deepEqual((await scanned(root, "main")).present, ["src/feature.ts"]);
  });
});

describe("scanChanges: git failures carry git's own words", () => {
  it("says it is not a repository, rather than reporting no changes", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    const scan = await scanChanges(scratchDir(), null);
    assert.equal(scan.ok, false);
    assert.match(scan.ok ? "" : scan.message, /not a git repository/i);
  });

  it("refuses a repository with no commit rather than reporting no changes", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    // `git diff HEAD` has no HEAD to diff against here. The old code took the
    // failure as an empty diff and reported only untracked files, so anything
    // already staged was invisible to `--changed`.
    const root = scratchDir();
    await git(root, ["init", "--initial-branch=main"]);
    write(root, "src/a.ts");
    await git(root, ["add", "."]);
    const scan = await scanChanges(root, null);
    assert.equal(scan.ok, false);
    assert.match(scan.ok ? "" : scan.message, /git diff:/);
  });

  it("names the ref for an unknown --since, not the repository", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    // Two different mistakes with two different fixes. Flattening both into
    // "not a git repository" sends the reader to the wrong place.
    const scan = await scanChanges(await repo(), "no-such-ref");
    assert.equal(scan.ok, false);
    const message = scan.ok ? "" : scan.message;
    assert.match(message, /merge-base/);
    assert.doesNotMatch(message, /not a git repository/i);
  });
});

describe("selectSourceFiles", () => {
  it("keeps source files under the allowed prefixes, in order, de-duplicated", () => {
    const root = scratchDir();
    write(root, "src/a.ts");
    write(root, "src/b.tsx");
    write(root, "test/c.ts");
    write(root, "other/d.ts");
    write(root, "src/notes.md", "# no\n");
    const names = ["src/a.ts", "src/b.tsx", "src/a.ts", "test/c.ts", "other/d.ts", "src/notes.md"];
    assert.deepEqual(selectSourceFiles(root, names, ["src", "test"]), [
      "src/a.ts",
      "src/b.tsx",
      "test/c.ts",
    ]);
  });

  it("drops a name that is not on disk", () => {
    const root = scratchDir();
    write(root, "src/here.ts");
    assert.deepEqual(selectSourceFiles(root, ["src/here.ts", "src/gone.ts"], ["src"]), [
      "src/here.ts",
    ]);
  });

  it("keeps a name that is not on disk when the caller asks — the removed half", () => {
    const root = scratchDir();
    assert.deepEqual(
      selectSourceFiles(root, ["src/gone.ts", "src/gone.md"], ["src"], { mustExist: false }),
      ["src/gone.ts"],
    );
  });

  it("excludes ambient declarations unless asked", () => {
    const root = scratchDir();
    write(root, "src/types.d.ts");
    assert.deepEqual(selectSourceFiles(root, ["src/types.d.ts"], ["src"]), []);
    assert.deepEqual(
      selectSourceFiles(root, ["src/types.d.ts"], ["src"], { includeDeclarations: true }),
      ["src/types.d.ts"],
    );
  });
});

describe("gitSha and gitDirty", () => {
  it("returns a short sha inside a repository", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    const sha = await gitSha(await repo());
    assert.ok(sha !== null);
    assert.match(sha, /^[0-9a-f]{7,40}$/u);
  });

  it("reports a clean tree as not dirty", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    assert.equal(await gitDirty(await repo()), false);
  });

  it("reports an uncommitted change as dirty", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not installed");
      return;
    }
    const root = await repo();
    write(root, "src/committed.ts", "export const x = 1;\n");
    assert.equal(await gitDirty(root), true);
  });
});
