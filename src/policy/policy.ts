/**
 * Policy loading: `kragg.json`, then `package.json#kragg`, then defaults.
 *
 * Ported from `kragg/src/kragg/policy.py`, which reads `kragg.toml` and then
 * `pyproject.toml` `[tool.kragg]`. The precedence rule is the same: a
 * standalone config file wins OUTRIGHT — if `kragg.json` exists,
 * `package.json#kragg` is not consulted at all. There is exactly one source of
 * truth and no merge semantics for anyone to reason about.
 *
 * CONFIG IS DATA, NOT CODE. There is deliberately no `kragg.config.ts` and
 * there never will be. A config file that executes arbitrary TypeScript at
 * load time means the tool that is supposed to guard the project runs
 * untrusted code from that project before any gate has looked at it, and it
 * makes the effective policy non-reproducible — the same repo can resolve to
 * different rules depending on the environment. JSON only: parsing is
 * deterministic, total, and cannot call anything.
 *
 * KEYS ARE snake_case ON DISK, matching the Python implementation and
 * `docs/spec-conformance.md`, so a polyglot repo configures both siblings the
 * same way. Domain fields are camelCase in TypeScript; the translation
 * happens here.
 *
 * FAIL CLOSED. Every setting is in one of three states: ABSENT, and the
 * default applies; CONFIGURED, and the value is honoured exactly, including
 * deliberate opt-outs such as `[]`, `{}`, `0`, `null` and `"off"`; or
 * INVALID — wrong type, out of range, wrong shape, or a key kragg does not
 * know — and the whole load is rejected with a `PolicyError` naming the file
 * and the setting. An invalid value NEVER becomes a default. Degrading would
 * mean `forbidden_calls: ["node:child_process", 7]` reads as "no bans" and
 * `forbiden_calls` configures nothing, with the project reporting green
 * either way — the failure mode this module exists to prevent, where a
 * project believes it is protected and is not.
 *
 * DIVERGES from Python, which degrades a mismatched value to its default and
 * ignores unknown keys. Stricter in every case; documented in README.md and
 * `docs/spec-conformance.md`. `kragg.schema.json` at the package root mirrors
 * exactly these keys, types and ranges for editor validation, and a test
 * keeps the two in lockstep.
 *
 * THIS MODULE PARSES UNTRUSTED INPUT. Everything arrives as `unknown` and is
 * narrowed explicitly. No casts, no assertions, no trusting the shape.
 */

import { join } from "node:path";

import {
  getEnum,
  getInt,
  getOptionalString,
  getString,
  getStringList,
  getStringPairs,
  isTable,
  own,
  PolicyError,
  readTable,
  rejectUnknownKeys,
  type Source,
} from "./readers.ts";

/**
 * Raised when a config file exists but cannot be used.
 *
 * Declared alongside the throwing readers in `./readers.ts`, and re-exported
 * here because THIS is the module callers import. The CLI catches it and exits
 * with the usage code.
 */
export { PolicyError } from "./readers.ts";

/** One `[callExpression, whyItIsBannedAndWhatToUseInstead]` entry. */
export type ForbiddenCall = readonly [entry: string, fixHint: string];

/**
 * Tool-selection vocabularies.
 *
 * Declared HERE rather than imported from `adapters/`: these are the words a
 * project writes in `kragg.json`, so they belong to the config contract. The
 * catalog assigns each value straight into the adapter's own setting type, so
 * a divergence is a compile error at the wiring point rather than a config key
 * that silently stops working. Each carries `"auto"` (detect) and `"off"` (a
 * deliberate, VISIBLE disable) because those are different intentions.
 *
 * `AuditSeverity` omits the auditor's own `"info"`: offering it as a floor
 * invites a project to configure a gate that can never be green.
 */
export type LintToolSetting = "auto" | "oxlint" | "biome" | "eslint" | "off";
export type TestRunnerSetting = "auto" | "vitest" | "node" | "bun" | "off";
export type SecretScannerSetting = "auto" | "gitleaks" | "secretlint" | "off";
export type AuditSeverity = "low" | "moderate" | "high" | "critical";

