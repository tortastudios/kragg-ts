/**
 * Reviewed critical-function declarations, end to end.
 *
 * THE HOLE THE FEATURE CLOSES is the fixture below: `verifyPassword` is called
 * from exactly one place, so the call graph ranks it last and every
 * criticality-driven gate is silent about it — while `normalize`, three lines
 * of plumbing with three callers, is enforced. Consequence is not centrality,
 * and `critical_functions` is how a reviewer says so.
 *
 * Four properties are pinned here, and each of them is a way the feature could
 * be worse than useless:
 *
 *  1. A DECLARATION IS ENFORCED. It reaches the sidecar as `is_critical: true`
 *     and travels from there into `criticalFunctions`, `test-quality`,
 *     `critical-coverage` and mutation targeting, exactly as a graph-selected
 *     function does.
 *  2. IT NEVER DEMOTES. Declaring a function the graph already selected adds a
 *     reason and takes nothing away, and no spelling of the setting can make
 *     an automatically critical function stop being critical.
 *  3. IT CANNOT VANISH. Rename the function and leave the entry behind, and
 *     the command and all three gates ERROR (exit 3) naming the stale entry —
 *     never a quiet return to "not critical", which is the failure that would
 *     make the whole setting a liability.
 *  4. THE SIDECAR DOES NOT GROW A KEY. `.kragg/criticality.json` records still
 *     carry exactly the six keys Python reads; the reason is re-derived from
 *     the policy wherever it is shown, which is also why a declaration added
 *     after the last derivation takes effect immediately.
 *
 * The compiler is passed in explicitly, as everywhere else in these tests, so
 * nothing depends on what is installed where.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import ts from "typescript";

import { renderGaps } from "../src/commands/coverage.ts";
import { runCriticality } from "../src/commands/criticality.ts";
import { selectTargets } from "../src/commands/mutation/targets.ts";
import { EXIT_ENVIRONMENT, EXIT_OK } from "../src/engine/report.ts";
import {
  checkCriticalCoverage,
  criticalCoverageGaps,
} from "../src/gates/criticalCoverage.ts";
import { checkCriticalTests } from "../src/gates/criticalTests.ts";
import {
  criticalityPath,
  formatReport,
  formatTable,
  readJson,
  writeJson,
  writeStamp,
  type FunctionProfile,
} from "../src/gates/criticality.ts";
import {
  declaredCritical,
  missingDeclarations,
  staleDeclarationMessage,
} from "../src/gates/criticality/declared.ts";
import { checkTestQuality } from "../src/gates/testQuality.ts";
import {
  criticalFunctions,
  declarationProblem,
  hasCriticalityData,
} from "../src/gates/testDepth/criticalFunctions.ts";
import { loadPolicy } from "../src/policy/policy.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) {
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
  include: ["src/**/*.ts", "test/**/*.ts"],
});

/** The one authorization entrypoint: exported, and called exactly once. */
const LOGIN = `export function verifyPassword(given: string, expected: string): boolean {
  return given.length > 0 && given === expected;
}

export function login(given: string, expected: string): string {
  return verifyPassword(given, expected) ? "ok" : "denied";
}
`;

/** Plumbing with three callers: what centrality DOES find. */
const INDEX = `export function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function parse(value: string): string {
  return normalize(value);
}

export function render(value: string): string {
  return normalize(value);
}

export function report(value: string): string {
  return normalize(value);
}
`;

/** A test suite that exercises the hub and never mentions the entrypoint. */
const SUITE = `import { normalize } from "../src/text.ts";

export function exercise(): string {
  return normalize(" A ");
}
`;

const SOURCES: Readonly<Record<string, string>> = {
  "src/text.ts": INDEX,
  "src/auth/login.ts": LOGIN,
  "test/index.spec.ts": SUITE,
};

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-declared-"));
  roots.push(root);
  writeFileSync(join(root, "tsconfig.json"), TSCONFIG);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

