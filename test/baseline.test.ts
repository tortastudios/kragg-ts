/**
 * Tests for the reviewed legacy-debt baseline (TOR-1377).
 *
 * The properties that matter, in the order a reviewer would ask about them:
 *
 *  1. WHAT CAN NEVER BE BASELINED. Security, compiler and evidence gates are
 *     refused at record time, rejected at read time, and ignored at apply
 *     time — three independent fences, each tested on its own.
 *  2. THE IDENTITY. An entry survives a line shift above it, and goes stale
 *     — with the finding coming back as new — when the flagged line, the
 *     message or the file name changes. Renames are re-reviews.
 *  3. THE ACCOUNTING. An accepted finding becomes a `baselined:` advisory on
 *     its gate and nothing on the wire changes shape; a stale entry is
 *     reported, never dropped; a finding an adapter hid keeps the gate red.
 *
 * Everything here drives real files, because the fingerprint is a hash of
 * the line on disk and a mocked reader would test the mock.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { gateResult, type GateResult, type Violation } from "../src/engine/models.ts";
import {
  applyBaseline,
  BASELINE_GATES,
  baselineEntries,
  entryKey,
  lineFingerprint,
  readBaseline,
  recordBaseline,
  type Baseline,
} from "../src/policy/baseline.ts";
import { PolicyError } from "../src/policy/policy.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

const BASELINE = ".kragg/baseline.json";

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-baseline-"));
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

/** A gate that ran and found these; `hidden` extra findings the adapter capped away. */
function failing(name: string, violations: readonly Violation[], hidden = 0): GateResult {
  return gateResult({
    name,
    passed: false,
    violations,
    violationCount: violations.length + hidden,
  });
}

const LEGACY = "export function legacy(n: number): number { return n; }\n";
const CC: Violation = {
  message: "legacy has cyclomatic complexity grade C (max allowed: B)",
  file: "src/legacy.ts",
  line: 1,
  code: "CC-C",
  fixHint: "split into smaller functions or use early returns",
};
const SECRET: Violation = {
  message: "secret `API_TOKEN` silently defaults to empty",
  file: "src/config.ts",
  line: 1,
  code: "secret-default",
};

/** Record the given results and read the file back, as `check` does. */
function recorded(root: string, results: readonly GateResult[]): Baseline {
  recordBaseline(root, BASELINE, results);
  return readBaseline(root, BASELINE);
}

describe("baseline: what can never be baselined", () => {
  const NEVER = [
    "detect-secrets",
    "secret-default",
    "forbidden-calls",
    "tsc",
    "typing-strictness",
    "test-coverage",
    "critical-tests",
    "audit",
  ];

  it("keeps the security, compiler and evidence gates out of the allowlist", () => {
    for (const gate of NEVER) {
      assert.equal(BASELINE_GATES.includes(gate), false, gate);
    }
  });

  it("refuses their findings at record time, naming the gate and the count, and records nothing for them", () => {
    const root = project({ "src/legacy.ts": LEGACY, "src/config.ts": 'const t = process.env.T ?? "";\n' });
    const recording = recordBaseline(root, BASELINE, [
      failing("complexity", [CC]),
      failing("secret-default", [SECRET]),
      failing("tsc", [{ message: "TS2322", file: "src/a.ts", line: 1 }], 4),
    ]);
    assert.equal(recording.written, 1);
    assert.deepEqual([...recording.refused], [["secret-default", 1], ["tsc", 5]]);
    const entries = readBaseline(root, BASELINE).entries;
    assert.deepEqual(entries.map((entry) => entry.gate), ["complexity"]);
  });

  it("records nothing for a skipped or errored gate: nothing was learned", () => {
    const root = project({ "src/legacy.ts": LEGACY });
    const recording = recordBaseline(root, BASELINE, [
      gateResult({ name: "complexity", passed: false, skipped: true, skipReason: "x" }),
      gateResult({ name: "halstead", passed: false, error: true, output: "boom" }),
      gateResult({ name: "structure", passed: true }),
    ]);
    assert.equal(recording.written, 0);
    assert.equal(recording.refused.size, 0);
  });

  it("rejects a hand-edited entry for such a gate when the file is read", () => {
    const root = project({
      [BASELINE]: JSON.stringify({
        version: 1,
        entries: [{ gate: "secret-default", file: "src/config.ts", code: null, message: "m", fingerprint: "" }],
      }),
    });
    assert.throws(() => readBaseline(root, BASELINE), (error: unknown) => {
      assert.ok(error instanceof PolicyError);
      assert.match(error.message, /entries\[0\]\.gate "secret-default" can never be baselined/u);
      return true;
    });
  });

  it("ignores such an entry at apply time even if one is handed to it directly", () => {
    // Belt and braces: the reader rejects it, and the applier would not use it.
    const root = project({ "src/config.ts": 'const t = process.env.T ?? "";\n' });
    const baseline: Baseline = {
      path: BASELINE,
      entries: [
        {
          gate: "secret-default",
          file: "src/config.ts",
          code: "secret-default",
          message: SECRET.message,
          fingerprint: lineFingerprint('const t = process.env.T ?? "";'),
        },
      ],
    };
    const applied = applyBaseline(root, [failing("secret-default", [SECRET])], baseline, undefined);
    assert.equal(applied.accepted, 0);
    assert.equal(applied.results[0]?.passed, false);
    assert.equal(applied.results[0]?.violationCount, 1);
  });

  it("leaves an errored or skipped result untouched, whatever the file says", () => {
    const root = project({ "src/legacy.ts": LEGACY });
    const baseline = recorded(root, [failing("complexity", [CC])]);
    const errored = gateResult({ name: "complexity", passed: false, error: true, violations: [CC], violationCount: 1 });
    const skipped = gateResult({ name: "complexity", passed: false, skipped: true, skipReason: "fail-fast" });
    const applied = applyBaseline(root, [errored, skipped], baseline, undefined);
    assert.deepEqual(applied.results, [errored, skipped]);
    assert.equal(applied.accepted, 0);
    assert.deepEqual(applied.stale, []);
  });
});