const LINT_TOOLS: readonly LintToolSetting[] = ["auto", "oxlint", "biome", "eslint", "off"];
const TEST_RUNNERS: readonly TestRunnerSetting[] = ["auto", "vitest", "node", "bun", "off"];
const SCANNERS: readonly SecretScannerSetting[] = ["auto", "gitleaks", "secretlint", "off"];
const SEVERITIES: readonly AuditSeverity[] = ["low", "moderate", "high", "critical"];

/** Configuration for the active guardrails policy pack. */
export interface KraggPolicy {
  /** Name of the policy pack, reported in `kragg status`. */
  readonly profile: string;
  /** Directories holding first-party source, relative to the project root. */
  readonly sourcePaths: readonly string[];
  /** Directories holding tests, relative to the project root. */
  readonly testPaths: readonly string[];
  /**
   * The tsconfig every type-aware surface reads, relative to the project
   * root: the shared `ts.Program`, the `tsc` gate's `--project`, the
   * `typing-strictness` audit, the `boundaries` alias table and the
   * criticality freshness stamp. ONE setting, so they cannot disagree about
   * which file configures the project. A solution-style file (`references`
   * and no inputs of its own) is refused by every one of them — see
   * `analysis/program.ts` — and the fix is to name a concrete project here.
   */
  readonly tsconfig: string;
  /** Line-coverage percentage below which the coverage gate fails. */
  readonly coverageFailUnder: number;
  /** How deeply a type may nest before the type-complexity gate complains. */
  readonly typeMaxNestingDepth: number;
  /** Maximum rendered length of a single type before it must be named. */
  readonly typeMaxLength: number;
  /** Cap on violations reported per gate, so output stays actionable. */
  readonly maxViolationsPerGate: number;
  /** Architectural layers, outermost first, for the boundaries gate. */
  readonly layers: readonly string[];
  /** Maximum lines in one source file before the structure gate fails. */
  readonly maxFileLines: number;
  /** Maximum exported symbols in one module before the structure gate fails. */
  readonly maxPublicSymbols: number;
  /** Glob patterns exempt from the structure budgets (see `util/globs.ts`). */
  readonly structureExclude: readonly string[];
  /** Glob patterns scoping mutation testing in. Empty means "everything". */
  readonly mutationInclude: readonly string[];
  /** Glob patterns scoping mutation testing out. */
  readonly mutationExclude: readonly string[];
  /** Banned call targets, each with the hint that says what to use instead. */
  readonly forbiddenCalls: readonly ForbiddenCall[];
  /**
   * Identifier suffixes that mark a binding as holding a secret. A secret
   * given a fallback default never fails loudly — it runs unconfigured and
   * signs with an empty key — so the secret-default gate flags the idiom.
   */
  readonly secretNameSuffixes: readonly string[];
  /** Which linter the lint gate drives. `"auto"` detects; `"off"` skips. */
  readonly lintTool: LintToolSetting;
  /** Which test runner the coverage gate drives. */
  readonly testRunner: TestRunnerSetting;
  /** Which secret scanner the `detect-secrets` gate drives. */
  readonly secretScanner: SecretScannerSetting;
  /**
   * Reviewed-findings baseline for the scanner, root-relative; `undefined`
   * means none. The two scanners' formats are NOT interchangeable.
   */
  readonly secretBaseline: string | undefined;
  /** Advisories below this severity are counted but not reported. */
  readonly auditSeverity: AuditSeverity;
  /** Where the test runner writes its istanbul JSON, relative to the root. */
  readonly coverageReportPath: string;
}

/**
 * Baseline policy. Every value matches `KraggPolicy` in `policy.py` except
 * where a JavaScript-ecosystem difference makes the Python value meaningless;
 * each of those is called out inline. Nothing here is tuned for convenience —
 * the defaults are the strict ones, and a project loosens them explicitly.
 */
