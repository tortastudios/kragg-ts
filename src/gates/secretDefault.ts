/**
 * Secret-default gate: secret-named bindings that silently fall back.
 *
 * This is the inverse of a secret scanner. detect-secrets asks "is a
 * credential committed here?"; this gate asks "will this credential be ABSENT
 * at runtime and quietly replaced with nothing?". `process.env.HMAC_SECRET ??
 * ""` deploys happily unconfigured and signs every request with an empty key;
 * `private apiToken = ""` in a settings class does the same. A blank signing
 * key must fail at startup, not sign.
 *
 * ── WHAT IS FLAGGED ────────────────────────────────────────────────────────
 * A name matching a policy secret suffix, given a fallback that is a literal:
 *
 *  - env reads with a literal fallback — `process.env.API_TOKEN ?? ""`,
 *    `process.env["API_TOKEN"] || "dev"`, `Bun.env.X ?? ""`,
 *    `import.meta.env.VITE_TOKEN ?? ""`, `Deno.env.get("X_SECRET") ?? ""`;
 *  - destructuring defaults — `const { apiSecret = "" } = process.env`,
 *    including the renaming form `{ API_TOKEN: t = "" }`;
 *  - string-literal bindings — `const apiToken = ""`, `this.apiToken = ""`,
 *    `private apiToken = ""`, `apiToken ??= ""`, and chained assignment
 *    (`a = b = ""` is seen at both targets);
 *  - object-literal properties — `{ apiKey: "" }`;
 *  - parameter defaults — `function f(signingKey = "")`, on functions,
 *    methods and arrows alike;
 *  - schema builder defaults — `z.string().default("")`, anywhere in the
 *    chain. This CLOSES a limitation the Python gate documents (Pydantic's
 *    `Field(default="")` is a known miss there); `.default(<literal>)` is
 *    purely syntactic, so reading it is not a guess.
 *
 * A non-empty fallback is reported too, with different wording: `?? "dev"` is
 * a hardcoded credential, not an absent one, and both are bugs.
 *
 * ── WHAT IS NOT FLAGGED, ON PURPOSE ────────────────────────────────────────
 *  - `process.env.X ?? throwIfMissing("X")`. This is the CORRECT pattern. The
 *    fallback must be a LITERAL to be a finding; a call may throw, and `??`
 *    evaluates it lazily, so a call in the fallback slot is exactly how you
 *    fail loudly. This diverges from Python, which flags any non-`None`
 *    default because Python's `os.getenv(k, f())` evaluates `f()` eagerly and
 *    therefore cannot express the pattern at all.
 *  - `?? null` / `?? undefined`. Those model "absent" honestly and force the
 *    caller to handle it, exactly as Python leaves `None` defaults alone.
 *  - `process.env.X ?? FALLBACK` where `FALLBACK` is a constant. Resolving it
 *    needs data flow; the gate has none, and guessing is worse than missing.
 *  - reads through some other object — `config.get("apiToken", "")`,
 *    `settings.apiToken ?? ""`. Python draws the same line: no taint
 *    analysis, so the gate cannot tell a config object from any other object,
 *    and the idiom it matches is the one at the environment boundary.
 *  - `z.string().catch("")`, `setDefault`-style helpers, and any other
 *    project-specific defaulting API. Only `.default()` is recognised.
 *
 * ── THE VALIDATE-AFTER PATTERN ─────────────────────────────────────────────
 * Python flags the read in `x = getenv("X_SECRET", ""); if not x: raise` and
 * recommends restructuring. THIS GATE DOES NOT, and the divergence is
 * deliberate: that code already fails loudly at startup, which is the whole
 * requirement, so reporting it teaches people to suppress. The recognition is
 * narrow and sound in the flagging direction — the fallback must initialize a
 * variable whose very next statement is an `if` testing that identifier for
 * emptiness and unconditionally throwing. A guard three statements later,
 * behind a helper, or one that logs instead of throwing is not recognised and
 * the finding stands. See `guardedByThrow` for the exact rule. It applies
 * only to an EMPTY fallback: after `?? "dev"` the guard can never fire, so
 * the read is still broken and still reported.
 *
 * ── RESIDUAL FALSE POSITIVE ────────────────────────────────────────────────
 * A non-secret variable that merely matches a suffix — a tokenizer's
 * `token = ""`, a `csrfToken` placeholder in a fixture — is reported. Suppress
 * the reviewed site with a trailing `// kragg: ignore`, which is visible in
 * review, rather than by narrowing `secret_name_suffixes` repo-wide.
 *
 * ── MEASURED CALIBRATION ───────────────────────────────────────────────────
 * Run over four real TypeScript repositories (~1,900 non-declaration files)
 * the gate produced nine violations, every one of them a genuinely
 * secret-named binding, and every one of them in a TEST file holding a
 * hardcoded credential (`token: "tok_123"`). With the default
 * `source_paths = ["src"]` those are not scanned at all, so the measured
 * production hit count on that corpus is zero, and the measured false
 * positive count is also zero.
 *
 * RECALL IS BOUNDED BY THE POLICY, NOT BY THIS CODE, and the same corpus
 * shows it: `process.env.DASHBOARD_SERVICE_KEY || ""` appears three times in
 * one production dashboard and is NOT reported, because `ServiceKey` is not
 * in `secret_name_suffixes` — bare `Key` is excluded on purpose (`sortKey`,
 * `cacheKey`) and no qualified form covers it. Adding `ServiceKey` to the
 * policy surfaces all three immediately. A project should expect to extend
 * the suffix list with its own vocabulary; that is the contract this gate
 * enforces rather than discovers.
 *
 * ── WHY THIS GATE IS SYNTAX-ONLY ───────────────────────────────────────────
 * Every rule above reads shapes, not types, so this gate never builds a
 * `ts.Program`. It runs in the cheap tier with `kragg check --changed` over a
 * handful of files in milliseconds. That is a property worth keeping: a
 * security gate people skip because it is slow protects nothing.
 */

import { statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import type bundledTs from "typescript";

import {
  parseSourceFile,
  parsedSources,
  resolveTypeScript,
  type ParsedSource,
  type TypeScriptApi,
} from "../analysis/sourceFile.ts";
import type { Violation } from "../engine/models.ts";
import { suppressed } from "../util/suppress.ts";
import { guardedByThrow, secretFindings, type SecretFinding } from "./secretDefault/detect.ts";
import { hasUsableSuffix } from "./secretDefault/names.ts";

/** `Violation.code` for every finding this gate produces. */
export const SECRET_DEFAULT_CODE = "secret-default";

/** The one fix that actually restores loud failure. */
export const SECRET_DEFAULT_FIX_HINT =
  "read it with no fallback so startup fails loudly " +
  '(`process.env.X ?? throwIfMissing("X")`), or validate it non-empty at the boundary';

/** Extensions this gate reads when a caller narrows the scan to paths. */
const SCANNED_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".mts", ".cts"];

export interface SecretDefaultsOptions {
  /** Absolute or cwd-relative project root. */
  readonly root: string;
  /** `KraggPolicy.sourcePaths`. */
  readonly sourcePaths: readonly string[];
  /** `KraggPolicy.secretNameSuffixes`. */
  readonly secretNameSuffixes: readonly string[];
  /**
   * Restrict the scan to these files — the `--changed` path. Paths may be
   * absolute or root-relative; anything outside `sourcePaths`, and anything
   * without a scanned extension, is dropped. Omit to walk `sourcePaths`.
   */
  readonly paths?: readonly string[] | undefined;
  /** Compiler to parse with. Defaults to `resolveTypeScript(root).api`. */
  readonly api?: TypeScriptApi | undefined;
}

/**
 * Either the findings, or the reason the gate could not run.
 *
 * Same shape as `ForbiddenCallsOutcome`, for the same reason: "I could not
 * run" has to reach the caller as `error: true` and exit 3, never as a green
 * gate. A security gate that silently checked nothing is the worst outcome
 * available to it.
 */
export type SecretDefaultsOutcome =
  | { readonly ok: true; readonly violations: readonly Violation[] }
  | { readonly ok: false; readonly message: string };

/**
 * Report one violation per secret-named binding given a silent fallback.
 *
 * FAILS CLOSED in two configuration cases, both of which would otherwise pass
 * green while checking nothing:
 *
 *  - no configured suffix can ever match (an empty or all-blank
 *    `secret_name_suffixes`);
 *  - a whole-project scan whose `source_paths` contain no existing directory.
 *    A narrowed (`paths`) scan is exempt: "no changed source files" is a
 *    legitimately empty run.
 *
 * Violations are ordered by file, then line, then column, so two runs over an
 * unchanged tree diff cleanly.
 */
