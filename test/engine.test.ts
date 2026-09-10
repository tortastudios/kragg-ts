/**
 * Tests for the gate pipeline and exit-code selection.
 *
 * Uses Node's built-in `node:test` + `node:assert/strict` — no test framework
 * dependency (see docs/dependency-policy.md). Run with `node --test test/`.
 *
 * These cover the two behaviours the cross-language contract actually turns
 * on: the tier/skip semantics of `runGates`, and the exit code a report
 * resolves to. Both are pinned by `crag/spec/SPEC.md`, which is the authority
 * where the Python implementation and the spec disagree — see
 * docs/spec-conformance.md for the two places they do here.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { FAST, runGates, SLOW, type GateSpec } from "../src/engine/gate.ts";
import {
  appendRun,
  journalPath,
  JOURNAL_DIR,
  readRuns,
  renderStatusLines,
  type JournalEntry,
  type JournalGate,
} from "../src/engine/journal.ts";
import {
  commandOutput,
  gateResult,
  type CompletedCommand,
  type GateResult,
  type Violation,
} from "../src/engine/models.ts";
import {
  buildReport,
  EXIT_ENVIRONMENT,
  EXIT_GATE_FAILURES,
  EXIT_OK,
  renderText,
  reportExitCode,
  reportPassed,
} from "../src/engine/report.ts";
import { toPayload, type ReportPayload } from "../src/engine/reportPayload.ts";

/** Temporary journal roots, removed after the suite. */
const journalRoots: string[] = [];

