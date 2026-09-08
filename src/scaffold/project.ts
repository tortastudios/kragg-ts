/**
 * The scaffold engine: create, initialize, generate.
 *
 * Ported from `create_new_project`, `initialize_project` and `generate_module`
 * in `kragg/scaffold.py`. Three rules from the original are load-bearing and
 * are preserved exactly:
 *
 *  1. `new` refuses a non-empty directory. Scaffolding on top of existing work
 *     is how a scaffold destroys something.
 *  2. `init` never overwrites (`overwrite=False`). It is run against a project
 *     that already has content and opinions; a guardrail file that clobbers a
 *     hand-written config teaches everyone to distrust the tool. Kept, and
 *     extended: `initPlan.ts` withholds the additions that would redefine the
 *     project even though they overwrite no file at all.
 *  3. `gen module` refuses when the module already exists, rather than
 *     silently writing nothing and reporting success.
 *
 * NOTHING HERE RUNS A PACKAGE MANAGER, ever. The scaffold's entire claim is
 * that the hardening in `.npmrc` and `pnpm-workspace.yaml` is in place before
 * the first install; an install triggered by the scaffold would by definition
 * have run before the human read what it was agreeing to.
 */

import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { guardrailFiles } from "./guardrails.ts";
import {
  isPlainObject,
  mergeAdditions,
  planInit,
  type InitPlan,
  type InitSkip,
} from "./initPlan.ts";
import type { Kind, McpSdk } from "./kinds.ts";
import { normalizePackageName, shadowConflict, shadowRefusal, validatePackageName } from "./naming.ts";
import { kindFiles, moduleFiles } from "./templates.ts";

/** Raised when a scaffold operation cannot proceed. Message is user-facing. */
export class ScaffoldError extends Error {
  override readonly name = "ScaffoldError";
}

/** Everything `createNewProject` needs to decide what to write. */
export interface NewProjectOptions {
  /** Directory to create the project in. Must be empty or absent. */
  readonly root: string;
  /** Human-facing project name, usually the directory's basename. */
  readonly projectName: string;
  /** Which skeleton to generate. */
  readonly kind: Kind;
  /** Explicit npm package name, decoupling it from the directory name. */
  readonly packageName?: string | undefined;
  /** Which MCP SDK to target when `kind` is `"mcp"`. */
  readonly mcpSdk?: McpSdk | undefined;
  /** Downgrade an import-shadowing refusal to a warning. */
  readonly allowShadowing?: boolean | undefined;
}

/** What a scaffold operation did, so the caller can report it honestly. */
export interface ScaffoldResult {
  /** Absolute paths written, in write order. */
  readonly written: readonly string[];
  /** Non-fatal messages (currently: an allowed shadowing conflict). */
  readonly warnings: readonly string[];
}

/**
 * Create a new kragg-managed project with the layered layout.
 *
 * Throws `ScaffoldError` rather than writing a partial project when the target
 * is unusable or the package name is refused — the checks all happen before
 * the first `writeFileSync`.
 */
export function createNewProject(options: NewProjectOptions): ScaffoldResult {
  const root = resolve(options.root);
  requireEmptyDirectory(root);
  const packageName = resolvePackageName(options);
  const warnings: string[] = [];
  const conflict = shadowConflict(packageName);
  if (conflict !== null) {
    const refusal = shadowRefusal(packageName, conflict);
    if (options.allowShadowing !== true) {
      throw new ScaffoldError(refusal);
    }
    warnings.push(`warning: ${refusal}`);
  }
  const mcpSdk: McpSdk = options.mcpSdk ?? "fastmcp";
  const identity = {
    projectName: options.projectName,
    packageName,
    kind: options.kind,
    mcpSdk,
  };
  const files = {
    ...guardrailFiles(identity),
    ...kindFiles(options.kind, options.projectName, mcpSdk),
  };
  return { written: writeFiles(root, files), warnings };
}

/** What `initializeProject` did, including what it deliberately did not do. */
export interface InitResult extends ScaffoldResult {
  /** Files and keys left alone, with the reason each was left alone. */
  readonly skipped: readonly InitSkip[];
}

/**
 * Work out what `kragg init` would do to `root`, writing nothing.
 *
 * This is the only place the decision is made — `initializeProject` applies
 * the plan this returns, and `--dry-run` prints it — so the dry run cannot
 * drift from the real one. It does not create `root` either: asking what init
 * would do must not leave a directory behind.
 *
 * An unparseable `package.json` fails HERE, before the first write, rather
 * than halfway through. "We could not read your config, so we replaced it" is
 * the failure mode that loses work.
 */
export function planInitialization(root: string): InitPlan {
  const absolute = resolve(root);
  const manifestPath = join(absolute, "package.json");
  const manifest = existsSync(manifestPath) ? readJsonObject(manifestPath) : null;
  return planInit(absolute, manifest);
}

/**
 * Add guardrail files to an EXISTING project. No skeleton, no overwrites, and
 * no change to what the project already means.
 *
 * `package.json` and `kragg.json` are the two files most likely to hold work
 * nobody wants replaced, so neither is written over: the manifest gains only
 * keys that are additive in effect as well as in the diff, and the policy is
 * created only when the project does not already state one. See `initPlan.ts`
 * for why each of those is not the obvious "merge everything in" behaviour.
 */