export function checkSecretDefaults(options: SecretDefaultsOptions): SecretDefaultsOutcome {
  const suffixes = options.secretNameSuffixes;
  if (!hasUsableSuffix(suffixes)) {
    return {
      ok: false,
      message:
        "secret_name_suffixes is empty, so secret-default cannot match anything. " +
        "Remove the override to restore the defaults, or list the suffixes this " +
        "project uses.",
    };
  }
  const root = resolve(options.root);
  if (options.paths === undefined) {
    const missing = missingSourcePaths(root, options.sourcePaths);
    if (missing !== null) {
      return { ok: false, message: missing };
    }
  }
  const api = options.api ?? resolveTypeScript(root).api;
  const violations: Violation[] = [];
  for (const source of sourcesToScan(root, api, options)) {
    violations.push(...scanSource(source, suffixes, api));
  }
  return { ok: true, violations };
}

/**
 * The reason a whole-project scan would read zero files, or `null`.
 *
 * `parsedSources` skips a non-existent source path silently, matching Python.
 * That is right for a policy listing `src` and `lib` in a repo that has only
 * `src` — but if NONE of them exist the gate is misconfigured, and saying so
 * is the only honest result.
 */
function missingSourcePaths(root: string, sourcePaths: readonly string[]): string | null {
  if (sourcePaths.length === 0) {
    return "source_paths is empty, so secret-default has nothing to scan.";
  }
  const found = sourcePaths.some((path) => {
    try {
      return statSync(resolve(root, path)).isDirectory();
    } catch {
      return false;
    }
  });
  if (found) {
    return null;
  }
  return (
    `none of the configured source_paths exist under ${root} ` +
    `(${sourcePaths.join(", ")}), so secret-default scanned no files`
  );
}

/** Files to scan: the narrowed set when given, the full walk otherwise. */
function sourcesToScan(
  root: string,
  api: TypeScriptApi,
  options: SecretDefaultsOptions,
): Iterable<ParsedSource> {
  if (options.paths === undefined) {
    return parsedSources(root, options.sourcePaths, { api });
  }
  const roots = options.sourcePaths.map((path) => resolve(root, path));
  const found: ParsedSource[] = [];
  const seen = new Set<string>();
  for (const path of options.paths) {
    const absolute = resolve(root, path);
    if (seen.has(absolute) || !isScannable(absolute, roots)) {
      continue;
    }
    seen.add(absolute);
    const parsed = parseSourceFile(absolute, root, api);
    if (parsed !== null) {
      found.push(parsed);
    }
  }
  return found;
}

/** Under a source path, a scanned extension, and not a declaration file. */
function isScannable(absolute: string, roots: readonly string[]): boolean {
  if (/\.d\.[cm]?ts$/.test(absolute)) {
    return false;
  }
  if (!SCANNED_EXTENSIONS.some((extension) => absolute.endsWith(extension))) {
    return false;
  }
  return roots.some((base) => {
    const rel = relative(base, absolute);
    return rel !== "" && !rel.startsWith("..") && !rel.startsWith(`..${sep}`);
  });
}

function scanSource(
  source: ParsedSource,
  suffixes: readonly string[],
  api: TypeScriptApi,
): readonly Violation[] {
  const found: Violation[] = [];
  const visit = (node: bundledTs.Node): void => {
    for (const finding of secretFindings(node, api, suffixes)) {
      const violation = toViolation(finding, source, api);
      if (violation !== null) {
        found.push(violation);
      }
    }
    api.forEachChild(node, visit);
  };
  api.forEachChild(source.sourceFile, visit);
  return found.sort(
    (left, right) => (left.line ?? 0) - (right.line ?? 0) || (left.column ?? 0) - (right.column ?? 0),
  );
}

function toViolation(
  finding: SecretFinding,
  source: ParsedSource,
  api: TypeScriptApi,
): Violation | null {
  const empty = finding.fallback === "";
  if (finding.fromEnv && empty && guardedByThrow(finding.node, api)) {
    return null;
  }
  const file = source.sourceFile;
  const start = file.getLineAndCharacterOfPosition(finding.node.getStart(file));
  const end = file.getLineAndCharacterOfPosition(finding.node.getEnd());
  if (suppressed(source.lines, start.line + 1, end.line + 1)) {
    return null;
  }
  const problem = empty
    ? "silently defaults to empty"
    : `has a hardcoded fallback default (\`${truncate(finding.fallback)}\`)`;
  return {
    message: `secret \`${finding.name}\` ${problem}`,
    file: source.relative,
    line: start.line + 1,
    column: start.character + 1,
    code: SECRET_DEFAULT_CODE,
    fixHint: SECRET_DEFAULT_FIX_HINT,
  };
}

/**
 * Shorten a fallback for the message.
 *
 * The value is echoed so a reviewer can see WHAT the secret falls back to,
 * but a long literal is truncated: it is a credential-shaped string, and
 * printing it whole into a log is the kind of accident this gate is supposed
 * to be on the right side of.
 */
function truncate(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 12)}…`;
}
