import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { EvidenceBoard, collectEvidenceForSlugs, type EvidenceItem, type EvidenceSource } from "../../src/core/retrieval/evidence.js";

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

// ─── collectEvidenceForSlugs tests ──────────────────────────────

describe("collectEvidenceForSlugs", () => {
  const testDir = "/tmp/cbrain-test-evidence-collect";
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

  test("trusted link → fact item", () => {
    db.rawDb.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
    ).run("entities/a", "A", "a.md", "h1");
    db.rawDb.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
    ).run("entities/b", "B", "b.md", "h2");
    db.rawDb.prepare(
      "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("entities/a", "entities/b", "knows", "wikilink", "trusted", 0.9);

    const result = collectEvidenceForSlugs(db, ["entities/a"]);

    expect(result.facts.length).toBeGreaterThanOrEqual(1);
    const fact = result.facts.find(f => f.claim.includes("knows"));
    expect(fact).toBeDefined();
    expect(fact!.source_type).toBe("link");
    expect(fact!.trust_state).toBe("trusted");
    expect(fact!.confidence).toBe(0.9);
  });

  test("user_thought timeline → thought item", () => {
    db.rawDb.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
    ).run("entities/x", "X", "x.md", "h1");
    db.rawDb.prepare(
      "INSERT INTO timeline (page_slug, summary, source, trust_state, source_page_slug) VALUES (?, ?, ?, ?, ?)"
    ).run("entities/x", "用户提到X项目可能需要调整方向", "dialogue", "user_thought", "records/chat-001");

    const result = collectEvidenceForSlugs(db, ["entities/x"]);

    expect(result.user_thoughts).toHaveLength(1);
    expect(result.user_thoughts[0].claim).toBe("用户提到X项目可能需要调整方向");
    expect(result.user_thoughts[0].source_type).toBe("timeline");
  });

  test("candidate not mixed into facts", () => {
    db.rawDb.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
    ).run("entities/c", "C", "c.md", "h1");
    db.rawDb.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
    ).run("entities/d", "D", "d.md", "h2");
    db.rawDb.prepare(
      "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("entities/c", "entities/d", "可能认识", "ner", "candidate", 0.4);

    const result = collectEvidenceForSlugs(db, ["entities/c"]);

    expect(result.facts).toHaveLength(0);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
  });

  test("rejected and superseded excluded", () => {
    db.rawDb.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
    ).run("entities/e", "E", "e.md", "h1");
    db.rawDb.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
    ).run("entities/f", "F", "f.md", "h2");
    db.rawDb.prepare(
      "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state) VALUES (?, ?, ?, ?, ?)"
    ).run("entities/e", "entities/f", "旧关系", "ner", "rejected");
    db.rawDb.prepare(
      "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state) VALUES (?, ?, ?, ?, ?)"
    ).run("entities/e", "entities/f", "替代关系", "ner", "superseded");

    const result = collectEvidenceForSlugs(db, ["entities/e"]);

    expect(result.facts).toHaveLength(0);
    expect(result.candidates).toHaveLength(0);
    expect(result.user_thoughts).toHaveLength(0);
  });

  test("same claim + trusted/candidate does NOT produce conflict", () => {
    db.rawDb.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
    ).run("entities/g", "G", "g.md", "h1");
    db.rawDb.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
    ).run("entities/h", "H", "h.md", "h2");
    // Link says "G与H是同事" as trusted
    db.rawDb.prepare(
      "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, context, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("entities/g", "entities/h", "knows", "wikilink", "trusted", "G与H是同事", 0.9);
    // Timeline says same claim as candidate — different trust, NOT a conflict
    db.rawDb.prepare(
      "INSERT INTO timeline (page_slug, summary, source, trust_state, source_page_slug) VALUES (?, ?, ?, ?, ?)"
    ).run("entities/g", "G与H是同事", "ner", "candidate", "records/auto");

    const result = collectEvidenceForSlugs(db, ["entities/g"]);

    // trusted + candidate on same claim = no conflict (just different confirmation levels)
    expect(result.conflicts).toHaveLength(0);
    // Both should appear in their respective partitions
    expect(result.facts.length).toBeGreaterThanOrEqual(1);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
  });

  test("gap detection: unsupported candidates", () => {
    db.rawDb.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
    ).run("entities/p", "P", "p.md", "h1");
    db.rawDb.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
    ).run("entities/q", "Q", "q.md", "h2");
    // Only a candidate, no trusted fact backing it
    db.rawDb.prepare(
      "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("entities/p", "entities/q", "可能合作过", "ner", "candidate", 0.3);

    const result = collectEvidenceForSlugs(db, ["entities/p"]);

    expect(result.gaps.length).toBeGreaterThanOrEqual(1);
    expect(result.facts).toHaveLength(0);
  });

  test("link.source_page_slug is preferred as source_slug", () => {
    db.rawDb.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
    ).run("entities/sp-a", "SP-A", "sp-a.md", "h1");
    db.rawDb.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
    ).run("entities/sp-b", "SP-B", "sp-b.md", "h2");
    db.rawDb.prepare(
      "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence, source_page_slug) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("entities/sp-a", "entities/sp-b", "knows", "wikilink", "trusted", 0.9, "records/conversation-sps");

    const result = collectEvidenceForSlugs(db, ["entities/sp-a"]);

    expect(result.facts.length).toBeGreaterThanOrEqual(1);
    const fact = result.facts.find(f => f.source_slug === "records/conversation-sps");
    expect(fact).toBeDefined();
  });

  test("link without source_page_slug falls back to other-end slug", () => {
    db.rawDb.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
    ).run("entities/fb-a", "FB-A", "fb-a.md", "h1");
    db.rawDb.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
    ).run("entities/fb-b", "FB-B", "fb-b.md", "h2");
    // No source_page_slug — should fall back to other-end slug
    db.rawDb.prepare(
      "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("entities/fb-a", "entities/fb-b", "knows", "wikilink", "trusted", 0.9);

    const result = collectEvidenceForSlugs(db, ["entities/fb-a"]);

    expect(result.facts.length).toBeGreaterThanOrEqual(1);
    const fact = result.facts.find(f => f.source_slug === "entities/fb-b");
    expect(fact).toBeDefined();
  });

  test("incoming link source_slug does not equal the queried slug", () => {
    db.rawDb.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
    ).run("entities/ic-a", "IC-A", "ic-a.md", "h1");
    db.rawDb.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
    ).run("entities/ic-b", "IC-B", "ic-b.md", "h2");
    // Link from ic-b → ic-a (incoming for ic-a). No source_page_slug.
    db.rawDb.prepare(
      "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("entities/ic-b", "entities/ic-a", "knows", "wikilink", "trusted", 0.9);

    const result = collectEvidenceForSlugs(db, ["entities/ic-a"]);

    expect(result.facts.length).toBeGreaterThanOrEqual(1);
    for (const fact of result.facts) {
      expect(fact.source_slug).not.toBe("entities/ic-a");
    }
  });
});
