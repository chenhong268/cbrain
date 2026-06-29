import { describe, test, expect } from "bun:test";
import {
  shouldFilterDiscovery,
  formatDigestCard,
  formatDiscoveryDigest,
  formatKnowledgeMapSurface,
} from "../../src/core/discovery-digest.js";
import type { DiscoveryRow } from "../../src/core/discovery-digest.js";

function mockRow(overrides: Partial<DiscoveryRow> = {}): DiscoveryRow {
  return {
    id: 1,
    type: "bridge",
    entities: '["entities/person-a", "entities/org-c"]',
    score: 0.8,
    detail: null,
    detected_at: "2026-06-02T10:00:00Z",
    actionable: "high",
    suggestion: null,
    proposed_actions: null,
    auto_applicable: 0,
    metadata: null,
    ...overrides,
  };
}

const entityLookup = (slug: string) => {
  const map: Record<string, { title: string; type: string }> = {
    "entities/person-a": { title: "人物A", type: "entity/person" },
    "entities/person-b": { title: "人物B", type: "entity/person" },
    "entities/org-c": { title: "组织C", type: "entity/organization" },
    "concepts/topic-d": { title: "主题D", type: "concept/concept" },
    "records/event-e": { title: "事件E", type: "record" },
  };
  return map[slug] ?? null;
};

const BANNED_WORDS = [
  "score", "hops", "shared_neighbors", "distance",
  "图距离", "跳", "桥接", "high", "promote_discovery", "insight",
  "_debug", "候选", "过滤",
];

function assertNoBannedWords(text: string) {
  for (const w of BANNED_WORDS) {
    expect(text.includes(w)).toBe(false);
  }
}

describe("shouldFilterDiscovery", () => {
  test("gap always passes regardless of suggestion", () => {
    const row = mockRow({ type: "gap", actionable: "low", suggestion: null });
    expect(shouldFilterDiscovery(row)).toBeNull();
  });

  test("bridge without suggestion is filtered", () => {
    const row = mockRow({ type: "bridge", actionable: "high", suggestion: null });
    expect(shouldFilterDiscovery(row)).toBe("bridge_no_suggestion");
  });

  test("bridge with suggestion passes", () => {
    const row = mockRow({ type: "bridge", actionable: "high", suggestion: "建议建立关联" });
    expect(shouldFilterDiscovery(row)).toBeNull();
  });

  test("bridge with suggestion but distance >= 6 and non-high is filtered", () => {
    const row = mockRow({
      type: "bridge",
      actionable: "medium",
      suggestion: "建议建立关联",
      metadata: JSON.stringify({ distance: 8 }),
    });
    expect(shouldFilterDiscovery(row)).toBe("bridge_weak_signal");
  });

  test("bridge with suggestion and distance >= 6 but high actionable passes", () => {
    const row = mockRow({
      type: "bridge",
      actionable: "high",
      suggestion: "重要发现",
      metadata: JSON.stringify({ distance: 8 }),
    });
    expect(shouldFilterDiscovery(row)).toBeNull();
  });

  test("trend without suggestion is filtered", () => {
    const row = mockRow({
      type: "trend",
      actionable: "high",
      entities: '["entities/person-a"]',
      suggestion: null,
    });
    expect(shouldFilterDiscovery(row)).toBe("trend_no_suggestion");
  });

  test("trend with suggestion passes", () => {
    const row = mockRow({
      type: "trend",
      actionable: "medium",
      entities: '["entities/person-a"]',
      suggestion: "注意趋势",
    });
    expect(shouldFilterDiscovery(row)).toBeNull();
  });

  test("contradiction with explanation passes", () => {
    const row = mockRow({
      type: "contradiction",
      entities: '["entities/person-a"]',
      suggestion: null,
      metadata: JSON.stringify({ explanation: "来源冲突" }),
    });
    expect(shouldFilterDiscovery(row)).toBeNull();
  });

  test("contradiction with suggested_resolution passes", () => {
    const row = mockRow({
      type: "contradiction",
      entities: '["entities/person-a"]',
      suggestion: null,
      metadata: JSON.stringify({ suggested_resolution: "核实来源" }),
    });
    expect(shouldFilterDiscovery(row)).toBeNull();
  });

  test("contradiction with suggestion passes", () => {
    const row = mockRow({
      type: "contradiction",
      entities: '["entities/person-a"]',
      suggestion: "检查来源",
    });
    expect(shouldFilterDiscovery(row)).toBeNull();
  });

  test("contradiction without evidence or suggestion is filtered", () => {
    const row = mockRow({
      type: "contradiction",
      entities: '["entities/person-a"]',
      suggestion: null,
      metadata: null,
    });
    expect(shouldFilterDiscovery(row)).toBe("contradiction_no_evidence");
  });

  test("unknown type is filtered", () => {
    const row = mockRow({
      type: "community_crossing",
      entities: '["entities/person-a"]',
      suggestion: "建议",
    });
    expect(shouldFilterDiscovery(row)).toBe("unknown_type");
  });
});

