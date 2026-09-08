/**
 * What `kragg init` would change, decided before anything is written.
 *
 * `init` runs against a project that already works. Every file it touches is
 * therefore a file somebody else owns, and the failure mode is not "init
 * wrote nothing" but "init quietly redefined the project": a `"type":
 * "module"` that turns a CommonJS package into ESM, a `packageManager` that
 * points corepack at a tool the repo does not use, a `kragg.json` that
 * shadows a stricter `package.json#kragg` outright. None of those look like
 * damage in a diff — they look like additions.
 *
 * So planning is separated from applying. `planInit` reads the project and
 * returns exactly what would happen; `initializeProject` in `./project.ts`
 * carries it out, and `--dry-run` prints it and stops. There is one code path
 * deciding what changes, which is what makes the dry run trustworthy: it is
 * not a second implementation that has to be kept honest.
 *
 * The additive-merge rule lives here too, because planning has to answer
 * "which keys would this add?" and applying has to add exactly those. One
 * definition, used twice.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_POLICY } from "../policy/policy.ts";
import { guardrailFiles, kraggConfig, packageJson, type ProjectIdentity } from "./guardrails.ts";
import { normalizePackageName } from "./naming.ts";

/** A file `init` would create, with the contents it would write. */
export interface PlannedWrite {
  /** Absolute path. */
  readonly path: string;
  readonly contents: string;
}

/** An existing JSON file `init` would add keys to. */
export interface PlannedMerge {
  /** Absolute path. */
  readonly path: string;
  /** The additive fragment handed to `mergeJson`. */
  readonly additions: Readonly<Record<string, unknown>>;
  /** Dotted key paths that would actually appear, e.g. `scripts.check`. */
  readonly keys: readonly string[];
}

/** Something `init` deliberately leaves alone, and the reason it does. */
export interface InitSkip {
  /** Absolute path, or `<path>#<key>` when a single JSON key is withheld. */
  readonly path: string;
  /** User-facing explanation, phrased as why leaving it alone is correct. */
  readonly reason: string;
  /**
   * `true` when the skip changes what the user gets and must be reported even
   * in a normal run — a preserved policy, a manifest key not added. A file
   * that merely already exists is `false`: listing fifteen of those buries
   * the two lines that matter.
   */
  readonly notable: boolean;
}

/** Everything `kragg init` would do to a project. Computed, never applied. */
export interface InitPlan {
  /** Absolute project root. */
  readonly root: string;
  readonly writes: readonly PlannedWrite[];
  readonly merges: readonly PlannedMerge[];
  readonly skipped: readonly InitSkip[];
}

/** The result of an additive merge: the value, and what it gained. */
export interface MergeOutcome {
  readonly merged: Record<string, unknown>;
  /** Dotted key paths added, in the order they were added. Empty means no change. */
  readonly added: readonly string[];
}

/**
 * `package.json` keys `init` will not introduce into a manifest that already
 * exists, each with the breakage adding it would cause.
 *
 * Every one of them is a statement about the project as a whole rather than an
 * addition to it, and a project that already ships has already answered all
 * four — by writing the key, or by deliberately leaving it out. `"type"` is
 * the sharpest: absent means CommonJS, so *adding* the key is what breaks the
 * project, and no diff of the existing file would have shown a conflict.
 */
const PRESERVED_MANIFEST_KEYS: ReadonlyMap<string, string> = new Map([
  [
    "type",
    'left as-is: adding "type": "module" makes Node read every .js file in the ' +
      "project as ESM, which breaks a CommonJS project outright",
  ],
  [
    "engines",
    "left as-is: declaring a Node range the project never agreed to can fail its " +
      "next install",
  ],
  [
    "packageManager",
    "left as-is: it would point corepack at a package manager this project does " +
      "not use",
  ],
  [
    "private",
    'left as-is: adding "private": true would make a publishable package refuse ' +
      "to publish",
  ],
]);

/**
 * Decide what `init` would do to `root`.
 *
 * `manifest` is the parsed `package.json`, or `null` when there is none — the
 * caller parses it so that an unreadable manifest fails once, loudly, before
 * any of this runs. Nothing here writes, creates a directory, or mutates its
 * arguments, which is the whole guarantee `--dry-run` rests on.
 */
export function planInit(root: string, manifest: Record<string, unknown> | null): InitPlan {
  const identity: ProjectIdentity = {
    projectName: basenameOf(root),
    packageName: normalizePackageName(basenameOf(root)),
    kind: null,
    mcpSdk: "fastmcp",
  };
  const files = guardrailFiles(identity);
  // Both are decided below: writing them here would clobber the existing file.
  delete files["package.json"];
  delete files["kragg.json"];

  const writes: PlannedWrite[] = [];
  const skipped: InitSkip[] = [];
  for (const relative of Object.keys(files).sort()) {
    const contents = files[relative];
    if (contents === undefined) {
      continue;
    }
    const path = join(root, relative);
    if (existsSync(path)) {
      skipped.push({ path, reason: "already present; left exactly as it is", notable: false });
      continue;
    }
    writes.push({ path, contents });
  }

  const merges: PlannedMerge[] = [];
  planManifest(root, identity, manifest, merges, skipped);
  planPolicy(root, manifest, writes, skipped);
  return { root, writes, merges, skipped };
}

/**
 * Plan `package.json`: create it whole, or add only what is safely additive.
 *
 * A manifest that does not exist yet has no semantics to preserve, so it gets
 * the full generated fragment. One that does exist gets everything except
 * `PRESERVED_MANIFEST_KEYS` — and each withheld key is reported, because
 * "kragg init did not set up your module system" is exactly the kind of thing
 * a user should learn from the command rather than from a broken build.
 */
