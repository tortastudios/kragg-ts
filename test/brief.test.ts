/**
 * Tests for `kragg brief`.
 *
 * The load-bearing assertion is the FIRST one: outside a git repository
 * `buildBrief` returns `null`, never an empty document. `git/changes.ts`
 * keeps `null` and `[]` apart precisely so a caller cannot report "0 files
 * changed" for a directory git was never able to answer about, and a brief
 * that lost the distinction would print a confident, wrong review of nothing.
 * `runBrief` turns that `null` into `EXIT_ENVIRONMENT` and the specific
 * message `cmd_brief` prints.
 *
 * After that: the three sections, the area split (tests win ties), the fan-in
 * ranking and its cap, and the two states of the gate section.
 *
 * Each fixture is a real, throwaway git repository — `changedFiles` shells out
 * to git, so a mocked one would test the mock. `commit` gives the tests a base
 * to diff against, which is what makes "changed" mean anything.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import ts from "typescript";

import {
  buildBrief,
  JOURNAL_PROVENANCE,
  NOT_A_REPOSITORY_MESSAGE,
} from "../src/commands/brief.ts";
import { gitSha } from "../src/git/changes.ts";
import { lineFingerprint } from "../src/policy/baseline.ts";
import { DEFAULT_POLICY, type KraggPolicy } from "../src/policy/policy.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

const POLICY: KraggPolicy = {
  ...DEFAULT_POLICY,
  sourcePaths: ["src"],
  testPaths: ["test"],
};

function scratch(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-brief-"));
  roots.push(root);
  write(root, files);
  return root;
}

function write(root: string, files: Readonly<Record<string, string>>): void {
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
}

function git(root: string, args: readonly string[]): void {
  // `brief` reads real git history, so this test drives a real repository.
  // Routing it through `runCommand` would make the fixture setup async for no
  // benefit and couple the test to the thing it is testing around.
  execFileSync("git", [...args], { cwd: root, stdio: "ignore" }); // kragg: ignore -- test fixture setup drives a real git repository synchronously; argv array, no shell
}

/** A repository with one commit, so `HEAD` is a usable diff base. */
function repository(files: Readonly<Record<string, string>>): string {
  const root = scratch({ ".gitkeep": "" });
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "test"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "base"]);
  write(root, files);
  return root;
}

async function brief(root: string): Promise<string> {
  const text = await buildBrief({ root, since: null, policy: POLICY, api: ts });
  assert.ok(text !== null, "expected a brief");
  return text;
}

describe("brief: not a repository is not an empty change set", () => {
  it("returns null outside a git repository", async () => {
    const text = await buildBrief({
      root: scratch({ "src/a.ts": "export const a = 1;\n" }),
      since: null,
      policy: POLICY,
      api: ts,
    });
    assert.equal(text, null);
  });

  it("names the failure the way cmd_brief does", () => {
    assert.equal(NOT_A_REPOSITORY_MESSAGE, "not a git repository (required for brief)");
  });

  it("renders a real document for a repository with nothing changed", async () => {
    const text = await brief(repository({}));
    assert.ok(text.startsWith("# Change brief\n"), text);
    assert.ok(text.includes("0 source files changed vs HEAD"), text);
  });
});

describe("brief: the change set", () => {
  it("groups changed files into Source, Tests and Other", async () => {
    const root = repository({
      "src/a.ts": "export const a = 1;\n",
      "test/a.test.ts": "export const t = 1;\n",
      "scripts/build.js": "module.exports = 1;\n",
    });
    const text = await brief(root);
    assert.ok(text.includes("## Source\n- src/a.ts\n"), text);
    assert.ok(text.includes("## Tests\n- test/a.test.ts\n"), text);
    assert.ok(text.includes("## Other\n- scripts/build.js\n"), text);
    assert.ok(text.includes("3 source files changed vs HEAD"), text);
  });

  it("files a colocated test under Tests, not Source", async () => {
    // A `*.test.ts` inside a source path would otherwise leave the section a
    // reviewer checks first permanently empty.
    const root = repository({ "src/a.test.ts": "export const t = 1;\n" });
    const text = await brief(root);
    assert.ok(text.includes("## Tests\n- src/a.test.ts\n"), text);
    assert.ok(!text.includes("## Source"), text);
  });

  it("omits kragg's own artifacts", async () => {
    const root = repository({
      "src/a.ts": "export const a = 1;\n",
      ".kragg/history.jsonl": "{}\n",
    });
    const text = await brief(root);
    // Not as a changed file. The gate section names `.kragg/history.jsonl` as
    // its source, which is the opposite problem — see "provenance" below.
    assert.ok(!text.includes("- .kragg/"), text);
    assert.ok(text.includes("1 source file changed vs HEAD"), text);
  });

  it("names the base when diffing against a ref", async () => {
    const root = repository({ "src/a.ts": "export const a = 1;\n" });
    const text = await buildBrief({ root, since: "main", policy: POLICY, api: ts });
    assert.ok(text !== null);
    assert.ok(text.includes("vs main"), text);
  });

  it("returns null for a ref git cannot resolve", async () => {
    const root = repository({ "src/a.ts": "export const a = 1;\n" });
    const text = await buildBrief({ root, since: "no-such-ref", policy: POLICY, api: ts });
    assert.equal(text, null);
  });
});

