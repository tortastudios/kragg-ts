/**
 * Package-level runs: `check --package` / `security --package`, and the
 * notice a root run prints about the members it did not check.
 *
 * ── THE PROBLEM ────────────────────────────────────────────────────────────
 * A workspace root usually has no `tsconfig.json`, no `typescript` of its own
 * and no source; its packages have all three, each differently. A root run
 * used to error on the missing root tsconfig, resolve the root's compiler for
 * everything, and say nothing at all about `packages/*` — the type error in
 * `packages/b` was invisible, and the report looked like the whole repository
 * had been judged.
 *
 * ── THE SHAPE OF A PACKAGE RUN ─────────────────────────────────────────────
 * One member, one complete run, as if `kragg` had been invoked inside it:
 *
 *  - ROOT: the member directory. Every gate, every `source_paths`, every
 *    `.kragg/` artifact and the journal are the member's.
 *  - POLICY: the member's own `kragg.json` / `package.json#kragg` when it has
 *    one; otherwise the ROOT's policy, since a workspace writes its rules once
 *    at the top. Never a merge, and never the defaults for a member of a repo
 *    that configured something.
 *  - TSCONFIG: the member policy's `tsconfig`, through `projectTsconfig`.
 *  - BASELINE: the member policy's `baseline`, read and (under
 *    `--update-baseline`) written at the MEMBER's root. A member that inherits
 *    the root's policy therefore keeps its accepted debt in its own
 *    `<member>/.kragg/baseline.json`, at the same relative path the root uses
 *    for its own — one reviewed file per root, never one root's file silently
 *    absorbing another root's findings.
 *  - COMPILER: `resolveTypeScript(member)` — the member's own `typescript`,
 *    or the one hoisted to the workspace root, resolved the way the member's
 *    code resolves it. Never the root's when the member has its own, and
 *    reported per member so a mixed-version workspace shows which was used.
 *  - PROGRAM: exactly one lazy `ts.Program`, owned by that member's
 *    `CatalogContext`, like any other run.
 *
 * ── HONEST AGGREGATION ─────────────────────────────────────────────────────
 * Members are never merged into one report: two `tsc` rows from two packages
 * folded into one gate would hide which package failed and which passed. Text
 * output prints one section per member and a workspace summary line; JSON
 * output prints an ARRAY of the ordinary per-member payloads, each with the
 * unchanged schema and its own `targets`. The exit code is the worst of the
 * members'. Every usage error — an unknown `--package`, a member whose
 * configured tsconfig does not exist, a malformed member policy — is found
 * BEFORE any gate runs and refuses the whole invocation with exit 2.
 *
 * ── WHAT A ROOT RUN SAYS ───────────────────────────────────────────────────
 * A run without `--package` in a workspace root checks the root package and
 * prints, on stderr, the members it did not check — or the reason the member
 * list could not be read. A skipped package is a fact the reader must see; it
 * is not part of the wire format, so it goes where every other run note goes.
 */

import { relative } from "node:path";

import { resolveTypeScript, type CompilerResolution } from "../analysis/sourceFile.ts";
import {
  EXIT_ENVIRONMENT,
  EXIT_GATE_FAILURES,
  EXIT_OK,
  EXIT_USAGE,
  renderText,
  reportExitCode,
  type CheckReport,
} from "../engine/report.ts";
import { toPayload, type ReportPayload } from "../engine/reportPayload.ts";
import type { WorkspacePackage } from "../environment/model.ts";
import { resolveProjectEnvironment, type ProjectEnvironment } from "../environment/project.ts";
import { selectWorkspacePackage } from "../environment/workspaces.ts";
import { declaresPolicy, loadPolicy, type KraggPolicy } from "../policy/policy.ts";
import type { Assembly } from "./check.ts";
import { executePipeline, type PipelineRun, type ReportFlags } from "./pipeline.ts";

