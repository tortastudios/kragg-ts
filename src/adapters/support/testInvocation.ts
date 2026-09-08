/**
 * WHICH command runs the suite, and WHERE that command came from.
 *
 * Two ways in, and the difference between them is the reason this module
 * exists rather than being three lines inside `adapters/testRunner.ts`:
 *
 *  1. **`test_command`** — the project states the argv. kragg resolves element
 *     0 the way it resolves every other tool, appends the reporter and
 *     coverage flags it must control and the `test_paths` patterns, and runs
 *     that. Nothing is inferred.
 *
 *  2. **Detection** — `support/detect.ts` reads `package.json#scripts.test`
 *     (or a vitest config, or a dependency) and concludes WHICH RUNNER the
 *     project uses. That is all it concludes. kragg then builds its own argv
 *     from policy.
 *
 * DETECTION IS NOT AN EQUIVALENT INVOCATION, and every message below says so
 * out loud. A project whose script is
 * `node --import tsx --test "src/**\/*.test.ts"` has detection answer "node",
 * correctly — and the argv kragg builds from that carries no `--import tsx`
 * and no `src/**\/*.test.ts`. Before this module, the gate printed neither the
 * script nor the argv, so a suite that loaded nothing and discovered nothing
 * was indistinguishable from a suite that passed. The provenance sentence is
 * therefore not documentation polish: it is the only thing that tells a reader
 * the command they are looking at is kragg's reconstruction rather than
 * theirs, and it names `test_command` as the way to stop reconstructing.
 */

import type { CompletedCommand } from "../../engine/models.ts";
import type { ProjectEnvironment } from "../../environment/project.ts";
import {
  missingTool as missingToolName,
  missingToolMessage,
  remediation,
} from "../../environment/project.ts";
import { detectTestRunner } from "./detect.ts";
import type { RunnerDetection, TestRunnerChoice, TestRunnerName } from "./detect.ts";
import { missingTool, notConfigured } from "./outcome.ts";
import type { Unavailable } from "./outcome.ts";
import { resolveProgram, resolveRunner } from "./testCommands.ts";

/** Runner programs kragg can identify a report format for by name alone. */
const RUNNER_PROGRAMS: readonly TestRunnerName[] = ["vitest", "node", "bun"];

/** One resolved way to run the suite. */
export interface Invocation {
  readonly runner: TestRunnerName;
  /** Resolved program plus the project's own arguments. Never a shell string. */
  readonly prefix: readonly string[];
  /** Short provenance, e.g. `kragg.json#test_command`. Reported as `source`. */
  readonly source: string;
  /** The `scripts.test` text, when detection read one. */
  readonly script?: string | undefined;
  /** True when `test_command` decided, so nothing about the argv is inferred. */
  readonly explicit: boolean;
}

/** An invocation, or the reason there is none. */
export type InvocationOutcome = ({ readonly ok: true } & Invocation) | Unavailable;

/** Everything deciding what runs, straight from policy. */
export interface InvocationInputs {
  readonly env: ProjectEnvironment;
  readonly choice: TestRunnerChoice;
  readonly testCommand: readonly string[];
}

/**
 * Resolve the invocation. `test_command` wins; `"off"` outranks even that.
 *
 * `"off"` is checked first because it is the one setting that means "do not
 * run tests", and a project that switched the gate off after writing a
 * `test_command` must not have the command run anyway.
 */
export function resolveInvocation(inputs: InvocationInputs): InvocationOutcome {
  const { env, choice, testCommand } = inputs;
  if (testCommand.length > 0 && choice !== "off") {
    return fromTestCommand(env, choice, testCommand);
  }
  const detection = detectTestRunner(env.root, choice);
  if (detection.runner === undefined) {
    return notConfigured(skipReason(detection, env));
  }
  const resolved = resolveRunner(env, detection.runner);
  if (!resolved.ok) {
    return resolved;
  }
  return {
    ok: true,
    runner: detection.runner,
    prefix: [resolved.bin],
    source: detection.source,
    script: detection.script,
    explicit: false,
  };
}

/**
 * Build the invocation `test_command` states.
 *
 * The runner is the ONE thing that still has to be known, because kragg parses
 * the report and the three runners write three unrelated formats. An explicit
 * `test_runner` decides it; otherwise the program name does. `policy.ts`
 * rejects the remaining case at load (exit 2), so reaching the error below
 * means a caller built these options itself.
 */
function fromTestCommand(
  env: ProjectEnvironment,
  choice: TestRunnerChoice,
  argv: readonly string[],
): InvocationOutcome {
  const program = argv[0] ?? "";
  const runner = choice === "auto" ? programRunner(program) : asRunner(choice);
  if (runner === undefined) {
    return missingTool(
      `test_command runs ${JSON.stringify(program)}, and kragg cannot tell which runner's ` +
        `report format that produces, so it will not run it. Set \`test_runner\` to one of ` +
        `${RUNNER_PROGRAMS.join(", ")}, or start \`test_command\` with one of them.`,
    );
  }
  const resolved = resolveProgram(env, program);
  if (!resolved.ok) {
    return resolved;
  }
  return {
    ok: true,
    runner,
    prefix: [resolved.bin, ...argv.slice(1)],
    source: "test_command",
    explicit: true,
  };
}

