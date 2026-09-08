/**
 * The known-defect corpus: one real defect per metric gate, plus a clean
 * control that no metric gate may touch.
 *
 * NOT a test file (no `.test.ts` suffix), so `node --test "test/**\/*.test.ts"`
 * does not execute it — it is data, written to a temporary project by
 * `knownDefects.test.ts`.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM THE PER-GATE TESTS ─────────────────────
 * `complexity.test.ts`, `halstead.test.ts` and the rest pin the FORMULAS: that
 * `if` scores 1, that a `switch` scores 1, that `return a + b` has two
 * operators. None of them pin the THRESHOLDS, and thresholds are exactly what
 * a calibration exercise is tempted to move. Every number in this repository's
 * metric gates is radon's, ported onto a language it was not drawn against
 * (see `docs/calibration.md`), so "we lowered the bar until the samples went
 * green" is the specific failure this corpus exists to make impossible: each
 * fixture below is a defect a reasonable reviewer would want flagged, and the
 * test asserts it is STILL flagged at whatever thresholds are in force.
 *
 * If a future calibration change is right, it will not stop detecting these.
 * If it does stop, the test fails and the change has to argue for itself.
 *
 * ── EACH FIXTURE ISOLATES ONE GATE ─────────────────────────────────────────
 * A fixture that tripped four gates would keep passing its test for the wrong
 * reason after three of them were weakened. The measured numbers in each doc
 * comment below are from 2026-09-08 and say how much headroom the fixture has
 * on the gates it is NOT for.
 *
 * The values are dated because they are facts about a formula, not a contract:
 * a legitimate change to the operand partition moves them. What must not move
 * is which side of the line they fall on.
 */

/** One fixture file, and the finding it must keep producing. */
export interface KnownDefect {
  /** Gate that must flag it — matches the `check` pipeline's gate name. */
  readonly gate: string;
  /** Path inside the fixture project. */
  readonly path: string;
  /** The symbol a reader would point at, or `""` for a file-level finding. */
  readonly symbol: string;
  /** What was measured on 2026-09-08, and the budget it broke. */
  readonly measured: string;
  readonly source: string;
}

/**
 * A tsconfig strict enough for the type-aware gate to have real types, and
 * self-contained enough to build with no `node_modules` present.
 */
export const KNOWN_DEFECT_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "es2023",
    lib: ["es2023"],
    module: "preserve",
    moduleResolution: "bundler",
    allowImportingTsExtensions: true,
    noEmit: true,
    strict: true,
    types: [],
    skipLibCheck: true,
  },
  include: ["src/**/*.ts"],
});

/**
 * A genuinely complex function: seven branches, a loop, an early return and
 * four short-circuit operators, all interacting.
 *
 * MEASURED: cyclomatic 13, grade C (budget: worst grade B, i.e. score 10).
 * Nothing else is close — Halstead effort 6,904 against 50,000, difficulty
 * 13.5 against 30, bugs 0.17 against 0.4, file MI 50.0 grade A.
 *
 * Deliberately NOT a `switch`. kragg scores a `switch` as one decision point
 * (see `complexity/cyclomatic.ts`), so a dispatch table cannot fail this gate
 * and would be a fixture that tests the divergence rather than the threshold.
 */
const COMPLEX_FUNCTION = [
  "export function classifyShipment(",
  "  weightKg: number,",
  "  volumeM3: number,",
  "  destination: string,",
  "  express: boolean,",
  "  fragile: boolean,",
  "  insuredValue: number | null,",
  "): string {",
  "  if (weightKg <= 0 || volumeM3 <= 0) {",
  '    return "invalid";',
  "  }",
  "  const density = weightKg / volumeM3;",
  '  let tier = "standard";',
  "  if (density > 300) {",
  '    tier = "dense";',
  "  } else if (density > 120) {",
  '    tier = "medium";',
  "  } else if (density > 40) {",
  '    tier = "light";',
  "  } else {",
  '    tier = "bulky";',
  "  }",
  '  if (express && destination !== "domestic") {',
  "    tier = `${tier}-international-express`;",
  "  }",
  "  if (fragile) {",
  "    tier = `${tier}-handling`;",
  "  }",
  '  for (const restricted of ["KP", "IR", "SY"]) {',
  "    if (destination === restricted) {",
  '      return "embargoed";',
  "    }",
  "  }",
  "  if (insuredValue !== null && insuredValue > 25000) {",
  "    tier = `${tier}-declared`;",
  "  }",
  "  return tier;",
  "}",
].join("\n");