describe("baseline: the file", () => {
  it("is empty when absent, and a PolicyError when malformed", () => {
    assert.deepEqual(readBaseline(project({}), BASELINE), { path: BASELINE, entries: [] });
    for (const [bad, pattern] of [
      ["{not json", /not valid JSON/u],
      ['{"version": 2, "entries": []}', /version must be 1 \(got 2\)/u],
      ['{"version": 1}', /entries must be a list/u],
      ['{"version": 1, "entries": [], "extra": 1}', /extra is not a baseline key/u],
      ['{"version": 1, "entries": [{"gate": "complexity"}]}', /entries\[0\]\.file must be a string/u],
      ['{"version": 1, "entries": [{"gate": "complexity", "file": "a", "code": 3, "message": "m", "fingerprint": ""}]}', /entries\[0\]\.code must be a string or null/u],
      ['{"version": 1, "entries": [{"gate": "complexity", "file": "a", "code": null, "message": "m", "fingerprint": "", "line": 3}]}', /entries\[0\]\.line is not a baseline entry key/u],
    ] as const) {
      const root = project({ [BASELINE]: bad });
      assert.throws(() => readBaseline(root, BASELINE), (error: unknown) => {
        assert.ok(error instanceof PolicyError, bad);
        assert.match(error.message, pattern, bad);
        return true;
      }, bad);
    }
  });

  it("is written sorted, versioned, one entry per occurrence, and replaced on re-record", () => {
    const root = project({ "src/legacy.ts": `${LEGACY}${LEGACY}` });
    const twice = { ...CC, line: 2 };
    recordBaseline(root, BASELINE, [failing("complexity", [twice, CC])]);
    const raw: unknown = JSON.parse(readFileSync(join(root, BASELINE), "utf8"));
    assert.deepEqual(raw, {
      version: 1,
      entries: [
        { gate: "complexity", file: "src/legacy.ts", code: "CC-C", message: CC.message, fingerprint: lineFingerprint(LEGACY) },
        { gate: "complexity", file: "src/legacy.ts", code: "CC-C", message: CC.message, fingerprint: lineFingerprint(LEGACY) },
      ],
    });
    assert.ok(readFileSync(join(root, BASELINE), "utf8").endsWith("\n"));
    recordBaseline(root, BASELINE, []);
    assert.deepEqual(readBaseline(root, BASELINE).entries, []);
  });

  it("parses a base revision handed to it as data, with the same rules", () => {
    assert.deepEqual(baselineEntries({ version: 1, entries: [] }, "x#"), []);
    assert.throws(() => baselineEntries([], "x#"), /x# must be a JSON object/u);
  });
});

describe("baseline: identity", () => {
  it("is every part of the entry, and nothing else", () => {
    const entry = { gate: "complexity", file: "src/a.ts", code: "CC-C", message: "m", fingerprint: "f" };
    assert.equal(entryKey(entry), entryKey({ ...entry }));
    for (const changed of [
      { ...entry, gate: "halstead" },
      { ...entry, file: "src/b.ts" },
      { ...entry, code: null },
      { ...entry, message: "m2" },
      { ...entry, fingerprint: "g" },
    ]) {
      assert.notEqual(entryKey(changed), entryKey(entry), JSON.stringify(changed));
    }
    // No delimiter collision: a `::`-style join would confuse these two.
    assert.notEqual(
      entryKey({ ...entry, file: "a:", message: ":b" }),
      entryKey({ ...entry, file: "a", message: "::b" }),
    );
  });

  it("survives a line shift above the finding", () => {
    const root = project({ "src/legacy.ts": LEGACY });
    const baseline = recorded(root, [failing("complexity", [CC])]);
    write(root, { "src/legacy.ts": `// a new comment above\n${LEGACY}` });
    const applied = applyBaseline(root, [failing("complexity", [{ ...CC, line: 2 }])], baseline, undefined);
    assert.equal(applied.accepted, 1);
    assert.equal(applied.results[0]?.passed, true);
    assert.deepEqual(applied.stale, []);
  });

  it("does not survive a change to the flagged line: the finding is new and the entry stale", () => {
    const root = project({ "src/legacy.ts": LEGACY });
    const baseline = recorded(root, [failing("complexity", [CC])]);
    write(root, { "src/legacy.ts": "export function legacy(n: number, m: number): number { return n + m; }\n" });
    const applied = applyBaseline(root, [failing("complexity", [CC])], baseline, undefined);
    assert.equal(applied.accepted, 0);
    assert.equal(applied.results[0]?.passed, false);
    assert.equal(applied.results[0]?.violationCount, 1);
    assert.equal(applied.stale.length, 1);
  });

  it("does not survive a changed message: a metric that grew is a different fact", () => {
    const root = project({ "src/legacy.ts": LEGACY });
    const baseline = recorded(root, [failing("complexity", [CC])]);
    const worse = { ...CC, message: CC.message.replace("grade C", "grade D"), code: "CC-D" };
    const applied = applyBaseline(root, [failing("complexity", [worse])], baseline, undefined);
    assert.equal(applied.accepted, 0);
    assert.equal(applied.results[0]?.passed, false);
    assert.equal(applied.stale.length, 1);
  });

  it("treats a renamed file as a re-review: old entry stale, new finding fails", () => {
    const root = project({ "src/legacy.ts": LEGACY });
    const baseline = recorded(root, [failing("complexity", [CC])]);
    renameSync(join(root, "src/legacy.ts"), join(root, "src/old.ts"));
    const applied = applyBaseline(root, [failing("complexity", [{ ...CC, file: "src/old.ts" }])], baseline, undefined);
    assert.equal(applied.accepted, 0);
    assert.equal(applied.results[0]?.passed, false);
    assert.deepEqual(applied.stale.map((entry) => entry.file), ["src/legacy.ts"]);
    const stale = applied.results[0]?.advisories.find((advisory) => advisory.message.startsWith("stale baseline entry:"));
    assert.ok(stale !== undefined, "the stale entry is reported on the gate");
    assert.equal(stale.file, "src/legacy.ts");
    assert.match(stale.message, /re-run `kragg check --update-baseline`/u);
  });

  it("is a multiset: two identical entries accept two findings, and a third is reported", () => {
    const root = project({ "src/legacy.ts": `${LEGACY}${LEGACY}${LEGACY}` });
    const one = CC;
    const two = { ...CC, line: 2 };
    const three = { ...CC, line: 3 };
    const baseline = recorded(root, [failing("complexity", [one, two])]);
    const applied = applyBaseline(root, [failing("complexity", [one, two, three])], baseline, undefined);
    assert.equal(applied.accepted, 2);
    assert.equal(applied.results[0]?.violationCount, 1);
    assert.equal(applied.results[0]?.passed, false);
    assert.deepEqual(applied.stale, []);
  });
});

describe("baseline: the accounting", () => {
  it("moves an accepted finding into its gate's advisories, prefixed, and passes the gate", () => {
    const root = project({ "src/legacy.ts": LEGACY });
    const baseline = recorded(root, [failing("complexity", [CC])]);
    const applied = applyBaseline(root, [failing("complexity", [CC])], baseline, undefined);
    const result = applied.results[0];
    assert.ok(result !== undefined);
    assert.equal(result.passed, true);
    assert.deepEqual(result.violations, []);
    assert.equal(result.violationCount, 0);
    assert.deepEqual(result.advisories, [{ ...CC, message: `baselined: ${CC.message}` }]);
    assert.equal(applied.accepted, 1);
  });

  it("keeps a NEW finding failing beside an accepted one", () => {
    const root = project({ "src/legacy.ts": `${LEGACY}export function fresh(): void {}\n` });
    const baseline = recorded(root, [failing("complexity", [CC])]);
    const fresh = { ...CC, message: "fresh has cyclomatic complexity grade C (max allowed: B)", line: 2 };
    const applied = applyBaseline(root, [failing("complexity", [CC, fresh])], baseline, undefined);
    const result = applied.results[0];
    assert.ok(result !== undefined);
    assert.equal(result.passed, false);
    assert.deepEqual(result.violations, [fresh]);
    assert.equal(result.violationCount, 1);
    assert.equal(result.advisories.length, 1);
  });

  it("keeps the gate red when the adapter hid findings nobody reviewed", () => {
    const root = project({ "src/legacy.ts": LEGACY });
    const baseline = recorded(root, [failing("complexity", [CC])]);
    const applied = applyBaseline(root, [failing("complexity", [CC], 3)], baseline, undefined);
    assert.equal(applied.results[0]?.passed, false);
    assert.equal(applied.results[0]?.violationCount, 3);
    assert.equal(applied.accepted, 1);
  });

  it("never accepts anything on a gate outside the allowlist, or on a passing one", () => {
    const root = project({ "src/legacy.ts": LEGACY });
    const baseline = recorded(root, [failing("complexity", [CC])]);
    const passing = gateResult({ name: "complexity", passed: true });
    const applied = applyBaseline(root, [passing, failing("tsc", [CC])], baseline, undefined);
    assert.equal(applied.accepted, 0);
    // The passing gate stays passed; the debt it no longer has is reported as
    // stale on it rather than silently dropped.
    assert.equal(applied.results[0]?.passed, true);
    assert.deepEqual(applied.results[0]?.violations, []);
    assert.match(applied.results[0]?.advisories[0]?.message ?? "", /^stale baseline entry:/u);
    assert.equal(applied.stale.length, 1);
    // `tsc` is untouched even though its finding is byte-identical to the entry.
    assert.equal(applied.results[1]?.passed, false);
    assert.equal(applied.results[1]?.violationCount, 1);
    assert.deepEqual(applied.results[1]?.advisories, []);
  });

  it("judges staleness only inside an incremental run's scope, and only for gates that ran", () => {
    const root = project({ "src/legacy.ts": LEGACY, "src/other.ts": LEGACY });
    const other = { ...CC, file: "src/other.ts", message: "other is complex" };
    const baseline = recorded(root, [failing("complexity", [CC, other])]);
    write(root, { "src/legacy.ts": "export const gone = 1;\n", "src/other.ts": "export const gone = 1;\n" });
    // Both entries are unmatched. Scoped to legacy.ts, only that one is stale.
    const scoped = applyBaseline(root, [failing("complexity", [])], baseline, ["src/legacy.ts"]);
    assert.deepEqual(scoped.stale.map((entry) => entry.file), ["src/legacy.ts"]);
    // A full run judges both.
    const full = applyBaseline(root, [gateResult({ name: "complexity", passed: true })], baseline, undefined);
    assert.equal(full.stale.length, 2);
    // A gate that did not run cannot have found anything stale.
    const skipped = gateResult({ name: "complexity", passed: false, skipped: true, skipReason: "static gates failed" });
    assert.deepEqual(applyBaseline(root, [skipped], baseline, undefined).stale, []);
  });
});
