/**
 * `kragg fix` — the `ruff format` + `ruff check --fix` analogue.
 *
 * Ported from `cmd_fix`, with the one substitution the ecosystem forces: there
 * is no single tool that both formats and safely fixes TypeScript, so the
 * command drives whichever linter the project actually has, in its fix mode.
 *
 * RESOLVED FROM THE PROJECT, like every other tool kragg runs. A globally
 * installed linter of a different major applies different rules and would
 * rewrite the project's source to a style it never chose — and unlike a
 * misreported gate, that damage is on disk. `detectLintTool` enforces it.
 *
 * ABSENT IS A VISIBLE SKIP, never a silent success. "kragg fix printed nothing
 * and exited 0" must not be the way a project learns it has no linter.
 *
 * NOT the same coverage as `ruff format`: only biome formats. oxlint and
 * eslint fix lint findings and leave formatting alone, and the output says so
 * rather than implying a format pass happened.
 */

import { detectLintTool, type LintTool } from "../adapters/lint.ts";
import { resolveProjectEnvironment } from "../environment/project.ts";
import { runCommand } from "../engine/runner.ts";
import { commandOutput, commandPassed } from "../engine/models.ts";
import { EXIT_ENVIRONMENT, EXIT_GATE_FAILURES, EXIT_OK } from "../engine/report.ts";
import { loadPolicy } from "../policy/policy.ts";

/** How one linter is invoked in fix mode, and what that pass covers. */
interface FixMode {
  /** Arguments appended to the linter's bin. */
  readonly args: readonly string[];
  /** Whether this pass also reformats, as `ruff format` would. */
  readonly formats: boolean;
}

/** Arguments that put each linter into fix mode, and what that covers. */
const FIX_MODES: Readonly<Record<LintTool, FixMode>> = {
  // `--fix` applies only the fixes oxlint considers safe.
  oxlint: { args: ["--fix"], formats: false },
  // `check --write` is biome's combined formatter + safe-fix pass, which is
  // the closest thing in the ecosystem to `ruff format && ruff check --fix`.
  biome: { args: ["check", "--write"], formats: true },
  eslint: { args: ["--fix"], formats: false },
};

/** Run the project's linter in fix mode. Returns the process exit code. */
export async function runFix(root: string, targets: readonly string[]): Promise<number> {
  const policy = loadPolicy(root);
  const env = resolveProjectEnvironment(root);
  const detected = detectLintTool(env, policy.lintTool);
  if (!detected.ok) {
    // The adapter's message is worded for the lint GATE, so say whose refusal
    // this is before quoting it: a stray "the lint gate did not run" under
    // `kragg fix` reads like the wrong command reported.
    process.stderr.write(`kragg fix: nothing to run.\n${detected.message}\n`);
    // A named-but-missing linter is an ERROR: the project asked for a specific
    // tool and we did not run it. "No linter anywhere" is a skip.
    return detected.reason === "error" ? EXIT_ENVIRONMENT : EXIT_OK;
  }

  const mode = FIX_MODES[detected.tool];
  const paths = targets.length > 0 ? targets : policy.sourcePaths;
  const command = [detected.bin, ...mode.args, ...paths];
  const result = await runCommand(detected.tool, command, root);

  process.stdout.write(`${detected.tool} ${mode.args.join(" ")}\n`);
  const output = commandOutput(result);
  if (output !== "") {
    process.stdout.write(`${output}\n`);
  }
  if (!mode.formats) {
    process.stdout.write(
      `note: ${detected.tool} fixes lint findings only; it does not format.\n`,
    );
  }
  return commandPassed(result) ? EXIT_OK : EXIT_GATE_FAILURES;
}