describe("formatDigestCard", () => {
  test("every card carries the DB row id", () => {
    const row = mockRow({ id: 42, type: "gap", entities: '["entities/org-c"]', metadata: JSON.stringify({ mention_count: 10, link_count: 0 }) });
    const card = formatDigestCard(row, entityLookup);
    expect(card.id).toBe(42);
  });

  test("bridge card: natural language, no internal terms", () => {
    const row = mockRow({
      type: "bridge",
      entities: '["entities/person-a", "entities/org-c"]',
      metadata: JSON.stringify({ distance: 5, shared_neighbors: 0 }),
      suggestion: "建议确认关联",
    });
    const card = formatDigestCard(row, entityLookup);
    expect(card.title).toContain("潜在关联");
    expect(card.title).toContain("人物A");
    expect(card.title).toContain("组织C");
    expect(card.evidence).toContain("间接关系线索");
    assertNoBannedWords(Object.values(card).join(" "));
  });

  test("bridge card: uses suggestion when present", () => {
    const row = mockRow({
      type: "bridge",
      entities: '["entities/person-a", "entities/org-c"]',
      metadata: JSON.stringify({ distance: 5 }),
      suggestion: "建议建立关联",
    });
    const card = formatDigestCard(row, entityLookup);
    expect(card.suggested_action).toBe("建议建立关联");
  });

  test("trend card: rising direction", () => {
    const row = mockRow({
      type: "trend",
      entities: '["entities/person-a"]',
      metadata: JSON.stringify({ direction: "trend_rising", delta: 5, daily_counts: [1, 2, 3, 4, 5, 6, 7] }),
      suggestion: "注意上升",
    });
    const card = formatDigestCard(row, entityLookup);
    expect(card.title).toBe("关注度上升：人物A");
    expect(card.evidence).toContain("+5");
  });

  test("trend card: declining direction", () => {
    const row = mockRow({
      type: "trend",
      entities: '["concepts/topic-d"]',
      metadata: JSON.stringify({ direction: "trend_declining", delta: -3, daily_counts: [7, 6, 5, 4, 3, 2, 1] }),
      suggestion: "关注下降",
    });
    const card = formatDigestCard(row, entityLookup);
    expect(card.title).toBe("关注度下降：主题D");
    expect(card.evidence).toContain("-3");
  });

  test("gap card: correct auto-generated suggested_action", () => {
    const row = mockRow({
      type: "gap",
      entities: '["entities/org-c"]',
      metadata: JSON.stringify({ mention_count: 25, link_count: 1 }),
    });
    const card = formatDigestCard(row, entityLookup);
    expect(card.title).toBe("需要补全：组织C");
    expect(card.evidence).toContain("25 次");
    expect(card.evidence).toContain("1 条关联");
    expect(card.suggested_action).toContain("添加更详细的描述");
  });

  test("contradiction card: uses explanation and suggested_resolution", () => {
    const row = mockRow({
      type: "contradiction",
      entities: '["entities/person-b"]',
      metadata: JSON.stringify({ explanation: "来源信息冲突", suggested_resolution: "核实来源A", source_count: 3 }),
      suggestion: "检查来源",
    });
    const card = formatDigestCard(row, entityLookup);
    expect(card.title).toBe("信息矛盾：人物B");
    expect(card.evidence).toBe("来源信息冲突");
    expect(card.suggested_action).toBe("核实来源A");
  });

  test("contradiction card: falls back to suggestion when no resolution", () => {
    const row = mockRow({
      type: "contradiction",
      entities: '["entities/person-b"]',
      metadata: JSON.stringify({ explanation: "冲突描述" }),
      suggestion: "检查来源",
    });
    const card = formatDigestCard(row, entityLookup);
    expect(card.suggested_action).toBe("检查来源");
  });

  test("handles missing entity titles gracefully", () => {
    const row = mockRow({
      type: "gap",
      entities: '["entities/unknown-xyz"]',
      metadata: JSON.stringify({ mention_count: 10, link_count: 0 }),
    });
    const card = formatDigestCard(row, entityLookup);
    expect(card.title).toContain("entities/unknown-xyz");
  });

  test("default branch: outputs 待确认发现, no score", () => {
    const row = mockRow({
      type: "custom_type",
      entities: '["entities/person-a"]',
      suggestion: "查看",
    });
    const card = formatDigestCard(row, entityLookup);
    expect(card.title).toContain("待确认发现");
    expect(card.evidence).not.toContain("score");
    assertNoBannedWords(Object.values(card).join(" "));
  });
});