export const DEFAULT_POLICY: KraggPolicy = {
  /**
   * DIVERGES from Python's `"strict-ai-python"`: the pack is language-
   * specific (tsc and a JS test runner, not mypy and pytest), so it carries a
   * language-specific name. Reporting `strict-ai-python` from the TypeScript
   * tool would be actively misleading in a polyglot repo running both.
   */
  profile: "strict-ai-typescript",
  sourcePaths: ["src"],
  /**
   * DIVERGES from Python's `("tests",)`: the JavaScript ecosystem is split
   * roughly evenly between `test/` and `tests/`, with no equivalent of the
   * pytest convention that settled it for Python. Defaulting to only one
   * silently checks nothing in half of all projects — the fail-open case.
   * Both are listed; a path that does not exist is simply not scanned.
   */
  testPaths: ["test", "tests"],
  /** `tsc -p`'s own default. TypeScript-only: Python has no equivalent knob. */
  tsconfig: "tsconfig.json",
  coverageFailUnder: 80,
  typeMaxNestingDepth: 2,
  typeMaxLength: 40,
  maxViolationsPerGate: 25,
  layers: [],
  maxFileLines: 500,
  maxPublicSymbols: 20,
  structureExclude: [],
  mutationInclude: [],
  mutationExclude: [],
  forbiddenCalls: [],
  /**
   * DIVERGES from Python's `("_secret", "_token", ...)` in CASING ONLY: the
   * suffixes exist to match the tail of an identifier, and JavaScript
   * identifiers are camelCase, so `hmacSecret` needs `Secret` where Python's
   * `hmac_secret` needs `_secret`. The set of concepts is identical, entry for
   * entry, and the gate is expected to match a bare lowercase form too
   * (`secret` matches as well as `hmacSecret`).
   *
   * Bare `Key` is deliberately EXCLUDED, preserving the Python original's
   * reasoning: `sortKey` and `cacheKey` are not secrets, and flagging them
   * would train everyone to suppress the gate. Only the qualified key
   * suffixes below are treated as secret-bearing.
   *
   * `ServiceKey` DIVERGES from the Python default list, which has no analogue.
   * Measurement on a production repo found `process.env.DASHBOARD_SERVICE_KEY
   * || ""` three times, every one unreported, purely because no suffix
   * matched. A service key is a credential by every definition the rest of
   * this list uses, and it is qualified enough to avoid the `sortKey` false
   * positives bare `Key` would cause. Port it back, do not drop it.
   */
  secretNameSuffixes: [
    "Secret",
    "Token",
    "Password",
    "Passphrase",
    "ApiKey",
    "SigningKey",
    "SecretKey",
    "PrivateKey",
    "AccessKey",
    "ServiceKey",
  ],
  lintTool: "auto",
  testRunner: "auto",
  secretScanner: "auto",
  secretBaseline: undefined,
  auditSeverity: "high",
  coverageReportPath: "coverage/coverage-final.json",
};


/**
 * Keys allowed in a config table that are not settings. `$schema` points an
 * editor at `kragg.schema.json`; it configures nothing and is not an error.
 */
const NON_SETTING_KEYS: readonly string[] = ["$schema"];

/**
 * Load policy from `kragg.json`, then `package.json#kragg`, then defaults.
 *
 * Unknown keys are checked LAST, once every reader has recorded the key it
 * consumed, so the set of accepted keys is exactly the set of keys read —
 * there is no second list to drift from the readers.
 */
export function loadPolicy(root: string): KraggPolicy {
  const source = loadSource(root);
  const policy: KraggPolicy = {
    ...readScopes(source),
    ...readBudgets(source),
    ...readRules(source),
    ...readTools(source),
  };
  rejectUnknownKeys(source, NON_SETTING_KEYS);
  return policy;
}

/** The settings naming WHERE kragg looks: paths, layers and glob scopes. */
type PolicyScopes = Pick<
  KraggPolicy,
  | "profile"
  | "sourcePaths"
  | "testPaths"
  | "tsconfig"
  | "layers"
  | "structureExclude"
  | "mutationInclude"
  | "mutationExclude"
  | "coverageReportPath"
>;

/** The numeric thresholds a gate compares a measurement against. */
type PolicyBudgets = Pick<
  KraggPolicy,
  | "coverageFailUnder"
  | "typeMaxNestingDepth"
  | "typeMaxLength"
  | "maxViolationsPerGate"
  | "maxFileLines"
  | "maxPublicSymbols"
