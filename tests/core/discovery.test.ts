import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { DiscoveryManager } from "../../src/core/discovery.js";
import type { LLMProvider } from "../../src/llm/provider.js";

/** Days offset from today — formats as YYYY-MM-DD */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function seedPage(db: CBrainDB, slug: string, type: string, title: string, mentionCount = 0): void {
  db.upsertPage({
    slug, type, title,
    filePath: `${slug}.md`,
    contentHash: "abc",
  });
  if (mentionCount > 0) {
    db.prepare("UPDATE pages SET mention_count = $mc WHERE slug = $slug")
      .run({ $mc: mentionCount, $slug: slug });
  }
}

function createMockLlm(response: string): LLMProvider {
  return { name: "mock", chat: async () => response };
}

describe("DiscoveryManager - data layer", () => {
  const testDir = "/tmp/cbrain-test-discovery";
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

  // ─── mention_snapshots ────────────────────────────────────────

  test("upsertMentionSnapshot inserts and queries correctly", () => {
    seedPage(db, "entity/test", "entity/person", "Test");

    db.upsertMentionSnapshot("entity/test", daysAgo(1), 5);
    db.upsertMentionSnapshot("entity/test", daysAgo(0), 8);

    const snapshots = db.getMentionSnapshots("entity/test", 7);
    expect(snapshots.length).toBe(2);
    expect(snapshots[0].mention_count).toBe(5);
    expect(snapshots[1].mention_count).toBe(8);
  });

  test("upsertMentionSnapshot is idempotent (same date overwrites)", () => {
    seedPage(db, "entity/test", "entity/person", "Test");

    db.upsertMentionSnapshot("entity/test", daysAgo(0), 5);
    db.upsertMentionSnapshot("entity/test", daysAgo(0), 7);

    const snapshots = db.getMentionSnapshots("entity/test", 7);
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].mention_count).toBe(7);
  });

  test("cleanMentionSnapshots removes old entries", () => {
    seedPage(db, "entity/test", "entity/person", "Test");

    db.upsertMentionSnapshot("entity/test", daysAgo(60), 3);
    db.upsertMentionSnapshot("entity/test", daysAgo(1), 5);

    const removed = db.cleanMentionSnapshots(30);
    expect(removed).toBe(1);

    const snapshots = db.getMentionSnapshots("entity/test", 7);
    expect(snapshots.length).toBe(1);
  });

  // ─── discoveries status/metadata ─────────────────────────────

  test("discoveries table has status column", () => {
    seedPage(db, "entity/test", "entity/person", "Test");
    const id = db.addDiscovery("trend", ["entity/test"], 0.8, undefined, undefined, "low", false, { direction: "trend_rising" });
    db.updateDiscoveryStatus(id, "resolved");

    const d = db.getDiscoveryById(id);
    expect(d).not.toBeNull();
    expect(d!.status).toBe("resolved");
  });

  test("discoveries table stores metadata", () => {
    seedPage(db, "entity/test", "entity/person", "Test");
    const id = db.addDiscovery("trend", ["entity/test"], 0.8, undefined, undefined, "low", false, { direction: "trend_rising", delta: 5 });

    const d = db.getDiscoveryById(id);
    expect(d).not.toBeNull();
    const meta = JSON.parse(d!.metadata);
    expect(meta.direction).toBe("trend_rising");
    expect(meta.delta).toBe(5);
  });

  test("discoveries default status is pending", () => {
    seedPage(db, "entity/test", "entity/person", "Test");
    const id = db.addDiscovery("trend", ["entity/test"], 0.8);

    const d = db.getDiscoveryById(id);
    expect(d).not.toBeNull();
    expect(d!.status).toBe("pending");
    expect(d!.metadata).toBeNull();
  });

  test("addDiscovery without metadata still works (backward compat)", () => {
    seedPage(db, "entity/foo", "entity/person", "Foo");
    const id = db.addDiscovery("bridge", ["entity/foo"], 0.5, { note: "test" });
    const d = db.getDiscoveryById(id);
    expect(d).not.toBeNull();
    expect(d!.type).toBe("bridge");
    expect(d!.status).toBe("pending");
  });
});

