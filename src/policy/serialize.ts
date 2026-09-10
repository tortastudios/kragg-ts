/**
 * `kragg policy show`, and the only place a policy becomes JSON.
 *
 * Split out of `policy.ts` for size. The key ORDER below is the contract —
 * see the function's own docstring — so nothing here may be reordered to suit
 * a reader.
 */

import type { KraggPolicy } from "./policy.ts";

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
    // name JavaScript tools, or a rule Python does not have), so they sort
    // AFTER every shared field. A conformance diff can therefore compare the
    // common prefix key-for-key.
    //
    // An OBJECT, not the pair list `forbidden_calls` serializes to: there is
    // no Python `asdict` to match here, and printing it in the shape it is
    // written in is what makes `policy show` answer "what did I declare".
    critical_functions: Object.fromEntries(policy.criticalFunctions),
    lint_tool: policy.lintTool,
    test_runner: policy.testRunner,
    secret_scanner: policy.secretScanner,
    secret_baseline: policy.secretBaseline ?? null,
    audit_severity: policy.auditSeverity,
    coverage_report_path: policy.coverageReportPath,
    test_command: [...policy.testCommand],
    baseline: policy.baseline ?? null,
    tsconfig: policy.tsconfig,
  };
}
