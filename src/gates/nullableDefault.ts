/**
 * Nullable-default gate: external or nullable data consumed as a concrete
 * value.
 *
 * THIS IS A REDESIGN, NOT A PORT, and the reason is worth stating plainly.
 * The Python gate exists because `d.get("n", 0)` returns the default only
 * when the key is ABSENT — a key present with value `None` yields `None`, so
 * `a.get("n", 0) + b.get("n", 0)` raises `TypeError` the first time an API
 * sends a null. That exact idiom has no JavaScript equivalent: `Map.get` has
 * no default parameter and object access has no `.get` at all. Translating
 * the AST patterns would have produced a gate that matches nothing.
 *
 * What survives the port is the FAILURE CLASS — external or nullable data
 * consumed as though it were a concrete type — and its two JavaScript forms:
 *
 *  1. `||` MIS-COALESCING. `const port = config.port || 3000` replaces a
 *     legitimate `0`, `""` or `false`, not just a missing value. This is the
 *     closest true analogue of the Python bug: a value that is present is
 *     defaulted away anyway. See `nullableDefault/falsyCoalesce.ts`.
 *  2. ARITHMETIC ON AN UNTYPED PAYLOAD. `JSON.parse` and `response.json()`
 *     return `any`, and JavaScript arithmetic coerces rather than raising, so
 *     `payload.count + 1` on a null field is `1` — a wrong number, silently,
 *     where Python would at least have crashed. See
 *     `nullableDefault/untypedPayload.ts`.
 *
 * ── PRECISION IS THE DESIGN CONSTRAINT ─────────────────────────────────────
 * The Python gate was measured at ~5 hits across a real 206-file repository,
 * and that number is the specification, not a side effect. A gate that fires
 * on every `||` in a codebase gets disabled within a week and then protects
 * nothing at all. So the rules are narrow on purpose, and each module's doc
 * comment states its own rules in full. In summary:
 *
 *  - only `||` (never `??` — that is the fix, not the bug);
 *  - only a TRUTHY NUMERIC OR BOOLEAN literal fallback (`|| 3000`, `|| true`)
 *    — a falsy fallback is harmless, a string fallback is usually intended,
 *    and a computed fallback is a choice rather than a default;
 *  - only when THE TYPE CHECKER CONFIRMS the left operand is nullable AND can
 *    actually be `0`/`false`. `1 | 2 | undefined` is not reported. `any` and
 *    `unknown` are skipped — the checker does not know, so neither do we;
 *  - only in a value position, never in a condition;
 *  - for rule 2, only arithmetic, only on an `any` that syntactically
 *    descends from a `JSON.parse`/`.json()` call, and `+` only against a
 *    number.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT CATCH ──────────────────────────────────
 *  - `??` ON A VALUE THAT SHOULD HAVE BEEN VALIDATED. `??` is the correct
 *    operator; whether a given default is a good idea is a judgement about
 *    the domain, not a fact in the syntax. Flagging it would flag the fix.
 *    The one place a default is unconditionally wrong is on a credential,
 *    and that is the `secret-default` gate's job.
 *  - `process.env.X` TYPED AS `string`. That is a compiler setting, not a
 *    code pattern: `noUncheckedIndexedAccess` makes it `string | undefined`
 *    for the whole repo in one line. Enforcing it belongs to
 *    `typing-strictness`, and re-implementing it here would mean reporting
 *    every environment read in a project that has already opted out.
 *  - A GENUINELY-NULLABLE FIELD MODELED AS NON-NULL. If the API can send
 *    `null` but the interface says `number`, every rule above sees a clean
 *    non-nullable type and stays quiet. `KNOWN_LIMITATIONS.md` says this for
 *    the whole class and it is true here too: static analysis can only see
 *    the nullability someone modeled. Only a runtime schema plus a test that
 *    feeds `null` closes it, and kragg can enforce neither.
 *  - COMPARISON, INDEXING, TRUTHINESS and template interpolation on untyped
 *    data. Real bugs of the same family, all out of scope, all for the same
 *    reason the Python gate restricts itself to arithmetic: hit count.
 *  - DATA FLOW OF ANY KIND. A payload passed as a parameter or stored on an
 *    object is not followed. There is no taint analysis, so — exactly as in
 *    Python — the gate cannot tell an API object from a local one and matches
 *    an idiom instead.
 *
 * ── MEASURED CALIBRATION ───────────────────────────────────────────────────
 * Run over three real TypeScript applications (380 program files, 679 `||`
 * sites, 624 arithmetic sites) the gate produced ZERO violations. Two sites
 * came close and were correctly rejected: `params.get("limit") || 100`, where
 * the left side is `string | null` and so has no falsy NUMBER to lose, and
 * `totalPct || 0.001`, a non-nullable `number` — a deliberate divide-by-zero
 * guard, not a defaulting mistake.
 *
 * Relaxing rule 3 to accept string fallbacks was measured on the same corpus:
 * 31 violations, roughly one per twelve files, and reading them they are
 * almost all intended (`brandDomain?.trim() || "<your-brand-domain.com>"`,
 * `accountType || "self_serve"`). That is the noise level at which a gate
 * gets switched off, and it is the empirical reason rule 3 exists.
 *
 * Two honest consequences of reporting that number. First, this gate is
 * calibrated BELOW the Python original's measured ~5 hits per 206 files, and
 * on this corpus it is unproven against a real defect — the unit tests show
 * it fires, production has not yet shown it fires. Second, a gate that never
 * fires still earns its place the way a lint rule does, by making the bug
 * un-mergeable rather than by finding one today. If a project measures
 * differently, the rules to revisit are 3 and 4, in that order.
 *
 * A residual false positive on a safe internal value is suppressed with a
 * trailing `// kragg: ignore -- <reason>`, visible in review at the site it applies to.
 */

