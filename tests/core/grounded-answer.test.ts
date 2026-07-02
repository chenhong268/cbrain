import { describe, test, expect } from "bun:test";
import { GroundedAnswerer, buildGroundedRecall } from "../../src/core/retrieval/grounded-answer.js";
import type { EvidenceBoardResult, EvidenceItem } from "../../src/core/retrieval/evidence.js";

// ─── Helpers ──────────────────────────────────────────────────

function factItem(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    claim: "人物A与主题B有关联",
    evidence_type: "fact",
    source_type: "link",
    source_slug: "records/conversation-001",
    source_category: "imported_content",
    trust_state: "trusted",
    excerpt: "人物A提到对主题B很感兴趣",
    confidence: 0.9,
    timestamp: "2025-01-15T10:00:00Z",
    ...overrides,
  };
}

function thoughtItem(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    claim: "人物A认为项目C需要重新评估",
    evidence_type: "user_thought",
    source_type: "timeline",
    source_slug: "records/conversation-002",
    source_category: "dialogue_extraction",
    trust_state: "user_thought",
    excerpt: "人物A在对话中表示项目C可能方向有误",
    ...overrides,
  };
}

function candidateItem(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    claim: "人物A可能认识人物D",
    evidence_type: "candidate",
    source_type: "link",
    source_slug: "records/conversation-003",
    source_category: "agent_inference",
    trust_state: "candidate",
    confidence: 0.4,
    ...overrides,
  };
}

function emptyBoard(): EvidenceBoardResult {
  return { facts: [], user_thoughts: [], candidates: [], gaps: [], conflicts: [] };
}

// ─── Tests ────────────────────────────────────────────────────

describe("GroundedAnswerer", () => {
  test("trusted facts → factual answer with source, high confidence", () => {
    const answerer = new GroundedAnswerer();
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [factItem()],
    };

    const result = answerer.synthesize("人物A和主题B的关系？", board);

    expect(result.confidence).toBe("high");
    expect(result.facts_used).toHaveLength(1);
    expect(result.facts_used[0].claim).toBe("人物A与主题B有关联");
    expect(result.facts_used[0].source_slug).toBe("records/conversation-001");
    expect(result.answer).toContain("人物A与主题B有关联");
    expect(result.thoughts_used).toHaveLength(0);
    expect(result.unresolved).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
  });

  test("user_thoughts only → framed as prior thinking, medium confidence", () => {
    const answerer = new GroundedAnswerer();
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      user_thoughts: [thoughtItem()],
    };

    const result = answerer.synthesize("人物A对项目C的看法？", board);

    expect(result.confidence).toBe("medium");
    expect(result.thoughts_used).toHaveLength(1);
    expect(result.thoughts_used[0].claim).toBe("人物A认为项目C需要重新评估");
    expect(result.facts_used).toHaveLength(0);
    expect(result.answer).toContain("你之前提到");
    expect(result.answer).toContain("人物A认为项目C需要重新评估");
  });

  test("candidates only → low confidence, unresolved claims", () => {
    const answerer = new GroundedAnswerer();
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      candidates: [candidateItem()],
      gaps: ["人物A可能认识人物D"],
    };

    const result = answerer.synthesize("人物A认识谁？", board);

    expect(result.confidence).toBe("low");
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]).toBe("人物A可能认识人物D");
    expect(result.facts_used).toHaveLength(0);
    expect(result.answer).toContain("尚待确认");
    expect(result.answer).toContain("人物A可能认识人物D");
  });

  test("conflicting evidence → conflict-aware answer, both sides shown", () => {
    const answerer = new GroundedAnswerer();
    const pro = factItem({ claim: "人物A是项目E的负责人" });
    const con = candidateItem({ claim: "人物A已离开项目E" });
    const board: EvidenceBoardResult = {
      facts: [pro],
      user_thoughts: [],
      candidates: [con],
      gaps: [],
      conflicts: [{ claim: "人物A与项目E的关系", evidence: [pro, con] }],
    };

    const result = answerer.synthesize("人物A在项目E的角色？", board);

    expect(result.confidence).not.toBe("high");
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].claim).toBe("人物A与项目E的关系");
    expect(result.answer).toContain("存在矛盾信息");
    expect(result.answer).toContain("人物A是项目E的负责人");
    expect(result.answer).toContain("人物A已离开项目E");
  });

  test("empty board → insufficient evidence answer, low confidence", () => {
    const answerer = new GroundedAnswerer();
    const result = answerer.synthesize("随便什么问题", emptyBoard());

    expect(result.confidence).toBe("low");
    expect(result.facts_used).toHaveLength(0);
    expect(result.thoughts_used).toHaveLength(0);
    expect(result.unresolved).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
    expect(result.answer).toBe("目前没有足够的记录来回答这个问题。");
  });

  test("output is compact — no raw body, profile, or trace", () => {
    const answerer = new GroundedAnswerer();
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [factItem()],
    };

    const result = answerer.synthesize("问题", board);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("tool_trace");
    expect(serialized).not.toContain("page_body");
    expect(serialized).not.toContain("full_profile");
    expect(serialized).not.toContain("proactive_hint");
  });

  test("facts + unresolved candidates → medium confidence", () => {
    const answerer = new GroundedAnswerer();
    const board: EvidenceBoardResult = {
      facts: [factItem({ claim: "人物A在团队G" })],
      user_thoughts: [],
      candidates: [candidateItem({ claim: "人物A可能参与项目F" })],
      gaps: ["人物A可能参与项目F"],
      conflicts: [],
    };

    const result = answerer.synthesize("人物A的情况？", board);

    expect(result.confidence).toBe("medium");
    expect(result.facts_used).toHaveLength(1);
    expect(result.unresolved).toHaveLength(1);
  });

  test("fact-supported candidate does not show as pending", () => {
    const answerer = new GroundedAnswerer();
    const board: EvidenceBoardResult = {
      facts: [factItem({ claim: "人物A在团队G工作" })],
      user_thoughts: [],
      candidates: [candidateItem({ claim: "人物A在团队G工作" })],
      gaps: [],
      conflicts: [],
    };

    const result = answerer.synthesize("人物A在哪个团队？", board);

    expect(result.confidence).toBe("high");
    expect(result.answer).not.toContain("尚待确认");
    expect(result.unresolved).toHaveLength(0);
  });

  // ── Adversarial regression tests ─────────────────────────────

  test("conflict does not silently pick a side — both sides shown in context", () => {
    const pro = factItem({ claim: "人物A是项目E的负责人" });
    const con = candidateItem({ claim: "人物A已离开项目E" });
    const board: EvidenceBoardResult = {
      facts: [pro],
      user_thoughts: [],
      candidates: [con],
      gaps: [],
      conflicts: [{ claim: "人物A与项目E", evidence: [pro, con] }],
    };

    const result = new GroundedAnswerer().synthesize("人物A在项目E？", board);

    expect(result.answer).toContain("存在矛盾信息");
    expect(result.confidence).not.toBe("high");
    expect(result.answer).not.toMatch(/^根据记录：/);
    expect(result.answer).toContain("人物A是项目E的负责人");
    expect(result.answer).toContain("人物A已离开项目E");
  });

  test("fact reversal — answer faithfully represents recorded claims", () => {
    const answerer = new GroundedAnswerer();
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [factItem({ claim: "人物A已离开项目E" })],
    };

    const result = answerer.synthesize("人物A在项目E？", board);

    expect(result.answer).toContain("人物A已离开项目E");
    expect(result.answer).not.toContain("人物A加入了项目E");
    expect(result.answer).toContain("根据记录");
  });

  test("candidate is never asserted as verified fact", () => {
    const answerer = new GroundedAnswerer();
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      candidates: [candidateItem()],
      gaps: ["人物A可能认识人物D"],
    };

    const result = answerer.synthesize("人物A认识谁？", board);

    expect(result.answer).not.toContain("根据记录");
    expect(result.answer).toContain("尚待确认");
    expect(result.confidence).toBe("low");
  });

  test("user thought is never presented as verified fact", () => {
    const answerer = new GroundedAnswerer();
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      user_thoughts: [thoughtItem({ claim: "人物A觉得方案X最佳" })],
    };

    const result = answerer.synthesize("方案X怎样？", board);

    expect(result.answer).not.toContain("根据记录");
    expect(result.answer).toContain("你之前提到");
    expect(result.answer).toContain("人物A觉得方案X最佳");
    expect(result.confidence).toBe("medium");
  });
});

