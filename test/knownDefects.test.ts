/**
 * Retained known-defect detection for the metric gates.
 *
 * ── WHAT THIS SUITE IS FOR, AND WHAT IT IS NOT FOR ─────────────────────────
 * The other metric suites pin FORMULAS. This one pins the only thing a
 * calibration exercise can quietly break: that the shipped thresholds still
 * catch a defect a reviewer would want caught. Each fixture in
 * `fixtures/knownDefects.ts` is one such defect, measured and dated, sitting
 * on the far side of exactly one gate's budget.
 *
 * A future change to `CC_MAX_GRADE`, `MI_MIN_GRADE`, `MAX_EFFORT`,
 * `MAX_DIFFICULTY`, `MAX_BUGS`, `type_max_nesting_depth`, `type_max_length` or
 * to the nullable-default rules may well be justified — `docs/calibration.md`
 * exists to make that argument possible. What it may not do is stop detecting
 * these, silently. If it does, this suite fails and the change has to say so
 * out loud.
 *
 * THE CONTROL IS HALF THE SUITE. Every gate is also asserted to report NOTHING
 * about `src/clean.ts`. Zero findings is not accuracy, and neither is a full
 * finding list: a gate that flagged everything would satisfy every positive
 * assertion here and fail every negative one.
 *
 * The budgets come from `loadPolicy` on a project with no `kragg.json`, so the
 * SHIPPED DEFAULTS are what is under test, not numbers this file chose.
 *
 * This suite imports `typescript` directly, which production gate code must
 * NOT do (see `resolveTypeScript`): here it is the compiler under test, passed
 * in explicitly so the shared handle cache stays clean.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import ts from "typescript";

import { analysisProgram } from "../src/analysis/program.ts";
import type { Violation } from "../src/engine/models.ts";
import { cyclomaticViolations, maintainabilityViolations } from "../src/gates/complexity.ts";
import { halsteadViolations } from "../src/gates/halstead.ts";
import { checkNullableDefaults } from "../src/gates/nullableDefault.ts";
import { checkTypeComplexity } from "../src/gates/typeComplexity.ts";
import { loadPolicy } from "../src/policy/policy.ts";
import {
  CLEAN_CONTROL_PATH,
  KNOWN_DEFECTS,
  KNOWN_DEFECT_PROJECT,
} from "./fixtures/knownDefects.ts";

const SOURCE_PATHS = ["src"];

let root = "";

/** Every gate's findings over the fixture project, keyed by gate name. */
let findings: Readonly<Record<string, readonly Violation[]>> = {};

before(() => {
  root = mkdtempSync(join(tmpdir(), "kragg-known-defects-"));
  for (const [path, source] of Object.entries(KNOWN_DEFECT_PROJECT)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${source}\n`, "utf8");
  }

  const policy = loadPolicy(root);
  const options = { api: ts };
  const outcome = checkNullableDefaults({
    program: analysisProgram({ root, api: ts }),
  });
  assert.equal(outcome.ok, true, "the fixture program must build");

  findings = {
    complexity: cyclomaticViolations(root, SOURCE_PATHS, options),
    maintainability: maintainabilityViolations(root, SOURCE_PATHS, options),
    halstead: halsteadViolations(root, SOURCE_PATHS, options),
    "type-complexity": checkTypeComplexity({
      root,
      sourcePaths: SOURCE_PATHS,
      maxDepth: policy.typeMaxNestingDepth,
      maxLength: policy.typeMaxLength,
      api: ts,
    }),
    "nullable-default": outcome.ok ? outcome.violations : [],
  };
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function forFile(gate: string, path: string): readonly Violation[] {
  return (findings[gate] ?? []).filter((violation) => violation.file === path);
}

describe("known defects stay detected at the shipped thresholds", () => {
  for (const defect of KNOWN_DEFECTS) {
    it(`${defect.gate} flags ${defect.path} — ${defect.measured}`, () => {
      const reported = forFile(defect.gate, defect.path);
      assert.ok(
        reported.length > 0,
        `${defect.gate} no longer flags ${defect.path} (${defect.measured}). ` +
          "If a threshold moved deliberately, update docs/calibration.md and " +
          "this fixture together — do not delete the assertion.",
      );
      if (defect.symbol !== "") {
        assert.ok(
          reported.some((violation) => violation.message.includes(defect.symbol)),
          `${defect.gate} flagged ${defect.path} but never named ${defect.symbol}`,
        );
      }
    });
  }

  it("complexity reports the C grade, not merely some grade", () => {
    const [violation] = forFile("complexity", "src/complexFunction.ts");
    assert.equal(violation?.code, "CC-C");
  });

  it("maintainability drops the bulk module out of grade A", () => {
    const [violation] = forFile("maintainability", "src/lowMaintainability.ts");
    assert.match(violation?.code ?? "", /^MI-[BC]$/u);
  });

  it("halstead breaches all three ceilings on one function", () => {
    const metrics = forFile("halstead", "src/highEffort.ts").map((violation) =>
      violation.message.replace(/^mixColor: /u, "").split(" ")[0],
    );
    assert.deepEqual(new Set(metrics), new Set(["effort", "difficulty", "estimated"]));
  });

  it("type-complexity catches the depth failure and the length failure", () => {
    const messages = forFile("type-complexity", "src/complexTypes.ts").map(
      (violation) => violation.message,
    );
    assert.equal(messages.length, 2);
    assert.ok(
      messages.some((message) => /depth=3/u.test(message)),
      "the depth-only annotation is no longer reported",
    );
    assert.ok(
      messages.some((message) => /depth=1, length=4[0-9]/u.test(message)),
      "the length-only annotation is no longer reported",
    );
  });

  it("nullable-default still fires on both of its rules", () => {
    const messages = forFile("nullable-default", "src/nullableDefaults.ts").map(
      (violation) => violation.message,
    );
    assert.equal(messages.length, 2);
    assert.ok(messages.some((message) => message.startsWith("`||`")));
    assert.ok(messages.some((message) => message.startsWith("arithmetic")));
  });
});

describe("the clean control stays clean", () => {
  for (const gate of ["complexity", "maintainability", "halstead", "type-complexity", "nullable-default"]) {
    it(`${gate} reports nothing about ${CLEAN_CONTROL_PATH}`, () => {
      assert.deepEqual(forFile(gate, CLEAN_CONTROL_PATH), []);
    });
  }

  it("each fixture trips exactly the gate it was built for", () => {
    for (const defect of KNOWN_DEFECTS) {
      const others = Object.keys(findings).filter(
        (gate) =>
          gate !== defect.gate &&
          // The Halstead fixture is straight-line arithmetic and the complexity
          // fixture is all branches, so those two never collide. Maintainability
          // is the exception that has to be allowed: it is a FILE metric, and a
          // file holding a defect is a slightly worse file. It is asserted not
          // to fire on the control instead.
          gate !== "maintainability",
      );
      for (const gate of others) {
        assert.deepEqual(
          forFile(gate, defect.path),
          [],
          `${gate} also fires on ${defect.path}, so that fixture no longer isolates ${defect.gate}`,
        );
      }
    }
  });
});
