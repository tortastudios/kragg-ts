/**
 * Executable conformance: this implementation against recorded goldens.
 *
 * ── WHAT THIS SUITE IS ─────────────────────────────────────────────────────
 * `docs/spec-conformance.md` describes a contract shared with the Python
 * sibling. `tortastudios/crag` at `f76a7d03` (release 0.9.0) ships the
 * normative version of it — `spec/SPEC.md` — plus a stdlib-only runner and
 * fixtures, and CI runs that runner against `dist/cli.js`. But only two of
 * its fixtures declare `applies_to: typescript`, so the cross-language suite
 * exercises a fraction of the surface the contract covers.
 *
 * These fixtures cover the rest, from this side: the report fields and their
 * nulls, all four exit codes, gates that skip and gates that error, the
 * journal as a READER as well as a writer, the criticality file and its
 * sidecar, and the hook protocol's stdin narrowing and stdout JSON. Each
 * fixture records the spec revision it was taken against, and the ones whose
 * behaviour deliberately differs from Python carry an explicit divergence
 * record naming the SPEC.md row — never a normalization that would quietly
 * erase the difference along with any real break sharing its shape.
 *
 * ── THE ONE THING A GOLDEN SUITE MUST NOT BECOME ───────────────────────────
 * A golden that is regenerated whenever it goes red tests nothing. Two things
 * guard against that here. `validateReport` re-derives the summary counts,
 * the duration total and the exit code from `gates[]` on every run, so a
 * report can fail even when it matches its recorded bytes; and normalization
 * is limited to the seven rules in SPEC.md section 9, each listed and
 * justified in docs/spec-conformance.md. `KRAGG_CONFORMANCE_UPDATE=1` exists
 * to re-record, and using it is a contract decision to be reviewed as a diff.
 *
 * ── WHY THE HOOK FIXTURE DOES NOT SPAWN ────────────────────────────────────
 * Every other fixture drives the real CLI as a child process through
 * `runCommand`, the repository's single sanctioned subprocess wrapper. The
 * hook needs a payload on STDIN, and `runCommand` has no stdin channel — it
 * exists to run gates, which never take input. Rather than widen the one
 * security-critical function in the codebase for a test, the hook cases call
 * `cmdHook` with the same `runCheck`/`ensureCriticality` the CLI wires in
 * `src/cli.ts` and the `readStdin` seam that module already exposes for this
 * purpose. What that misses is the process boundary itself; crag's own `hook`
 * fixture covers the spawned form, on the Python side.
 */

import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { cmdHook } from "../src/commands/hook.ts";
import { hookCheck, hookCriticality } from "../src/commands/hookCheck.ts";
import { runCommand } from "../src/engine/runner.ts";
import {
  normalizeCriticality,
  normalizeHookOutput,
  normalizeReport,
  normalizeStamp,
  pathReplacements,
  scrub,
  validateCriticality,
  validateJournalEntry,
  validateReport,
  validateStamp,
  type Replacement,
} from "./conformanceContract.ts";

/**
 * The pinned reference. A FULL COMMIT SHA, never a branch or a tag.
 *
 * A moving pin lets an edit in the sibling repository turn an unrelated pull
 * request here red, which is how people learn to ignore a check. Bumping it
 * is a deliberate act — read the SPEC.md and fixture diff the way you would
 * read a schema migration. Every fixture manifest repeats it, and the CI
 * workflow checks the sibling out at it; the last test in this file asserts
 * all three still agree.
 */
const PINNED_CRAG_COMMIT = "f76a7d0321ca6498d5c00653c493aa5ffdf2383d";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/conformance", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** Re-record the goldens instead of diffing them. Deliberate, never routine. */
const UPDATE = process.env["KRAGG_CONFORMANCE_UPDATE"] === "1";

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface HookCase {
  readonly name: string;
  readonly stdin: string;
  /** True when this case's output carries durations from a live gate run. */
  readonly liveDurations: boolean;
}

interface Manifest {
  readonly kind: string;
  readonly argv: readonly string[];
  readonly cases: readonly HookCase[];
  readonly expectedExit: number;
  readonly git: boolean;
  readonly journal: boolean;
  readonly artifacts: readonly string[];
  readonly cragCommit: string;
}