/** The fixture, with whatever `critical_functions` the test is about. */
function fixture(
  declarations: Readonly<Record<string, string>> | null = null,
  overrides: Readonly<Record<string, string>> = {},
): string {
  const config = {
    source_paths: ["src"],
    test_paths: ["test"],
    ...(declarations === null ? {} : { critical_functions: declarations }),
  };
  return project({ ...SOURCES, ...overrides, "kragg.json": JSON.stringify(config) });
}

const REASON = "authorization entrypoint";
const DECLARED = { "src/auth/login#verifyPassword": REASON };

/** An lcov tracefile in which the entrypoint was never entered. */
const LCOV = [
  "TN:",
  "SF:src/auth/login.ts",
  "DA:1,0",
  "DA:2,0",
  "FN:1,verifyPassword",
  "FNDA:0,verifyPassword",
  "end_of_record",
  "",
].join("\n");

/** Run `kragg criticality --write` and hand back its exit code and output. */
function write(root: string): { readonly code: number; readonly errors: string[] } {
  const errors: string[] = [];
  const code = runCriticality({
    root,
    write: true,
    log: (): void => undefined,
    logError: (line: string): void => void errors.push(line),
  });
  return { code, errors };
}

/** Is this name marked critical in the sidecar, as the gates would read it? */
function criticalInSidecar(root: string, name: string): boolean {
  return readJson(root).some(
    (record) => record["name"] === name && record["is_critical"] === true,
  );
}

/* --- 1. a declaration is enforced ---------------------------------------- */

describe("an undeclared low-fan-in entrypoint is invisible to the gates", () => {
  const root = fixture();
  const written = write(root);

  it("ranks it uncritical, because that is what the call graph says", () => {
    assert.equal(written.code, EXIT_OK);
    assert.equal(criticalInSidecar(root, "src/auth/login#verifyPassword"), false);
    // The hub three functions call IS selected: the graph is working, and it
    // is measuring the wrong thing about `verifyPassword`.
    assert.equal(criticalInSidecar(root, "src/text#normalize"), true);
  });

  it("keeps it out of every downstream consumer", () => {
    const names = criticalFunctions(root, ["src"], { api: ts }).map((one) => one.qualname);
    assert.ok(!names.includes("src/auth/login#verifyPassword"));
    const outcome = checkTestQuality({
      root,
      testPaths: ["test"],
      sourcePaths: ["src"],
      api: ts,
    });
    assert.equal(outcome.ok && !outcome.skipped, true);
    const messages = outcome.ok && !outcome.skipped
      ? outcome.violations.map((violation) => violation.message)
      : [];
    assert.ok(!messages.some((message) => message.includes("verifyPassword")));
  });
});

