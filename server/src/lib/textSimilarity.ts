/**
 * Small local string-similarity helper — no fuzzy/edit-distance utility
 * exists anywhere else in this repo (confirmed by search; `parsing/templates.ts`'s
 * "fuzzy" header matching is exact membership against a fixed alias list, a
 * different problem). Built for `APPLY_ROTA_TEMPLATE`'s ambiguity backstop
 * (spec §2.2): the model resolves a `templateId` itself the same way it
 * resolves every other entity reference, but this independently re-scores
 * that resolution against the caller's own saved template names rather than
 * trusting the model's stated confidence alone for a same-shape judgment.
 */

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Standard Levenshtein edit distance, iterative two-row DP (no recursion, no dependency). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prevRow = Array.from({ length: b.length + 1 }, (_, j) => j);
  let currRow = new Array(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i++) {
    currRow[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        prevRow[j] + 1, // deletion
        currRow[j - 1] + 1, // insertion
        prevRow[j - 1] + cost, // substitution
      );
    }
    [prevRow, currRow] = [currRow, prevRow];
  }
  return prevRow[b.length];
}

/**
 * Normalized similarity in [0, 1] — 1 means identical (after case/whitespace
 * normalization), 0 means completely different. Two empty strings are
 * treated as identical (1); one empty and one non-empty as completely
 * different (0), rather than dividing by zero.
 */
export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

export interface MatchCandidate {
  id: string;
  name: string;
}

export interface ScoredMatch {
  id: string;
  name: string;
  score: number;
}

/**
 * Scores `query` against every candidate and returns the best match plus the
 * runner-up (if any) — the caller decides what score/margin counts as
 * "confident enough", since that threshold is intent-specific, not a
 * property of this generic helper.
 */
export function bestMatch(query: string, candidates: MatchCandidate[]): { best: ScoredMatch | null; runnerUp: ScoredMatch | null } {
  const scored: ScoredMatch[] = candidates
    .map((c) => ({ id: c.id, name: c.name, score: similarity(query, c.name) }))
    .sort((a, b) => b.score - a.score);
  return { best: scored[0] ?? null, runnerUp: scored[1] ?? null };
}
