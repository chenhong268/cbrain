import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { DiscoveryManager } from "../../src/core/discovery.js";

describe("DiscoveryManager.runSimilarEntityDetection (#246)", () => {
  const testDir = "/tmp/cbrain-test-similar-orch";
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

  /**
   * Seed a page and optionally bump mention_count via incrementMentionCount.
   * upsertPage does not accept mentionCount; use incrementMentionCount after upsert.
   * Title uniqueness constraint requires distinct raw titles per test.
   */
  function seedPage(slug: string, title: string, type = "entity/company", mentionCount = 0): void {
    db.upsertPage({ slug, type, title, filePath: `${slug}.md`, contentHash: slug });
    for (let i = 0; i < mentionCount; i++) {
      db.incrementMentionCount(slug);
    }
  }

  test("seeds two case-insensitive duplicate titles → persists one similar_entity discovery", async () => {
    // name_exact is case-insensitive in the detector; raw titles differ to avoid
    // the pages.title UNIQUE constraint (idx_pages_title_uniq).
    seedPage("entity/a", "AlphaCorp", "entity/company", 3);
    seedPage("entity/b", "alphacorp", "entity/company", 1);

    const mgr = new DiscoveryManager(db);
    const report = await mgr.runSimilarEntityDetection();

    expect(report.total).toBe(1);
    expect(report.byType.similar_entity).toBe(1);

    const rows = db.getDiscoveriesByType("similar_entity", 10);
    expect(rows).toHaveLength(1);

    const meta = JSON.parse(rows[0].metadata ?? "{}");
    expect(meta.match_kind).toBe("name_exact");
    // entity/a has higher mention_count (3 vs 1) → canonical target
    expect(meta.recommended_target).toBe("entity/a");
  });

  test("re-running does not duplicate visible rows (recurrence)", async () => {
    seedPage("entity/a", "BetaCorp");
    seedPage("entity/b", "betacorp");

    const mgr = new DiscoveryManager(db);
    await mgr.runSimilarEntityDetection();

    const second = await mgr.runSimilarEntityDetection();
    expect(second.total).toBe(0);
    expect(db.getDiscoveriesByType("similar_entity", 10)).toHaveLength(1);
  });

  test("dismissed candidate does NOT resurrect as pending", async () => {
    seedPage("entity/a", "GammaCorp");
    seedPage("entity/b", "gammacorp");

    const mgr = new DiscoveryManager(db);
    await mgr.runSimilarEntityDetection();

    const row = db.getDiscoveriesByType("similar_entity", 10)[0];
    db.updateDiscoveryStatus(row.id, "dismissed");

    await mgr.runSimilarEntityDetection();
    expect(db.getDiscoveriesByType("similar_entity", 10)).toHaveLength(0);
  });
});
