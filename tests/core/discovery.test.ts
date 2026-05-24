import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { DiscoveryManager } from "../../src/core/discovery.js";

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
    seedPage(db, "entity/a", "entity/person", "A", 3);
    seedPage(db, "entity/b", "entity/person", "B", 3);
    seedPage(db, "entity/c", "entity/person", "C", 3);
    seedPage(db, "entity/d", "entity/person", "D", 3);
    seedPage(db, "entity/e", "entity/person", "E", 3);
    db.insertLink("entity/a", "entity/b", "提及", 0.5, "ner");
    db.insertLink("entity/b", "entity/c", "提及", 0.5, "ner");
    db.insertLink("entity/c", "entity/d", "提及", 0.5, "ner");
    db.insertLink("entity/d", "entity/e", "提及", 0.5, "ner");

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
});
