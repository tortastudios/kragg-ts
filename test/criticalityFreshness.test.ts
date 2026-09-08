/**
 * Tests for criticality staleness detection and derive-with-cache.
 *
 * THE BUG THESE PIN DOWN. Five gate modules were split into directories, every
 * qualified name in the call graph changed, and the file on disk still named
 * the old ones — so `test-quality` reported 35 findings when the truth was 2,
 * each naming a function that no longer existed. Nothing was broken; a gate
 * simply believed a cache nobody had validated.
 *
 * So the assertions come in two halves, and both are load-bearing:
 *
 *  1. A STALE FILE IS NEVER HANDED OUT. `readJson` is the one door every
 *     consumer walks through — the three gates, the Claude hook, `kragg map` —
 *     and it must return the empty list for a file it cannot vouch for, in
 *     every shape of "cannot vouch for" there is.
 *  2. STALE IS REPAIRED, NOT MERELY REFUSED. Refusing alone would make the
 *     criticality gates skip on every run in which anyone touched a file,
 *     which in an inner loop is every run. `ensure()` derives from the shared
 *     program — lazily, once, and never while a pipeline is only being
 *     assembled.
 *
 * mtimes are set explicitly with `utimesSync` wherever a test is about mtime.
 * Writing a file and hoping its timestamp lands in a later millisecond than
 * the one just recorded is how a suite acquires a flake.
 */

import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import ts from "typescript";

import { analysisProgram } from "../src/analysis/program.ts";
import { noCriticalityReason } from "../src/catalog/context.ts";
import { criticalityCache } from "../src/catalog/criticalityCache.ts";
import {
  criticalityFreshness,
  criticalityPath,
  readJson,
  STALE_CRITICALITY_REASON,
  writeStamp,
} from "../src/gates/criticality.ts";
// `scanSources` and `stampPath` are the walk's own internals, exercised here
// but named by no other module — so they stay off the public facade, whose
// symbol budget is what keeps it from accreting. See `gates/criticality.ts`.
import { scanSources, stampPath } from "../src/gates/criticality/freshness.ts";

const temporaryRoots: string[] = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "es2022",
    module: "nodenext",
    moduleResolution: "nodenext",
    strict: true,
    allowImportingTsExtensions: true,
    noEmit: true,
  },
  include: ["src/**/*.ts"],
});

