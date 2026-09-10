/**
 * This module lives under `src/coverage/` ON PURPOSE.
 *
 * The freshness walk used to skip any directory named `dist`, `build`, `out`
 * or `coverage` AT ANY DEPTH, so a project's own `src/coverage/` was invisible
 * to it and every edit under here left `.kragg/criticality.json` reading
 * `fresh`. Both this module and its callers are inside the directory, so the
 * regression case can edit the call graph without touching a single file the
 * buggy walk would have looked at.
 */

export function summarize(lines: readonly number[]): number {
  return lines.reduce((total, line) => total + line, 0);
}
