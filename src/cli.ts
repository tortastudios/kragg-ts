#!/usr/bin/env node
/**
 * The `kragg` command-line interface.
 *
 * Deliberately built on `node:util`'s `parseArgs` and nothing else. A CLI
 * argument parser is the classic "just one small dependency" that drags a
 * transitive tree into a tool whose entire purpose is supply-chain and quality
 * discipline. See docs/dependency-policy.md.
 *
 * THE EXIT CODE IS THE INTERFACE. Everything else — text, JSON, colour — is
 * for a human skimming. The exit code is what a hook, a CI job or an agent
 * branches on, and it must be decidable without parsing a single line of
 * prose:
 *
 *   0  every gate passed (skips included: a skip is not a failure)
 *   1  gates ran and found violations — fix the code
 *   2  the invocation was wrong, or the config was — fix the command line
 *   3  a gate could not run — fix the environment; findings are unreliable
 *
 * `PolicyError` maps to 2, not 3. A `kragg.json` that names a linter we do not
 * recognise is the same class of mistake as a misspelled flag: the user told
 * us to do something we cannot do, and the fix is to correct what they wrote.
 *
 * SCAFFOLD COMMANDS PARSE THEIR OWN ARGV. `new`, `gen` and `init` take flags
 * this table does not know (`--kind`, `--mcp-sdk`, `--allow-shadowing`), so
 * they are routed BEFORE the strict parse and handed the raw remainder.
 * Folding their flags into `OPTIONS` instead would make every other command
 * silently accept `--kind`, which is exactly the class of "flag ignored, user
 * believes it applied" bug the per-command allowlist exists to prevent.
 *
 * AN ACCEPTED ARGUMENT MUST BE AN ARGUMENT THAT ACTS. That bug class has three
 * more shapes than a flag the command does not know, and all three are usage
 * errors here rather than silent fallbacks:
 *
 *   - a value outside its domain (`--format yaml`, `--max-violations abc`),
 *     which used to fall back to the default and run something the caller did
 *     not ask for (`invalidValue`);
 *   - a positional a command has no use for (`kragg status yesterday`), which
 *     used to be dropped on the floor (`POSITIONALS`);
 *   - `--file` alongside `--changed`/`--since`, where git decides the file set
 *     and the explicit list is discarded (`conflict`).
 *
 * `--help` is the fourth side of the same contract: `cli/usage.ts` documents
 * exactly the flags `ALLOWED` accepts, and `test/cli.test.ts` walks one
 * against the other.
 */

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { USAGE } from "./cli/usage.ts";
import { inventoryOptions } from "./commands/inventory.ts";
import { runAudit } from "./commands/audit.ts";
import { runBrief } from "./commands/brief.ts";
import { runCheck, type ReportFlags } from "./commands/check.ts";
import { runCoverage } from "./commands/coverage.ts";
import { runCriticality } from "./commands/criticality.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runFix } from "./commands/fix.ts";
import { flakyCommand } from "./commands/flaky.ts";
import { runGen } from "./commands/gen.ts";
import { hookCheck, hookCriticality } from "./commands/hookCheck.ts";
import { cmdHook } from "./commands/hook.ts";
import { runInit } from "./commands/init.ts";
import { runMap } from "./commands/map.ts";
import { mutationCommand } from "./commands/mutation.ts";
import { runNew } from "./commands/new.ts";
import { runPolicyShow } from "./commands/policyShow.ts";
import { runSecurity } from "./commands/security.ts";
import { runSpec } from "./commands/spec.ts";
import { runStatus } from "./commands/status.ts";
import {
  kraggVersion,
  EXIT_ENVIRONMENT,
  EXIT_OK,
  EXIT_USAGE,
} from "./engine/report.ts";
import { PolicyError } from "./policy/policy.ts";

/**
 * Commands with no handler yet.
 *
 * Empty, and it must stay that way by being emptied — never by deleting the
 * check. A command that silently does nothing is the failure mode this whole
 * project exists to prevent, so an unwired command has to SAY it is unwired.
 */
const PENDING: readonly string[] = [];

/**
 * The parse table.
 *
 * NO `default:` ANYWHERE, deliberately: an absent flag has to stay
 * distinguishable from one that was passed, or per-command validation cannot
 * tell `kragg doctor` from `kragg doctor --changed` and would accept flags the
 * command does not implement. Defaults are applied after validation instead.
 */
const OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  file: { type: "string", multiple: true },
  format: { type: "string" },
  "max-violations": { type: "string" },
  "no-journal": { type: "boolean" },
  changed: { type: "boolean" },
  since: { type: "string" },
  "fail-fast": { type: "boolean" },
  all: { type: "boolean" },
  last: { type: "string" },
  write: { type: "boolean" },
  path: { type: "string", multiple: true },
  rerun: { type: "string" },
  "update-baseline": { type: "boolean" },
  symbol: { type: "string", multiple: true },
  limit: { type: "string" },
  package: { type: "string", multiple: true },
} as const;

/** Command name -> the flags it accepts. */
type FlagTable = Readonly<Record<string, readonly string[]>>;

/** Which flags each command accepts. Anything else is a usage error. */
// ONE LINE PER COMMAND, however long: `test/cli.test.ts` reads this table as
// text to hold it in lockstep with the `--help` sections in `cli/usage.ts`,
// and a wrapped entry (or a comment between entries) is an unparsed line, not
// a silently smaller flag set.
const ALLOWED: FlagTable = {
  check: ["file", "format", "max-violations", "no-journal", "changed", "since", "fail-fast", "all", "update-baseline", "package"],
  security: ["file", "format", "max-violations", "no-journal", "package"],
  fix: ["file"],
  status: ["format", "last"],
  doctor: [],
  policy: [],
  map: ["write", "path", "symbol", "changed", "limit", "all", "format"],
  spec: ["path", "symbol", "changed", "limit", "all", "format"],
  brief: ["since", "path", "limit", "all"],
  coverage: [],
  criticality: ["write", "path"],
  audit: [],
  mutation: ["path", "since", "all", "update-baseline"],
  flaky: ["last", "rerun"],
  hook: [],
  new: [],
  gen: [],
  init: ["dry-run"],
};

/**
 * How many positionals each command takes after its own name.
 *
 * Two do: `policy show` and `hook claude`. Every other command takes NONE, and
 * an extra word is a usage error rather than something quietly dropped —
 * `kragg check src/a.ts` looks like it scoped the run (it does not; that is
 * `--file`), and `kragg status 20` looks like `--last 20`.
 */
const POSITIONALS: Readonly<Record<string, number>> = { policy: 1, hook: 1 };

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

/**
 * Run the CLI and return the process exit code.
 *
 * Returns rather than calling `process.exit` so the whole surface is testable
 * and so buffered stdout is never truncated on exit.
 */
export async function main(argv: readonly string[]): Promise<number> {
  // Scaffold commands own their argv — see the module header. Routed before
  // the strict parse, which would reject `--kind` and friends outright.
  const scaffold = routeScaffold(argv);
  if (scaffold !== null) {
    return scaffold;
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error: unknown) {
    return usageError(messageOf(error));
  }

  const { values, positionals } = parsed;
  if (values.version === true) {
    process.stdout.write(`${kraggVersion()}\n`);
    return EXIT_OK;
  }
  const command = positionals[0];
  if (values.help === true || command === undefined) {
    process.stdout.write(USAGE);
    // `kragg` with no command is a usage error even though we print help: a
    // caller that meant to run a check must not see a success code.
    return values.help === true ? EXIT_OK : EXIT_USAGE;
  }

  try {
    return await dispatch(command, positionals.slice(1), values);
  } catch (error: unknown) {
    return failure(error);
  }
}

/** Route to a handler after validating the flags it was given. */
async function dispatch(
  command: string,
  rest: readonly string[],
  values: Values,
): Promise<number> {
  if (PENDING.includes(command)) {
    process.stderr.write(
      `kragg: \`${command}\` is not implemented yet in the TypeScript port.\n` +
        "It is registered so this message is accurate; it has no handler.\n",
    );
    return EXIT_USAGE;
  }
  const allowed = ALLOWED[command];
  if (allowed === undefined) {
    return usageError(`unknown command '${command}'`);
  }
  const rejected = rejectedFlag(values, allowed);
  if (rejected !== null) {
    return usageError(`\`${command}\` does not accept --${rejected}`);
  }
  const extra = rest[POSITIONALS[command] ?? 0];
  if (extra !== undefined) {
    return usageError(`\`${command}\` does not take the argument '${extra}'`);
  }
  const invalid = invalidValue(values) ?? conflict(values);
  if (invalid !== null) {
    return usageError(invalid);
  }

  const root = process.cwd();
  const gate = gateCommand(command, rest, values, root);
  return gate ?? reportCommand(command, rest, values, root);
}

