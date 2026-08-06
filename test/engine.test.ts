/**
 * Tests for the gate pipeline and exit-code selection.
 *
 * Uses Node's built-in `node:test` + `node:assert/strict` — no test framework
 * dependency (see docs/dependency-policy.md). Run with `node --test test/`.
 *
 * These cover the two behaviours the cross-language contract actually turns
 * on: the tier/skip semantics of `runGates`, and the exit code a report
 * resolves to. Both must stay identical to the Python implementation.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FAST, runGates, SLOW, type GateSpec } from "../src/engine/gate.ts";
import {
  commandOutput,
  gateResult,
  type CompletedCommand,
  type GateResult,
} from "../src/engine/models.ts";
import {
  buildReport,
  EXIT_ENVIRONMENT,
  EXIT_GATE_FAILURES,
  EXIT_OK,
  reportExitCode,
  reportPassed,
} from "../src/engine/report.ts";

/** A gate that records that it ran, and returns the verdict we asked for. */
function spec(
  name: string,
  tier: typeof FAST | typeof SLOW,
  passed: boolean,
  ran: string[],
  extra: Partial<GateResult> = {},
): GateSpec {
  return {
    name,
    tier,
    run: () => {
      ran.push(name);
      return gateResult({ name, passed, ...extra });
    },
  };
}

function byName(results: readonly GateResult[], name: string): GateResult {
  const found = results.find((r) => r.name === name);
  assert.ok(found !== undefined, `expected a result named ${name}`);
  return found;
}

describe("runGates", () => {
  it("runs every fast gate even after one fails", async () => {
    // The whole point of the fast tier: one invocation reveals every
    // failure, so an agent never has to re-run to discover problem #2.
    const ran: string[] = [];
    const results = await runGates([
      spec("a", FAST, false, ran),
      spec("b", FAST, false, ran),
      spec("c", FAST, true, ran),
    ]);

    assert.deepEqual(ran, ["a", "b", "c"]);
    assert.equal(results.length, 3);
    assert.equal(results.filter((r) => r.skipped).length, 0);
  });

  it("skips slow gates when a fast gate failed", async () => {
    const ran: string[] = [];
    const results = await runGates([
      spec("fast", FAST, false, ran),
      spec("slow", SLOW, true, ran),
    ]);

    assert.deepEqual(ran, ["fast"], "the slow gate must not have run");
    const slow = byName(results, "slow");
    assert.equal(slow.skipped, true);
    assert.equal(slow.skipReason, "static gates failed");
    assert.equal(slow.passed, false);
  });

  it("runs slow gates anyway when forceSlow is set", async () => {
    const ran: string[] = [];
    const results = await runGates(
      [spec("fast", FAST, false, ran), spec("slow", SLOW, true, ran)],
      { forceSlow: true },
    );

    assert.deepEqual(ran, ["fast", "slow"]);
    assert.equal(byName(results, "slow").skipped, false);
  });

  it("does not skip slow gates when only a slow gate failed", async () => {
    const ran: string[] = [];
    await runGates([
      spec("slow1", SLOW, false, ran),
      spec("slow2", SLOW, true, ran),
    ]);

    assert.deepEqual(ran, ["slow1", "slow2"]);
  });

  it("halts every remaining gate under failFast, and reports them", async () => {
    const ran: string[] = [];
    const results = await runGates(
      [
        spec("a", FAST, false, ran),
        spec("b", FAST, true, ran),
        spec("c", SLOW, true, ran),
      ],
      { failFast: true },
    );

    assert.deepEqual(ran, ["a"]);
    // Halted gates are reported as skipped, not omitted: the report must
    // still account for the whole pipeline.
    assert.equal(results.length, 3);
    assert.equal(byName(results, "b").skipReason, "fail-fast");
    assert.equal(byName(results, "c").skipReason, "fail-fast");
  });

  it("honours a spec's own skipReason without running it", async () => {
    const ran: string[] = [];
    const results = await runGates([
      { ...spec("skipped", FAST, true, ran), skipReason: "no files changed" },
      spec("ran", FAST, true, ran),
    ]);

    assert.deepEqual(ran, ["ran"]);
    assert.equal(byName(results, "skipped").skipReason, "no files changed");
  });

  it("times each gate it runs", async () => {
    const ran: string[] = [];
    const results = await runGates([spec("a", FAST, true, ran)]);

    assert.ok(byName(results, "a").durationMs >= 0);
    assert.equal(Number.isInteger(byName(results, "a").durationMs), true);
  });

  it("returns results in spec order", async () => {
    const ran: string[] = [];
    const results = await runGates([
      spec("first", FAST, true, ran),
      spec("second", FAST, true, ran),
      spec("third", SLOW, true, ran),
    ]);

    assert.deepEqual(
      results.map((r) => r.name),
      ["first", "second", "third"],
    );
  });
});

