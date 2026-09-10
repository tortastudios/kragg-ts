/**
 * What "kragg passed its own gates" is allowed to mean — and what it is not.
 *
 * ── THE PROBLEM THIS SOLVES ────────────────────────────────────────────────
 * `kragg check --all` on this repository ends in a summary line, and a summary
 * line is the one thing a release must not be gated on. `17 passed, 0 failed,
 * 1 skipped` and `12 passed, 0 failed, 6 skipped` both read as green, and the
 * difference between them is six checks that did not happen. Worse, a skip is
 * a moving target: a gate can start skipping because a tool vanished from the
 * runner, because a policy key was edited, or because a refactor made it step
 * aside — and none of those changes the summary's shape.
 *
 * So the gate is not the summary. It is this:
 *
 *   EVERY CHECK THAT DID NOT RUN IS ENUMERATED, WITH ITS REASON, AND EVERY ONE
 *   OF THEM MUST MATCH A REVIEWED ENTRY BELOW. Anything else fails the build.
 *
 * ── WHY THE REASON IS PART OF THE ENTRY ────────────────────────────────────
 * An allowlist keyed on the gate NAME alone would accept `detect-secrets`
 * skipping for any reason at all — including `disabled by policy
 * (secret_scanner = "off")`, which is someone switching the gate off in
 * `kragg.json` and CI agreeing that this was always fine. Each entry therefore
 * pins the SUBSTRING of the skip reason that identifies the specific
 * circumstance a reviewer accepted. The same gate skipping for a different
 * reason is an unexpected skip and fails.
 *
 * ── AN ENTRY THAT STOPS MATCHING ───────────────────────────────────────────
 * ...is reported as a notice, not a failure: it means MORE ran than the
 * allowlist expected, which is the safe direction, and the honest response is
 * to delete the entry rather than to block the pull request that improved
 * things. Nothing else here errs towards the permissive side.
 */

/** One skip a reviewer looked at and accepted, and the reason they accepted. */
export interface ExpectedSkip {
  /** The gate name, exactly as the report spells it. */
  readonly gate: string;
  /** A substring the gate's `skip_reason` must contain for this entry to apply. */
  readonly reasonIncludes: string;
  /** Why this skip is acceptable. Printed in the job log, every run. */
  readonly why: string;
}

/**
 * THE REVIEWED ALLOWLIST. One entry. Adding a second is a decision, not a fix.
 *
 * `detect-secrets` with `secret_scanner: "auto"` (this repo's setting, by
 * omission) looks for gitleaks on `PATH` and secretlint in the project's
 * `node_modules`. A stock GitHub-hosted runner has neither, and kragg
 * deliberately bundles no scanner: a scanner that reported "clean" without
 * checking would be worse than none.
 *
 * INSTALLING GITLEAKS IN CI WAS CONSIDERED AND NOT DONE. It would close this
 * skip, and it would also mean every future CI run depends on a third-party
 * binary fetched at job time — a supply-chain surface this repository spends
 * `minimumReleaseAge`, `ignoreScripts` and SHA-pinned actions keeping small.
 * The skip is visible, enumerated on every run, and pinned to its exact
 * reason, which is the property that actually matters: a NEW skip cannot hide
 * behind it. If the scanner is ever added, delete this entry — the notice the
 * evaluator prints will say so.
 */
export const EXPECTED_SKIPS: readonly ExpectedSkip[] = [
  {
    gate: "detect-secrets",
    reasonIncludes: "no secret scanner available",
    why:
      "a stock CI runner has no gitleaks on PATH and this repository installs no " +
      "secretlint; kragg bundles no scanner, and `secret_scanner: \"auto\"` skips " +
      "visibly rather than reporting an unscanned tree as clean",
  },
];

/** The subset of a gate's payload this evaluation reads. */
export interface GateState {
  readonly name: string;
  readonly passed: boolean;
  readonly skipped: boolean;
  readonly skipReason: string | null;
  readonly error: boolean;
}

/** Everything the evaluation is a function of. */
export interface SelfCheckInput {
  readonly exitCode: number;
  readonly gates: readonly GateState[];
}

/** The verdict: what to print, and whether the build may go on. */
export interface SelfCheckVerdict {
  /** Lines to print, in order. Always includes the full enumeration. */
  readonly report: readonly string[];
  /** Every reason this run is not acceptable. Empty means it is. */
  readonly problems: readonly string[];
  readonly ok: boolean;
}

