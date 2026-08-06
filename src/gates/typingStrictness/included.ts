/**
 * Does the type checker ever LOOK at the source? The `include`/`exclude` half
 * of `typing-strictness`.
 *
 * ── THE BLIND SPOT THIS CLOSES ─────────────────────────────────────────────
 * The rest of this gate audits how strictly `tsc` is configured. None of it
 * asks the prior question: which files does that configuration actually reach?
 * A project can hold an immaculate `compilerOptions` and write
 * `"exclude": ["src/generated", "src/legacy"]`, and every flag check above
 * still reports green — over code the compiler never opened. That is the exact
 * failure mode kragg exists to prevent, committed by kragg's own gate.
 *
 * So: take the file list the COMPILER resolves for the config, take the files
 * the policy's `source_paths` really contain, and report the difference.
 *
 * ── THE FILE LIST IS THE COMPILER'S, NOT OURS ──────────────────────────────
 * `parseJsonConfigFileContent` is handed a REAL `readDirectory` here (the rest
 * of this gate stubs it out, because it only wants `compilerOptions`), so
 * `fileNames` is literally the list `tsc` would compile: `files`, `include`,
 * `exclude`, the implicit recursive default when no `include` is given,
 * extension rules and all. Re-implementing that globbing would guarantee
 * disagreeing with the compiler on some edge, and a config gate that cries
 * wolf gets switched off.
 *
 * ── WHERE IT REFUSES TO GUESS ──────────────────────────────────────────────
 * A root config carrying `references` is a SOLUTION-STYLE build: it typically
 * lists no inputs of its own and delegates every file to the referenced
 * projects, whose configs this tier does not walk. Auditing it would report
 * every source file in the repo as unchecked, which is both wrong and the
 * loudest possible way to be wrong. Those projects get a visible advisory
 * naming the reason instead — a stated non-audit is honest; a false alarm is
 * not.
 *
 * ── THERE IS DELIBERATELY NO PER-GATE OPT-OUT ──────────────────────────────
 * `structureExclude` exists because a barrel legitimately exceeds a symbol
 * budget while still being real, checked code. Nothing is analogous here: the
 * finding is "this file is not type-checked", and a project that wants it
 * silenced has exactly two honest answers, both of which already exist:
 *
 *   1. put the file in `include`, so it IS type-checked; or
 *   2. take its directory out of `source_paths` in `kragg.json`, so kragg
 *      stops calling it source at all.
 *
 * The second is the real opt-out for a generated directory, and it is the
 * better one precisely because it is not gate-local: a directory nobody
 * type-checks should not be silently gated by the complexity, secret and
 * forbidden-call gates either. Adding a `typecheckExclude` would let a project
 * keep a directory inside `source_paths`, outside the compiler, and green —
 * which is the state this module exists to make visible.
 *
 * ── SCOPE, STATED ──────────────────────────────────────────────────────────
 *  - only `<root>/tsconfig.json`, like the rest of the gate. A project whose
 *    real config is `tsconfig.app.json` is unaudited here;
 *  - `.d.ts` files are not walked, matching `parsedSources`;
 *  - the audit is over the WHOLE tree even under `--changed`, for the same
 *    reason the flag audit is: the config governs every file, and a directory
 *    dropped out of `include` must not hide behind an unrelated commit.
 */

import { dirname, relative, resolve } from "node:path";

import type ts from "typescript";

import { toPosix } from "../../analysis/modulePath.ts";
import type { TypeScriptApi } from "../../analysis/sourceFile.ts";
import { DEFAULT_EXTENSIONS, walkFiles } from "../../analysis/walk.ts";
import type { Violation } from "../../engine/models.ts";
import { TSCONFIG_NAME, type Table } from "./chain.ts";
import { TYPING_STRICTNESS_CODES as CODE } from "./codes.ts";

/** Findings split by whether they fail the gate, as `ConfigAudit` is. */
export interface IncludeAudit {
  readonly violations: readonly Violation[];
  readonly advisories: readonly Violation[];
}

/**
 * How many unchecked files are named before the rest become a count.
 *
 * A directory dropped from `include` can hold hundreds of files, and a
 * violation per file would bury every other finding in the report. The names
 * are what make the first ones actionable; the tail only needs to be true.
 */
const NAMED_LIMIT = 20;

const EMPTY: IncludeAudit = { violations: [], advisories: [] };

/**
 * Report source files no `tsconfig.json` input covers.
 *
 * `config` is the PARSED tsconfig JSON — the same object the flag audit hands
 * to `parseJsonConfigFileContent` — so the file is read once for both halves.
 */
