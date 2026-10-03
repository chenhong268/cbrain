import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { InsightManager } from "../../src/core/maintenance/insight.js";
import type { LanceDBManager } from "../../src/storage/lancedb.js";
import { registerInsightTools } from "../../src/mcp/tools/insights.js";
import { ReflectManager } from "../../src/core/maintenance/reflect.js";

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

  test("pagination consumes current rows and reads do not archive stored history", () => {
    const first = db.listInsights({ limit: 1, offset: 0 });
    const second = db.listInsights({ limit: 1, offset: 1 });
    expect([...first, ...second].map(row => row.id).sort()).toEqual(ids.slice(2));
    expect(db.listInsights({ limit: 1, offset: 2 })).toEqual([]);
    expect(db.getInsightsBySourceEntities(["entity-a"], 1)).toHaveLength(1);
    expect(db.getInsightsBySourceEntities(["entity-b"], 1)).toEqual([]);
    expect(db.getInsight(ids[0])?.status).toBe("active");
    expect(db.countInsights()).toBe(4);
  });

  test("timezone offsets and fractions share the current and archive boundary", async () => {
    const past = db.createInsight({ content: "主题D", type: "pattern", sourceType: "manual",
      expiresAt: "2000-01-01T00:00:00.500+08:00", sourceEntities: ["entity-a"] });
    const future = db.createInsight({ content: "主题D", type: "pattern", sourceType: "manual",
      expiresAt: "2099-01-01T00:00:00.500-05:00", sourceEntities: ["entity-a"] });
    ids.unshift(past);
    ids.push(future);
    expect(db.getInsight(past, true)).toBeNull();
    expect(db.getInsight(future, true)?.id).toBe(future);
    expect(db.listInsights({ sourceType: "manual" }).map(row => row.id)).toEqual([future]);
    expect((await manager.queryInsights("主题D", 10)).map(row => row.id)).not.toContain(past);
    expect(db.getInsightsBySourceEntities(["entity-a"]).map(row => row.id)).toContain(future);
    expect(manager.archiveExpired()).toBe(3);
    expect(db.getInsight(past)?.status).toBe("archived");
    expect(db.getInsight(future)?.status).toBe("active");
  });

  test("dismissed, archived and malformed expiry are excluded from current reads", async () => {
    db.updateInsightStatus(ids[2]!, "dismissed");
    db.updateInsightStatus(ids[3]!, "archived");
    const malformed = db.createInsight({ content: "主题D", type: "pattern", sourceType: "reflect",
      expiresAt: "not-a-timestamp", sourceEntities: ["entity-a"] });
    ids.push(malformed);
    expect(db.listInsights()).toEqual([]);
    expect(db.getInsightsBySourceEntities(["entity-a"])).toEqual([]);
    expect(manager.countActive()).toBe(0);
    expect(await manager.queryInsights("主题D")).toEqual([]);
    expect(db.listInsights({ status: "dismissed" }).map(row => row.id)).toEqual([ids[2]!]);
    expect(db.listInsights({ status: "archived" }).map(row => row.id)).toEqual([ids[3]!]);
    expect(db.getInsight(malformed)?.expires_at).toBe("not-a-timestamp");
  });

  test("registered insight tools return current lists and preserve explicit expired detail", async () => {
    const handlers = new Map<string, (args: any) => Promise<any>>();
    registerInsightTools({
      registerTool(name: string, _definition: unknown, handler: (args: any) => Promise<any>) {
        handlers.set(name, handler);
      },
    } as never, { db, insights: manager } as never);
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse((await handlers.get(name)!(args)).content[0].text);
    for (const [name, args] of [
      ["insight", { action: "list" }], ["list_insights", {}],
      ["insight", { action: "query", query: "主题D", limit: 2 }],
      ["query_insights", { query: "主题D", limit: 2 }],
    ] as const) {
      const result = await call(name, args);
      expect(result.insights.map((row: { id: number }) => row.id).sort()).toEqual(ids.slice(2));
    }
    const historical = await call("insight", { action: "get", id: ids[0] });
    expect(historical.id).toBe(ids[0]);
    expect(historical.expires_at).toBe(db.getInsight(ids[0])?.expires_at);
    expect(db.getInsight(ids[0])?.status).toBe("active");
  });

  test.each([
    ["expired", "2000-01-01T00:00:00Z", 1],
    ["current", "2099-01-01T00:00:00Z", 0],
  ] as const)("reflect deduplication uses %s insight validity", async (_label, expiresAt, generated) => {
    db.upsertPage({ slug: "entity-b", title: "实体B", type: "entity/person",
      filePath: "entities/entity-b.md", contentHash: "b" });
    const previous = db.createInsight({ content: "主题D的旧判断", type: "pattern", sourceType: "reflect",
      sourceEntities: ["entity-b"], expiresAt });
    const countBefore = db.countInsights();
    const insightManager = new InsightManager(db, {
      dimensions: 1, embed: async () => ({ embedding: [0], tokenCount: 0 }), embedBatch: async () => [],
    }, { addInsightVector: async () => undefined } as unknown as LanceDBManager);
    const reflect = new ReflectManager(db, {} as never, {
      name: "mock", chat: async () => JSON.stringify({
        summary: "实体B的已知关联", key_facts: [], confidence: 0.8,
        insights: [{ content: "主题D的新判断", related_entities: ["entity-b"], type: "pattern", confidence: 0.8 }],
      }),
    }, undefined, undefined, insightManager);
    const report = await reflect.reflectIncremental();
    expect(report.insightsGenerated).toBe(generated);
    expect(db.countInsights()).toBe(countBefore + generated);
    expect(db.getInsightsBySourceEntities(["entity-b"])).toHaveLength(1);
    expect(db.getInsight(previous)?.status).toBe("active");
  });
});
