/**
 * The tsconfig half of `typing-strictness`: is the type checker actually
 * configured to check anything?
 *
 * Python audits `[tool.mypy]` for `strict = true`, for core flags that have
 * been individually downgraded, and for `ignore_errors`. The TypeScript
 * equivalent is materially larger, because `tsconfig.json` has far more places
 * to hide a downgrade than mypy does — including, crucially, ANOTHER FILE.
 *
 * `extends` IS THE MAIN EVENT. A project can ship a root `tsconfig.json` that
 * looks immaculate and inherit `"strictNullChecks": false` from a shared base
 * three packages away. So the audit never reads the root file's
 * `compilerOptions` directly: it asks the compiler for the RESOLVED options
 * via `parseJsonConfigFileContent`, which walks the whole `extends` chain the
 * same way `tsc` does, including chains that resolve through `node_modules`
 * and TypeScript 5's `extends` arrays. What the audit judges is what the
 * compiler will actually use.
 *
 * FAIL CLOSED, TWICE OVER. A config that cannot be parsed, or an `extends`
 * that does not resolve, is reported as a VIOLATION rather than skipped: "we
 * could not verify the floor" must never render as "the floor is met". And
 * because the resolved options are the compiler's own, a chain this module
 * fails to follow can only cost provenance in a message, never correctness in
 * a verdict.
 *
 * PROVENANCE IS BEST EFFORT AND DECORATIVE. A second, independent walk of the
 * chain finds which file explicitly wrote an offending value, so a message can
 * say `(set in ./tsconfig.base.json)`. It annotates a finding only when its
 * own reading agrees with the compiler's resolved value; when the two
 * disagree, or the walk cannot resolve a link, the annotation is simply
 * dropped. It can never create, suppress or change a finding.
 *
 * ONE FILE, THE SELECTED ONE. The audit is over the tsconfig the caller
 * resolved — the policy's `tsconfig` — and every finding names that file by
 * its root-relative path, so `tsconfig.app.json` findings say so. A file that
 * only references other projects is refused before any flag is judged: see
 * the gate's module doc.
 *
 * TWO HALVES. This module judges the resolved `compilerOptions`; `included.ts`
 * judges whether the config's `files`/`include`/`exclude` actually reach the
 * policy's source paths. A strict config that type-checks none of the code is
 * the older and larger hole, and it is the reason the second half exists.
 */

import { readFileSync } from "node:fs";
import { dirname, relative } from "node:path";

import type ts from "typescript";

import { toPosix } from "../../analysis/modulePath.ts";
import { readProjectConfig } from "../../analysis/program.ts";
import type { TypeScriptApi } from "../../analysis/sourceFile.ts";
import type { Violation } from "../../engine/models.ts";
import { configChain, provenance, type ConfigFile } from "./chain.ts";
import { TYPING_STRICTNESS_CODES as CODE } from "./codes.ts";
import { auditIncludedSources } from "./included.ts";

/** Findings split by whether they fail the gate. */
export interface ConfigAudit {
  readonly violations: readonly Violation[];
  readonly advisories: readonly Violation[];
}

/** The audit, or the reason it could not be performed at all. */
export type ConfigOutcome =
  | { readonly ok: true; readonly audit: ConfigAudit }
  | { readonly ok: false; readonly message: string };

/**
 * Flags implied by `strict`. Each is audited two ways: all of them being
 * explicitly `true` is an alternative route to the floor (mirroring Python's
 * `_meets_floor`, which accepts the core flags in place of `strict = true`),
 * and any of them being explicitly `false` is a downgrade that re-opens the
 * hole even when `strict` is on.
 */
const IMPLIED_BY_STRICT: readonly string[] = [
  "strictNullChecks",
  "noImplicitAny",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
  "useUnknownInCatchVariables",
  "alwaysStrict",
];

/**
 * Also implied by `strict` (TypeScript 5.6+), and so also a downgrade when
 * switched off — but NOT required for the floor, because a project on an
 * older compiler cannot set it and the hole it covers is narrow.
 */
const LATE_STRICT_FLAG = "strictBuiltinIteratorReturn";

/** A flag the floor requires above `strict`, with the reason it is required. */
interface RequiredFlag {
  readonly name: string;
  readonly why: string;
  readonly fixHint: string;
}

