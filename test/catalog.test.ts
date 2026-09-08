/**
 * Tests for the gate catalog.
 *
 * Three things are worth pinning down here, and none of them is "does a gate
 * find the right violations" — every gate has its own suite for that.
 *
 *  1. COMPOSITION. The gate list, its order and its tiers are a contract with
 *     `catalog.py`, and a silently dropped gate is a check that stops running
 *     while the report still says "18 gates".
 *  2. SKIP SEMANTICS. An unconfigured gate must SKIP VISIBLY. The failure this
 *     prevents is a green `[PASS]` for a check that never happened. Criticality
 *     data is the one case that is NOT a skip any more — the pipeline derives
 *     what it does not have, and only the message for data it cannot derive is
 *     pinned here.
 *  3. THE OUTCOME MAPPING. Every gate reports in its own shape, and the three
 *     destinations — fail, error, skip — drive three different exit codes. A
 *     mapper that collapses error into fail turns "your compiler is missing"
 *     into "you have type errors".
 *
 * Plus the performance invariant: assembling a pipeline must not build a
 * `ts.Program`. That one is a test because it is invisible until it is slow.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { buildCheckGates, buildSecurityGates } from "../src/catalog.ts";
import {
  catalogContext,
  noCriticalityReason,
  unconfigured,
} from "../src/catalog/context.ts";
import {
  errorGate,
  fromReport,
  fromSecrets,
  fromSimple,
  fromTestDepth,
  fromTypingStrictness,
  fromUnavailable,
  nativeGate,
  skipGate,
  type RanReport,
} from "../src/catalog/results.ts";
import { FAST, runGates, SLOW, type GateSpec } from "../src/engine/gate.ts";
import type { GateResult } from "../src/engine/models.ts";
import { EXIT_ENVIRONMENT, EXIT_GATE_FAILURES, EXIT_OK } from "../src/engine/report.ts";
import { buildReport, reportExitCode } from "../src/engine/report.ts";
import { resolveProjectEnvironment } from "../src/environment/project.ts";
import { writeStamp } from "../src/gates/criticality.ts";
import { DEFAULT_POLICY, type KraggPolicy } from "../src/policy/policy.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-catalog-"));
  roots.push(root);
  return root;
}

/** A pipeline built over a throwaway root, with an optional policy override. */
function gates(
  build: typeof buildCheckGates,
  overrides: Partial<KraggPolicy> = {},
  root = project(),
): GateSpec[] {
  return build({
    root,
    policy: { ...DEFAULT_POLICY, ...overrides },
    env: resolveProjectEnvironment(root),
    targets: ["src"],
  });
}

function names(specs: readonly GateSpec[]): string[] {
  return specs.map((spec) => spec.name);
}

function find(specs: readonly GateSpec[], name: string): GateSpec {
  const spec = specs.find((candidate) => candidate.name === name);
  assert.ok(spec !== undefined, `no gate named ${name}`);
  return spec;
}

/** The `GateResult` a pipeline produced for one gate. */
function findResult(results: readonly GateResult[], name: string): GateResult {
  const result = results.find((candidate) => candidate.name === name);
  assert.ok(result !== undefined, `no result named ${name}`);
  return result;
}

function exitCodeFor(results: readonly GateResult[]): number {
  return reportExitCode(
    buildReport({
      command: "check",
      mode: "full",
      targets: [],
      results,
      maxViolations: 10,
      startedAt: "now",
      gitSha: null,
    }),
  );
}

