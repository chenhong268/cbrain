/**
 * Shared name-similarity helpers for NER entity resolution and similar-entity
 * detection (#246). Pure functions, no DB/LLM/ontology dependency.
 */

/** Lowercase; strip whitespace/hyphen/underscore/dot; strip parentheticals; strip non-letter/number. */
export function normalizeForComparison(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s\-_.]+/g, "")
    .replace(/[（(].+?[）)]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .trim();
}

/** Containment guard: absolute length diff >= 3, OR shorter >= 60% of longer. */
export function isSignificantSubstring(shorter: string, longer: string): boolean {
  const diff = longer.length - shorter.length;
  if (diff >= 3) return true;
  if (shorter.length >= longer.length * 0.6) return true;
  return false;
}

/** True if the string contains any CJK ideograph (Han/Hiragana/Katakana/Hangul). */
export function hasCjk(s: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(s);
}

/**
 * Early-exit Levenshtein. Returns edit distance if <= maxDistance, else null.
 * Prunes as soon as the running row minimum exceeds maxDistance.
 */
export function boundedLevenshtein(a: string, b: string, maxDistance: number): number | null {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > maxDistance) return null;
  if (la === 0) return lb <= maxDistance ? lb : null;
  if (lb === 0) return la <= maxDistance ? la : null;

  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDistance) return null;
    const tmp = prev; prev = curr; curr = tmp;
  }
  const result = prev[lb];
  return result <= maxDistance ? result : null;
}

/**
 * Blocking keys for candidate-pair generation (#246). Two pages are a candidate
 * pair iff their key sets intersect. Includes: full normalized title, latin/digit
 * word tokens (>=2 chars), CJK bigrams, and an acronym key. Used ONLY for pair
 * generation — never for match_kind.
 */
export function tokenizeForBlocking(title: string): Set<string> {
  const keys = new Set<string>();
  const norm = normalizeForComparison(title);
  if (norm.length > 0) keys.add(norm);

  const lower = title.toLowerCase();
  const wordTokens = lower.match(/[a-z0-9]{2,}/g) ?? [];
  for (const t of wordTokens) keys.add(t);

  if (hasCjk(title)) {
    const cjkRuns = lower.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? [];
    for (const run of cjkRuns) {
      for (let i = 0; i < run.length - 1; i++) keys.add(run.slice(i, i + 2));
      if (run.length === 1) keys.add(run);
    }
  }

  if (wordTokens.length >= 2) {
    const acr = wordTokens.map((t) => t[0]).join("");
    if (acr.length >= 2) keys.add("acr:" + acr);
  }
  return keys;
}

/**
 * Higher = more canonical merge target. Penalizes title length, parenthetical /
 * alias-trace count, and slug path depth. Used only to break canonical ties (#246 §8).
 */
export function titleCanonicalScore(title: string, slug: string): number {
  let score = 0;
  score -= title.length;
  score -= (title.match(/[（(]/g) ?? []).length * 3;
  score -= slug.split("/").filter(Boolean).length * 2;
  return score;
}