describe("DiscoveryManager - detectBridges", () => {
  const testDir = "/tmp/cbrain-test-discovery-bridge";
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

  test("detects bridge between distant entities (dist >= 4)", () => {
    // A → B → C → D → E, A-E is bridge (dist 4)
    // Extra neighbors on A and E to meet BRIDGE_MIN_DEGREE=2
    seedPage(db, "entity/a", "entity/person", "A", 3);
    seedPage(db, "entity/b", "entity/person", "B", 3);
    seedPage(db, "entity/c", "entity/person", "C", 3);
    seedPage(db, "entity/d", "entity/person", "D", 3);
    seedPage(db, "entity/e", "entity/person", "E", 3);
    seedPage(db, "entity/a1", "entity/person", "A1", 3);
    seedPage(db, "entity/e1", "entity/person", "E1", 3);
    db.insertLink("entity/a", "entity/b", "提及", 0.5, "ner");
    db.insertLink("entity/a", "entity/a1", "提及", 0.5, "ner");
    db.insertLink("entity/b", "entity/c", "提及", 0.5, "ner");
    db.insertLink("entity/c", "entity/d", "提及", 0.5, "ner");
    db.insertLink("entity/d", "entity/e", "提及", 0.5, "ner");
    db.insertLink("entity/e", "entity/e1", "提及", 0.5, "ner");

    const mgr = new DiscoveryManager(db);
    const results = mgr.detectBridges();

    expect(results.length).toBeGreaterThanOrEqual(1);
    const bridge = results.find(r => r.entities.includes("entity/a") && r.entities.includes("entity/e"));
    expect(bridge).toBeDefined();
    expect(bridge!.type).toBe("bridge");
  });

  test("no bridge when graph is fully connected", () => {
    seedPage(db, "entity/a", "entity/person", "A", 3);
    seedPage(db, "entity/b", "entity/person", "B", 3);
    seedPage(db, "entity/c", "entity/person", "C", 3);
    db.insertLink("entity/a", "entity/b", "提及", 0.5, "ner");
    db.insertLink("entity/b", "entity/c", "提及", 0.5, "ner");
    db.insertLink("entity/a", "entity/c", "提及", 0.5, "ner");

    const mgr = new DiscoveryManager(db);
    const results = mgr.detectBridges();

    const bridges = results.filter(r => r.metadata?.distance >= 4);
    expect(bridges.length).toBe(0);
  });
});

describe("DiscoveryManager - detectTrends", () => {
  const testDir = "/tmp/cbrain-test-discovery-trend";
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

  test("detects rising trend (3+ consecutive increases)", () => {
    seedPage(db, "entity/test", "entity/person", "Test", 10);
    db.upsertMentionSnapshot("entity/test", daysAgo(3), 3);
    db.upsertMentionSnapshot("entity/test", daysAgo(2), 5);
    db.upsertMentionSnapshot("entity/test", daysAgo(1), 7);
    db.upsertMentionSnapshot("entity/test", daysAgo(0), 9);

    const mgr = new DiscoveryManager(db);
    const results = mgr.detectTrends();

    expect(results.length).toBeGreaterThanOrEqual(1);
    const trend = results.find(r => r.entities.includes("entity/test"));
    expect(trend).toBeDefined();
    expect(trend!.type).toBe("trend");
    expect(trend!.metadata?.direction).toBe("trend_rising");
  });

  test("detects declining trend (3+ consecutive decreases)", () => {
    seedPage(db, "entity/test", "entity/person", "Test", 10);
    db.upsertMentionSnapshot("entity/test", daysAgo(3), 12);
    db.upsertMentionSnapshot("entity/test", daysAgo(2), 9);
    db.upsertMentionSnapshot("entity/test", daysAgo(1), 6);
    db.upsertMentionSnapshot("entity/test", daysAgo(0), 3);

    const mgr = new DiscoveryManager(db);
    const results = mgr.detectTrends();

    const trend = results.find(r => r.entities.includes("entity/test"));
    expect(trend).toBeDefined();
    expect(trend!.metadata?.direction).toBe("trend_declining");
  });

  test("detects spike (delta >= 5 in 7 days)", () => {
    seedPage(db, "entity/test", "entity/person", "Test", 15);
    db.upsertMentionSnapshot("entity/test", daysAgo(1), 3);
    db.upsertMentionSnapshot("entity/test", daysAgo(0), 15);

    const mgr = new DiscoveryManager(db);
    const results = mgr.detectTrends();

    const spike = results.find(r => r.entities.includes("entity/test") && r.metadata?.direction === "trend_spike");
    expect(spike).toBeDefined();
  });

  test("no trend for stable entity", () => {
    seedPage(db, "entity/stable", "entity/person", "Stable", 5);
    db.upsertMentionSnapshot("entity/stable", daysAgo(2), 5);
    db.upsertMentionSnapshot("entity/stable", daysAgo(1), 5);
    db.upsertMentionSnapshot("entity/stable", daysAgo(0), 5);

    const mgr = new DiscoveryManager(db);
    const results = mgr.detectTrends();

    const trend = results.find(r => r.entities.includes("entity/stable"));
    expect(trend).toBeUndefined();
  });
});

