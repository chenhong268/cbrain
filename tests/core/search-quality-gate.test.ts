import { describe, test, expect } from "bun:test";
import {
  isBareStubCandidate,
  applyRecallQualityGate,
  RECALL_MIN_SCORE,
  BARE_STUB_PENALTY,
  type PageLike,
} from "../../src/core/retrieval/search.js";
import type { SearchResult } from "../../src/core/retrieval/search.js";

const sr = (slug: string, score: number, source: SearchResult["source"] = "hybrid"): SearchResult =>
  ({ slug, score, snippet: "", source });

const page = (tier: number, type: string, mention_count: number): PageLike =>
  ({ tier, type, mention_count });

describe("isBareStubCandidate (#230)", () => {
  test("tier-3 entity with ≤1 link and ≤1 mention is bare", () => {
    expect(isBareStubCandidate(page(3, "entity/person", 1), 1)).toBe(true);
    expect(isBareStubCandidate(page(3, "concept/concept", 0), 0)).toBe(true);
  });

  test("rich page (many links/mentions) is not bare", () => {
    expect(isBareStubCandidate(page(3, "entity/person", 5), 10)).toBe(false);
    expect(isBareStubCandidate(page(3, "entity/person", 1), 5)).toBe(false);
  });

  test("high-tier page is not bare", () => {
    expect(isBareStubCandidate(page(1, "entity/person", 1), 0)).toBe(false);
    expect(isBareStubCandidate(page(2, "entity/person", 0), 0)).toBe(false);
  });

  test("non entity/concept type is not bare", () => {
    expect(isBareStubCandidate(page(3, "record", 0), 0)).toBe(false);
  });

  test("tier-3 entity with many graph links is NOT bare (structurally connected)", () => {
    // #230 regression: a tier-3 / low-mention entity that is well-linked must
    // not be misclassified as bare just because tier/mention are low.
    expect(isBareStubCandidate(page(3, "entity/person", 1), 5)).toBe(false);
    expect(isBareStubCandidate(page(3, "entity/person", 0), 2)).toBe(false);
  });
});

describe("applyRecallQualityGate (#230)", () => {
  test("filters low-score non-exact results below threshold", () => {
    const results = [sr("a", 0.5), sr("b", RECALL_MIN_SCORE / 3)];
    const gate = applyRecallQualityGate(results, { pagesBySlug: new Map() });
    expect(gate.results.map(r => r.slug)).toEqual(["a"]);
    expect(gate.filteredCount).toBe(1);
    expect(gate.reasonCodes).toContain("low_relevance_filtered");
  });

  test("exact match bypasses low-relevance filter", () => {
    const results = [sr("exact", 1.0, "exact"), sr("b", RECALL_MIN_SCORE / 3)];
    const gate = applyRecallQualityGate(results, { pagesBySlug: new Map() });
    expect(gate.results.map(r => r.slug)).toEqual(["exact"]);
    expect(gate.filteredCount).toBe(1);
  });

  test("exactSlugs set bypasses filter even for non-exact source", () => {
    const results = [sr("promoted", 0.005, "hybrid")];
    const gate = applyRecallQualityGate(results, {
      pagesBySlug: new Map(),
      exactSlugs: new Set(["promoted"]),
    });
    expect(gate.results.map(r => r.slug)).toEqual(["promoted"]);
  });

  test("bare tier-3 stub demoted below richer page with comparable relevance", () => {
    const results = [sr("bare", 0.2), sr("rich", 0.2)];
    const pagesBySlug = new Map<string, PageLike>([
      ["bare", page(3, "entity/person", 1)],
      ["rich", page(1, "entity/person", 10)],
    ]);
    const gate = applyRecallQualityGate(results, {
      pagesBySlug,
      linkCounts: new Map([["bare", 1], ["rich", 8]]),
    });
    // both above threshold, both kept, but bare demoted to second
    expect(gate.results.map(r => r.slug)).toEqual(["rich", "bare"]);
    expect(gate.results[1].score).toBeCloseTo(0.2 * BARE_STUB_PENALTY, 5);
    expect(gate.filteredCount).toBe(0);
  });

  test("bare demotion can push a stub below threshold (filtered)", () => {
    const bareScore = RECALL_MIN_SCORE + 0.005; // above threshold pre-penalty, below after
    const results = [sr("bare", bareScore)];
    const pagesBySlug = new Map<string, PageLike>([["bare", page(3, "entity/person", 1)]]);
    const gate = applyRecallQualityGate(results, { pagesBySlug, linkCounts: new Map([["bare", 1]]) });
    expect(gate.results).toHaveLength(0);
    expect(gate.reasonCodes).toContain("low_relevance_filtered");
  });

  test("empty input returns empty", () => {
    const gate = applyRecallQualityGate([], { pagesBySlug: new Map() });
    expect(gate.results).toEqual([]);
    expect(gate.filteredCount).toBe(0);
  });
});
