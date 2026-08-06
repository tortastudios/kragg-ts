/**
 * Is `.kragg/criticality.json` still describing THIS source tree?
 *
 * ── THE BUG THIS EXISTS TO CLOSE ───────────────────────────────────────────
 * Criticality data is a CACHE OF A DERIVED FACT, and until this module existed
 * nothing checked whether the fact had moved. Five gate modules were split
 * into directories, which changed every qualified name in the call graph
 * (`src/gates/criticality#buildCallGraph` became
 * `src/gates/criticality/graph#buildCallGraph`). The file on disk still named
 * the old functions, so `test-quality` reported 35 findings when the truth was
 * 2 — every one of them naming a function that no longer existed under that
 * name. Nothing was broken; the gate simply believed a stale file.
 *
 * A gate that reports confidently on data it never validated is the exact
 * failure shape kragg is built to refuse, so the rule here is absolute: A
 * STALE FILE IS NEVER SILENTLY TRUSTED. `readJson` consults this module and
 * degrades to the empty list, which is the state a repo that has never run the
 * analysis is already in and which every consumer already handles.
 *
 * ── HOW STALENESS IS DETECTED, AND WHY THIS WAY ────────────────────────────
 * The gates that read criticality data run in the INNER LOOP, so the check
 * must not rebuild the call graph to decide whether the call graph is out of
 * date — that would cost exactly what it is trying to avoid. So the check is a
 * directory walk: the newest mtime, the file count and the total byte size of
 * the analyzed sources, compared against the same three numbers recorded when
 * the data was written.
 *
 *  - NEWEST MTIME catches an edit to any existing file.
 *  - FILE COUNT catches a deletion, and an addition whose mtime somehow does
 *    not exceed the recorded one.
 *  - TOTAL BYTES is a third cheap axis: a same-size, same-count, same-mtime
 *    tree is the same tree for this purpose.
 *
 * All three come from one `readdirSync`+`statSync` pass over the configured
 * paths — single-digit milliseconds on a repo of this size, against the ~1s a
 * graph rebuild costs. It is DELIBERATELY NOT MEMOIZED: `readJson` is called a
 * handful of times per run, the pipeline REWRITES the file mid-run when it
 * derives, and a cache that had to be invalidated on that write would be a
 * second source of truth about freshness.
 *
 * FALSE STALE IS THE SAFE DIRECTION and is the only direction this errs in. A
 * `git checkout` rewrites mtimes and makes everything look stale; the cost is
 * one rebuild, and the answer stays correct. False FRESH is the failure that
 * matters, and the only way to reach it is a tree that changed without
 * changing its newest mtime, its file count or its total size.
 *
 * ── WHY A SIDECAR AND NOT A FIELD IN THE JSON ──────────────────────────────
 * `.kragg/criticality.json` is a CROSS-LANGUAGE WIRE FORMAT: kragg-Python's
 * `read_json` reads the same file, and its top level is a LIST. There is no
 * place in a list to put a metadata object that Python would not hand straight
 * back to its callers as a profile record —
 * `[entry for entry in data if isinstance(entry, dict)]` keeps any object it
 * finds, and a record with no `name` would flow into gates that expect one.
 * Adding the fingerprint to all N records instead would repeat one whole-tree
 * fact N times and still change what Python reads.
 *
 * So the stamp is a SEPARATE FILE, `.kragg/criticality.stamp.json`, and
 * `criticality.json` stays byte-identical to what both tools already write.
 * That is additive in the strongest available sense: Python's reader is not
 * merely still able to parse our file, it cannot observe the change at all.
 *
 * ── THE UNSTAMPED FALLBACK ─────────────────────────────────────────────────
 * A criticality file with no stamp beside it is a real and permanent case, not
 * a migration: kragg-Python writes one, and so did every kragg-ts before this
 * module. Treating it as stale outright would mean re-deriving — and
 * overwriting a polyglot repo's Python-authored data — on every single run.
 *
 * So an unstamped file is judged by the WEAKER instrument that needs no
 * cooperation from whoever wrote it: the newest source mtime anywhere in the
 * repo, against the criticality file's OWN mtime. Any source touched after the
 * data was written makes it stale. That is coarser — it cannot see a deletion
 * that left the newest mtime alone, and it has to guess at the source set —
 * but it is a real check, and the rule that matters holds either way: NOTHING
 * IS TRUSTED WITHOUT BEING CHECKED. Deriving once replaces the guess with a
 * stamp, and every run after that uses the precise path.
 *
 * TWO KNOWN GAPS, stated rather than papered over:
 *
 *  1. The stamped walk covers the paths the POLICY declares (sources plus
 *     tests, since both are in the program and both contribute nodes), not the
 *     tsconfig's own `include`. Editing the tsconfig to pull in a directory
 *     the policy does not name changes the graph without changing the stamp.
 *     The fix is for the policy and the tsconfig to agree, which every other
 *     gate already assumes.
 *  2. The unstamped walk has no declared paths at all, so it skips the
 *     directories that are conventionally not source — `node_modules`, build
 *     output, dot-directories. A repo that builds INTO its source tree would
 *     have its generated files ignored by that walk. It would still be caught
 *     the moment anything writes a stamp.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The journal directory both siblings write into. */
