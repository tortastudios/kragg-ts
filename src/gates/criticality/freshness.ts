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
 * ── WHAT THE FINGERPRINT COVERS, AND WHY THAT SET ──────────────────────────
 * The answer this module gives must be a function of everything the analysis
 * READS. Anything the analysis reads that the fingerprint does not watch is a
 * way for the data to be wrong while this module says "fresh", which is the
 * one direction that is not allowed to happen. So the fingerprint is:
 *
 *  - THE SOURCE TREE, walked with `analysis/walk.ts` — the SAME walk the
 *    syntax tier uses — and hashed. Not "the same rules, restated": the same
 *    function, because a second copy of a skip list is a second answer to
 *    "which files are ours", and this module had one. Its private list matched
 *    `dist`/`build`/`out`/`coverage` BY NAME AT ANY DEPTH, so this repo's own
 *    `src/coverage/` (and any `src/build/`) was invisible to it: every file
 *    under it could be edited, added or deleted and the data stayed "fresh".
 *    `walk.ts` skips those names only as immediate children of the REPO ROOT,
 *    which is the only place they mean "generated".
 *  - A CONTENT HASH, not a size and an mtime. Counting files and summing bytes
 *    cannot see a same-size edit, and comparing the newest mtime cannot see an
 *    editor or a checkout that preserves timestamps. Both happen; `sed -i`
 *    swapping one character for another is a same-size edit, and the two
 *    together were enough to keep a genuinely changed tree reading as fresh.
 *    Hashing the bytes has no such blind spot, and it is cheap: MEASURED at
 *    ~6 ms over this repo's 214 source and test files (~2 MB), up from ~1 ms
 *    for the old three numbers, against the ~1s a graph rebuild costs.
 *  - THE OTHER ANALYSIS INPUTS: `kragg.json` and `package.json#kragg` (which
 *    decide the paths and the thresholds), `tsconfig.json` (which decides
 *    which files are in the program at all), and the RESOLVED COMPILER's
 *    version and path (which decides how they parse). None of these lives
 *    under the source paths, and each of them can change the graph on its own.
 *
 * Count and total size are still recorded and compared. They are redundant
 * against the hash and are cheap; they make a mismatch legible to a human
 * reading the stamp.
 *
 * It is DELIBERATELY NOT MEMOIZED: `readJson` is called a handful of times per
 * run, the pipeline REWRITES the file mid-run when it derives, and a cache
 * that had to be invalidated on that write would be a second source of truth
 * about freshness.
 *
 * FALSE STALE IS THE SAFE DIRECTION and is the only direction this errs in. A
 * `git checkout` that restores different bytes makes everything look stale;
 * the cost is one rebuild, and the answer stays correct. False FRESH is the
 * failure that matters.
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
 * The stamp's own shape is internal and versioned; a stamp of any other
 * version is not read as evidence of anything (see below).
 *
 * ── THE UNSTAMPED FALLBACK ─────────────────────────────────────────────────
 * A criticality file with NO STAMP BESIDE IT is a real and permanent case, not
 * a migration: kragg-Python writes one. Treating it as stale outright would
 * mean re-deriving — and overwriting a polyglot repo's Python-authored data —
 * on every single run. So an unstamped file is judged by the WEAKER instrument
 * that needs no cooperation from whoever wrote it: the newest source mtime
 * anywhere in the repo, against the criticality file's OWN mtime.
 *
 * A stamp that IS there but cannot be read — unparseable, a version this build
 * does not know, a missing field — is a different case and gets a different
 * answer: STALE, full stop. Something wrote a stamp, so the mtime relation is
 * not the instrument that applies; falling back to it would let an older
 * build's stamp buy freshness from a fingerprint this build no longer trusts.
 *
 * REMAINING GAPS, stated rather than papered over:
 *
 *  1. The walk covers the paths the POLICY declares (sources plus tests, since
 *     both are in the program and both contribute nodes), not the tsconfig's
 *     own `include`. The tsconfig's BYTES are now in the fingerprint, so
 *     editing it invalidates — but a file appearing inside a directory only
 *     the tsconfig names, with the tsconfig unchanged, is still not seen. The
 *     fix is for the policy and the tsconfig to agree, which every other gate
 *     already assumes.
 *  2. A `tsconfig.json` that `extends` another file watches only its own
 *     bytes, not the base's.
 *  3. The compiler is fingerprinted by the version and path `resolveTypeScript`
 *     reports. A compiler replaced in place, at the same path and with the same
 *     `version` string, is not distinguishable from the old one.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { resolveTypeScript } from "../../analysis/sourceFile.ts";
