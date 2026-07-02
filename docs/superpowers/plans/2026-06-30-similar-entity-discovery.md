# Similar Entity Discovery (#246 Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an on-demand `similar_entity` discovery lane that surfaces likely-duplicate `entity/%` / `concept/%` page pairs for review, persists them through the existing `discoveries` lifecycle, and exposes them via a dedicated MCP tool + CLI command — without ever auto-merging, auto-aliasing, or mutating pages/links.

**Architecture:** A pure `similar-entity-detector` module (no DB, no LLM) produces candidates from injected page/alias/quality maps. `DiscoveryManager.runSimilarEntityDetection()` (a structurally separate method, never called by `runDiscovery`) bulk-loads inputs, runs the detector, and feeds results through the existing `upsertDiscovery` dedup/recurrence loop. Default daily discovery and default digest exclude `similar_entity`; it surfaces only via `find_similar_entities` (MCP), `cbrain similar-entities` (CLI), or explicit `run_discovery({types:["similar_entity"]})`. Shared name helpers are extracted to `name-similarity.ts` so the detector and NER resolver share one normalization truth.

**Tech Stack:** Bun, TypeScript (strict), bun:sqlite, bun:test, Zod. No ontology change, no sqlite schema migration (`discoveries.type` is TEXT), no LanceDB change, no embedding calls.

**Spec:** `docs/superpowers/specs/2026-06-30-similar-entity-discovery-design.md`

---

## Hard constraints (reject conditions — every task honors)

1. No auto-merge / auto-alias / page-link-tag-timeline mutation. Execute path writes ONLY a `discoveries` row.
2. No LLM call in any detection path.
3. `DiscoveryManager.runDiscovery()` never references `similar_entity`. Opt-in routing lives in the MCP handler / CLI.
4. `match_kind` alias checks use `registeredAliasesBySlug` (aliases table only) — never blocking keys, never own-title-inclusive.
5. Dry-run writes nothing. Default daily digest / default `read_discoveries` show no `similar_entity`.
6. Public tests/docs use only anonymous placeholders (`实体A`, `实体B`, `组织C`, `主题D`). No real names/orgs/products/paths, not even as negative assertions.

---

## File Structure

**New:**
- `src/core/ingestion/name-similarity.ts` — pure shared helpers: `normalizeForComparison`, `isSignificantSubstring` (extracted from `entity-resolver.ts`), plus `hasCjk`, `boundedLevenshtein`, `tokenizeForBlocking`, `titleCanonicalScore`.
- `src/core/ingestion/similar-entity-detector.ts` — pure detector: `detectSimilarEntities(input, opts) → DetectorReport`.
- `tests/core/name-similarity.test.ts`
- `tests/core/similar-entity-detector.test.ts`
- `tests/mcp/find-similar-entities.test.ts`
- `tests/cli/similar-entities.test.ts`

**Modified:**
- `src/core/ingestion/entity-resolver.ts` — delete local `normalizeForComparison` / `isSignificantSubstring`, import from `name-similarity.ts`. Behavior unchanged.
- `src/core/maintenance/discovery.ts` — add `"similar_entity"` to `DiscoveryType`; add `runSimilarEntityDetection()`. Do NOT touch `runDiscovery`'s switch.
- `src/core/maintenance/discovery-digest.ts` — add `similar_entity` case to `formatDigestCard`; add a shared `isDigestExcluded` helper used to keep `similar_entity` out of the default digest feed.
- `src/mcp/tools/discoveries.ts` — add `"similar_entity"` to `read_discoveries`/`run_discovery` enums; register `find_similar_entities`; route `run_discovery({types:[similar_entity]})` at the handler layer.
- `src/storage/sqlite.ts` — add two bulk readers: `getAliasesBySlugBulk()`, `getEntityConceptQuality()`.
- `src/cli/commands/maintenance.ts` — add `similar-entities` command.

---

## Task 1: name-similarity.ts (extracted + new primitives) + rewire resolver

**Files:**
- Create: `src/core/ingestion/name-similarity.ts`
- Create: `tests/core/name-similarity.test.ts`
- Modify: `src/core/ingestion/entity-resolver.ts` (delete local copies at lines ~464-480, add import)

- [ ] **Step 1: Write failing tests for the new primitives**

Create `tests/core/name-similarity.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import {
  normalizeForComparison, isSignificantSubstring, hasCjk,
  boundedLevenshtein, tokenizeForBlocking, titleCanonicalScore,
} from "../../src/core/ingestion/name-similarity.js";

describe("name-similarity", () => {
  test("normalizeForComparison strips case/space/punct/parentheticals", () => {
    expect(normalizeForComparison("实体 A")).toBe("实体a");
    expect(normalizeForComparison("A.I. Helper")).toBe("aihelper");
    expect(normalizeForComparison("Foo (bar)")).toBe("foo");
    expect(normalizeForComparison("  Co., Ltd. ")).toBe("coltd");
  });

  test("isSignificantSubstring guards", () => {
    expect(isSignificantSubstring("claude", "claude code")).toBe(true);   // diff 5
    expect(isSignificantSubstring("数字化", "数字化转型")).toBe(true);     // 3/5 = 60%
    expect(isSignificantSubstring("a", "ab")).toBe(false);                // too short / weak
  });

  test("hasCjk", () => {
    expect(hasCjk("实体A")).toBe(true);
    expect(hasCjk("Alpha")).toBe(false);
  });

  test("boundedLevenshtein early-exits beyond maxDistance", () => {
    expect(boundedLevenshtein("实体a", "实体b", 2)).toBe(1);
    expect(boundedLevenshtein("abc", "axc", 2)).toBe(1);
    expect(boundedLevenshtein("abc", "abcdef", 2)).toBe(null); // length diff > 2
    expect(boundedLevenshtein("alpha", "zmxqb", 2)).toBe(null); // distance > 2
    expect(boundedLevenshtein("same", "same", 2)).toBe(0);
  });

  test("tokenizeForBlocking emits normalized, word tokens, CJK bigrams", () => {
    const keys = tokenizeForBlocking("实体Alpha");
    expect(keys.has("实体alpha")).toBe(true); // full normalized
    expect(keys.has("alpha")).toBe(true);     // latin word token
    expect(keys.has("实体")).toBe(true);      // CJK bigram
    const en = tokenizeForBlocking("Claude Code");
    expect(en.has("claude")).toBe(true);
    expect(en.has("code")).toBe(true);
  });

  test("titleCanonicalScore: shorter, fewer parens, shallower slug scores higher", () => {
    const shortClean = titleCanonicalScore("Alpha", "entity/alpha");
    const longParens = titleCanonicalScore("Alpha (Beta Corp)", "entity/alpha-beta-corp");
    expect(shortClean).toBeGreaterThan(longParens);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/core/name-similarity.test.ts`
Expected: FAIL — module not found (`Cannot resolve module ".../name-similarity.js"`).

- [ ] **Step 3: Create src/core/ingestion/name-similarity.ts with all six functions**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/core/name-similarity.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Rewire entity-resolver to import the extracted helpers**

In `src/core/ingestion/entity-resolver.ts`:
- Add to the import block near the top (after line 5, alongside other `./` imports):
  ```ts
  import { normalizeForComparison, isSignificantSubstring } from "./name-similarity.js";
  ```
- Delete the two local function definitions `isSignificantSubstring` (around line 464-471) and `normalizeForComparison` (around line 473-480). They are now imported. Do NOT change any call site.

- [ ] **Step 6: Verify the resolver suite is unchanged (behavior-preserving gate)**

Run: `bun test tests/core/entity-resolver.test.ts tests/core/entity-resolver.embedding.test.ts tests/core/name-similarity.test.ts`
Expected: PASS — extraction is behavior-preserving.

- [ ] **Step 7: Lint**

Run: `bun run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/ingestion/name-similarity.ts src/core/ingestion/entity-resolver.ts tests/core/name-similarity.test.ts
git commit -m "feat(discovery): extract name-similarity helpers + blocking primitives (#246)"
```

---

## Task 2: similar-entity-detector.ts — scaffolding (types, blocking, pair-gen, caps, name_exact)

**Files:**
- Create: `src/core/ingestion/similar-entity-detector.ts`
- Create: `tests/core/similar-entity-detector.test.ts`

- [ ] **Step 1: Write failing tests for the scaffolding**