/**
 * Judge one `check --all` payload.
 *
 * Pure, so it is unit-tested rather than only exercised by the CI job it
 * powers: the case that matters — a NEW skip appearing beside the expected one
 * — must not be discoverable only by breaking CI.
 */
export function evaluateSelfCheck(
  input: SelfCheckInput,
  allowed: readonly ExpectedSkip[] = EXPECTED_SKIPS,
): SelfCheckVerdict {
  const report: string[] = [];
  const problems: string[] = [];
  const matched = new Set<ExpectedSkip>();

  const absent = input.gates.filter((gate) => gate.skipped || gate.error);
  report.push(`gates reported: ${input.gates.length}`);
  report.push(`checks that did not run: ${absent.length}`);
  for (const gate of absent) {
    if (gate.error) {
      report.push(`  [ERROR]      ${gate.name} — could not run; kragg reports this as exit 3`);
      problems.push(`${gate.name} could not run (error: true); a required check did not happen`);
      continue;
    }
    const reason = gate.skipReason ?? "";
    const entry = allowed.find(
      (candidate) => candidate.gate === gate.name && reason.includes(candidate.reasonIncludes),
    );
    if (entry === undefined) {
      report.push(`  [UNEXPECTED] ${gate.name} — skipped: ${oneLine(reason)}`);
      problems.push(
        `${gate.name} was skipped and no reviewed entry covers it: ${oneLine(reason)}`,
      );
      continue;
    }
    matched.add(entry);
    report.push(`  [EXPECTED]   ${gate.name} — skipped: ${oneLine(reason)}`);
    report.push(`               reviewed: ${entry.why}`);
  }

  for (const gate of input.gates) {
    if (!gate.passed && !gate.skipped && !gate.error) {
      problems.push(`${gate.name} failed`);
    }
  }
  if (input.exitCode !== 0) {
    problems.push(`kragg check --all exited ${input.exitCode}, not 0`);
  }
  for (const entry of allowed) {
    if (!matched.has(entry)) {
      report.push(
        `  [NOTICE]     ${entry.gate} is no longer skipped for "${entry.reasonIncludes}" — ` +
          "delete its entry from EXPECTED_SKIPS",
      );
    }
  }
  return { report, problems, ok: problems.length === 0 };
}

/** Collapse a multi-line skip reason so the enumeration stays one row per gate. */
function oneLine(reason: string): string {
  const collapsed = reason.replace(/\s+/gu, " ").trim();
  return collapsed.length <= 200 ? collapsed : `${collapsed.slice(0, 197)}...`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrow a parsed report payload into {@link SelfCheckInput}.
 *
 * Every field is required by name. A payload missing one is a wire-format
 * break and is thrown on rather than defaulted — defaulting `skipped` to
 * `false` here would turn "the schema moved" into "everything ran".
 */
export function readSelfCheckInput(payload: unknown): SelfCheckInput {
  if (!isRecord(payload)) {
    throw new Error("the report payload is not a JSON object");
  }
  const exitCode = payload["exit_code"];
  const gates = payload["gates"];
  if (typeof exitCode !== "number") {
    throw new Error("report.exit_code is missing or not a number");
  }
  if (!Array.isArray(gates)) {
    throw new Error("report.gates is missing or not a list");
  }
  return { exitCode, gates: gates.map((gate, index) => readGate(gate, index)) };
}

function readGate(value: unknown, index: number): GateState {
  if (!isRecord(value)) {
    throw new Error(`report.gates[${index}] is not an object`);
  }
  const name = value["name"];
  const passed = value["passed"];
  const skipped = value["skipped"];
  const error = value["error"];
  const skipReason = value["skip_reason"];
  if (typeof name !== "string") {
    throw new Error(`report.gates[${index}].name is missing or not a string`);
  }
  if (typeof passed !== "boolean" || typeof skipped !== "boolean" || typeof error !== "boolean") {
    throw new Error(`report.gates[${index}] (${name}) is missing one of passed/skipped/error`);
  }
  if (skipReason !== null && typeof skipReason !== "string") {
    throw new Error(`report.gates[${index}] (${name}).skip_reason is neither a string nor null`);
  }
  return { name, passed, skipped, error, skipReason };
}
