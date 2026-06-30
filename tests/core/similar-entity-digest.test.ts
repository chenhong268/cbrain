import { describe, test, expect } from "bun:test";
import { formatDigestCard, shouldFilterDiscovery, isDigestExcluded } from "../../src/core/discovery-digest.js";

const lookup = (slug: string) => ({ title: slug.replace("entity/", ""), type: "entity/company" });

function similarRow(slugA: string, slugB: string, actionable = "high"): {
  id: number; type: string; entities: string; score: number; detail: string | null;
  detected_at: string; actionable: string; suggestion: string | null;
  proposed_actions: string | null; auto_applicable: number; metadata: string | null;
} {
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
    expect(card.evidence).not.toContain("name_score");
    expect(card.evidence).not.toContain("recommended_target");
  });
});