/** A throwaway project with a tsconfig and whatever files a test names. */
function project(files: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-freshness-"));
  temporaryRoots.push(root);
  writeFileSync(join(root, "tsconfig.json"), TSCONFIG);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

/** Put a criticality file on disk without claiming anything about its age. */
function writeData(root: string, json = '[{"name": "src/a#hot"}]'): void {
  mkdirSync(join(root, ".kragg"), { recursive: true });
  writeFileSync(criticalityPath(root), json);
}

/** Move a file's mtime forward by a whole second, deterministically. */
function touchLater(path: string): void {
  const stats = statSync(path);
  const when = new Date(stats.mtimeMs + 1000);
  utimesSync(path, when, when);
}

describe("scanSources", () => {
  it("counts each file once however many times its tree is named", () => {
    // Overlapping entries are a realistic policy (`["src", "src/gates"]`), and
    // a double count would make the tree look permanently changed.
    const root = project({ "src/a.ts": "export const a = 1;\n" });
    const once = scanSources(root, ["src"]);
    const twice = scanSources(root, ["src", "src", "src/../src"]);
    assert.equal(once.files, 1);
    assert.deepEqual(twice, once);
  });

  it("ignores files that cannot contribute call-graph nodes", () => {
    const root = project({
      "src/a.ts": "export const a = 1;\n",
      "src/notes.md": "# not source\n",
      "src/data.json": "{}\n",
    });
    assert.equal(scanSources(root, ["src"]).files, 1);
  });

  it("skips node_modules and dot-directories, which churn and are not analyzed", () => {
    const root = project({
      "src/a.ts": "export const a = 1;\n",
      "src/node_modules/dep/index.ts": "export const d = 1;\n",
      "src/.cache/x.ts": "export const x = 1;\n",
    });
    assert.equal(scanSources(root, ["src"]).files, 1);
  });

  it("is total: a configured path that does not exist contributes nothing", () => {
    // "your source_paths names a missing directory" is a policy problem for
    // another gate to report, not a reason freshness cannot be judged.
    const root = project({ "src/a.ts": "export const a = 1;\n" });
    assert.deepEqual(scanSources(root, ["src", "nope"]), scanSources(root, ["src"]));
  });

  it("watches nested directories whose NAME happens to be a build-output name", () => {
    // THE BUG. This walk kept its own skip list and applied it by BASENAME AT
    // ANY DEPTH, so `src/coverage/` and `src/build/` — the first of which is a
    // real directory in this very repo — were invisible to it. Every file
    // under them could be edited, added or deleted and the data still read
    // "fresh". The walk is `analysis/walk.ts`'s now, which skips those names
    // only where they mean "generated": as children of the REPO ROOT.
    const root = project({
      "src/a.ts": "export const a = 1;\n",
      "src/coverage/model.ts": "export const model = 1;\n",
      "src/build/plan.ts": "export const plan = 1;\n",
      "src/out/emit.ts": "export const emit = 1;\n",
      "src/dist/bundle.ts": "export const bundle = 1;\n",
      "dist/generated.ts": "export const generated = 1;\n",
      "coverage/report.ts": "export const report = 1;\n",
    });
    assert.equal(scanSources(root, ["src"]).files, 5);
    // Under `["."]` the same names ARE generated output, and stay skipped.
    assert.equal(scanSources(root, ["."]).files, 5);
  });

  it("sees a same-size edit, which a count and a byte total cannot", () => {
    // `sed -i` swapping one character for another is a same-size edit, and the
    // old fingerprint (files, bytes, newest mtime) was blind to it whenever
    // the mtime did not move either.
    const root = project({ "src/a.ts": "export const a = 1;\n" });
    const path = join(root, "src", "a.ts");
    const when = new Date(Math.floor(statSync(path).mtimeMs));
    utimesSync(path, when, when);
    const before = scanSources(root, ["src"]);

    writeFileSync(path, "export const a = 2;\n");
    utimesSync(path, when, when);
    const after = scanSources(root, ["src"]);
    assert.equal(after.files, before.files);
    assert.equal(after.bytes, before.bytes, "the mutation must be same-size");
    assert.equal(after.newestMtimeMs, before.newestMtimeMs, "and same-mtime");
    assert.notEqual(after.digest, before.digest, "the content hash must see it");
  });

  it("hashes independently of the order the caller lists its paths in", () => {
    const root = project({
      "src/a.ts": "export const a = 1;\n",
      "test/a.test.ts": "export const t = 1;\n",
    });
    assert.equal(
      scanSources(root, ["src", "test"]).digest,
      scanSources(root, ["test", "src"]).digest,
    );
  });
});

describe("criticalityFreshness", () => {
  it("separates a file that was never generated from one that was outrun", () => {
    // Same remedy, different situations. A skip that says "no criticality
    // data" about a file sitting right there sends a user looking for it.
    const root = project({ "src/a.ts": "export const a = 1;\n" });
    assert.equal(criticalityFreshness(root), "missing");
    writeData(root);
    writeStamp(root, ["src"]);
    assert.equal(criticalityFreshness(root), "fresh");
  });

  it("judges an unstamped file by the mtime relation instead", () => {
    // This is the kragg-Python file, and the file written by any kragg-ts
    // predating the stamp. Both are permanent cases, not migrations, so the
    // answer cannot be a blanket "stale" — but it cannot be a blanket "fresh"
    // either. The weaker instrument: was any source touched after it?
    const root = project({ "src/a.ts": "export const a = 1;\n" });
    writeData(root);
    assert.equal(criticalityFreshness(root), "fresh");

    touchLater(join(root, "src", "a.ts"));
    assert.equal(criticalityFreshness(root), "stale");
  });

  it("does not call an unstamped file stale just because the repo was built", () => {
    // The unstamped walk has no declared paths, so it has to skip the
    // directories that are conventionally not source. Otherwise every compile
    // would trigger a re-derive.
    const root = project({ "src/a.ts": "export const a = 1;\n" });
    writeData(root);
    for (const ignored of ["node_modules/dep/index.js", "dist/a.js", "coverage/x.js"]) {
      const path = join(root, ignored);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "// generated\n");
      touchLater(path);
    }
    assert.equal(criticalityFreshness(root), "fresh");
  });

  it("prefers the stamp over the mtime relation once there is one", () => {
    // The stamp can see a deletion; the mtime relation cannot, because
    // removing a file leaves every remaining mtime exactly where it was.
    const root = project({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 1;\n",
    });
    writeData(root);
    rmSync(join(root, "src", "b.ts"));
    assert.equal(criticalityFreshness(root), "fresh");

    writeData(root);
    writeStamp(root, ["src"]);
    rmSync(join(root, "src", "a.ts"));
    assert.equal(criticalityFreshness(root), "stale");
  });

  it("notices a file added after the stamp", () => {
    // The bug that started this: modules split into directories, so the
    // qualified names in the graph all moved.
    const root = project({ "src/a.ts": "export const a = 1;\n" });
    writeData(root);
    writeStamp(root, ["src"]);
    writeFileSync(join(root, "src", "b.ts"), "export const b = 1;\n");
    assert.equal(criticalityFreshness(root), "stale");
  });

  it("notices a file deleted after the stamp", () => {
    // Deletion is why the count is tracked at all: removing a file can leave
    // the newest mtime exactly where it was.
    const root = project({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 1;\n",
    });
    writeData(root);
    writeStamp(root, ["src"]);
    rmSync(join(root, "src", "b.ts"));
    assert.equal(criticalityFreshness(root), "stale");
  });

  it("notices an in-place edit that changes neither the count nor the size", () => {
    // Same name, same byte count, new content: only the mtime moved.
    const root = project({ "src/a.ts": "export const a = 1;\n" });
    writeData(root);
    writeStamp(root, ["src"]);
    writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n");
    touchLater(join(root, "src", "a.ts"));
    assert.equal(criticalityFreshness(root), "stale");
  });

  it("notices a same-mtime edit that changes the size", () => {
    // The other direction: an editor that preserves timestamps still cannot
    // preserve the byte count.
    const root = project({ "src/a.ts": "export const a = 1;\n" });
    writeData(root);
    writeStamp(root, ["src"]);
    const path = join(root, "src", "a.ts");
    const before = statSync(path);
    writeFileSync(path, "export const a = 1;\nexport const b = 2;\n");
    utimesSync(path, new Date(before.mtimeMs), new Date(before.mtimeMs));
    assert.equal(criticalityFreshness(root), "stale");
  });

  it("notices an edit that changes neither the size nor the mtime", () => {
    // THE COARSE-METADATA HOLE. Files, bytes and newest-mtime were the whole
    // fingerprint, so a same-size edit made by a tool that preserves
    // timestamps — `sed -i` under a build system, a restore from an archive —
    // left all three numbers exactly where they were, and the data on disk
    // stayed "fresh" while describing a tree that no longer existed.
    const root = project({ "src/a.ts": "export const a = 1;\n" });
    const path = join(root, "src", "a.ts");
    // A whole-millisecond mtime, so restoring it below is exact rather than
    // truncated — `utimesSync` cannot express the sub-millisecond part a write
    // leaves behind, and a test about preserved timestamps must preserve them.
    const when = new Date(Math.floor(statSync(path).mtimeMs));
    utimesSync(path, when, when);
    const before = statSync(path);

    writeData(root);
    writeStamp(root, ["src"]);
    assert.equal(criticalityFreshness(root), "fresh");

    writeFileSync(path, "export const a = 2;\n");
    utimesSync(path, when, when);
    const after = statSync(path);
    assert.equal(after.size, before.size, "the mutation must be same-size");
    assert.equal(after.mtimeMs, before.mtimeMs, "and must preserve the mtime");

    assert.equal(criticalityFreshness(root), "stale");
  });

  it("watches a nested directory named like a build output", () => {
    // `src/coverage/` is a real directory in this repo, and the old walk's own
    // skip list ate it by name at any depth: edits, additions and deletions
    // under it were all invisible.
    const root = project({
      "src/a.ts": "export const a = 1;\n",
      "src/coverage/model.ts": "export const model = 1;\n",
    });
    writeData(root);
    writeStamp(root, ["src"]);
    assert.equal(criticalityFreshness(root), "fresh");

    writeFileSync(join(root, "src", "coverage", "model.ts"), "export const model = 2;\n");
    assert.equal(criticalityFreshness(root), "stale");

    writeData(root);
    writeStamp(root, ["src"]);
    rmSync(join(root, "src", "coverage", "model.ts"));
    assert.equal(criticalityFreshness(root), "stale", "a deletion under it too");
  });

  it("watches the analysis inputs that are not source files", () => {
    // The policy decides which paths are analyzed, the tsconfig decides which
    // files are in the program at all. Either can move the call graph without
    // a single source byte changing, so neither may be outside the
    // fingerprint. Each case re-stamps first, so a failure names itself.
    const root = project({ "src/a.ts": "export const a = 1;\n" });
    for (const [name, changed] of [
      ["kragg.json", '{"source_paths": ["src", "lib"]}\n'],
      ["tsconfig.json", `${TSCONFIG}\n`],
      ["package.json", '{"kragg": {"max_file_lines": 400}}\n'],
      ["package.json", '{"kragg": {"max_file_lines": 300}}\n'],
    ] as const) {
      writeData(root);
      writeStamp(root, ["src"]);
      assert.equal(criticalityFreshness(root), "fresh", name);
      writeFileSync(join(root, name), changed);
      assert.equal(criticalityFreshness(root), "stale", name);
    }
  });

  it("reads a stamp of an unknown version as stale, not as an mtime question", () => {
    // Every kragg-ts before the content hash wrote `version: 1`, whose numbers
    // this build cannot verify. Falling back to the mtime relation — the
    // instrument reserved for a file NOBODY stamped — would let that older
    // claim buy freshness anyway. It does not crash on it either.
    const root = project({ "src/a.ts": "export const a = 1;\n" });
    writeData(root);
    writeFileSync(
      stampPath(root),
      JSON.stringify({
        version: 1,
        scan_paths: ["src"],
        files: 1,
        bytes: 20,
        newest_mtime_ms: statSync(join(root, "src", "a.ts")).mtimeMs,
      }),
    );
    assert.equal(criticalityFreshness(root), "stale");
  });

  it("watches the paths the stamp names, tests included", () => {
    // Tests are in the program, so they contribute nodes, so an edit to one
    // really can change the answer.
    const root = project({
      "src/a.ts": "export const a = 1;\n",
      "test/a.test.ts": "export const t = 1;\n",
    });
    writeData(root);
    writeStamp(root, ["src", "test"]);
    assert.equal(criticalityFreshness(root), "fresh");
    writeFileSync(join(root, "test", "b.test.ts"), "export const u = 1;\n");
    assert.equal(criticalityFreshness(root), "stale");
  });

  it("does not read an unusable stamp as evidence of anything", () => {
    // A half-written or future-version stamp is not a stamp. It falls through
    // to the mtime relation, which here has already been outrun.
    const root = project({ "src/a.ts": "export const a = 1;\n" });
    writeData(root);
    touchLater(join(root, "src", "a.ts"));
    for (const stamp of [
      "{ not json",
      "[]",
      "null",
      '{"version": 2, "scan_paths": ["src"], "files": 1, "bytes": 1, "newest_mtime_ms": 1}',
      '{"version": 1, "scan_paths": ["src"], "files": 1, "bytes": 1}',
      '{"version": 1, "scan_paths": "src", "files": 1, "bytes": 1, "newest_mtime_ms": 1}',
      '{"version": 1, "scan_paths": [1], "files": 1, "bytes": 1, "newest_mtime_ms": 1}',
      '{"version": 1, "scan_paths": ["src"], "files": "1", "bytes": 1, "newest_mtime_ms": 1}',
    ]) {
      writeFileSync(stampPath(root), stamp);
      assert.equal(criticalityFreshness(root), "stale", stamp);
    }
  });

  it("says missing, not stale, when the stamp outlives the data", () => {
    const root = project({ "src/a.ts": "export const a = 1;\n" });
    writeData(root);
    writeStamp(root, ["src"]);
    rmSync(criticalityPath(root));
    assert.equal(criticalityFreshness(root), "missing");
  });
});