>;

/** The settings that enumerate what a gate looks FOR. */
type PolicyRules = Pick<KraggPolicy, "forbiddenCalls" | "secretNameSuffixes" | "secretBaseline">;

/** Which external tool each gate drives, and how strict it is. */
type PolicyTools = Pick<
  KraggPolicy,
  "lintTool" | "testRunner" | "secretScanner" | "auditSeverity"
>;

function readScopes(source: Source): PolicyScopes {
  const base = DEFAULT_POLICY;
  return {
    profile: getString(source, "profile", base.profile),
    sourcePaths: getStringList(source, "source_paths", base.sourcePaths),
    testPaths: getStringList(source, "test_paths", base.testPaths),
    tsconfig: getPath(source, "tsconfig", base.tsconfig),
    layers: getStringList(source, "layers", base.layers),
    structureExclude: getStringList(source, "structure_exclude", base.structureExclude),
    mutationInclude: getStringList(source, "mutation_include", base.mutationInclude),
    mutationExclude: getStringList(source, "mutation_exclude", base.mutationExclude),
    coverageReportPath: getString(source, "coverage_report_path", base.coverageReportPath),
  };
}

/**
 * Every budget is a count or a percentage, so a negative value is invalid
 * and `0` is a legitimate configured value: `coverage_fail_under: 0` and
 * `max_violations_per_gate: 0` are the documented opt-outs ("do not ask for
 * coverage", "no cap"), and a zero depth or length is simply the strictest
 * setting. A percentage above 100 can never be met and is rejected too.
 * These ranges are mirrored in `kragg.schema.json`.
 */
const COUNT = { min: 0 } as const;
const PERCENT = { min: 0, max: 100 } as const;

function readBudgets(source: Source): PolicyBudgets {
  const base = DEFAULT_POLICY;
  return {
    coverageFailUnder: getInt(source, "coverage_fail_under", base.coverageFailUnder, PERCENT),
    typeMaxNestingDepth: getInt(source, "type_max_nesting_depth", base.typeMaxNestingDepth, COUNT),
    typeMaxLength: getInt(source, "type_max_length", base.typeMaxLength, COUNT),
    maxViolationsPerGate: getInt(source, "max_violations_per_gate", base.maxViolationsPerGate, COUNT),
    maxFileLines: getInt(source, "max_file_lines", base.maxFileLines, COUNT),
    maxPublicSymbols: getInt(source, "max_public_symbols", base.maxPublicSymbols, COUNT),
  };
}

/**
 * The enforced restrictions.
 *
 * `getStringPairs` is the fail-closed reader: a configured ban is never
 * dropped, and a malformed hint is rejected by name rather than repaired.
 * See its own doc.
 */
function readRules(source: Source): PolicyRules {
  const base = DEFAULT_POLICY;
  return {
    forbiddenCalls: getStringPairs(source, "forbidden_calls", base.forbiddenCalls),
    secretNameSuffixes: getStringList(source, "secret_name_suffixes", base.secretNameSuffixes),
    secretBaseline: getOptionalString(source, "secret_baseline", base.secretBaseline),
  };
}

function readTools(source: Source): PolicyTools {
  const base = DEFAULT_POLICY;
  return {
    lintTool: getEnum(source, "lint_tool", LINT_TOOLS, base.lintTool),
    testRunner: getEnum(source, "test_runner", TEST_RUNNERS, base.testRunner),
    secretScanner: getEnum(source, "secret_scanner", SCANNERS, base.secretScanner),
    auditSeverity: getEnum(source, "audit_severity", SEVERITIES, base.auditSeverity),
  };
}

/**
 * Serialize a policy for `kragg policy show`.
 *
 * The Python analogue is `KraggPolicy.as_dict()`. Keys are snake_case and the
 * order matches the Python dataclass field order, so the two implementations
 * produce byte-identical JSON for an identical policy and a conformance test
 * can diff them directly. Pairs serialize as two-element arrays, which is
 * what `dataclasses.asdict` yields for a tuple of tuples.
 *
 * Arrays are copied rather than aliased so a caller cannot mutate the frozen
 * `DEFAULT_POLICY` through the returned object.
 */