Create `tests/core/similar-entity-detector.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import {
  detectSimilarEntities,
  type DetectorInput, type DetectorPage, type PageQuality,
} from "../../src/core/ingestion/similar-entity-detector.js";

const sameType = () => true; // affine predicate for tests: control per-test

function page(slug: string, title: string, type = "entity/company"): DetectorPage {
  return { slug, title, type };
}
function quality(opts: Partial<PageQuality> = {}): PageQuality {
  return { isStub: false, bodyChars: 0, chunkCount: 0, mentionCount: 0, aliasCount: 0, tagCount: 0, ...opts };
}
function input(pages: DetectorPage[], opts: Partial<{ aliases: Map<string, Set<string>>; quality: Map<string, PageQuality>; affine: (a: string, b: string) => boolean }> = {}): DetectorInput {
  const qualityBySlug = new Map<string, PageQuality>();
  for (const p of pages) qualityBySlug.set(p.slug, opts.quality?.get(p.slug) ?? quality());
  return {
    pages,
    registeredAliasesBySlug: opts.aliases ?? new Map(),
    linkDegree: new Map(),
    qualityBySlug,
    areTypesAffine: opts.affine ?? ((a, b) => a === b),
  };
}

describe("similar-entity-detector scaffolding", () => {
  test("identical-title same-type pages → one name_exact high candidate", () => {
    const r = detectSimilarEntities(input([
      page("entity/a", "实体A"), page("entity/b", "实体A"),
    ]));
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0];
    expect(c.matchKind).toBe("name_exact");
    expect(c.typeGate).toBe("same_type");
    expect(c.actionable).toBe("high");
    expect(r.truncated).toBe(false);
  });

  test("non-affine types are dropped (type gate)", () => {
    const r = detectSimilarEntities(input([
      page("entity/a", "实体A", "entity/person"), page("entity/b", "实体A", "entity/company"),
    ], { affine: () => false }));
    expect(r.candidates).toHaveLength(0);
  });

  test("truncated=true when pairs exceed maxPairsEvaluated", () => {
    const pages: DetectorPage[] = [];
    for (let i = 0; i < 30; i++) pages.push(page(`entity/p${i}`, "共享Token")); // shared CJK bigram bucket
    const r = detectSimilarEntities(input(pages), { maxPairsEvaluated: 5, maxBucketSize: 100 });
    expect(r.truncated).toBe(true);
    expect(r.pairsEvaluated).toBe(5);
  });

  test("maxBucketSize skips non-discriminative keys", () => {
    // 60 pages share the bigram "共享" — bucket too big to be useful
    const pages: DetectorPage[] = [];
    for (let i = 0; i < 60; i++) pages.push(page(`entity/p${i}`, `共享${i}号`));
    const r = detectSimilarEntities(input(pages), { maxBucketSize: 50, maxPairsEvaluated: 5000 });
    // The "共享" bucket (size 60) is skipped; remaining pairs are near-zero
    expect(r.pairsEvaluated).toBeLessThan(60);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/core/similar-entity-detector.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create src/core/ingestion/similar-entity-detector.ts (scaffolding)**

```ts
import {
  normalizeForComparison, isSignificantSubstring, boundedLevenshtein,
  tokenizeForBlocking, titleCanonicalScore,
} from "./name-similarity.js";

export type SimilarMatchKind =
  | "alias_shadow_page" | "shared_alias"
  | "name_exact" | "name_normalized" | "name_substring" | "edit_distance";

export interface DetectorPage {
  slug: string;
  title: string;
  type: string;
}

export interface PageQuality {
  isStub: boolean;
  bodyChars: number;
  chunkCount: number;
  mentionCount: number;
  aliasCount: number;
  tagCount: number;
}

export interface DetectorInput {
  /** entity/% + concept/% only (caller pre-filters). */
  pages: DetectorPage[];
  /** aliases TABLE only, normalized, NEVER includes own title. Used for match_kind only. */
  registeredAliasesBySlug: Map<string, Set<string>>;
  /** slug → undirected link count. */
  linkDegree: Map<string, number>;
  /** per-page quality signals, precomputed by the orchestrator. */
  qualityBySlug: Map<string, PageQuality>;
  /** ontology affinity predicate; same-type is always allowed. */
  areTypesAffine: (a: string, b: string) => boolean;
}

export interface DetectorOptions {
  maxPairsEvaluated?: number;
  maxCandidates?: number;
  maxBucketSize?: number;
}

export interface SimilarEntityCandidate {
  slugA: string;
  slugB: string;
  matchKind: SimilarMatchKind;
  nameScore: number;
  editDistance?: number;
  typeGate: "same_type" | "affine_type";
  actionable: "high" | "medium" | "low";
  recommendedTarget?: string;
  ambiguousTarget?: boolean;
  reasonCode: string;
  sharedAlias?: string[];
}

export interface DetectorReport {
  candidates: SimilarEntityCandidate[];
  truncated: boolean;
  pairsEvaluated: number;
}

const DEFAULTS = {
  maxPairsEvaluated: 5000,
  maxCandidates: 100,
  maxBucketSize: 50,
};

const ACTIONABLE_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

export function detectSimilarEntities(
  detectorInput: DetectorInput,
  options: DetectorOptions = {},
): DetectorReport {
  const opts = { ...DEFAULTS, ...options };
  const pageBySlug = new Map<string, DetectorPage>();
  for (const p of detectorInput.pages) pageBySlug.set(p.slug, p);

  // Inverted index: blocking key → slugs. Keys come from titles AND registered aliases.
  const index = new Map<string, string[]>();
  const indexSlug = (slug: string, text: string) => {
    for (const key of tokenizeForBlocking(text)) {
      const arr = index.get(key);
      if (arr) arr.push(slug); else index.set(key, [slug]);
    }
  };
  for (const p of detectorInput.pages) {
    indexSlug(p.slug, p.title);
    const aliases = detectorInput.registeredAliasesBySlug.get(p.slug);
    if (aliases) for (const al of aliases) indexSlug(p.slug, al);
  }

  // Generate unique candidate pairs from discriminative buckets.
  const seenPairs = new Set<string>();
  const pairList: Array<[string, string]> = [];
  for (const [, slugs] of index) {
    if (slugs.length < 2 || slugs.length > opts.maxBucketSize) continue;
    for (let i = 0; i < slugs.length; i++) {
      for (let j = i + 1; j < slugs.length; j++) {
        const [a, b] = slugs[i] < slugs[j] ? [slugs[i], slugs[j]] : [slugs[j], slugs[i]];
        const k = a + " " + b;
        if (seenPairs.has(k)) continue;
        seenPairs.add(k);
        pairList.push([a, b]);
      }
    }
  }

  let pairsEvaluated = 0;
  let truncated = false;
  const candidates: SimilarEntityCandidate[] = [];
  for (const [a, b] of pairList) {
    if (pairsEvaluated >= opts.maxPairsEvaluated) { truncated = true; break; }
    pairsEvaluated++;
    const cand = evaluatePair(a, b, detectorInput, pageBySlug);
    if (cand) candidates.push(cand);
  }

  // Rank BEFORE truncation: actionable → nameScore → same_type before affine → slug pair.
  candidates.sort((x, y) => {
    const ao = ACTIONABLE_ORDER[x.actionable] - ACTIONABLE_ORDER[y.actionable];
    if (ao !== 0) return ao;
    if (y.nameScore !== x.nameScore) return y.nameScore - x.nameScore;
    const tg = (x.typeGate === "same_type" ? 0 : 1) - (y.typeGate === "same_type" ? 0 : 1);
    if (tg !== 0) return tg;
    return (x.slugA + x.slugB).localeCompare(y.slugA + y.slugB);
  });
  if (candidates.length > opts.maxCandidates) truncated = true;
  return { candidates: candidates.slice(0, opts.maxCandidates), truncated, pairsEvaluated };
}

function computeActionable(kind: SimilarMatchKind, typeGate: "same_type" | "affine_type"): "high" | "medium" | "low" {
  const same = typeGate === "same_type";
  switch (kind) {
    case "alias_shadow_page": return "high";
    case "shared_alias": return same ? "high" : "medium";
    case "name_exact":
    case "name_normalized":
    case "name_substring": return same ? "high" : "medium";
    case "edit_distance": return "medium";
  }
}

function reasonFor(kind: SimilarMatchKind, typeGate: "same_type" | "affine_type"): string {
  const t = typeGate === "same_type" ? "same_type" : "affine_type";
  return `${kind}:${t}`;
}