/** The runner a program name identifies, ignoring any directory part. */
function programRunner(program: string): TestRunnerName | undefined {
  const name = program.replaceAll("\\", "/").split("/").at(-1) ?? program;
  return RUNNER_PROGRAMS.find((runner) => runner === name);
}

/** Narrow a non-`auto`, non-`off` choice to the runner it names. */
function asRunner(choice: TestRunnerChoice): TestRunnerName | undefined {
  return RUNNER_PROGRAMS.find((runner) => runner === choice);
}

/**
 * The invocation, and whether kragg was told it or worked it out.
 *
 * Rendered into the gate's output, so it appears wherever a reader is given a
 * verdict they might otherwise attribute to their own test script.
 */
export function invocationNote(
  invocation: Invocation,
  command: readonly string[],
): string {
  const argv = `invocation: ${command.join(" ")}`;
  if (invocation.explicit) {
    return (
      `${argv}\n  from \`test_command\` in kragg.json, plus the reporter and coverage ` +
      "flags kragg has to control and the `test_paths` patterns."
    );
  }
  if (invocation.script !== undefined) {
    return (
      `${argv}\n  kragg BUILT this argv itself. The runner (${invocation.runner}) was ` +
      `inferred from ${invocation.source}, which reads \`${invocation.script}\` — that ` +
      "script was NOT run and this argv is not equivalent to it, so any loader, setup or " +
      "config flag it carries is missing here, and the files come from `test_paths` " +
      "rather than from the script. Set `test_command` (an argv array) to run a specific " +
      "invocation."
    );
  }
  return (
    `${argv}\n  kragg BUILT this argv itself: the runner (${invocation.runner}) comes from ` +
    `${invocation.source} and the files from \`test_paths\`. Set \`test_command\` (an argv ` +
    "array) if this suite needs a loader, a setup file or a config flag."
  );
}

/**
 * Why no runner ran, with the commands that would make one available.
 *
 * The unsupported branch names BOTH remedies. `test_runner` alone is not
 * always one: a jest suite cannot be re-run by vitest without changes, but a
 * `test_command` that drives the project's own runner through a wrapper can
 * be, so the reader is told about the setting that can actually help them.
 */
export function skipReason(detection: RunnerDetection, env: ProjectEnvironment): string {
  if (detection.source.startsWith("policy:")) {
    return `${detection.source} — the test gate is switched off in kragg.json`;
  }
  if (detection.unsupported !== undefined) {
    return (
      `this project's test script runs ${detection.unsupported}, which kragg does not ` +
      `drive yet (\`${detection.script ?? ""}\`). Nothing was checked. Set \`test_runner\` ` +
      "if one of vitest / node / bun can run this suite, or `test_command` (an argv array) " +
      "to state the invocation, with `test_runner` naming the report format it produces."
    );
  }
  return (
    "no test runner detected (looked at package.json#scripts.test, vitest.config.*, " +
    "a vitest dependency, and bunfig.toml). No tests were run, so nothing was verified.\n" +
    `${remediation(env.packageManager, "vitest @vitest/coverage-v8")}\n` +
    "or use Node's built-in runner: set `\"test\": \"node --test\"` in package.json, or " +
    "state the invocation with `test_command` in kragg.json."
  );
}

/**
 * Was the RUNNER ITSELF missing?
 *
 * The `_is_tool_module` twin from `catalog.py`. `missingToolName` reports
 * whatever name the output said could not be found; only when that name IS the
 * runner does this become an environment failure. A test file that cannot
 * import `./helpers.ts` produces the same class of message and is a TEST
 * failure — reported through the normal parse path, against the file that
 * failed. Getting this backwards tells someone to reinstall their toolchain
 * when they have a typo in an import.
 *
 * It lives here, beside the resolution that chose the program, because both
 * answer the same question about the same argv: is this a runner kragg was
 * able to start?
 */
export function runnerMissing(
  env: ProjectEnvironment,
  gate: string,
  runner: TestRunnerName,
  result: CompletedCommand,
): Unavailable | undefined {
  // `returncode: 127` is the shape `missingTool` reads, not a claim about what
  // the runner exited with: the question here is only which NAME the output
  // said could not be found.
  const missing = missingToolName({
    name: gate,
    command: [],
    cwd: env.root,
    returncode: 127,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  if (missing === null) {
    return undefined;
  }
  if (missing !== runner && !missing.endsWith(`/${runner}`)) {
    return undefined;
  }
  if (runner === "vitest") {
    return missingTool(missingToolMessage(env, "vitest", "vitest"));
  }
  return missingTool(
    `${runner} could not be started, so no tests ran.\n` +
      (runner === "bun"
        ? "Install bun (https://bun.com) or set `test_runner` to a runner this project has."
        : "kragg runs `node --test` on its own interpreter; this should not happen.") +
      `\n${remediation(env.packageManager, runner)}`,
  );
}