describe("brief: critical functions touched", () => {
  const CRITICALITY = JSON.stringify([
    { name: "src/a#low", fan_in: 2, is_critical: true, risk: "MED" },
    { name: "src/a#high", fan_in: 9, is_critical: true, risk: "HIGH" },
    { name: "src/untouched#other", fan_in: 20, is_critical: true, risk: "HIGH" },
  ]);

  it("lists only the changed ones, ranked by fan-in", async () => {
    const root = repository({
      "src/a.ts": "export function low(): void {}\nexport function high(): void {}\n",
      "src/untouched.ts": "export function other(): void {}\n",
      ".kragg/criticality.json": CRITICALITY,
    });
    // Commit `untouched.ts` so it is genuinely not part of the change set.
    git(root, ["add", "src/untouched.ts"]);
    git(root, ["commit", "-m", "untouched"]);
    const text = await brief(root);
    assert.ok(
      text.includes(
        "## Critical functions touched\n" +
          "- `src/a#high` (fan-in 9) in src/a.ts\n" +
          "- `src/a#low` (fan-in 2) in src/a.ts\n",
      ),
      text,
    );
    assert.ok(!text.includes("src/untouched#other"), text);
  });

  it("prints `none` rather than dropping the heading", async () => {
    const root = repository({ "src/a.ts": "export const a = 1;\n" });
    const text = await brief(root);
    assert.ok(text.includes("## Critical functions touched\nnone\n"), text);
  });

  it("caps the list and says how many were withheld", async () => {
    const names = Array.from({ length: 6 }, (_, index) => `fn${index}`);
    const root = repository({
      "src/a.ts": names.map((name) => `export function ${name}(): void {}`).join("\n"),
      ".kragg/criticality.json": JSON.stringify(
        names.map((name, index) => ({
          name: `src/a#${name}`,
          fan_in: 10 - index,
          is_critical: true,
          risk: "HIGH",
        })),
      ),
    });
    const text = await buildBrief({
      root,
      since: null,
      policy: { ...POLICY, maxViolationsPerGate: 2 },
      api: ts,
    });
    assert.ok(text !== null);
    assert.ok(text.includes("- `src/a#fn0` (fan-in 10) in src/a.ts\n"), text);
    assert.ok(text.includes("- `src/a#fn1` (fan-in 9) in src/a.ts\n"), text);
    assert.ok(text.includes("- +4 more, ranked by fan-in\n"), text);
    assert.ok(!text.includes("fn5"), text);
  });
});

describe("brief: the gate section", () => {
  it("says there are no recorded runs when the journal is missing", async () => {
    const text = await brief(repository({}));
    assert.ok(
      text.includes(
        `## Last gate run\n${JOURNAL_PROVENANCE}\nno recorded runs (run \`kragg check\`)`,
      ),
      text,
    );
  });

  it("summarises the journal when there is one", async () => {
    const root = repository({
      ".kragg/history.jsonl": `${JSON.stringify({
        schema_version: 1,
        ts: "2026-08-06T00:00:00Z",
        command: "check",
        mode: "full",
        git_sha: "abc1234",
        git_dirty: false,
        passed: true,
        exit_code: 0,
        duration_ms: 1500,
        gates: [],
      })}\n`,
    });
    const text = await brief(root);
    assert.ok(
      text.includes(`## Last gate run\n${JOURNAL_PROVENANCE}\nlast run: PASS (check, full mode`),
      text,
    );
  });

  it("ends with exactly one trailing newline", async () => {
    const text = await brief(repository({}));
    assert.ok(text.endsWith("\n"), JSON.stringify(text.slice(-4)));
    assert.ok(!text.endsWith("\n\n"), JSON.stringify(text.slice(-4)));
  });
});