const JOURNAL_DIR = ".kragg";

/** Where {@link import("./report.ts").readJson} looks, and where a caller should write. */
export function criticalityPath(root: string): string {
  return join(root, JOURNAL_DIR, "criticality.json");
}

/** Where the freshness stamp for {@link criticalityPath} lives. */
export function stampPath(root: string): string {
  return join(root, JOURNAL_DIR, "criticality.stamp.json");
}

/**
 * What a reader may conclude about the criticality file on disk.
 *
 * `"missing"` and `"stale"` are kept apart because they have DIFFERENT
 * REMEDIES to print at a human — one has never been generated, the other has
 * been outrun — even though both mean the same thing to a consumer: there is
 * no data here you may use.
 */
export type Freshness = "fresh" | "missing" | "stale";

/**
 * The skip reason for data that exists but no longer describes the tree.
 *
 * Phrased like `NO_CRITICALITY_REASON`, and for the same reason: a skip that
 * does not say how to un-skip itself trains people to ignore skips.
 */
export const STALE_CRITICALITY_REASON =
  "stale criticality data — the sources changed since it was written " +
  "(run `kragg criticality --write`)";

/** Extensions that contribute nodes to the call graph. */
const SOURCE_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/**
 * Directory names never descended into.
 *
 * `node_modules` and dot-directories are not analyzed and churn constantly.
 * The build outputs are here for the UNSTAMPED walk, which has no declared
 * paths and would otherwise call a repo stale every time it was compiled —
 * the same names every tsconfig `exclude` and `.gitignore` already carries.
 * A path named EXPLICITLY by a caller is still walked: this filter applies to
 * descendants, never to a scan root.
 */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
]);

/**
 * The part of a `Dirent` this walk uses.
 *
 * Named rather than written inline so the local annotation stays inside the
 * `type-complexity` budget, and structural so it needs no `node:fs` type
 * import: `readdirSync(..., { withFileTypes: true })` satisfies it.
 */
interface DirectoryEntry {
  readonly name: string;
  readonly isDirectory: () => boolean;
}

/** The three numbers that stand in for "which tree was this derived from". */
export interface SourceScan {
  readonly files: number;
  readonly bytes: number;
  readonly newestMtimeMs: number;
}

/**
 * Walk `paths` and reduce them to a {@link SourceScan}.
 *
 * Files are counted by ABSOLUTE PATH through a set, so overlapping or repeated
 * entries (`["src", "src/gates"]`) contribute once rather than twice — a
 * double count would make the tree look permanently changed. `node_modules`
 * and dot-directories are skipped: neither is analyzed, and both churn.
 *
 * TOTAL: an unreadable path contributes nothing rather than throwing. A
 * configured directory that does not exist is a policy problem for another
 * gate to report, not a reason freshness cannot be judged.
 */
