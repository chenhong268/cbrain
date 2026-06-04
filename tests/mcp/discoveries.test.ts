import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

function createMockEmbedding(): EmbeddingProvider {
  return {
    dimensions: 128,
    embed: async (text: string) => ({
      embedding: new Array(128).fill(0).map((_, i) => (text.charCodeAt(i % text.length) ?? 0) / 65536),
      tokenCount: text.length,
    }),
    embedBatch: async (texts: string[]) =>
      texts.map((t) => ({
        embedding: new Array(128).fill(0).map((_, i) => (t.charCodeAt(i % t.length) ?? 0) / 65536),
        tokenCount: t.length,
      })),
  };
}

function createMockLanceDB() {
  return {
    connect: async () => {},
    addChunks: async () => {},
    search: async () => [],
    fullTextSearch: async () => [],
    deleteByPageSlug: async () => {},
    deleteRawChunksByPageSlug: async () => {},
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

function getTools(server: any) {
  return (server as any)._registeredTools as Record<string, any>;
}

const BANNED_WORDS = [
  "score", "hops", "shared_neighbors", "distance",
  "图距离", "跳", "桥接", "high", "promote_discovery", "insight",
  "_debug", "候选", "过滤",
];

function assertNoBannedWords(text: string) {
  for (const w of BANNED_WORDS) {
    expect(text.includes(w)).toBe(false);
  }
}

function seedPage(db: CBrainDB, slug: string, title: string, type: string, mentionCount = 0) {
  db.rawDb.prepare(
    "INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count, hotness_score, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, 0, datetime('now'), datetime('now'))"
  ).run(slug, type, title, `${slug}.md`, null, mentionCount);
}

function createMockLLM() {
  return {
    name: "mock",
    chat: async () => JSON.stringify({ suggestion: "mock suggestion" }),
  };
}

function seedDiscovery(
  db: CBrainDB,
  type: string,
  entities: string[],
  score: number,
  actionable: string,
  suggestion: string | null,
  metadata: Record<string, unknown> | null = null,
): number {
  const id = db.addDiscovery(type, entities, score, undefined, undefined, actionable, false, metadata ?? undefined);
  if (suggestion !== null) {
    db.updateDiscoverySuggestion(id, suggestion);
  }
  return id;
}

describe("MCP Discovery Tools", () => {
  const testDir = "/tmp/cbrain-test-discoveries";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let deps: CBrainDeps;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    deps = {
      db,
      embedding: createMockEmbedding(),
      lance: createMockLanceDB() as any,
      llm: createMockLLM() as any,
      vaultPath,
      runtimePath: join(dirname(dbPath), "runtime"),
    };
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  describe("read_discoveries", () => {
    test("default returns at most 3 cards", async () => {
      seedPage(db, "entities/person-a", "人物A", "entity/person");
      seedPage(db, "entities/person-b", "人物B", "entity/person");
      seedPage(db, "entities/org-c", "组织C", "entity/organization");
      seedPage(db, "concepts/topic-d", "主题D", "concept/concept");

      // Seed 5 gaps — all pass filter
      for (let i = 0; i < 5; i++) {
        seedDiscovery(db, "gap", [`entities/org-c`], 0.5 + i * 0.1, "medium", null, {
          mention_count: 10 + i,
          link_count: 0,
        });
      }

      const server = createServer(deps);
      const result = await getTools(server).read_discoveries.handler({});
      const payload = JSON.parse(result.content[0].text);

      expect(payload.cards.length).toBeLessThanOrEqual(3);
      expect(payload.cards.length).toBe(3);
    });

    test("default payload does not contain _debug", async () => {
      seedPage(db, "entities/org-c", "组织C", "entity/organization");
      seedDiscovery(db, "gap", ["entities/org-c"], 0.7, "medium", null, {
        mention_count: 10,
        link_count: 0,
      });

      const server = createServer(deps);
      const result = await getTools(server).read_discoveries.handler({});
      const payload = JSON.parse(result.content[0].text);

      expect(payload._debug).toBeUndefined();
    });

    test("debug=true returns _debug", async () => {
      seedPage(db, "entities/org-c", "组织C", "entity/organization");
      seedDiscovery(db, "gap", ["entities/org-c"], 0.7, "medium", null, {
        mention_count: 10,
        link_count: 0,
      });

      const server = createServer(deps);
      const result = await getTools(server).read_discoveries.handler({ debug: true });
      const payload = JSON.parse(result.content[0].text);

      expect(payload._debug).toBeDefined();
      expect(payload._debug.total_candidates).toBe(1);
      expect(payload._debug.filtered).toBe(0);
    });

    test("display, cards, and summary contain no banned words", async () => {
      seedPage(db, "entities/person-a", "人物A", "entity/person");
      seedPage(db, "entities/person-b", "人物B", "entity/person");
      seedPage(db, "entities/org-c", "组织C", "entity/organization");

      seedDiscovery(db, "gap", ["entities/org-c"], 0.7, "high", null, {
        mention_count: 25,
        link_count: 1,
      });
      seedDiscovery(db, "bridge", ["entities/person-a", "entities/person-b"], 0.8, "medium", "建议确认关联", {
        distance: 4,
      });
      seedDiscovery(db, "trend", ["entities/person-a"], 0.6, "medium", "注意趋势变化", {
        direction: "trend_rising",
        delta: 5,
        daily_counts: [1, 2, 3, 4, 5, 6, 7],
      });

      const server = createServer(deps);
      const result = await getTools(server).read_discoveries.handler({});
      const payload = JSON.parse(result.content[0].text);

      // Verify all 3 types are present
      const titles = payload.cards.map((c: any) => c.title as string);
      expect(titles.some((t: string) => t.includes("需要补全"))).toBe(true);
      expect(titles.some((t: string) => t.includes("潜在关联"))).toBe(true);
      expect(titles.some((t: string) => t.includes("关注度"))).toBe(true);

      assertNoBannedWords(payload.display);
      assertNoBannedWords(payload.summary.message);
      expect(payload.raw).toBeDefined();
      for (const card of payload.cards) {
        assertNoBannedWords(Object.values(card).join(" "));
      }

      // Per-type field assertions
      const bridgeCard = payload.cards.find((c: any) => c.title.includes("潜在关联"));
      expect(bridgeCard.evidence).not.toContain("图距离");
      expect(bridgeCard.evidence).not.toContain("跳");
      expect(bridgeCard.evidence).not.toContain("distance");

      const trendCard = payload.cards.find((c: any) => c.title.includes("关注度"));
      const trendText = Object.values(trendCard).join(" ");
      expect(trendText).toContain("提及次数");
      assertNoBannedWords(trendText);
    });

    test("custom limit overrides default 3", async () => {
      seedPage(db, "entities/org-c", "组织C", "entity/organization");

      for (let i = 0; i < 8; i++) {
        seedDiscovery(db, "gap", ["entities/org-c"], 0.5 + i * 0.05, "medium", null, {
          mention_count: 10 + i,
          link_count: 0,
        });
      }

      const server = createServer(deps);
      const result = await getTools(server).read_discoveries.handler({ limit: 5 });
      const payload = JSON.parse(result.content[0].text);

      expect(payload.cards.length).toBeLessThanOrEqual(5);
      expect(payload.cards.length).toBe(5);
    });

    test("empty results return placeholder message", async () => {
      const server = createServer(deps);
      const result = await getTools(server).read_discoveries.handler({});
      const payload = JSON.parse(result.content[0].text);

      expect(payload.cards.length).toBe(0);
      expect(payload.display).toBe("暂无新的发现。");
      expect(payload.result_summary).toContain("暂无");
      expect(payload.raw).toBeDefined();
    });
  });

  describe("update_discovery_status", () => {
    test("marks discovery as seen", async () => {
      seedPage(db, "entities/org-c", "组织C", "entity/organization");
      const id = seedDiscovery(db, "gap", ["entities/org-c"], 0.7, "medium", null, {
        mention_count: 10,
        link_count: 0,
      });

      const server = createServer(deps);
      const result = await getTools(server).update_discovery_status.handler({
        ids: [id],
        status: "seen",
      });
      const payload = JSON.parse(result.content[0].text);

      expect(payload.updated).toBe(1);
      expect(payload.status).toBe("seen");
    });
  });

  describe("run_discovery", () => {
    test("default summary does not contain system-log terms", async () => {
      seedPage(db, "entities/org-c", "组织C", "entity/organization", 25);

      const server = createServer(deps);
      const result = await getTools(server).run_discovery.handler({
        types: ["gap"],
      });
      const payload = JSON.parse(result.content[0].text);

      const bannedSummaryWords = ["检测完成", "新增", "结构异常"];
      for (const w of bannedSummaryWords) {
        expect(payload.result_summary?.includes(w) ?? payload.summary.message.includes(w)).toBe(false);
      }
    });

    test("default output contains no banned terms", async () => {
      // Seed entity pages with high mention_count + no links → detectGaps will find them
      seedPage(db, "entities/person-a", "人物A", "entity/person", 20);
      seedPage(db, "entities/person-b", "人物B", "entity/person", 15);
      seedPage(db, "entities/org-c", "组织C", "entity/organization", 30);

      const server = createServer(deps);
      const result = await getTools(server).run_discovery.handler({
        types: ["gap"],
      });
      const payload = JSON.parse(result.content[0].text);

      expect(payload.cards).toBeDefined();
      expect(payload.summary).toBeDefined();
      expect(payload.display).toBeDefined();

      for (const w of BANNED_WORDS) {
        expect(payload.summary.message.includes(w)).toBe(false);
        expect(payload.result_summary?.includes(w) ?? false).toBe(false);
        expect(payload.display.includes(w)).toBe(false);
      }
      for (const card of payload.cards) {
        assertNoBannedWords(Object.values(card).join(" "));
      }

      expect(payload._debug).toBeUndefined();
      expect(payload.report).toBeUndefined();
    });

    test("debug=true returns raw report", async () => {
      seedPage(db, "entities/org-c", "组织C", "entity/organization", 25);

      const server = createServer(deps);
      const result = await getTools(server).run_discovery.handler({
        types: ["gap"],
        debug: true,
      });
      const payload = JSON.parse(result.content[0].text);

      expect(payload._debug).toBeDefined();
      expect(payload._debug.report).toBeDefined();
      expect(payload._debug.report.total).toBeDefined();
      expect(payload._debug.report.byType).toBeDefined();
      expect(payload._debug.skipped).toBeDefined();
    });

    test("returns at most 3 cards by default", async () => {
      // Seed 5 entities with high mentions → 5 gaps detected
      const types: Array<[string, string, string]> = [
        ["entities/person-a", "人物A", "entity/person"],
        ["entities/person-b", "人物B", "entity/person"],
        ["entities/org-c", "组织C", "entity/organization"],
        ["entities/org-d", "组织D", "entity/organization"],
        ["entities/org-e", "组织E", "entity/organization"],
      ];
      for (const [slug, title, type] of types) {
        seedPage(db, slug, title, type, 20);
      }

      const server = createServer(deps);
      const result = await getTools(server).run_discovery.handler({
        types: ["gap"],
      });
      const payload = JSON.parse(result.content[0].text);

      expect(payload.cards.length).toBeLessThanOrEqual(3);
    });
  });
});