describe("formatDiscoveryDigest", () => {
  test("cards carry DB row ids for update_discovery_status", () => {
    const rows = [
      mockRow({ id: 10, type: "gap", entities: '["entities/org-c"]', metadata: JSON.stringify({ mention_count: 20, link_count: 0 }) }),
      mockRow({ id: 20, type: "trend", entities: '["entities/person-a"]', metadata: JSON.stringify({ direction: "trend_rising", delta: 3, daily_counts: [1, 2, 3] }), suggestion: "注意" }),
    ];
    const digest = formatDiscoveryDigest(rows, entityLookup, 10);
    expect(digest.cards[0].id).toBe(10);
    expect(digest.cards[1].id).toBe(20);
  });

  test("filters bridges without suggestion", () => {
    const rows = [
      mockRow({ id: 1, type: "bridge", actionable: "high", score: 0.9, suggestion: null }),
      mockRow({ id: 2, type: "bridge", actionable: "high", score: 0.8, suggestion: "重要关联" }),
    ];
    const digest = formatDiscoveryDigest(rows, entityLookup);
    expect(digest.cards.length).toBe(1);
    expect(digest.cards[0].title).toContain("潜在关联");
  });

  test("filters trends without suggestion", () => {
    const rows = [
      mockRow({ id: 1, type: "trend", actionable: "high", entities: '["entities/person-a"]', suggestion: null }),
      mockRow({ id: 2, type: "trend", actionable: "high", entities: '["entities/person-a"]', suggestion: "注意" }),
    ];
    const digest = formatDiscoveryDigest(rows, entityLookup);
    expect(digest.cards.length).toBe(1);
  });

  test("gap passes without suggestion", () => {
    const rows = [
      mockRow({ type: "gap", entities: '["entities/org-c"]', metadata: JSON.stringify({ mention_count: 20, link_count: 0 }) }),
    ];
    const digest = formatDiscoveryDigest(rows, entityLookup);
    expect(digest.cards.length).toBe(1);
    expect(digest.cards[0].title).toContain("需要补全");
  });

  test("sorts: high > medium > low, then score desc", () => {
    const rows = [
      mockRow({ id: 1, type: "trend", actionable: "medium", score: 0.9, entities: '["entities/person-a"]', metadata: JSON.stringify({ direction: "trend_rising", delta: 2, daily_counts: [1, 2, 3] }), suggestion: "注意" }),
      mockRow({ id: 2, type: "gap", actionable: "high", score: 0.5, entities: '["entities/org-c"]', metadata: JSON.stringify({ mention_count: 20, link_count: 0 }) }),
      mockRow({ id: 3, type: "bridge", actionable: "medium", score: 0.8, entities: '["entities/person-a", "entities/person-b"]', metadata: JSON.stringify({ distance: 4 }), suggestion: "确认" }),
    ];
    const digest = formatDiscoveryDigest(rows, entityLookup, 10);
    expect(digest.cards[0].title).toContain("需要补全");
    expect(digest.cards[1].title).toContain("关注度");
    expect(digest.cards[2].title).toContain("潜在关联");
  });

  test("respects maxItems limit", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      mockRow({ id: i + 1, type: "gap", score: 1 - i * 0.1, entities: '["entities/org-c"]', metadata: JSON.stringify({ mention_count: 10 + i, link_count: 0 }) })
    );
    const digest = formatDiscoveryDigest(rows, entityLookup, 3);
    expect(digest.cards.length).toBe(3);
  });

  test("display markdown: renders cards with ### headings", () => {
    const rows = [
      mockRow({ id: 1, type: "gap", entities: '["entities/org-c"]', metadata: JSON.stringify({ mention_count: 15, link_count: 0 }) }),
      mockRow({ id: 2, type: "trend", entities: '["entities/person-a"]', metadata: JSON.stringify({ direction: "trend_rising", delta: 3, daily_counts: [1, 2, 3] }), suggestion: "注意" }),
    ];
    const digest = formatDiscoveryDigest(rows, entityLookup, 10);
    expect(digest.display).toContain("### 需要补全：组织C");
    expect(digest.display).toContain("### 关注度上升：人物A");
    expect(digest.display).toContain("---");
    expect(digest.display).toContain("**建议**");
  });

  test("display and cards contain no banned words", () => {
    const rows = [
      mockRow({ id: 1, type: "gap", entities: '["entities/org-c"]', metadata: JSON.stringify({ mention_count: 15, link_count: 0 }) }),
      mockRow({ id: 2, type: "trend", entities: '["entities/person-a"]', metadata: JSON.stringify({ direction: "trend_rising", delta: 3, daily_counts: [1, 2, 3] }), suggestion: "注意" }),
      mockRow({ id: 3, type: "bridge", entities: '["entities/person-a", "entities/person-b"]', metadata: JSON.stringify({ distance: 4 }), suggestion: "确认" }),
    ];
    const digest = formatDiscoveryDigest(rows, entityLookup, 10);
    assertNoBannedWords(digest.display);
    for (const card of digest.cards) {
      assertNoBannedWords(Object.values(card).join(" "));
    }
  });

  test("display: empty results show placeholder", () => {
    const rows = [
      mockRow({ type: "bridge", actionable: "high", suggestion: null }),
    ];
    const digest = formatDiscoveryDigest(rows, entityLookup);
    expect(digest.display).toBe("暂无新的发现。");
    expect(digest.cards.length).toBe(0);
  });

  test("_debug: correct counts and filter_reasons", () => {
    const rows = [
      mockRow({ type: "bridge", actionable: "high", suggestion: null }),
      mockRow({ type: "trend", actionable: "high", entities: '["entities/person-a"]', suggestion: null }),
      mockRow({ type: "gap", entities: '["entities/org-c"]', metadata: JSON.stringify({ mention_count: 10, link_count: 0 }) }),
    ];
    const digest = formatDiscoveryDigest(rows, entityLookup, 10);
    expect(digest._debug.total_candidates).toBe(3);
    expect(digest._debug.filtered).toBe(2);
    expect(digest._debug.filter_reasons["bridge_no_suggestion"]).toBe(1);
    expect(digest._debug.filter_reasons["trend_no_suggestion"]).toBe(1);
  });
});