import { walkFiles } from "../../analysis/walk.ts";

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
 * Files outside the source tree whose bytes the analysis depends on.
 *
 * `kragg.json` decides which paths are analyzed and where the thresholds sit;
 * `tsconfig.json` decides which files end up in the program and how they are
 * parsed. Either can change the call graph without a single source byte
 * moving. `package.json#kragg` is watched too, separately, because the rest of
 * `package.json` churns for reasons that have nothing to do with analysis.
 */
const INPUT_FILES: readonly string[] = ["kragg.json", "tsconfig.json"];

/** Bumped whenever the fingerprint changes meaning; older stamps read stale. */
const STAMP_VERSION = 2;

/** What the tree looked like: three legible numbers and one exact one. */
export interface SourceScan {
  readonly files: number;
  readonly bytes: number;
  readonly newestMtimeMs: number;
  /** Hash over every walked file's repo-relative path and bytes. */
  readonly digest: string;
}

/**
 * Walk `paths` and reduce them to a {@link SourceScan}.
 *
 * The walk is `analysis/walk.ts`'s, so the file set is by construction the one
 * the syntax tier analyzes: `node_modules`, `.git` and dot-directories are
 * skipped wherever they occur, build-output NAMES only at the repo root, and
 * declaration files not at all. Files are gathered by ABSOLUTE PATH through a
 * set, so overlapping or repeated entries (`["src", "src/gates"]`) contribute
 * once rather than twice — a double count would make the tree look permanently
 * changed — and hashed in sorted order so the digest does not depend on the
 * order the caller happened to list its paths in.
 *
 * TOTAL: an unreadable path contributes nothing rather than throwing. A
 * configured directory that does not exist is a policy problem for another
 * gate to report, not a reason freshness cannot be judged.
 */
export function scanSources(root: string, paths: readonly string[]): SourceScan {
  const absoluteRoot = resolve(root);
  const seen = new Set<string>();
  for (const path of paths) {
    const base = resolve(absoluteRoot, path);
    for (const file of walkFiles(base, SOURCE_EXTENSIONS, false, absoluteRoot)) {
      seen.add(file);
    }
  }
  const hash = createHash("sha256");
  let bytes = 0;
  let newestMtimeMs = 0;
  for (const file of [...seen].sort()) {
    try {
      const stats = statSync(file);
      const content = readFileSync(file);
      bytes += stats.size;
      newestMtimeMs = Math.max(newestMtimeMs, stats.mtimeMs);
      hash.update(`${relative(absoluteRoot, file)}:${content.length}:`);
      hash.update(content);
    } catch {
      // Vanished between the walk and the read. The count already moved, which
      // is enough to mark the tree changed.
    }
  }
  return { files: seen.size, bytes, newestMtimeMs, digest: hash.digest("hex") };
}

/**
 * Hash the analysis inputs that are not source files.
 *
 * An absent file hashes as the marker rather than as nothing, so "you deleted
 * `kragg.json`" and "you never had one" are the same state and "you added one"
 * is a change. The compiler contributes its version and the path it was
 * resolved from: analyzing with a different compiler is analyzing a different
 * language, and the criticality data is downstream of that choice.
 */
function analysisInputs(root: string): string {
  const hash = createHash("sha256");
  for (const name of INPUT_FILES) {
    try {
      const content = readFileSync(join(root, name));
      hash.update(`${name}:${content.length}:`);
      hash.update(content);
    } catch {
      hash.update(`${name}:absent:`);
    }
  }
  hash.update(`package.json#kragg:${packageKragg(root)}:`);
  const compiler = resolveTypeScript(root);
  hash.update(`compiler:${compiler.version}:${compiler.path ?? ""}:`);
  return hash.digest("hex");
}

/** The `kragg` block of `package.json`, serialized; a marker when unreadable. */
function packageKragg(root: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return "absent";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "absent";
  }
  const record: Readonly<Record<string, unknown>> = { ...parsed };
  return JSON.stringify(record["kragg"] ?? null);
}