describe("DiscoveryManager - detectGaps", () => {
  const testDir = "/tmp/cbrain-test-discovery-gap";
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

  test("detects gap: high mentions, low links", () => {
    seedPage(db, "entity/island", "entity/person", "Island", 10);
    seedPage(db, "entity/other", "entity/person", "Other", 3);

    const mgr = new DiscoveryManager(db);
    const results = mgr.detectGaps();

    const gap = results.find(r => r.entities.includes("entity/island"));
    expect(gap).toBeDefined();
    expect(gap!.type).toBe("gap");
    expect(gap!.metadata?.mention_count).toBe(10);
    expect(gap!.metadata?.link_count).toBe(0);
  });

  test("no gap when entity has enough links", () => {
    seedPage(db, "entity/connected", "entity/person", "Connected", 10);
    seedPage(db, "entity/b", "entity/person", "B", 3);
    seedPage(db, "entity/c", "entity/person", "C", 3);
    db.insertLink("entity/connected", "entity/b", "提及", 0.5, "ner");
    db.insertLink("entity/c", "entity/connected", "提及", 0.5, "ner");

    const mgr = new DiscoveryManager(db);
    const results = mgr.detectGaps();

    const gap = results.find(r => r.entities.includes("entity/connected"));
    expect(gap).toBeUndefined();
  });

  test("no gap for low-mention entity", () => {
    seedPage(db, "entity/low", "entity/person", "Low", 2);

    const mgr = new DiscoveryManager(db);
    const results = mgr.detectGaps();

    const gap = results.find(r => r.entities.includes("entity/low"));
    expect(gap).toBeUndefined();
  });

  test("no gap for short-title generic entity", () => {
    seedPage(db, "entity/generic", "entity/person", "银行", 15);

    const mgr = new DiscoveryManager(db);
    const results = mgr.detectGaps();

    const gap = results.find(r => r.entities.includes("entity/generic"));
    expect(gap).toBeUndefined();
  });

  test("no gap for generic concept below high threshold", () => {
    // concept/ requires 20 mentions (not 8) to avoid NER noise
    seedPage(db, "concept/fintech", "concept/concept", "金融科技", 12);

    const mgr = new DiscoveryManager(db);
    const results = mgr.detectGaps();

    const gap = results.find(r => r.entities.includes("concept/fintech"));
    expect(gap).toBeUndefined();
  });

  test("gap detected for concept above high threshold", () => {
    seedPage(db, "concept/blockchain", "concept/concept", "区块链", 35);

    const mgr = new DiscoveryManager(db);
    const results = mgr.detectGaps();

    const gap = results.find(r => r.entities.includes("concept/blockchain"));
    expect(gap).toBeDefined();
    expect(gap!.metadata?.mention_count).toBe(35);
  });

  test("entity gap at normal threshold still works", () => {
    seedPage(db, "entity/person", "entity/person", "黄仁勋", 10);

    const mgr = new DiscoveryManager(db);
    const results = mgr.detectGaps();

    const gap = results.find(r => r.entities.includes("entity/person"));
    expect(gap).toBeDefined();
  });

  test("non-whitelisted entity type filtered out of gaps", () => {
    seedPage(db, "entity/noise", "entity/disease", "银行转账", 15);

    const mgr = new DiscoveryManager(db);
    const results = mgr.detectGaps();

    const gap = results.find(r => r.entities.includes("entity/noise"));
    expect(gap).toBeUndefined();
  });

  test("gap actionable=high only when mention_count >= 20 and link_count === 0", () => {
    seedPage(db, "entity/big", "entity/person", "重要人物", 25);

    const mgr = new DiscoveryManager(db);
    const results = mgr.detectGaps();

    const gap = results.find(r => r.entities.includes("entity/big"));
    expect(gap).toBeDefined();
    expect(gap!.actionable).toBe("high");
  });

  test("gap actionable=medium when score < 0.7", () => {
    // mention_count=10 gives mentionScore≈0.6, with 1 link isolationScore≈0.5
    // score = 0.6*0.6 + 0.5*0.4 = 0.56 < 0.7 → medium
    seedPage(db, "entity/low", "entity/person", "低分人物", 10);
    seedPage(db, "record/src", "record", "来源", 1);
    db.insertLink("record/src", "entity/low", "提及", 0.5);

    const mgr = new DiscoveryManager(db);
    const results = mgr.detectGaps();

    const gap = results.find(r => r.entities.includes("entity/low"));
    expect(gap).toBeDefined();
    expect(gap!.actionable).toBe("medium");
  });
});