describe("buildCheckGates: composition", () => {
  it("assembles every gate, in the order catalog.py defines", () => {
    assert.deepEqual(names(gates(buildCheckGates)), [
      "lint",
      "tsc",
      "typing-strictness",
      "complexity",
      "maintainability",
      "halstead",
      "type-complexity",
      "boundaries",
      "structure",
      "forbidden-calls",
      "nullable-default",
      "critical-tests",
      "test-quality",
      "secret-default",
      "detect-secrets",
      "test-coverage",
      "critical-coverage",
      "audit",
    ]);
  });

  it("puts exactly the three expensive gates in the SLOW tier", () => {
    const specs = gates(buildCheckGates);
    const slow = specs.filter((spec) => spec.tier === SLOW);
    assert.deepEqual(names(slow), ["test-coverage", "critical-coverage", "audit"]);
    assert.equal(specs.filter((spec) => spec.tier === FAST).length, 15);
  });

  it("skips every slow gate in incremental mode, and no fast one", () => {
    const root = project();
    const specs = buildCheckGates({
      root,
      policy: DEFAULT_POLICY,
      env: resolveProjectEnvironment(root),
      targets: ["src/a.ts"],
      paths: ["src/a.ts"],
      incremental: true,
    });
    for (const spec of specs.filter((candidate) => candidate.tier === SLOW)) {
      assert.equal(spec.skipReason, "incremental mode", spec.name);
    }
    assert.equal(find(specs, "tsc").skipReason, undefined);
  });
});

describe("a gate that skips itself does not cost the slow tier its run", () => {
  it("still runs test-coverage, critical-coverage and audit with no secret scanner", async () => {
    // THE FALSE GREEN THIS CLOSES, on the real pipeline's names and tiers.
    // Whether a scanner is installed is not knowable while the pipeline is
    // being assembled, so `detect-secrets` decides at RUN time and returns
    // `passed: false, skipped: true`. `runGates` read that as a failure and
    // skipped every SLOW gate with "static gates failed" — on this repo, 14
    // green gates, exit 0, and the test suite never run. The runs are faked
    // so no gate here needs a tool installed to prove the wiring.
    const ran: string[] = [];
    const results = await runGates(
      gates(buildCheckGates).map((spec) => ({
        ...spec,
        run: () => {
          ran.push(spec.name);
          return spec.name === "detect-secrets"
            ? fromSecrets(spec.name, {
                ok: false,
                skipped: true,
                reason: "no secret scanner available",
              })
            : nativeGate(spec.name, []);
        },
      })),
    );

    assert.ok(ran.includes("detect-secrets"), "the scanner gate must have been reached");
    for (const name of ["test-coverage", "critical-coverage", "audit"]) {
      assert.ok(ran.includes(name), `${name} must run when a fast gate only skipped`);
      assert.equal(findResult(results, name).skipReason, null, name);
    }
    assert.equal(findResult(results, "detect-secrets").skipped, true);
    // And the run is still green, with the skip printed rather than promoted.
    assert.equal(exitCodeFor(results), EXIT_OK);
  });
});

describe("buildSecurityGates", () => {
  it("is a strict subset of the check pipeline", () => {
    const security = names(gates(buildSecurityGates));
    assert.deepEqual(security, [
      "forbidden-calls",
      "secret-default",
      "detect-secrets",
      "audit",
    ]);
    const check = new Set(names(gates(buildCheckGates)));
    for (const name of security) {
      assert.ok(check.has(name), `${name} is in security but not in check`);
    }
  });
});

describe("unconfigured gates skip visibly", () => {
  it("skips boundaries until at least two layers are declared", () => {
    assert.equal(
      find(gates(buildCheckGates), "boundaries").skipReason,
      "no layers configured",
    );
    // One layer cannot express a direction, so it is still nothing to enforce.
    assert.equal(
      find(gates(buildCheckGates, { layers: ["cli"] }), "boundaries").skipReason,
      "no layers configured",
    );
    assert.equal(
      find(gates(buildCheckGates, { layers: ["cli", "core"] }), "boundaries").skipReason,
      undefined,
    );
  });

  it("skips forbidden-calls with an empty ban list", () => {
    assert.equal(
      find(gates(buildCheckGates), "forbidden-calls").skipReason,
      "no forbidden calls configured",
    );
    assert.equal(
      find(gates(buildCheckGates, { forbiddenCalls: [["a.b", "no"]] }), "forbidden-calls")
        .skipReason,
      undefined,
    );
  });

  it("skips secret-default with no suffixes rather than passing", () => {
    assert.equal(
      find(gates(buildCheckGates, { secretNameSuffixes: [] }), "secret-default").skipReason,
      "no secret name suffixes configured",
    );
    assert.equal(
      find(gates(buildCheckGates), "secret-default").skipReason,
      undefined,
    );
  });

  it("returns undefined when configured, so the gate runs", () => {
    assert.equal(unconfigured("nope", true), undefined);
    assert.equal(unconfigured("nope", false), "nope");
  });
});

