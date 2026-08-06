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
 */

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { runAudit } from "./commands/audit.ts";
import { runBrief } from "./commands/brief.ts";
import { runCheck, type ReportFlags } from "./commands/check.ts";
import { runCoverage } from "./commands/coverage.ts";
import { runCriticality } from "./commands/criticality.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runFix } from "./commands/fix.ts";
import { flakyCommand } from "./commands/flaky.ts";
import { runGen } from "./commands/gen.ts";
import { hookCheck } from "./commands/hookCheck.ts";
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

const USAGE = `kragg — guardrails for AI-assisted TypeScript projects

Usage:
  kragg <command> [options]

Gates:
  check          run the quality gates
  security       run the security gates only
  fix            format and safely fix lint findings

Inventory and review:
  map            exported symbols, so nothing gets reinvented
  spec           the test suite rendered as a documentation tree
  brief          a reviewable digest of the change set
  status         show recent run history
  policy show    print the effective policy
  doctor         verify this project's setup

Test depth (on-demand, never the inner loop):
  coverage       uncovered lines in critical functions, ranked by fan-in
  criticality    call-graph risk -> CRITICALITY.md + .kragg/criticality.json
  mutation       mutation-test critical files with Stryker
  flaky          gates that flipped on an unchanged commit
  audit          dead code and dependency drift

Scaffolding:
  new <name>     a new project (--kind cli|api|mcp)
  gen module <n> service/domain/test slots in the layered layout
  init           add guardrails to an existing project

Harness integration:
  hook claude    hook adapter; reads hook JSON on stdin

Options for check and security:
  --file <path>          scope to this file (repeatable)
  --format text|json     output format (default: text)
  --max-violations <n>   cap violations shown per gate
  --no-journal           do not append to .kragg/history.jsonl

Options for check only:
  --changed              only files changed against HEAD
  --since <ref>          only files changed since <ref>
  --fail-fast            stop at the first failing gate
  --all                  run slow gates even after a fast gate failed

Options for status:
  --format text|json     output format (default: text)
  --last <n>             how many runs to read (default: 10)

Global options:
  -h, --help             show this help and exit
  -v, --version          print the version and exit

Exit codes:
  0  all gates passed
  1  gates ran and found violations
  2  usage error (bad flags, unknown command, unusable config)
  3  environment broken (a gate could not run)
`;

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
} as const;

/** Command name -> the flags it accepts. */
type FlagTable = Readonly<Record<string, readonly string[]>>;

/** Which flags each command accepts. Anything else is a usage error. */
const ALLOWED: FlagTable = {
  check: ["file", "format", "max-violations", "no-journal", "changed", "since", "fail-fast", "all"],
  security: ["file", "format", "max-violations", "no-journal"],
  fix: ["file"],
  status: ["format", "last"],
  doctor: [],
  policy: [],
  map: ["write"],
  spec: [],
  brief: ["since"],
  coverage: [],
  criticality: ["write", "path"],
  audit: [],
  mutation: ["path", "since", "all", "write"],
  flaky: ["last", "rerun"],
  hook: [],
  new: [],
  gen: [],
  init: [],
};

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
      return runMap({ root, write: values.write === true });
    case "spec":
      return runSpec({ root });
    case "brief":
      return runBrief({ root, since: values.since ?? null });
    case "coverage":
      return runCoverage({ root });
    case "criticality":
      return runCriticality({ root, write: values.write === true });
    case "audit":
      return runAudit({ root });
    case "mutation":
      return mutationCommand({
        root,
        paths: values.path ?? [],
        changedSince: values.since ?? null,
        updateBaseline: values.write === true,
        incremental: values.all !== true,
      });
    case "flaky":
      return flakyCommand({ root, last: integer(values.last, 10), rerun: rerunCount(values) });
    case "hook":
      // The protocol name is required, not defaulted. Running the Claude
      // adapter under another harness's name would "work" while feeding a
      // model output it never reads — the silent-no-op failure again.
      return cmdHook({ protocol: rest[0] ?? "", root, runCheck: hookCheck });
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
  };
}

/**
 * `--format`, defaulting to text.
 *
 * An unrecognised value falls back rather than throwing, and that is the
 * lenient choice on purpose: the argument only decides how results are
 * PRINTED, so getting it wrong cannot make a failing project look passing.
 */
function format(values: Values): "text" | "json" {
  return values.format === "json" ? "json" : "text";
}

/** A non-negative integer flag, or the fallback when it is not one. */
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