describe("a declared entrypoint is critical everywhere the graph's own are", () => {
  const root = fixture(DECLARED);
  const written = write(root);

  it("reaches the sidecar as an ordinary critical record", () => {
    assert.equal(written.code, EXIT_OK);
    assert.equal(criticalInSidecar(root, "src/auth/login#verifyPassword"), true);
  });

  it("adds NO key to the cross-language record shape", () => {
    for (const record of readJson(root)) {
      assert.deepEqual(Object.keys(record), [
        "name",
        "fan_in",
        "fan_out",
        "betweenness",
        "is_critical",
        "risk",
      ]);
    }
    // The reason lives in the policy, and only there.
    const raw = readFileSync(criticalityPath(root), "utf8");
    assert.ok(!raw.includes(REASON));
  });

  it("keeps its real metrics: declaring does not invent a fan-in", () => {
    const record = readJson(root).find(
      (entry) => entry["name"] === "src/auth/login#verifyPassword",
    );
    assert.equal(record?.["fan_in"], 1);
    assert.equal(record?.["betweenness"], 0);
    assert.equal(record?.["risk"], "low");
  });

  it("resolves through criticalFunctions, carrying the reviewer's reason", () => {
    const found = criticalFunctions(root, ["src"], { api: ts }).find(
      (one) => one.qualname === "src/auth/login#verifyPassword",
    );
    assert.equal(found?.file, "src/auth/login.ts");
    assert.equal(found?.name, "verifyPassword");
    assert.equal(found?.declaredReason, REASON);
  });

  it("fails test-quality, naming the function and why it is gated", () => {
    const outcome = checkTestQuality({
      root,
      testPaths: ["test"],
      sourcePaths: ["src"],
      api: ts,
    });
    assert.equal(outcome.ok && !outcome.skipped, true);
    const violations = outcome.ok && !outcome.skipped ? outcome.violations : [];
    const finding = violations.find((violation) => violation.code === "critical-untested");
    assert.equal(
      finding?.message,
      `no test references critical function src/auth/login#verifyPassword (declared: ${REASON})`,
    );
  });

  it("fails critical-coverage, with the reason in the message", () => {
    const outcome = checkCriticalCoverage({
      root,
      sourcePaths: ["src"],
      report: null,
      lcov: LCOV,
      api: ts,
    });
    assert.equal(outcome.ok && !outcome.skipped, true);
    const violations = outcome.ok && !outcome.skipped ? outcome.violations : [];
    assert.ok(
      violations.some((violation) =>
        violation.message.startsWith(
          `critical function src/auth/login#verifyPassword (declared: ${REASON}) has`,
        ),
      ),
      `expected a declared finding, got ${JSON.stringify(violations)}`,
    );
  });

  it("says why in `kragg coverage`, not just a fan-in of 1", () => {
    const gaps = criticalCoverageGaps({
      root,
      sourcePaths: ["src"],
      report: null,
      lcov: LCOV,
      api: ts,
    });
    assert.ok(
      renderGaps(gaps).some((line) =>
        line.includes(`src/auth/login#verifyPassword (declared: ${REASON})`),
      ),
      renderGaps(gaps).join("\n"),
    );
  });

  it("is a mutation target, like every other critical function", async () => {
    const selection = await selectTargets({ root, policy: loadPolicy(root) });
    assert.ok(selection.ok, selection.ok ? "" : selection.message);
    assert.equal(selection.source, "criticality");
    assert.ok(selection.files.includes("src/auth/login.ts"));
  });

  it("shows WHY in the table and in CRITICALITY.md", () => {
    const markdown = readFileSync(join(root, "CRITICALITY.md"), "utf8");
    assert.ok(markdown.includes("| Function | Fan-in | Fan-out | Centrality | Risk | Why |"));
    assert.ok(
      markdown.includes(`| \`src/auth/login#verifyPassword\` | 1 | 0 | 0.0000 | low | declared: ${REASON} |`),
      markdown,
    );
    const printed: string[] = [];
    runCriticality({ root, write: false, log: (line) => printed.push(line) });
    assert.ok(printed[0]?.endsWith("  Why"));
    assert.ok(
      printed.some(
        (line) =>
          line.startsWith("src/auth/login#verifyPassword") &&
          line.endsWith(`declared: ${REASON}`),
      ),
      printed.join("\n"),
    );
    // The graph's own selection says what made IT critical, in the same column.
    assert.ok(
      printed.some(
        (line) => line.startsWith("src/text#normalize") && line.includes("fan-in 4"),
      ),
      printed.join("\n"),
    );
  });
});

/* --- 2. a declaration never demotes -------------------------------------- */

describe("declaring a function the graph already selected", () => {
  const reviewed = "reviewed: input canonicalization";
  const root = fixture({ ...DECLARED, "src/text#normalize": reviewed });
  const written = write(root);

  it("leaves it critical and shows both reasons", () => {
    assert.equal(written.code, EXIT_OK);
    assert.equal(criticalInSidecar(root, "src/text#normalize"), true);
    const printed: string[] = [];
    runCriticality({ root, write: false, log: (line) => printed.push(line) });
    const row = printed.find((line) => line.startsWith("src/text#normalize"));
    assert.ok(row?.includes(`declared: ${reviewed}`), row);
    assert.ok(row?.includes("fan-in 4"), row);
  });

  it("adds to the critical population rather than replacing it", () => {
    const critical = readJson(root).filter((record) => record["is_critical"] === true);
    assert.deepEqual(
      critical.map((record) => record["name"]).toSorted(),
      ["src/auth/login#verifyPassword", "src/text#normalize"],
    );
  });
});

/* --- 3. a declaration cannot vanish -------------------------------------- */

