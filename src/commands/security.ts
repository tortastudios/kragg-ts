/**
 * `kragg security` — the security subset, on its own.
 *
 * Ported from `cmd_security`. Everything it runs is also in `check`; the point
 * of the shorter pipeline is COST. A security-only run is cheap enough to put
 * in a pre-push hook, and a gate nobody can afford to run is a gate that does
 * not protect anything.
 *
 * It does not accept `--changed`, matching Python: a credential committed
 * three commits ago is still committed, and a ban violated in a file this
 * branch did not touch is still a violation. Scoping a security scan to the
 * diff answers a question nobody asked.
 */

import { buildSecurityGates } from "../catalog.ts";
import { resolveProjectEnvironment } from "../environment/project.ts";
import { loadPolicy } from "../policy/policy.ts";
import { runPipeline, type ReportFlags } from "./check.ts";

/** Run the security pipeline and return the process exit code. */
export async function runSecurity(flags: ReportFlags): Promise<number> {
  const policy = loadPolicy(flags.root);
  const scoped = flags.targets.length > 0;
  const targets = scoped ? flags.targets : policy.sourcePaths;
  return runPipeline({
    command: "security",
    mode: scoped ? "file" : "full",
    policy,
    specs: buildSecurityGates({
      root: flags.root,
      policy,
      env: resolveProjectEnvironment(flags.root),
      targets,
      paths: scoped ? flags.targets : undefined,
      incremental: scoped,
    }),
    targets,
    flags,
  });
}