describe("criticality-dependent gates", () => {
  it("carries no spec-level criticality skip: the pipeline DERIVES the data", () => {
    // Python skips these when `.kragg/criticality.json` is absent. We can do
    // better than not paying for them: the pipeline has already built the
    // program the call graph needs, so it computes the data rather than
    // stepping aside, and a repo that has never run `kragg criticality
    // --write` still gets the gate. A gate that never runs enforces nothing.
    const specs = gates(buildCheckGates);
    assert.equal(find(specs, "critical-tests").skipReason, undefined);
    assert.equal(find(specs, "critical-coverage").skipReason, undefined);
  });

  it("names an absent file and an outrun one differently", () => {
    // Same remedy, different situations — and a skip that says "no criticality
    // data" about a file sitting right there sends a user looking for it.
    const root = project();
    assert.equal(
      noCriticalityReason(root),
      "no criticality data (run `kragg criticality --write`)",
    );

    mkdirSync(join(root, ".kragg"), { recursive: true });
    writeFileSync(join(root, ".kragg", "criticality.json"), "[]");
    const scanned = [...DEFAULT_POLICY.sourcePaths, ...DEFAULT_POLICY.testPaths];
    writeStamp(root, scanned);
    assert.equal(noCriticalityReason(root), undefined);

    // A module appears after the fact, so every name the file records may have
    // moved — the shape the 35-findings bug arrived in.
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    assert.match(String(noCriticalityReason(root)), /^stale criticality data/u);
  });

  it("still skips critical-coverage wholesale in incremental mode", () => {
    // The run-wide reason survived the move to derive-with-cache: an
    // incremental run must not pay for a call graph it will not consult.
    const root = project();
    const specs = buildCheckGates({
      root,
      policy: DEFAULT_POLICY,
      env: resolveProjectEnvironment(root),
      targets: [],
      incremental: true,
    });
    assert.equal(find(specs, "critical-coverage").skipReason, "incremental mode");
  });
});

describe("the program is shared and lazy", () => {
  it("does not build a ts.Program just to assemble a pipeline", () => {
    // The whole performance contract: a run where no type-aware gate fires
    // must not pay for `ts.createProgram`, which reads the entire file graph.
    const root = project();
    const ctx = catalogContext({
      root,
      policy: DEFAULT_POLICY,
      env: resolveProjectEnvironment(root),
      targets: ["src"],
    });
    assert.equal(ctx.program.loaded(), false);
    buildCheckGates({
      root,
      policy: DEFAULT_POLICY,
      env: resolveProjectEnvironment(root),
      targets: ["src"],
    });
    assert.equal(ctx.program.loaded(), false);
  });

  it("hands every type-aware gate the same handle and compiler", () => {
    const root = project();
    const options = {
      root,
      policy: DEFAULT_POLICY,
      env: resolveProjectEnvironment(root),
      targets: ["src"],
    };
    const first = catalogContext(options);
    const second = catalogContext(options);
    assert.equal(first.program, second.program);
    assert.equal(first.api, second.api);
  });
});