import { relative } from "node:path";

import type bundledTs from "typescript";

import {
  programSourceFiles,
  sourceFilesFor,
  type AnalysisProgram,
} from "../analysis/program.ts";
import type { TypeScriptApi } from "../analysis/sourceFile.ts";
import type { Violation } from "../engine/models.ts";
import { suppression, unhonouredMessage } from "../util/suppress.ts";
import { falsyCoalesceFinding } from "./nullableDefault/falsyCoalesce.ts";
import type { NullableFinding } from "./nullableDefault/finding.ts";
import { untypedPayloadFinding } from "./nullableDefault/untypedPayload.ts";

/** `Violation.code` for every finding this gate produces. */
export const NULLABLE_DEFAULT_CODE = "nullable-default";

export interface NullableDefaultsOptions {
  /** The shared, lazy program handle — this gate needs a type checker. */
  readonly program: AnalysisProgram;
  /**
   * Restrict the scan to these files — the `--changed` path. Paths may be
   * absolute or root-relative; ones the program does not contain are dropped.
   * Omit to scan the project's whole source set.
   */
  readonly paths?: readonly string[] | undefined;
}

/**
 * Either the findings, or the reason the gate could not run.
 *
 * Same shape as `ForbiddenCallsOutcome`. A program that fails to build is
 * `ok: false` and reaches the caller as `error: true` / exit 3 — never as a
 * pass, because "the checker never ran" and "the checker found nothing" are
 * not the same result.
 */
export type NullableDefaultsOutcome =
  | { readonly ok: true; readonly violations: readonly Violation[] }
  | { readonly ok: false; readonly message: string };

/**
 * Report one violation per site where nullable data is consumed concretely.
 *
 * The two rules are applied to every node and cannot collide: rule 1 matches
 * `||`/`||=` and rule 2 matches arithmetic operators, which are disjoint
 * sets. At most one violation is produced per node.
 *
 * Violations are ordered by file (program order) and, within a file, by line
 * then column.
 */
export function checkNullableDefaults(
  options: NullableDefaultsOptions,
): NullableDefaultsOutcome {
  const load = options.program.load();
  if (!load.ok) {
    return { ok: false, message: load.message };
  }
  const api = options.program.compiler.api;
  const violations: Violation[] = [];
  for (const file of filesToScan(load.program, options)) {
    violations.push(...scanFile(file, api, load.checker, options.program.root));
  }
  return { ok: true, violations };
}

/** The project's own source files, optionally narrowed to a caller's list. */
function filesToScan(
  program: bundledTs.Program,
  options: NullableDefaultsOptions,
): readonly bundledTs.SourceFile[] {
  const own = programSourceFiles(program);
  if (options.paths === undefined) {
    return own;
  }
  const allowed = new Set(own);
  return sourceFilesFor(program, options.program.root, options.paths).filter((file) =>
    allowed.has(file),
  );
}

function scanFile(
  file: bundledTs.SourceFile,
  api: TypeScriptApi,
  checker: bundledTs.TypeChecker,
  root: string,
): readonly Violation[] {
  const lines = file.text.split(/\r?\n/);
  const relativePath = toPosix(relative(root, file.fileName));
  const found: Violation[] = [];

  const visit = (node: bundledTs.Node): void => {
    const finding =
      falsyCoalesceFinding(node, api, checker) ?? untypedPayloadFinding(node, api, checker);
    if (finding !== null) {
      const violation = toViolation(finding, file, lines, relativePath);
      if (violation !== null) {
        found.push(violation);
      }
    }
    api.forEachChild(node, visit);
  };
  api.forEachChild(file, visit);
  return found;
}

function toViolation(
  finding: NullableFinding,
  file: bundledTs.SourceFile,
  lines: readonly string[],
  relativePath: string,
): Violation | null {
  const start = file.getLineAndCharacterOfPosition(finding.node.getStart(file));
  const end = file.getLineAndCharacterOfPosition(finding.node.getEnd());
  const marker = suppression(lines, start.line + 1, end.line + 1);
  if (marker.kind === "honoured") {
    return null;
  }
  return {
    message: unhonouredMessage(finding.message, marker),
    file: relativePath,
    line: start.line + 1,
    column: start.character + 1,
    code: NULLABLE_DEFAULT_CODE,
    fixHint: finding.fixHint,
  };
}

function toPosix(path: string): string {
  return path.split("\\").join("/");
}
