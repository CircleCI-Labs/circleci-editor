/**
 * The "is this almost certainly a typo of that" primitive every mechanical
 * rename suggestion in this app is built on -- `suggestions.ts`'s
 * `stpes` -> `steps` one level inside a job, and `topLevelKeys.ts`'s
 * `workflow` -> `workflows` one level above it (issue #5). Split out of
 * `suggestions.ts` into its own module so the latter can depend on it
 * without the two modules importing each other: `topLevelKeys.ts` needs this
 * distance check, and `suggestions.ts` needs `topLevelKeys.ts`'s known-key
 * list to build a rename button for the diagnostic that check produces.
 */

/** The largest edit distance still considered a typo rather than a different word. */
const MAX_DISTANCE = 2;

/**
 * Optimal string alignment distance (Levenshtein plus adjacent
 * transposition). The transposition case is not optional here: the two
 * typos this feature was built against -- `stpes` for `steps` and `chekcout`
 * for `checkout` -- are both single transpositions, which plain Levenshtein
 * scores as 2 and would therefore rank level with genuinely unrelated
 * two-edit candidates.
 */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => 0),
  );
  for (let i = 0; i < rows; i++) (d[i] as number[])[0] = i;
  for (let j = 0; j < cols; j++) (d[0] as number[])[j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = d[i] as number[];
      const prev = d[i - 1] as number[];
      row[j] = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        const prev2 = d[i - 2] as number[];
        row[j] = Math.min(row[j] as number, (prev2[j - 2] as number) + cost);
      }
    }
  }
  return (d[a.length] as number[])[b.length] as number;
}

/**
 * The single closest candidate to `typo`, or `undefined` when there isn't
 * exactly one. Three conditions, each of which has to hold before this app
 * will put a candidate behind a button:
 *
 *  - the distance is at most `MAX_DISTANCE`;
 *  - the distance is strictly less than the shorter of the two words, so
 *    short names (`os` vs `at`) can't "near-match" each other;
 *  - no other candidate ties for that distance -- a tie is ambiguity, and
 *    ambiguity is declined.
 */
export function nearestUnique(
  typo: string,
  candidates: readonly string[],
): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  let tied = false;

  for (const candidate of candidates) {
    if (candidate === typo) return undefined; // nothing to fix
    const distance = editDistance(typo, candidate);
    if (distance > MAX_DISTANCE) continue;
    if (distance >= Math.min(typo.length, candidate.length)) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
      tied = false;
    } else if (distance === bestDistance) {
      tied = true;
    }
  }

  return tied ? undefined : best;
}
