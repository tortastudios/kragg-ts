/**
 * "Did you mean …?" — one nearest-name suggestion, two vocabularies.
 *
 * Split out of `readers.ts` for size. It answers the same question about a
 * misspelled config key (`forbiden_calls`) and about a `critical_functions`
 * entry that names no analysed function: both are a typo that would otherwise
 * configure nothing quietly, and both deserve the same suggestion.
 */

/**
 * The closest known name, or `undefined` when nothing is close enough to be
 * obvious.
 *
 * Shared with `gates/criticality/declared.ts`, which asks the same question
 * about a different vocabulary: a `critical_functions` entry that names no
 * function in the analysed program is the same typo in a different place, and
 * a reader should get the same "did you mean" out of both.
 *
 * `maxDistance` is what that second vocabulary needs. A config key is a dozen
 * characters, so three edits is already a different word; a qualified function
 * name is thirty, and renaming `verifyPassword` to `verifyPasswordHash` is
 * four edits away from a name that is obviously the same function. The
 * proportional guard below (`bestDistance * 2 < key.length`) is what keeps a
 * larger budget from producing nonsense, and it applies either way.
 */
export function nearestName(
  key: string,
  known: readonly string[],
  maxDistance = 3,
): string | undefined {
  const flat = (name: string): string => name.toLowerCase().replaceAll(/[-_]/gu, "");
  const sameLetters = known.find((candidate) => flat(candidate) === flat(key));
  if (sameLetters !== undefined) {
    return sameLetters;
  }
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of known) {
    const distance = editDistance(key, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= maxDistance && bestDistance * 2 < key.length ? best : undefined;
}

/** Levenshtein distance; the inputs are short config keys, so O(n·m) is fine. */
function editDistance(left: string, right: string): number {
  let row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (const [i, char] of [...left].entries()) {
    row = nextRow(row, i + 1, char, right);
  }
  return row[right.length] ?? 0;
}

/** One row of the Levenshtein table: the distances after consuming `char`. */
function nextRow(row: readonly number[], first: number, char: string, right: string): number[] {
  const next = [first];
  for (const [j, other] of [...right].entries()) {
    const substitution = (row[j] ?? 0) + (char === other ? 0 : 1);
    next.push(Math.min((row[j + 1] ?? 0) + 1, (next[j] ?? 0) + 1, substitution));
  }
  return next;
}
