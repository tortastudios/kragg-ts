/**
 * Two banned calls and one silently-defaulted secret, on purpose.
 *
 * The ban is on a FIRST-PARTY module rather than on a Node builtin for two
 * reasons. These fixture sources sit inside kragg-ts's own `tsconfig.json`
 * include list, so kragg's own `forbidden-calls` gate reads them too and
 * banning `node:child_process` here would make the fixture fail the
 * repository. And the fixture project deliberately has no `node_modules`, so
 * a builtin's declaration is unresolvable and the type-checker-backed gate
 * would — correctly — report nothing.
 *
 * The two `runShell` calls are what make `violation_count` larger than the
 * display list: the gate reports both, and the report collapses findings that
 * share a `(code, message)`. `max_violations_per_gate: 1` is deliberately
 * small so the golden pins `truncated` alongside it.
 */
import { runShell } from "./unsafe.ts";

export function listFiles(): string {
  return runShell("ls");
}

export function listBranches(): string {
  return runShell("git branch");
}

export function sign(payload: string, apiKey = ""): string {
  return `${payload}:${apiKey}`;
}
