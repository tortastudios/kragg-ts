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

import {
  getArgv,
  getCriticalDeclarations,
  getEnum,
  getInt,
  getOptionalString,
  getPath,
  getString,
  getStringList,
  getStringPairs,
  PolicyError,
  rejectUnknownKeys,
  type Source,
} from "./readers.ts";
import { loadSource } from "./source.ts";

/**
 * Raised when a config file exists but cannot be used.
 *
 * Declared alongside the throwing readers in `./readers.ts`, and re-exported
 * here because THIS is the module callers import. The CLI catches it and exits
 * with the usage code.
 */
export { PolicyError } from "./readers.ts";

/**
 * The "did you mean" helper, re-exported for the one consumer outside this
 * directory: `gates/criticality/declared.ts`, which asks the same question of
 * a `critical_functions` entry that names no function in the program.
 */
export { nearestName } from "./names.ts";

/**
 * Serialize a policy for `kragg policy show`. Lives in `serialize.ts`; kept on
 * this module's surface because the policy is what a caller has in hand.
 */
export { policyAsDict } from "./serialize.ts";

/**
 * Whether a project declares a policy of its own — see `./source.ts`.
 *
 * Re-exported because `policy.ts` is the module callers import; a workspace
 * member run asks this before deciding to inherit the root's rules.
 */
export { declaresPolicy } from "./source.ts";

/** One `[callExpression, whyItIsBannedAndWhatToUseInstead]` entry. */
export type ForbiddenCall = readonly [entry: string, fixHint: string];

/**
 * One reviewed critical-function declaration:
 * `["<module>#<qualified.name>", "why it is critical"]`.
 *
 * The name is the same `module#name` the call graph and
 * `.kragg/criticality.json` use. The reason is REQUIRED and is shown wherever
 * the function is named — the report, the table and the violation messages —
 * because a manual override that cannot be explained is one nobody can review.
 */
export type CriticalDeclaration = readonly [name: string, reason: string];

/** Every reviewed declaration a project made, sorted by name. */
export type CriticalDeclarations = readonly CriticalDeclaration[];

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
   * Functions a REVIEWER declared critical, each with the reason.
   *
   * Additive to the call-graph selection and never subtractive: a declaration
   * makes a function critical, and nothing here can make an automatically
   * critical function stop being one. It exists for the consequential
   * function the graph cannot see — an authorization or payment entrypoint
   * with one caller has low fan-in and no betweenness, and is exactly where a
   * missing test costs the most.
   */
  readonly criticalFunctions: CriticalDeclarations;
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
  /**
   * The exact argv that runs this project's suite, WITHOUT file patterns —
   * `["node", "--import", "tsx", "--test"]`. Empty (the default) means kragg
   * infers the runner and builds the argv itself, which cannot carry a loader
   * or setup flag it was never told about. kragg appends its own reporter and
   * coverage flags and the `test_paths` patterns; element 0 is resolved like
   * every other tool (the project's `node_modules/.bin`, or `node` / `bun` as
   * runtimes) and is never looked up on `PATH`.
   */
  readonly testCommand: readonly string[];
  /** Which secret scanner the `detect-secrets` gate drives. */
  readonly secretScanner: SecretScannerSetting;
  /**
   * Reviewed-findings baseline for the scanner, root-relative; `undefined`
   * means none. The two scanners' formats are NOT interchangeable.
   */
  readonly secretBaseline: string | undefined;
  /**
   * Reviewed legacy-debt baseline, root-relative; `undefined` means none.
   * Written only by `kragg check --update-baseline`, read by every `check`.
   * See `policy/baseline.ts` for what may and may not be recorded in it.
   */
  readonly baseline: string | undefined;
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
   * NO PYTHON COUNTERPART, and empty by default: every critical function is
   * one the call graph found until a reviewer says otherwise. See
   * `docs/spec-conformance.md` for what an implementation that does not know
   * this key reads out of a sidecar written with one.
   */
  criticalFunctions: [],
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
  testCommand: [],
  secretScanner: "auto",
  secretBaseline: undefined,
  baseline: undefined,
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
  requireKnownRunner(source, policy);
  return policy;
}

/** Programs whose report format kragg recognises from the program name alone. */
const RUNNER_PROGRAMS: readonly string[] = ["vitest", "node", "bun"];

/**
 * A `test_command` kragg could run but could not READ is rejected at load.
 *
 * kragg does not just spawn the suite, it parses the suite's report, and the
 * three runners produce three unrelated formats. When `test_runner` is
 * `"auto"` the only evidence of which format to expect is the program name,
 * so a `test_command` starting with anything else — `tsx`, a wrapper script —
 * has to say so with `test_runner`. Rejecting here, at exit 2 before any gate
 * runs, rather than at gate time: the project can fix a config error it is
 * told about immediately, and there is no run for the mistake to hide in.
 */
function requireKnownRunner(source: Source, policy: KraggPolicy): void {
  const program = policy.testCommand[0];
  if (program === undefined || policy.testRunner !== "auto") {
    return;
  }
  const name = program.replaceAll("\\", "/").split("/").at(-1) ?? program;
  if (RUNNER_PROGRAMS.includes(name)) {
    return;
  }
  throw new PolicyError(
    `${source.label}test_command runs ${JSON.stringify(program)}, and kragg cannot tell ` +
      "which runner's report format that produces. Set `test_runner` to the runner it " +
      `drives (${RUNNER_PROGRAMS.join(", ")}), or start the command with one of them.`,
  );
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
type PolicyRules = Pick<
  KraggPolicy,
  "forbiddenCalls" | "criticalFunctions" | "secretNameSuffixes" | "secretBaseline" | "baseline"
>;

/** Which external tool each gate drives, and how strict it is. */
type PolicyTools = Pick<
  KraggPolicy,
  "lintTool" | "testRunner" | "testCommand" | "secretScanner" | "auditSeverity"
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
    criticalFunctions: getCriticalDeclarations(
      source,
      "critical_functions",
      base.criticalFunctions,
    ),
    secretNameSuffixes: getStringList(source, "secret_name_suffixes", base.secretNameSuffixes),
    secretBaseline: getOptionalString(source, "secret_baseline", base.secretBaseline),
    baseline: getOptionalString(source, "baseline", base.baseline),
  };
}

function readTools(source: Source): PolicyTools {
  const base = DEFAULT_POLICY;
  return {
    lintTool: getEnum(source, "lint_tool", LINT_TOOLS, base.lintTool),
    testRunner: getEnum(source, "test_runner", TEST_RUNNERS, base.testRunner),
    testCommand: getArgv(source, "test_command", base.testCommand),
    secretScanner: getEnum(source, "secret_scanner", SCANNERS, base.secretScanner),
    auditSeverity: getEnum(source, "audit_severity", SEVERITIES, base.auditSeverity),
  };
}