/**
 * Builds one root's pipeline: `assembleCheck` or `assembleSecurity`.
 *
 * Generic in the flag record so a command's own flags reach the member run
 * with their types intact — `check` passes `--update-baseline` through here,
 * and a `ReportFlags`-typed seam would have dropped it from the type while
 * the spread kept carrying it at runtime.
 */
export type Assemble<F extends ReportFlags> = (
  flags: F,
  policy: KraggPolicy,
  env: ProjectEnvironment,
) => Promise<Assembly>;

/** A member whose run has been assembled and can be executed. */
interface PreparedMember {
  readonly member: WorkspacePackage;
  readonly compiler: CompilerResolution;
  readonly run: () => PipelineRun;
}

/** The usage error that stops the whole invocation before any gate runs. */
interface Refusal {
  readonly ok: false;
  readonly exit: number;
  readonly message: string;
}

/** Every `--package` value resolved to a member, or the refusal. */
type Selection = { readonly ok: true; readonly members: readonly WorkspacePackage[] } | Refusal;

/** The members to run, assembled, or the refusal. */
type Preparation = { readonly ok: true; readonly members: readonly PreparedMember[] } | Refusal;

/** Run the pipeline once per selected member and return the worst exit code. */
export async function runPackages<F extends ReportFlags>(
  flags: F,
  assemble: Assemble<F>,
): Promise<number> {
  const prepared = await prepareMembers(flags, assemble);
  if (!prepared.ok) {
    process.stderr.write(`kragg: ${prepared.message}\n`);
    return prepared.exit;
  }
  const payloads: ReportPayload[] = [];
  const verdicts: string[] = [];
  let exit = EXIT_OK;
  for (const member of prepared.members) {
    const report = await runMember(flags, member, payloads);
    const code = reportExitCode(report);
    verdicts.push(`${member.member.path} ${verdict(code)}`);
    exit = worst(exit, code);
  }
  if (flags.format === "json") {
    process.stdout.write(`${JSON.stringify(payloads, null, 1)}\n`);
  } else {
    process.stdout.write(
      `== workspace: ${prepared.members.length} packages checked: ${verdicts.join(", ")} ==\n`,
    );
  }
  return exit;
}

/**
 * Phase 1: resolve every selector and assemble every member's pipeline —
 * every usage error there is, before any gate runs anywhere.
 */
async function prepareMembers<F extends ReportFlags>(
  flags: F,
  assemble: Assemble<F>,
): Promise<Preparation> {
  const rootEnv = resolveProjectEnvironment(flags.root);
  const rootPolicy = loadPolicy(flags.root);
  const selected = selectMembers(flags, rootEnv);
  if (!selected.ok) {
    return selected;
  }
  const members: PreparedMember[] = [];
  for (const member of selected.members) {
    const policy = declaresPolicy(member.root) ? loadPolicy(member.root) : rootPolicy;
    const memberFlags: F = { ...flags, root: member.root, targets: [], packages: [] };
    const assembled = await assemble(memberFlags, policy, memberEnvironment(rootEnv, member));
    if (!assembled.ok) {
      return { ok: false, exit: assembled.exit, message: `${member.path}: ${assembled.message}` };
    }
    members.push({ member, compiler: resolveTypeScript(member.root), run: assembled.run });
  }
  return { ok: true, members };
}

/** Every `--package` value resolved to a member, once each, in order. */
function selectMembers(flags: ReportFlags, rootEnv: ProjectEnvironment): Selection {
  const members: WorkspacePackage[] = [];
  for (const selector of flags.packages) {
    const selected = selectWorkspacePackage(flags.root, rootEnv.workspaces, selector);
    if (!selected.ok) {
      return { ok: false, exit: EXIT_USAGE, message: selected.reason };
    }
    if (!members.some((member) => member.root === selected.package.root)) {
      members.push(selected.package);
    }
  }
  return { ok: true, members };
}