describe("readJson refuses what freshness will not vouch for", () => {
  it("hands out records only when the data matches the tree", () => {
    const root = project({ "src/a.ts": "export const a = 1;\n" });
    writeData(root);
    writeStamp(root, ["src"]);
    assert.deepEqual(readJson(root), [{ name: "src/a#hot" }]);

    // The 35-findings bug, in miniature: a new module appears, so every name
    // the file records may have moved. Not one record escapes.
    writeFileSync(join(root, "src", "b.ts"), "export const b = 1;\n");
    assert.deepEqual(readJson(root), []);
  });

  it("refuses an unstamped file the sources have outrun", () => {
    const root = project({ "src/a.ts": "export const a = 1;\n" });
    writeData(root);
    assert.deepEqual(readJson(root), [{ name: "src/a#hot" }]);
    touchLater(join(root, "src", "a.ts"));
    assert.deepEqual(readJson(root), []);
  });

  it("still degrades to empty for the malformed cases, stamp or no stamp", () => {
    const root = project({ "src/a.ts": "export const a = 1;\n" });
    writeData(root, "{ not json");
    writeStamp(root, ["src"]);
    assert.deepEqual(readJson(root), []);
  });

  it("offers a stale reason that names the remedy", () => {
    // A skip that does not say how to un-skip itself trains people to ignore
    // skips; one that misdescribes why is worse.
    assert.match(STALE_CRITICALITY_REASON, /kragg criticality --write/u);
    assert.match(STALE_CRITICALITY_REASON, /stale/u);
  });
});

