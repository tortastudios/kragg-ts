/**
 * The gates that appear in BOTH pipelines.
 *
 * `kragg security` is not a different set of rules from `kragg check` — it is
 * the same rules with everything else stripped away, so a security-only run is
 * fast enough to put in a pre-push hook without anyone being tempted to skip
 * it. Defining them once, here, is what keeps that true: a gate added to
 * `security` cannot silently drift out of `check`, and a threshold changed for
 * one cannot fail to change for the other.
 *
 * Ported from the overlap between `build_check_gates` and
 * `build_security_gates` in `catalog.py`. Python's `bandit` has no analogue
 * here — there is no equivalent security linter for TypeScript that kragg can
 * drive without bundling one, and shipping a gate that reports nothing would
 * be worse than not shipping it.
 */

import { runAudit, AUDIT_GATE } from "../adapters/audit.ts";
import { FAST, SLOW, type GateSpec } from "../engine/gate.ts";
import { checkForbiddenCalls } from "../gates/forbiddenCalls.ts";
import { checkSecretDefaults } from "../gates/secretDefault.ts";
import { runSecretScan } from "../gates/secrets.ts";
import { unconfigured, type CatalogContext } from "./context.ts";
import { fromReport, fromSecrets, fromSimple } from "./results.ts";

/**
 * Ban list enforcement.
 *
 * Skips VISIBLY with nothing configured rather than passing: an empty ban list
 * has forbidden nothing, and `[PASS] forbidden-calls` on a project that never
 * wrote a rule is a green light for a check that does not exist. The gate
 * itself also short-circuits on an empty rule set without ever loading the
 * program, so the skip costs nothing either way.
 */
export function forbiddenCallsGate(ctx: CatalogContext): GateSpec {
  return {
    name: "forbidden-calls",
    tier: FAST,
    run: () =>
      fromSimple(
        "forbidden-calls",
        checkForbiddenCalls({
          program: ctx.program,
          forbidden: ctx.policy.forbiddenCalls,
          paths: ctx.paths,
        }),
      ),
    skipReason: unconfigured(
      "no forbidden calls configured",
      ctx.policy.forbiddenCalls.length > 0,
    ),
  };
}

/**
 * The two credential gates, in pipeline order.
 *
 * They answer different questions and neither substitutes for the other:
 * `secret-default` finds a secret that was given a silent fallback (the code
 * runs unconfigured and signs with an empty key, and nothing ever fails),
 * while `detect-secrets` finds a credential committed to the repo. A project
 * can be clean on one and compromised on the other.
 */
export function secretGates(ctx: CatalogContext): readonly GateSpec[] {
  return [
    {
      name: "secret-default",
      tier: FAST,
      run: () =>
        fromSimple(
          "secret-default",
          checkSecretDefaults({
            root: ctx.root,
            sourcePaths: ctx.policy.sourcePaths,
            secretNameSuffixes: ctx.policy.secretNameSuffixes,
            paths: ctx.paths,
            api: ctx.api,
          }),
        ),
      skipReason: unconfigured(
        "no secret name suffixes configured",
        ctx.policy.secretNameSuffixes.length > 0,
      ),
    },
    {
      name: "detect-secrets",
      tier: FAST,
      // Named for the Python gate it replaces, not for the tool it drives:
      // the scanner underneath is gitleaks or secretlint depending on what is
      // installed, and the gate name is part of the wire format.
      run: async () =>
        fromSecrets(
          "detect-secrets",
          await runSecretScan({
            env: ctx.env,
            scanner: ctx.policy.secretScanner,
            // Undefined, not `sourcePaths`: credentials hide in `.env` files,
            // CI workflows and fixtures far more often than in `src/`, and the
            // adapter's default is the whole project. Only an explicitly
            // narrowed run scopes it down.
            targets: ctx.paths,
            baselinePath: ctx.policy.secretBaseline ?? null,
          }),
        ),
    },
  ];
}

/**
 * Dependency vulnerability audit — SLOW, because it talks to the network.
 *
 * An audit that could not reach the advisory database reports `offline`, which
 * this maps to an ERROR and exit 3. That is the whole reason `Unavailable`
 * carries a `kind`: a scan that found nothing because it could not look has
 * cleared nothing, and rendering it as a pass would put a green checkmark on
 * an unknown.
 */
export function auditGate(ctx: CatalogContext): GateSpec {
  return {
    name: AUDIT_GATE,
    tier: SLOW,
    run: async () =>
      fromReport(
        AUDIT_GATE,
        await runAudit({
          env: ctx.env,
          severityFloor: ctx.policy.auditSeverity,
          maxViolations: ctx.policy.maxViolationsPerGate,
        }),
      ),
    skipReason: ctx.slowSkip,
  };
}
