import { describe, expect, test } from "bun:test";
import {
  ACTION_CANDIDATE_TYPES,
  isActionCandidateType,
  assertSafeActionDisplay,
  buildActionCandidatesFromDiscoveries,
} from "../../src/core/maintenance/action-candidates.js";

describe("action candidate core helpers (#267)", () => {
  test("recognizes all action candidate types", () => {
    expect(ACTION_CANDIDATE_TYPES).toEqual([
      "action_review_discovery",
      "action_health_review",
      "action_repair_preview",
    ]);
    expect(isActionCandidateType("action_review_discovery")).toBe(true);
    expect(isActionCandidateType("action_health_review")).toBe(true);
    expect(isActionCandidateType("action_repair_preview")).toBe(true);
    expect(isActionCandidateType("gap")).toBe(false);
  });

  test("display guard rejects internal identifiers and debug terms", () => {
    expect(assertSafeActionDisplay("有一项健康问题需要人工确认。")).toBeUndefined();
    expect(() => assertSafeActionDisplay("score=0.9")).toThrow(/unsafe display/i);
    expect(() => assertSafeActionDisplay("dedup_key=abc")).toThrow(/unsafe display/i);
    expect(() => assertSafeActionDisplay("entity/private-a")).toThrow(/unsafe display/i);
    expect(() => assertSafeActionDisplay("/Users/example/private")).toThrow(/unsafe display/i);
    expect(() => assertSafeActionDisplay("SELECT * FROM pages")).toThrow(/unsafe display/i);
  });
});

describe("buildActionCandidatesFromDiscoveries (#267)", () => {
  test("creates one review candidate for high actionable discovery", () => {
    const drafts = buildActionCandidatesFromDiscoveries([
      {
        id: 7,
        type: "similar_entity",
        entities: JSON.stringify(["entity/a", "entity/b"]),
        score: 0.9,
        actionable: "high",
        auto_applicable: 0,
        occurrence_count: 1,
        dedup_key: "similar_entity|entity/a|entity/b",
        metadata: JSON.stringify({ reason_code: "name_exact" }),
      },
    ]);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].type).toBe("action_review_discovery");
    expect(drafts[0].entities).toEqual(["discovery:similar_entity|entity/a|entity/b"]);
    expect(drafts[0].actionable).toBe("high");
    expect(drafts[0].metadata.source_type).toBe("similar_entity");
    expect(drafts[0].evidence[0]).toEqual({
      source: "discovery",
      ref: "discovery:similar_entity|entity/a|entity/b",
      kind: "similar_entity",
    });
    expect(drafts[0].proposedActions[0].type).toBe("review");
    expect(drafts[0].displayTitle).not.toContain("entity/");
    expect(drafts[0].displayReason).not.toContain("score");
  });

  test("creates review candidate for repeated medium discovery", () => {
    const drafts = buildActionCandidatesFromDiscoveries([
      {
        id: 8,
        type: "gap",
        entities: JSON.stringify(["entity/a"]),
        score: 0.5,
        actionable: "medium",
        auto_applicable: 0,
        occurrence_count: 3,
        dedup_key: "gap|entity/a",
      },
    ]);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].actionable).toBe("medium");
    expect(drafts[0].metadata.occurrence_count).toBe(3);
  });

  test("skips low-signal non-repeated discovery", () => {
    const drafts = buildActionCandidatesFromDiscoveries([
      {
        id: 9,
        type: "bridge",
        entities: JSON.stringify(["entity/a", "entity/b"]),
        score: 0.2,
        actionable: "low",
        auto_applicable: 0,
        occurrence_count: 1,
        dedup_key: "bridge|entity/a|entity/b",
      },
    ]);

    expect(drafts).toHaveLength(0);
  });

  test("skips already action candidate rows", () => {
    const drafts = buildActionCandidatesFromDiscoveries([
      {
        id: 10,
        type: "action_review_discovery",
        entities: JSON.stringify(["discovery:x"]),
        score: 1,
        actionable: "high",
        auto_applicable: 0,
        occurrence_count: 3,
        dedup_key: "action_review_discovery|discovery:x",
      },
    ]);

    expect(drafts).toHaveLength(0);
  });
});