describe("knowledge_map surface (#244)", () => {
  const KM_BANNED = [
    "slug", "community_id", "weighted_degree", "density",
    "source_type", "debug", "raw", "节点", "桥接", "候选",
  ];

  test("shouldFilterDiscovery passes KM types", () => {
    expect(
      shouldFilterDiscovery(mockRow({ type: "knowledge_map_isolation", entities: '["entities/person-a"]' })),
    ).toBeNull();
    expect(
      shouldFilterDiscovery(mockRow({ type: "knowledge_map_bridge", entities: '["concepts/topic-d"]' })),
    ).toBeNull();
  });

  test("isolation card: natural language, no raw terms", () => {
    const row = mockRow({
      id: 1,
      type: "knowledge_map_isolation",
      entities: '["entities/person-a"]',
      actionable: "medium",
      metadata: JSON.stringify({ source: "knowledge_map", mention_count: 12 }),
    });
    const card = formatDigestCard(row, entityLookup);
    expect(card.title).toContain("人物A");
    expect(card.title).toContain("孤立记忆");
    assertNoBannedWords(Object.values(card).join(" "));
    for (const b of KM_BANNED) {
      expect(Object.values(card).join(" ")).not.toContain(b);
    }
  });

  test("bridge card: avoids 桥接, uses 连接", () => {
    const row = mockRow({
      id: 2,
      type: "knowledge_map_bridge",
      entities: '["concepts/topic-d"]',
      actionable: "medium",
      metadata: JSON.stringify({ source: "knowledge_map", community_count: 3 }),
    });
    const card = formatDigestCard(row, entityLookup);
    expect(card.title).toContain("主题D");
    expect(card.title).toContain("跨领域连接");
    expect(Object.values(card).join(" ")).not.toContain("桥接");
    assertNoBannedWords(Object.values(card).join(" "));
  });

  test("formatKnowledgeMapSurface: isolation first, capped at 5", () => {
    const isolations = [1, 2, 3].map((id, i) =>
      mockRow({
        id,
        type: "knowledge_map_isolation",
        entities: '["entities/person-a"]',
        score: 0.9 - i * 0.1,
        metadata: JSON.stringify({ source: "knowledge_map" }),
      }),
    );
    const bridges = [4, 5, 6].map((id, i) =>
      mockRow({
        id,
        type: "knowledge_map_bridge",
        entities: '["concepts/topic-d"]',
        score: 0.8 - i * 0.1,
        metadata: JSON.stringify({ source: "knowledge_map" }),
      }),
    );
    const surface = formatKnowledgeMapSurface(isolations, bridges, entityLookup, 5);
    expect(surface.cards).toHaveLength(5);
    expect(surface.cards[0].id).toBe(1); // isolation first
    expect(surface.cards[3].id).toBe(4); // then bridge
    expect(surface.display).toContain("知识结构观察");
  });

  test("formatKnowledgeMapSurface: empty → empty display", () => {
    const surface = formatKnowledgeMapSurface([], [], entityLookup, 5);
    expect(surface.cards).toHaveLength(0);
    expect(surface.display).toBe("");
  });
});
