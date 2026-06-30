import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { DiscoveryManager } from "../../src/core/discovery.js";

describe("CLI similar-entities (dry-run default) (#246)", () => {
  const testDir = "/tmp/cbrain-test-cli-similar";
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

  function seedPage(slug: string, title: string, type = "entity/company"): void {
    db.upsertPage({ slug, type, title, filePath: `${slug}.md`, contentHash: slug });
  }

  test("dry-run detection writes nothing to discoveries", async () => {
    // "实体 A 公司" and "实体A公司" normalize to the same string → name_normalized match
    seedPage("entity/a", "实体 A 公司");
    seedPage("entity/b", "实体A公司");
    const mgr = new DiscoveryManager(db);
    const report = await mgr.runSimilarEntityDetection({ dryRun: true });
    expect(report.total).toBe(1);
    expect(report.candidates?.length ?? 0).toBe(1);
    expect(db.getDiscoveriesByType("similar_entity", 10)).toHaveLength(0); // dry-run → nothing persisted
  });

  test("execute persists", async () => {
    seedPage("entity/a", "实体 A 公司");
    seedPage("entity/b", "实体A公司");
    const mgr = new DiscoveryManager(db);
    await mgr.runSimilarEntityDetection(); // execute path (default)
    expect(db.getDiscoveriesByType("similar_entity", 10)).toHaveLength(1);
  });
});
