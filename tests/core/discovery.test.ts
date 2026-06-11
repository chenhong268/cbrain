import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
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
    db.rawDb.prepare("UPDATE pages SET mention_count = $mc WHERE slug = $slug")
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
    const { id } = db.upsertDiscovery("trend", ["entity/test"], 0.8, undefined, undefined, "low", false, { direction: "trend_rising" });
    db.updateDiscoveryStatus(id, "resolved");

    const d = db.getDiscoveryById(id);
    expect(d).not.toBeNull();
    expect(d!.status).toBe("resolved");
  });

  test("discoveries table stores metadata", () => {
    seedPage(db, "entity/test", "entity/person", "Test");
    const { id } = db.upsertDiscovery("trend", ["entity/test"], 0.8, undefined, undefined, "low", false, { direction: "trend_rising", delta: 5 });

    const d = db.getDiscoveryById(id);
    expect(d).not.toBeNull();
    const meta = JSON.parse(d!.metadata!);
    expect(meta.direction).toBe("trend_rising");
    expect(meta.delta).toBe(5);
  });

  test("discoveries default status is pending", () => {
    seedPage(db, "entity/test", "entity/person", "Test");
    const { id } = db.upsertDiscovery("trend", ["entity/test"], 0.8);

    const d = db.getDiscoveryById(id);
    expect(d).not.toBeNull();
    expect(d!.status).toBe("pending");
    expect(d!.metadata).toBeNull();
  });

  test("upsertDiscovery without metadata still works", () => {
    seedPage(db, "entity/foo", "entity/person", "Foo");
    const { id } = db.upsertDiscovery("bridge", ["entity/foo"], 0.5, { note: "test" });
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
    db.insertLink("entity/a", "entity/b", "提及", null, 0.5, undefined, "ner");
    db.insertLink("entity/a", "entity/a1", "提及", null, 0.5, undefined, "ner");
    db.insertLink("entity/b", "entity/c", "提及", null, 0.5, undefined, "ner");
    db.insertLink("entity/c", "entity/d", "提及", null, 0.5, undefined, "ner");
    db.insertLink("entity/d", "entity/e", "提及", null, 0.5, undefined, "ner");
    db.insertLink("entity/e", "entity/e1", "提及", null, 0.5, undefined, "ner");

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
    db.insertLink("entity/a", "entity/b", "提及", null, 0.5, undefined, "ner");
    db.insertLink("entity/b", "entity/c", "提及", null, 0.5, undefined, "ner");
    db.insertLink("entity/a", "entity/c", "提及", null, 0.5, undefined, "ner");

    const mgr = new DiscoveryManager(db);
    const results = mgr.detectBridges();

    const bridges = results.filter(r => (r.metadata?.distance as number) >= 4);
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
    db.insertLink("entity/connected", "entity/b", "提及", null, 0.5, undefined, "ner");
    db.insertLink("entity/c", "entity/connected", "提及", null, 0.5, undefined, "ner");

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
    db.insertLink("record/src", "entity/low", "提及", null, 0.5);

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
    db.insertLink("records/note1", "entity/person", "提及", null, 0.8, undefined, "ner");
    db.insertLink("records/note2", "entity/person", "提及", null, 0.8, undefined, "ner");

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
    db.insertLink("records/note1", "entity/person", "提及", null, 0.8, undefined, "ner");
    db.insertLink("records/note2", "entity/person", "提及", null, 0.8, undefined, "ner");

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
    db.insertLink("records/note1", "entity/person", "提及", null, 0.8, undefined, "ner");
    db.insertLink("records/note2", "entity/person", "提及", null, 0.8, undefined, "ner");

    const mgr = new DiscoveryManager(db);
    const results = await mgr.detectContradictions();

    expect(results.length).toBe(0);
  });

  test("invalid LLM JSON → graceful fallback", async () => {
    seedPage(db, "entity/person", "entity/person", "某公司", 5);
    seedPage(db, "records/note1", "record", "会议记录1", 0);
    seedPage(db, "records/note2", "record", "会议记录2", 0);
    db.insertLink("records/note1", "entity/person", "提及", null, 0.8, undefined, "ner");
    db.insertLink("records/note2", "entity/person", "提及", null, 0.8, undefined, "ner");

    const mockLlm = createMockLlm("not valid json {{{");

    const mgr = new DiscoveryManager(db, mockLlm);
    const results = await mgr.detectContradictions();

    expect(results.length).toBe(0);
  });

  test("LLM returns markdown-fenced JSON → still parsed correctly", async () => {
    seedPage(db, "entity/person", "entity/person", "某公司", 5);
    seedPage(db, "records/note1", "record", "会议记录1", 0);
    seedPage(db, "records/note2", "record", "会议记录2", 0);
    db.insertLink("records/note1", "entity/person", "提及", null, 0.8, undefined, "ner");
    db.insertLink("records/note2", "entity/person", "提及", null, 0.8, undefined, "ner");

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
    db.insertLink("entity/a", "entity/b", "提及", null, 0.5, undefined, "ner");
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
    db.upsertDiscovery("gap", ["entity/a"], 0.5, undefined, undefined, "medium");
    db.upsertDiscovery("bridge", ["entity/b"], 1.0, undefined, undefined, "high");
    db.upsertDiscovery("gap", ["entity/c"], 0.3, undefined, undefined, "high");

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

    db.upsertDiscovery("bridge", ["entity/a"], 1.0, undefined, undefined, "high");
    db.upsertDiscovery("gap", ["entity/b"], 0.5, undefined, undefined, "high");

    const results = db.getDiscoveriesByActionable("high", 10);
    expect(results.length).toBe(2);
    expect(results[0].score).toBe(1.0);
    expect(results[1].score).toBe(0.5);
  });
});