export function initializeProject(root: string): InitResult {
  return applyInitPlan(planInitialization(root));
}

/**
 * Carry out a plan, reporting honestly if it cannot be finished.
 *
 * Writability is checked before the first write, so the common failure — a
 * read-only target — costs nothing and leaves nothing behind. A failure part
 * way through cannot be undone (there is no transaction over a filesystem),
 * so it names every file already written instead of pretending it is clean.
 */
function applyInitPlan(plan: InitPlan): InitResult {
  requireWritable(plan.root);
  const written: string[] = [];
  try {
    for (const file of plan.writes) {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.contents, "utf8");
      written.push(file.path);
    }
    for (const merge of plan.merges) {
      const path = mergeJson(merge.path, merge.additions);
      if (path !== null) {
        written.push(path);
      }
    }
  } catch (error: unknown) {
    if (error instanceof ScaffoldError) {
      throw error;
    }
    throw new ScaffoldError(writeFailure(error, written));
  }
  return { written, warnings: [], skipped: plan.skipped };
}

/** Create the root if needed, and refuse before writing if it is read-only. */
function requireWritable(root: string): void {
  try {
    mkdirSync(root, { recursive: true });
    accessSync(root, constants.W_OK);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ScaffoldError(`cannot write to ${root}: ${detail}`);
  }
}

/** Report a failed write, and every file that was written before it. */
function writeFailure(error: unknown, written: readonly string[]): string {
  const detail = error instanceof Error ? error.message : String(error);
  const head = `kragg init could not finish: ${detail}`;
  if (written.length === 0) {
    return `${head}\nNothing was written.`;
  }
  const lines = written.map((path) => `  ${path}`).join("\n");
  return `${head}\nThese files were written before the failure and are still there:\n${lines}`;
}

/**
 * Generate the domain, service, and test slots for a new module.
 *
 * Refuses when any slot already exists: partially generating over a module
 * that is already there produces a mix of new stubs and old code, which is
 * strictly worse than doing nothing and saying so.
 */
export function generateModule(root: string, name: string): ScaffoldResult {
  const absolute = resolve(root);
  if (!existsSync(join(absolute, "src"))) {
    throw new ScaffoldError("no src/ directory found; run this from the project root");
  }
  const module = normalizePackageName(name);
  const invalid = validatePackageName(module);
  if (invalid !== null) {
    throw new ScaffoldError(`invalid module name '${name}': ${invalid}`);
  }
  const files = moduleFiles(module);
  const existing = Object.keys(files).filter((relative) =>
    existsSync(join(absolute, relative)),
  );
  if (existing.length > 0) {
    throw new ScaffoldError(
      `module '${module}' already exists: ${existing.join(", ")}`,
    );
  }
  return { written: writeFiles(absolute, files), warnings: [] };
}

/** The npm name to use: explicit and validated, or derived and normalized. */
function resolvePackageName(options: NewProjectOptions): string {
  const explicit = options.packageName;
  if (explicit === undefined || explicit === "") {
    return normalizePackageName(options.projectName);
  }
  const invalid = validatePackageName(explicit);
  if (invalid !== null) {
    throw new ScaffoldError(
      `--package '${explicit}' is not a valid npm package name: ${invalid}`,
    );
  }
  return explicit;
}

/** Refuse anything but a missing or empty directory. */
function requireEmptyDirectory(root: string): void {
  if (existsSync(root) && readdirSync(root).length > 0) {
    throw new ScaffoldError(`target directory is not empty: ${root}`);
  }
}

/**
 * Write `files` under `root`, returning the absolute paths written.
 *
 * Unconditional, and used only where the target has already been established
 * as safe to write: `new` refuses a non-empty directory and `gen module`
 * refuses an existing slot. `init`, which writes into a project full of
 * somebody else's files, decides file by file in `initPlan.ts` instead.
 */
export function writeFiles(
  root: string,
  files: Readonly<Record<string, string>>,
): string[] {
  const written: string[] = [];
  for (const relative of Object.keys(files).sort()) {
    const contents = files[relative];
    if (contents === undefined) {
      continue;
    }
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
    written.push(path);
  }
  return written;
}

/**
 * Merge `additions` into an existing JSON file, or create it.
 *
 * Additive only, and one level deep for nested objects: a key already present
 * keeps its value, at the top level and inside `scripts`/`dependencies` alike.
 * Returns the path when the file changed, `null` when it was already complete.
 *
 * An unparseable existing file is a hard error rather than a silent overwrite.
 * "We could not read your config, so we replaced it" is the failure mode that
 * loses work.
 */
export function mergeJson(
  path: string,
  additions: Readonly<Record<string, unknown>>,
): string | null {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(additions, null, 2)}\n`, "utf8");
    return path;
  }
  const outcome = mergeAdditions(readJsonObject(path), additions);
  if (outcome.added.length === 0) {
    return null;
  }
  writeFileSync(path, `${JSON.stringify(outcome.merged, null, 2)}\n`, "utf8");
  return path;
}

/** Read a JSON object, failing loudly on anything that is not one. */
function readJsonObject(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ScaffoldError(`${path} is not valid JSON: ${detail}`);
  }
  if (!isPlainObject(parsed)) {
    throw new ScaffoldError(`${path} does not contain a JSON object`);
  }
  return { ...parsed };
}
