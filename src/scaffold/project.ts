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
 *     hand-written config teaches everyone to distrust the tool.
 *  3. `gen module` refuses when the module already exists, rather than
 *     silently writing nothing and reporting success.
 *
 * NOTHING HERE RUNS A PACKAGE MANAGER, ever. The scaffold's entire claim is
 * that the hardening in `.npmrc` and `pnpm-workspace.yaml` is in place before
 * the first install; an install triggered by the scaffold would by definition
 * have run before the human read what it was agreeing to.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { guardrailFiles, packageJson, kraggConfig } from "./guardrails.ts";
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
  return { written: writeFiles(root, files, true), warnings };
}

/**
 * Add guardrail files to an EXISTING project. No skeleton, no overwrites.
 *
 * `package.json` and `kragg.json` are merged rather than written, because both
 * are near-certain to exist already and both are the file most likely to hold
 * work nobody wants replaced.
 */
export function initializeProject(root: string): ScaffoldResult {
  const absolute = resolve(root);
  mkdirSync(absolute, { recursive: true });
  const projectName = basenameOf(absolute);
  const identity = {
    projectName,
    packageName: normalizePackageName(projectName),
    kind: null,
    mcpSdk: "fastmcp" as const,
  };
  const files = guardrailFiles(identity);
  // Both are merged below; writing them here would clobber the existing file.
  delete files["package.json"];
  delete files["kragg.json"];
  const written = writeFiles(absolute, files, false);
  const merged = [
    mergeJson(join(absolute, "package.json"), packageJson(identity)),
    mergeJson(join(absolute, "kragg.json"), kraggConfig(null)),
  ].filter((path): path is string => path !== null);
  return { written: [...written, ...merged], warnings: [] };
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
  return { written: writeFiles(absolute, files, true), warnings: [] };
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

/** The final path segment, used as the project name for `init`. */
function basenameOf(absolute: string): string {
  const segments = absolute.split(/[\\/]/).filter((part) => part !== "");
  return segments[segments.length - 1] ?? "app";
}

/**
 * Write `files` under `root`, returning the absolute paths written.
 *
 * With `overwrite` false, an existing file is skipped silently — that is the
 * `init` contract, and the caller reports what was written, not what it
 * intended to write.
 */
export function writeFiles(
  root: string,
  files: Readonly<Record<string, string>>,
  overwrite: boolean,
): string[] {
  const written: string[] = [];
  for (const relative of Object.keys(files).sort()) {
    const contents = files[relative];
    if (contents === undefined) {
      continue;
    }
    const path = join(root, relative);
    if (!overwrite && existsSync(path)) {
      continue;
    }
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
  const existing = readJsonObject(path);
  const merged = { ...existing };
  let changed = false;
  for (const [key, value] of Object.entries(additions)) {
    const current = merged[key];
    if (current === undefined) {
      merged[key] = value;
      changed = true;
      continue;
    }
    if (isPlainObject(current) && isPlainObject(value)) {
      const nested = { ...current };
      for (const [innerKey, innerValue] of Object.entries(value)) {
        if (nested[innerKey] === undefined) {
          nested[innerKey] = innerValue;
          changed = true;
        }
      }
      merged[key] = nested;
    }
  }
  if (!changed) {
    return null;
  }
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
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

/** True for a JSON object, false for arrays, null, and primitives. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