// ─── Cross-run dedup + recurrence + migration ──────────────────

describe("Discovery dedup — upsertDiscovery", () => {
  const testDir = "/tmp/cbrain-test-discovery-dedup";
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

  test("reversed entity order produces one row (canonical identity)", () => {
    seedPage(db, "entity/a", "entity/person", "A");
    seedPage(db, "entity/b", "entity/person", "B");

    const r1 = db.upsertDiscovery("bridge", ["entity/a", "entity/b"], 0.9, undefined, undefined, "high");
    const r2 = db.upsertDiscovery("bridge", ["entity/b", "entity/a"], 0.9, undefined, undefined, "high");

    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(false);
    expect(r1.id).toBe(r2.id);
  });

  test("duplicate entity entries resolve to one key", () => {
    seedPage(db, "entity/x", "entity/person", "X");

    const r1 = db.upsertDiscovery("gap", ["entity/x", "entity/x"], 0.5, undefined, undefined, "medium");
    const r2 = db.upsertDiscovery("gap", ["entity/x"], 0.5, undefined, undefined, "medium");

    // Both deduplicate to the same key since [...new Set(["entity/x","entity/x"])] = ["entity/x"]
    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(false);
    expect(r1.id).toBe(r2.id);
  });

  test("two consecutive runDiscovery calls produce one durable row", async () => {
    seedPage(db, "entity/a", "entity/person", "A", 3);
    seedPage(db, "entity/b", "entity/person", "B", 3);
    seedPage(db, "entity/c", "entity/person", "C", 3);
    seedPage(db, "entity/d", "entity/person", "D", 3);
    seedPage(db, "entity/e", "entity/person", "E", 3);
    seedPage(db, "entity/a1", "entity/person", "A1", 3);
    seedPage(db, "entity/e1", "entity/person", "E1", 3);
    db.insertLink("entity/a", "entity/b", "提及", null, 0.5, undefined, "ner");
    db.insertLink("entity/a", "entity/a1", "提及", null, 0.5, undefined, "ner");
    db.insertLink("entity/b", "entity/c", "提及", null, 0.5, undefined, "ner");
    db.insertLink("entity/c", "entity/d", "提及", null, 0.5, undefined, "ner");
    db.insertLink("entity/d", "entity/e", "提及", null, 0.5, undefined, "ner");
    db.insertLink("entity/e", "entity/e1", "提及", null, 0.5, undefined, "ner");

    const mgr = new DiscoveryManager(db);

    const report1 = await mgr.runDiscovery(["bridge"]);
    expect(report1.total).toBeGreaterThanOrEqual(1);

    const report2 = await mgr.runDiscovery(["bridge"]);
    expect(report2.total).toBe(0);
  });

  test("runDiscovery twice without marking seen — one row, occurrence=2", async () => {
    seedPage(db, "entity/a", "entity/person", "A", 3);
    seedPage(db, "entity/b", "entity/person", "B", 3);
    seedPage(db, "entity/c", "entity/person", "C", 3);
    seedPage(db, "entity/d", "entity/person", "D", 3);
    seedPage(db, "entity/e", "entity/person", "E", 3);
    seedPage(db, "entity/a1", "entity/person", "A1", 3);
    seedPage(db, "entity/e1", "entity/person", "E1", 3);
    db.insertLink("entity/a", "entity/b", "提及", null, 0.5, undefined, "ner");
    db.insertLink("entity/a", "entity/a1", "提及", null, 0.5, undefined, "ner");
    db.insertLink("entity/b", "entity/c", "提及", null, 0.5, undefined, "ner");
    db.insertLink("entity/c", "entity/d", "提及", null, 0.5, undefined, "ner");
    db.insertLink("entity/d", "entity/e", "提及", null, 0.5, undefined, "ner");
    db.insertLink("entity/e", "entity/e1", "提及", null, 0.5, undefined, "ner");

    const mgr = new DiscoveryManager(db);

    await mgr.runDiscovery(["bridge"]);
    await mgr.runDiscovery(["bridge"]);

    // Should have exactly 1 row for the a-e bridge
    const allBridges = db.getDiscoveriesByType("bridge", 10);
    expect(allBridges.length).toBe(1);

    const d = db.getDiscoveryById(allBridges[0].id);
    expect(d!.occurrence_count).toBe(2);
  });

  test("repeat detection increments occurrence and updates last_detected_at", () => {
    seedPage(db, "entity/a", "entity/person", "A");

    const r1 = db.upsertDiscovery("gap", ["entity/a"], 0.5, undefined, undefined, "medium", false, { mention_count: 10 });
    const r2 = db.upsertDiscovery("gap", ["entity/a"], 0.6, undefined, undefined, "medium", false, { mention_count: 12 });

    expect(r1.inserted).toBe(true);
    expect(r1.occurrenceCount).toBe(1);
    expect(r2.inserted).toBe(false);
    expect(r2.occurrenceCount).toBe(2);

    const d = db.getDiscoveryById(r1.id);
    expect(d!.occurrence_count).toBe(2);
    expect(d!.score).toBe(0.6);
    const meta = JSON.parse(d!.metadata!);
    expect(meta.mention_count).toBe(12);
    expect(d!.last_detected_at).not.toBeNull();
    expect(d!.detected_at).not.toBeNull();
  });

  test("seen status survives recurrence", () => {
    seedPage(db, "entity/a", "entity/person", "A");

    const { id } = db.upsertDiscovery("gap", ["entity/a"], 0.5, undefined, undefined, "medium");
    db.markDiscoverySeen(id);

    db.upsertDiscovery("gap", ["entity/a"], 0.6, undefined, undefined, "medium");

    const d = db.getDiscoveryById(id);
    expect(d!.seen).toBe(1);
  });

  test("resolved status survives recurrence", () => {
    seedPage(db, "entity/a", "entity/person", "A");

    const { id } = db.upsertDiscovery("bridge", ["entity/a"], 0.9, undefined, undefined, "high");
    db.updateDiscoveryStatus(id, "resolved");

    db.upsertDiscovery("bridge", ["entity/a"], 0.9, undefined, undefined, "high");

    const d = db.getDiscoveryById(id);
    expect(d!.status).toBe("resolved");
  });

  test("dismissed status survives recurrence", () => {
    seedPage(db, "entity/a", "entity/person", "A");

    const { id } = db.upsertDiscovery("bridge", ["entity/a"], 0.9, undefined, undefined, "high");
    db.updateDiscoveryStatus(id, "dismissed");

    db.upsertDiscovery("bridge", ["entity/a"], 0.9, undefined, undefined, "high");

    const d = db.getDiscoveryById(id);
    expect(d!.status).toBe("dismissed");
  });

  test("suggestion survives recurrence", () => {
    seedPage(db, "entity/a", "entity/person", "A");

    const { id } = db.upsertDiscovery("bridge", ["entity/a"], 0.9, undefined, undefined, "high");
    db.updateDiscoverySuggestion(id, "建议验证");

    db.upsertDiscovery("bridge", ["entity/a"], 0.9, undefined, undefined, "high");

    const d = db.getDiscoveryById(id);
    expect(d!.suggestion).toBe("建议验证");
  });

  test("different discovery types for same entities remain distinct", () => {
    seedPage(db, "entity/a", "entity/person", "A");
    seedPage(db, "entity/b", "entity/person", "B");

    const r1 = db.upsertDiscovery("bridge", ["entity/a", "entity/b"], 0.9, undefined, undefined, "high");
    const r2 = db.upsertDiscovery("contradiction", ["entity/a", "entity/b"], 0.8, undefined, undefined, "high");

    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(true);
    expect(r1.id).not.toBe(r2.id);
  });

  test("no writes outside discoveries-related tables", () => {
    seedPage(db, "entity/a", "entity/person", "A");

    const pagesBefore = (db.rawDb.prepare("SELECT COUNT(*) as c FROM pages").get() as any).c;
    const linksBefore = (db.rawDb.prepare("SELECT COUNT(*) as c FROM links").get() as any).c;
    const timelineBefore = (db.rawDb.prepare("SELECT COUNT(*) as c FROM timeline").get() as any).c;
    const insightsBefore = (db.rawDb.prepare("SELECT COUNT(*) as c FROM insights").get() as any).c;

    db.upsertDiscovery("gap", ["entity/a"], 0.5, undefined, undefined, "medium");
    db.upsertDiscovery("gap", ["entity/a"], 0.6, undefined, undefined, "medium");

    expect((db.rawDb.prepare("SELECT COUNT(*) as c FROM pages").get() as any).c).toBe(pagesBefore);
    expect((db.rawDb.prepare("SELECT COUNT(*) as c FROM links").get() as any).c).toBe(linksBefore);
    expect((db.rawDb.prepare("SELECT COUNT(*) as c FROM timeline").get() as any).c).toBe(timelineBefore);
    expect((db.rawDb.prepare("SELECT COUNT(*) as c FROM insights").get() as any).c).toBe(insightsBefore);
  });
});

