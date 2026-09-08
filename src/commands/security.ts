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
 *
 * `--file` it does accept, and it resolves that argument through the SAME
 * `resolveScope` `check` uses. It used to reimplement the two-line version
 * here, which is how one command came to reject `--file nope.ts` while the
 * other ran a green pipeline over it.
 */

import { buildSecurityGates } from "../catalog.ts";
import { resolveProjectEnvironment } from "../environment/project.ts";
import { loadPolicy } from "../policy/policy.ts";
import { runPipeline, type ReportFlags } from "./check.ts";
import { resolveScope } from "./scope.ts";

/** Run the security pipeline and return the process exit code. */
export async function runSecurity(flags: ReportFlags): Promise<number> {
  const policy = loadPolicy(flags.root);
  const resolved = await resolveScope(
    { root: flags.root, targets: flags.targets, changed: false, since: null },
    policy,
  );
  if (!resolved.ok) {
    process.stderr.write(`kragg: ${resolved.message}\n`);
    return resolved.exit;
  }
  const { scope } = resolved;
  return runPipeline({
    command: "security",
    mode: scope.mode,
    policy,
    specs: buildSecurityGates({
      root: flags.root,
      policy,
      env: resolveProjectEnvironment(flags.root),
      targets: scope.targets,
      paths: scope.paths,
      incremental: scope.mode !== "full",
    }),
    targets: scope.targets,
    flags,
  });
}
