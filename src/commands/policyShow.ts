/**
 * `kragg policy show` — the EFFECTIVE policy, after every default and every
 * override.
 *
 * Ported from `cmd_policy_show`. The value of this command is that it answers
 * "what is actually enforced here", which is not the same question as "what
 * does kragg.json say": defaults fill in, and a `package.json#kragg` block may
 * be shadowed by a `kragg.json`. A malformed value never gets this far — the
 * load rejects it with `PolicyError` (exit 2, naming the setting), so what
 * prints here is exactly what the gates enforce.
 *
 * Keys are sorted and the indent is 2, matching Python's
 * `json.dumps(..., indent=2, sort_keys=True)`, so the two siblings' output for
 * an identical policy diffs to nothing.
 */

import { EXIT_OK } from "../engine/report.ts";
import { loadPolicy, policyAsDict } from "../policy/policy.ts";

/** Print the resolved policy as sorted JSON. Returns the exit code. */
export function runPolicyShow(root: string): number {
  const dict = policyAsDict(loadPolicy(root));
  const sorted: Record<string, unknown> = {};
  // Insertion order IS key order for JSON.stringify on string keys, so sorting
  // the keys and rebuilding is the whole implementation. `sort()` compares by
  // code unit, which is what Python's `sort_keys=True` does for ASCII keys.
  for (const key of Object.keys(dict).sort()) {
    sorted[key] = dict[key];
  }
  process.stdout.write(`${JSON.stringify(sorted, null, 2)}\n`);
  return EXIT_OK;
}