describe("Discovery dedup — enrichment budget", () => {
  const testDir = "/tmp/cbrain-test-discovery-enrichment";
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

  test("repeat detection performs no second LLM enrichment call", async () => {
    let llmCallCount = 0;
    const mockLlm: LLMProvider = {
      name: "mock",
      chat: async () => {
        llmCallCount++;
        return JSON.stringify({ suggestion: "test" });
      },
    };

    // Use gap detection — entity with high mentions and zero links → actionable=high
    seedPage(db, "entity/island", "entity/person", "Island", 25);

    const mgr = new DiscoveryManager(db, mockLlm);

    await mgr.runDiscovery(["gap"]);
    const callsRun1 = llmCallCount;
    expect(callsRun1).toBeGreaterThanOrEqual(1);

    await mgr.runDiscovery(["gap"]);
    expect(llmCallCount).toBe(callsRun1); // no additional LLM calls
  });
});

describe("Discovery dedup — migration consolidation", () => {
  const testDir = "/tmp/cbrain-test-discovery-migration";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("migration consolidates pre-existing duplicates", () => {
    // Use raw sqlite to create pre-migration state with duplicate rows
    const rawDb = new Database(dbPath);
    rawDb.exec(`CREATE TABLE IF NOT EXISTS discoveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      entities TEXT NOT NULL,
      score REAL NOT NULL,
      detail TEXT,
      detected_at TEXT NOT NULL,
      dream_run TEXT,
      seen INTEGER NOT NULL DEFAULT 0,
      actionable TEXT DEFAULT 'low',
      suggestion TEXT,
      proposed_actions TEXT,
      auto_applicable INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      metadata TEXT
    )`);
    rawDb.prepare(
      "INSERT INTO discoveries (type, entities, score, detail, detected_at, dream_run, actionable, auto_applicable, status) VALUES ($type, $entities, $score, $detail, $detected, $run, $actionable, $auto, $status)"
    ).run({
      $type: "bridge",
      $entities: '["entity/a","entity/b"]',
      $score: 0.9,
      $detail: null,
      $detected: "2026-05-01 10:00:00",
      $run: null,
      $actionable: "high",
      $auto: 0,
      $status: "pending",
    });
    rawDb.prepare(
      "INSERT INTO discoveries (type, entities, score, detail, detected_at, dream_run, actionable, auto_applicable, seen, status, suggestion) VALUES ($type, $entities, $score, $detail, $detected, $run, $actionable, $auto, $seen, $status, $suggestion)"
    ).run({
      $type: "bridge",
      $entities: '["entity/a","entity/b"]',
      $score: 0.95,
      $detail: null,
      $detected: "2026-05-15 10:00:00",
      $run: null,
      $actionable: "high",
      $auto: 0,
      $seen: 1,
      $status: "seen",
      $suggestion: "建议验证",
    });
    rawDb.prepare(
      "INSERT INTO discoveries (type, entities, score, detail, detected_at, dream_run, actionable, auto_applicable, status) VALUES ($type, $entities, $score, $detail, $detected, $run, $actionable, $auto, $status)"
    ).run({
      $type: "bridge",
      $entities: '["entity/a","entity/b"]',
      $score: 1.0,
      $detail: null,
      $detected: "2026-06-01 10:00:00",
      $run: null,
      $actionable: "high",
      $auto: 0,
      $status: "dismissed",
    });
    rawDb.close();

    // Re-open triggers migration
    db = new CBrainDB(dbPath);

    // Should consolidate to 1 row
    const rows = db.rawDb.prepare("SELECT id, score, seen, status, suggestion, occurrence_count, last_detected_at, dedup_key FROM discoveries").all() as any[];
    expect(rows.length).toBe(1);
    const d = rows[0];
    expect(d.status).toBe("dismissed"); // terminal status preserved
    expect(d.seen).toBe(1); // seen=1 preserved from any duplicate
    expect(d.suggestion).toBe("建议验证"); // suggestion preserved
    expect(d.occurrence_count).toBe(3);
    expect(d.score).toBe(1.0); // latest score
    expect(d.last_detected_at).toBe("2026-06-01 10:00:00");
    expect(d.dedup_key).toBe('bridge|["entity/a","entity/b"]');

    // Unique index prevents re-insert
    const r = db.upsertDiscovery("bridge", ["entity/a", "entity/b"], 0.5);
    expect(r.inserted).toBe(false);
    expect(r.occurrenceCount).toBe(4);
  });

  test("unique index prevents second physical row", () => {
    db = new CBrainDB(dbPath);
    seedPage(db, "entity/a", "entity/person", "A");

    const r1 = db.upsertDiscovery("gap", ["entity/a"], 0.5);
    const r2 = db.upsertDiscovery("gap", ["entity/a"], 0.6);

    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(false);

    const count = (db.rawDb.prepare("SELECT COUNT(*) as c FROM discoveries").get() as any).c;
    expect(count).toBe(1);
  });

  test("migration canonicalizes reversed entity order", () => {
    const rawDb = new Database(dbPath);
    rawDb.exec(`CREATE TABLE IF NOT EXISTS discoveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      entities TEXT NOT NULL,
      score REAL NOT NULL,
      detail TEXT,
      detected_at TEXT NOT NULL,
      dream_run TEXT,
      seen INTEGER NOT NULL DEFAULT 0,
      actionable TEXT DEFAULT 'low',
      suggestion TEXT,
      proposed_actions TEXT,
      auto_applicable INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      metadata TEXT
    )`);
    // Same bridge but reversed entity order
    rawDb.prepare("INSERT INTO discoveries (type, entities, score, detected_at, status) VALUES ($type, $entities, $score, $detected, $status)")
      .run({ $type: "bridge", $entities: '["entity/a","entity/b"]', $score: 0.9, $detected: "2026-05-01", $status: "pending" });
    rawDb.prepare("INSERT INTO discoveries (type, entities, score, detected_at, status, seen) VALUES ($type, $entities, $score, $detected, $status, $seen)")
      .run({ $type: "bridge", $entities: '["entity/b","entity/a"]', $score: 0.95, $detected: "2026-06-01", $status: "seen", $seen: 1 });
    rawDb.close();

    db = new CBrainDB(dbPath);
    const rows = db.rawDb.prepare("SELECT dedup_key, occurrence_count, score, seen FROM discoveries").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].dedup_key).toBe('bridge|["entity/a","entity/b"]');
    expect(rows[0].occurrence_count).toBe(2);
    expect(rows[0].seen).toBe(1);
    expect(rows[0].score).toBe(0.95);
  });

  test("migration canonicalizes duplicate entity entries", () => {
    const rawDb = new Database(dbPath);
    rawDb.exec(`CREATE TABLE IF NOT EXISTS discoveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      entities TEXT NOT NULL,
      score REAL NOT NULL,
      detail TEXT,
      detected_at TEXT NOT NULL,
      dream_run TEXT,
      seen INTEGER NOT NULL DEFAULT 0,
      actionable TEXT DEFAULT 'low',
      suggestion TEXT,
      proposed_actions TEXT,
      auto_applicable INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      metadata TEXT
    )`);
    // Same gap with duplicated entity slug
    rawDb.prepare("INSERT INTO discoveries (type, entities, score, detected_at, status) VALUES ($type, $entities, $score, $detected, $status)")
      .run({ $type: "gap", $entities: '["entity/x"]', $score: 0.5, $detected: "2026-05-01", $status: "pending" });
    rawDb.prepare("INSERT INTO discoveries (type, entities, score, detected_at, status) VALUES ($type, $entities, $score, $detected, $status)")
      .run({ $type: "gap", $entities: '["entity/x","entity/x"]', $score: 0.6, $detected: "2026-06-01", $status: "pending" });
    rawDb.close();

    db = new CBrainDB(dbPath);
    const rows = db.rawDb.prepare("SELECT dedup_key, occurrence_count FROM discoveries").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].dedup_key).toBe('gap|["entity/x"]');
    expect(rows[0].occurrence_count).toBe(2);
  });

  test("migration aggregates existing occurrence_count on re-migration", () => {
    const rawDb = new Database(dbPath);
    rawDb.exec(`CREATE TABLE IF NOT EXISTS discoveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      entities TEXT NOT NULL,
      score REAL NOT NULL,
      detail TEXT,
      detected_at TEXT NOT NULL,
      dream_run TEXT,
      seen INTEGER NOT NULL DEFAULT 0,
      actionable TEXT DEFAULT 'low',
      suggestion TEXT,
      proposed_actions TEXT,
      auto_applicable INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      metadata TEXT,
      occurrence_count INTEGER DEFAULT 1
    )`);
    // Two rows with same dedup_key and pre-existing occurrence_count values
    rawDb.prepare("INSERT INTO discoveries (type, entities, score, detected_at, status, occurrence_count) VALUES ($type, $entities, $score, $detected, $status, $occ)")
      .run({ $type: "bridge", $entities: '["entity/a","entity/b"]', $score: 0.9, $detected: "2026-05-01", $status: "pending", $occ: 5 });
    rawDb.prepare("INSERT INTO discoveries (type, entities, score, detected_at, status, occurrence_count) VALUES ($type, $entities, $score, $detected, $status, $occ)")
      .run({ $type: "bridge", $entities: '["entity/a","entity/b"]', $score: 1.0, $detected: "2026-06-01", $status: "pending", $occ: 3 });
    rawDb.close();

    db = new CBrainDB(dbPath);
    const rows = db.rawDb.prepare("SELECT occurrence_count FROM discoveries").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].occurrence_count).toBe(8); // 5 + 3, not 2
  });
});

