/**
 * Tests for the critical-tests gate.
 *
 * These drive real `git` against real throwaway repositories, for the reason
 * `changes.test.ts` gives: the behaviour under test IS the change set, and a
 * mocked diff would only assert that the fixture matches itself. Every test is
 * skipped when git is unavailable rather than failing, so the suite stays
 * honest on a machine without it.
 *
 * The cases are chosen around the two ways this gate can be wrong. It can
 * NAG — flagging a change that came with a colocated `src/foo.test.ts`, with
 * a test that reaches the function through an alias, a re-export or a shared
 * helper, or a change to a private or non-critical function — which gets it
 * switched off. Or it can go QUIET — passing outside a repository, without
 * criticality data, or on the strength of an unrelated test edit, a comment,
 * a string, or a skipped test — where the honest answer is a finding or a
 * visible skip and never a green.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import ts from "typescript";

import { analysisProgram } from "../src/analysis/program.ts";
import { runCommand } from "../src/engine/runner.ts";
import type { Violation } from "../src/engine/models.ts";
import { writeStamp } from "../src/gates/criticality.ts";
import {
  checkCriticalTests,
  CRITICAL_TESTS_CODE,
  NOT_A_REPOSITORY_REASON,
} from "../src/gates/criticalTests.ts";
import { NO_CRITICALITY_REASON } from "../src/gates/testDepth/outcome.ts";
import { OUTSIDE_PROGRAM_NOTE } from "../src/gates/testDepth/references.ts";

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
  assert.equal(result.returncode, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
}

function scratchDir(): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-critical-tests-"));
  roots.push(root);
  return root;
}

function write(root: string, relative: string, contents: string): void {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

const CRITICALITY = JSON.stringify([
  { name: "src/client#Client.send", fan_in: 9, is_critical: true },
  { name: "src/client#_internal", fan_in: 7, is_critical: true },
  { name: "src/other#Other.run", fan_in: 5, is_critical: true },
  { name: "src/auth#verifyPassword", fan_in: 4, is_critical: true },
  { name: "src/client#Client.idle", fan_in: 1, is_critical: false },
]);

const CLIENT = `
export class Client {
  send() {}
  idle() {}
}
export function _internal() {}
`;

const OTHER = `
export class Other {
  run() {}
}
`;

const AUTH = `
export function verifyPassword(given: string): boolean {
  return given.length > 3;
}
`;

/** Includes the test tree, so the checker can see the tests. */
const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "es2022",
    module: "nodenext",
    moduleResolution: "nodenext",
    strict: true,
    allowImportingTsExtensions: true,
    noEmit: true,
    types: [],
  },
  include: ["src", "test", "tests"],
});

/** The same project, with the test tree left out of the program. */
const TSCONFIG_SOURCES_ONLY = TSCONFIG.replace('"include":["src","test","tests"]', '"include":["src"]');

const UNRELATED_TEST = `it("unrelated", () => { expect(1).toBe(1); });\n`;

/** A repository with criticality data and three committed source files. */
async function repo(extra: Readonly<Record<string, string>> = {}): Promise<string> {
  const root = scratchDir();
  await git(root, ["init", "--initial-branch=main"]);
  write(root, "tsconfig.json", TSCONFIG);
  write(root, ".kragg/criticality.json", CRITICALITY);
  write(root, "src/client.ts", CLIENT);
  write(root, "src/other.ts", OTHER);
  write(root, "src/auth.ts", AUTH);
  write(root, "test/client.test.ts", `it("sends", () => { expect(1).toBe(1); });\n`);
  write(root, "test/other.test.ts", UNRELATED_TEST);
  for (const [name, contents] of Object.entries(extra)) {
    write(root, name, contents);
  }
  await git(root, ["add", "."]);
  await git(root, [...COMMIT_FLAGS, "commit", "-m", "initial"]);
  return root;
}

/** Rewrite the authorization entry point, the change every case is about. */
function editAuth(root: string): void {
  write(root, "src/auth.ts", `${AUTH}\n// edited\n`);
}

async function violationsFor(root: string): Promise<readonly Violation[]> {
  // Vouch for the fixture's criticality data at the LAST possible moment —
  // after the test has made whatever edit it is about. This gate is precisely
  // about changed source files, and every such change invalidates the cache,
  // so in the real pipeline the gate is preceded by a derive. Stamping here
  // stands in for that derive; see `gates/criticality/freshness.ts`.
  writeStamp(root, ["src", "test", "tests"]);
  const outcome = await checkCriticalTests({
    root,
    sourcePaths: ["src"],
    testPaths: ["test", "tests"],
    program: analysisProgram({ root, api: ts }),
    api: ts,
  });
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.message);
  assert.equal(outcome.ok && outcome.skipped, false);
  return outcome.ok && !outcome.skipped ? outcome.violations : [];
}

