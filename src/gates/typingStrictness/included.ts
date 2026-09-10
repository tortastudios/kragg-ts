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
 * The list arrives as a `ProjectConfig` from `analysis/program.ts`, which
 * hands `parseJsonConfigFileContent` a REAL `readDirectory` (the flag audit
 * stubs it out, because it only wants `compilerOptions`), so `fileNames` is
 * literally the list `tsc` would compile: `files`, `include`, `exclude`, the
 * implicit recursive default when no `include` is given, extension rules and
 * all. Re-implementing that globbing would guarantee disagreeing with the
 * compiler on some edge, and a config gate that cries wolf gets switched off.
 * It is the same resolution the shared program is built from, so the two
 * cannot disagree about which files the config reaches.
 *
 * ── WHERE IT REFUSES TO GUESS ──────────────────────────────────────────────
 * A config carrying `references` AND inputs of its own is a hybrid: its own
 * inputs are audited, but the referenced projects' configs are not walked, and
 * a visible advisory says so. (A config with references and NO inputs — the
 * solution-style shape — never reaches this module: `config.ts` refuses it as
 * a gate error, since its flags are not what type-checks anything.) A stated
 * non-audit is honest; a false alarm is not.
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
 *  - one tsconfig — the selected one — like the rest of the gate;
 *  - `.d.ts` files are not walked, matching `parsedSources`;
 *  - the audit is over the WHOLE tree even under `--changed`, for the same
 *    reason the flag audit is: the config governs every file, and a directory
 *    dropped out of `include` must not hide behind an unrelated commit.
 */

import { relative, resolve } from "node:path";

import { toPosix } from "../../analysis/modulePath.ts";
import type { ProjectConfig } from "../../analysis/program.ts";
import { DEFAULT_EXTENSIONS, walkFiles } from "../../analysis/walk.ts";
import type { Violation } from "../../engine/models.ts";
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
 * Report source files no input of the config covers.
 *
 * `name` is the config's root-relative path, for the messages. `config` is
 * the compiler's resolution of it. An unusable config is not re-reported —
 * the flag audit has already turned it into a `tsconfig-invalid` violation, or
 * the gate has refused it outright — EXCEPT the one that simply matches
 * nothing (`kind: "empty"`), whose honest file list is empty and whose every
 * source file is therefore unchecked.
 */
export function auditIncludedSources(
  root: string,
  name: string,
  config: ProjectConfig,
  sourcePaths: readonly string[],
): IncludeAudit {
  if (!config.ok) {
    return config.kind === "empty" ? report(unchecked(root, sourcePaths, new Set()), name) : EMPTY;
  }
  if (config.references.length > 0) {
    return { violations: [], advisories: [unaudited(name, config.references.length)] };
  }
  const checked = new Set(config.parsed.fileNames.map((file) => resolve(file)));
  return report(unchecked(root, sourcePaths, checked), name);
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
function report(missing: readonly string[], name: string): IncludeAudit {
  if (missing.length === 0) {
    return EMPTY;
  }
  const violations: Violation[] = missing
    .slice(0, NAMED_LIMIT)
    .map((file) => fileViolation(file, name));
  const hidden = missing.length - violations.length;
  if (hidden > 0) {
    violations.push({
      message:
        `${hidden} further source files are outside \`${name}\` — ` +
        "the type checker never opens them either",
      file: name,
      code: CODE.uncheckedSource,
      fixHint:
        `widen \`include\` in \`${name}\` to cover the source paths, ` +
        "or drop the directory from `source_paths` in kragg.json if it is " +
        "deliberately not type-checked",
    });
  }
  return { violations, advisories: [] };
}

function fileViolation(file: string, name: string): Violation {
  return {
    message:
      `${file} is not type-checked — no \`files\`/\`include\` entry in ` +
      `\`${name}\` covers it, so tsc never reads it`,
    file,
    code: CODE.uncheckedSource,
    fixHint:
      `add \`${file}\` to \`include\` in \`${name}\` (or drop its ` +
      "directory from `source_paths` in kragg.json if it is deliberately not " +
      "type-checked — an unchecked directory should not be gated as source)",
  };
}

/**
 * The visible skip for a config that mixes its own inputs with references.
 *
 * ADVISORY, not a violation: the project is not doing anything wrong, and this
 * tier simply cannot follow it. It rides in the advisory bucket so it is
 * recorded and reported rather than silently absent — see the caveat on
 * `fromTypingStrictness` about when advisories reach the printed report.
 */
function unaudited(name: string, references: number): Violation {
  return {
    message:
      `include/exclude coverage was NOT audited: \`${name}\` declares ` +
      `${references} project ${references === 1 ? "reference" : "references"} ` +
      "beside its own inputs, and this tier reads one config per run — the " +
      "referenced projects' coverage of the source paths is unknown here",
    file: name,
    code: CODE.uncheckedSourceUnaudited,
    fixHint:
      "no action required; point `tsconfig` in kragg.json at each referenced " +
      "project in turn, or run kragg inside each referenced package, to have " +
      "its own tsconfig audited",
  };
}
