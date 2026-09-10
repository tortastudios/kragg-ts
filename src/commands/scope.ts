/**
 * ONE place decides what an invocation checks.
 *
 * `check` and `security` both accept `--file`, `check` also accepts
 * `--changed`/`--since`, and every gate downstream reads the answer out of the
 * same `CatalogContext`. When the resolution lived inside `runCheck` and was
 * re-derived by hand in `runSecurity`, the two drifted, and neither of them
 * had anywhere to put the cases that are not a plain list of files. This
 * module is that place.
 *
 * ── THE THREE MODES ────────────────────────────────────────────────────────
 *
 *  - `full`    — no scoping. Per-file tools get `source_paths`; the gates that
 *                take a file list get `undefined`, which means "the whole
 *                project" and is NOT the same as an empty array.
 *  - `changed` — `--changed`/`--since`. Git decides, and only the source files
 *                that still exist become targets.
 *  - `file`    — explicit `--file`. The caller decides. `targets` stays
 *                exactly what was typed (it is on the wire); a directory is
 *                expanded into `paths`, which is not, so the path-aware gates
 *                see the same files the linter does. A `--file` that names
 *                nothing at all is a mistake to report, not a scope to run.
 *
 * ── A CONFIG EDIT IS A CHANGE, AND IT CHANGES EVERYTHING ───────────────────
 * `check --changed` used to answer "no changed TypeScript files" and exit 0
 * after an edit to `kragg.json`, `tsconfig.json`, `package.json` or a linter
 * config — the four files most able to change what every gate concludes about
 * every file. Tighten `max_file_lines`, loosen `strict`, add a dependency with
 * an advisory against it, and the incremental run reported a green tree it had
 * not looked at.
 *
 * So the rule, and it is deliberately the blunt one: **a change set that
 * contains a configuration or dependency input makes the run a FULL run.** Not
 * "run the gates whose inputs changed" — nobody can keep that mapping honest
 * as gates are added, and a wrong mapping is a silent pass. The report says
 * `mode: "full"` and lists the source paths in `targets`, because that is what
 * was checked; the reason is printed on stderr so a human is not left
 * wondering why `--changed` ran the suite.
 *
 * {@link CONFIGURATION_INPUTS} and {@link CONFIGURATION_PREFIXES} are that
 * list, in full. Nothing is matched by guesswork.
 *
 * ── A DELETION IS ALSO A CHANGE ────────────────────────────────────────────
 * A deleted file must never be handed to a per-file tool: there is no file. It
 * must equally never be mistaken for "nothing changed" — deleting the module
 * that half the tree imports is the change most likely to break the build. So
 * a change set whose source edits are ONLY removals is promoted to a full run
 * as well, for the same reason and by the same code path. A change set with
 * both removals and survivors needs no promotion: the survivors make it a real
 * `changed` run, and `tsc` compiles the whole project on every run anyway, so
 * the broken importer is reported wherever it lives.
 *
 * ── AN EMPTY SELECTION IS NOT A FAILED ONE ─────────────────────────────────
 * A repository where nothing changed, or where only a `README.md` changed, has
 * a genuinely empty selection. That is exit 0 and the documented clean-run
 * report — it is not an error, and it must not become a full run either, or
 * every doc edit would run the test suite. What is an error is git being
 * unable to answer at all (exit 3, carrying git's own message) and a `--file`
 * that names nothing checkable (exit 2, naming the path).
 */

import { statSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";

import { walkFiles } from "../analysis/walk.ts";
import { EXIT_ENVIRONMENT, EXIT_USAGE } from "../engine/report.ts";
import {
  scanChanges,
  selectSourceFiles,
  SOURCE_EXTENSIONS,
  type ChangedPaths,
} from "../git/changes.ts";
import type { KraggPolicy } from "../policy/policy.ts";
import { testScanDirectories } from "../util/testPaths.ts";

/** What one invocation is scoped to. */
export interface Scope {
  /** Passed to the per-file external tools (the linter, the scanner). */
  readonly targets: readonly string[];
  /** Narrowing for path-aware gates; `undefined` for a whole-project run. */
  readonly paths: readonly string[] | undefined;
  readonly mode: "full" | "changed" | "file";
  /**
   * One line explaining a resolution the caller did not literally ask for —
   * today, an incremental run promoted to a full one. Printed on stderr, so
   * `--format json`'s stdout stays a single parseable document.
   */
  readonly note: string | undefined;
}

/** A resolved scope, or the exit code and message the invocation earned. */
export type ScopeResult =
  | { readonly ok: true; readonly scope: Scope }
  | { readonly ok: false; readonly exit: number; readonly message: string };

/** The flags that decide a scope. `security` passes the incremental pair off. */
export interface ScopeRequest {
  readonly root: string;
  /** `--file`, repeatable. Empty means "the whole project". */
  readonly targets: readonly string[];
  readonly changed: boolean;
  readonly since: string | null;
}

/**
 * Configuration and dependency inputs, by exact file name.
 *
 * Matched on the BASENAME at any depth, so a workspace package's own
 * `package.json` or `tsconfig.json` counts. Every entry is a file some part of
 * this pipeline actually reads:
 *
 *  - `kragg.json` and `package.json` — the policy (`policy/policy.ts` reads
 *    `kragg.json`, then `package.json#kragg`), and the dependency manifest the
 *    `audit` gate and every tool resolution work from.
 *  - the lockfiles and `pnpm-workspace.yaml` — what is actually installed, and
 *    therefore which advisories apply and which binaries exist.
 *  - `biome.json`/`biome.jsonc` and `bunfig.toml` — a linter and a test-runner
 *    config the adapters read (`adapters/lint.ts`, `adapters/support/detect.ts`).
 *
 * `tsconfig*.json`, the remaining linter configs and the vitest configs are
 * matched by prefix instead; see {@link CONFIGURATION_PREFIXES}.
 */
export const CONFIGURATION_INPUTS: readonly string[] = [
  "kragg.json",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "biome.json",
  "biome.jsonc",
  "bunfig.toml",
];

/**
 * Configuration inputs whose names carry a variable tail.
 *
 * These mirror the file-name tables in `adapters/lint.ts`
 * (`SPECS[*].configFiles`) and `adapters/support/detect.ts` (`VITEST_CONFIGS`)
 * without restating each extension, so a new extension on either side cannot
 * fall out of this list.
 *
 * `tsconfig` is NOT here: it is the one prefix common enough to collide with
 * real source (`tsconfigLoader.ts`), so it is matched with its `.json`
 * extension required — see {@link isConfigurationName}.
 */
export const CONFIGURATION_PREFIXES: readonly string[] = [
  ".oxlintrc.",
  "oxlint.config.",
  "eslint.config.",
  ".eslintrc",
  "vitest.config.",
  "vitest.workspace.",
];

/**
 * Resolve what this invocation checks.
 *
 * Order matters: git failure before anything else (nothing is knowable), then
 * `--file` validation (the caller's own mistake), then the full-run default.
 * `--file` alongside `--changed`/`--since` never reaches here — `cli.ts`
 * rejects the combination as a usage error.
 */
export async function resolveScope(
  request: ScopeRequest,
  policy: KraggPolicy,
): Promise<ScopeResult> {
  if (request.changed || request.since !== null) {
    return await incrementalScope(request, policy);
  }
  if (request.targets.length > 0) {
    return explicitScope(request.root, request.targets);
  }
  return { ok: true, scope: fullScope(policy, undefined) };
}

/** `--changed`/`--since`: git decides, and a config edit overrules it. */
async function incrementalScope(
  request: ScopeRequest,
  policy: KraggPolicy,
): Promise<ScopeResult> {
  const scan = await scanChanges(request.root, request.since);
  if (!scan.ok) {
    return {
      ok: false,
      exit: EXIT_ENVIRONMENT,
      message: `${scan.message} (--changed/--since needs a git repository it can query)`,
    };
  }
  const promotion = fullRunReason(request.root, scan.paths, policy);
  if (promotion !== undefined) {
    return { ok: true, scope: fullScope(policy, promotion) };
  }
  // `selectSourceFiles` filters by DIRECTORY, so a `test_paths` entry that is
  // a pattern contributes its literal base (`util/testPaths.ts`). A colocated
  // `src/**/*.test.ts` is already covered by `source_paths`.
  const allowed = [...policy.sourcePaths, ...testScanDirectories(policy.testPaths)];
  const sources = selectSourceFiles(request.root, scan.paths.present, allowed);
  return { ok: true, scope: { targets: sources, paths: sources, mode: "changed", note: undefined } };
}

/**
 * Why this change set has to be checked in full, or `undefined`.
 *
 * Both arms name the file that forced it. "kragg ran everything" with no
 * reason attached is the kind of surprise people work around by not using the
 * flag.
 */
function fullRunReason(
  root: string,
  paths: ChangedPaths,
  policy: KraggPolicy,
): string | undefined {
  const configured = changedConfiguration([...paths.present, ...paths.removed], policy);
  if (configured !== undefined) {
    return (
      `${configured} changed, which can change what every gate concludes about ` +
      "every file, so this run is a full check rather than an incremental one"
    );
  }
  const allowed = [...policy.sourcePaths, ...testScanDirectories(policy.testPaths)];
  if (selectSourceFiles(root, paths.present, allowed).length > 0) {
    return undefined;
  }
  const removed = selectSourceFiles(root, paths.removed, allowed, { mustExist: false });
  const first = removed[0];
  if (first === undefined) {
    return undefined;
  }
  return (
    `${first} was removed and no changed source file is left to check, ` +
    "so this run is a full check rather than an incremental one"
  );
}

/** The first changed configuration/dependency input, or `undefined`. */
function changedConfiguration(
  names: readonly string[],
  policy: KraggPolicy,
): string | undefined {
  const baseline = policy.secretBaseline;
  return names.find(
    (name) =>
      (baseline !== undefined && normalize(name) === normalize(baseline)) ||
      isConfigurationName(basename(name)),
  );
}

/** Whether one file NAME (not path) is a configuration or dependency input. */
function isConfigurationName(file: string): boolean {
  if (file.startsWith("tsconfig") && file.endsWith(".json")) {
    return true;
  }
  return (
    CONFIGURATION_INPUTS.includes(file) ||
    CONFIGURATION_PREFIXES.some((prefix) => file.startsWith(prefix))
  );
}

/**
 * `--file`: check that every path the caller named is there, and say which
 * files each one stands for.
 *
 * A PATH THAT DOES NOT EXIST IS EXIT 2, naming it. It used to sail through as
 * a target: the linter reported "no files found" — an error whose message is
 * about the linter, not about the typo — while five path-aware gates matched
 * nothing at all and printed `[PASS]`. A typo in a scope must not be able to
 * produce a green gate.
 *
 * A DIRECTORY IS EXPANDED, but only in `paths`. `targets` stays exactly what
 * the caller wrote, because `targets` is on the wire and the cross-language
 * contract pins it as "the paths/files checked, as given" (SPEC.md section
 * 2.1, and the sibling's own `--file src` goldens). `paths` is internal, and
 * it is what the gates that compare file paths read — so `--file src` used to
 * lint the whole tree while `typing-strictness`, `type-complexity`,
 * `nullable-default`, `secret-default` and `forbidden-calls` matched zero
 * files and reported `[PASS]` over them. Expanding here is what makes every
 * gate agree about one argument. The walk excludes ambient declarations,
 * exactly as the source walk does everywhere else; a `.d.ts` named EXPLICITLY
 * is still honoured, because then the caller has said so.
 */
function explicitScope(root: string, targets: readonly string[]): ScopeResult {
  const paths: string[] = [];
  for (const target of targets) {
    const resolved = resolveTarget(root, target);
    if (!resolved.ok) {
      return resolved;
    }
    for (const file of resolved.files) {
      if (!paths.includes(file)) {
        paths.push(file);
      }
    }
  }
  return { ok: true, scope: { targets, paths, mode: "file", note: undefined } };
}

/** One resolved `--file` argument, or the usage error it earned. */
type TargetResult =
  | { readonly ok: true; readonly files: readonly string[] }
  | { readonly ok: false; readonly exit: number; readonly message: string };

/** The files one `--file` argument stands for, repo-relative. */
function resolveTarget(root: string, target: string): TargetResult {
  const absolute = resolve(root, target);
  const stat = statOf(absolute);
  if (stat === null) {
    return { ok: false, exit: EXIT_USAGE, message: `--file ${target}: no such file or directory` };
  }
  if (stat === "directory") {
    const walked = [...walkFiles(absolute, SOURCE_EXTENSIONS, false, resolve(root))];
    return { ok: true, files: walked.map((file) => toRelative(root, file)) };
  }
  // A file is taken at its word, extension and all: `--file kragg.json` is a
  // caller saying what to check, and the gates that cannot read it simply do
  // not match it. `tsc` compiles the whole project regardless — see TOR-1359.
  return { ok: true, files: [toRelative(root, absolute)] };
}

/** The whole project: source paths for the tools, "everything" for the gates. */
function fullScope(policy: KraggPolicy, note: string | undefined): Scope {
  // DIVERGES from Python, which passes only `source_paths[0]` to its external
  // tools and therefore lints exactly one directory in a project that declares
  // several. Passing all of them checks what the project said it has.
  return { targets: policy.sourcePaths, paths: undefined, mode: "full", note };
}

/** `"file"`, `"directory"`, or `null` when the path is not there at all. */
function statOf(absolute: string): "file" | "directory" | null {
  try {
    return statSync(absolute).isDirectory() ? "directory" : "file";
  } catch {
    return null;
  }
}

function toRelative(root: string, absolute: string): string {
  return relative(resolve(root), absolute).split(sep).join("/");
}

/** Repo-relative POSIX normalisation: drop a `./` prefix and trailing `/`. */
function normalize(value: string): string {
  let path = value.replaceAll("\\", "/");
  while (path.startsWith("./")) {
    path = path.slice(2);
  }
  while (path.endsWith("/") && path.length > 1) {
    path = path.slice(0, -1);
  }
  return path;
}