describe("derive-with-cache", () => {
  const FIXTURE: Readonly<Record<string, string>> = {
    "src/a.ts": [
      "export function leaf(): number {",
      "  return 1;",
      "}",
      "export function middle(): number {",
      "  return leaf() + leaf();",
      "}",
      "export function top(): number {",
      "  return middle();",
      "}",
      "",
    ].join("\n"),
  };

  function cacheFor(root: string): ReturnType<typeof criticalityCache> {
    return criticalityCache({
      root,
      scanPaths: ["src"],
      analysis: analysisProgram({ root, api: ts }),
    });
  }

  it("does not touch the program until ensure() is called", () => {
    // The whole laziness contract: a run where no criticality-dependent gate
    // fires must not pay for a call graph, or for the program under it.
    const root = project(FIXTURE);
    const analysis = analysisProgram({ root, api: ts });
    const cache = criticalityCache({ root, scanPaths: ["src"], analysis });
    assert.equal(analysis.loaded(), false);
    cache.ensure();
    assert.equal(analysis.loaded(), true);
  });

  it("derives the data when there is none, so the gates run", () => {
    const root = project(FIXTURE);
    assert.equal(criticalityFreshness(root), "missing");
    cacheFor(root).ensure();
    assert.equal(criticalityFreshness(root), "fresh");
    const names = readJson(root).map((record) => record["name"]);
    assert.ok(names.includes("src/a#leaf"), JSON.stringify(names));
  });

  it("regenerates data the tree has outrun, under the CURRENT names", () => {
    // The bug, reproduced and then fixed: `middle` moves to another module,
    // and the entry naming it where it used to live must not survive.
    const root = project(FIXTURE);
    cacheFor(root).ensure();
    assert.ok(readJson(root).some((record) => record["name"] === "src/a#middle"));

    writeFileSync(
      join(root, "src", "a.ts"),
      ["export function leaf(): number {", "  return 1;", "}", ""].join("\n"),
    );
    writeFileSync(
      join(root, "src", "b.ts"),
      [
        'import { leaf } from "./a.ts";',
        "export function middle(): number {",
        "  return leaf() + leaf();",
        "}",
        "",
      ].join("\n"),
    );
    assert.equal(criticalityFreshness(root), "stale");
    // Refused before it is repaired: no consumer sees the old names even for
    // the instant between the edit and the next derivation.
    assert.deepEqual(readJson(root), []);

    cacheFor(root).ensure();
    const names = readJson(root).map((record) => record["name"]);
    assert.ok(names.includes("src/b#middle"), JSON.stringify(names));
    assert.ok(!names.includes("src/a#middle"), JSON.stringify(names));
  });

  it("derives at most once per run, even across three gates", () => {
    const root = project(FIXTURE);
    const cache = cacheFor(root);
    cache.ensure();
    const first = statSync(criticalityPath(root)).mtimeMs;
    touchLater(criticalityPath(root));
    const touched = statSync(criticalityPath(root)).mtimeMs;
    cache.ensure();
    cache.ensure();
    // Untouched by the repeat calls: the memo, not a second identical write.
    assert.equal(statSync(criticalityPath(root)).mtimeMs, touched);
    assert.ok(touched > first);
  });

  it("leaves fresh data alone rather than rewriting it", () => {
    const root = project(FIXTURE);
    cacheFor(root).ensure();
    touchLater(criticalityPath(root));
    const when = statSync(criticalityPath(root)).mtimeMs;
    cacheFor(root).ensure();
    assert.equal(statSync(criticalityPath(root)).mtimeMs, when);
  });

  it("builds no program at all when the data is already fresh", () => {
    // The laziness half of the same fact: `ensure()` answers the freshness
    // question BEFORE it touches the handle, so `kragg map` at session start
    // on an up-to-date repo compiles nothing. This is the assertion
    // `map.test.ts` used to make by seeding a process-global handle cache,
    // which no longer exists — the run owns its program.
    const root = project(FIXTURE);
    cacheFor(root).ensure();
    assert.equal(criticalityFreshness(root), "fresh");

    const analysis = analysisProgram({ root, api: ts });
    criticalityCache({ root, scanPaths: ["src"], analysis }).ensure();
    assert.equal(analysis.loaded(), false);
  });

  it("never reports data it could not write as fresh", () => {
    // A read-only `.kragg` is a legitimate state — a checked-out artifact
    // directory, a container with a read-only mount. What it may NEVER become
    // is a pass on stale data: the derivation cannot land, so the file on disk
    // is still the one the edit outran, and every consumer must keep refusing
    // it and keep saying why.
    if (process.getuid?.() === 0) {
      return; // root ignores the mode bits, so there is nothing to observe.
    }
    const root = project(FIXTURE);
    cacheFor(root).ensure();
    const derived = readFileSync(criticalityPath(root), "utf8");
    // A new FUNCTION, so a derivation that landed would be visible in the file
    // as a record naming it — the assertion below is about a write that did
    // not happen, not about two identical writes.
    writeFileSync(
      join(root, "src", "b.ts"),
      "export function extra(): number {\n  return 1;\n}\n",
    );
    assert.equal(criticalityFreshness(root), "stale");

    chmodSync(criticalityPath(root), 0o400);
    chmodSync(stampPath(root), 0o400);
    chmodSync(join(root, ".kragg"), 0o500);
    try {
      cacheFor(root).ensure();
      assert.equal(readFileSync(criticalityPath(root), "utf8"), derived, "nothing was written");
      assert.doesNotMatch(derived, /src\/b#extra/u);
      assert.equal(criticalityFreshness(root), "stale");
      assert.deepEqual(readJson(root), [], "no consumer may see the outrun records");
      assert.equal(noCriticalityReason(root), STALE_CRITICALITY_REASON);
    } finally {
      chmodSync(join(root, ".kragg"), 0o700);
      chmodSync(criticalityPath(root), 0o600);
      chmodSync(stampPath(root), 0o600);
    }
  });

  it("writes nothing when the program cannot be built, and claims nothing", () => {
    // Fail closed with no second code path: the derivation failed, so the
    // file stays whatever it was, and freshness still refuses it.
    const root = mkdtempSync(join(tmpdir(), "kragg-freshness-"));
    temporaryRoots.push(root);
    writeData(root);
    writeStamp(root, ["src"]);
    // Stamped over an empty tree, then given a file: definitively stale, and
    // with no tsconfig there is no program to re-derive it from.
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    assert.equal(criticalityFreshness(root), "stale");

    cacheFor(root).ensure();
    assert.equal(criticalityFreshness(root), "stale");
    assert.deepEqual(readJson(root), []);
  });

  it("does not write CRITICALITY.md, which is a tracked human document", () => {
    // Rewriting it during an unrelated `check` would put a diff in front of
    // someone who asked for a gate result.
    const root = project(FIXTURE);
    cacheFor(root).ensure();
    assert.throws(() => statSync(join(root, "CRITICALITY.md")));
  });

  it("survives a `.kragg` it cannot write, and still claims nothing", () => {
    // A read-only checkout, reproduced by making `.kragg` un-creatable: a
    // plain file sits where the directory would go, so `mkdirSync` fails.
    // Every gate that does not write must still run, and — the part that
    // matters — nothing may be stamped, because a stamp with no data behind
    // it is exactly the false `fresh` this module exists to prevent.
    const root = project(FIXTURE);
    writeFileSync(join(root, ".kragg"), "not a directory");

    assert.doesNotThrow(() => cacheFor(root).ensure());

    assert.equal(statSync(join(root, ".kragg")).isFile(), true, "the blocker is untouched");
    assert.equal(criticalityFreshness(root), "missing");
    assert.deepEqual(readJson(root), []);
  });
});

describe("writeStamp when the stamp cannot be written", () => {
  it("swallows the write failure instead of taking the run down with it", () => {
    // Same read-only shape as above, but on `writeStamp` directly: a stamp is
    // an optimization, and failing to record one must never be fatal. The
    // next run simply re-derives.
    const root = project({ "src/a.ts": "export const a = 1;\n" });
    writeFileSync(join(root, ".kragg"), "not a directory");

    assert.doesNotThrow(() => writeStamp(root, ["src"]));

    assert.equal(statSync(join(root, ".kragg")).isFile(), true);
    // No stamp may be left behind: there is nothing for it to vouch for.
    assert.throws(() => statSync(stampPath(root)));
  });

  it("writes the stamp normally when the directory can be created", () => {
    const root = project({ "src/a.ts": "export const a = 1;\n" });
    writeStamp(root, ["src"]);
    const stamp: unknown = JSON.parse(readFileSync(stampPath(root), "utf8"));
    assert.ok(typeof stamp === "object" && stamp !== null);
    const record: Readonly<Record<string, unknown>> = { ...stamp };
    assert.equal(record["version"], 2); // STAMP_VERSION: content-hash stamps since TOR-1366
    assert.deepEqual(record["scan_paths"], ["src"]);
    assert.equal(record["files"], 1);
  });
});