/**
 * The gate-running half: `check`, `security`, `fix`, and the config surfaces.
 *
 * Split from `reportCommand` along the same seam the help text uses. One
 * switch over every command was a single grade-C function, and the branching
 * was real — each arm builds a different options record — so the fix is fewer
 * arms per function, not a suppression.
 *
 * Returns `null` for a command it does not own, so the caller can try the
 * other half. `null` and not `undefined`: an arm that legitimately resolves to
 * `undefined` must stay distinguishable from "not mine".
 */
function gateCommand(
  command: string,
  rest: readonly string[],
  values: Values,
  root: string,
): Promise<number> | number | null {
  switch (command) {
    case "check":
      return runCheck({
        ...reportFlags(values, root),
        changed: values.changed === true,
        since: values.since ?? null,
        updateBaseline: values["update-baseline"] === true,
      });
    case "security":
      return runSecurity(reportFlags(values, root));
    case "fix":
      return runFix(root, values.file ?? []);
    case "status":
      return runStatus(root, format(values), integer(values.last, 10));
    case "doctor":
      return runDoctor(root);
    case "policy":
      // The only subcommand today; anything else is a usage error rather than
      // a silent `show`, so a future `policy set` cannot be mistaken for one.
      return rest[0] === "show" ? runPolicyShow(root) : usageError("usage: kragg policy show");
    default:
      return null;
  }
}

/** The reporting and test-depth half, plus the harness hook. */
function reportCommand(
  command: string,
  rest: readonly string[],
  values: Values,
  root: string,
): Promise<number> | number {
  switch (command) {
    case "map":
      return runMap({ root, write: values.write === true, ...inventoryOptions(values) });
    case "spec":
      return runSpec({ root, ...inventoryOptions(values) });
    case "brief": {
      // Only the two filters `brief` accepts: `ALLOWED` has already rejected
      // the others, and passing them anyway would document a surface it has not.
      const view = inventoryOptions(values);
      return runBrief({ root, since: values.since ?? null, paths: view.paths, limit: view.limit });
    }
    case "coverage":
      return runCoverage({ root });
    case "criticality":
      return runCriticality({ root, write: values.write === true, paths: values.path ?? [] });
    case "audit":
      return runAudit({ root });
    case "mutation":
      return mutationCommand({
        root,
        paths: values.path ?? [],
        // `undefined`, NOT `null`: `null` means "narrow to what changed against
        // HEAD", so defaulting to it made every `kragg mutation` a --since run
        // and a clean tree mutate nothing while exiting 0. The change
        // intersection is opt-in — see the module doc in commands/mutation.ts.
        changedSince: values.since,
        updateBaseline: values["update-baseline"] === true,
        incremental: values.all !== true,
      });
    case "flaky":
      return flakyCommand({ root, last: integer(values.last, 10), rerun: rerunCount(values) });
    case "hook":
      // The protocol name is required, not defaulted. Running the Claude
      // adapter under another harness's name would "work" while feeding a
      // model output it never reads — the silent-no-op failure again.
      return cmdHook({
        protocol: rest[0] ?? "",
        root,
        runCheck: hookCheck,
        ensureCriticality: hookCriticality,
      });
    default:
      return usageError(`unknown command '${command}'`);
  }
}

/** `--rerun N`, or 0 when the flag was not passed (passive mode). */
function rerunCount(values: Values): number {
  return values.rerun === undefined ? 0 : integer(values.rerun, 0);
}

/**
 * Route `new`/`gen`/`init`, or return `null` to fall through to normal parsing.
 *
 * These three take flags the shared `OPTIONS` table does not declare, so they
 * receive the raw remainder and parse it themselves.
 */
function routeScaffold(argv: readonly string[]): number | null {
  const rest = argv.slice(1);
  switch (argv[0]) {
    case "new":
      return runNew(rest);
    case "gen":
      return runGen(rest);
    case "init":
      return runInit(rest);
    default:
      return null;
  }
}

/** The first passed flag this command does not accept, or `null`. */
function rejectedFlag(values: Values, allowed: readonly string[]): string | null {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || name === "help" || name === "version") {
      continue;
    }
    if (!allowed.includes(name)) {
      return name;
    }
  }
  return null;
}