describe("Discovery dedup — concurrency", () => {
  const testDir = "/tmp/cbrain-test-discovery-concurrency";
  const dbPath = join(testDir, "test.sqlite");

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("two connections upserting same key produce one durable row", () => {
    // First connection creates the DB and schema
    const db1 = new CBrainDB(dbPath);
    seedPage(db1, "entity/a", "entity/person", "A");

    const r1 = db1.upsertDiscovery("gap", ["entity/a"], 0.5);
    expect(r1.inserted).toBe(true);

    // Second connection opens same DB
    const db2 = new CBrainDB(dbPath);
    const r2 = db2.upsertDiscovery("gap", ["entity/a"], 0.6);
    expect(r2.inserted).toBe(false);
    expect(r2.occurrenceCount).toBe(2);

    // Verify physical uniqueness
    const count = (db2.rawDb.prepare("SELECT COUNT(*) as c FROM discoveries").get() as any).c;
    expect(count).toBe(1);

    db2.close();
    db1.close();
  });
});

describe("Discovery dedup — migration recovery", () => {
  const testDir = "/tmp/cbrain-test-discovery-migration-recovery";
  const dbPath = join(testDir, "test.sqlite");

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function makePreMigrationSchema(rawDb: Database): void {
    rawDb.exec(`CREATE TABLE IF NOT EXISTS discoveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      entities TEXT NOT NULL,
      score REAL NOT NULL,
      detail TEXT,
      detected_at TEXT NOT NULL,
      dream_run TEXT,
      seen INTEGER NOT NULL DEFAULT 0,
      actionable TEXT DEFAULT 'low',
      suggestion TEXT,
      proposed_actions TEXT,
      auto_applicable INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      metadata TEXT
    )`);
  }

  test("existing unique index + NULL-key reversed-order dupes → re-open succeeds, one row", () => {
    // Simulate interrupted/partial migration: schema has columns + unique index + NULL key dupes
    const rawDb = new Database(dbPath);
    makePreMigrationSchema(rawDb);
    // Add dedup columns manually
    rawDb.exec("ALTER TABLE discoveries ADD COLUMN dedup_key TEXT");
    rawDb.exec("ALTER TABLE discoveries ADD COLUMN last_detected_at TEXT");
    rawDb.exec("ALTER TABLE discoveries ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1");
    // Create unique index (simulates prior partial migration)
    rawDb.exec("CREATE UNIQUE INDEX idx_discoveries_dedup_key ON discoveries(dedup_key)");
    // Insert two rows with NULL dedup_key and reversed entity order
    rawDb.prepare("INSERT INTO discoveries (type, entities, score, detected_at, status) VALUES ($type, $entities, $score, $detected, $status)")
      .run({ $type: "bridge", $entities: '["entity/a","entity/b"]', $score: 0.9, $detected: "2026-05-01", $status: "pending" });
    rawDb.prepare("INSERT INTO discoveries (type, entities, score, detected_at, status, seen) VALUES ($type, $entities, $score, $detected, $status, $seen)")
      .run({ $type: "bridge", $entities: '["entity/b","entity/a"]', $score: 0.95, $detected: "2026-06-01", $status: "seen", $seen: 1 });
    rawDb.close();

    // Re-opening must NOT crash — migration handles the NULL-key dupes
    const db = new CBrainDB(dbPath);
    const rows = db.rawDb.prepare("SELECT dedup_key, occurrence_count, seen, score FROM discoveries").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].dedup_key).toBe('bridge|["entity/a","entity/b"]');
    expect(rows[0].occurrence_count).toBe(2);
    expect(rows[0].seen).toBe(1);
    expect(rows[0].score).toBe(0.95);

    // Unique index still exists
    const idx = db.rawDb.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_discoveries_dedup_key'").all() as any[];
    expect(idx.length).toBe(1);
    db.close();
  });

  test("non-canonical non-NULL keys get re-canonicalized and consolidated", () => {
    const rawDb = new Database(dbPath);
    makePreMigrationSchema(rawDb);
    rawDb.exec("ALTER TABLE discoveries ADD COLUMN dedup_key TEXT");
    rawDb.exec("ALTER TABLE discoveries ADD COLUMN last_detected_at TEXT");
    rawDb.exec("ALTER TABLE discoveries ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1");
    rawDb.exec("CREATE UNIQUE INDEX idx_discoveries_dedup_key ON discoveries(dedup_key)");
    // Insert rows with non-canonical keys (raw type||entities, no sort)
    rawDb.prepare("INSERT INTO discoveries (type, entities, score, detected_at, status, dedup_key) VALUES ($type, $entities, $score, $detected, $status, $key)")
      .run({ $type: "gap", $entities: '["entity/x"]', $score: 0.5, $detected: "2026-05-01", $status: "pending", $key: 'gap|["entity/x"]' });
    rawDb.prepare("INSERT INTO discoveries (type, entities, score, detected_at, status, dedup_key) VALUES ($type, $entities, $score, $detected, $status, $key)")
      .run({ $type: "gap", $entities: '["entity/x","entity/x"]', $score: 0.6, $detected: "2026-06-01", $status: "pending", $key: 'gap|["entity/x","entity/x"]' });
    rawDb.close();

    const db = new CBrainDB(dbPath);
    const rows = db.rawDb.prepare("SELECT dedup_key, occurrence_count FROM discoveries").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].dedup_key).toBe('gap|["entity/x"]');
    expect(rows[0].occurrence_count).toBe(2);
    db.close();
  });

  test("migration is idempotent — runs twice without error", () => {
    const db1 = new CBrainDB(dbPath);
    seedPage(db1, "entity/a", "entity/person", "A");
    db1.upsertDiscovery("gap", ["entity/a"], 0.5);
    db1.close();

    // Second open triggers migration again on existing data
    const db2 = new CBrainDB(dbPath);
    const rows = db2.rawDb.prepare("SELECT dedup_key, occurrence_count FROM discoveries").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].dedup_key).toBe('gap|["entity/a"]');
    expect(rows[0].occurrence_count).toBe(1);
    db2.close();

    // Third open — still idempotent
    const db3 = new CBrainDB(dbPath);
    const rows3 = db3.rawDb.prepare("SELECT COUNT(*) as c FROM discoveries").get() as any;
    expect(rows3.c).toBe(1);
    db3.close();
  });
});