// ─── buildGroundedRecall tests ─────────────────────────────────

describe("buildGroundedRecall", () => {
  test("returns compact result — claim strings only, no body/excerpt", () => {
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [factItem()],
    };

    const result = buildGroundedRecall("人物A和主题B的关系？", board);

    expect(result.query).toBe("人物A和主题B的关系？");
    expect(result.answer).toContain("人物A与主题B有关联");
    expect(result.confidence).toBe("high");
    expect(result.facts).toEqual(["人物A与主题B有关联"]);
    expect(result.must_not_claim).toHaveLength(0);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("excerpt");
    expect(serialized).not.toContain("body");
  });

  test("sources aggregated by slug with evidence_count", () => {
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [
        factItem({ source_slug: "records/a" }),
        factItem({ claim: "另一个事实", source_slug: "records/a" }),
        factItem({ source_slug: "records/b" }),
      ],
    };

    const result = buildGroundedRecall("问题", board);

    expect(result.sources).toHaveLength(2);
    const sourceA = result.sources.find(s => s.slug === "records/a");
    expect(sourceA).toBeDefined();
    expect(sourceA!.evidence_count).toBe(2);
    const sourceB = result.sources.find(s => s.slug === "records/b");
    expect(sourceB).toBeDefined();
    expect(sourceB!.evidence_count).toBe(1);
  });

  test("must_not_claim = candidate claims", () => {
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      candidates: [
        candidateItem({ claim: "人物A可能认识人物D" }),
        candidateItem({ claim: "人物A可能参与项目F" }),
      ],
      gaps: ["人物A可能认识人物D", "人物A可能参与项目F"],
    };

    const result = buildGroundedRecall("问题", board);

    expect(result.must_not_claim).toHaveLength(2);
    expect(result.must_not_claim).toContain("人物A可能认识人物D");
    expect(result.must_not_claim).toContain("人物A可能参与项目F");
  });

  test("empty board → low confidence, minimal output", () => {
    const result = buildGroundedRecall("随便什么", emptyBoard());

    expect(result.confidence).toBe("low");
    expect(result.facts).toHaveLength(0);
    expect(result.user_thoughts).toHaveLength(0);
    expect(result.candidates).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
    expect(result.gaps).toHaveLength(0);
    expect(result.sources).toHaveLength(0);
    expect(result.must_not_claim).toHaveLength(0);
    expect(result.answer).toContain("没有足够的记录");
  });
});
