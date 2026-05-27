import { describe, test, expect } from "bun:test";
import { EvidenceBoard, type EvidenceItem, type EvidenceSource } from "../../src/core/evidence.js";

// ─── Helpers ──────────────────────────────────────────────────

const alwaysValid: EvidenceSource = { resolveSlug: () => true };
const rejectInvalid: EvidenceSource = { resolveSlug: (slug: string) => slug.length > 0 && slug !== "invalid-slug" };

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

// ─── Tests ────────────────────────────────────────────────────

describe("EvidenceBoard", () => {
  test("scenario 1: trusted evidence → facts partition", () => {
    const board = new EvidenceBoard(alwaysValid);
    board.add(factItem());

    const result = board.build();

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].claim).toBe("人物A与主题B有关联");
    expect(result.facts[0].trust_state).toBe("trusted");
    expect(result.facts[0].evidence_type).toBe("fact");
    expect(result.facts[0].source_slug).toBe("records/conversation-001");
    expect(result.facts[0].excerpt).toBe("人物A提到对主题B很感兴趣");
    expect(result.user_thoughts).toHaveLength(0);
    expect(result.candidates).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
    expect(result.gaps).toHaveLength(0);
  });

  test("scenario 2: user_thought evidence → separate partition, not mixed into facts", () => {
    const board = new EvidenceBoard(alwaysValid);
    board.add(thoughtItem());

    const result = board.build();

    expect(result.user_thoughts).toHaveLength(1);
    expect(result.user_thoughts[0].claim).toBe("人物A认为项目C需要重新评估");
    expect(result.user_thoughts[0].trust_state).toBe("user_thought");
    expect(result.user_thoughts[0].evidence_type).toBe("user_thought");
    expect(result.facts).toHaveLength(0);
    expect(result.candidates).toHaveLength(0);
  });

  test("scenario 3: candidate evidence → candidates only, not in facts or user_thoughts", () => {
    const board = new EvidenceBoard(alwaysValid);
    board.add(candidateItem());

    const result = board.build();

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].claim).toBe("人物A可能认识人物D");
    expect(result.candidates[0].trust_state).toBe("candidate");
    expect(result.candidates[0].evidence_type).toBe("candidate");
    expect(result.facts).toHaveLength(0);
    expect(result.user_thoughts).toHaveLength(0);
  });

  test("scenario 4: rejected and superseded evidence excluded from board output", () => {
    const board = new EvidenceBoard(alwaysValid);
    board.add(factItem({ claim: "可信事实" }));
    board.add(factItem({ claim: "已拒绝的推断", trust_state: "rejected" }));
    board.add(candidateItem({ claim: "已替代的候选", trust_state: "superseded" }));

    const result = board.build();

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].claim).toBe("可信事实");
    const allClaims = [...result.facts, ...result.user_thoughts, ...result.candidates].map((e) => e.claim);
    expect(allClaims).not.toContain("已拒绝的推断");
    expect(allClaims).not.toContain("已替代的候选");
  });

  test("scenario 5: explicitly declared conflicting claims → conflicts array", () => {
    const board = new EvidenceBoard(alwaysValid);
    const pro = factItem({ claim: "人物A是项目E的负责人" });
    const con = candidateItem({ claim: "人物A已离开项目E" });
    board.add(pro);
    board.add(con);
    board.addConflict("人物A与项目E的关系", [pro, con]);

    const result = board.build();

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].claim).toBe("人物A与项目E的关系");
    expect(result.conflicts[0].evidence).toHaveLength(2);
    // Items still appear in their respective partitions
    expect(result.facts).toHaveLength(1);
    expect(result.candidates).toHaveLength(1);
  });

  test("same claim text from different trust levels → not auto-detected as conflict", () => {
    const board = new EvidenceBoard(alwaysValid);
    board.add(factItem({ claim: "人物A在团队G工作" }));
    board.add(candidateItem({ claim: "人物A在团队G工作" }));
    // No addConflict → no conflicts

    const result = board.build();

    expect(result.conflicts).toHaveLength(0);
    expect(result.facts).toHaveLength(1);
    expect(result.candidates).toHaveLength(1);
  });

  test("scenario 6: missing or unresolvable source_slug → rejected", () => {
    const board = new EvidenceBoard(rejectInvalid);
    board.add(factItem({ source_slug: "" }));
    board.add(factItem({ source_slug: "invalid-slug" }));
    board.add(factItem({ source_slug: "valid-slug" }));

    const result = board.build();

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].source_slug).toBe("valid-slug");
  });

  test("scenario 7: duplicate evidence deduped by claim + source_slug + trust_state", () => {
    const board = new EvidenceBoard(alwaysValid);
    const item = factItem();
    board.add(item);
    board.add({ ...item });
    board.add({ ...item, confidence: 0.7 });

    const result = board.build();

    expect(result.facts).toHaveLength(1);
  });

  test("candidate with trust_state=candidate cannot enter facts even if evidence_type=fact", () => {
    const board = new EvidenceBoard(alwaysValid);
    board.add({
      claim: "Agent推断的'事实'",
      evidence_type: "fact",
      source_type: "link",
      source_slug: "records/conversation-004",
      source_category: "agent_inference",
      trust_state: "candidate",
    });

    const result = board.build();

    expect(result.facts).toHaveLength(0);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].evidence_type).toBe("candidate");
  });

  test("candidates without fact support → gaps", () => {
    const board = new EvidenceBoard(alwaysValid);
    board.add(candidateItem({ claim: "人物A可能参与项目F" }));

    const result = board.build();

    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toBe("人物A可能参与项目F");
  });

  test("user_thought does not fill fact gap for candidate", () => {
    const board = new EvidenceBoard(alwaysValid);
    board.add(thoughtItem({ claim: "人物A觉得项目C有问题" }));
    board.add(candidateItem({ claim: "人物A觉得项目C有问题" }));

    const result = board.build();

    // user_thought does NOT eliminate the gap — only facts do
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toBe("人物A觉得项目C有问题");
    expect(result.user_thoughts).toHaveLength(1);
    expect(result.candidates).toHaveLength(1);
  });

  test("fact support eliminates candidate gap", () => {
    const board = new EvidenceBoard(alwaysValid);
    board.add(factItem({ claim: "人物A在团队G工作" }));
    board.add(candidateItem({ claim: "人物A在团队G工作" }));

    const result = board.build();

    expect(result.gaps).toHaveLength(0);
    expect(result.facts).toHaveLength(1);
    expect(result.candidates).toHaveLength(1);
  });

  test("addConflict excludes rejected/superseded from conflict evidence", () => {
    const board = new EvidenceBoard(alwaysValid);
    const trusted = factItem({ claim: "人物A在项目E" });
    const rejected = factItem({ claim: "人物A已离开项目E", trust_state: "rejected" });
    board.addConflict("人物A与项目E", [trusted, rejected]);

    const result = board.build();

    // Only 1 active item remains — not enough for a conflict group
    expect(result.conflicts).toHaveLength(0);
  });

  test("addConflict normalizes evidence_type from trust_state", () => {
    const board = new EvidenceBoard(alwaysValid);
    const trusted = factItem({ claim: "人物A是负责人" });
    const disguised = candidateItem({
      claim: "人物A已离职",
      trust_state: "candidate",
      evidence_type: "fact" as EvidenceItem["evidence_type"],
    });
    board.add(trusted);
    board.add(disguised);
    board.addConflict("人物A在职状态", [trusted, disguised]);

    const result = board.build();

    expect(result.conflicts).toHaveLength(1);
    const conflictEvidence = result.conflicts[0].evidence;
    // candidate must show as candidate, never as fact
    const candidateEntry = conflictEvidence.find((e) => e.trust_state === "candidate");
    expect(candidateEntry).toBeDefined();
    expect(candidateEntry!.evidence_type).toBe("candidate");
  });

  test("addConflict with all inactive items produces no conflict", () => {
    const board = new EvidenceBoard(alwaysValid);
    board.addConflict("纯失效", [
      factItem({ trust_state: "rejected" }),
      candidateItem({ trust_state: "superseded" }),
    ]);

    const result = board.build();

    expect(result.conflicts).toHaveLength(0);
  });

  test("addConflict deduplicates identical evidence — no fake conflict", () => {
    const board = new EvidenceBoard(alwaysValid);
    const item = factItem({ claim: "人物A在项目E" });
    board.addConflict("关系", [item, { ...item }]);

    const result = board.build();

    expect(result.conflicts).toHaveLength(0);
  });

  test("addConflict keeps distinct evidence after dedup", () => {
    const board = new EvidenceBoard(alwaysValid);
    const a = factItem({ claim: "人物A是负责人" });
    const b = candidateItem({ claim: "人物A已离职" });
    board.addConflict("人物A在职状态", [a, b, { ...a }]);

    const result = board.build();

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].evidence).toHaveLength(2);
  });
});