interface Outcome {
  readonly root: string;
  readonly exit: number;
  /** The value diffed against `expected.json`, already normalized. */
  readonly observed: unknown;
  /** Contract breaks found by the validators. Empty on a conforming run. */
  readonly breaks: readonly string[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return parsed;
}

function readString(source: Readonly<Record<string, unknown>>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function readStrings(source: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const value = source[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function manifestOf(name: string): Manifest {
  const raw = readJson(join(FIXTURES, name, "fixture.json"));
  assert.ok(isRecord(raw), `${name}/fixture.json must be an object`);
  const setup = raw["setup"];
  const exit = raw["expected_exit"];
  const recorded = raw["recorded_against"];
  return {
    kind: readString(raw, "kind"),
    argv: readStrings(raw, "argv"),
    cases: hookCases(raw["cases"]),
    expectedExit: typeof exit === "number" ? exit : 0,
    git: isRecord(setup) && setup["git"] === true,
    journal: raw["journal"] === true,
    artifacts: readStrings(raw, "artifacts"),
    cragCommit: isRecord(recorded) ? readString(recorded, "crag_commit") : "",
  };
}

function hookCases(value: unknown): readonly HookCase[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((entry) => ({
    name: readString(entry, "name"),
    stdin: readString(entry, "stdin"),
    liveDurations: entry["live_durations"] === true,
  }));
}

/**
 * Copy the fixture project somewhere it is not inside this repository.
 *
 * The location matters. `resolveBin` walks the ancestor chain looking for a
 * `node_modules/.bin`, so a fixture run from inside this checkout would find
 * kragg-ts's own `tsc` and the `check-missing-tsc` fixture would stop being
 * about a missing compiler. `git_sha` would come from this repository too.
 */
function materialize(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `kragg-conf-${name}-`));
  roots.push(root);
  cpSync(join(FIXTURES, name, "project"), root, { recursive: true });
  return root;
}

async function initGit(root: string): Promise<void> {
  const identity = [
    "-c",
    "user.name=kragg-conformance",
    "-c",
    "user.email=conformance@kragg.invalid",
    "-c",
    "commit.gpgsign=false",
  ];
  for (const argv of [
    ["git", "init", "-q", "."],
    ["git", ...identity, "add", "-A"],
    ["git", ...identity, "commit", "-q", "-m", "fixture baseline"],
  ]) {
    const done = await runCommand("git", argv, root);
    assert.equal(done.returncode, 0, `git setup failed: ${done.stderr}`);
  }
}

function replacementsFor(root: string): readonly Replacement[] {
  return pathReplacements([
    [root, "<project>"],
    [REPO_ROOT.replace(/\/$/u, ""), "<kragg-repo>"],
  ]);
}

async function runFixture(name: string): Promise<Outcome> {
  const manifest = manifestOf(name);
  const root = materialize(name);
  if (manifest.git) {
    await initGit(root);
  }
  const replacements = replacementsFor(root);
  const outcome =
    manifest.kind === "hook"
      ? await runHookFixture(manifest, root, replacements)
      : await runCliFixture(manifest, root, replacements);
  return {
    ...outcome,
    breaks: [...outcome.breaks, ...sideFileBreaks(root, manifest)],
  };
}

async function runCliFixture(
  manifest: Manifest,
  root: string,
  replacements: readonly Replacement[],
): Promise<Outcome> {
  const done = await runCommand("kragg", [process.execPath, CLI, ...manifest.argv], root);
  const base = { root, exit: done.returncode };
  if (manifest.kind === "streams") {
    return {
      ...base,
      observed: {
        stdout: scrub(done.stdout, replacements),
        stderr: scrub(done.stderr, replacements),
      },
      breaks: [],
    };
  }
  if (manifest.kind === "artifact") {
    return { ...base, observed: artifactSnapshot(root, manifest), breaks: [] };
  }
  const payload: unknown = JSON.parse(done.stdout);
  const breaks = [...validateReport(payload)];
  if (isRecord(payload) && payload["exit_code"] !== done.returncode) {
    breaks.push("report.exit_code disagrees with the process exit status");
  }
  return { ...base, observed: normalizeReport(payload, replacements), breaks };
}

/**
 * `.kragg/criticality.json` plus the sidecar, each normalized on its own.
 *
 * They are separate entries in the golden because they are separate files in
 * the contract: the list is shared with Python, the stamp is not, and putting
 * the stamp's fields inside the list is precisely the mistake SPEC.md
 * section 6 exists to prevent.
 *
 * Nothing here is path-scrubbed: node names are repo-relative by construction
 * (`src#normalize`) and the stamp's `scan_paths` are the policy's own
 * relative entries, so an absolute path appearing in either file would be the
 * bug, not the noise.
 *
 * The list of artifact paths is recorded in the golden alongside their
 * contents, so dropping one from the manifest fails the diff instead of
 * quietly checking less than it used to.
 */
function artifactSnapshot(root: string, manifest: Manifest): unknown {
  const snapshot: Record<string, unknown> = {};
  for (const relative of manifest.artifacts) {
    const path = join(root, relative);
    assert.ok(existsSync(path), `artifact not written: ${relative}`);
    const data: unknown = readJson(path);
    snapshot[relative] = relative.endsWith("stamp.json")
      ? normalizeStamp(data)
      : normalizeCriticality(data);
  }
  return { artifacts: snapshot, paths: [...manifest.artifacts] };
}

async function runHookFixture(
  manifest: Manifest,
  root: string,
  replacements: readonly Replacement[],
): Promise<Outcome> {
  const cases: Record<string, string> = {};
  let exit = 0;
  for (const hookCase of manifest.cases) {
    const emitted: string[] = [];
    const code = await cmdHook({
      protocol: "claude",
      root,
      runCheck: hookCheck,
      ensureCriticality: hookCriticality,
      readStdin: () => hookCase.stdin,
      emit: (line) => {
        emitted.push(line);
      },
    });
    exit = code !== 0 ? code : exit;
    cases[hookCase.name] = normalizeHookOutput(
      emitted.join("\n"),
      replacements,
      hookCase.liveDurations,
    );
  }
  return { root, exit, observed: { cases }, breaks: [] };
}

/**
 * Everything a run left behind that the contract also governs.
 *
 * The journal and the criticality file are checked wherever they appear, not
 * only in the fixtures that are about them: a run that quietly starts writing
 * a malformed sidecar is exactly the kind of break a report-shaped golden
 * would sail past.
 */
function sideFileBreaks(root: string, manifest: Manifest): readonly string[] {
  const breaks: string[] = [];
  const journal = join(root, ".kragg", "history.jsonl");
  if (manifest.journal) {
    assert.ok(existsSync(journal), ".kragg/history.jsonl was not written");
    const lines = readFileSync(journal, "utf8").split("\n").filter((line) => line !== "");
    assert.equal(lines.length, 1, "expected exactly one journal line");
    lines.forEach((line, index) => {
      const entry: unknown = JSON.parse(line);
      breaks.push(...validateJournalEntry(entry, `journal[${index}]`));
    });
  }
  const criticality = join(root, ".kragg", "criticality.json");
  if (existsSync(criticality)) {
    breaks.push(...validateCriticality(readJson(criticality)));
  }
  const stamp = join(root, ".kragg", "criticality.stamp.json");
  if (existsSync(stamp)) {
    breaks.push(...validateStamp(readJson(stamp)));
  }
  return breaks;
}

function compareGolden(name: string, observed: unknown): void {
  const path = join(FIXTURES, name, "expected.json");
  if (UPDATE) {
    writeFileSync(path, `${JSON.stringify(observed, null, 1)}\n`);
    return;
  }
  assert.ok(existsSync(path), `missing golden for ${name}; record it deliberately`);
  assert.deepEqual(observed, readJson(path));
}

const FIXTURE_NAMES = readdirSync(FIXTURES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe("spec conformance fixtures", () => {
  for (const name of FIXTURE_NAMES) {
    describe(name, () => {
      const manifest = manifestOf(name);
      let outcome: Outcome | null = null;

      before(async () => {
        outcome = await runFixture(name);
      });

      it("exits with the status the contract requires", () => {
        assert.ok(outcome !== null);
        assert.equal(outcome.exit, manifest.expectedExit);
      });

      it("breaks no structural rule of the shared schema", () => {
        assert.ok(outcome !== null);
        assert.deepEqual([...outcome.breaks], []);
      });

      it("matches the recorded golden byte for byte, after normalization", () => {
        assert.ok(outcome !== null);
        compareGolden(name, outcome.observed);
      });

      it("records the spec revision it was taken against", () => {
        assert.equal(manifest.cragCommit, PINNED_CRAG_COMMIT);
      });
    });
  }
});

describe("the pin", () => {
  it("is the same full commit SHA in the fixtures, the workflow and the doc", () => {
    const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    assert.ok(
      workflow.includes(PINNED_CRAG_COMMIT),
      "ci.yml must check the sibling out at the pinned commit",
    );
    assert.doesNotMatch(
      workflow,
      /repository: tortastudios\/crag[\s\S]{0,200}?ref: (main|master|v[\d.]+)\b/u,
      "the sibling must never be checked out at a branch or tag",
    );
    const doc = readFileSync(join(REPO_ROOT, "docs/spec-conformance.md"), "utf8");
    assert.ok(doc.includes(PINNED_CRAG_COMMIT), "the doc must name the pinned commit");
  });
});