/**
 * Phase 2 for one member: announce it, run it, render it.
 *
 * Text output gets a section on stdout; JSON output collects the payload and
 * sends the compiler line to stderr, so stdout stays one parseable document.
 */
async function runMember(
  flags: ReportFlags,
  { member, compiler, run }: PreparedMember,
  payloads: ReportPayload[],
): Promise<CheckReport> {
  const compilerLine = describeCompiler(flags.root, compiler);
  if (flags.format === "text") {
    process.stdout.write(`== package ${label(member)} ==\n${compilerLine}\n`);
  } else {
    process.stderr.write(`kragg: ${member.path}: ${compilerLine}\n`);
  }
  const report = await executePipeline(run());
  if (flags.format === "text") {
    process.stdout.write(`${renderText(report)}\n`);
  } else {
    payloads.push(toPayload(report));
  }
  return report;
}

/**
 * The member's environment, with the package manager inherited from the
 * workspace root when the member declares none of its own.
 *
 * A member has no lockfile — the workspace root owns it — so detection inside
 * the member answers `unknown`, which would error the `audit` gate and blunt
 * every install hint for a repository that plainly uses pnpm. The root's
 * answer is the correct one for every member, and `source` says it was
 * inherited so `doctor`-style output stays traceable.
 */
function memberEnvironment(rootEnv: ProjectEnvironment, member: WorkspacePackage): ProjectEnvironment {
  const env = resolveProjectEnvironment(member.root);
  if (env.packageManager !== "unknown" || rootEnv.packageManager === "unknown") {
    return env;
  }
  return {
    ...env,
    packageManager: rootEnv.packageManager,
    source: `${rootEnv.source} (inherited from the workspace root)`,
  };
}

/**
 * The stderr notice for a root run in a workspace, or `undefined` for a
 * single-package repository.
 *
 * Printed whether the member list could be read or not: an unreadable
 * declaration is the MORE important case to announce, since nothing else in
 * the run will mention the packages it hid.
 */
export function uncheckedPackagesNotice(env: ProjectEnvironment, command: string): string | undefined {
  const { workspaces } = env;
  if (workspaces.kind === "none") {
    return undefined;
  }
  const hint = `run \`kragg ${command} --package <name-or-path>\` (repeatable) to check them`;
  if (workspaces.note !== null) {
    return (
      `workspace root: this run checked only the root package; its members could ` +
      `NOT be listed (${workspaces.note}) — ${hint}`
    );
  }
  if (workspaces.packages.length === 0) {
    return undefined;
  }
  const count = workspaces.packages.length;
  const names = workspaces.packages.map(label).join(", ");
  return (
    `workspace root: this run checked only the root package, NOT its ${count} member ` +
    `${count === 1 ? "package" : "packages"} (${names}) — ${hint}`
  );
}

function label(member: WorkspacePackage): string {
  return member.name === null ? member.path : `${member.path} (${member.name})`;
}

/** `compiler: typescript 5.9.3 (project: packages/b/node_modules/typescript/lib/typescript.js)`. */
function describeCompiler(root: string, compiler: CompilerResolution): string {
  const origin =
    compiler.path === null
      ? compiler.source
      : `${compiler.source}: ${relative(root, compiler.path) || compiler.path}`;
  const line = `compiler: typescript ${compiler.version} (${origin})`;
  return compiler.note === null ? line : `${line} — ${compiler.note}`;
}

function verdict(code: number): string {
  switch (code) {
    case EXIT_OK:
      return "passed";
    case EXIT_GATE_FAILURES:
      return "failed";
    default:
      return "error";
  }
}

/** A broken environment outranks findings, which outrank a clean member. */
function worst(left: number, right: number): number {
  const rank = (code: number): number =>
    code === EXIT_ENVIRONMENT ? 2 : code === EXIT_GATE_FAILURES ? 1 : 0;
  return rank(right) > rank(left) ? right : left;
}