/** Assemble the reporting flags shared by `check` and `security`. */
function reportFlags(values: Values, root: string): ReportFlags {
  return {
    root,
    targets: values.file ?? [],
    format: format(values),
    maxViolations: values["max-violations"] === undefined
      ? undefined
      : integer(values["max-violations"], 0),
    journal: values["no-journal"] !== true,
    failFast: values["fail-fast"] === true,
    all: values.all === true,
    packages: values.package ?? [],
  };
}

/**
 * The first flag whose VALUE is outside its domain, as a message, or `null`.
 *
 * Every one of these used to fall back to a default. That is the same bug as
 * a flag the command ignores, one level down: `--format yaml` printed text and
 * exited 0, so a caller parsing stdout as JSON got a parse error with no way
 * to tell a bad flag from a broken run, and `--max-violations abc` silently
 * restored the policy's cap over the one the caller asked for. Neither can
 * make a failing project look passing, which is why it was survivable — but a
 * machine surface that quietly does something else is not one anybody can
 * build on. Checked once, here, whichever command was invoked.
 */
function invalidValue(values: Values): string | null {
  if (values.format !== undefined && values.format !== "text" && values.format !== "json") {
    return `--format must be 'text' or 'json', not '${values.format}'`;
  }
  return (
    notACount("max-violations", values["max-violations"]) ??
    notACount("last", values.last) ??
    notACount("limit", values.limit) ??
    notACount("rerun", values.rerun)
  );
}

/** Digits only, matching Python's `type=int`: no `1e3`, no sign, no padding. */
function notACount(name: string, raw: string | undefined): string | null {
  if (raw === undefined || /^[0-9]+$/.test(raw)) {
    return null;
  }
  return `--${name} must be a non-negative integer, not '${raw}'`;
}

/**
 * Flags the command accepts individually that cannot both apply, or `null`.
 *
 * `--changed`/`--since` hand the file set to git, and `resolveScope` in
 * `commands/check.ts` then DISCARDS an explicit `--file` list. Running the
 * caller's second choice without saying so is how a scope gets believed;
 * asking which one they meant costs one re-run and no trust.
 */
function conflict(values: Values): string | null {
  const fromGit = values.changed === true || values.since !== undefined;
  if (fromGit && values.file !== undefined) {
    return "--file cannot be combined with --changed or --since; git decides the file set";
  }
  // A package run is a FULL run of that package: git reports paths relative
  // to the repository root, not the member, and a `--file` would be relative
  // to whichever root the reader had in mind. Neither can be honoured yet.
  if (values.package !== undefined && (fromGit || values.file !== undefined)) {
    return "--package cannot be combined with --file, --changed or --since; a package run checks the whole package";
  }
  // Same class, one level down: `--all` is the inventories' spelling of
  // `--limit 0`, so accepting both means silently honouring one.
  if (values.all === true && values.limit !== undefined) {
    return "--all cannot be combined with --limit; --all IS the full export (--limit 0)";
  }
  return null;
}

/** `--format`, defaulting to text. `invalidValue` has already vetted it. */
function format(values: Values): "text" | "json" {
  return values.format === "json" ? "json" : "text";
}

/**
 * A non-negative integer flag, or the fallback when the flag is absent.
 *
 * The guard is not the validation — `invalidValue` rejects a non-count before
 * any command runs — it is what keeps that true for a future caller that does
 * not come through `dispatch`.
 */
function integer(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function usageError(message: string): number {
  process.stderr.write(`kragg: ${message}\n\n${USAGE}`);
  return EXIT_USAGE;
}

/**
 * Map a thrown error onto an exit code.
 *
 * `PolicyError` is a USAGE error: the project wrote something kragg cannot
 * act on, and the fix is to edit the config. Everything else that escapes a
 * command handler is an ENVIRONMENT error — the run did not complete, so no
 * verdict about the code was reached, and exit 1 would claim one.
 */
function failure(error: unknown): number {
  if (error instanceof PolicyError) {
    process.stderr.write(`kragg: ${error.message}\n`);
    return EXIT_USAGE;
  }
  process.stderr.write(`kragg: ${messageOf(error)}\n`);
  return EXIT_ENVIRONMENT;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* Only run when invoked as the entry point, so tests can import `main`. */
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv.slice(2));
}