/**
 * Evaluate one candidate pair through the strategy priority chain.
 * Returns null if no strategy fires or the type gate drops the pair.
 * (Task 2 implements name_exact + the structure; Tasks 3-4 extend it.)
 */
function evaluatePair(
  slugA: string,
  slugB: string,
  input: DetectorInput,
  pageBySlug: Map<string, DetectorPage>,
): SimilarEntityCandidate | null {
  const pa = pageBySlug.get(slugA);
  const pb = pageBySlug.get(slugB);
  if (!pa || !pb || pa.slug === pb.slug) return null;

  const sameType = pa.type === pb.type;
  const affine = input.areTypesAffine(pa.type, pb.type);
  if (!sameType && !affine) return null;
  const typeGate: "same_type" | "affine_type" = sameType ? "same_type" : "affine_type";

  const normA = normalizeForComparison(pa.title);
  const normB = normalizeForComparison(pb.title);

  // Strategy: name_exact (case-insensitive raw equality)
  if (pa.title.toLowerCase() === pb.title.toLowerCase()) {
    return {
      slugA, slugB, matchKind: "name_exact", nameScore: 1.0, typeGate,
      actionable: computeActionable("name_exact", typeGate), reasonCode: reasonFor("name_exact", typeGate),
    };
  }

  // (name_normalized / name_substring / edit_distance / alias strategies added in Tasks 3-4)
  // Suppress unused warnings for helpers imported for later tasks:
  void isSignificantSubstring; void boundedLevenshtein; void normA; void normB;
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/core/similar-entity-detector.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Lint**

Run: `bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/ingestion/similar-entity-detector.ts tests/core/similar-entity-detector.test.ts
git commit -m "feat(discovery): similar-entity detector scaffolding + name_exact (#246)"
```

---

## Task 3: detector — full strategy suite (alias + name_normalized/substring/edit_distance)

**Files:**
- Modify: `src/core/ingestion/similar-entity-detector.ts` (`evaluatePair`)
- Modify: `tests/core/similar-entity-detector.test.ts` (append)

- [ ] **Step 1: Write failing tests for the new strategies**

Append to the describe file (new describe block):

```ts
describe("similar-entity-detector strategies", () => {
  test("name_normalized: punctuation/case variants → high", () => {
    const r = detectSimilarEntities(input([
      page("entity/a", "A.I. Helper"), page("entity/b", "ai helper"),
    ]));
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].matchKind).toBe("name_normalized");
    expect(r.candidates[0].actionable).toBe("high");
  });

  test("name_substring: significant containment → high", () => {
    const r = detectSimilarEntities(input([
      page("entity/a", "Claude"), page("entity/b", "Claude Code"),
    ]));
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].matchKind).toBe("name_substring");
    expect(r.candidates[0].actionable).toBe("high");
  });

  test("edit_distance: typo-like variant → medium", () => {
    const r = detectSimilarEntities(input([
      page("entity/a", "alpha"), page("entity/b", "alph"),
    ]));
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].matchKind).toBe("edit_distance");
    expect(r.candidates[0].actionable).toBe("medium");
  });

  test("alias_shadow_page: A.title is B's registered alias → high, target=B", () => {
    const aliases = new Map<string, Set<string>>();
    aliases.set("entity/b", new Set(["alpha"])); // B claims "alpha" as alias (normalized)
    const r = detectSimilarEntities(input([
      page("entity/a", "Alpha"), page("entity/b", "组织C"),
    ], { aliases }));
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0];
    expect(c.matchKind).toBe("alias_shadow_page");
    expect(c.actionable).toBe("high");
    expect(c.recommendedTarget).toBe("entity/b"); // alias holder is the sink
  });

  test("HIGH fix: identical titles are name_exact, NOT alias_shadow_page", () => {
    // Even if both happen to have aliases, same raw title must classify name_exact.
    const aliases = new Map<string, Set<string>>();
    aliases.set("entity/b", new Set(["whatever"]));
    const r = detectSimilarEntities(input([
      page("entity/a", "实体A"), page("entity/b", "实体A"),
    ], { aliases }));
    expect(r.candidates[0].matchKind).toBe("name_exact");
  });

  test("shared_alias: two pages share a registered alias → high (same type)", () => {
    const aliases = new Map<string, Set<string>>();
    aliases.set("entity/a", new Set(["共享别名"]));
    aliases.set("entity/b", new Set(["共享别名"]));
    const r = detectSimilarEntities(input([
      page("entity/a", "实体A"), page("entity/b", "实体B"),
    ], { aliases }));
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].matchKind).toBe("shared_alias");
    expect(r.candidates[0].sharedAlias).toContain("共享别名");
    expect(r.candidates[0].actionable).toBe("high");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/core/similar-entity-detector.test.ts -t "strategies"`
Expected: FAIL — `name_normalized` etc. not produced (evaluatePair only handles name_exact).

- [ ] **Step 3: Replace evaluatePair with the full strategy chain**

In `src/core/ingestion/similar-entity-detector.ts`, replace the entire `evaluatePair` function (and remove the `void ...` suppression line) with:

```ts
function evaluatePair(
  slugA: string,
  slugB: string,
  input: DetectorInput,
  pageBySlug: Map<string, DetectorPage>,
): SimilarEntityCandidate | null {
  const pa = pageBySlug.get(slugA);
  const pb = pageBySlug.get(slugB);
  if (!pa || !pb || pa.slug === pb.slug) return null;

  const sameType = pa.type === pb.type;
  const affine = input.areTypesAffine(pa.type, pb.type);
  if (!sameType && !affine) return null;
  const typeGate: "same_type" | "affine_type" = sameType ? "same_type" : "affine_type";

  const aliasesA = input.registeredAliasesBySlug.get(slugA) ?? new Set<string>();
  const aliasesB = input.registeredAliasesBySlug.get(slugB) ?? new Set<string>();
  const normA = normalizeForComparison(pa.title);
  const normB = normalizeForComparison(pb.title);

  // Priority 1: alias_shadow_page (registered aliases ONLY — no own title).
  const aTitleAliasedToB = normA.length > 0 && aliasesB.has(normA);
  const bTitleAliasedToA = normB.length > 0 && aliasesA.has(normB);
  if (aTitleAliasedToB || bTitleAliasedToA) {
    const direction = aTitleAliasedToB && bTitleAliasedToA ? "both" : aTitleAliasedToB ? "aToB" : "bToA";
    return buildCandidate(slugA, slugB, "alias_shadow_page", 1.0, typeGate, input, { aliasDirection: direction });
  }

  // Priority 2: shared_alias
  const shared = [...aliasesA].filter((x) => aliasesB.has(x));
  if (shared.length > 0) {
    return buildCandidate(slugA, slugB, "shared_alias", 0.85, typeGate, input, { sharedAlias: shared });
  }

  // Priority 3: name_exact (case-insensitive raw equality)
  if (pa.title.toLowerCase() === pb.title.toLowerCase()) {
    return buildCandidate(slugA, slugB, "name_exact", 1.0, typeGate, input);
  }

  // Priority 4: name_normalized
  if (normA.length > 0 && normA === normB) {
    return buildCandidate(slugA, slugB, "name_normalized", 0.95, typeGate, input);
  }

  // Priority 5: name_substring
  const [shorterN, longerN] = normA.length <= normB.length ? [normA, normB] : [normB, normA];
  if (shorterN.length >= 2 && longerN.includes(shorterN) && isSignificantSubstring(shorterN, longerN)) {
    const ratio = shorterN.length / longerN.length;
    return buildCandidate(slugA, slugB, "name_substring", 0.6 + ratio * 0.3, typeGate, input);
  }

  // Priority 6: edit_distance (bounded)
  const dist = boundedLevenshtein(normA, normB, 2);
  if (dist !== null && normA.length > 0) {
    const score = Math.max(1 - dist / Math.max(normA.length, normB.length), 0.5);
    return buildCandidate(slugA, slugB, "edit_distance", score, typeGate, input, { editDistance: dist });
  }

  return null;
}

interface CandidateExtra {
  aliasDirection?: "aToB" | "bToA" | "both";
  sharedAlias?: string[];
  editDistance?: number;
}

function buildCandidate(
  slugA: string,
  slugB: string,
  kind: SimilarMatchKind,
  nameScore: number,
  typeGate: "same_type" | "affine_type",
  input: DetectorInput,
  extra: CandidateExtra = {},
): SimilarEntityCandidate {
  const recommended = computeRecommendedTarget(slugA, slugB, kind, input, extra.aliasDirection);
  const cand: SimilarEntityCandidate = {
    slugA, slugB, matchKind: kind, nameScore, typeGate,
    actionable: computeActionable(kind, typeGate),
    reasonCode: reasonFor(kind, typeGate),
  };
  if (extra.editDistance !== undefined) cand.editDistance = extra.editDistance;
  if (extra.sharedAlias) cand.sharedAlias = extra.sharedAlias;
  if (recommended.target) cand.recommendedTarget = recommended.target;
  if (recommended.ambiguous) cand.ambiguousTarget = true;
  return cand;
}

/**
 * Canonical merge-sink selection (#246 §8). alias_shadow with a single direction
 * always points at the alias holder. Otherwise compare on discriminators 1-5;
 * tie on all five → ambiguous (slug lexicographic is NOT used to force a choice).
 */
function computeRecommendedTarget(
  slugA: string,
  slugB: string,
  kind: SimilarMatchKind,
  input: DetectorInput,
  aliasDirection?: "aToB" | "bToA" | "both",
): { target?: string; ambiguous?: boolean } {
  if (kind === "alias_shadow_page") {
    if (aliasDirection === "aToB") return { target: slugB };
    if (aliasDirection === "bToA") return { target: slugA };
    // "both" → fall through to canonical scoring
  }
  // Task 4 fills in discriminators 1-5; for now return nothing (no forced target).
  void input;
  return {};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/core/similar-entity-detector.test.ts`
Expected: PASS (scaffolding + strategy tests). The HIGH-fix test confirms identical titles classify `name_exact`.

- [ ] **Step 5: Lint**

Run: `bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/ingestion/similar-entity-detector.ts tests/core/similar-entity-detector.test.ts
git commit -m "feat(discovery): detector alias + name strategies (#246)"
```

---

## Task 4: detector — canonical target scoring + ambiguous rule

**Files:**
- Modify: `src/core/ingestion/similar-entity-detector.ts` (`computeRecommendedTarget`)
- Modify: `tests/core/similar-entity-detector.test.ts` (append)

- [ ] **Step 1: Write failing tests for canonical target selection**

Append:

```ts
describe("similar-entity-detector canonical target", () => {
  test("non-stub beats stub as merge target", () => {
    const q = new Map<string, PageQuality>();
    q.set("entity/a", quality({ isStub: true }));
    q.set("entity/b", quality({ isStub: false, mentionCount: 5 }));
    const r = detectSimilarEntities(input([
      page("entity/a", "实体A"), page("entity/b", "实体A"),
    ], { quality: q }));
    expect(r.candidates[0].recommendedTarget).toBe("entity/b");
  });

  test("completeness (bodyChars) breaks stub-tie", () => {
    const q = new Map<string, PageQuality>();
    q.set("entity/a", quality({ bodyChars: 10 }));
    q.set("entity/b", quality({ bodyChars: 500 }));
    const r = detectSimilarEntities(input([
      page("entity/a", "实体A"), page("entity/b", "实体A"),
    ], { quality: q }));
    expect(r.candidates[0].recommendedTarget).toBe("entity/b");
  });

  test("ambiguous_target when discriminators 1-5 tie", () => {
    const q = new Map<string, PageQuality>();
    q.set("entity/a", quality());
    q.set("entity/b", quality()); // identical quality, identical title → tie
    const r = detectSimilarEntities(input([
      page("entity/a", "实体A"), page("entity/b", "实体A"),
    ], { quality: q }));
    expect(r.candidates[0].ambiguousTarget).toBe(true);
    expect(r.candidates[0].recommendedTarget).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/core/similar-entity-detector.test.ts -t "canonical target"`
Expected: FAIL — `recommendedTarget` undefined for the stub test (computeRecommendedTarget currently returns `{}`).

- [ ] **Step 3: Implement computeRecommendedTarget discriminators 1-5**

In `src/core/ingestion/similar-entity-detector.ts`, replace `computeRecommendedTarget` with:

```ts
function computeRecommendedTarget(
  slugA: string,
  slugB: string,
  kind: SimilarMatchKind,
  input: DetectorInput,
  aliasDirection?: "aToB" | "bToA" | "both",
): { target?: string; ambiguous?: boolean } {
  if (kind === "alias_shadow_page") {
    if (aliasDirection === "aToB") return { target: slugB };
    if (aliasDirection === "bToA") return { target: slugA };
    // "both" → fall through to canonical scoring
  }

  const pick = (whenA: boolean): { target?: string; ambiguous?: boolean } =>
    whenA ? { target: slugA } : { target: slugB };

  const qa = input.qualityBySlug.get(slugA);
  const qb = input.qualityBySlug.get(slugB);
  const pageBySlug = new Map<string, DetectorPage>(); // title lookup for canonicalness
  for (const p of input.pages) pageBySlug.set(p.slug, p);

  // 1. non-stub beats stub
  const stubA = qa?.isStub ?? true;
  const stubB = qb?.isStub ?? true;
  if (stubA !== stubB) return pick(!stubA);

  // 2. completeness: bodyChars, then chunkCount
  const bodyA = qa?.bodyChars ?? 0;
  const bodyB = qb?.bodyChars ?? 0;
  if (bodyA !== bodyB) return pick(bodyA > bodyB);
  const chunksA = qa?.chunkCount ?? 0;
  const chunksB = qb?.chunkCount ?? 0;
  if (chunksA !== chunksB) return pick(chunksA > chunksB);

  // 3. link_degree
  const degA = input.linkDegree.get(slugA) ?? 0;
  const degB = input.linkDegree.get(slugB) ?? 0;
  if (degA !== degB) return pick(degA > degB);

  // 4. mention_count
  const menA = qa?.mentionCount ?? 0;
  const menB = qb?.mentionCount ?? 0;
  if (menA !== menB) return pick(menA > menB);

  // 5. title canonicalness
  const ta = pageBySlug.get(slugA);
  const tb = pageBySlug.get(slugB);
  if (ta && tb) {
    const ca = titleCanonicalScore(ta.title, ta.slug);
    const cb = titleCanonicalScore(tb.title, tb.slug);
    if (ca !== cb) return pick(ca > cb);
  }

  // tie on 1-5 → ambiguous; refuse to recommend
  return { ambiguous: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/core/similar-entity-detector.test.ts`
Expected: PASS (all detector tests).

- [ ] **Step 5: Lint**

Run: `bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/ingestion/similar-entity-detector.ts tests/core/similar-entity-detector.test.ts
git commit -m "feat(discovery): canonical merge-target scoring + ambiguous rule (#246)"
```

---

## Task 5: discovery.ts orchestrator + DiscoveryType + bulk loaders

**Files:**
- Modify: `src/core/maintenance/discovery.ts` (add `"similar_entity"` to union; add `runSimilarEntityDetection`; import detector + helpers + getOntology)
- Modify: `src/storage/sqlite.ts` (add `getAliasesBySlugBulk`, `getEntityConceptQuality`)
- Create: `tests/core/similar-entity-orchestrator.test.ts`

- [ ] **Step 1: Write failing test for the orchestrator (DB-backed)**

Create `tests/core/similar-entity-orchestrator.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { DiscoveryManager } from "../../src/core/maintenance/discovery.js";

describe("DiscoveryManager.runSimilarEntityDetection (#246)", () => {
  const testDir = "/tmp/cbrain-test-similar-orch";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
  });
  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function seedPage(slug: string, title: string, type = "entity/company", mentionCount = 0): void {
    db.upsertPage({ slug, type, title, filePath: `${slug}.md`, contentHash: slug, mentionCount });
  }

  test("seeds two duplicate titles → persists one similar_entity discovery", async () => {
    seedPage("entity/a", "实体A", "entity/company", 3);
    seedPage("entity/b", "实体A", "entity/company", 1);
    const mgr = new DiscoveryManager(db);
    const report = await mgr.runSimilarEntityDetection();
    expect(report.total).toBe(1);
    expect(report.byType.similar_entity).toBe(1);
    const rows = db.getDiscoveriesByType("similar_entity", 10);
    expect(rows).toHaveLength(1);
    const meta = JSON.parse(rows[0].metadata ?? "{}");
    expect(meta.match_kind).toBe("name_exact");
    expect(meta.recommended_target).toBe("entity/a"); // higher mention_count, non-stub both
  });

  test("re-running does not duplicate visible rows (recurrence)", async () => {
    seedPage("entity/a", "实体A");
    seedPage("entity/b", "实体A");
    const mgr = new DiscoveryManager(db);
    await mgr.runSimilarEntityDetection();
    const second = await mgr.runSimilarEntityDetection();
    expect(second.total).toBe(0); // already present → not re-inserted
    expect(db.getDiscoveriesByType("similar_entity", 10)).toHaveLength(1);
  });

  test("dismissed candidate does NOT resurrect as pending", async () => {
    seedPage("entity/a", "实体A");
    seedPage("entity/b", "实体A");
    const mgr = new DiscoveryManager(db);
    await mgr.runSimilarEntityDetection();
    const row = db.getDiscoveriesByType("similar_entity", 10)[0];
    db.updateDiscoveryStatus(row.id, "dismissed");
    await mgr.runSimilarEntityDetection();
    expect(db.getDiscoveriesByType("similar_entity", 10)).toHaveLength(0); // dismissed → not pending
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/similar-entity-orchestrator.test.ts`
Expected: FAIL — `runSimilarEntityDetection` is not a function; `getAliasesBySlugBulk`/`getEntityConceptQuality` undefined.

- [ ] **Step 3: Add the two bulk readers to sqlite.ts**

In `src/storage/sqlite.ts`, add these methods on `CBrainDB` (place near `findEmptyShells`, around line 1639):

```ts
  /** Bulk alias loader: rows of (page_slug, alias). Caller groups + normalizes. (#246) */
  getAliasesBySlugBulk(): Array<{ page_slug: string; alias: string }> {
    return this.prepare("SELECT page_slug, alias FROM aliases").all() as Array<{ page_slug: string; alias: string }>;
  }

  /**
   * Bulk entity/concept quality signals for similar-entity detection (#246).
   * pages has no summary column; completeness comes from chunks.
   */
  getEntityConceptQuality(): Array<{
    slug: string; mention_count: number; alias_count: number; tag_count: number; body_chars: number; chunk_count: number;
  }> {
    return this.prepare(`
      SELECT p.slug,
             p.mention_count AS mention_count,
             COALESCE(a.c, 0) AS alias_count,
             COALESCE(t.c, 0) AS tag_count,
             COALESCE(c.body_chars, 0) AS body_chars,
             COALESCE(c.chunk_count, 0) AS chunk_count
      FROM pages p
      LEFT JOIN (SELECT page_slug, COUNT(*) c FROM aliases GROUP BY page_slug) a ON a.page_slug = p.slug
      LEFT JOIN (SELECT page_slug, COUNT(*) c FROM tags GROUP BY page_slug) t ON t.page_slug = p.slug
      LEFT JOIN (SELECT page_slug, SUM(length(content)) body_chars, COUNT(*) chunk_count FROM chunks GROUP BY page_slug) c ON c.page_slug = p.slug
      WHERE p.type LIKE 'entity/%' OR p.type LIKE 'concept/%'
    `).all() as Array<{ slug: string; mention_count: number; alias_count: number; tag_count: number; body_chars: number; chunk_count: number }>;
  }
```

- [ ] **Step 4: Add similar_entity to DiscoveryType + imports in discovery.ts**

In `src/core/maintenance/discovery.ts`, change the union (line 5) to:

```ts
export type DiscoveryType = "bridge" | "trend" | "gap" | "contradiction" | "similar_entity";
```

Add imports after the existing imports (after line 3):

```ts
import { getOntology } from "../ontology/loader.js";
import { normalizeForComparison } from "./name-similarity.js";
import {
  detectSimilarEntities,
  type DetectorInput, type DetectorPage, type PageQuality,
} from "./similar-entity-detector.js";
```

- [ ] **Step 5: Add runSimilarEntityDetection() to DiscoveryManager**

Add this method on the `DiscoveryManager` class (place after `runDiscovery`, before `detectBridges`):

```ts
  /**
   * #246 — On-demand similar-entity detection lane. Structurally separate from
   * runDiscovery(): runDiscovery NEVER calls this. Builds DetectorInput in bulk,
   * runs the pure detector, and feeds results through the existing dedup →
   * upsertDiscovery loop. Persists candidates only; merges nothing.
   */
  async runSimilarEntityDetection(): Promise<DiscoveryReport> {
    this.llmBudget = MAX_LLM_BUDGET;
    const byType: Record<string, number> = {};
    const byActionable: Record<string, number> = { high: 0, medium: 0, low: 0 };
    const highActionable: DetectionResult[] = [];
    const empty: DiscoveryReport = { total: 0, byType, byActionable, highActionable, enrichment: { skipped: true, reason: "no_candidates", llmAvailable: !!this.llm, attempted: 0, saved: 0, errors: 0 } };

    const entityPages = this.db.getEntityConceptPages();
    if (entityPages.length < 2) return empty;

    // registeredAliasesBySlug: aliases table only, normalized, NO own title.
    const registeredAliasesBySlug = new Map<string, Set<string>>();
    for (const { page_slug, alias } of this.db.getAliasesBySlugBulk()) {
      const norm = normalizeForComparison(alias);
      if (!norm) continue;
      const set = registeredAliasesBySlug.get(page_slug);
      if (set) set.add(norm); else registeredAliasesBySlug.set(page_slug, new Set([norm]));
    }

    // qualityBySlug + linkDegree.
    const qualityBySlug = new Map<string, PageQuality>();
    const adj = this.buildAdjacency();
    for (const row of this.db.getEntityConceptQuality()) {
      const linkDegree = adj.get(row.slug)?.size ?? 0;
      qualityBySlug.set(row.slug, {
        isStub: row.mention_count === 0 && linkDegree === 0 && row.alias_count === 0 && row.tag_count === 0,
        bodyChars: row.body_chars,
        chunkCount: row.chunk_count,
        mentionCount: row.mention_count,
        aliasCount: row.alias_count,
        tagCount: row.tag_count,
      });
    }
    const linkDegree = new Map<string, number>();
    for (const [slug, neighbors] of adj) linkDegree.set(slug, neighbors.size);

    const detectorInput: DetectorInput = {
      pages: entityPages as DetectorPage[],
      registeredAliasesBySlug,
      linkDegree,
      qualityBySlug,
      areTypesAffine: (a, b) => getOntology().areTypesAffine(a, b),
    };
    const report = detectSimilarEntities(detectorInput);

    const seen = new Set<string>();
    let newCount = 0;
    for (const c of report.candidates) {
      const key = [c.slugA, c.slugB].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const metadata: Record<string, unknown> = {
        match_kind: c.matchKind,
        name_score: c.nameScore,
        type_gate: c.typeGate,
        reason_code: c.reasonCode,
      };
      if (c.editDistance !== undefined) metadata.edit_distance = c.editDistance;
      if (c.recommendedTarget) metadata.recommended_target = c.recommendedTarget;
      if (c.ambiguousTarget) metadata.ambiguous_target = true;
      if (c.sharedAlias) metadata.shared_alias = c.sharedAlias;

      const { id, inserted } = this.db.upsertDiscovery(
        "similar_entity", [c.slugA, c.slugB], c.nameScore,
        undefined, undefined, c.actionable, false, metadata,
      );
      if (!inserted) continue;
      newCount++;
      byType.similar_entity = (byType.similar_entity ?? 0) + 1;
      byActionable[c.actionable]++;
      if (c.actionable === "high") {
        const r: DetectionResult = {
          type: "similar_entity", entities: [c.slugA, c.slugB], score: c.nameScore,
          metadata, actionable: "high",
        };
        r._dbId = id;
        highActionable.push(r);
      }
    }

    this.logger?.info("discovery", `similar_entity: ${newCount} 个新候选 (truncated=${report.truncated})`);
    return {
      total: newCount, byType, byActionable, highActionable,
      enrichment: { skipped: true, reason: "no_enrichment", llmAvailable: !!this.llm, attempted: 0, saved: 0, errors: 0 },
    };
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/core/similar-entity-orchestrator.test.ts`
Expected: PASS (3 tests). Note: `upsertPage` must accept a `mentionCount` field — if the field name differs, check `upsertPage`'s signature and use the correct one (e.g. `mentions`).

- [ ] **Step 7: Verify runDiscovery is untouched (default-exclusion guarantee)**

Run: `bun test tests/core/discovery.test.ts`
Expected: PASS — existing discovery behavior unchanged.

- [ ] **Step 8: Lint**

Run: `bun run lint`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/core/maintenance/discovery.ts src/storage/sqlite.ts tests/core/similar-entity-orchestrator.test.ts
git commit -m "feat(discovery): runSimilarEntityDetection orchestrator + bulk loaders (#246)"
```

---

## Task 6: discovery-digest.ts — similar_entity card + default-digest exclusion

**Files:**
- Modify: `src/core/maintenance/discovery-digest.ts` (`formatDigestCard` case; `isDigestExcluded` helper)
- Modify: `src/mcp/tools/discoveries.ts` (use `isDigestExcluded` in the unseen-feed filter)
- Create: `tests/core/similar-entity-digest.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/core/similar-entity-digest.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { formatDigestCard, shouldFilterDiscovery, isDigestExcluded } from "../../src/core/maintenance/discovery-digest.js";

const lookup = (slug: string) => ({ title: slug.replace("entity/", ""), type: "entity/company" });

function similarRow(slugA: string, slugB: string, actionable = "high"): any {
  return {
    id: 1, type: "similar_entity",
    entities: JSON.stringify([slugA, slugB]),
    score: 1.0, detail: null, detected_at: "2026-06-30", actionable,
    suggestion: null, proposed_actions: null, auto_applicable: 0,
    metadata: JSON.stringify({ match_kind: "name_exact", recommended_target: slugA }),
  };
}

describe("similar_entity digest", () => {
  test("isDigestExcluded flags similar_entity for the default feed", () => {
    expect(isDigestExcluded("similar_entity")).toBe(true);
    expect(isDigestExcluded("bridge")).toBe(false);
  });

  test("shouldFilterDiscovery lets similar_entity through (review-only, no suggestion required)", () => {
    expect(shouldFilterDiscovery(similarRow("entity/a", "entity/b"))).toBeNull();
  });

  test("formatDigestCard produces natural-language text, hides raw score/slug internals", () => {
    const card = formatDigestCard(similarRow("entity/a", "entity/b"), lookup);
    expect(card.title).toContain("可能重复");
    expect(card.suggested_action).toContain("merge_entities");
    // display text must not leak raw score or internal field names
    expect(card.evidence).not.toContain("name_score");
    expect(card.evidence).not.toContain("recommended_target");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/core/similar-entity-digest.test.ts`
Expected: FAIL — `isDigestExcluded` not exported; `formatDigestCard` returns the default "待确认发现" case for `similar_entity`.

- [ ] **Step 3: Add isDigestExcluded + similar_entity card case**

In `src/core/maintenance/discovery-digest.ts`, add an exported helper near `shouldFilterDiscovery`:

```ts
/**
 * #246 — Types excluded from the DEFAULT discovery digest feed (daily run_discovery
 * digest, default read_discoveries). similar_entity is a governance/cleanup lane and
 * must not pollute the insight digest. KM types were already excluded upstream.
 */
export function isDigestExcluded(type: string): boolean {
  return type === "similar_entity";
}
```

Add a `case "similar_entity"` inside the `switch (r.type)` in `formatDigestCard` (before the `default` case):

```ts
    case "similar_entity": {
      const [a, b] = slugs;
      const titleA = resolveTitle(a, entityLookup);
      const titleB = resolveTitle(b, entityLookup);
      const matchKind = meta.match_kind as string | undefined;
      const kindLabel =
        matchKind === "alias_shadow_page" ? "名称已是别名的残留页"
        : matchKind === "shared_alias" ? "共享别名"
        : matchKind === "name_exact" ? "名称相同"
        : matchKind === "name_normalized" ? "名称仅大小写/标点不同"
        : matchKind === "name_substring" ? "名称相互包含"
        : matchKind === "edit_distance" ? "名称仅有细微拼写差异"
        : "名称高度相似";
      return {
        id: r.id,
        title: `可能重复：${titleA} 与 ${titleB}`,
        why_it_matters: `两条记忆${kindLabel}，类型相同或相近，疑似指向同一对象，合并前请核对。`,
        evidence: `${kindLabel}（置信度：${r.actionable === "high" ? "高" : "中"}）。`,
        suggested_action: "用 merge_entities 先 dry-run 核对，确认后再执行合并。",
      };
    }
```

- [ ] **Step 4: Wire isDigestExcluded into the MCP unseen-feed filter**

In `src/mcp/tools/discoveries.ts`, import `isDigestExcluded`:

```ts
import { formatDiscoveryDigest, formatKnowledgeMapSurface, isDigestExcluded } from "../../core/maintenance/discovery-digest.js";
```

In the `run_discovery` handler, change the line that filters KM types out of `newRows`:

```ts
    const normalRows = newRows.filter(r => !KM_TYPES.has(r.type) && !isDigestExcluded(r.type));
```

(Keep the existing KM filter; add `&& !isDigestExcluded(r.type)`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/core/similar-entity-digest.test.ts tests/mcp/discoveries.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint**

Run: `bun run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/maintenance/discovery-digest.ts src/mcp/tools/discoveries.ts tests/core/similar-entity-digest.test.ts
git commit -m "feat(discovery): similar_entity digest card + default-feed exclusion (#246)"
```

---

## Task 7: MCP find_similar_entities + read_discoveries enum + run_discovery routing

**Files:**
- Modify: `src/mcp/tools/discoveries.ts` (register `find_similar_entities`; add `similar_entity` to enums; handler-layer routing in `run_discovery`)
- Create: `tests/mcp/find-similar-entities.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/mcp/find-similar-entities.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { registerDiscoveryTools } from "../../src/mcp/tools/discoveries.js";
import type { ToolContext } from "../../src/mcp/context.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Minimal McpServer stub: captures registered tools by name.
function makeServer(): { server: McpServer; tools: Map<string, (args: any) => Promise<any>> } {
  const tools = new Map<string, (args: any) => Promise<any>>();
  const server = {
    registerTool(name: string, _def: unknown, handler: (args: any) => Promise<any>) {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  return { server, tools };
}

describe("MCP find_similar_entities (#246)", () => {
  const testDir = "/tmp/cbrain-test-find-similar";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB; let ctx: ToolContext; let tools: Map<string, (args: any) => Promise<any>>;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    ctx = { db } as unknown as ToolContext;
    const s = makeServer();
    registerDiscoveryTools(s.server, ctx);
    tools = s.tools;
  });
  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function seedPage(slug: string, title: string, type = "entity/company", mentionCount = 0): void {
    db.upsertPage({ slug, type, title, filePath: `${slug}.md`, contentHash: slug, mentionCount });
  }

  test("persists by default and returns review candidates with slugs in raw", async () => {
    seedPage("entity/a", "实体A", "entity/company", 3);
    seedPage("entity/b", "实体A", "entity/company", 1);
    const res = await tools.get("find_similar_entities")!({ limit: 20 });
    const payload = JSON.parse(res.content[0].text);
    expect(payload.candidates.length).toBe(1);
    const c = payload.candidates[0];
    expect(c.slug_a).toBe("entity/a");
    expect(c.slug_b).toBe("entity/b");
    expect(c.match_kind).toBe("name_exact");
    expect(payload.display).toContain("可能重复");
    expect(payload.display).not.toContain("name_score");
    expect(db.getDiscoveriesByType("similar_entity", 10)).toHaveLength(1);
  });

  test("dryRun writes nothing", async () => {
    seedPage("entity/a", "实体A");
    seedPage("entity/b", "实体A");
    await tools.get("find_similar_entities")!({ dryRun: true });
    expect(db.getDiscoveriesByType("similar_entity", 10)).toHaveLength(0);
  });

  test("display hides slugs; raw includes recommended_target", async () => {
    seedPage("entity/a", "实体A", "entity/company", 5);
    seedPage("entity/b", "实体A", "entity/company", 1);
    const res = await tools.get("find_similar_entities")!({});
    const payload = JSON.parse(res.content[0].text);
    expect(payload.display).not.toContain("entity/a");
    expect(payload.candidates[0].recommended_target).toBe("entity/a");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/mcp/find-similar-entities.test.ts`
Expected: FAIL — `find_similar_entities` tool not registered.

- [ ] **Step 3: Add similar_entity to read_discoveries/run_discovery enums**

In `src/mcp/tools/discoveries.ts`:
- In `read_discoveries` `typeFilter` enum, append `"similar_entity"`:
  ```ts
  typeFilter: z.enum(["bridge", "trend", "gap", "contradiction", "knowledge_map_isolation", "knowledge_map_bridge", "similar_entity"]).optional()
  ```
- In `run_discovery` `types` enum, append `"similar_entity"`:
  ```ts
  types: z.array(z.enum(["bridge", "trend", "gap", "contradiction", "similar_entity"])).optional()
  ```

- [ ] **Step 4: Route similar_entity at the run_discovery handler layer**

In the `run_discovery` handler, replace the report-construction block with handler-layer routing. After the line `const requested = types as DiscoveryType[] | undefined;`, change the flow to:

```ts
    const wantsSimilar = requested?.includes("similar_entity") ?? false;
    const normalRequested = requested ? requested.filter(t => t !== "similar_entity") : undefined;

    const fastTypes: DiscoveryType[] = normalRequested
      ? normalRequested.filter(t => t !== "contradiction")
      : ["bridge", "trend", "gap"];
    const runContradiction = normalRequested?.includes("contradiction") ?? false;

    const discoveryMgr = new DiscoveryManager(ctx.db, ctx.llm);
    const report = await discoveryMgr.runDiscovery(runContradiction ? undefined : fastTypes);
    if (wantsSimilar) {
      const simReport = await discoveryMgr.runSimilarEntityDetection();
      report.total += simReport.total;
      for (const [k, v] of Object.entries(simReport.byType)) report.byType[k] = (report.byType[k] ?? 0) + v;
      for (const [k, v] of Object.entries(simReport.byActionable)) report.byActionable[k] = (report.byActionable[k] ?? 0) + v;
      report.highActionable.push(...simReport.highActionable);
    }
```

Keep the rest of the handler unchanged. The digest below still reads `getUnseenDiscoveries` and excludes `similar_entity` via `isDigestExcluded`, so the user-facing digest stays clean even when both were requested.

- [ ] **Step 5: Register find_similar_entities tool**

In `registerDiscoveryTools`, add (e.g. after `run_discovery`):

```ts
  server.registerTool("find_similar_entities", {
    description:
      "查找可能重复的实体/概念页面对，供人工或 Agent 核对后通过 merge_entities 合并。" +
      "默认会把候选写入 discoveries 生命周期（dismissed/resolved 不会重复打扰）。" +
      "返回 display（用户可见自然语言）和 candidates（含 slug 与推荐合并目标，供调用 merge_entities）。" +
      "绝不自动合并或写别名。",
    inputSchema: {
      limit: z.number().optional().default(20).describe("Max candidates to return"),
      scope: z.enum(["entity", "concept"]).optional().describe("Restrict to slug namespace (entity/% or concept/%)"),
      dryRun: z.boolean().optional().default(false).describe("If true, do not persist candidates"),
    },
  }, async ({ limit, scope, dryRun }) => {
    const discoveryMgr = new DiscoveryManager(ctx.db, ctx.llm);
    const report = await discoveryMgr.runSimilarEntityDetection();
    void dryRun; // persistence default-on; dryRun handled by reading pending rows only when true
    const entityLookup = (slug: string) => ctx.db.getPage(slug);

    let rows = ctx.db.getDiscoveriesByType("similar_entity", Math.max(limit ?? 20, 20));
    if (scope === "entity") rows = rows.filter(r => {
      const [a] = JSON.parse(r.entities) as string[];
      return a.startsWith("entity/");
    });
    if (scope === "concept") rows = rows.filter(r => {
      const [a] = JSON.parse(r.entities) as string[];
      return a.startsWith("concept/");
    });

    const cards = rows.slice(0, limit ?? 20).map(r => formatDigestCard(r, entityLookup));
    const display = cards.length > 0
      ? cards.map(c => `### ${c.title}\n${c.why_it_matters}\n${c.evidence}\n**建议**：${c.suggested_action}`).join("\n\n---\n\n")
      : "暂无可能重复的实体。";

    const candidates = rows.slice(0, limit ?? 20).map(r => {
      const [a, b] = JSON.parse(r.entities) as string[];
      const meta = r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : {};
      return {
        slug_a: a, slug_b: b,
        match_kind: meta.match_kind ?? null,
        type_gate: meta.type_gate ?? null,
        recommended_target: meta.recommended_target ?? null,
        ambiguous_target: meta.ambiguous_target === true,
        confidence: r.actionable === "high" ? "高" : "中",
      };
    });

    const summary = candidates.length > 0
      ? `发现 ${candidates.length} 组可能重复的实体，请核对后用 merge_entities 合并。`
      : "暂无可能重复的实体。";

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ display, summary, candidates, result_summary: summary }, null, 2),
      }],
    };
  });
```

> Note on dryRun: `runSimilarEntityDetection` always upserts (lifecycle is the point of the tool). For a true no-write debug path, gate the upsert by adding a `dryRun` option to `runSimilarEntityDetection` in Task 5's method signature (`async runSimilarEntityDetection(options?: { dryRun?: boolean })`) and skip the `upsertDiscovery` loop when set — the detector still runs and returns candidates, but nothing is persisted. If you take this route, also surface candidates from the in-memory detector report instead of re-reading `getDiscoveriesByType`. Prefer this cleaner approach; the `void dryRun` above is a placeholder until the option is threaded.

- [ ] **Step 6: Thread dryRun through runSimilarEntityDetection (cleaner approach)**

Update `runSimilarEntityDetection` signature in `src/core/maintenance/discovery.ts`:

```ts
  async runSimilarEntityDetection(options: { dryRun?: boolean } = {}): Promise<DiscoveryReport & { candidates?: import("./similar-entity-detector.js").SimilarEntityCandidate[] }> {
```

Inside, after `const report = detectSimilarEntities(detectorInput);`, if `options.dryRun`, return early with the in-memory candidates and skip the upsert loop:

```ts
    if (options.dryRun) {
      return {
        total: report.candidates.length, byType: { similar_entity: report.candidates.length },
        byActionable: { high: 0, medium: 0, low: 0 }, highActionable: [],
        enrichment: { skipped: true, reason: "dry_run", llmAvailable: !!this.llm, attempted: 0, saved: 0, errors: 0 },
        candidates: report.candidates,
      };
    }
```

(Count byActionable over `report.candidates` for accuracy in the dry-run branch.) Then in `find_similar_entities` (Step 5), when `dryRun` is true, build `candidates` from `report.candidates` (the in-memory list) instead of `getDiscoveriesByType`; otherwise read persisted rows as in Step 5. Remove the `void dryRun` placeholder.

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test tests/mcp/find-similar-entities.test.ts tests/mcp/discoveries.test.ts`
Expected: PASS.

- [ ] **Step 8: Lint**

Run: `bun run lint`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/mcp/tools/discoveries.ts src/core/maintenance/discovery.ts tests/mcp/find-similar-entities.test.ts
git commit -m "feat(mcp): find_similar_entities tool + run_discovery similar_entity routing (#246)"
```

---

## Task 8: CLI cbrain similar-entities

**Files:**
- Modify: `src/cli/commands/maintenance.ts` (add `similar-entities` command, sibling to `dedup-types`)
- Create: `tests/cli/similar-entities.test.ts`

- [ ] **Step 1: Read the dedup-types command for the pattern**

Run: `grep -n "dedup-types" -A 40 src/cli/commands/maintenance.ts`
Confirm the option/action shape (`--dry-run`, `--execute`, `--type`).

- [ ] **Step 2: Write failing test**

Create `tests/cli/similar-entities.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { DiscoveryManager } from "../../src/core/maintenance/discovery.js";

describe("CLI similar-entities (dry-run default) (#246)", () => {
  const testDir = "/tmp/cbrain-test-cli-similar";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
  });
  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("dry-run detection writes nothing to discoveries", async () => {
    db.upsertPage({ slug: "entity/a", type: "entity/company", title: "实体A", filePath: "a.md", contentHash: "a", mentionCount: 3 });
    db.upsertPage({ slug: "entity/b", type: "entity/company", title: "实体A", filePath: "b.md", contentHash: "b", mentionCount: 1 });
    const mgr = new DiscoveryManager(db);
    const report = await mgr.runSimilarEntityDetection({ dryRun: true });
    expect(report.total).toBe(1);
    expect(db.getDiscoveriesByType("similar_entity", 10)).toHaveLength(0); // dry-run → nothing persisted
  });

  test("execute persists", async () => {
    db.upsertPage({ slug: "entity/a", type: "entity/company", title: "实体A", filePath: "a.md", contentHash: "a" });
    db.upsertPage({ slug: "entity/b", type: "entity/company", title: "实体A", filePath: "b.md", contentHash: "b" });
    const mgr = new DiscoveryManager(db);
    await mgr.runSimilarEntityDetection(); // execute path
    expect(db.getDiscoveriesByType("similar_entity", 10)).toHaveLength(1);
  });
});
```

> This test exercises the `runSimilarEntityDetection({dryRun:true})` contract the CLI relies on. A full CLI-invocation test (spawning the commander binary) is optional; the unit contract above is the gate.

- [ ] **Step 3: Run test to verify it fails (dry-run branch)**

Run: `bun test tests/cli/similar-entities.test.ts`
Expected: The "execute persists" test passes; the "dry-run writes nothing" test FAILS until Task 7 Step 6's `dryRun` option is in place. If Task 7 already landed dryRun, both pass — confirm.

- [ ] **Step 4: Add the similar-entities command**

In `src/cli/commands/maintenance.ts`, add a sibling command near `dedup-types` (around line 1147). Mirror its option shape:

```ts
  // ─── similar-entities: detect duplicate entity/concept candidates (#246) ──
  program
    .command("similar-entities")
    .description("Detect likely-duplicate entity/concept pages for review (no auto-merge)")
    .option("--dry-run", "Print candidates without persisting (default)")
    .option("--execute", "Persist candidates to the discoveries lifecycle")
    .option("--scope <scope>", "Restrict to entity or concept namespace")
    .action(async (opts) => {
      const config = loadConfig();
      const db = new CBrainDB(config.dbPath);
      const logger = makeLogger?.(config); // use the same logger factory the file already uses; match existing sibling commands
      const mgr = new DiscoveryManager(db, undefined, logger);
      const dryRun = !opts.execute;
      const report = await mgr.runSimilarEntityDetection({ dryRun });

      const candidates = report.candidates ?? [];
      const visible = opts.scope
        ? candidates.filter((c) => (opts.scope === "entity" ? c.slugA.startsWith("entity/") : c.slugA.startsWith("concept/")))
        : candidates;

      if (visible.length === 0) {
        console.log(dryRun ? "No similar entities found." : "No new similar-entity candidates persisted.");
        db.close();
        return;
      }

      console.log(`${dryRun ? "[dry-run] " : ""}${visible.length} similar-entity candidate(s):${dryRun ? " (not persisted)" : ""}`);
      for (const c of visible) {
        const ta = db.getPage(c.slugA)?.title ?? c.slugA;
        const tb = db.getPage(c.slugB)?.title ?? c.slugB;
        const target = c.recommendedTarget ? ` → target: ${c.recommendedTarget}` : c.ambiguousTarget ? " → ambiguous target" : "";
        console.log(`  ${ta}  ⟷  ${tb}   [${c.matchKind} / ${c.actionable}]${target}`);
      }
      db.close();
    });
```

> Match the exact logger factory + `loadConfig` import the surrounding `dedup-types` command uses (read those lines at edit time and reuse the same names — do not invent a new factory).

- [ ] **Step 5: Run the CLI test + a manual dry-run**

Run: `bun test tests/cli/similar-entities.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint**

Run: `bun run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/maintenance.ts tests/cli/similar-entities.test.ts
git commit -m "feat(cli): cbrain similar-entities command (#246)"
```

---

## Task 9: full gate + anonymous-fixture audit + spec coverage

**Files:** none (verification + audit only)

- [ ] **Step 1: Run the full project gate**

Run: `bun run check`
Expected: PASS (tsc + biome + full `bun test`, 0 fail).

- [ ] **Step 2: Anonymous-placeholder audit**

Run: `bun test tests/core/similar-entity-detector.test.ts tests/core/similar-entity-orchestrator.test.ts tests/mcp/find-similar-entities.test.ts tests/cli/similar-entities.test.ts -v`
Visually confirm fixtures use only `实体A`/`实体B`/`组织C`/`主题D`/`共享别名`/`Alpha`/`Claude`-style synthetic tokens. No real person/org/product/company names, paths, or emails — not even in negative assertions.

- [ ] **Step 3: Spec coverage self-check (map each acceptance criterion to a test)**

| Acceptance criterion | Covered by |
|---|---|
| 1. same-type title variants → one candidate | Task 2 "identical-title" + Task 3 "name_normalized" |
| 2. normalized variants → high | Task 3 "name_normalized → high" |
| 3. similar-but-different not high | Task 2 type-gate + actionable mapping (edit_distance = medium) |
| 4. record/source ignored | orchestrator uses `getEntityConceptPages` (entity/% + concept/% only) |
| 5. alias-shadow detected high | Task 3 "alias_shadow_page" |
| 6. dismissed not resurrected | Task 5 "dismissed candidate does NOT resurrect" |
| 7. stable dedup across runs | Task 5 "re-running does not duplicate" |
| 8. default digest/read excludes | Task 6 `isDigestExcluded` + runDiscovery untouched (Task 5 Step 7) |
| 9. dry-run writes nothing | Task 7 "dryRun writes nothing" + Task 8 dry-run test |
| 9b. execute writes only discovery candidate | no alias/page/link/tag write calls anywhere in new code |
| 10. display hides internals | Task 6 + Task 7 "display hides slugs" |
| 11. merge_entities only path | no new executor introduced; suggested_action points to merge_entities |
| 12. anonymous placeholders | Task 9 Step 2 |
| 13. ambiguous on 1-5 tie | Task 4 "ambiguous_target" |

- [ ] **Step 4: grep audit — no auto-merge / auto-alias / page-link writes in new code**

Run:
```bash
git diff main -- src/core/ingestion/similar-entity-detector.ts src/core/maintenance/discovery.ts src/mcp/tools/discoveries.ts src/cli/commands/maintenance.ts | grep -nE "addAlias|upsertPage|insertLink|addLink|upsertLink|mergeEntities|batchMerge" || echo "CLEAN: no write/merge calls added in detection path"
```
Expected: `CLEAN` (the only writes are `upsertDiscovery` for discovery rows). `merge_entities`/`batch_merge_pages` are referenced in suggestion text only, not invoked.

- [ ] **Step 5: Final review hand-off**

Run: `git diff main --stat && git log main..HEAD --oneline`
Confirm: every commit is green, the spec (commit e5229fb) matches the implementation, no real names in the diff. Do NOT push, do NOT close the issue — hand off to 宏哥.

---

## Non-goals honored (Phase 1)

No semantic embedding strategy · no `SIMILAR_TO` relation · no MinHash · no LanceDB migration · no record/source merging · no bulk confirm into `batch_merge_pages` · no auto stub deletion.

## Self-Review

**Spec coverage:** all 13 acceptance criteria mapped in Task 9 Step 3. Every spec section (strategies, alias rule, type gate, blocking, caps, canonical scoring, ambiguous rule, persistence, surface exclusion, surfaces, display/raw) has an implementing task.

**Placeholder scan:** one intentional `void dryRun` placeholder in Task 7 Step 5, explicitly resolved in Task 7 Step 6 (thread `dryRun` through `runSimilarEntityDetection`). No other TBD/TODO/"add appropriate".

**Type consistency:** `SimilarMatchKind`, `DetectorInput`, `PageQuality`, `SimilarEntityCandidate`, `DetectorReport` defined in Task 2 and consumed unchanged in Tasks 3-8. `runSimilarEntityDiscovery` → `runSimilarEntityDetection` (consistent). `recommendedTarget` / `ambiguousTarget` / `sharedAlias` / `editDistance` field names match across detector, orchestrator metadata (`recommended_target` / `ambiguous_target` / `shared_alias` / `edit_distance`), and MCP output. `isDigestExcluded` defined + exported in Task 6 and imported in Task 6 Step 4 and reused.

**Open risks (carry into execution):**
1. `upsertPage` field name for mention count — Task 5 Step 6 flags to verify (`mentionCount` vs `mentions`).
2. `find_similar_entities` dry-run path (Task 7 Steps 5-6) — the cleaner approach threads `dryRun` through the orchestrator; ensure both the dry-run and persisted branches return the same candidate shape.
3. Logger factory name in the CLI command (Task 8 Step 4) — mirror `dedup-types` exactly; do not invent.
4. `MAX_PAIRS_EVALUATED` vs realistic vault size (Open risk #1 from spec) — if a real vault truncates immediately, raise the cap or tighten `tokenizeForBlocking`; never silently truncate without `truncated:true`.
