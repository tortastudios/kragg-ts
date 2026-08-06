/**
 * Gate entry points: turn measured blocks into failures, violations and text.
 */

import {
  parsedSources,
  resolveTypeScript,
  type ParsedSource,
  type TypeScriptApi,
} from "../../analysis/sourceFile.ts";
import type { Violation } from "../../engine/models.ts";
import {
  MAX_BUGS,
  MAX_DIFFICULTY,
  MAX_EFFORT,
  type HalsteadFailure,
  type HalsteadOptions,
  type HalsteadThresholds,
} from "./metrics.ts";
import { fileHalstead } from "./walk.ts";

/**
 * Halstead failures for one already-parsed file.
 *
 * Only function blocks are checked, matching `check_file` in `halstead.py`,
 * which iterates `results.functions` and ignores the file total. A module of
 * simple functions cannot fail this gate no matter how long the module is —
 * that is the structure gate's job, not this one's.
 */
export function checkSource(
  source: ParsedSource,
  api: TypeScriptApi,
  thresholds: HalsteadThresholds = {},
): HalsteadFailure[] {
  const maxEffort = thresholds.maxEffort ?? MAX_EFFORT;
  const maxDifficulty = thresholds.maxDifficulty ?? MAX_DIFFICULTY;
  const maxBugs = thresholds.maxBugs ?? MAX_BUGS;

  const failures: HalsteadFailure[] = [];
  for (const block of fileHalstead(source.sourceFile, api).functions) {
    const location = `${source.relative}::${block.name}`;
    const metrics = block.metrics;
    if (metrics.effort > maxEffort) {
      failures.push({ location, metric: "effort", actual: metrics.effort, maximum: maxEffort, line: block.line });
    }
    if (metrics.difficulty > maxDifficulty) {
      failures.push({
        location,
        metric: "difficulty",
        actual: metrics.difficulty,
        maximum: maxDifficulty,
        line: block.line,
      });
    }
    if (metrics.bugs > maxBugs) {
      failures.push({
        location,
        metric: "estimated bugs",
        actual: metrics.bugs,
        maximum: maxBugs,
        line: block.line,
      });
    }
  }
  return failures;
}

/** Halstead failures across every source file under `sourcePaths`. */
export function halsteadFailures(
  root: string,
  sourcePaths: readonly string[],
  options: HalsteadOptions = {},
): HalsteadFailure[] {
  const api = options.api ?? resolveTypeScript(root).api;
  const failures: HalsteadFailure[] = [];
  for (const source of parsedSources(root, sourcePaths, { api })) {
    failures.push(...checkSource(source, api, options));
  }
  return failures;
}

/**
 * The gate's violations, in the exact shape `_halstead_gate` produces in
 * `catalog.py`: the message names the FUNCTION, the `file` field carries the
 * path, and the two are split back out of the `file::function` location.
 */
export function halsteadViolations(
  root: string,
  sourcePaths: readonly string[],
  options: HalsteadOptions = {},
): Violation[] {
  return halsteadFailures(root, sourcePaths, options).map(toViolation);
}

function toViolation(failure: HalsteadFailure): Violation {
  const separator = failure.location.indexOf("::");
  const file = separator === -1 ? failure.location : failure.location.slice(0, separator);
  const name = separator === -1 ? "" : failure.location.slice(separator + 2);
  return {
    message:
      `${name === "" ? file : name}: ${failure.metric} ` +
      `${failure.actual.toFixed(1)} exceeds max ${failure.maximum.toFixed(1)}`,
    file,
    line: failure.line,
    code: "halstead",
    fixHint: "reduce operators/operands; split the function",
  };
}

/** Format a failure for CLI output, matching `format_violation` in Python. */
export function formatHalsteadFailure(failure: HalsteadFailure): string {
  return (
    `  ${failure.location} - ${failure.metric} ` +
    `${failure.actual.toFixed(1)} exceeds max ${failure.maximum.toFixed(1)}`
  );
}
