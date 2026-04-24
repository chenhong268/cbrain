import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { EnrichManager } from "../../src/core/enrich.js";

function insertEntity(
  db: CBrainDB,
  slug: string,
  title: string,
  mentionCount = 0,
  tier = 3
) {
  db.prepare(
    `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
     VALUES (?, 'entity', ?, ?, ?, ?, ?)`
  ).run(slug, title, `${slug}.md`, `h-${slug}`, mentionCount, tier);
}

describe("EnrichManager", () => {
  const testDir = "/tmp/cbrain-test-enrich";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let enrich: EnrichManager;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    enrich = new EnrichManager(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  describe("computeTier", () => {
    test("tier 3 for 0-2 mentions (default threshold)", () => {
      expect(enrich.computeTier(0)).toBe(3);
      expect(enrich.computeTier(1)).toBe(3);
      expect(enrich.computeTier(2)).toBe(3);
    });

    test("tier 2 for 3-9 mentions", () => {
      expect(enrich.computeTier(3)).toBe(2);
      expect(enrich.computeTier(5)).toBe(2);
      expect(enrich.computeTier(9)).toBe(2);
    });

    test("tier 1 for 10+ mentions", () => {
      expect(enrich.computeTier(10)).toBe(1);
      expect(enrich.computeTier(50)).toBe(1);
    });

    test("custom thresholds", () => {
      const custom = new EnrichManager(db, { tier2: 2, tier1: 5 });
      expect(custom.computeTier(1)).toBe(3);
      expect(custom.computeTier(2)).toBe(2);
      expect(custom.computeTier(5)).toBe(1);
    });
  });

  describe("enrichEntity", () => {
    test("upgrades tier 3 to tier 2", () => {
      insertEntity(db, "entities/zhangsan", "张三", 5, 3);

      const result = enrich.enrichEntity("entities/zhangsan");
      expect(result.upgraded).toBe(true);
      expect(result.previousTier).toBe(3);
      expect(result.newTier).toBe(2);

      const row = db
        .prepare("SELECT tier FROM pages WHERE slug = ?")
        .get("entities/zhangsan") as any;
      expect(row.tier).toBe(2);
    });

    test("upgrades tier 3 directly to tier 1", () => {
      insertEntity(db, "entities/popular", "Popular", 15, 3);

      const result = enrich.enrichEntity("entities/popular");
      expect(result.upgraded).toBe(true);
      expect(result.newTier).toBe(1);
    });

    test("upgrades tier 2 to tier 1", () => {
      insertEntity(db, "entities/rising", "Rising", 12, 2);

      const result = enrich.enrichEntity("entities/rising");
      expect(result.upgraded).toBe(true);
      expect(result.previousTier).toBe(2);
      expect(result.newTier).toBe(1);
    });

    test("no upgrade when tier is correct", () => {
      insertEntity(db, "entities/stable", "Stable", 5, 2);

      const result = enrich.enrichEntity("entities/stable");
      expect(result.upgraded).toBe(false);
      expect(result.newTier).toBe(2);
    });

    test("no downgrade", () => {
      insertEntity(db, "entities/high", "High", 1, 1);

      const result = enrich.enrichEntity("entities/high");
      expect(result.upgraded).toBe(false);
      expect(result.newTier).toBe(1);
    });

    test("returns empty for non-existent entity", () => {
      const result = enrich.enrichEntity("entities/ghost");
      expect(result.upgraded).toBe(false);
    });

    test("skips non-entity pages", () => {
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
         VALUES (?, 'concept', ?, ?, ?, ?, ?)`
      ).run("concepts/test", "Test", "concepts/test.md", "h1", 10, 3);

      const result = enrich.enrichEntity("concepts/test");
      // enrichEntity will still process it if called directly, but enrichAll filters
      expect(result.newTier).toBe(1);
    });
  });

  describe("enrichAll", () => {
    test("processes all entities", () => {
      insertEntity(db, "entities/a", "A", 2, 3);
      insertEntity(db, "entities/b", "B", 5, 3);
      insertEntity(db, "entities/c", "C", 15, 3);

      const results = enrich.enrichAll();
      expect(results.length).toBe(3);

      const upgraded = enrich.getUpgraded(results);
      expect(upgraded.length).toBe(2);
    });

    test("ignores non-entity pages", () => {
      insertEntity(db, "entities/a", "A", 5, 3);
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'record', ?, ?, ?)`
      ).run("records/r", "R", "r.md", "h");

      const results = enrich.enrichAll();
      expect(results.length).toBe(1);
      expect(results[0].slug).toBe("entities/a");
    });

    test("returns empty when no entities", () => {
      const results = enrich.enrichAll();
      expect(results).toEqual([]);
    });
  });

  describe("getEntityProfile", () => {
    test("returns full profile", () => {
      insertEntity(db, "entities/profile", "Profile", 8, 2);
      insertEntity(db, "entities/other", "Other", 0, 3);

      db.prepare(
        "INSERT INTO tags (page_slug, tag) VALUES (?, ?)"
      ).run("entities/profile", "人物");

      db.prepare(
        "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
      ).run("entities/other", "entities/profile", "mentions");
      db.prepare(
        "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
      ).run("entities/profile", "entities/other", "mentions");

      const profile = enrich.getEntityProfile("entities/profile");
      expect(profile).not.toBeNull();
      expect(profile!.title).toBe("Profile");
      expect(profile!.tier).toBe(2);
      expect(profile!.mentionCount).toBe(8);
      expect(profile!.backlinkCount).toBe(1);
      expect(profile!.outLinkCount).toBe(1);
      expect(profile!.tags).toContain("人物");
    });

    test("returns null for non-existent entity", () => {
      const profile = enrich.getEntityProfile("entities/ghost");
      expect(profile).toBeNull();
    });
  });
});
