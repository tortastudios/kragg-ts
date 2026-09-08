/**
 * Typing-strictness gate: make `strict-ai-typescript` a VERIFIED contract.
 *
 * Ported from `kragg/src/kragg/gates/typing_strictness.py`, whose module
 * docstring states the problem exactly: "kragg's mypy gate is only as strong
 * as the project's mypy config, and the scaffold historically shipped none —
 * so a lax or absent `[tool.mypy]` let `dict[str, Any]` external data pass
 * trivially". Substitute `tsc` for mypy and `Record<string, any>` for
 * `dict[str, Any]` and nothing else changes: a `tsc` gate that reports green
 * against a config with `strict` off has verified nothing at all.
 *
 * So this gate audits the CONFIGURATION and scans for BLANKET IGNORES, in two
 * halves that live in their own modules:
 *
 *  - `typingStrictness/config.ts` — does `tsconfig.json`, with its `extends`
 *    chain resolved, actually meet the strict floor?
 *  - `typingStrictness/included.ts` — does that config's `include`/`exclude`
 *    actually REACH the policy's source paths, or is a directory excluded from
 *    type checking altogether?
 *  - `typingStrictness/hatches.ts` — does the source plant escape hatches that
 *    silence the checker regardless of the config?
 *
 * IT DOES NO TYPE INFERENCE AND NO TAINT ANALYSIS. The honest residual is the
 * Python one, and `KNOWN_LIMITATIONS.md` states it: a value typed `string`
 * that is really nullable still passes. The gate can only require the typing
 * floor that makes honest modelling possible; it cannot make anyone model
 * honestly.
 *
 * ── WHY THIS IS BIGGER THAN THE PYTHON GATE ────────────────────────────────
 * mypy has one config table and one source-level ignore. TypeScript has:
 * `strict` plus eight flags it implies, each individually re-disableable; a
 * second tier of flags that are not implied by `strict` at all but without
 * which strictness lies about external data; `extends`, which can hide any of
 * the above in another package; and five distinct in-source ways to switch the
 * checker off. Enumerating them is the substance of this gate.
 *
 * ── THE FLOOR, EXACTLY ─────────────────────────────────────────────────────
 * REQUIRED (a violation when not met):
 *   `strict: true` — or, mirroring Python's `_meets_floor`, every flag it
 *      implies set explicitly true;
 *   none of `strictNullChecks`, `noImplicitAny`, `strictFunctionTypes`,
 *      `strictBindCallApply`, `strictPropertyInitialization`,
 *      `useUnknownInCatchVariables`, `alwaysStrict`,
 *      `strictBuiltinIteratorReturn` set to `false`;
 *   `noUncheckedIndexedAccess: true` — load-bearing, see below;
 *   `exactOptionalPropertyTypes: true`;
 *   `noEmitOnError: true`, but ONLY when the config emits;
 *   not `allowJs` without `checkJs`.
 *
 * ADVISORY (reported, never fatal): `skipLibCheck`, `allowJs` WITH `checkJs`,
 * `verbatimModuleSyntax`, `isolatedModules`. Each carries the reasoning at its
 * definition in `config.ts`.
 *
 * `noUncheckedIndexedAccess` IS THE ONE TO ARGUE ABOUT, and it is required.
 * Without it, `process.env.API_URL` is typed `string` when it is really
 * `string | undefined`, every `Record<string, T>` lookup is typed as if it
 * always hits, and every array index is typed as if it is in bounds. That is
 * precisely the "external/nullable data consumed as a concrete type" bug class
 * `KNOWN_LIMITATIONS.md` names as the reason these gates exist. A project with
 * `strict: true` and this flag off is not strict about anything that came from
 * outside the program.
 *
 * ── WHAT IT DOES NOT AUDIT ─────────────────────────────────────────────────
 * Honest gaps, listed rather than hidden:
 *
 *  - only `<root>/tsconfig.json`. A monorepo's per-package configs and a
 *    project whose real config is `tsconfig.app.json` are unaudited;
 *  - a SOLUTION-STYLE config (one with `references`) is not audited for
 *    include coverage at all. It is skipped with a stated reason rather than
 *    guessed at — see `included.ts` for why a guess would report every file in
 *    the repo as unchecked;
 *  - `.d.ts` files, which `parsedSources` excludes. A hand-authored
 *    declaration file full of `any` is invisible here;
 *  - anything a `// kragg: ignore -- <reason>` covers, by design.
 */

