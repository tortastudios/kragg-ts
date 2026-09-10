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
 * other ran a green pipeline over it. `--package` it accepts too, through the
 * same `packages.ts` runner: a member's `forbidden-calls` reads the member's
 * program, and its `audit` runs in the member's directory.
 */

import { buildSecurityGates } from "../catalog.ts";
import { resolveProjectEnvironment, type ProjectEnvironment } from "../environment/project.ts";
import { loadPolicy, type KraggPolicy } from "../policy/policy.ts";
import type { Assembly } from "./check.ts";
import { runPackages, uncheckedPackagesNotice } from "./packages.ts";
import { runPipeline, type PipelineRun, type ReportFlags } from "./pipeline.ts";
import { resolveScope } from "./scope.ts";

/** Run the security pipeline and return the process exit code. */
export async function runSecurity(flags: ReportFlags): Promise<number> {
  if (flags.packages.length > 0) {
    return runPackages(flags, assembleSecurity);
  }
  const policy = loadPolicy(flags.root);
  const env = resolveProjectEnvironment(flags.root);
  const assembled = await assembleSecurity(flags, policy, env);
  if (!assembled.ok) {
    process.stderr.write(`kragg: ${assembled.message}\n`);
    return assembled.exit;
  }
  const unchecked = uncheckedPackagesNotice(env, "security");
  if (unchecked !== undefined) {
    process.stderr.write(`kragg: ${unchecked}\n`);
  }
  return runPipeline(assembled.run());
}

/** The security pipeline for one root; see `assembleCheck`. */
async function assembleSecurity(
  flags: ReportFlags,
  policy: KraggPolicy,
  env: ProjectEnvironment,
): Promise<Assembly> {
  const resolved = await resolveScope(
    { root: flags.root, targets: flags.targets, changed: false, since: null },
    policy,
  );
  if (!resolved.ok) {
    return resolved;
  }
  const { scope } = resolved;
  return {
    ok: true,
    scope,
    run: (): PipelineRun => ({
      command: "security",
      mode: scope.mode,
      policy,
      specs: buildSecurityGates({
        root: flags.root,
        policy,
        env,
        targets: scope.targets,
        paths: scope.paths,
        incremental: scope.mode !== "full",
      }),
      targets: scope.targets,
      flags,
    }),
  };
}
