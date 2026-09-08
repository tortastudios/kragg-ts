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
 * NAG — flagging a change that came with a colocated `src/foo.test.ts`, or a
 * change to a private or non-critical function — which gets it switched off.
 * Or it can go QUIET — passing outside a repository, or without criticality
 * data, where the honest answer is a visible skip and never a green.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import ts from "typescript";

import { runCommand } from "../src/engine/runner.ts";
import type { Violation } from "../src/engine/models.ts";
import { writeStamp } from "../src/gates/criticality.ts";
import {
  checkCriticalTests,
  CRITICAL_TESTS_CODE,
  NOT_A_REPOSITORY_REASON,
} from "../src/gates/criticalTests.ts";
import { NO_CRITICALITY_REASON } from "../src/gates/testDepth/outcome.ts";

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

/** A repository with criticality data and two committed source files. */
async function repo(extra: Readonly<Record<string, string>> = {}): Promise<string> {
  const root = scratchDir();
  await git(root, ["init", "--initial-branch=main"]);
  write(root, ".kragg/criticality.json", CRITICALITY);
  write(root, "src/client.ts", CLIENT);
  write(root, "src/other.ts", OTHER);
  write(root, "test/client.test.ts", `it("sends", () => { expect(1).toBe(1); });\n`);
  for (const [name, contents] of Object.entries(extra)) {
    write(root, name, contents);
  }
  await git(root, ["add", "."]);
  await git(root, [...COMMIT_FLAGS, "commit", "-m", "initial"]);
  return root;
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
    api: ts,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.skipped, false);
  return outcome.ok && !outcome.skipped ? outcome.violations : [];
}

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
    const messages = (await violationsFor(root)).map((violation) => violation.message);
    assert.deepEqual(messages, [
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
      api: ts,
    });
    // `error: true` and exit 3 in the pipeline — never a pass, and never a
    // silent drop back to "not critical".
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? "" : outcome.message, /src\/client#Client\.renamed/u);
  });

  it("passes when a file under a test path changed too", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not available");
      return;
    }
    const root = await repo();
    write(root, "src/client.ts", `${CLIENT}\n// edited\n`);
    write(root, "test/client.test.ts", `it("sends", () => { expect(2).toBe(2); });\n`);
    assert.deepEqual(await violationsFor(root), []);
  });

  it("accepts a colocated test file as a test change", async (t) => {
    if (!gitAvailable) {
      t.skip("git is not available");
      return;
    }
    const root = await repo();
    write(root, "src/client.ts", `${CLIENT}\n// edited\n`);
    write(root, "src/client.spec.ts", `it("sends", () => { expect(1).toBe(1); });\n`);
    assert.deepEqual(await violationsFor(root), []);
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
    const messages = (await violationsFor(root)).map((violation) => violation.message);
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

describe("critical-tests: when it cannot run", () => {
  it("skips with the criticality remediation when there is no data", async () => {
    const root = scratchDir();
    write(root, "src/client.ts", CLIENT);
    const outcome = await checkCriticalTests({
      root,
      sourcePaths: ["src"],
      testPaths: ["test"],
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
      api: ts,
    });
    assert.equal(
      outcome.ok && outcome.skipped && outcome.reason,
      NOT_A_REPOSITORY_REASON,
    );
  });
});