const REQUIRED_FLAGS: readonly RequiredFlag[] = [
  {
    name: "noUncheckedIndexedAccess",
    why: "index and record reads are typed as if they always hit",
    fixHint:
      'set `"noUncheckedIndexedAccess": true`. Without it `process.env.X`, ' +
      "`arr[i]` and `Record<string, T>` lookups are typed `T` when they are " +
      "really `T | undefined` — the external-data-consumed-as-a-concrete-type " +
      "bug class kragg exists to catch. This is not a nitpick: it is the flag " +
      "that makes strict typing tell the truth about data from outside.",
  },
  {
    name: "exactOptionalPropertyTypes",
    why: "an optional property can be set to an explicit `undefined`",
    fixHint:
      'set `"exactOptionalPropertyTypes": true` so `{ a?: string }` cannot ' +
      "hold `undefined`; write `a?: string | undefined` where that is meant",
  },
];

/** A flag that is good practice but sits outside the typing floor. */
interface AdvisoryFlag {
  readonly name: string;
  readonly why: string;
  readonly fixHint: string;
}

/**
 * DELIBERATELY ADVISORY, NOT REQUIRED. Neither flag changes how strictly types
 * are checked; both change whether a SEPARATE tool can be trusted to reproduce
 * the check. `verbatimModuleSyntax` keeps emitted imports identical to the
 * source ones, and `isolatedModules` keeps every file transpilable on its own
 * — they matter enormously if the project builds with esbuild, swc or Node's
 * type stripping, and not at all if `tsc` is the only thing that ever reads
 * the code. Failing a `tsc`-only project over them would be the gate crying
 * wolf, so they are reported and never fatal.
 */
const ADVISORY_FLAGS: readonly AdvisoryFlag[] = [
  {
    name: "verbatimModuleSyntax",
    why: "emitted imports may not match the source imports",
    fixHint:
      'consider `"verbatimModuleSyntax": true` so type-only imports are ' +
      "written as `import type` and the emitted module graph matches the source",
  },
  {
    name: "isolatedModules",
    why: "a single-file transpiler may not reproduce what tsc checked",
    fixHint:
      'consider `"isolatedModules": true` if anything other than tsc ' +
      "(esbuild, swc, Node type stripping) compiles this project",
  },
];

/**
 * Audit the tsconfig at `tsconfigPath`, resolving its `extends` chain.
 *
 * TWO QUESTIONS, ONE READ OF THE FILE. The flag audit asks whether the
 * compiler is strict; `included.ts` asks whether the compiler ever LOOKS at
 * the policy's `sourcePaths` — a config that excludes a directory passes every
 * flag check while type-checking none of it. Both halves parse the same JSON,
 * so the second costs one glob rather than a second read.
 */
export function auditTsconfig(
  root: string,
  tsconfigPath: string,
  api: TypeScriptApi,
  sourcePaths: readonly string[],
): ConfigOutcome {
  const name = toPosix(relative(root, tsconfigPath));
  let text: string;
  try {
    text = readFileSync(tsconfigPath, "utf8");
  } catch (error: unknown) {
    if (!isMissingFile(error)) {
      // The file is there and unreadable. That is "the gate could not run",
      // which is a different thing from "the project has no config".
      return { ok: false, message: `could not read ${name}: ${describe(error)}` };
    }
    return {
      ok: true,
      audit: single({
        message: `no \`${name}\` (nothing is type-checked)`,
        file: name,
        code: CODE.tsconfigMissing,
        fixHint:
          `add a \`${name}\` with \`"strict": true\` and ` +
          '`"noUncheckedIndexedAccess": true` (see the kragg scaffold), or set ' +
          "`tsconfig` in kragg.json to the project file that exists",
      }),
    };
  }

  const options = resolveOptions(tsconfigPath, text, api, name);
  if (!options.ok) {
    return { ok: true, audit: single(options.violation) };
  }
  // The compiler's own resolution of the config, with a real `readDirectory`:
  // the shape that names no inputs of its own is refused HERE, before any flag
  // is judged, because its flags are not the ones that type-check anything.
  const inputs = readProjectConfig(api, tsconfigPath);
  if (!inputs.ok && inputs.kind === "solution") {
    return { ok: false, message: `${inputs.message}\nThe typing-strictness gate did not run.` };
  }
  const flags = judge(options.value, configChain(tsconfigPath, api), name);
  const included = auditIncludedSources(root, name, inputs, sourcePaths);
  return {
    ok: true,
    audit: {
      violations: [...flags.violations, ...included.violations],
      advisories: [...flags.advisories, ...included.advisories],
    },
  };
}