after(() => {
  for (const root of journalRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A real payload, built the way `runPipeline` builds the one it journals. */
function journalPayload(command: string, passed: boolean, gateName: string): ReportPayload {
  return toPayload(
    buildReport({
      command,
      mode: "full",
      targets: [],
      results: [
        gateResult({
          name: gateName,
          passed,
          violations: passed ? [] : [{ message: "x" }],
        }),
      ],
      maxViolations: 25,
      startedAt: "2026-01-01T00:00:00+00:00",
      gitSha: null,
    }),
  );
}

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

  it("does not skip slow gates for a spec-level skip either", async () => {
    // The spec-level skip (`skipReason` on the `GateSpec`) never reached the
    // halt decision, because the gate never ran. Pinned so the two kinds of
    // skip cannot drift apart again: an unconfigured gate and a gate that
    // discovered it had nothing to check are the same fact.
    const ran: string[] = [];
    const results = await runGates([
      { ...spec("fast", FAST, true, ran), skipReason: "no layers configured" },
      spec("slow", SLOW, true, ran),
    ]);

    assert.deepEqual(ran, ["slow"]);
    assert.equal(byName(results, "slow").skipped, false);
    assert.equal(byName(results, "fast").skipReason, "no layers configured");
  });

  it("does not skip slow gates when a fast gate skipped from inside its run", async () => {
    // THE FALSE GREEN THIS CLOSES. A visible skip is `passed: false,
    // skipped: true`, and a gate can only discover it has nothing to check
    // ONCE IT RUNS — `detect-secrets` with no scanner installed, `lint` with
    // no linter, `critical-tests` outside a git repository. Reading that as a
    // failure skipped the entire slow tier with "static gates failed": on
    // this repo, 14 green gates, exit 0, and the tests never run.
    const ran: string[] = [];
    const results = await runGates([
      spec("fast", FAST, false, ran, {
        skipped: true,
        skipReason: "no secret scanner available",
      }),
      spec("slow", SLOW, true, ran),
    ]);

    assert.deepEqual(ran, ["fast", "slow"], "the slow gate must still run");
    assert.equal(byName(results, "slow").skipped, false);
    assert.equal(byName(results, "slow").passed, true);
    assert.equal(byName(results, "fast").skipReason, "no secret scanner available");
  });

  it("does not halt under failFast on a gate that skipped from inside its run", async () => {
    const ran: string[] = [];
    const results = await runGates(
      [
        spec("a", FAST, false, ran, { skipped: true, skipReason: "nothing configured" }),
        spec("b", FAST, true, ran),
        spec("c", SLOW, true, ran),
      ],
      { failFast: true },
    );

    assert.deepEqual(ran, ["a", "b", "c"]);
    assert.equal(byName(results, "b").skipReason, null);
    assert.equal(byName(results, "c").skipReason, null);
  });

  it("still skips slow gates when a fast gate errored", async () => {
    // `error: true` is NOT a skip: the gate tried and could not, so nothing
    // was learned about the code and the slow tier would be measuring the
    // same broken environment. Fail closed.
    const ran: string[] = [];
    const results = await runGates([
      spec("fast", FAST, false, ran, { error: true, output: "tsc is not installed" }),
      spec("slow", SLOW, true, ran),
    ]);

    assert.deepEqual(ran, ["fast"]);
    assert.equal(byName(results, "slow").skipReason, "static gates failed");
  });

  it("turns a gate that throws into an errored gate, and keeps going", async () => {
    // `run` is arbitrary code over an untrusted tree. An exception used to
    // propagate out of `runGates`, so `cli.ts` printed one stderr line and
    // the whole consolidated report — every other gate's result included —
    // was lost. The gate is `error: true` instead, and the pipeline finishes.
    const ran: string[] = [];
    const results = await runGates([
      spec("first", FAST, true, ran),
      { name: "boom", tier: FAST, run: () => { ran.push("boom"); throw new Error("ENOENT: src/gone.ts"); } },
      spec("later", FAST, true, ran),
      spec("slow", SLOW, true, ran),
    ]);

    assert.deepEqual(ran, ["first", "boom", "later"], "the fast tier must finish");
    assert.equal(results.length, 4);
    const boom = byName(results, "boom");
    assert.equal(boom.error, true);
    assert.equal(boom.passed, false);
    assert.equal(boom.skipped, false, "a thrown gate is never a skip");
    assert.match(boom.output, /ENOENT: src\/gone\.ts/u, "the message must not be swallowed");
    // Fail closed, like any other error: the slow tier is not run on top of it.
    assert.equal(byName(results, "slow").skipReason, "static gates failed");
  });

  it("reports a non-Error throw without inventing a message", async () => {
    const results = await runGates([
      { name: "boom", tier: FAST, run: () => { throw "just a string"; } },
    ]);

    assert.equal(byName(results, "boom").error, true);
    assert.match(byName(results, "boom").output, /just a string/u);
  });

  it("halts the rest of the pipeline under failFast when a gate throws", async () => {
    const ran: string[] = [];
    const results = await runGates(
      [
        { name: "boom", tier: FAST, run: () => { ran.push("boom"); throw new Error("nope"); } },
        spec("b", FAST, true, ran),
      ],
      { failFast: true },
    );

    assert.deepEqual(ran, ["boom"]);
    assert.equal(byName(results, "b").skipReason, "fail-fast");
  });

  it("runs the slow tier under forceSlow even when a fast gate threw", async () => {
    // `--all` means "run them anyway". An error must not quietly re-acquire
    // the veto the flag just took away.
    const ran: string[] = [];
    const results = await runGates(
      [
        { name: "boom", tier: FAST, run: () => { ran.push("boom"); throw new Error("nope"); } },
        spec("slow", SLOW, true, ran),
      ],
      { forceSlow: true },
    );

    assert.deepEqual(ran, ["boom", "slow"]);
    assert.equal(byName(results, "slow").skipped, false);
  });

  it("times a gate that threw like any other", async () => {
    const results = await runGates([
      { name: "boom", tier: FAST, run: () => { throw new Error("nope"); } },
    ]);

    assert.equal(Number.isInteger(byName(results, "boom").durationMs), true);
    assert.ok(byName(results, "boom").durationMs >= 0);
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

  it("keeps the three states apart in one report: skip 0, failure 1, error 3", async () => {
    // The whole priority order in one pipeline, from `runGates` rather than
    // hand-built results: a runtime skip must not lift the exit code, a
    // failure must, and an error — here, a gate that threw — must outrank it.
    const ran: string[] = [];
    const r = report(
      await runGates([
        spec("skipper", FAST, false, ran, { skipped: true, skipReason: "nothing configured" }),
        spec("failer", FAST, false, ran, { violationCount: 2 }),
        { name: "thrower", tier: FAST, run: () => { throw new Error("boom"); } },
      ]),
    );

    assert.equal(reportExitCode(r), EXIT_ENVIRONMENT);
    assert.equal(reportExitCode(report(await runGates([
      spec("skipper", FAST, false, ran, { skipped: true, skipReason: "nothing configured" }),
      spec("failer", FAST, false, ran, { violationCount: 2 }),
    ]))), EXIT_GATE_FAILURES);
    assert.equal(reportExitCode(report(await runGates([
      spec("skipper", FAST, false, ran, { skipped: true, skipReason: "nothing configured" }),
      spec("passer", FAST, true, ran),
    ]))), EXIT_OK);
  });

  it("puts a thrown gate's message on the wire and into next_actions", async () => {
    // "Do not swallow the exception" is only true if a reader can see it. It
    // reaches `raw_output` because an errored gate with no parsed violations
    // is exactly the case `processGate` keeps raw output for, and the `Fix:`
    // line is what `next_actions` lifts out of an errored gate.
    const payload = toPayload(
      report(
        await runGates([
          { name: "boom", tier: FAST, run: () => { throw new Error("ENOENT: src/gone.ts"); } },
        ]),
      ),
    );

    assert.equal(payload.exit_code, EXIT_ENVIRONMENT);
    assert.equal(payload.gates[0]?.error, true);
    assert.match(payload.gates[0]?.raw_output ?? "", /ENOENT: src\/gone\.ts/u);
    assert.match(payload.next_actions.join("\n"), /^boom: Fix: /mu);
    // And it is not dressed up as a finding about the project's code.
    assert.equal(payload.gates[0]?.violation_count, 0);
    assert.deepEqual(payload.gates[0]?.violations, []);
  });

  it("counts a gate that threw as failed in the summary, never as skipped", () => {
    const r = report([
      gateResult({ name: "a", passed: true }),
      gateResult({ name: "b", passed: false, error: true, output: "threw" }),
      gateResult({ name: "c", passed: false, skipped: true, skipReason: "x" }),
    ]);
    assert.deepEqual(toPayload(r).summary, {
      gates_total: 3,
      gates_passed: 1,
      gates_failed: 1,
      gates_skipped: 1,
      violations_total: 0,
      violations_shown: 0,
    });
  });
});

/**
 * TOR-1418 — dedupe collapses REPEATS, never LOCATIONS.
 *
 * The defect: a family of findings sharing a `(code, message)` was folded into
 * one violation object whose `message` named the other locations in prose —
 * `… (+2 more at src/scene.ts, src/simulation.ts)` — and no structured field
 * named them at all. A consumer filtering `violations` by `file` (a file-scoped
 * agent deciding what it has been assigned) saw one file where three had been
 * flagged, and read the other two as clean.
 *
 * What is pinned here is that every distinct location survives as its own
 * violation object, and that `truncated`/`violation_count` keep meaning what
 * they meant: genuine overflow past the per-gate cap, never this folding.
 */
describe("violation dedupe", () => {
  const mi = (file: string): Violation => ({
    message: "maintainability index grade C (minimum: A)",
    file,
    code: "MI-C",
  });

  function payloadOf(violations: readonly Violation[], maxViolations = 25) {
    const gate = toPayload(
      buildReport({
        command: "check",
        mode: "full",
        targets: [],
        results: [
          gateResult({
            name: "maintainability",
            passed: false,
            violations,
            violationCount: violations.length,
          }),
        ],
        maxViolations,
        startedAt: "2026-01-01T00:00:00+00:00",
        gitSha: null,
      }),
    ).gates[0];
    assert.ok(gate !== undefined);
    return gate;
  }

  it("keeps one structured entry per file for a family spanning three files", () => {
    const gate = payloadOf([mi("src/main.ts"), mi("src/scene.ts"), mi("src/simulation.ts")]);
    assert.deepEqual(
      gate.violations.map((v) => v.file),
      ["src/main.ts", "src/scene.ts", "src/simulation.ts"],
    );
    assert.equal(gate.violation_count, 3);
    assert.equal(gate.truncated, false, "nothing overflowed the cap");
    for (const violation of gate.violations) {
      assert.doesNotMatch(violation.message, /more at/, "no location may live in prose");
    }
  });

  it("lets a file-scoped consumer recover its own work from `file` alone", () => {
    const gate = payloadOf([mi("src/main.ts"), mi("src/scene.ts"), mi("src/simulation.ts")]);
    const mine = gate.violations.filter((v) => v.file === "src/simulation.ts");
    assert.equal(mine.length, 1, "the file the folded payload used to call clean");
  });

  it("keeps two findings in ONE file apart when their lines differ", () => {
    // The same-file half of the defect: line 24 used to exist only inside
    // line 20's message.
    const call = (line: number): Violation => ({
      message: "forbidden call `src/unsafe.runShell` (banned: `src/unsafe`)",
      file: "src/index.ts",
      line,
      column: 10,
      code: "forbidden-call",
    });
    const gate = payloadOf([call(20), call(24)]);
    assert.deepEqual(
      gate.violations.map((v) => v.line),
      [20, 24],
    );
  });

  it("still collapses the identical finding reported twice at one location", () => {
    // Nothing is hidden: both entries pointed at the same place.
    const gate = payloadOf([mi("src/main.ts"), mi("src/main.ts")]);
    assert.equal(gate.violations.length, 1);
    assert.equal(gate.violations[0]?.message.endsWith("(+1 more)"), true);
    assert.equal(gate.violation_count, 2, "the raw total is untouched");
    assert.equal(gate.truncated, false, "dedupe is not overflow");
  });

  it("reports `truncated` for real overflow past the cap, and only that", () => {
    const files = ["a", "b", "c", "d"].map((n) => mi(`src/${n}.ts`));
    const capped = payloadOf(files, 2);
    assert.equal(capped.violations.length, 2);
    assert.equal(capped.violation_count, 4);
    assert.equal(capped.truncated, true);
    assert.equal(payloadOf(files, 4).truncated, false);
  });
});

/**
 * The advisory channel.
 *
 * Advisories exist for findings a reader must SEE but must not be blocked by —
 * `skipLibCheck`, a non-null assertion, a severity floor that filtered
 * something out. Two properties carry the whole design, and each has the
 * failure mode it prevents written next to it: they never move the verdict,
 * and they are printed on a PASSING gate, which is the case they exist for and
 * the case the old `output` bucket could not reach.
 */
describe("advisories", () => {
  const hatch = (line: number): Violation => ({
    message: "skipLibCheck is enabled",
    file: "tsconfig.json",
    line,
    code: "tsconfig-advisory-flag",
  });

  function reportOf(result: GateResult, maxViolations = 25) {
    return buildReport({
      command: "check",
      mode: "all",
      targets: [],
      results: [result],
      maxViolations,
      startedAt: "2026-01-01T00:00:00+00:00",
      gitSha: null,
    });
  }

  it("never move the verdict, the counts or the exit code", () => {
    // An advisory that changed the outcome would just be a violation with
    // extra steps, and the split would be pointless.
    const r = reportOf(
      gateResult({ name: "typing-strictness", passed: true, advisories: [hatch(3)] }),
    );
    assert.equal(reportPassed(r), true);
    assert.equal(reportExitCode(r), EXIT_OK);
    assert.equal(r.gates[0]?.result.violationCount, 0);
    assert.deepEqual(r.gates[0]?.shown, []);
  });

  it("are printed under a passing gate, labelled as advice", () => {
    // THE REGRESSION. These used to ride in `GateResult.output`, which the
    // report surfaces only for a gate that FAILED with nothing structured —
    // so a green `typing-strictness` said nothing about a real, deliberate
    // escape hatch in the project's config.
    const text = renderText(
      reportOf(gateResult({ name: "typing-strictness", passed: true, advisories: [hatch(3)] })),
    );
    assert.match(text, /\[PASS] typing-strictness/);
    assert.match(text, /\[advisory] tsconfig\.json:3 tsconfig-advisory-flag skipLibCheck/);
    assert.match(text, /0 failed, 0 skipped, 1 advisories$/m);
  });

  it("reach the JSON as their own list, leaving `violations` alone", () => {
    // The wire decision: a NEW key, never a `severity` field on a violation.
    // Every consumer today filters on `violations`, and an advisory landing
    // in that list would read as a finding to fix in both siblings.
    const gate = toPayload(
      reportOf(gateResult({ name: "typing-strictness", passed: true, advisories: [hatch(3)] })),
    ).gates[0];
    assert.deepEqual(gate?.violations, []);
    assert.equal(gate?.violation_count, 0);
    assert.equal(gate?.advisory_count, 1);
    assert.equal(gate?.advisories[0]?.code, "tsconfig-advisory-flag");
    assert.equal(gate?.advisories[0]?.fix_hint, null, "absent fields are explicit nulls");
    assert.equal(gate?.passed, true);
  });

  it("are deduped and capped, and say so rather than vanishing", () => {
    // TOR-1418: three lines are three advisories. Dedupe used to fold the
    // second and third into the first's prose, so an advisory list a machine
    // read structurally named one line out of three.
    const many = [hatch(1), hatch(2), hatch(3)];
    const spread = reportOf(gateResult({ name: "g", passed: true, advisories: many }));
    assert.equal(spread.gates[0]?.advisoryCount, 3);
    assert.deepEqual(
      spread.gates[0]?.advisories.map((a) => a.line),
      [1, 2, 3],
    );

    // Two reports of the identical finding AT THE SAME line still collapse:
    // there is no second location for a reader to go to.
    const twice = [hatch(1), hatch(1)];
    const deduped = reportOf(gateResult({ name: "g", passed: true, advisories: twice }));
    assert.equal(deduped.gates[0]?.advisoryCount, 1);
    assert.match(String(deduped.gates[0]?.advisories[0]?.message), /\(\+1 more\)$/);

    const distinct = [hatch(1), { ...hatch(2), message: "second" }];
    const capped = reportOf(gateResult({ name: "g", passed: true, advisories: distinct }), 1);
    assert.equal(capped.gates[0]?.advisoryCount, 2);
    assert.equal(capped.gates[0]?.advisories.length, 1);
    assert.match(renderText(capped), /\[advisory] \.\.\. 1 more not shown/);
  });

  it("are not printed for a skipped gate, which observed nothing", () => {
    const skipped = gateResult({
      name: "g",
      passed: false,
      skipped: true,
      skipReason: "x",
      advisories: [hatch(1)],
    });
    assert.doesNotMatch(renderText(reportOf(skipped)), /\[advisory]/);
  });

  it("leave a clean run's summary line untouched", () => {
    assert.match(renderText(reportOf(gateResult({ name: "g", passed: true }))), /0 skipped$/m);
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

/**
 * The run journal, read back from a real `.kragg/history.jsonl`.
 *
 * `commands.test.ts` covers what `runPipeline` WRITES. These cover the read
 * side, which has a different obligation: the file is append-only and a run
 * can be interrupted mid-line, so a half-written final entry must cost that
 * entry and nothing else. A reader that threw on it would take `kragg status`
 * down for the rest of the history too.
 */
describe("readRuns", () => {
  function journalRoot(lines: readonly string[]): string {
    const root = mkdtempSync(join(tmpdir(), "kragg-journal-"));
    journalRoots.push(root);
    mkdirSync(join(root, JOURNAL_DIR), { recursive: true });
    writeFileSync(journalPath(root), lines.map((line) => `${line}\n`).join(""), "utf8");
    return root;
  }

  it("returns an empty history rather than throwing when there is no file", () => {
    const root = mkdtempSync(join(tmpdir(), "kragg-journal-"));
    journalRoots.push(root);
    assert.deepEqual(readRuns(root, 10), []);
  });

  it("round-trips what appendRun wrote, oldest first", () => {
    const root = mkdtempSync(join(tmpdir(), "kragg-journal-"));
    journalRoots.push(root);
    appendRun(root, journalPayload("check", true, "a"));
    appendRun(root, journalPayload("security", false, "b"), { gitDirty: true });
    const runs = readRuns(root, 10);
    assert.equal(runs.length, 2);
    assert.equal(runs[0]?.command, "check");
    assert.equal(runs[0]?.passed, true);
    assert.equal(runs[0]?.git_dirty, false, "an omitted gitDirty records clean");
    assert.equal(runs[1]?.command, "security");
    assert.equal(runs[1]?.passed, false);
    assert.equal(runs[1]?.git_dirty, true);
    assert.equal(runs[1]?.gates[0]?.name, "b");
  });

  it("returns only the most recent runs, and all of them when `last` is larger", () => {
    const root = journalRoot([
      JSON.stringify({ command: "one" }),
      JSON.stringify({ command: "two" }),
      JSON.stringify({ command: "three" }),
    ]);
    assert.deepEqual(readRuns(root, 99).map((run) => run.command), ["one", "two", "three"]);
    assert.deepEqual(readRuns(root, 3).map((run) => run.command), ["two", "three"]);
    // KNOWN QUIRK, pinned rather than wished away: `last` bounds LINES, and an
    // append-only file always ends in a newline, so the empty final line spends
    // one of them. The window is therefore `last - 1` entries. It is a display
    // cap on `kragg status`, so being one short is harmless — but a reader of
    // this test should not be surprised by it.
    assert.deepEqual(readRuns(root, 2).map((run) => run.command), ["three"]);
  });

  it("skips a half-written line and keeps the history around it", () => {
    // The interrupted-run case. Losing the whole file to it would be worse
    // than losing the entry.
    const root = journalRoot([
      JSON.stringify({ command: "good" }),
      '{"command":"truncated"',
      "",
      JSON.stringify({ command: "later" }),
    ]);
    assert.deepEqual(readRuns(root, 10).map((run) => run.command), ["good", "later"]);
  });

  it("skips a well-formed line that is not an object", () => {
    // `JSON.parse` succeeds on all three; none of them is a run.
    const root = journalRoot(["[1,2]", '"a string"', "7", JSON.stringify({ command: "real" })]);
    assert.deepEqual(readRuns(root, 10).map((run) => run.command), ["real"]);
  });
});

describe("renderStatusLines", () => {
  function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
    return {
      schema_version: 1,
      ts: "2026-01-01T00:00:00+00:00",
      command: "check",
      mode: "full",
      git_sha: null,
      git_dirty: false,
      passed: true,
      exit_code: 0,
      duration_ms: 2500,
      gates: [],
      ...overrides,
    };
  }

  function gate(name: string, passed: boolean, durationMs: number, count = 0): JournalGate {
    return {
      name,
      passed,
      skipped: false,
      duration_ms: durationMs,
      violation_count: count,
    };
  }

  it("says so when nothing has been recorded, rather than rendering a pass", () => {
    // `runStatus` short-circuits this case itself, so nothing else reaches it:
    // an empty history has no evidence either way and must not read as green.
    assert.deepEqual(renderStatusLines([]), ["no runs recorded yet — run `kragg check`"]);
  });

  it("summarizes a passing run without inventing a failing-gates line", () => {
    const lines = renderStatusLines([entry({ gates: [gate("lint", true, 1200)] })]);
    assert.equal(lines[0], "last run: PASS (check, full mode, 2026-01-01T00:00:00+00:00, 2.5s)");
    assert.equal(lines.some((line) => line.startsWith("failing gates:")), false);
    assert.equal(lines.includes("pass streak: 1 of last 1 runs"), true);
    assert.equal(lines.at(-1), "slowest gate: lint (1.2s)");
  });

  it("names the failing gates with their counts, and skips the skipped ones", () => {
    const lines = renderStatusLines([
      entry({
        passed: false,
        exit_code: 1,
        gates: [
          gate("lint", false, 900, 3),
          { name: "secrets", passed: false, skipped: true, duration_ms: 0, violation_count: 0 },
          gate("tsc", false, 4000, 1),
        ],
      }),
    ]);
    assert.match(lines[0] ?? "", /^last run: FAIL \(check, full mode/);
    assert.equal(lines[1], "failing gates: lint (3 violations), tsc (1 violations)");
    assert.equal(lines.at(-1), "slowest gate: tsc (4.0s)");
  });

  it("counts the pass streak backwards from the last run only", () => {
    const runs = [
      entry({ passed: true }),
      entry({ passed: false }),
      entry({ passed: true }),
      entry({ passed: true }),
    ];
    assert.equal(
      renderStatusLines(runs).find((line) => line.startsWith("pass streak:")),
      "pass streak: 2 of last 4 runs",
    );
  });

  it("omits the slowest-gate line when no gate was timed", () => {
    // Every gate at 0ms means the durations were never recorded; naming one of
    // them "slowest" would be a claim the journal does not support.
    const lines = renderStatusLines([entry({ gates: [gate("a", true, 0), gate("b", true, 0)] })]);
    assert.equal(lines.some((line) => line.startsWith("slowest gate:")), false);
    assert.equal(lines.length, 2);
  });
});
