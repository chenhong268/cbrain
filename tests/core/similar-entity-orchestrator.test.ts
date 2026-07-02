import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { DiscoveryManager } from "../../src/core/maintenance/discovery.js";

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
    seedPage("entity/a", "公司Alpha", "entity/company", 3);
    seedPage("entity/b", "公司alpha", "entity/company", 1);

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
    seedPage("entity/a", "公司Beta");
    seedPage("entity/b", "公司beta");

    const mgr = new DiscoveryManager(db);
    await mgr.runSimilarEntityDetection();

    const second = await mgr.runSimilarEntityDetection();
    expect(second.total).toBe(0);
    expect(db.getDiscoveriesByType("similar_entity", 10)).toHaveLength(1);
  });

  test("dismissed candidate does NOT resurrect as pending", async () => {
    seedPage("entity/a", "公司Gamma");
    seedPage("entity/b", "公司gamma");

    const mgr = new DiscoveryManager(db);
    await mgr.runSimilarEntityDetection();

    const row = db.getDiscoveriesByType("similar_entity", 10)[0];
    db.updateDiscoveryStatus(row.id, "dismissed");

    await mgr.runSimilarEntityDetection();
    expect(db.getDiscoveriesByType("similar_entity", 10)).toHaveLength(0);
  });

  test("HIGH2: own-title alias does not turn a normalized duplicate into alias_shadow", async () => {
    // Two pages whose titles normalize-equal but raw-differ (space). B's aliases table
    // happens to contain B's own title. Must classify name_normalized, NOT alias_shadow_page.
    seedPage("entity/a", "实体 A 公司");
    seedPage("entity/b", "实体A公司");
    db.rawDb.prepare("INSERT OR IGNORE INTO aliases (page_slug, alias) VALUES (?, ?)").run("entity/b", "实体A公司");
    const mgr = new DiscoveryManager(db);
    const _report = await mgr.runSimilarEntityDetection();
    const rows = db.getDiscoveriesByType("similar_entity", 10);
    expect(rows).toHaveLength(1);
    const meta = JSON.parse(rows[0].metadata ?? "{}");
    expect(meta.match_kind).toBe("name_normalized");
  });

  test("HIGH1: scope=entity persists only entity pairs, not concept pairs", async () => {
    // Entity pair: raw titles differ (space) but normalize-equal → would be detected
    seedPage("entity/a", "实体 A 公司", "entity/company");
    seedPage("entity/b", "实体A公司", "entity/company");
    // Concept pair: similarly normalize-equal → would ALSO be detected without scope
    seedPage("concept/x", "主题 D 概念", "concept/concept");
    seedPage("concept/y", "主题D概念", "concept/concept");
    // Without scope: 2 candidates. With scope=entity: 1 candidate.
    const mgr = new DiscoveryManager(db);
    await mgr.runSimilarEntityDetection({ scope: "entity" });
    const rows = db.getDiscoveriesByType("similar_entity", 10);
    expect(rows).toHaveLength(1);
    const entities = JSON.parse(rows[0].entities);
    expect(entities.every((s: string) => s.startsWith("entity/"))).toBe(true);
  });
});