/**
 * Record the tree that the criticality file currently on disk describes.
 *
 * Called by whoever just wrote `criticality.json` — `kragg criticality
 * --write` and the check pipeline's derive-with-cache — and by nobody else.
 * Writing a stamp without writing the data it stamps would assert freshness
 * about a file that was never regenerated.
 *
 * Returns whether the stamp reached the disk. A read-only checkout still gets
 * to run every gate, so failure is not thrown; but it is REPORTED rather than
 * swallowed, because a caller that just wrote data it cannot vouch for is
 * entitled to say so instead of leaving a user with a gate that skips forever
 * and no reason why. Nothing is ever marked fresh on this path: with no stamp
 * written, the next run judges the file by the weaker instrument or, if an
 * older stamp is still there, finds it does not match and re-derives.
 */
export function writeStamp(root: string, paths: readonly string[]): boolean {
  const scan = scanSources(root, paths);
  const payload = {
    version: STAMP_VERSION,
    scan_paths: [...paths],
    files: scan.files,
    bytes: scan.bytes,
    source_digest: scan.digest,
    inputs_digest: analysisInputs(root),
  };
  try {
    mkdirSync(join(root, JOURNAL_DIR), { recursive: true });
    writeFileSync(stampPath(root), `${JSON.stringify(payload, null, 1)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** A stamp read back from disk, once every field has been checked. */
interface Stamp {
  readonly paths: readonly string[];
  readonly files: number;
  readonly bytes: number;
  readonly sourceDigest: string;
  readonly inputsDigest: string;
}

/** A stamp, or which of the two ways there is not one. */
type StampRead = Stamp | "absent" | "unusable";

/**
 * May the criticality file on disk be believed?
 *
 * Three cases, and which applies depends only on what is beside the data:
 *
 *  - A STAMP: the recorded count, size, source digest and input digest,
 *    recomputed and compared. Exact, and the only instrument that can see a
 *    deletion, a same-size edit or a changed tsconfig.
 *  - NO STAMP: the newest source mtime anywhere in the repo against the data
 *    file's own mtime. Coarser, needs no cooperation, and is what makes a
 *    kragg-Python file judgeable at all. See the module header.
 *  - AN UNREADABLE STAMP: stale. Something stamped this file with a
 *    fingerprint this build cannot verify, and an unverifiable claim of
 *    freshness is worth exactly nothing.
 */
export function criticalityFreshness(root: string): Freshness {
  const dataMtimeMs = mtimeOf(criticalityPath(root));
  if (dataMtimeMs === null) {
    return "missing";
  }
  const stamp = readStamp(root);
  if (stamp === "absent") {
    return scanSources(root, ["."]).newestMtimeMs <= dataMtimeMs ? "fresh" : "stale";
  }
  if (stamp === "unusable") {
    return "stale";
  }
  const scan = scanSources(root, stamp.paths);
  const unchanged =
    scan.files === stamp.files &&
    scan.bytes === stamp.bytes &&
    scan.digest === stamp.sourceDigest &&
    analysisInputs(root) === stamp.inputsDigest;
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

/**
 * Read the stamp file.
 *
 * The two failures are kept apart on purpose: NOT BEING THERE is the
 * kragg-Python case and hands the question to the mtime relation, while BEING
 * THERE AND UNREADABLE is a claim this build cannot check and is answered with
 * "stale". See `criticalityFreshness`.
 */
function readStamp(root: string): StampRead {
  try {
    return parseStamp(readFileSync(stampPath(root), "utf8"));
  } catch {
    return "absent";
  }
}

/** Narrow raw stamp text; anything short of a complete stamp is unusable. */
function parseStamp(raw: string): StampRead {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return "unusable";
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return "unusable";
  }
  const record: Readonly<Record<string, unknown>> = { ...data };
  return record["version"] === STAMP_VERSION ? stampFields(record) : "unusable";
}

/** Every field, checked; `"unusable"` if any one of them is not what it must be. */
function stampFields(record: Readonly<Record<string, unknown>>): StampRead {
  const paths = stringList(record["scan_paths"]);
  const files = finiteNumber(record["files"]);
  const bytes = finiteNumber(record["bytes"]);
  const sourceDigest = text(record["source_digest"]);
  const inputsDigest = text(record["inputs_digest"]);
  if (paths === null || files === null || bytes === null) {
    return "unusable";
  }
  if (sourceDigest === null || inputsDigest === null) {
    return "unusable";
  }
  return { paths, files, bytes, sourceDigest, inputsDigest };
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

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