describe("DiscoveryManager - detectContradictions", () => {
  const testDir = "/tmp/cbrain-test-discovery-contradiction";
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

  test("detects contradiction between two sources", async () => {
    seedPage(db, "entity/person", "entity/person", "某公司", 5);
    seedPage(db, "records/note1", "record", "会议记录1", 0);
    seedPage(db, "records/note2", "record", "会议记录2", 0);
    db.insertLink("records/note1", "entity/person", "提及", 0.8, "ner");
    db.insertLink("records/note2", "entity/person", "提及", 0.8, "ner");

    const mockLlm = createMockLlm(JSON.stringify({
      has_contradiction: true,
      confidence: 0.85,
      explanation: "两个来源对该公司业务方向描述矛盾",
      suggested_resolution: "核实后保留最新来源",
    }));

    const mgr = new DiscoveryManager(db, mockLlm);
    const results = await mgr.detectContradictions();

    expect(results.length).toBeGreaterThanOrEqual(1);
    const c = results.find(r => r.entities.includes("entity/person"));
    expect(c).toBeDefined();
    expect(c!.type).toBe("contradiction");
    expect(c!.metadata?.explanation).toContain("矛盾");
    expect(c!.actionable).toBe("high");
  });

  test("no contradiction when LLM says no", async () => {
    seedPage(db, "entity/person", "entity/person", "某公司", 5);
    seedPage(db, "records/note1", "record", "会议记录1", 0);
    seedPage(db, "records/note2", "record", "会议记录2", 0);
    db.insertLink("records/note1", "entity/person", "提及", 0.8, "ner");
    db.insertLink("records/note2", "entity/person", "提及", 0.8, "ner");

    const mockLlm = createMockLlm(JSON.stringify({
      has_contradiction: false,
      confidence: 0.3,
      explanation: "来源一致",
      suggested_resolution: "",
    }));

    const mgr = new DiscoveryManager(db, mockLlm);
    const results = await mgr.detectContradictions();

    expect(results.length).toBe(0);
  });

  test("no LLM → no contradictions detected", async () => {
    seedPage(db, "entity/person", "entity/person", "某公司", 5);
    seedPage(db, "records/note1", "record", "会议记录1", 0);
    seedPage(db, "records/note2", "record", "会议记录2", 0);
    db.insertLink("records/note1", "entity/person", "提及", 0.8, "ner");
    db.insertLink("records/note2", "entity/person", "提及", 0.8, "ner");

    const mgr = new DiscoveryManager(db);
    const results = await mgr.detectContradictions();

    expect(results.length).toBe(0);
  });

  test("invalid LLM JSON → graceful fallback", async () => {
    seedPage(db, "entity/person", "entity/person", "某公司", 5);
    seedPage(db, "records/note1", "record", "会议记录1", 0);
    seedPage(db, "records/note2", "record", "会议记录2", 0);
    db.insertLink("records/note1", "entity/person", "提及", 0.8, "ner");
    db.insertLink("records/note2", "entity/person", "提及", 0.8, "ner");

    const mockLlm = createMockLlm("not valid json {{{");

    const mgr = new DiscoveryManager(db, mockLlm);
    const results = await mgr.detectContradictions();

    expect(results.length).toBe(0);
  });

  test("LLM returns markdown-fenced JSON → still parsed correctly", async () => {
    seedPage(db, "entity/person", "entity/person", "某公司", 5);
    seedPage(db, "records/note1", "record", "会议记录1", 0);
    seedPage(db, "records/note2", "record", "会议记录2", 0);
    db.insertLink("records/note1", "entity/person", "提及", 0.8, "ner");
    db.insertLink("records/note2", "entity/person", "提及", 0.8, "ner");

    const mockLlm = createMockLlm("```json\n{\"has_contradiction\": true, \"confidence\": 0.9, \"explanation\": \"矛盾\", \"suggested_resolution\": \"核实\"}\n```");

    const mgr = new DiscoveryManager(db, mockLlm);
    const results = await mgr.detectContradictions();

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.metadata?.explanation).toBe("矛盾");
  });
});