/**
 * Straight-line arithmetic over four parameters and three accumulators: no
 * branches at all, and hard to follow anyway. This is the failure Halstead
 * describes and cyclomatic complexity cannot see.
 *
 * MEASURED: effort 111,719 (budget 50,000), difficulty 82.7 (budget 30), bugs
 * 0.45 (budget 0.4) — all three ceilings, from one function. Cyclomatic
 * complexity is 1, grade A: the whole point.
 */
const HIGH_EFFORT_FUNCTION = [
  "export function mixColor(r: number, g: number, b: number, a: number): number {",
  "  let x = r * a + g * a + b * a;",
  "  let y = r * r + g * g + b * b;",
  "  let z = x * y - r * g + b * a;",
  "  x = x + y * z - r * a + g * b;",
  "  y = y * x + z * r - g * a + b * b;",
  "  z = z - x * y + r * b - g * a;",
  "  x = x * r + y * g + z * b - a;",
  "  y = y * r - x * g + z * b + a;",
  "  z = z * r + x * g - y * b + a;",
  "  x = x + r * g * b * a - y + z;",
  "  y = y - r * g + b * a * x - z;",
  "  z = z + r - g * b + a * x * y;",
  "  x = x * y * z + r + g - b * a;",
  "  y = y * z * x - r + g * b + a;",
  "  z = z * x * y + r * g - b + a;",
  "  x = x - y + z * r * g * b * a;",
  "  y = y + z - x * r * g * b * a;",
  "  z = z * x - y + r * g * b * a;",
  "  x = x * a + y * b + z * g + r;",
  "  y = y * a - x * b + z * g - r;",
  "  z = z * a + x * b - y * g + r;",
  "  x = x + r * a - g * b + z * y;",
  "  y = y - r * b + g * a - z * x;",
  "  z = z + r * g - b * a + x * y;",
  "  return x + y + z;",
  "}",
].join("\n");

/**
 * The number of near-identical blocks in the low-maintainability fixture.
 *
 * NOT AN ARBITRARY NUMBER, and the reason is itself a calibration finding.
 * The maintainability index is dominated by `-16.2*ln(lloc)` and rewards
 * comments through `+50*sin(sqrt(2.46*C))`, so in TypeScript a file only
 * leaves grade A when it is BOTH large and undocumented. Measured on this
 * exact block shape (six lines, comment-free) on 2026-09-08:
 *
 *     10 blocks →  60 lloc, MI 36.8 A
 *     20 blocks → 120 lloc, MI 26.4 A
 *     30 blocks → 180 lloc, MI 19.7 A   <- still passing
 *     40 blocks → 240 lloc, MI 14.6 B   <- the fixture
 *     60 blocks → 360 lloc, MI  6.6 C
 *
 * 40 is the first round count that fails, with about five points of margin.
 * Generating rather than transcribing 240 lines is deliberate: the defect
 * being modelled IS undifferentiated bulk, and a reader can verify the whole
 * file from the six lines below plus the count.
 */
const LOW_MAINTAINABILITY_BLOCKS = 40;

/**
 * A large, comment-free, repetitive module.
 *
 * MEASURED: MI 14.6, grade B (budget: grade A, i.e. MI above 19). Every
 * individual function inside it is trivial — cyclomatic 2, grade A, Halstead
 * effort in the hundreds — so no other gate fires. That is the honest shape of
 * a maintainability failure: nothing local is wrong, and the file is still
 * unmaintainable.
 */
const LOW_MAINTAINABILITY_FILE = Array.from(
  { length: LOW_MAINTAINABILITY_BLOCKS },
  (_unused, index) =>
    [
      `export function step${index}(a: number, b: number, c: number): number {`,
      `  let r = a * ${index + 2} + b - c;`,
      `  if (r > ${index * 7 + 3}) { r = r / 2 + b * c - a; }`,
      `  r = r + a * b - c / ${index + 3};`,
      "  return r;",
      "}",
    ].join("\n"),
).join("\n");

/**
 * Two over-budget annotations, one for each half of the gate's contract.
 *
 * MEASURED at the ported budgets (depth 2, length 40):
 *  - `rows`: depth 3, length 31 — over on DEPTH only;
 *  - `columns`: depth 1, length 48 — over on LENGTH only.
 *
 * The pair matters because the calibration measurements found length to be the
 * binding budget in TypeScript by an order of magnitude (`docs/calibration.md`).
 * A corpus with only length failures would go on passing if the depth budget
 * were quietly removed.
 */