async function messagesFor(root: string): Promise<readonly string[]> {
  return (await violationsFor(root)).map((violation) => violation.message);
}

const AUTH_UNTESTED =
  "critical function src/auth#verifyPassword (fan-in 4) changed without ";

describe("critical-tests: the rule", () => {
  it("passes when nothing changed", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not available");
      return;
    }
    assert.deepEqual(await violationsFor(await repo()), []);
  });

  it("fails when a critical function's file changed alone", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not available");
      return;
    }
    const root = await repo();
    write(root, "src/client.ts", `${CLIENT}\n// edited\n`);
    const violations = await violationsFor(root);
    assert.equal(violations.length, 1);
    const violation = violations[0];
    assert.ok(violation !== undefined);
    assert.equal(
      violation.message,
      "critical function src/client#Client.send (fan-in 9) changed without test changes",
    );
    assert.equal(violation.file, "src/client.ts");
    assert.equal(violation.code, CRITICAL_TESTS_CODE);
    assert.equal(
      violation.fixHint,
      "add or update a test covering send, or revert the change",
    );
  });

  it("gates a DECLARED function, and says who declared it", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not available");
      return;
    }
    // `Client.idle` has fan-in 1 and the criticality run did not select it; a
    // reviewer did. The finding has to say so, or a fan-in-1 function being
    // gated reads as a false positive and gets suppressed.
    const root = await repo({
      "kragg.json": JSON.stringify({
        critical_functions: { "src/client#Client.idle": "shuts the session down" },
      }),
    });
    write(root, "src/client.ts", `${CLIENT}\n// edited\n`);
    assert.deepEqual(await messagesFor(root), [
      "critical function src/client#Client.send (fan-in 9) changed without test changes",
      "critical function src/client#Client.idle (declared: shuts the session down) " +
        "changed without test changes",
    ]);
  });

  it("errors, rather than going quiet, when a declaration names nothing", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not available");
      return;
    }
    const root = await repo({
      "kragg.json": JSON.stringify({
        critical_functions: { "src/client#Client.renamed": "authorization" },
      }),
    });
    write(root, "src/client.ts", `${CLIENT}\n// edited\n`);
    writeStamp(root, ["src", "test", "tests"]);
    const outcome = await checkCriticalTests({
      root,
      sourcePaths: ["src"],
      testPaths: ["test", "tests"],
      program: analysisProgram({ root, api: ts }),
      api: ts,
    });
    // `error: true` and exit 3 in the pipeline — never a pass, and never a
    // silent drop back to "not critical".
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? "" : outcome.message, /src\/client#Client\.renamed/u);
  });

  it("reports every critical function in every changed file", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not available");
      return;
    }
    const root = await repo();
    write(root, "src/client.ts", `${CLIENT}\n// edited\n`);
    write(root, "src/other.ts", `${OTHER}\n// edited\n`);
    assert.deepEqual(
      (await violationsFor(root)).map((violation) => violation.file),
      ["src/client.ts", "src/other.ts"],
    );
  });

  it("says nothing about a file with no critical function in it", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not available");
      return;
    }
    const root = await repo({ "src/plain.ts": "export const a = 1;\n" });
    write(root, "src/plain.ts", "export const a = 2;\n");
    assert.deepEqual(await violationsFor(root), []);
  });

  it("exempts private and non-critical functions", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not available");
      return;
    }
    const root = await repo();
    write(root, "src/client.ts", `${CLIENT}\n// edited\n`);
    const messages = await messagesFor(root);
    assert.equal(messages.length, 1, messages.join("; "));
    assert.doesNotMatch(messages[0] ?? "", /_internal|idle/);
  });

  it("sees an untracked new file", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not available");
      return;
    }
    const root = scratchDir();
    await git(root, ["init", "--initial-branch=main"]);
    write(root, ".kragg/criticality.json", CRITICALITY);
    write(root, "src/other.ts", OTHER);
    await git(root, ["add", "."]);
    await git(root, [...COMMIT_FLAGS, "commit", "-m", "initial"]);
    write(root, "src/client.ts", CLIENT);
    assert.deepEqual(
      (await violationsFor(root)).map((violation) => violation.file),
      ["src/client.ts"],
    );
  });
});