import {
  absolutePath,
  parsedSources,
  resolveTypeScript,
  type TypeScriptApi,
} from "../analysis/sourceFile.ts";
import type { Violation } from "../engine/models.ts";
import { auditTsconfig } from "./typingStrictness/config.ts";
import { scanSourceHatches } from "./typingStrictness/hatches.ts";

export { ADVISORY_CODES, TYPING_STRICTNESS_CODES } from "./typingStrictness/codes.ts";

export interface TypingStrictnessOptions {
  /** Absolute project root — the directory holding `tsconfig.json`. */
  readonly root: string;
  /** Directories to scan for escape hatches, as `KraggPolicy.sourcePaths`. */
  readonly sourcePaths: readonly string[];
  /** Compiler to parse with. Defaults to `resolveTypeScript(root).api`. */
  readonly api?: TypeScriptApi | undefined;
  /**
   * Restrict the SOURCE scan to these files — the `--changed` path. The
   * config audit always runs: `tsconfig.json` governs every file whether or
   * not it changed, and skipping it on an unrelated commit would let a
   * loosened floor ride in unnoticed.
   */
  readonly paths?: readonly string[] | undefined;
}

/**
 * Either the findings, or the reason the gate could not run.
 *
 * The union follows `ForbiddenCallsOutcome`, with one addition:
 * `advisories`. `Violation` carries no severity field in either sibling, so a
 * finding that should be SEEN but should not fail a build is expressed as a
 * separate bucket with its own codes (`ADVISORY_CODES`). A caller building a
 * `GateResult` fails on `violations` and reports `advisories` alongside them.
 *
 * The `ok: false` arm is narrow on purpose: a missing `tsconfig.json` is a
 * violation (Python's `mypy-config-missing`), and an unparseable one is also a
 * violation, because "we could not verify the floor" must never be reported as
 * "the floor is met". Only a config that exists and cannot be READ — a
 * permission or I/O failure — is a gate that could not run.
 */
export type TypingStrictnessOutcome =
  | {
      readonly ok: true;
      readonly violations: readonly Violation[];
      readonly advisories: readonly Violation[];
    }
  | { readonly ok: false; readonly message: string };

/**
 * Audit the project's `tsconfig.json` and scan its sources for escape hatches.
 *
 * Config findings come first, then source findings in walk order and, within a
 * file, by position — so two runs over an unchanged tree diff cleanly.
 */
export function checkTypingStrictness(
  options: TypingStrictnessOptions,
): TypingStrictnessOutcome {
  const api = options.api ?? resolveTypeScript(options.root).api;
  const config = auditTsconfig(options.root, api, options.sourcePaths);
  if (!config.ok) {
    return { ok: false, message: config.message };
  }
  const violations: Violation[] = [...config.audit.violations];
  const advisories: Violation[] = [...config.audit.advisories];

  const wanted = selectedPaths(options);
  for (const source of parsedSources(options.root, options.sourcePaths, { api })) {
    if (wanted !== null && !wanted.has(source.path)) {
      continue;
    }
    const found = scanSourceHatches(source, api);
    violations.push(...found.violations);
    advisories.push(...found.advisories);
  }
  return { ok: true, violations, advisories };
}

/** Absolute paths the caller narrowed to, or `null` for "everything". */
function selectedPaths(options: TypingStrictnessOptions): ReadonlySet<string> | null {
  if (options.paths === undefined) {
    return null;
  }
  return new Set(options.paths.map((path) => absolutePath(options.root, path)));
}
