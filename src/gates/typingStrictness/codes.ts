/**
 * Violation codes for the `typing-strictness` gate, and which of them are
 * ADVISORY.
 *
 * They live in their own module so that the gate entry point and its two
 * scanners can all reach them without importing each other, and so that the
 * entry point spends exactly one symbol of its public-surface budget on the
 * whole vocabulary.
 *
 * NAMING. A code that maps onto a Python code keeps the Python spelling with
 * the tool name swapped (`mypy-config-missing` -> `tsconfig-missing`,
 * `mypy-not-strict` -> `tsconfig-not-strict`, `mypy-loosened` ->
 * `tsconfig-loosened`, `bare-type-ignore` -> `bare-ts-expect-error`). The rest
 * are new, because TypeScript has escape hatches mypy does not have.
 *
 * ADVISORY VS VIOLATION. `Violation` carries no severity field in either
 * sibling, so severity is expressed as a distinct CODE and a distinct bucket
 * on the outcome. An advisory is reported and never fails the gate. The
 * distinction is reserved for the three findings where a blanket failure would
 * be wrong more often than it would be right — see the gate's module doc.
 */

/** Every code this gate can emit, by a stable key. */
export const TYPING_STRICTNESS_CODES = {
  /** No `tsconfig.json` at the project root — nothing is type-checked. */
  tsconfigMissing: "tsconfig-missing",
  /** A `tsconfig.json` that cannot be parsed, or an `extends` that does not resolve. */
  tsconfigInvalid: "tsconfig-invalid",
  /** `strict` is not on, and the flags it implies are not all on either. */
  tsconfigNotStrict: "tsconfig-not-strict",
  /** A flag implied by `strict` is explicitly turned back off. */
  tsconfigLoosened: "tsconfig-loosened",
  /** A required flag above the `strict` baseline is absent or off. */
  tsconfigMissingFlag: "tsconfig-missing-flag",
  /** `allowJs` without `checkJs`: unchecked JavaScript in a strict project. */
  tsconfigUncheckedJs: "tsconfig-unchecked-js",
  /** ADVISORY. `allowJs` with `checkJs`: JavaScript is checked, but weakly. */
  tsconfigAllowJs: "tsconfig-allow-js",
  /** ADVISORY. `skipLibCheck` hides breakage inside dependency types. */
  tsconfigSkipLibCheck: "tsconfig-skip-lib-check",
  /** ADVISORY. A flag that is good practice but outside the typing floor. */
  tsconfigAdvisoryFlag: "tsconfig-advisory-flag",
  /** A source file no `tsconfig.json` `files`/`include` entry covers. */
  uncheckedSource: "unchecked-source",
  /** ADVISORY. Why the include/exclude audit did not run on this project. */
  uncheckedSourceUnaudited: "unchecked-source-unaudited",

  /** `@ts-ignore` — suppresses an error nobody named, and never expires. */
  tsIgnore: "ts-ignore",
  /** `@ts-expect-error` with no description. The analogue of a bare `# type: ignore`. */
  bareTsExpectError: "bare-ts-expect-error",
  /** `@ts-nocheck` — turns the type checker off for an entire file. */
  tsNocheck: "ts-nocheck",
  /** `x as any` / `<any>x` — an assertion straight through the type system. */
  asAny: "as-any",
  /** `x as unknown as T` — the double cast that launders any value into any type. */
  doubleCast: "double-cast",
  /** Explicit `any` in an exported signature: it escapes into every caller. */
  exportedAny: "exported-any",
  /** ADVISORY. Explicit `any` that stays inside the module. */
  internalAny: "internal-any",
  /** `Function` as a type: callable with anything, returns `any`. */
  unsafeFunctionType: "unsafe-function-type",
  /** ADVISORY. `object` as a type: any non-primitive, with no members. */
  weakObjectType: "weak-object-type",
  /** ADVISORY. `x!` and `let x!: T` — assertions the checker cannot verify. */
  nonNullAssertion: "non-null-assertion",
} as const;

/**
 * Codes that are REPORTED but must not fail the gate.
 *
 * A caller building a `GateResult` fails on the `violations` bucket and shows
 * `advisories` alongside it; this set exists so a caller that has already
 * flattened the two can still tell them apart.
 */
export const ADVISORY_CODES: ReadonlySet<string> = new Set<string>([
  TYPING_STRICTNESS_CODES.tsconfigAllowJs,
  TYPING_STRICTNESS_CODES.tsconfigSkipLibCheck,
  TYPING_STRICTNESS_CODES.tsconfigAdvisoryFlag,
  TYPING_STRICTNESS_CODES.uncheckedSourceUnaudited,
  TYPING_STRICTNESS_CODES.internalAny,
  TYPING_STRICTNESS_CODES.weakObjectType,
  TYPING_STRICTNESS_CODES.nonNullAssertion,
]);
