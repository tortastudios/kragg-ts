#!/usr/bin/env node
/**
 * `scripts/selfcheck.ts` — kragg checks itself, and the evidence is truthful.
 *
 * ── WHAT IT RUNS ───────────────────────────────────────────────────────────
 *
 *     node dist/cli.js check --all --no-journal --format json
 *
 * `dist/cli.js`, deliberately: the BUILT artifact, the one `bin` points at and
 * the one a consumer installs. Running `src/cli.ts` here would gate the
 * release on a program that is never shipped.
 *
 * `--all` because the whole point is the slow tier — the tests, the coverage,
 * the audit — and `--no-journal` because a CI run has nothing to journal to.
 *
 * ── WHAT IT ASSERTS ────────────────────────────────────────────────────────
 * Not the summary line. `17 passed, 0 failed, 1 skipped` is what a green run
 * looks like, and so is `12 passed, 0 failed, 6 skipped`; the difference is
 * five checks that stopped happening, and no summary makes that visible. So
 * this prints EVERY check that did not run, with its reason, on every run —
 * pass or fail — and fails the build unless each one matches a reviewed entry
 * in `scripts/selfcheck/expectations.ts`, reason included. A gate that could
 * not run (`error: true`) always fails the build: an unavailable required
 * check blocks, it does not pass.
 *
 * Run it by hand exactly as CI does:
 *
 *     pnpm run build && pnpm run selfcheck
 *
 * ── RULES IT KEEPS ─────────────────────────────────────────────────────────
 * No new dependencies; the one subprocess goes through `src/engine/runner.ts`
 * with an argv array and `shell: false`, as `scripts/calibrate.ts` and
 * `scripts/compat.ts` do. It writes nothing.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCommand } from "../src/engine/runner.ts";
import { evaluateSelfCheck, readSelfCheckInput } from "./selfcheck/expectations.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[/\\]$/u, "");
const CLI = join(REPO_ROOT, "dist", "cli.js");
const ARGV: readonly string[] = ["check", "--all", "--no-journal", "--format", "json"];

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

async function main(): Promise<number> {
  if (!existsSync(CLI)) {
    out(`FAIL: ${CLI} does not exist. Run \`pnpm run build\` first.`);
    return 1;
  }
  out(`self-check: node ${CLI} ${ARGV.join(" ")}`);
  out(`node: ${process.version} (${process.execPath})`);
  const done = await runCommand("kragg", [process.execPath, CLI, ...ARGV], REPO_ROOT);
  if (done.stderr.trim() !== "") {
    out(`stderr from the run:\n${done.stderr.trim()}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(done.stdout);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    out(`FAIL: the run printed no JSON report (${reason}); it exited ${done.returncode}.`);
    out(done.stdout.slice(0, 2000));
    return 1;
  }

  const stated = readSelfCheckInput(payload);
  // The PROCESS exit status is what a shell acts on, so it is what is judged.
  // The payload's own `exit_code` must agree with it — the contract says so —
  // and a disagreement is reported rather than silently resolved either way.
  const verdict = evaluateSelfCheck({ gates: stated.gates, exitCode: done.returncode });
  for (const line of verdict.report) {
    out(line);
  }
  if (stated.exitCode !== done.returncode) {
    out(
      `FAIL: report.exit_code is ${stated.exitCode} but the process exited ` +
        `${done.returncode}; the two are a contract and must agree.`,
    );
    return 1;
  }
  if (verdict.ok) {
    out("OK: every gate either ran or is a reviewed, documented skip.");
    return 0;
  }
  for (const problem of verdict.problems) {
    out(`FAIL: ${problem}`);
  }
  out(
    "A check that did not run is not a check that passed. Fix the gate, or — if " +
      "the skip is genuinely acceptable — add a reviewed entry to " +
      "scripts/selfcheck/expectations.ts saying so, with the reason it matches.",
  );
  return 1;
}

process.exitCode = await main();