export function policyAsDict(policy: KraggPolicy): Record<string, unknown> {
  return {
    profile: policy.profile,
    source_paths: [...policy.sourcePaths],
    test_paths: [...policy.testPaths],
    coverage_fail_under: policy.coverageFailUnder,
    type_max_nesting_depth: policy.typeMaxNestingDepth,
    type_max_length: policy.typeMaxLength,
    max_violations_per_gate: policy.maxViolationsPerGate,
    layers: [...policy.layers],
    max_file_lines: policy.maxFileLines,
    max_public_symbols: policy.maxPublicSymbols,
    structure_exclude: [...policy.structureExclude],
    mutation_include: [...policy.mutationInclude],
    mutation_exclude: [...policy.mutationExclude],
    forbidden_calls: policy.forbiddenCalls.map(([entry, hint]) => [entry, hint]),
    secret_name_suffixes: [...policy.secretNameSuffixes],
    // TypeScript-only tail: these settings have no Python counterpart (they
    // name JavaScript tools), so they sort AFTER every shared field. A
    // conformance diff can therefore compare the common prefix key-for-key.
    lint_tool: policy.lintTool,
    test_runner: policy.testRunner,
    secret_scanner: policy.secretScanner,
    secret_baseline: policy.secretBaseline ?? null,
    audit_severity: policy.auditSeverity,
    coverage_report_path: policy.coverageReportPath,
    tsconfig: policy.tsconfig,
  };
}

/**
 * A path setting: a string, and a non-empty one.
 *
 * `""` resolves to the root directory itself, so `tsconfig: ""` would send
 * every type-aware surface to open a directory and report a confusing
 * failure about it. Rejected by name instead, like every other malformed
 * value; the schema mirrors the `minLength`.
 */
function getPath(source: Source, key: string, fallback: string): string {
  const value = getString(source, key, fallback);
  if (value === "") {
    throw new PolicyError(`${source.label}${key} must be a non-empty path (got "")`);
  }
  return value;
}

/**
 * Whether `root` carries a policy of its own — a `kragg.json`, or a
 * `package.json` with a `kragg` key.
 *
 * For a workspace member under `--package`: a member that declares nothing
 * inherits the ROOT's policy rather than the defaults, because the root's
 * `kragg.json` is where a workspace writes its rules once. A member that
 * declares anything at all is on its own, exactly as `loadPolicy` treats a
 * standalone project — there is no merge, and a malformed member policy is
 * still a `PolicyError` here.
 */
export function declaresPolicy(root: string): boolean {
  if (readTable(join(root, "kragg.json")) !== null) {
    return true;
  }
  const pkg = readTable(join(root, "package.json"));
  return pkg !== null && own(pkg, "kragg") !== undefined;
}

/**
 * Read the raw config table and where it came from; an empty table when the
 * project configures nothing.
 *
 * A `package.json#kragg` that is present but not an object is REJECTED, not
 * read as "unconfigured" (which is what Python's `isinstance(kragg, dict)`
 * guard does): the project wrote a policy block, and running the defaults in
 * its place would be the silent fall-back this module refuses everywhere
 * else. A `kragg.json` that is not an object is already rejected by
 * `readTable`.
 */
function loadSource(root: string): Source {
  const standalonePath = join(root, "kragg.json");
  const standalone = readTable(standalonePath);
  if (standalone !== null) {
    return { table: standalone, label: `${standalonePath}#`, consumed: new Set() };
  }
  const pkgPath = join(root, "package.json");
  const pkg = readTable(pkgPath);
  const label = `${pkgPath}#kragg.`;
  if (pkg === null) {
    return { table: {}, label, consumed: new Set() };
  }
  const kragg = own(pkg, "kragg");
  if (kragg === undefined) {
    return { table: {}, label, consumed: new Set() };
  }
  if (!isTable(kragg)) {
    throw new PolicyError(
      `${pkgPath}#kragg must be a JSON object of kragg settings (got ${JSON.stringify(kragg)})`,
    );
  }
  return { table: kragg, label, consumed: new Set() };
}