/**
 * The evidence rule. A changed test file vouches for a changed critical
 * function only when the checker binds something in it — or in a test-tree
 * module it imports — to the function or to its module. Names in comments,
 * strings and skipped tests, and edits to unrelated test files, do not.
 */
describe("critical-tests: which test changes count", () => {
  it("rejects an unrelated test edit, and says what it examined", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not available");
      return;
    }
    const root = await repo();
    editAuth(root);
    // A whitespace-only change to a test that never touches `src/auth`.
    write(root, "test/other.test.ts", `${UNRELATED_TEST}\n`);
    assert.deepEqual(await messagesFor(root), [
      `${AUTH_UNTESTED}a relevant test change: examined test/other.test.ts ` +
        "(no bound reference to verifyPassword or module src/auth)",
    ]);
  });

  it("rejects a test that names the function only in a comment or a string", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not available");
      return;
    }
    const root = await repo();
    editAuth(root);
    write(
      root,
      "test/auth.test.ts",
      `// TODO verifyPassword\nit("verifyPassword works", () => { expect(1).toBe(1); });\n`,
    );
    assert.deepEqual(await messagesFor(root), [
      `${AUTH_UNTESTED}a relevant test change: examined test/auth.test.ts ` +
        "(no bound reference to verifyPassword or module src/auth)",
    ]);
  });

  it("accepts a test that calls the function", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not available");
      return;
    }
    const root = await repo();
    editAuth(root);
    write(
      root,
      "test/auth.test.ts",
      'import { verifyPassword } from "../src/auth.ts";\n' +
        'it("rejects short input", () => { expect(verifyPassword("ab")).toBe(false); });\n',
    );
    assert.deepEqual(await violationsFor(root), []);
  });

  it("accepts a test that binds the function's module without naming it", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not available");
      return;
    }
    const root = await repo();
    write(root, "src/client.ts", `${CLIENT}\n// edited\n`);
    // Constructs the class and never calls `send`: still the module's test.
    write(
      root,
      "test/client.test.ts",
      'import { Client } from "../src/client.ts";\n' +
        'it("builds", () => { expect(new Client()).toBeTruthy(); });\n',
    );
    assert.deepEqual(await violationsFor(root), []);
  });

  it("accepts a colocated test file that binds the function", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not available");
      return;
    }
    const root = await repo();
    write(root, "src/client.ts", `${CLIENT}\n// edited\n`);
    write(
      root,
      "src/client.spec.ts",
      'import { Client } from "./client.ts";\n' +
        'it("sends", () => { expect(new Client().send()).toBe(undefined); });\n',
    );
    assert.deepEqual(await violationsFor(root), []);
  });

  it("follows an alias through a re-exporting barrel", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not available");
      return;
    }
    const root = await repo({
      "test/barrel.ts": 'export { verifyPassword as vp } from "../src/auth.ts";\n',
    });
    editAuth(root);
    write(
      root,
      "test/auth.test.ts",
      'import { vp } from "./barrel.ts";\nit("aliases", () => { expect(vp("abcd")).toBe(true); });\n',
    );
    assert.deepEqual(await violationsFor(root), []);
  });

  it("follows a shared helper the changed test imports", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not available");
      return;
    }
    // The helper is committed and unchanged; only the test that calls it is
    // edited. The helper binds `verifyPassword`, so the test reaches it.
    const root = await repo({
      "test/helpers.ts":
        'import { verifyPassword } from "../src/auth.ts";\n' +
        "export function expectAuth(given: string): boolean { return verifyPassword(given); }\n",
    });
    editAuth(root);
    write(
      root,
      "test/auth.test.ts",
      'import { expectAuth } from "./helpers.ts";\n' +
        'it("via helper", () => { expect(expectAuth("abcd")).toBe(true); });\n',
    );
    assert.deepEqual(await violationsFor(root), []);
  });

  it("accepts the function passed to a helper rather than called", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not available");
      return;
    }
    const root = await repo({
      "test/helpers.ts":
        "export function expectAuth(check: (given: string) => boolean): void { check('abcd'); }\n",
    });
    editAuth(root);
    write(
      root,
      "test/auth.test.ts",
      'import { verifyPassword } from "../src/auth.ts";\n' +
        'import { expectAuth } from "./helpers.ts";\n' +
        'it("indirect", () => { expectAuth(verifyPassword); expect(1).toBe(1); });\n',
    );
    assert.deepEqual(await violationsFor(root), []);
  });

  it("rejects a reference that sits only inside a skipped test, saying so", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not available");
      return;
    }
    const root = await repo();
    editAuth(root);
    write(
      root,
      "test/auth.test.ts",
      'import { verifyPassword } from "../src/auth.ts";\n' +
        'it.skip("later", () => { expect(verifyPassword("ab")).toBe(false); });\n' +
        'describe.skip("group", () => { it("x", () => { verifyPassword("ab"); }); });\n',
    );
    assert.deepEqual(await messagesFor(root), [
      `${AUTH_UNTESTED}a relevant test change: examined test/auth.test.ts ` +
        "(binds verifyPassword only inside a skipped or todo test)",
    ]);
  });

  it("does not let a same-named unrelated symbol vouch for the function", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not available");
      return;
    }
    const root = await repo();
    editAuth(root);
    write(
      root,
      "test/auth.test.ts",
      "function verifyPassword(): boolean { return true; }\n" +
        'it("local", () => { expect(verifyPassword()).toBe(true); });\n',
    );
    assert.equal((await violationsFor(root)).length, 1);
  });

  it("names a test file the program does not contain as unresolvable", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not available");
      return;
    }
    const root = await repo({ "tsconfig.json": TSCONFIG_SOURCES_ONLY });
    editAuth(root);
    write(
      root,
      "test/auth.test.ts",
      'import { verifyPassword } from "../src/auth.ts";\n' +
        'it("calls", () => { expect(verifyPassword("ab")).toBe(false); });\n',
    );
    assert.deepEqual(await messagesFor(root), [
      `${AUTH_UNTESTED}a relevant test change: examined test/auth.test.ts (${OUTSIDE_PROGRAM_NOTE})`,
    ]);
  });

  it("caps the examined list and counts the rest", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not available");
      return;
    }
    const root = await repo();
    editAuth(root);
    for (const name of ["a", "b", "c", "d", "e", "f", "g"]) {
      write(root, `test/${name}.test.ts`, UNRELATED_TEST);
    }
    const [message] = await messagesFor(root);
    assert.match(message ?? "", /examined test\/a\.test\.ts \(.*\), test\/b\.test\.ts/u);
    assert.match(message ?? "", /, and 2 more$/u);
  });

  it("errors when the program needed to bind the test cannot be built", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not available");
      return;
    }
    const root = await repo({ "tsconfig.json": "{ this is not json" });
    editAuth(root);
    write(root, "test/auth.test.ts", UNRELATED_TEST);
    writeStamp(root, ["src", "test", "tests"]);
    const outcome = await checkCriticalTests({
      root,
      sourcePaths: ["src"],
      testPaths: ["test", "tests"],
      program: analysisProgram({ root, api: ts }),
      api: ts,
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? "" : outcome.message, /tsconfig\.json/u);
  });

  it("does not need the program when no test file changed", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not available");
      return;
    }
    const root = await repo({ "tsconfig.json": "{ this is not json" });
    editAuth(root);
    writeStamp(root, ["src", "test", "tests"]);
    const program = analysisProgram({ root, api: ts });
    const outcome = await checkCriticalTests({
      root,
      sourcePaths: ["src"],
      testPaths: ["test", "tests"],
      program,
      api: ts,
    });
    assert.equal(outcome.ok && !outcome.skipped && outcome.violations.length, 1);
    assert.equal(program.loaded(), false);
  });
});

describe("critical-tests: when it cannot run", () => {
  it("skips with the criticality remediation when there is no data", async () => {
    const root = scratchDir();
    write(root, "src/client.ts", CLIENT);
    const outcome = await checkCriticalTests({
      root,
      sourcePaths: ["src"],
      testPaths: ["test"],
      program: analysisProgram({ root, api: ts }),
      api: ts,
    });
    assert.equal(outcome.ok && outcome.skipped && outcome.reason, NO_CRITICALITY_REASON);
  });

  it("skips rather than passing outside a git repository", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not available");
      return;
    }
    const root = scratchDir();
    write(root, ".kragg/criticality.json", CRITICALITY);
    write(root, "src/client.ts", CLIENT);
    // Current data, so the skip under test is "not a repository" and not the
    // freshness one. Two reasons to skip would prove nothing about either.
    writeStamp(root, ["src", "test"]);
    const outcome = await checkCriticalTests({
      root,
      sourcePaths: ["src"],
      testPaths: ["test"],
      program: analysisProgram({ root, api: ts }),
      api: ts,
    });
    assert.equal(
      outcome.ok && outcome.skipped && outcome.reason,
      NOT_A_REPOSITORY_REASON,
    );
  });
});
