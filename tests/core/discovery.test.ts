import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";

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

  function seedPage(slug: string, type: string, title: string, mentionCount = 0): void {
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

  // ─── mention_snapshots ────────────────────────────────────────

  test("upsertMentionSnapshot inserts and queries correctly", () => {
    seedPage("entity/test", "entity/person", "Test");

    db.upsertMentionSnapshot("entity/test", "2026-05-20", 5);
    db.upsertMentionSnapshot("entity/test", "2026-05-21", 8);

    const snapshots = db.getMentionSnapshots("entity/test", 7);
    expect(snapshots.length).toBe(2);
    expect(snapshots[0].mention_count).toBe(5);
    expect(snapshots[1].mention_count).toBe(8);
  });

  test("upsertMentionSnapshot is idempotent (same date overwrites)", () => {
    seedPage("entity/test", "entity/person", "Test");

    db.upsertMentionSnapshot("entity/test", "2026-05-20", 5);
    db.upsertMentionSnapshot("entity/test", "2026-05-20", 7);

    const snapshots = db.getMentionSnapshots("entity/test", 7);
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].mention_count).toBe(7);
  });

  test("cleanMentionSnapshots removes old entries", () => {
    seedPage("entity/test", "entity/person", "Test");

    db.upsertMentionSnapshot("entity/test", "2026-04-01", 3);
    db.upsertMentionSnapshot("entity/test", "2026-05-20", 5);

    const removed = db.cleanMentionSnapshots(30);
    expect(removed).toBe(1);

    const snapshots = db.getMentionSnapshots("entity/test", 7);
    expect(snapshots.length).toBe(1);
  });

  // ─── discoveries status/metadata ─────────────────────────────

  test("discoveries table has status column", () => {
    seedPage("entity/test", "entity/person", "Test");
    const id = db.addDiscovery("trend", ["entity/test"], 0.8, undefined, undefined, "low", false, { direction: "rising" });
    db.updateDiscoveryStatus(id, "resolved");

    const d = db.getDiscoveryById(id);
    expect(d).not.toBeNull();
    expect(d!.status).toBe("resolved");
  });

  test("discoveries table stores metadata", () => {
    seedPage("entity/test", "entity/person", "Test");
    const id = db.addDiscovery("trend", ["entity/test"], 0.8, undefined, undefined, "low", false, { direction: "rising", delta: 5 });

    const d = db.getDiscoveryById(id);
    expect(d).not.toBeNull();
    const meta = JSON.parse(d!.metadata);
    expect(meta.direction).toBe("rising");
    expect(meta.delta).toBe(5);
  });

  test("discoveries default status is pending", () => {
    seedPage("entity/test", "entity/person", "Test");
    const id = db.addDiscovery("trend", ["entity/test"], 0.8);

    const d = db.getDiscoveryById(id);
    expect(d).not.toBeNull();
    expect(d!.status).toBe("pending");
    expect(d!.metadata).toBeNull();
  });

  test("addDiscovery without metadata still works (backward compat)", () => {
    seedPage("entity/foo", "entity/person", "Foo");
    const id = db.addDiscovery("bridge", ["entity/foo"], 0.5, { note: "test" });
    const d = db.getDiscoveryById(id);
    expect(d).not.toBeNull();
    expect(d!.type).toBe("bridge");
    expect(d!.status).toBe("pending");
  });
});