describe("DiscoveryManager - runDiscovery orchestration", () => {
  const testDir = "/tmp/cbrain-test-discovery-orchestration";
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

  test("runDiscovery with type filter only runs specified types", async () => {
    seedPage(db, "entity/a", "entity/person", "A", 10);
    db.upsertMentionSnapshot("entity/a", daysAgo(3), 3);
    db.upsertMentionSnapshot("entity/a", daysAgo(2), 5);
    db.upsertMentionSnapshot("entity/a", daysAgo(1), 7);
    db.upsertMentionSnapshot("entity/a", daysAgo(0), 9);

    const mgr = new DiscoveryManager(db);
    const report = await mgr.runDiscovery(["trend"]);

    expect(report.total).toBeGreaterThanOrEqual(1);
    expect(Object.keys(report.byType)).toEqual(["trend"]);
  });

  test("runDiscovery with no filter runs all types", async () => {
    seedPage(db, "entity/a", "entity/person", "A", 10);
    seedPage(db, "entity/b", "entity/person", "B", 3);
    db.insertLink("entity/a", "entity/b", "提及", 0.5, "ner");
    db.upsertMentionSnapshot("entity/a", daysAgo(3), 3);
    db.upsertMentionSnapshot("entity/a", daysAgo(2), 5);
    db.upsertMentionSnapshot("entity/a", daysAgo(1), 7);
    db.upsertMentionSnapshot("entity/a", daysAgo(0), 9);

    const mgr = new DiscoveryManager(db);
    const report = await mgr.runDiscovery();

    expect(report.total).toBeGreaterThanOrEqual(1);
    expect(report.byType.trend ?? 0).toBeGreaterThanOrEqual(1);
  });

  test("runDiscovery returns different types for same entity", async () => {
    seedPage(db, "entity/island", "entity/person", "Island", 10);
    db.upsertMentionSnapshot("entity/island", daysAgo(3), 3);
    db.upsertMentionSnapshot("entity/island", daysAgo(2), 5);
    db.upsertMentionSnapshot("entity/island", daysAgo(1), 7);
    db.upsertMentionSnapshot("entity/island", daysAgo(0), 9);

    const mgr = new DiscoveryManager(db);
    const report = await mgr.runDiscovery();

    // Both trend and gap for same entity — different types, both kept
    expect(report.total).toBeGreaterThanOrEqual(2);
  });
});

describe("Discovery ordering — actionable + score priority", () => {
  const testDir = "/tmp/cbrain-test-discovery-ordering";
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

  test("getUnseenDiscoveries returns high actionable first, then by score DESC", () => {
    seedPage(db, "entity/a", "entity/person", "A", 3);
    seedPage(db, "entity/b", "entity/person", "B", 3);
    seedPage(db, "entity/c", "entity/person", "C", 3);

    // medium inserted first, high inserted after
    db.addDiscovery("gap", ["entity/a"], 0.5, undefined, undefined, "medium");
    db.addDiscovery("bridge", ["entity/b"], 1.0, undefined, undefined, "high");
    db.addDiscovery("gap", ["entity/c"], 0.3, undefined, undefined, "high");

    const results = db.getUnseenDiscoveries(10);
    expect(results.length).toBe(3);
    // high actionable first (score DESC), then medium
    expect(results[0].type).toBe("bridge");
    expect(results[1].type).toBe("gap");
    expect(results[2].actionable).toBe("medium");
  });

  test("getDiscoveriesByActionable returns by score DESC within same actionable level", () => {
    seedPage(db, "entity/a", "entity/person", "A", 3);
    seedPage(db, "entity/b", "entity/person", "B", 3);

    db.addDiscovery("bridge", ["entity/a"], 1.0, undefined, undefined, "high");
    db.addDiscovery("gap", ["entity/b"], 0.5, undefined, undefined, "high");

    const results = db.getDiscoveriesByActionable("high", 10);
    expect(results.length).toBe(2);
    expect(results[0].score).toBe(1.0);
    expect(results[1].score).toBe(0.5);
  });
});
