import { describe, test, expect } from "bun:test";
import type { LLMProvider } from "../../src/llm/provider.js";
import { GroundedAnswerer } from "../../src/core/grounded-answer.js";
import type { EvidenceBoardResult, EvidenceItem } from "../../src/core/evidence.js";

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

function mockLLM(response: string): LLMProvider {
  return {
    name: "mock",
    chat: async () => response,
  };
}

function failingLLM(): LLMProvider {
  return {
    name: "fail",
    chat: async () => { throw new Error("LLM unavailable"); },
  };
}

// ─── Tests ────────────────────────────────────────────────────

describe("GroundedAnswerer", () => {
  test("scenario 1: trusted facts → factual answer with source, high confidence", async () => {
    const answerer = new GroundedAnswerer();
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [factItem()],
    };

    const result = await answerer.synthesize("人物A和主题B的关系？", board);

    expect(result.confidence).toBe("high");
    expect(result.facts_used).toHaveLength(1);
    expect(result.facts_used[0].claim).toBe("人物A与主题B有关联");
    expect(result.facts_used[0].source_slug).toBe("records/conversation-001");
    expect(result.answer).toContain("人物A与主题B有关联");
    expect(result.thoughts_used).toHaveLength(0);
    expect(result.unresolved).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
  });

  test("scenario 2: user_thoughts only → framed as prior thinking, medium confidence", async () => {
    const answerer = new GroundedAnswerer();
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      user_thoughts: [thoughtItem()],
    };

    const result = await answerer.synthesize("人物A对项目C的看法？", board);

    expect(result.confidence).toBe("medium");
    expect(result.thoughts_used).toHaveLength(1);
    expect(result.thoughts_used[0].claim).toBe("人物A认为项目C需要重新评估");
    expect(result.facts_used).toHaveLength(0);
    expect(result.answer).toContain("人物A认为项目C需要重新评估");
  });

  test("scenario 3: candidates only → low confidence, unresolved claims", async () => {
    const answerer = new GroundedAnswerer();
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      candidates: [candidateItem()],
      gaps: ["人物A可能认识人物D"],
    };

    const result = await answerer.synthesize("人物A认识谁？", board);

    expect(result.confidence).toBe("low");
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]).toBe("人物A可能认识人物D");
    expect(result.facts_used).toHaveLength(0);
    expect(result.answer).toContain("人物A可能认识人物D");
  });

  test("scenario 4: conflicting evidence → conflict-aware answer, confidence < high", async () => {
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

    const result = await answerer.synthesize("人物A在项目E的角色？", board);

    expect(result.confidence).not.toBe("high");
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].claim).toBe("人物A与项目E的关系");
    expect(result.answer).toContain("人物A与项目E的关系");
  });

  test("scenario 5: empty board → insufficient evidence answer, low confidence", async () => {
    const answerer = new GroundedAnswerer();
    const result = await answerer.synthesize("随便什么问题", emptyBoard());

    expect(result.confidence).toBe("low");
    expect(result.facts_used).toHaveLength(0);
    expect(result.thoughts_used).toHaveLength(0);
    expect(result.unresolved).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
    expect(result.answer).toBe("目前没有足够的记录来回答这个问题。");
  });

  test("scenario 6: LLM failure → degraded deterministic fallback", async () => {
    const answerer = new GroundedAnswerer({ llm: failingLLM() });
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [factItem()],
    };

    const result = await answerer.synthesize("人物A和主题B的关系？", board);

    expect(result.degraded).toBe(true);
    expect(result.confidence).toBe("high");
    expect(result.facts_used).toHaveLength(1);
    expect(result.answer).toContain("人物A与主题B有关联");
  });

  test("scenario 7: LLM hallucinated source → degraded deterministic fallback", async () => {
    const hallucinated = JSON.stringify({
      answer: "人物A与主题B有关联。",
      facts_used: [{ claim: "人物A与主题B有关联", source_slug: "records/hallucinated-999" }],
      thoughts_used: [],
      unresolved: [],
      conflicts: [],
    });
    const answerer = new GroundedAnswerer({ llm: mockLLM(hallucinated) });
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [factItem()],
    };

    const result = await answerer.synthesize("人物A和主题B的关系？", board);

    expect(result.degraded).toBe(true);
    expect(result.facts_used[0].source_slug).toBe("records/conversation-001");
  });

  test("scenario 8: output is compact — no raw body, profile, or trace", async () => {
    const answerer = new GroundedAnswerer();
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [factItem()],
    };

    const result = await answerer.synthesize("问题", board);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("tool_trace");
    expect(serialized).not.toContain("page_body");
    expect(serialized).not.toContain("full_profile");
    expect(serialized).not.toContain("proactive_hint");
  });

  test("LLM valid output → used directly, not degraded", async () => {
    const valid = JSON.stringify({
      answer: "根据记录，人物A与主题B有关联。",
      facts_used: [{ claim: "人物A与主题B有关联", source_slug: "records/conversation-001" }],
      thoughts_used: [],
      unresolved: [],
      conflicts: [],
    });
    const answerer = new GroundedAnswerer({ llm: mockLLM(valid) });
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [factItem()],
    };

    const result = await answerer.synthesize("人物A和主题B的关系？", board);

    expect(result.degraded).toBeUndefined();
    expect(result.answer).toBe("根据记录，人物A与主题B有关联。");
    expect(result.confidence).toBe("high");
    expect(result.facts_used).toHaveLength(1);
  });

  test("LLM malformed JSON → degraded fallback", async () => {
    const answerer = new GroundedAnswerer({ llm: mockLLM("this is not json") });
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [factItem()],
    };

    const result = await answerer.synthesize("问题", board);

    expect(result.degraded).toBe(true);
    expect(result.facts_used).toHaveLength(1);
  });

  test("LLM output missing answer field → degraded fallback", async () => {
    const noAnswer = JSON.stringify({
      facts_used: [{ claim: "人物A与主题B有关联", source_slug: "records/conversation-001" }],
      thoughts_used: [],
      unresolved: [],
      conflicts: [],
    });
    const answerer = new GroundedAnswerer({ llm: mockLLM(noAnswer) });
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [factItem()],
    };

    const result = await answerer.synthesize("问题", board);

    expect(result.degraded).toBe(true);
  });

  test("facts + unresolved candidates → medium confidence", async () => {
    const answerer = new GroundedAnswerer();
    const board: EvidenceBoardResult = {
      facts: [factItem({ claim: "人物A在团队G" })],
      user_thoughts: [],
      candidates: [candidateItem({ claim: "人物A可能参与项目F" })],
      gaps: ["人物A可能参与项目F"],
      conflicts: [],
    };

    const result = await answerer.synthesize("人物A的情况？", board);

    expect(result.confidence).toBe("medium");
    expect(result.facts_used).toHaveLength(1);
    expect(result.unresolved).toHaveLength(1);
  });

  test("LLM conflict output ignored — board conflicts used instead", async () => {
    const hallucinatedConflict = JSON.stringify({
      answer: "关于人物A与项目E的关系存在矛盾。",
      facts_used: [],
      thoughts_used: [],
    });
    const answerer = new GroundedAnswerer({ llm: mockLLM(hallucinatedConflict) });
    const pro = factItem({ claim: "人物A是项目E的负责人" });
    const board: EvidenceBoardResult = {
      facts: [pro],
      user_thoughts: [],
      candidates: [],
      gaps: [],
      conflicts: [{ claim: "人物A与项目E", evidence: [pro] }],
    };

    const result = await answerer.synthesize("人物A与项目E？", board);

    expect(result.degraded).toBeUndefined();
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].claim).toBe("人物A与项目E");
    expect(result.conflicts[0].source_slugs).toContain("records/conversation-001");
  });

  // ── P1 regression tests ──────────────────────────────────────

  test("LLM puts candidate source into facts_used → degraded", async () => {
    const crossPartition = JSON.stringify({
      answer: "人物A可能认识人物D。",
      facts_used: [{ claim: "人物A可能认识人物D", source_slug: "records/conversation-003" }],
      thoughts_used: [],
      unresolved: [],
      conflicts: [],
    });
    const answerer = new GroundedAnswerer({ llm: mockLLM(crossPartition) });
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      candidates: [candidateItem()],
      gaps: ["人物A可能认识人物D"],
    };

    const result = await answerer.synthesize("人物A认识谁？", board);

    expect(result.degraded).toBe(true);
    expect(result.facts_used).toHaveLength(0);
  });

  test("LLM rewrites claim text in facts_used → degraded", async () => {
    const rewrittenClaim = JSON.stringify({
      answer: "人物A非常喜欢主题B。",
      facts_used: [{ claim: "人物A非常喜欢主题B", source_slug: "records/conversation-001" }],
      thoughts_used: [],
      unresolved: [],
      conflicts: [],
    });
    const answerer = new GroundedAnswerer({ llm: mockLLM(rewrittenClaim) });
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [factItem()],
    };

    const result = await answerer.synthesize("人物A和主题B？", board);

    expect(result.degraded).toBe(true);
  });

  test("empty board, LLM invents facts → degraded", async () => {
    const invented = JSON.stringify({
      answer: "根据记录，人物A与主题B有关联。",
      facts_used: [{ claim: "人物A与主题B有关联", source_slug: "records/conversation-001" }],
      thoughts_used: [],
      unresolved: [],
      conflicts: [],
    });
    const answerer = new GroundedAnswerer({ llm: mockLLM(invented) });

    const result = await answerer.synthesize("随便什么", emptyBoard());

    expect(result.degraded).toBe(true);
    expect(result.facts_used).toHaveLength(0);
    expect(result.answer).toBe("目前没有足够的记录来回答这个问题。");
  });

  test("board conflicts preserved regardless of LLM output", async () => {
    const llmResponse = JSON.stringify({
      answer: "人物A是项目E的负责人。",
      facts_used: [{ claim: "人物A是项目E的负责人", source_slug: "records/conversation-001" }],
      thoughts_used: [],
    });
    const answerer = new GroundedAnswerer({ llm: mockLLM(llmResponse) });
    const pro = factItem({ claim: "人物A是项目E的负责人" });
    const con = candidateItem({ claim: "人物A已离开项目E" });
    const board: EvidenceBoardResult = {
      facts: [pro],
      user_thoughts: [],
      candidates: [con],
      gaps: [],
      conflicts: [{ claim: "人物A与项目E", evidence: [pro, con] }],
    };

    const result = await answerer.synthesize("人物A在项目E？", board);

    expect(result.degraded).toBeUndefined();
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].claim).toBe("人物A与项目E");
    expect(result.conflicts[0].source_slugs).toHaveLength(2);
  });

  test("board gaps preserved regardless of LLM output", async () => {
    const llmResponse = JSON.stringify({
      answer: "人物A在团队G工作。",
      facts_used: [{ claim: "人物A在团队G工作", source_slug: "records/conversation-001" }],
      thoughts_used: [],
    });
    const answerer = new GroundedAnswerer({ llm: mockLLM(llmResponse) });
    const board: EvidenceBoardResult = {
      facts: [factItem({ claim: "人物A在团队G工作" })],
      user_thoughts: [],
      candidates: [candidateItem({ claim: "人物A可能参与项目F" })],
      gaps: ["人物A可能参与项目F"],
      conflicts: [],
    };

    const result = await answerer.synthesize("人物A的情况？", board);

    expect(result.degraded).toBeUndefined();
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]).toBe("人物A可能参与项目F");
  });

  test("fact-supported candidate does not show as pending in deterministic", async () => {
    const answerer = new GroundedAnswerer();
    const board: EvidenceBoardResult = {
      facts: [factItem({ claim: "人物A在团队G工作" })],
      user_thoughts: [],
      candidates: [candidateItem({ claim: "人物A在团队G工作" })],
      gaps: [],
      conflicts: [],
    };

    const result = await answerer.synthesize("人物A在哪个团队？", board);

    expect(result.confidence).toBe("high");
    expect(result.answer).not.toContain("尚待确认");
    expect(result.unresolved).toHaveLength(0);
  });

  test("LLM answers about unrelated topic — no evidence overlap → degraded", async () => {
    const offTopic = JSON.stringify({
      answer: "主题X已经完成了全面验证，结论明确。",
      facts_used: [{ claim: "人物A与主题B有关联", source_slug: "records/conversation-001" }],
      thoughts_used: [],
    });
    const answerer = new GroundedAnswerer({ llm: mockLLM(offTopic) });
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [factItem()],
    };

    const result = await answerer.synthesize("人物A和主题B的关系？", board);

    expect(result.degraded).toBe(true);
    expect(result.answer).toContain("人物A与主题B有关联");
  });
});