const COMPLEX_TYPES = [
  "export function render(",
  "  rows: Map<string, Array<Set<number>>>,",
  "  columns: Record<string, string | number | boolean | null>,",
  "): number {",
  "  return rows.size + Object.keys(columns).length;",
  "}",
].join("\n");

/** Shared declarations for the nullable-default fixture. */
const NULLABLE_SHARED = [
  "export interface ServerConfig {",
  "  port?: number;",
  "  verbose?: boolean;",
  "}",
  "export declare const settings: ServerConfig;",
  "export declare const rawBody: string;",
].join("\n");

/**
 * Both nullable-default rules, one site each.
 *
 * `settings.port || 8080` is rule 1: `port` is `number | undefined`, so a
 * configured `0` is silently replaced by 8080. `payload.count + 1` is rule 2:
 * `JSON.parse` returns `any`, and a null field yields a wrong number rather
 * than an error.
 *
 * MEASURED: 2 violations. This gate has no numeric threshold to weaken — its
 * calibration lever is the RULES, and this fixture is what stops rule 1's
 * "truthy numeric literal fallback" or rule 2's provenance check from being
 * narrowed until the gate stops firing at all. It measured zero violations
 * across every real sample in `docs/calibration.md`, which is precisely why it
 * needs a fixture that proves it can still fire.
 */
const NULLABLE_DEFAULTS = [
  'import { settings, rawBody } from "./shared.ts";',
  "",
  "export const port = settings.port || 8080;",
  "",
  "export function totalItems(): number {",
  "  const payload = JSON.parse(rawBody);",
  "  return payload.count + 1;",
  "}",
].join("\n");

/**
 * The control: ordinary, well-typed, documented code.
 *
 * No metric gate may report anything here. Without it, a corpus of defects
 * proves only that the gates fire — not that they discriminate — and "flag
 * everything" would pass every other assertion in the suite.
 */
export const CLEAN_CONTROL_PATH = "src/clean.ts";

const CLEAN_CONTROL = [
  "/** Total a list of readings, ignoring the empty case. */",
  "export function summarize(values: readonly number[]): string {",
  "  if (values.length === 0) {",
  '    return "empty";',
  "  }",
  "  const total = values.reduce((sum, value) => sum + value, 0);",
  "  return `${values.length} values, total ${total}`;",
  "}",
  "",
  "/** The mean, or null when there is nothing to average. */",
  "export function mean(values: readonly number[]): number | null {",
  "  if (values.length === 0) {",
  "    return null;",
  "  }",
  "  return values.reduce((sum, value) => sum + value, 0) / values.length;",
  "}",
].join("\n");

/** Every fixture, in gate order. */
export const KNOWN_DEFECTS: readonly KnownDefect[] = [
  {
    gate: "complexity",
    path: "src/complexFunction.ts",
    symbol: "classifyShipment",
    measured: "cyclomatic 13, grade C (budget: grade B)",
    source: COMPLEX_FUNCTION,
  },
  {
    gate: "maintainability",
    path: "src/lowMaintainability.ts",
    symbol: "",
    measured: "MI 14.6, grade B (budget: grade A)",
    source: LOW_MAINTAINABILITY_FILE,
  },
  {
    gate: "halstead",
    path: "src/highEffort.ts",
    symbol: "mixColor",
    measured: "effort 111719, difficulty 82.7, bugs 0.45 (budgets 50000/30/0.4)",
    source: HIGH_EFFORT_FUNCTION,
  },
  {
    gate: "type-complexity",
    path: "src/complexTypes.ts",
    symbol: "render",
    measured: "depth 3 and length 48 (budgets 2/40)",
    source: COMPLEX_TYPES,
  },
  {
    gate: "nullable-default",
    path: "src/nullableDefaults.ts",
    symbol: "",
    measured: "2 sites: one `||` mis-coalesce, one untyped-payload arithmetic",
    source: NULLABLE_DEFAULTS,
  },
];

/** The whole fixture project: the defects, the control and their support. */
export const KNOWN_DEFECT_PROJECT: Readonly<Record<string, string>> = {
  "tsconfig.json": KNOWN_DEFECT_TSCONFIG,
  "src/shared.ts": NULLABLE_SHARED,
  [CLEAN_CONTROL_PATH]: CLEAN_CONTROL,
  ...Object.fromEntries(KNOWN_DEFECTS.map((defect) => [defect.path, defect.source])),
};
