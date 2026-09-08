/**
 * Reviewed critical-function declarations: the half of criticality the call
 * graph cannot see.
 *
 * ── THE HOLE THIS CLOSES ───────────────────────────────────────────────────
 * Centrality answers "what would a careless edit damage the most", and it
 * answers it well for plumbing. It is silent about CONSEQUENCE. An
 * authorization check called from exactly one route handler, a payment
 * capture called once at the end of a checkout, a token verifier behind a
 * single middleware — each has fan-in 1 and betweenness 0, sits at the very
 * bottom of the ranked table, and is where a missing test costs the most.
 * `critical_functions` in `kragg.json` lets a reviewer say so, with the reason
 * attached, and the declared function is then subject to exactly the same
 * enforcement as a graph-selected one.
 *
 * ── UNION, NEVER OVERRIDE ──────────────────────────────────────────────────
 * A declaration can only ADD. Nothing here can make an automatically critical
 * function stop being critical, and declaring one that already is critical is
 * fine — the table then shows both reasons. There is deliberately no
 * "not_critical" list: a config key that can switch off a gate's findings is
 * the fail-open shape this codebase exists to refuse.
 *
 * ── THE POLICY IS READ AT THE MOMENT OF USE ────────────────────────────────
 * `.kragg/criticality.json` is a CACHE of a derived fact, and its freshness
 * stamp watches the SOURCE TREE — editing `kragg.json` changes no source file,
 * so the stamp would still vouch for a sidecar written before the declaration
 * existed. Rather than teach the stamp about the policy, every reader applies
 * the declarations itself: {@link declaredCritical} is called by `readJson`
 * (so every consumer of the file sees them), by the derive-with-cache (so the
 * file on disk says the same thing) and by `kragg criticality`. The policy is
 * therefore the single source of truth at every read, and a declaration takes
 * effect the moment it is written, with no command to run in between.
 *
 * ── A DECLARATION THAT MATCHES NOTHING IS AN ERROR, NOT A SHRUG ────────────
 * If `verifyPassword` is renamed and the declaration is not, the protection
 * would silently evaporate — the entry names a function nobody analyses, so
 * nothing is enforced and nothing says so. {@link missingDeclarations} finds
 * those entries and the callers turn them into an ERROR: exit 3 from `kragg
 * criticality`, and `error: true` from the three gates that consume the data.
 * Naming the stale entry (with the nearest matching function, when one is
 * obvious) is the whole point: the remedy is a one-line edit, and the reviewer
 * has to be told which line.
 *
 * ── NO NEW KEY IN THE SIDECAR ──────────────────────────────────────────────
 * `.kragg/criticality.json` records carry exactly `name`, `fan_in`, `fan_out`,
 * `betweenness`, `is_critical` and `risk`; the Python sibling reads that file
 * and the conformance fixture pins the six keys. A declared function appears
 * there as an ordinary record with `is_critical: true` — no seventh key, no
 * second file. The REASON is not stored at all: it is re-derived from the
 * policy wherever it is shown, which is what makes it impossible for it to
 * drift from what `kragg.json` says.
 */

import {
  loadPolicy,
  nearestName,
  PolicyError,
  type CriticalDeclarations,
} from "../../policy/policy.ts";

/** A declaration that names no function in the analysed program. */
export interface MissingDeclaration {
  readonly name: string;
  readonly reason: string;
  /** The closest analysed function name, when one is obviously it. */
  readonly nearest: string | undefined;
}

/**
 * The reviewed declarations for a project, or none.
 *
 * A `kragg.json` that will not load yields NO declarations rather than
 * throwing, because this is called from readers that must stay total —
 * `readJson` degrades to an empty list for every other unusable input, and the
 * Claude hook fails open by design. Nothing is lost by it: every command loads
 * the policy itself and exits 2 with the `PolicyError` before a gate runs, so
 * a project with a broken config never reaches enforcement believing it is
 * protected.
 */
export function declaredCritical(root: string): CriticalDeclarations {
  try {
    return loadPolicy(root).criticalFunctions;
  } catch (error: unknown) {
    if (error instanceof PolicyError) {
      return [];
    }
    throw error;
  }
}

/** Declared name -> reason, for lookups while rendering or reporting. */
export function declaredReasons(
  declarations: CriticalDeclarations,
): ReadonlyMap<string, string> {
  return new Map(declarations.map(([name, reason]) => [name, reason]));
}

/**
 * The declarations that match no analysed function, worst first in file order.
 *
 * `names` is whatever the caller knows the program contains: the call graph's
 * nodes for `kragg criticality`, the sidecar's records for a gate. Both are
 * the complete population — the sidecar is never truncated — so an entry
 * missing from either really is an entry that names nothing.
 */
export function missingDeclarations(
  declarations: CriticalDeclarations,
  names: Iterable<string>,
): readonly MissingDeclaration[] {
  const present = new Set(names);
  const known = [...present];
  const missing: MissingDeclaration[] = [];
  for (const [name, reason] of declarations) {
    if (present.has(name)) {
      continue;
    }
    // A quarter of the name's length, floored at three edits: a rename is
    // usually a suffix or a moved module, and both are further than three
    // characters away from a name a reader would call obviously the same.
    const budget = Math.max(3, Math.floor(name.length / 4));
    missing.push({ name, reason, nearest: nearestName(name, known, budget) });
  }
  return missing;
}

/**
 * The message a caller reports for stale declarations, or `null` when every
 * declaration matches something.
 *
 * One line per entry, naming the entry, its reason and where to fix it, so the
 * text is the same whether it reaches a user as a command's stderr or as a
 * gate's `raw_output`. It is the message and the callers' `error: true` /
 * exit 3 that keep a rename from quietly dropping the protection.
 */
export function staleDeclarationMessage(
  declarations: CriticalDeclarations,
  names: Iterable<string>,
): string | null {
  const missing = missingDeclarations(declarations, names);
  return missing.length === 0 ? null : missingDeclarationMessage(missing);
}

function missingDeclarationMessage(
  missing: readonly MissingDeclaration[],
): string {
  const lines = missing.map(({ name, reason, nearest }) => {
    const suggestion = nearest === undefined ? "" : ` (did you mean ${nearest}?)`;
    return `  ${name} — declared critical: ${reason}${suggestion}`;
  });
  return [
    `critical_functions names ${missing.length === 1 ? "a function" : "functions"} ` +
      "that the analysed program does not define:",
    ...lines,
    "A renamed or deleted function must not silently stop being critical. " +
      "Update the entry in kragg.json (or package.json#kragg) to the new name, " +
      "or remove it if the function is gone.",
  ].join("\n");
}