type OptionsResult =
  | { readonly ok: true; readonly value: ts.CompilerOptions }
  | { readonly ok: false; readonly violation: Violation };

/**
 * The compiler's own resolved options for this config.
 *
 * `readDirectory` is stubbed out because THIS call only wants the options, and
 * globbing a large repo to throw the result away is a cost with no payer. The
 * two diagnostics that stub provokes are filtered; everything else is a real
 * config error and fails closed. `readProjectConfig` does the parse with a
 * real `readDirectory` when — and only when — the file list is the question.
 */
function resolveOptions(
  path: string,
  text: string,
  api: TypeScriptApi,
  name: string,
): OptionsResult {
  const parsed = api.parseConfigFileTextToJson(path, text);
  if (parsed.error !== undefined) {
    return { ok: false, violation: invalid(diagnosticText(parsed.error, api), name) };
  }
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: api.sys.useCaseSensitiveFileNames,
    readDirectory: () => [],
    fileExists: (file: string) => api.sys.fileExists(file),
    readFile: (file: string) => api.sys.readFile(file),
  };
  const command = api.parseJsonConfigFileContent(
    parsed.config,
    host,
    dirname(path),
    undefined,
    path,
  );
  const errors = command.errors.filter(
    (diagnostic) => !EMPTY_INPUT_DIAGNOSTICS.has(diagnostic.code),
  );
  const first = errors[0];
  if (first !== undefined) {
    return { ok: false, violation: invalid(diagnosticText(first, api), name) };
  }
  return { ok: true, value: command.options };
}

/** "No inputs were found" / "The 'files' list is empty" — caused by our stub. */
const EMPTY_INPUT_DIAGNOSTICS: ReadonlySet<number> = new Set([18002, 18003]);

/** Apply the floor to one set of resolved options. */
function judge(
  options: ts.CompilerOptions,
  chain: readonly ConfigFile[],
  name: string,
): ConfigAudit {
  const violations: Violation[] = [];
  const advisories: Violation[] = [];
  const note = (flag: string, value: boolean): string => provenance(chain, flag, value);

  if (!meetsFloor(options)) {
    violations.push({
      message: `TypeScript is not strict (missing \`"strict": true\`)${note("strict", false)}`,
      file: name,
      code: CODE.tsconfigNotStrict,
      fixHint: 'set `"strict": true` in compilerOptions',
    });
  }
  for (const flag of [...IMPLIED_BY_STRICT, LATE_STRICT_FLAG]) {
    if (flagValue(options, flag) === false) {
      violations.push({
        message: `\`${flag}\` is disabled — re-opens the typing hole \`strict\` closes${note(flag, false)}`,
        file: name,
        code: CODE.tsconfigLoosened,
        fixHint: `remove \`"${flag}": false\`; keep the strict floor`,
      });
    }
  }
  for (const required of REQUIRED_FLAGS) {
    if (flagValue(options, required.name) !== true) {
      violations.push({
        message: `\`${required.name}\` is not enabled — ${required.why}`,
        file: name,
        code: CODE.tsconfigMissingFlag,
        fixHint: required.fixHint,
      });
    }
  }
  violations.push(...emitSafety(options, name));
  violations.push(...javaScript(options, advisories, note, name));
  advisories.push(...advisory(options, note, name));
  return { violations, advisories };
}

/**
 * `noEmitOnError`, required ONLY when this config emits.
 *
 * `tsc` writes output for code that failed the type check unless told not to,
 * so a build can ship JavaScript nobody type-checked — the check has no teeth
 * on the artifact. A `noEmit: true` config produces no artifact, so the flag
 * is meaningless there and demanding it would be noise.
 */
function emitSafety(options: ts.CompilerOptions, name: string): readonly Violation[] {
  if (options.noEmit === true || flagValue(options, "noEmitOnError") === true) {
    return [];
  }
  return [
    {
      message: "`noEmitOnError` is not enabled — tsc emits output for code that failed to typecheck",
      file: name,
      code: CODE.tsconfigMissingFlag,
      fixHint:
        'set `"noEmitOnError": true`, or `"noEmit": true` if this config only ' +
        "type-checks and something else builds",
    },
  ];
}

