/**
 * The ban table: reading the policy into it, and matching a resolved call
 * against it.
 */

import type { ForbiddenCall } from "../../policy/policy.ts";
import { canonicalPath } from "./resolver.ts";

/** `Violation.code` for every finding this gate produces. */
export const FORBIDDEN_CALL_CODE = "forbidden-call";

/** Fix hint used when the policy bans a path but supplies no advice. */
export const DEFAULT_FIX_HINT = "this API is forbidden by the project policy";

/** The rule that banned a call: the entry as configured, and its advice. */
export interface RuleMatch {
  readonly entry: string;
  readonly hint: string;
}

/**
 * Canonical entry -> hint.
 *
 * FAIL CLOSED, matching `getStringPairs` in `policy.ts`: two entries that
 * canonicalize to the same path (`fs.x` and `node:fs.x`) collapse to one ban,
 * and a real hint always wins over an empty one so the surviving ban keeps its
 * advice. An entry is never dropped.
 */
export function buildRules(forbidden: readonly ForbiddenCall[]): ReadonlyMap<string, string> {
  const rules = new Map<string, string>();
  for (const [entry, hint] of forbidden) {
    const key = canonicalPath(entry.trim());
    if (key === "") {
      continue;
    }
    const existing = rules.get(key);
    if (existing === undefined || (existing === "" && hint !== "")) {
      rules.set(key, hint);
    }
  }
  return rules;
}

/**
 * The most specific rule matching any spelling of the call, or `null`.
 *
 * Specificity is longest entry, exactly as Python's `max(matches, key=len)`;
 * ties break toward the earlier (more canonical) spelling. Prefix matching is
 * done by walking the path's own segments so a ban on `pkg` matches
 * `pkg.Class.method` while a ban on `pk` matches nothing.
 */
export function matchRule(
  paths: readonly string[],
  rules: ReadonlyMap<string, string>,
): RuleMatch | null {
  let best: RuleMatch | null = null;
  for (const path of paths) {
    const parts = path.split(".");
    for (let size = parts.length; size > 0; size -= 1) {
      const entry = parts.slice(0, size).join(".");
      const hint = rules.get(entry);
      if (hint !== undefined) {
        if (best === null || entry.length > best.entry.length) {
          best = { entry, hint };
        }
        break;
      }
    }
  }
  return best;
}
