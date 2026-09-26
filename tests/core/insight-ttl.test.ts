import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { InsightManager } from "../../src/core/maintenance/insight.js";
import type { LanceDBManager } from "../../src/storage/lancedb.js";

describe("insight TTL read boundary", () => {
  let db: CBrainDB;
  let manager: InsightManager;
  let ids: number[];
  beforeEach(() => {
    db = new CBrainDB(":memory:");
    const now = Date.now();
    ids = [new Date(now - 60_000).toISOString(), "2000-01-01 00:00:00",
      new Date(now + 86_400_000).toISOString(), null].map(expiresAt => db.createInsight({
        content: "主题D的关联判断", type: "pattern", sourceType: "reflect",
        sourceEntities: ["entity-a"], expiresAt,
      }));
    manager = new InsightManager(db, {
      dimensions: 1, embed: async () => ({ embedding: [0], tokenCount: 0 }), embedBatch: async () => [],
    }, { searchInsights: async () => ids.map(id => ({ id })) } as unknown as LanceDBManager);
  });
  afterEach(() => db.close());

  test("active lists and entity context exclude expired rows before limiting", () => {
    expect(db.listInsights().map(r => r.id).sort()).toEqual(ids.slice(2));
    expect(db.listInsights({ status: "active", sourceType: "reflect", limit: 1 })).toHaveLength(1);
    expect(db.getInsightsBySourceEntities(["entity-a"]).map(r => r.id).sort()).toEqual(ids.slice(2));
    expect(manager.countActive()).toBe(2);
    expect(db.countInsights()).toBe(4);
    expect(db.getInsight(ids[0])?.status).toBe("active");
  });

  test("vector recall excludes expired rows without waiting for dream", async () => {
    expect((await manager.queryInsights("主题D", 2)).map(r => r.id)).toEqual(ids.slice(2));
  });

  test("archive uses timestamps and retains explicit historical access", () => {
    expect(manager.archiveExpired()).toBe(2);
    expect(db.listInsights({ status: "archived" }).map(r => r.id).sort()).toEqual(ids.slice(0, 2));
    expect(manager.archiveExpired()).toBe(0);
  });
});
