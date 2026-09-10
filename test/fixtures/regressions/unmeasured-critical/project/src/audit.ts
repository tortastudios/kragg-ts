/**
 * The critical function the test run NEVER LOADS.
 *
 * Three call sites in `handlers.ts` give it a fan-in of 3, which is the
 * graph's own threshold, so it is critical. No test imports this module, so
 * the coverage report has no entry for it at all — and "no entry" used to
 * mean "no uncovered lines", which read as a pass.
 */

export function recordAudit(actor: string, action: string): string {
  if (actor === "") {
    return `anonymous:${action}`;
  }
  return `${actor}:${action}`;
}