function planManifest(
  root: string,
  identity: ProjectIdentity,
  manifest: Record<string, unknown> | null,
  merges: PlannedMerge[],
  skipped: InitSkip[],
): void {
  const path = join(root, "package.json");
  const additions = packageJson(identity);
  if (manifest === null) {
    merges.push({ path, additions, keys: Object.keys(additions) });
    return;
  }
  const additive: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(additions)) {
    const reason = PRESERVED_MANIFEST_KEYS.get(key);
    if (reason === undefined) {
      additive[key] = value;
      continue;
    }
    if (!Object.hasOwn(manifest, key)) {
      skipped.push({ path: `${path}#${key}`, reason, notable: true });
    }
  }
  const keys = mergeAdditions(manifest, additive).added;
  if (keys.length === 0) {
    skipped.push({
      path,
      reason: "already has every key init adds",
      notable: false,
    });
    return;
  }
  merges.push({ path, additions: additive, keys });
}

/**
 * Plan `kragg.json`: write one only when the project has no policy at all.
 *
 * `loadPolicy` reads `kragg.json` first and a standalone file wins OUTRIGHT —
 * `package.json#kragg` is not consulted at all when one exists. So writing a
 * default `kragg.json` into a project that configures kragg in its manifest
 * does not *add* to that policy, it replaces it, and every stricter threshold,
 * every `forbidden_calls` entry and every non-default `source_paths` in it
 * stops applying. The generated defaults are weaker than most things anyone
 * would have written by hand, which makes it a silent downgrade of exactly the
 * settings a project bothered to tighten.
 *
 * Merging into an existing `kragg.json` has the same shape of problem one
 * level down: adding `source_paths` to a config that omitted it is not
 * additive to the *effective* policy, it overrides the default the project was
 * relying on. So a project that already states a policy — in either place —
 * keeps it untouched, and `init` says so.
 */
function planPolicy(
  root: string,
  manifest: Record<string, unknown> | null,
  writes: PlannedWrite[],
  skipped: InitSkip[],
): void {
  const path = join(root, "kragg.json");
  if (existsSync(path)) {
    skipped.push({
      path,
      reason: "already present; the effective policy is left exactly as it is",
      notable: true,
    });
    return;
  }
  if (manifest !== null && Object.hasOwn(manifest, "kragg")) {
    skipped.push({
      path,
      reason:
        "not created: this project's policy lives in package.json#kragg, and a " +
        "kragg.json would shadow it outright rather than add to it",
      notable: true,
    });
    return;
  }
  const config = initKraggConfig(root);
  writes.push({ path, contents: `${JSON.stringify(config, null, 2)}\n` });
  if (config["source_paths"] === undefined) {
    skipped.push({
      path: `${path}#source_paths`,
      reason:
        "no default source directory found here; set source_paths to this " +
        "project's layout before running kragg check",
      notable: true,
    });
  }
}

/**
 * The `kragg.json` a project with no policy gets: the defaults, narrowed to
 * the directories that actually exist.
 *
 * Every value written here has to resolve to the same effective policy the
 * project already had, or `init` has quietly changed the rules. Two of the
 * generated keys name directories, and a project laid out differently — `lib/`
 * rather than `src/`, `tests/` rather than `test/` — would be handed a policy
 * that contradicts it. So a path is written only when it is there, and a key
 * with nothing behind it is left out entirely so the loaded default keeps
 * applying instead of a narrower guess.
 */
function initKraggConfig(root: string): Record<string, unknown> {
  const config = { ...kraggConfig(null) };
  narrowToExisting(config, "source_paths", root, DEFAULT_POLICY.sourcePaths);
  narrowToExisting(config, "test_paths", root, DEFAULT_POLICY.testPaths);
  return config;
}

/** Keep the candidate paths that exist under `root`; drop the key if none do. */
function narrowToExisting(
  config: Record<string, unknown>,
  key: string,
  root: string,
  candidates: readonly string[],
): void {
  const present = candidates.filter((candidate) => existsSync(join(root, candidate)));
  if (present.length === 0) {
    delete config[key];
    return;
  }
  config[key] = present;
}

/**
 * Merge `additions` into `existing` without ever replacing a value.
 *
 * Additive only, and one level deep for nested objects: a key already present
 * keeps its value, at the top level and inside `scripts`/`dependencies` alike.
 * `added` names what changed, so a caller can report it and a caller can skip
 * writing a file that gained nothing.
 */
export function mergeAdditions(
  existing: Readonly<Record<string, unknown>>,
  additions: Readonly<Record<string, unknown>>,
): MergeOutcome {
  const merged: Record<string, unknown> = { ...existing };
  const added: string[] = [];
  for (const [key, value] of Object.entries(additions)) {
    const current = merged[key];
    if (current === undefined) {
      merged[key] = value;
      added.push(key);
      continue;
    }
    if (isPlainObject(current) && isPlainObject(value)) {
      const nested = { ...current };
      for (const [innerKey, innerValue] of Object.entries(value)) {
        if (nested[innerKey] === undefined) {
          nested[innerKey] = innerValue;
          added.push(`${key}.${innerKey}`);
        }
      }
      merged[key] = nested;
    }
  }
  return { merged, added };
}

/** True for a JSON object, false for arrays, null, and primitives. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The final path segment, used as the project name for `init`. */
function basenameOf(absolute: string): string {
  const segments = absolute.split(/[\\/]/).filter((part) => part !== "");
  return segments[segments.length - 1] ?? "app";
}
