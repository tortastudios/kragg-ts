/**
 * Recorded linter output, shared by `lintParsers.test.ts` and `lint.test.ts`.
 *
 * NOT a test file (no `.test.ts` suffix), so `node --test "test/**\/*.test.ts"`
 * does not execute it — it is data, imported by the suites that need it.
 *
 * PROVENANCE MATTERS MORE THAN COVERAGE HERE. kragg bundles no linter, so
 * these payloads cannot be produced by running one; a payload invented to
 * match the parser would prove only that the parser matches itself. Every
 * shape below is transcribed from the tool's own source or its own committed
 * snapshots, cited per fixture, and the full reasoning lives in each parser's
 * module header in `src/adapters/linters/`.
 */

/**
 * oxlint, clean run.
 *
 * The envelope is written unconditionally by `lint_command_info` in
 * `apps/oxlint/src/output_formatter/json.rs`, which is why its PRESENCE is
 * what separates "ran and found nothing" from "never ran".
 */
export const OXLINT_CLEAN = JSON.stringify({
  diagnostics: [],
  number_of_files: 3,
  number_of_rules: 92,
  threads_count: 8,
  start_time: 0.0123,
});

/**
 * oxlint, three diagnostics.
 *
 * Field set and nesting from `json.rs`'s own `#[test] fn reporter()`
 * assertion; the `line`/`column` members of `span` come from oxc's miette
 * FORK (`oxc-project/oxc-miette`, `src/handlers/json.rs`), which upstream
 * miette does not emit. The third entry is that fork's `"line": null,
 * "column": null` branch, taken when a label's span cannot be located.
 */
export const OXLINT_FOUND = JSON.stringify({
  diagnostics: [
    {
      message: "`debugger` statement is not allowed",
      code: "eslint(no-debugger)",
      severity: "error",
      causes: [],
      help: "Remove the debugger statement",
      filename: "src/a.ts",
      labels: [{ span: { offset: 42, length: 9, line: 3, column: 1 } }],
      related: [],
    },
    {
      message: "Variable 'x' is declared but never used.",
      code: "eslint(no-unused-vars)",
      severity: "warning",
      causes: [],
      filename: "src/b.ts",
      labels: [
        { label: "'x' is declared here", span: { offset: 10, length: 1, line: 1, column: 7 } },
      ],
      related: [],
    },
    {
      message: "Unexpected end of file",
      severity: "error",
      causes: [],
      filename: "src/c.ts",
      labels: [{ span: { offset: 0, length: 0, line: null, column: null } }],
      related: [],
    },
  ],
  number_of_files: 3,
  number_of_rules: 92,
  threads_count: 8,
  start_time: 0.04,
});

/** biome's `summary` object, key for key as its reporter emits it. */
export const BIOME_SUMMARY = {
  changed: 0,
  unchanged: 2,
  matches: 0,
  duration: "12ms",
  errors: 0,
  warnings: 2,
  infos: 0,
  skipped: 0,
  suggestedFixesSkipped: 0,
  diagnosticsNotPrinted: 0,
  scannerDuration: "1ms",
};

/** biome, clean run. */
export const BIOME_CLEAN = JSON.stringify({
  summary: { ...BIOME_SUMMARY, warnings: 0 },
  diagnostics: [],
  command: "check",
});

/**
 * biome, three diagnostics.
 *
 * The first two are verbatim from
 * `crates/biome_cli/tests/snapshots/main_cases_reporter_json/
 * reports_diagnostics_json_lint_command.snap` — including the columns, which
 * are what established that biome's line/column are 1-based rather than
 * assumed to be. The third is `to_json_report`'s `{line: 0, column: 0}`
 * fallback for a diagnostic with a file but no span.
 */
export const BIOME_FOUND = JSON.stringify({
  summary: { ...BIOME_SUMMARY, warnings: 3 },
  diagnostics: [
    {
      severity: "warning",
      message: "This import is unused.",
      category: "lint/correctness/noUnusedImports",
      location: {
        path: "index.ts",
        start: { line: 1, column: 8 },
        end: { line: 1, column: 12 },
      },
      advices: [{ start: { line: 1, column: 1 }, end: { line: 1, column: 21 }, text: "" }],
    },
    {
      severity: "warning",
      message: "This variable f is unused.",
      category: "lint/correctness/noUnusedVariables",
      location: {
        path: "index.ts",
        start: { line: 8, column: 5 },
        end: { line: 8, column: 6 },
      },
      advices: [],
    },
    {
      severity: "error",
      message: "File is too large.",
      category: "internal/io",
      location: { path: "huge.ts", start: { line: 0, column: 0 }, end: { line: 0, column: 0 } },
      advices: [],
    },
  ],
  command: "lint",
});

/** Repo root the absolute paths below are relative to. */
export const ROOT = "/repo";

/**
 * eslint, two files.
 *
 * `lib/cli-engine/formatters/json.js` is `JSON.stringify(results)` in its
 * entirety, so the wire format is exactly `ESLint.LintResult[]` from
 * `lib/types/index.d.ts` with `@eslint/core`'s `LintMessage` inside it. The
 * `suppressedMessages` entry is here to prove it is NOT re-reported.
 */
export const ESLINT_FOUND = JSON.stringify([
  {
    filePath: `${ROOT}/src/a.ts`,
    messages: [
      {
        ruleId: "no-unused-vars",
        severity: 2,
        message: "'x' is defined but never used.",
        line: 3,
        column: 7,
        endLine: 3,
        endColumn: 8,
        fix: { range: [10, 12], text: "" },
      },
      {
        ruleId: "prefer-const",
        severity: 1,
        message: "'y' is never reassigned. Use 'const' instead.",
        line: 4,
        column: 1,
        suggestions: [
          { desc: "Replace 'let' with 'const'", fix: { range: [20, 23], text: "const" } },
        ],
      },
    ],
    suppressedMessages: [
      { ruleId: "no-console", severity: 1, message: "suppressed", line: 9, column: 1 },
    ],
    errorCount: 1,
    fatalErrorCount: 0,
    warningCount: 1,
    fixableErrorCount: 1,
    fixableWarningCount: 0,
    usedDeprecatedRules: [],
  },
  {
    filePath: `${ROOT}/src/clean.ts`,
    messages: [],
    suppressedMessages: [],
    errorCount: 0,
    fatalErrorCount: 0,
    warningCount: 0,
    fixableErrorCount: 0,
    fixableWarningCount: 0,
    usedDeprecatedRules: [],
  },
]);

/**
 * eslint, a parse error.
 *
 * `ruleId: null` with `fatal: true`. ESLint counts it, keeps linting the other
 * files, and exits 1 — so it is a finding about the FILE, not a tool crash.
 */
export const ESLINT_FATAL_MESSAGE = JSON.stringify([
  {
    filePath: `${ROOT}/src/broken.ts`,
    messages: [
      {
        ruleId: null,
        fatal: true,
        severity: 2,
        message: "Parsing error: Unexpected token",
        line: 1,
        column: 5,
      },
    ],
    suppressedMessages: [],
    errorCount: 1,
    fatalErrorCount: 1,
    warningCount: 0,
    fixableErrorCount: 0,
    fixableWarningCount: 0,
    usedDeprecatedRules: [],
  },
]);