describe("a declaration that matches no function in the program", () => {
  /** The fixture after `verifyPassword` was renamed and the entry was not. */
  function renamed(): string {
    return fixture(DECLARED, {
      "src/auth/login.ts": LOGIN.replaceAll("verifyPassword", "verifyPasswordHash"),
    });
  }

  it("fails `kragg criticality` with exit 3, naming the entry", () => {
    const root = renamed();
    const outcome = write(root);
    assert.equal(outcome.code, EXIT_ENVIRONMENT);
    const message = outcome.errors.join("\n");
    assert.match(message, /critical_functions names a function/u);
    assert.match(message, /src\/auth\/login#verifyPassword — declared critical: authorization/u);
    // The remedy is a one-line edit, so the nearest name is offered.
    assert.match(message, /did you mean src\/auth\/login#verifyPasswordHash\?/u);
  });

  it("writes nothing: a report nobody can trust is worse than none", () => {
    const root = renamed();
    write(root);
    assert.throws(() => readFileSync(criticalityPath(root), "utf8"));
    assert.throws(() => readFileSync(join(root, "CRITICALITY.md"), "utf8"));
  });

  /** A project whose sidecar is current but whose declaration is not. */
  function staleAgainstData(): string {
    const root = renamed();
    writeJson(
      [
        { name: "src/auth/login#verifyPasswordHash", fanIn: 1, fanOut: 0, betweenness: 0, isCritical: false },
        { name: "src/text#normalize", fanIn: 3, fanOut: 0, betweenness: 0.25, isCritical: true },
      ],
      criticalityPath(root),
    );
    writeStamp(root, ["src", "test"]);
    return root;
  }

  it("is an ERROR from every gate that consumes the data, never a pass", async () => {
    const root = staleAgainstData();
    assert.equal(hasCriticalityData(root), true);

    const tests = await checkCriticalTests({
      root,
      sourcePaths: ["src"],
      testPaths: ["test"],
      api: ts,
    });
    assert.equal(tests.ok, false);
    assert.match(tests.ok ? "" : tests.message, /critical_functions names a function/u);

    const quality = checkTestQuality({
      root,
      testPaths: ["test"],
      sourcePaths: ["src"],
      api: ts,
    });
    assert.equal(quality.ok, false);
    assert.match(quality.ok ? "" : quality.message, /verifyPassword/u);

    const coverage = checkCriticalCoverage({
      root,
      sourcePaths: ["src"],
      report: null,
      api: ts,
    });
    assert.equal(coverage.ok, false);
    assert.match(coverage.ok ? "" : coverage.message, /update the entry in kragg\.json/iu);
  });

  it("says nothing when every declaration resolves", () => {
    const root = fixture(DECLARED);
    write(root);
    assert.equal(declarationProblem(root), null);
  });
});

/* --- 4. the policy is applied at read time ------------------------------- */

describe("a declaration added after the last derivation", () => {
  it("takes effect on the next read, with no command to run in between", () => {
    // The sidecar below is what a run BEFORE the declaration existed wrote,
    // and its stamp is honest: no source file changed, so freshness vouches
    // for it and nothing re-derives. The declaration must still be in force.
    const root = fixture(DECLARED);
    writeJson(
      [
        { name: "src/auth/login#verifyPassword", fanIn: 1, fanOut: 0, betweenness: 0, isCritical: false },
      ],
      criticalityPath(root),
    );
    writeStamp(root, ["src", "test"]);
    assert.equal(criticalInSidecar(root, "src/auth/login#verifyPassword"), true);
    const found = criticalFunctions(root, ["src"], { api: ts });
    assert.deepEqual(found.map((one) => one.qualname), ["src/auth/login#verifyPassword"]);
  });

  it("never flips a critical record the other way", () => {
    const root = fixture(DECLARED);
    writeJson(
      [{ name: "src/text#normalize", fanIn: 3, fanOut: 0, betweenness: 0.25, isCritical: true }],
      criticalityPath(root),
    );
    writeStamp(root, ["src", "test"]);
    assert.equal(criticalInSidecar(root, "src/text#normalize"), true);
  });
});

/* --- rendering: the display limit must not hide a declaration ------------ */

describe("the twenty-row display limit", () => {
  /** Twenty-five ranked functions, with the declared one dead last. */
  const profiles: readonly FunctionProfile[] = [
    ...Array.from({ length: 25 }, (_unused, index) => ({
      name: `src/a#fn${String(index)}`,
      fanIn: 25 - index,
      fanOut: 0,
      betweenness: 0,
      isCritical: 25 - index >= 3,
    })),
    {
      name: "src/auth/login#verifyPassword",
      fanIn: 1,
      fanOut: 0,
      betweenness: 0,
      isCritical: true,
      declaredReason: REASON,
    },
  ];

  it("still shows the declared function a reviewer asked for", () => {
    // It ranks last BY CONSTRUCTION — that is why it needed declaring — so a
    // plain top-twenty slice would drop the one row a human added on purpose,
    // and the report would disagree with the gates enforcing on it.
    const lines = formatTable(profiles);
    assert.equal(lines.length, 23, "header, rule, twenty ranked rows, plus the declared one");
    assert.ok(lines.at(-1)?.startsWith("src/auth/login#verifyPassword"));
    const rows = formatReport(profiles).split("\n").filter((line) => line.startsWith("| `"));
    assert.equal(rows.length, 21);
    assert.ok(rows.some((row) => row.includes("declared: authorization entrypoint")));
  });

  it("keeps Python's exact columns when nothing is declared", () => {
    // The `Why` column is the one difference, and it appears only for a
    // project that asked the question it answers.
    const undeclared = profiles.filter((one) => one.declaredReason === undefined);
    const [header, , row] = formatTable(undeclared);
    assert.equal(header?.endsWith("Risk".padStart(8)), true, header);
    assert.equal(row?.endsWith("HIGH".padStart(8)), true, row);
    assert.ok(!formatReport(undeclared).includes("| Why |"));
  });
});

/* --- the pieces, on their own -------------------------------------------- */

describe("declaredCritical", () => {
  it("reads the policy's declarations, sorted by name", () => {
    const root = fixture({ "src/b#two": "second", "src/a#one": "first" });
    assert.deepEqual(declaredCritical(root), [
      ["src/a#one", "first"],
      ["src/b#two", "second"],
    ]);
  });

  it("is empty for a project that declares nothing", () => {
    assert.deepEqual(declaredCritical(fixture()), []);
  });

  it("yields nothing rather than throwing on a config that will not load", () => {
    // Every command loads the policy itself and exits 2 with the PolicyError
    // long before a gate reads this; the readers that call it must stay total.
    const root = project({ "kragg.json": "{ not json" });
    assert.deepEqual(declaredCritical(root), []);
  });
});

describe("missingDeclarations", () => {
  const gone = "src/auth/login#verifyPassword";
  const kept = "src/billing/charge#capturePayment";
  const declarations = [
    [gone, "authorization"],
    [kept, "money"],
  ] as const;

  it("reports only the entries no analysed name matches", () => {
    assert.deepEqual(missingDeclarations(declarations, [kept, "src/auth/login#login"]), [
      // Nothing in that program is one obvious edit away, so nothing is
      // suggested: a wrong suggestion is worse than none.
      { name: gone, reason: "authorization", nearest: undefined },
    ]);
  });

  it("suggests the nearest analysed name when a rename is obvious", () => {
    const [missing] = missingDeclarations(declarations, [
      "src/auth/login#verifyPasswordHash",
      kept,
    ]);
    assert.equal(missing?.nearest, "src/auth/login#verifyPasswordHash");
  });

  it("stays silent when nothing is obviously the same function", () => {
    // A move to a differently-named directory is several edits away, and the
    // budget is proportional on purpose: a confident wrong suggestion sends a
    // reviewer to declare the wrong function.
    const [missing] = missingDeclarations(declarations, [
      "src/accounts/passwords#verify",
      kept,
    ]);
    assert.equal(missing?.nearest, undefined);
  });

  it("returns no message at all when everything resolves", () => {
    assert.equal(staleDeclarationMessage(declarations, [gone, kept]), null);
    assert.equal(staleDeclarationMessage([], []), null);
  });
});
