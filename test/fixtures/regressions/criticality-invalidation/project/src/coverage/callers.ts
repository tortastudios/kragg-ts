/** Three callers, so `summarize` reaches the fan-in threshold and is critical. */

import { summarize } from "./report.ts";

export function totalStatements(lines: readonly number[]): number {
  return summarize(lines);
}

export function totalBranches(lines: readonly number[]): number {
  return summarize(lines) * 2;
}

export function totalFunctions(lines: readonly number[]): number {
  return summarize(lines) + 1;
}