describe("outcome mapping: fail vs error vs skip", () => {
  it("maps a two-state failure to ERROR, not to a failed gate", () => {
    const result = fromSimple("x", { ok: false, message: "no tsconfig" });
    assert.equal(result.error, true);
    assert.equal(result.passed, false);
    assert.equal(result.skipped, false);
    assert.equal(result.output, "no tsconfig");
  });

  it("maps findings to a plain failure, with error left false", () => {
    const result = fromSimple("x", { ok: true, violations: [{ message: "bad" }] });
    assert.equal(result.error, false);
    assert.equal(result.passed, false);
    assert.equal(result.violationCount, 1);
  });

  it("maps an empty finding list to a pass", () => {
    assert.equal(fromSimple("x", { ok: true, violations: [] }).passed, true);
  });

  it("maps the test-depth middle arm to a visible skip", () => {
    const result = fromTestDepth("x", { ok: true, skipped: true, reason: "no data" });
    assert.equal(result.skipped, true);
    assert.equal(result.skipReason, "no data");
    assert.equal(result.error, false);
  });

  it("maps a missing secret scanner to a skip and a broken one to an error", () => {
    const absent = fromSecrets("s", { ok: false, skipped: true, reason: "none installed" });
    assert.equal(absent.skipped, true);
    assert.equal(absent.error, false);

    const broken = fromSecrets("s", {
      ok: false,
      skipped: false,
      command: ["gitleaks"],
      message: "crashed",
    });
    assert.equal(broken.error, true);
    assert.equal(broken.skipped, false);
  });

  it("treats only not-configured as a skip; every other kind is an error", () => {
    assert.equal(fromUnavailable("a", { ok: false, kind: "not-configured", message: "m" }).skipped, true);
    for (const kind of ["missing-tool", "crashed", "offline"] as const) {
      const result = fromUnavailable("a", { ok: false, kind, message: "m" });
      assert.equal(result.error, true, kind);
      assert.equal(result.skipped, false, kind);
    }
  });

  it("suppresses raw output when a report already parsed violations", () => {
    const withFindings = fromReport("t", {
      ok: true,
      command: ["x"],
      violations: [{ message: "boom" }],
      violationCount: 1,
      passed: false,
      output: "1000 lines of chatter",
    });
    assert.equal(withFindings.output, "");
    const unparsed = fromReport("t", {
      ok: true,
      command: ["x"],
      violations: [],
      violationCount: 0,
      passed: false,
      output: "segfault",
    });
    assert.equal(unparsed.output, "segfault");
  });

  it("routes typing-strictness advisories to the advisory channel, not to output", () => {
    // THE REGRESSION THIS CLOSES. They used to be joined into `output`, which
    // the report shows only for a FAILING gate with nothing structured — so on
    // a green gate a deliberate escape hatch in the config was recorded and
    // never printed. They must also not touch the verdict.
    const result = fromTypingStrictness("typing-strictness", {
      ok: true,
      violations: [],
      advisories: [{ message: "skipLibCheck is enabled", code: "tsconfig-advisory-flag" }],
    });
    assert.equal(result.passed, true);
    assert.equal(result.violationCount, 0);
    assert.equal(result.output, "");
    assert.deepEqual(
      result.advisories.map((advisory) => advisory.code),
      ["tsconfig-advisory-flag"],
    );
  });

  it("carries an adapter's advisories through, defaulting to none", () => {
    // `audit` uses this to report what its severity floor filtered out —
    // otherwise a clean run is indistinguishable from a run where the floor
    // hid three findings, and nobody can judge whether the floor is set right.
    const base: RanReport = {
      ok: true,
      command: ["x"],
      violations: [],
      violationCount: 0,
      passed: true,
      output: "",
    };
    const floored = fromReport("audit", {
      ...base,
      output: "audit: no advisories at or above `high` (3 below the `high` floor)",
      advisories: [{ message: "3 advisories below the `high` severity floor, not reported" }],
    });
    assert.equal(floored.passed, true, "an advisory must never fail the gate");
    assert.equal(floored.output, "", "a passing gate's raw output is still suppressed");
    assert.equal(floored.advisories.length, 1);
    assert.deepEqual(fromReport("t", base).advisories, []);
  });
});

describe("the exit-code contract these mappings feed", () => {
  const report = (results: Parameters<typeof buildReport>[0]["results"]): number =>
    reportExitCode(
      buildReport({
        command: "check",
        mode: "full",
        targets: [],
        results,
        maxViolations: 10,
        startedAt: "now",
        gitSha: null,
      }),
    );

  it("ranks a broken environment above gate failures", () => {
    assert.equal(
      report([nativeGate("a", [{ message: "bad" }]), errorGate("b", "missing tool")]),
      EXIT_ENVIRONMENT,
    );
  });

  it("reports plain findings as exit 1", () => {
    assert.equal(report([nativeGate("a", [{ message: "bad" }])]), EXIT_GATE_FAILURES);
  });

  it("treats a skip as a pass for the exit code, but still prints it", () => {
    assert.equal(report([nativeGate("a", []), skipGate("b", "nothing configured")]), EXIT_OK);
    assert.equal(skipGate("b", "why").skipReason, "why");
  });
});