describe("exit-code selection", () => {
  function report(results: readonly GateResult[]) {
    return buildReport({
      command: "check",
      mode: "all",
      targets: [],
      results,
      maxViolations: 25,
      startedAt: "2026-01-01T00:00:00+00:00",
      gitSha: null,
    });
  }

  it("is 0 when everything passed", () => {
    const r = report([gateResult({ name: "a", passed: true })]);
    assert.equal(reportPassed(r), true);
    assert.equal(reportExitCode(r), EXIT_OK);
  });

  it("is 0 when the only non-passing gates were skipped", () => {
    // A skipped gate never ran, so it cannot have failed.
    const r = report([
      gateResult({ name: "a", passed: true }),
      gateResult({ name: "b", passed: false, skipped: true, skipReason: "x" }),
    ]);
    assert.equal(reportPassed(r), true);
    assert.equal(reportExitCode(r), EXIT_OK);
  });

  it("is 1 when a gate found violations", () => {
    const r = report([
      gateResult({ name: "a", passed: true }),
      gateResult({ name: "b", passed: false, violationCount: 3 }),
    ]);
    assert.equal(reportPassed(r), false);
    assert.equal(reportExitCode(r), EXIT_GATE_FAILURES);
  });

  it("is 3 when a gate could not run, outranking gate failures", () => {
    // A broken environment makes every other finding unreliable, so it must
    // win over exit 1 no matter how many gates also failed.
    const r = report([
      gateResult({ name: "a", passed: false, violationCount: 9 }),
      gateResult({ name: "b", passed: false, error: true }),
    ]);
    assert.equal(reportExitCode(r), EXIT_ENVIRONMENT);
  });
});

describe("commandOutput", () => {
  function completed(stdout: string, stderr: string): CompletedCommand {
    return { name: "tool", command: ["tool"], cwd: "/repo", returncode: 1, stdout, stderr };
  }

  it("keeps BOTH streams, stdout first", () => {
    // REGRESSION. An earlier version preferred stderr, and that dropped the
    // actual cause of a failure: `execFile` writes its own
    // "Command failed: ..." wrapper to stderr while the tool's real message
    // goes to stdout. The wrapper names the command we already know; the line
    // below it is the only thing that says WHY.
    const output = commandOutput(
      completed(
        "<--- Last few GCs --->\nFATAL ERROR: JavaScript heap out of memory",
        "Command failed: node --max-old-space-size=64 build.js",
      ),
    );
    assert.match(output, /FATAL ERROR: JavaScript heap out of memory/);
    assert.match(output, /Command failed: node/);
    assert.ok(
      output.indexOf("FATAL ERROR") < output.indexOf("Command failed"),
      "stdout must come first: the cause reads before the wrapper",
    );
  });

  it("does not leave a blank line where a stream was empty", () => {
    // A report that opens with an empty line looks like output was lost.
    assert.equal(commandOutput(completed("only stdout\n", "")), "only stdout");
    assert.equal(commandOutput(completed("", "only stderr\n")), "only stderr");
    assert.equal(commandOutput(completed("out", "err")), "out\nerr");
  });

  it("is empty when the command said nothing", () => {
    // Not " " or "\n": a silent success must render as no output at all, so
    // callers can test it for emptiness.
    assert.equal(commandOutput(completed("", "")), "");
    assert.equal(commandOutput(completed("\n  \n", "  ")), "");
  });
});