export function auditIncludedSources(
  root: string,
  config: unknown,
  sourcePaths: readonly string[],
  api: TypeScriptApi,
): IncludeAudit {
  const solution = referenceCount(config);
  if (solution > 0) {
    return { violations: [], advisories: [unaudited(solution)] };
  }
  const checked = resolvedFiles(root, config, api);
  if (checked === null) {
    return EMPTY;
  }
  return report(unchecked(root, sourcePaths, checked));
}

/**
 * The files the compiler resolves for this config, or `null` when it could
 * not be asked.
 *
 * `null` is not "everything is unchecked": the flag audit has already turned
 * an unparseable config into a `tsconfig-invalid` violation, and reporting
 * every source file a second time would only add noise to a config the project
 * already has to fix.
 */
function resolvedFiles(
  root: string,
  config: unknown,
  api: TypeScriptApi,
): ReadonlySet<string> | null {
  const configPath = resolve(root, TSCONFIG_NAME);
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: api.sys.useCaseSensitiveFileNames,
    // The real one, unlike everywhere else in this gate: the file LIST is the
    // entire question here.
    readDirectory: (base, extensions, excludes, includes, depth) =>
      api.sys.readDirectory(base, extensions, excludes, includes, depth),
    fileExists: (file: string) => api.sys.fileExists(file),
    readFile: (file: string) => api.sys.readFile(file),
  };
  let command: ts.ParsedCommandLine;
  try {
    command = api.parseJsonConfigFileContent(
      config,
      host,
      dirname(configPath),
      undefined,
      configPath,
    );
  } catch {
    return null;
  }
  return new Set(command.fileNames.map((file) => resolve(file)));
}

/** Source files under the policy's paths that the compiler's list omits. */
function unchecked(
  root: string,
  sourcePaths: readonly string[],
  checked: ReadonlySet<string>,
): readonly string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  const absoluteRoot = resolve(root);
  for (const sourcePath of sourcePaths) {
    const base = resolve(absoluteRoot, sourcePath);
    for (const file of walkFiles(base, DEFAULT_EXTENSIONS, false, absoluteRoot)) {
      const absolute = resolve(file);
      if (seen.has(absolute)) {
        continue;
      }
      seen.add(absolute);
      if (!checked.has(absolute)) {
        missing.push(toPosix(relative(absoluteRoot, absolute)));
      }
    }
  }
  return missing.sort();
}

/** One violation per named file, then a single count for the tail. */
function report(missing: readonly string[]): IncludeAudit {
  if (missing.length === 0) {
    return EMPTY;
  }
  const violations: Violation[] = missing.slice(0, NAMED_LIMIT).map(fileViolation);
  const hidden = missing.length - violations.length;
  if (hidden > 0) {
    violations.push({
      message:
        `${hidden} further source files are outside \`${TSCONFIG_NAME}\` — ` +
        "the type checker never opens them either",
      file: TSCONFIG_NAME,
      code: CODE.uncheckedSource,
      fixHint:
        `widen \`include\` in \`${TSCONFIG_NAME}\` to cover the source paths, ` +
        "or drop the directory from `source_paths` in kragg.json if it is " +
        "deliberately not type-checked",
    });
  }
  return { violations, advisories: [] };
}

function fileViolation(file: string): Violation {
  return {
    message:
      `${file} is not type-checked — no \`files\`/\`include\` entry in ` +
      `\`${TSCONFIG_NAME}\` covers it, so tsc never reads it`,
    file,
    code: CODE.uncheckedSource,
    fixHint:
      `add \`${file}\` to \`include\` in \`${TSCONFIG_NAME}\` (or drop its ` +
      "directory from `source_paths` in kragg.json if it is deliberately not " +
      "type-checked — an unchecked directory should not be gated as source)",
  };
}

/**
 * The visible skip for a solution-style build.
 *
 * ADVISORY, not a violation: the project is not doing anything wrong, and this
 * tier simply cannot follow it. It rides in the advisory bucket so it is
 * recorded and reported rather than silently absent — see the caveat on
 * `fromTypingStrictness` about when advisories reach the printed report.
 */
function unaudited(references: number): Violation {
  return {
    message:
      `include/exclude coverage was NOT audited: \`${TSCONFIG_NAME}\` declares ` +
      `${references} project ${references === 1 ? "reference" : "references"}, ` +
      "so it is a solution-style build whose inputs live in the referenced " +
      "configs — this tier reads only the root config and would report every " +
      "source file as unchecked",
    file: TSCONFIG_NAME,
    code: CODE.uncheckedSourceUnaudited,
    fixHint:
      "no action required; run kragg inside each referenced project to have " +
      "its own tsconfig audited",
  };
}

/** How many `references` entries the root config declares. */
function referenceCount(config: unknown): number {
  if (!isTable(config)) {
    return 0;
  }
  const references: unknown = config["references"];
  return Array.isArray(references) ? references.length : 0;
}

/** True for a non-null, non-array object — a tsconfig document's shape. */
function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