/** `allowJs` splits by whether the JavaScript it admits is checked at all. */
function javaScript(
  options: ts.CompilerOptions,
  advisories: Violation[],
  note: (flag: string, value: boolean) => string,
  name: string,
): readonly Violation[] {
  if (flagValue(options, "allowJs") !== true) {
    return [];
  }
  if (flagValue(options, "checkJs") === true) {
    advisories.push({
      message: `\`allowJs\` admits JavaScript; \`checkJs\` checks it, but more weakly than TypeScript${note("allowJs", true)}`,
      file: name,
      code: CODE.tsconfigAllowJs,
      fixHint: "prefer converting the remaining JavaScript; keep `checkJs` on until then",
    });
    return [];
  }
  return [
    {
      message: `\`allowJs\` without \`checkJs\` — JavaScript compiles into this project unchecked${note("allowJs", true)}`,
      file: name,
      code: CODE.tsconfigUncheckedJs,
      fixHint: 'set `"checkJs": true`, or drop `"allowJs"` and convert the JavaScript',
    },
  ];
}

/**
 * `skipLibCheck` and the two build-hygiene flags.
 *
 * `skipLibCheck` IS an escape hatch — it stops the compiler checking every
 * `.d.ts`, so a dependency whose types are internally broken, or two
 * dependencies whose types conflict, produce no error. It is also close to
 * universal in real projects, and for a defensible reason: on a large
 * dependency tree it is the difference between a fast typecheck and a slow
 * one, and most of what it hides is somebody else's bug that the project
 * cannot fix anyway. Failing every project that has it on would train people
 * to suppress this gate, which costs more than the flag does. So it is
 * reported under its own code, at advisory severity, and the project decides.
 */
function advisory(
  options: ts.CompilerOptions,
  note: (flag: string, value: boolean) => string,
  name: string,
): readonly Violation[] {
  const found: Violation[] = [];
  if (flagValue(options, "skipLibCheck") === true) {
    found.push({
      message: `\`skipLibCheck\` is on — breakage inside dependency type definitions is invisible${note("skipLibCheck", true)}`,
      file: name,
      code: CODE.tsconfigSkipLibCheck,
      fixHint:
        'weigh this one: `"skipLibCheck": false` checks dependency types and ' +
        "catches conflicting or broken `.d.ts` files, at the cost of a slower " +
        "typecheck and errors you may not be able to fix",
    });
  }
  for (const flag of ADVISORY_FLAGS) {
    if (flagValue(options, flag.name) !== true) {
      found.push({
        message: `\`${flag.name}\` is not enabled — ${flag.why}`,
        file: name,
        code: CODE.tsconfigAdvisoryFlag,
        fixHint: flag.fixHint,
      });
    }
  }
  return found;
}

/** Python's `_meets_floor`, flag for flag. */
function meetsFloor(options: ts.CompilerOptions): boolean {
  if (options.strict === true) {
    return true;
  }
  return IMPLIED_BY_STRICT.every((flag) => flagValue(options, flag) === true);
}

/**
 * A compiler option read as a tri-state boolean.
 *
 * `CompilerOptions` has an index signature whose value type includes maps and
 * a source file, so a dynamic read is narrowed here rather than asserted.
 * `undefined` means "not set", which is a different thing from `false`.
 */
function flagValue(options: ts.CompilerOptions, name: string): boolean | undefined {
  const value: unknown = options[name];
  return typeof value === "boolean" ? value : undefined;
}

function single(violation: Violation): ConfigAudit {
  return { violations: [violation], advisories: [] };
}

function invalid(detail: string, name: string): Violation {
  return {
    message: `\`${name}\` could not be resolved (${detail}) — the strict floor cannot be verified`,
    file: name,
    code: CODE.tsconfigInvalid,
    fixHint: "fix the config (or its `extends` target) so tsc can read it",
  };
}

function diagnosticText(diagnostic: ts.Diagnostic, api: TypeScriptApi): string {
  return api.flattenDiagnosticMessageText(diagnostic.messageText, " ");
}

function isMissingFile(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code: unknown = error.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