describe("brief: exemptions (TOR-1377)", () => {
  /** A repository whose base commit holds `files`, with `changes` applied on top. */
  function evolved(
    files: Readonly<Record<string, string>>,
    changes: Readonly<Record<string, string>>,
  ): string {
    const root = repository(files);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "base files"]);
    write(root, changes);
    return root;
  }

  it("lists every suppression added, with its reason, and calls out a bare one", async () => {
    const root = repository({
      "src/a.ts":
        "const a = eval(x); // kragg: ignore -- x is a compile-time constant\n" +
        "const b = eval(y); /* kragg: ignore — reviewed */\n" +
        "const c = eval(z); // kragg: ignore\n",
    });
    const text = await brief(root);
    assert.ok(
      text.includes(
        "## Suppressions\n" +
          "- added src/a.ts:1 — x is a compile-time constant\n" +
          "- added src/a.ts:2 — reviewed\n" +
          "- added src/a.ts:3 — NO REASON (not honoured; the finding is reported)\n",
      ),
      text,
    );
  });

  it("lists a removed suppression, and ignores one that merely moved", async () => {
    const root = evolved(
      { "src/a.ts": "const a = eval(x); // kragg: ignore -- constant\nconst b = eval(y); // kragg: ignore -- reviewed\n" },
      { "src/a.ts": "// a new line above\nconst a = eval(x); // kragg: ignore -- constant\nconst b = eval(y);\n" },
    );
    const text = await brief(root);
    assert.ok(text.includes("## Suppressions\n- removed src/a.ts:2 — reviewed\n\n"), text);
  });

  it("prints none when the change set adds or removes no marker", async () => {
    const text = await brief(repository({ "src/a.ts": "export const a = 1;\n" }));
    assert.ok(text.includes("## Suppressions\nnone\n"), text);
    assert.ok(text.includes("## Baseline\nnone configured\n"), text);
  });

  it("lists baseline entries added, removed and stale", async () => {
    const line = "export function legacy(n: number): number { return n; }";
    const entry = (message: string, fingerprint: string): Record<string, unknown> => ({
      gate: "complexity",
      file: "src/legacy.ts",
      code: "CC-C",
      message,
      fingerprint,
    });
    const root = evolved(
      {
        "src/legacy.ts": `${line}\n`,
        ".kragg/baseline.json": JSON.stringify({
          version: 1,
          entries: [entry("kept", lineFingerprint(line)), entry("fixed", lineFingerprint(line))],
        }),
      },
      {
        ".kragg/baseline.json": JSON.stringify({
          version: 1,
          entries: [entry("kept", lineFingerprint(line)), entry("renamed", lineFingerprint("gone"))],
        }),
      },
    );
    const text = await buildBrief({
      root,
      since: null,
      policy: { ...POLICY, baseline: ".kragg/baseline.json" },
      api: ts,
    });
    assert.ok(text !== null);
    assert.ok(
      text.includes(
        "## Baseline\n" +
          "- added complexity src/legacy.ts CC-C — renamed\n" +
          "- removed complexity src/legacy.ts CC-C — fixed\n" +
          "- stale complexity src/legacy.ts CC-C — renamed (accepted line no longer in the file; re-run `kragg check --update-baseline`)\n",
      ),
      text,
    );
    assert.ok(!text.includes("kept"), text);
  });

  it("keeps the exemption sections between the critical and gate sections", async () => {
    const text = await brief(repository({}));
    const headings = ["## Critical functions touched", "## Suppressions", "## Baseline", "## Last gate run"];
    const order = headings.map((heading) => text.indexOf(heading));
    assert.ok(order.every((index) => index !== -1), text);
    assert.deepEqual([...order].sort((a, b) => a - b), order, text);
  });
});

/**
 * Where the gate section's numbers come from, and when they stopped applying.
 *
 * The section summarises `.kragg/history.jsonl` — a verdict recorded by some
 * earlier run, at some earlier commit. Printed bare under a list of changed
 * files it reads as "these files passed", which is a conclusion nobody
 * reached. So the document has to say what it is reading and, whenever the
 * recorded run does not describe this tree, that it does not.
 */
