/**
 * `kragg fix` — the `ruff format` + `ruff check --fix` analogue.
 *
 * Ported from `cmd_fix`, with the one substitution the ecosystem forces: there
 * is no single tool that both formats and safely fixes TypeScript, so the
 * command drives whichever linter the project actually has, in its fix mode,
 * and — separately — whichever formatter it actually has.
 *
 * TWO ORTHOGONAL CHOICES, TWO DETECTIONS. `detectLintTool` answers "what lints
 * here" and `detectFormatter` answers "what formats here"; the JavaScript
 * ecosystem does not tie the two together (oxlint + Prettier is an ordinary
 * pairing, and it is this repository's own shape). The one exception is biome,
 * which does both jobs: when biome is the LINTER, `check --write` is already a
 * combined format-and-fix pass, so no second formatter is asked for — a second
 * one would fight it over the same files.
 *
 * RESOLVED FROM THE PROJECT, like every other tool kragg runs. A globally
 * installed linter or formatter of a different major applies different rules
 * and would rewrite the project's source to a style it never chose — and
 * unlike a misreported gate, that damage is on disk. `detectLintTool` and
 * `detectFormatter` both enforce it.
 *
 * ABSENT IS A VISIBLE SKIP, never a silent success. "kragg fix printed nothing
 * and exited 0" must not be the way a project learns it has no linter, and the
 * `does not format` note is still printed — with the formatter skip's own
 * reason under it — whenever the pass genuinely did not format.
 */

import { detectFormatter, type FormatTool } from "../adapters/format.ts";
import { detectLintTool, type LintDetection, type LintTool } from "../adapters/lint.ts";
import { resolveProjectEnvironment, type ProjectEnvironment } from "../environment/project.ts";
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

/**
 * What the format half of this invocation will do.
 *
 * Three cases, not two, because "biome already formatted" and "nothing formats
 * here" both mean no formatter runs and mean opposite things to the reader:
 * the first is a completed format pass, the second is the skip the
 * `does not format` note exists to stay honest about.
 */
type FormatPass =
  | {
      readonly kind: "run";
      readonly tool: FormatTool;
      readonly bin: string;
      readonly args: readonly string[];
    }
  | { readonly kind: "covered" }
  | { readonly kind: "none"; readonly message: string };

/** Run the project's linter in fix mode, then its formatter. */
export async function runFix(root: string, targets: readonly string[]): Promise<number> {
  const policy = loadPolicy(root);
  const env = resolveProjectEnvironment(root);
  const lint = detectLintTool(env, policy.lintTool);
  if (!lint.ok && lint.reason === "error") {
    // The adapter's message is worded for the lint GATE, so say whose refusal
    // this is before quoting it: a stray "the lint gate did not run" under
    // `kragg fix` reads like the wrong command reported. A named-but-missing
    // linter is an ERROR — the project asked for a specific tool and we did
    // not run it — and NOTHING else runs, because a command that formatted
    // anyway would have half-honoured an explicit instruction.
    process.stderr.write(`kragg fix: nothing to run.\n${lint.message}\n`);
    return EXIT_ENVIRONMENT;
  }

  const format = formatPass(env, lint);
  if (!lint.ok && format.kind === "none") {
    // "No linter anywhere" is a skip, not an error — but it is a LOUD one,
    // and it now carries the formatter's own reason too.
    process.stderr.write(`kragg fix: nothing to run.\n${lint.message}\n${format.message}\n`);
    return EXIT_OK;
  }
  const paths = targets.length > 0 ? targets : policy.sourcePaths;
  return runPasses(root, lint, format, paths);
}

/**
 * Which formatter runs, if any.
 *
 * Biome-as-the-linter is answered without asking `detectFormatter` at all: its
 * fix mode has already formatted, and detecting a second formatter would only
 * invite two tools to rewrite the same files in one command.
 */
function formatPass(env: ProjectEnvironment, lint: LintDetection): FormatPass {
  if (lint.ok && FIX_MODES[lint.tool].formats) {
    return { kind: "covered" };
  }
  const detected = detectFormatter(env);
  if (!detected.ok) {
    return { kind: "none", message: detected.message };
  }
  return { kind: "run", tool: detected.tool, bin: detected.bin, args: detected.args };
}

/**
 * Run whichever halves exist, in order, and report what the other half did not
 * do. Reached only when at least one of the two will actually run.
 */
async function runPasses(
  root: string,
  lint: LintDetection,
  format: FormatPass,
  paths: readonly string[],
): Promise<number> {
  let passed = true;
  if (lint.ok) {
    passed = await runPass(root, lint.tool, lint.bin, FIX_MODES[lint.tool].args, paths);
  } else {
    // A formatter still runs: the two choices are independent, so a project
    // that formats but does not lint is not a project with nothing to do.
    process.stderr.write(`kragg fix: no linter ran.\n${lint.message}\n`);
  }
  if (format.kind === "run") {
    passed = (await runPass(root, format.tool, format.bin, format.args, paths)) && passed;
  } else if (format.kind === "none" && lint.ok) {
    // Keep the per-tool `formats` reporting honest: this pass really did fix
    // lint findings only, and the formatter's own reason says why.
    process.stdout.write(`note: ${lint.tool} fixes lint findings only; it does not format.\n`);
    process.stdout.write(`${format.message}\n`);
  }
  return passed ? EXIT_OK : EXIT_GATE_FAILURES;
}

/** Run one tool over the targets, echoing what ran and what it said. */
async function runPass(
  root: string,
  tool: string,
  bin: string,
  args: readonly string[],
  paths: readonly string[],
): Promise<boolean> {
  const result = await runCommand(tool, [bin, ...args, ...paths], root);
  process.stdout.write(`${tool} ${args.join(" ")}\n`);
  const output = commandOutput(result);
  if (output !== "") {
    process.stdout.write(`${output}\n`);
  }
  return commandPassed(result);
}
