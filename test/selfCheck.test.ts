/**
 * The self-check evidence rules, tested where they can be tested.
 *
 * `scripts/selfcheck.ts` is the release gate that refuses to accept `kragg
 * check --all`'s summary line as evidence. The half that decides — which
 * checks did not run, and whether a reviewer signed off on each one — is a
 * pure function, and it is tested here rather than only by breaking CI: the
 * case that matters is a NEW skip appearing beside the expected one, and
 * "discover it when a release fails" is not a test strategy.
 *
 * The rules asserted below are the ones that would be quietly weakened first:
 * a skip with the wrong reason must not inherit an allowlist entry, and an
 * errored gate must never be tolerated at all.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EXPECTED_SKIPS,
  evaluateSelfCheck,
  readSelfCheckInput,
  type GateState,
} from "../scripts/selfcheck/expectations.ts";

function passing(name: string): GateState {
  return { name, passed: true, skipped: false, skipReason: null, error: false };
}

function skipping(name: string, reason: string): GateState {
  return { name, passed: false, skipped: true, skipReason: reason, error: false };
}

/** The one skip this repository's own `check --all` is expected to report. */
const EXPECTED_SECRETS_SKIP = skipping(
  "detect-secrets",
  "no secret scanner available; kragg does not bundle one (a scanner that reports " +
    '"clean" without checking is worse than none)',
);

describe("self-check evidence", () => {
  it("accepts a run whose only absent check is the reviewed one", () => {
    const verdict = evaluateSelfCheck({
      exitCode: 0,
      gates: [passing("tsc"), passing("test-coverage"), EXPECTED_SECRETS_SKIP],
    });
    assert.deepEqual([...verdict.problems], []);
    assert.equal(verdict.ok, true);
  });

  it("enumerates every check that did not run, on a passing run too", () => {
    const verdict = evaluateSelfCheck({
      exitCode: 0,
      gates: [passing("tsc"), EXPECTED_SECRETS_SKIP],
    });
    const text = verdict.report.join("\n");
    assert.match(text, /checks that did not run: 1/u);
    assert.match(text, /\[EXPECTED\] {3}detect-secrets/u);
    assert.match(text, /reviewed: a stock CI runner has no gitleaks/u);
  });

  it("fails on a NEW skip that appears beside the expected one", () => {
    const verdict = evaluateSelfCheck({
      exitCode: 0,
      gates: [
        passing("tsc"),
        EXPECTED_SECRETS_SKIP,
        skipping("audit", "no package manager detected"),
      ],
    });
    assert.equal(verdict.ok, false);
    assert.deepEqual(
      [...verdict.problems],
      ["audit was skipped and no reviewed entry covers it: no package manager detected"],
    );
    assert.match(verdict.report.join("\n"), /\[UNEXPECTED\] audit/u);
  });

  it("refuses to let an allowlisted gate inherit the entry for a different reason", () => {
    // Switching the scanner off in `kragg.json` produces a different reason on
    // the SAME gate. That is a policy change, not the reviewed circumstance.
    const verdict = evaluateSelfCheck({
      exitCode: 0,
      gates: [passing("tsc"), skipping("detect-secrets", 'disabled by policy (secret_scanner = "off")')],
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.problems.join("\n"), /detect-secrets was skipped and no reviewed entry/u);
  });

  it("never tolerates a gate that could not run", () => {
    const verdict = evaluateSelfCheck({
      exitCode: 3,
      gates: [
        { name: "tsc", passed: false, skipped: false, skipReason: null, error: true },
        EXPECTED_SECRETS_SKIP,
      ],
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.problems.join("\n"), /tsc could not run \(error: true\)/u);
    assert.match(verdict.problems.join("\n"), /exited 3, not 0/u);
    assert.match(verdict.report.join("\n"), /\[ERROR\] {6}tsc/u);
  });

  it("fails a run that exited 0 with a failing gate, which cannot happen and must still be caught", () => {
    const failing: GateState = {
      name: "structure",
      passed: false,
      skipped: false,
      skipReason: null,
      error: false,
    };
    const verdict = evaluateSelfCheck({ exitCode: 0, gates: [failing] });
    assert.equal(verdict.ok, false);
    assert.deepEqual([...verdict.problems], ["structure failed"]);
  });

  it("notices an allowlist entry that no longer applies, without blocking on it", () => {
    const verdict = evaluateSelfCheck({ exitCode: 0, gates: [passing("detect-secrets")] });
    assert.equal(verdict.ok, true);
    assert.match(verdict.report.join("\n"), /no longer skipped .* delete its entry/u);
  });

  it("keeps the allowlist to the one entry a reviewer signed off on", () => {
    assert.equal(EXPECTED_SKIPS.length, 1);
    assert.equal(EXPECTED_SKIPS[0]?.gate, "detect-secrets");
  });
});

describe("self-check payload reading", () => {
  it("reads the snake_case wire fields", () => {
    const input = readSelfCheckInput({
      exit_code: 0,
      gates: [
        { name: "tsc", passed: true, skipped: false, skip_reason: null, error: false },
      ],
    });
    assert.equal(input.exitCode, 0);
    assert.deepEqual([...input.gates], [passing("tsc")]);
  });

  it("throws rather than defaulting when a field the verdict depends on is gone", () => {
    assert.throws(
      () => readSelfCheckInput({ exit_code: 0, gates: [{ name: "tsc", passed: true }] }),
      /missing one of passed\/skipped\/error/u,
    );
    assert.throws(() => readSelfCheckInput({ gates: [] }), /exit_code is missing/u);
    assert.throws(() => readSelfCheckInput({ exit_code: 0 }), /gates is missing/u);
  });
});