describe("brief: the gate section names its source and its staleness", () => {
  /** A journal holding one PASS, recorded at `sha`. */
  function journal(sha: string | null, dirty = false): string {
    return `${JSON.stringify({
      schema_version: 1,
      ts: "2026-08-06T00:00:00Z",
      command: "check",
      mode: "full",
      git_sha: sha,
      git_dirty: dirty,
      passed: true,
      exit_code: 0,
      duration_ms: 1500,
      gates: [],
    })}\n`;
  }

  /** A repository that ignores `.kragg/`, so a journal does not dirty the tree. */
  function quiet(): string {
    const root = repository({ ".gitignore": ".kragg/\n" });
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "ignore artifacts"]);
    return root;
  }

  it("labels the summary as read from the journal, not run for this brief", async () => {
    const root = repository({ ".kragg/history.jsonl": journal("abc1234") });
    const text = await brief(root);
    assert.ok(text.includes(JOURNAL_PROVENANCE), text);
    assert.match(JOURNAL_PROVENANCE, /history\.jsonl/);
    assert.match(JOURNAL_PROVENANCE, /Nothing was re-run/);
  });

  it("says the recorded PASS predates this change set when the commit differs", async () => {
    // The dangerous read: `last run: PASS` sitting under files it never saw.
    const root = repository({
      "src/a.ts": "export const a = 1;\n",
      ".kragg/history.jsonl": journal("abc1234"),
    });
    const text = await brief(root);
    assert.ok(text.includes("last run: PASS"), text);
    assert.match(text, /stale: recorded at abc1234, but HEAD is \w+ — that verdict predates/);
  });

  it("says so when the journal cannot name the commit it ran against", async () => {
    const root = repository({ ".kragg/history.jsonl": journal(null) });
    const text = await brief(root);
    assert.match(text, /stale: recorded against an unidentified commit/);
  });

  it("flags a run recorded on a dirty tree even at this very commit", async () => {
    const root = quiet();
    const sha = await gitSha(root);
    assert.ok(sha !== null);
    write(root, { ".kragg/history.jsonl": journal(sha, true) });
    const text = await brief(root);
    assert.match(text, /stale: recorded at \w+ with uncommitted changes/);
  });

  it("stays quiet when the recorded run really is this commit, cleanly", async () => {
    const root = quiet();
    const sha = await gitSha(root);
    assert.ok(sha !== null);
    write(root, { ".kragg/history.jsonl": journal(sha) });
    const text = await brief(root);
    assert.ok(text.includes("last run: PASS"), text);
    assert.ok(!text.includes("stale:"), text);
  });
});

/**
 * Narrowing and bounding a large change set.
 *
 * Both are DISPLAY concerns, and the assertions below are mostly about what
 * they must NOT touch: the count in the stats line, and the critical-function
 * analysis, both read the whole (path-filtered) change set.
 */
describe("brief: --path and --limit", () => {
  const CHANGE: Readonly<Record<string, string>> = {
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "export const b = 2;\n",
    "test/a.test.ts": 'it("a", () => {});\n',
  };

  it("narrows the whole digest to the named paths", async () => {
    const root = repository(CHANGE);
    const text = await buildBrief({ root, since: null, policy: POLICY, api: ts, paths: ["test"] });
    assert.ok(text !== null);
    assert.ok(text.includes("1 source file changed vs HEAD"), text);
    assert.ok(text.includes("- test/a.test.ts"), text);
    assert.ok(!text.includes("- src/a.ts"), text);
    assert.ok(!text.includes("## Source"), text);
  });

  it("bounds the listing while the count above it stays the real one", async () => {
    const root = repository(CHANGE);
    const text = await buildBrief({ root, since: null, policy: POLICY, api: ts, limit: 1 });
    assert.ok(text !== null);
    assert.ok(text.includes("3 source files changed vs HEAD"), text);
    assert.equal(text.match(/^- /gm)?.length, 1, text);
    assert.ok(
      text.includes("showing 1 of 3 changed files — pass --limit 0 for everything"),
      text,
    );
  });

  it("lists everything, and says nothing was withheld, at limit 0", async () => {
    const root = repository(CHANGE);
    const text = await buildBrief({ root, since: null, policy: POLICY, api: ts, limit: 0 });
    assert.ok(text !== null);
    assert.equal(text.match(/^- /gm)?.length, 3, text);
    assert.ok(!text.includes("showing"), text);
  });
});