export function scanSources(root: string, paths: readonly string[]): SourceScan {
  const seen = new Set<string>();
  let bytes = 0;
  let newestMtimeMs = 0;
  const visit = (absolute: string): void => {
    let entries: readonly DirectoryEntry[];
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) {
          visit(child);
        }
        continue;
      }
      if (!SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
        continue;
      }
      if (seen.has(child)) {
        continue;
      }
      seen.add(child);
      try {
        const stats = statSync(child);
        bytes += stats.size;
        newestMtimeMs = Math.max(newestMtimeMs, stats.mtimeMs);
      } catch {
        // Vanished between readdir and stat. The count already moved, which is
        // enough to mark the tree changed.
      }
    }
  };
  for (const path of paths) {
    visit(resolve(root, path));
  }
  return { files: seen.size, bytes, newestMtimeMs };
}

/**
 * Record the tree that the criticality file currently on disk describes.
 *
 * Called by whoever just wrote `criticality.json` — `kragg criticality
 * --write` and the check pipeline's derive-with-cache — and by nobody else.
 * Writing a stamp without writing the data it stamps would assert freshness
 * about a file that was never regenerated.
 *
 * Failure is swallowed, matching how the pipeline treats its `.kragg` mkdir: a
 * read-only checkout still gets to run every gate, and a missing stamp only
 * means the next run re-derives.
 */
export function writeStamp(root: string, paths: readonly string[]): void {
  const scan = scanSources(root, paths);
  const payload = {
    version: 1,
    scan_paths: [...paths],
    files: scan.files,
    bytes: scan.bytes,
    newest_mtime_ms: scan.newestMtimeMs,
  };
  try {
    mkdirSync(join(root, JOURNAL_DIR), { recursive: true });
    writeFileSync(stampPath(root), `${JSON.stringify(payload, null, 1)}\n`, "utf8");
  } catch {
    // Deliberately swallowed: see above.
  }
}

/** A stamp read back from disk, once every field has been checked. */
interface Stamp {
  readonly paths: readonly string[];
  readonly files: number;
  readonly bytes: number;
  readonly newestMtimeMs: number;
}

/**
 * May the criticality file on disk be believed?
 *
 * Two instruments, and which one is used depends only on whether whoever wrote
 * the data left a stamp:
 *
 *  - STAMPED: the recorded count, size and newest mtime over the recorded
 *    paths. Precise, and the only one that can see a deletion.
 *  - UNSTAMPED: the newest source mtime anywhere in the repo against the
 *    data file's own mtime. Coarser, needs no cooperation, and is what makes
 *    a kragg-Python file judgeable at all. See the module header.
 *
 * A stamp that is unparseable, of a version this build does not know, or
 * missing any field is not a stamp: it falls through to the mtime relation
 * rather than being read as evidence of freshness.
 */
export function criticalityFreshness(root: string): Freshness {
  const dataMtimeMs = mtimeOf(criticalityPath(root));
  if (dataMtimeMs === null) {
    return "missing";
  }
  const stamp = readStamp(root);
  if (stamp === null) {
    return scanSources(root, ["."]).newestMtimeMs <= dataMtimeMs ? "fresh" : "stale";
  }
  const scan = scanSources(root, stamp.paths);
  const unchanged =
    scan.files === stamp.files &&
    scan.bytes === stamp.bytes &&
    scan.newestMtimeMs <= stamp.newestMtimeMs;
  return unchanged ? "fresh" : "stale";
}

/** A file's mtime, or `null` when it is not there to have one. */
function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Parse the stamp, or `null` for anything that is not a complete one. */
function readStamp(root: string): Stamp | null {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(stampPath(root), "utf8"));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const record: Readonly<Record<string, unknown>> = { ...data };
  if (record["version"] !== 1) {
    return null;
  }
  const paths = stringList(record["scan_paths"]);
  const files = finiteNumber(record["files"]);
  const bytes = finiteNumber(record["bytes"]);
  const newestMtimeMs = finiteNumber(record["newest_mtime_ms"]);
  if (paths === null || files === null || bytes === null || newestMtimeMs === null) {
    return null;
  }
  return { paths, files, bytes, newestMtimeMs };
}

function stringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return null;
    }
    items.push(item);
  }
  return items;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
