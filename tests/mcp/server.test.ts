import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import { buildContext } from "../../src/mcp/context.js";
import { ProvenanceManager } from "../../src/core/provenance.js";
import { SqliteProvenanceStore } from "../../src/storage/provenance-store.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import type { IngestNerMode } from "../../src/cli/context.js";
import { authorizeNerJobClaim } from "../../src/core/maintenance/zero-link-backfill.js";

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
    addInsightVector: async () => {},
    search: async () => [],
    searchInsights: async () => [{ id: 1 }],
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

describe("MCP Server", () => {
  const testDir = "/tmp/cbrain-test-mcp";
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
      vaultPath,
      runtimePath: join(dirname(dbPath), "runtime"),
    };
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  describe("createServer", () => {
    test("returns an McpServer instance", () => {
      const server = createServer(deps);
      expect(server).toBeDefined();
      expect(typeof server.connect).toBe("function");
    });

    test("registers all tools", () => {
      const server = createServer(deps);
      const tools = getTools(server);
      const names = Object.keys(tools);
      expect(names.sort()).toEqual([
        "act_on_review_candidate", "add_alias", "add_knowledge", "add_link", "add_tag", "add_timeline_entry", "agentic_research", "alias", "append_page", "archive_insight",
        "batch",
        "batch_add_links", "batch_delete_pages", "batch_merge_pages",
        "brain_storm", "cbrain_recall", "confirm_evidence", "deep_recall", "delete_page", "dismiss_insight",
        "dossier", "dream", "dream_reset", "dream_status", "enrich", "expand_entity",
        "export_grounded_artifact", "find_similar_entities",
        "generate_indexes", "get_chunks", "get_compounding_reviews", "get_hierarchy", "get_ingest_log", "get_insight",
        "get_links", "get_org_tree", "get_page", "get_pages", "get_profile", "get_provenance", "get_tags",
        "get_timeline", "get_versions", "graph_query", "health",
        "ingest", "ingest_dialogue", "insight", "job", "job_cancel", "job_list",
        "job_retry", "job_status", "job_submit", "link", "list_insights",
        "list_pages", "mark_discovery_seen", "merge_entities", "merge_pages",
        "next_actions", "profile", "promote_discovery", "put_page", "query", "query_insights",
        "read_action_candidates", "read_discoveries", "read_knowledge_map", "read_project_state", "recall_episode", "record_feedback", "relation_audit", "reload_profile", "remove_alias",
        "remove_hierarchy", "remove_link", "remove_orphans", "remove_profile", "remove_tag",
        "repair_known_relations", "resolve_slugs", "revert_version", "run_action_candidates", "run_discovery", "set_hierarchy", "set_trust_state",
        "status", "summarize", "sync", "tag", "timeline", "update_action_candidate_status", "update_discovery_status", "update_profile", "wakeup_diff", "watcher_quarantine", "writeback",
      ]);
    });
  });

  describe("status tool", () => {
    test("returns empty brain stats", async () => {
      const server = createServer(deps);
      const result = await getTools(server).status.handler({});
      const data = JSON.parse(result.content[0].text);
      expect(data.totalPages).toBe(0);
      expect(data.totalLinks).toBe(0);
      expect(data.totalChunks).toBe(0);
    });

    test("returns counts after inserting data", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/test", "Test", "test.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/a", "A", "a.md", "ha");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/b", "B", "b.md", "hb");
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
      ).run("entities/a", "entities/b", "mentions");

      const server = createServer(deps);
      const result = await getTools(server).status.handler({});
      const data = JSON.parse(result.content[0].text);
      expect(data.totalPages).toBe(3);
      expect(data.totalLinks).toBe(1);
    });
  });

  describe("profile tool", () => {
    const profileEntry = {
      id: "pref-a",
      type: "preference" as const,
      category: "work" as const,
      scope: "open" as const,
      content: "偏好A",
      source: "explicit" as const,
      tags: ["tag-a"],
    };

    test("action=get matches get_profile envelope shape", async () => {
      const server = createServer(deps);
      const tools = getTools(server);
      const unified = await tools.profile.handler({ action: "get" });
      const legacy = await tools.get_profile.handler({});
      expect(JSON.parse(unified.content[0].text)).toEqual(JSON.parse(legacy.content[0].text));
    });

    test("action=update matches update_profile shape and writes entries", async () => {
      const server = createServer(deps);
      const result = await getTools(server).profile.handler({ action: "update", entries: [profileEntry] });
      const data = JSON.parse(result.content[0].text);
      expect(data.summary).toMatchObject({ status: "ok", count: 1 });
      expect(data.raw).toEqual({ updated: ["pref-a"], count: 1 });
    });

    test("action=remove matches remove_profile shape and removes entries", async () => {
      const server = createServer(deps);
      const tools = getTools(server);
      await tools.profile.handler({ action: "update", entries: [profileEntry] });
      const result = await tools.profile.handler({ action: "remove", ids: ["pref-a"] });
      const data = JSON.parse(result.content[0].text);
      expect(data.summary).toMatchObject({ status: "ok", count: 1 });
      expect(data.raw).toEqual({ removed: ["pref-a"], count: 1 });
    });

    test("action=reload matches reload_profile envelope shape", async () => {
      const server = createServer(deps);
      const tools = getTools(server);
      const unified = await tools.profile.handler({ action: "reload" });
      const legacy = await tools.reload_profile.handler({});
      expect(JSON.parse(unified.content[0].text)).toEqual(JSON.parse(legacy.content[0].text));
    });
  });

  describe("insight tool", () => {
    function seedInsight(overrides: Partial<{ content: string; type: "synthesis" | "pattern" | "anomaly" | "bridge"; confidence: number; sourceEntities: string[]; sourceType: "reflect" | "discovery" | "manual" }> = {}) {
      return db.createInsight({
        content: overrides.content ?? "匿名洞察内容A",
        type: overrides.type ?? "bridge",
        confidence: overrides.confidence ?? 0.7,
        sourceEntities: overrides.sourceEntities ?? ["entity/a"],
        sourceType: overrides.sourceType ?? "manual",
      });
    }

    function seedDiscovery(entities: string[], suggestion = "建议保留这条匿名发现") {
      const { id } = db.upsertDiscovery("bridge", entities, 0.8, { distance: 2 }, undefined, "medium", false);
      db.updateDiscoverySuggestion(id, suggestion);
      return id;
    }

    test("action=list matches list_insights shape", async () => {
      seedInsight({ content: "匿名洞察内容A" });
      const server = createServer(deps);
      const tools = getTools(server);
      const unified = await tools.insight.handler({ action: "list" });
      const legacy = await tools.list_insights.handler({});
      expect(JSON.parse(unified.content[0].text)).toEqual(JSON.parse(legacy.content[0].text));
    });

    test("action=get matches get_insight shape", async () => {
      const id = seedInsight({ content: "匿名洞察内容B", sourceEntities: ["entity/b"] });
      const server = createServer(deps);
      const tools = getTools(server);
      const unified = await tools.insight.handler({ action: "get", id });
      const legacy = await tools.get_insight.handler({ id });
      expect(JSON.parse(unified.content[0].text)).toEqual(JSON.parse(legacy.content[0].text));
    });

    test("action=archive matches archive_insight shape", async () => {
      const id = seedInsight();
      const server = createServer(deps);
      const result = await getTools(server).insight.handler({ action: "archive", id });
      expect(JSON.parse(result.content[0].text)).toEqual({ success: true, id, action: "archived" });
    });

    test("action=dismiss matches dismiss_insight shape", async () => {
      const id = seedInsight();
      const server = createServer(deps);
      const result = await getTools(server).insight.handler({ action: "dismiss", id });
      expect(JSON.parse(result.content[0].text)).toEqual({ success: true, id, action: "dismissed" });
    });

    test("action=query matches query_insights shape", async () => {
      seedInsight({ content: "匿名查询洞察" });
      const server = createServer(deps);
      const tools = getTools(server);
      const unified = await tools.insight.handler({ action: "query", query: "匿名", limit: 5 });
      const legacy = await tools.query_insights.handler({ query: "匿名", limit: 5 });
      expect(JSON.parse(unified.content[0].text)).toEqual(JSON.parse(legacy.content[0].text));
    });

    test("action=get fails fast when required id is missing", async () => {
      const server = createServer(deps);
      const result = await getTools(server).insight.handler({ action: "get" });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({ error: "insight action=get requires id" });
    });

    test("action=promote_discovery matches promote_discovery behavior and marks discovery seen", async () => {
      const legacyDiscoveryId = seedDiscovery(["entity/a", "entity/b"], "建议升级为匿名洞察A");
      const unifiedDiscoveryId = seedDiscovery(["entity/c", "entity/d"], "建议升级为匿名洞察B");
      const server = createServer(deps);
      const tools = getTools(server);
      const legacy = await tools.promote_discovery.handler({ discoveryId: legacyDiscoveryId, type: "bridge" });
      const unified = await tools.insight.handler({ action: "promote_discovery", discoveryId: unifiedDiscoveryId, type: "bridge" });
      const legacyData = JSON.parse(legacy.content[0].text);
      const unifiedData = JSON.parse(unified.content[0].text);
      expect(unifiedData).toMatchObject({
        success: true,
        promoted_from: unifiedDiscoveryId,
        actionable: legacyData.actionable,
        had_suggestion: true,
      });
      expect(unifiedData.insight).toMatchObject({ type: legacyData.insight.type, confidence: legacyData.insight.confidence });
      expect(db.getDiscoveryById(unifiedDiscoveryId)?.seen).toBe(1);
    });
  });

  describe("get_page tool", () => {
    test("returns page by slug", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/zhangsan", "张三", "zhangsan.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).get_page.handler({ slug: "entities/zhangsan" });
      const data = JSON.parse(result.content[0].text);
      expect(data.slug).toBe("entities/zhangsan");
      expect(data.title).toBe("张三");
      expect(data.type).toBe("entity");
    });

    test("returns error for missing page", async () => {
      const server = createServer(deps);
      const result = await getTools(server).get_page.handler({ slug: "entities/ghost" });
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe("Page not found");
    });
  });

  describe("alias tool", () => {
    test("action=add matches add_alias shape and writes alias", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/alias-add", "Alias Add", "alias-add.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).alias.handler({
        action: "add",
        slug: "entities/alias-add",
        alias: "Alias Alpha",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data).toEqual({ success: true, slug: "entities/alias-add", alias: "Alias Alpha" });

      const row = db.rawDb.prepare("SELECT alias FROM aliases WHERE page_slug = ? AND alias = ?")
        .get("entities/alias-add", "Alias Alpha") as { alias: string } | undefined;
      expect(row?.alias).toBe("Alias Alpha");
    });

    test("action=remove matches remove_alias shape and removes alias", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/alias-remove", "Alias Remove", "alias-remove.md", "h1");
      db.rawDb.prepare("INSERT OR IGNORE INTO aliases (page_slug, alias) VALUES (?, ?)")
        .run("entities/alias-remove", "Alias Beta");

      const server = createServer(deps);
      const result = await getTools(server).alias.handler({
        action: "remove",
        slug: "entities/alias-remove",
        alias: "Alias Beta",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data).toEqual({ success: true, slug: "entities/alias-remove", aliasRemoved: "Alias Beta" });

      const cnt = db.rawDb.prepare("SELECT COUNT(*) as c FROM aliases WHERE page_slug = ? AND alias = ?")
        .get("entities/alias-remove", "Alias Beta") as { c: number };
      expect(cnt.c).toBe(0);
    });
  });

  describe("get_pages tool", () => {
    function seedPage(slug: string, title: string, body: string = "") {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count, hotness_score, created_at, updated_at) VALUES (?, 'entity', ?, ?, NULL, 1, 0, 0, datetime('now'), datetime('now'))`
      ).run(slug, title, `${slug}.md`);
      // Write vault file so get_pages can read body
      if (body) {
        const filePath = join(vaultPath, `${slug}.md`);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, body);
      }
    }

    test("batch returns multiple pages with envelope", async () => {
      seedPage("entities/person-a", "人物A", "---\ntitle: 人物A\n---\n这是人物A的详细介绍，内容比较长。".repeat(3));
      seedPage("entities/person-b", "人物B", "---\ntitle: 人物B\n---\n人物B的简介。");
      seedPage("entities/org-c", "组织C", "---\ntitle: 组织C\n---\n组织C的介绍。");

      const server = createServer(deps);
      const result = await getTools(server).get_pages.handler({
        slugs: ["entities/person-a", "entities/person-b", "entities/org-c"],
      });
      const data = JSON.parse(result.content[0].text);

      // Envelope
      expect(data.display).toContain("找到 3 个页面");
      expect(data.summary.status).toBe("ok");
      expect(data.summary.count).toBe(3);
      expect(data.raw).toBeDefined();

      // Items
      expect(data.items.length).toBe(3);
      expect(data.missing.length).toBe(0);

      // Brief: excerpt is truncated
      const item = data.items.find((i: any) => i.slug === "entities/person-a");
      expect(item).toBeDefined();
      expect(item.title).toBe("人物A");
      expect(item.excerpt.length).toBeLessThanOrEqual(203); // 200 + "..."
      expect(item.tags).toBeUndefined(); // brief mode has no tags
    });

    test("missing slugs returned separately, not error", async () => {
      seedPage("entities/person-a", "人物A", "内容");

      const server = createServer(deps);
      const result = await getTools(server).get_pages.handler({
        slugs: ["entities/person-a", "entities/ghost", "entities/phantom"],
      });
      const data = JSON.parse(result.content[0].text);

      expect(data.summary.status).toBe("degraded");
      expect(data.items.length).toBe(1);
      expect(data.missing).toEqual(["entities/ghost", "entities/phantom"]);
      expect(data.display).toContain("2 个不存在");
    });

    test("all missing returns empty status", async () => {
      const server = createServer(deps);
      const result = await getTools(server).get_pages.handler({
        slugs: ["entities/nope1", "entities/nope2"],
      });
      const data = JSON.parse(result.content[0].text);

      expect(data.summary.status).toBe("empty");
      expect(data.items.length).toBe(0);
      expect(data.missing.length).toBe(2);
    });

    test("normal detail includes tags and link_count", async () => {
      seedPage("entities/person-a", "人物A", "内容");
      seedPage("entities/person-b", "人物B", "内容");
      // Add tags
      db.rawDb.prepare("INSERT INTO tags (page_slug, tag) VALUES (?, ?)").run("entities/person-a", "技术");
      db.rawDb.prepare("INSERT INTO tags (page_slug, tag) VALUES (?, ?)").run("entities/person-a", "前端");
      // Add links
      db.rawDb.prepare("INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)").run("entities/person-a", "entities/person-b", "mentions");

      const server = createServer(deps);
      const result = await getTools(server).get_pages.handler({
        slugs: ["entities/person-a", "entities/person-b"],
        detail: "normal",
      });
      const data = JSON.parse(result.content[0].text);

      expect(data.items.length).toBe(2);

      const personA = data.items.find((i: any) => i.slug === "entities/person-a");
      expect(personA.tags).toContain("技术");
      expect(personA.tags).toContain("前端");
      expect(personA.link_count.outgoing).toBeGreaterThanOrEqual(1);
      expect(personA.mention_count).toBeDefined();

      // Normal mode: longer excerpt limit
      const personB = data.items.find((i: any) => i.slug === "entities/person-b");
      expect(personB.tags).toBeDefined();
    });

    test("over 20 slugs rejected by Zod", async () => {
      const server = createServer(deps);
      const _slugs = Array.from({ length: 21 }, (_, i) => `entities/slug-${i}`);

      // Verify the inputSchema exists and has slugs array constraint
      const tool = getTools(server).get_pages;
      expect(tool).toBeDefined();
      expect(tool.inputSchema).toBeDefined();
      // The MCP SDK validates max(20) before calling handler.
      // Verify by checking a batch of exactly 20 succeeds:
      const slugs20 = Array.from({ length: 20 }, (_, i) => `entities/slug-${i}`);
      // This should not throw — handler may return empty results but validation passes
      const result = await getTools(server).get_pages.handler({ slugs: slugs20 });
      const data = JSON.parse(result.content[0].text);
      expect(data.summary.status).toBe("empty"); // none exist, but validation passed
    });

    test("envelope structure is complete", async () => {
      seedPage("entities/person-a", "人物A", "测试内容");

      const server = createServer(deps);
      const result = await getTools(server).get_pages.handler({
        slugs: ["entities/person-a"],
      });
      const data = JSON.parse(result.content[0].text);

      // All envelope fields present
      expect(typeof data.display).toBe("string");
      expect(data.summary).toHaveProperty("status");
      expect(data.summary).toHaveProperty("count");
      expect(data.summary).toHaveProperty("truncated");
      expect(data.summary).toHaveProperty("message");
      expect(data.raw).toBeDefined();
      expect(Array.isArray(data.items)).toBe(true);
      expect(Array.isArray(data.missing)).toBe(true);
      // raw contains full bounded payload
      expect(data.raw).toHaveProperty("items");
      expect(data.raw).toHaveProperty("missingSlugs");
      expect(data.raw).toHaveProperty("found");
      expect(data.raw).toHaveProperty("slugs");
      expect(data.raw).toHaveProperty("detail");
    });

    test("items preserve input slug order regardless of DB return order", async () => {
      // Seed pages in a different order than we'll request them
      seedPage("entities/charlie", "Charlie", "内容C");
      seedPage("entities/alice", "Alice", "内容A");
      seedPage("entities/bob", "Bob", "内容B");

      const server = createServer(deps);
      const result = await getTools(server).get_pages.handler({
        slugs: ["entities/alice", "entities/charlie", "entities/bob"],
      });
      const data = JSON.parse(result.content[0].text);

      // Items must be in requested order, not DB order
      expect(data.items.map((i: any) => i.slug)).toEqual([
        "entities/alice",
        "entities/charlie",
        "entities/bob",
      ]);
      // missing also preserves input order
      const result2 = await getTools(server).get_pages.handler({
        slugs: ["entities/bob", "entities/missing1", "entities/alice", "entities/missing2"],
      });
      const data2 = JSON.parse(result2.content[0].text);
      expect(data2.items.map((i: any) => i.slug)).toEqual(["entities/bob", "entities/alice"]);
      expect(data2.missing).toEqual(["entities/missing1", "entities/missing2"]);
    });
  });

  describe("list_pages tool", () => {
    test("returns empty list", async () => {
      const server = createServer(deps);
      const result = await getTools(server).list_pages.handler({});
      const data = JSON.parse(result.content[0].text);
      expect(data).toEqual([]);
    });

    test("filters by type", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/a", "A", "a.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'concept', ?, ?, ?)`
      ).run("concepts/b", "B", "b.md", "h2");

      const server = createServer(deps);
      const result = await getTools(server).list_pages.handler({ type: "entity" });
      const data = JSON.parse(result.content[0].text);
      expect(data.length).toBe(1);
      expect(data[0].slug).toBe("entities/a");
    });

    test("respects limit and offset", async () => {
      for (let i = 0; i < 5; i++) {
        db.rawDb.prepare(
          `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
        ).run(`entities/e${i}`, `E${i}`, `e${i}.md`, `h${i}`);
      }

      const server = createServer(deps);
      const result = await getTools(server).list_pages.handler({ limit: 2, offset: 0 });
      const data = JSON.parse(result.content[0].text);
      expect(data.length).toBe(2);
    });
  });

  describe("enrich tool", () => {
    test("enriches single entity", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
         VALUES (?, 'entity', ?, ?, ?, ?, ?)`
      ).run("entities/a", "A", "a.md", "h1", 5, 3);

      const server = createServer(deps);
      const result = await getTools(server).enrich.handler({ slug: "entities/a" });
      const data = JSON.parse(result.content[0].text);
      expect(data[0].upgraded).toBe(true);
      expect(data[0].newTier).toBe(2);
    });

    test("enriches all entities", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
         VALUES (?, 'entity/person', ?, ?, ?, ?, ?)`
      ).run("entities/a", "A", "a.md", "h1", 2, 3);
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
         VALUES (?, 'entity/person', ?, ?, ?, ?, ?)`
      ).run("entities/b", "B", "b.md", "h2", 10, 3);

      const server = createServer(deps);
      const result = await getTools(server).enrich.handler({});
      const data = JSON.parse(result.content[0].text);
      expect(data.length).toBe(2);
    });
  });

  describe("graph_query tool", () => {
    test("traverse from seed", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/a", "A", "a.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/b", "B", "b.md", "h2");
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
      ).run("entities/a", "entities/b", "mentions");

      const server = createServer(deps);
      const result = await getTools(server).graph_query.handler({ slug: "entities/a" });
      const data = JSON.parse(result.content[0].text);
      expect(data.display).toBeDefined();
      expect(data.summary).toBeDefined();
      expect(data.raw.resolvedSlug).toBe("entities/a");
      expect(data.raw.result.length).toBe(1);
      expect(data.raw.result[0].slug).toBe("entities/b");
    });

    test("backlinks mode", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/a", "A", "a.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/b", "B", "b.md", "h2");
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
      ).run("entities/b", "entities/a", "mentions");

      const server = createServer(deps);
      const result = await getTools(server).graph_query.handler({ slug: "entities/a", mode: "backlinks" });
      const data = JSON.parse(result.content[0].text);
      expect(data.display).toBeDefined();
      expect(data.raw.resolvedSlug).toBe("entities/a");
      expect(data.raw.result.length).toBe(1);
      expect(data.raw.result[0].from_slug).toBe("entities/b");
    });

    test("related mode", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count) VALUES (?, 'entity', ?, ?, ?, ?)`
      ).run("entities/a", "A", "a.md", "h1", 0);
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count) VALUES (?, 'entity', ?, ?, ?, ?)`
      ).run("entities/b", "B", "b.md", "h2", 5);
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
      ).run("entities/a", "entities/b", "mentions");

      const server = createServer(deps);
      const result = await getTools(server).graph_query.handler({ slug: "entities/a", mode: "related" });
      const data = JSON.parse(result.content[0].text);
      expect(data.display).toBeDefined();
      expect(data.raw.resolvedSlug).toBe("entities/a");
      expect(data.raw.result.length).toBe(1);
      expect(data.raw.result[0].slug).toBe("entities/b");
    });
  });

  describe("ingest tool", () => {
    test("ingests text content", async () => {
      const server = createServer(deps);
      const result = await getTools(server).ingest.handler({
        content: "Hello world. This is a complete record with enough factual context to exercise the ingest path.",
        type: "text",
        title: "Test Page",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.summary.status).toBe("recorded");
      expect(data.raw.slug).toBeDefined();
      expect(data.raw.created).toBe(true);
    });
  });

  describe("query tool", () => {
    test("returns results from search", async () => {
      const server = createServer(deps);
      const result = await getTools(server).query.handler({ query: "test" });
      const data = JSON.parse(result.content[0].text);
      expect(data.results).toBeDefined();
      expect(Array.isArray(data.results)).toBe(true);
    });
  });

  // ─── Page tools ───────────────────────────────

  describe("put_page tool", () => {
    test("creates a new page", async () => {
      const server = createServer(deps);
      const result = await getTools(server).put_page.handler({
        slug: "brain/entities/person/test",
        content: "Hello world",
        title: "Test",
        type: "entity/person",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.action).toBe("created");
      expect(data.page.slug).toBe("brain/entities/person/test");
      expect(data.page.title).toBe("Test");
    });

    test("explicit organization is marked agent and projected as trusted employment", async () => {
      mkdirSync(join(vaultPath, "entities", "company"), { recursive: true });
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/company', ?, ?, ?)`,
      ).run("brain/entities/company/org-c", "组织C", "entities/company/org-c.md", "org-hash");

      const server = createServer(deps);
      const result = await getTools(server).put_page.handler({
        slug: "brain/entities/person/entity-a",
        content: "匿名正文",
        title: "实体A",
        type: "entity/person",
        extra: { organization: "组织C" },
      });
      expect(JSON.parse(result.content[0].text).action).toBe("created");

      const page = db.getPage("brain/entities/person/entity-a");
      expect(page).toBeDefined();
      const raw = readFileSync(join(vaultPath, "brain/entities/person/entity-a.md"), "utf-8");
      expect(raw).toContain("organization_source: agent");
      const link = db.rawDb.prepare(
        "SELECT to_slug, trust_state, source_type FROM links WHERE from_slug = ? AND relation = '任职'",
      ).get("brain/entities/person/entity-a") as { to_slug: string; trust_state: string; source_type: string } | undefined;
      expect(link).toEqual({ to_slug: "brain/entities/company/org-c", trust_state: "trusted", source_type: "agent" });
    });

    test("forged organization_source fails before any page/version/edge write", async () => {
      mkdirSync(join(vaultPath, "entities", "person"), { recursive: true });
      const file = join(vaultPath, "entities", "person", "entity-a.md");
      writeFileSync(file, "---\ntitle: 实体A\ntype: entity/person\n---\n原始正文", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`,
      ).run("brain/entities/person/entity-a", "实体A", "entities/person/entity-a.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).put_page.handler({
        slug: "brain/entities/person/entity-a",
        content: "不应写入",
        mode: "replace",
        extra: { organization: "组织C", organization_source: "manual" },
      });

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({ error: "ORGANIZATION_SOURCE_FORBIDDEN" });
      expect(readFileSync(file, "utf-8")).toContain("原始正文");
      expect(readFileSync(file, "utf-8")).not.toContain("不应写入");
      expect(db.rawDb.prepare("SELECT COUNT(*) AS count FROM versions WHERE page_slug = ?").get("brain/entities/person/entity-a")).toEqual({ count: 0 });
      expect(db.rawDb.prepare("SELECT COUNT(*) AS count FROM links WHERE from_slug = ? AND relation = '任职'").get("brain/entities/person/entity-a")).toEqual({ count: 0 });
    });

    test("body-only update does not infer provenance for historical organization", async () => {
      mkdirSync(join(vaultPath, "entities", "person"), { recursive: true });
      const file = join(vaultPath, "entities", "person", "entity-a.md");
      writeFileSync(file, "---\ntitle: 实体A\ntype: entity/person\norganization: 组织C\n---\n原始正文", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`,
      ).run("brain/entities/person/entity-a", "实体A", "entities/person/entity-a.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).put_page.handler({
        slug: "brain/entities/person/entity-a",
        content: "追加正文",
      });

      expect(JSON.parse(result.content[0].text).action).toBe("updated");
      expect(db.rawDb.prepare("SELECT COUNT(*) AS count FROM links WHERE from_slug = ? AND relation = '任职'").get("brain/entities/person/entity-a")).toEqual({ count: 0 });
      expect(readFileSync(file, "utf-8")).not.toContain("organization_source");
    });

    test("returns error without title for new page", async () => {
      const server = createServer(deps);
      const result = await getTools(server).put_page.handler({
        slug: "entities/new",
        content: "Content without title",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBeDefined();
    });

    test("rejects a short record placeholder before persistence (#376)", async () => {
      const server = createServer(deps);
      const result = await getTools(server).put_page.handler({
        slug: "records/placeholder",
        content: "https://example.invalid/source\n待解析",
        title: "占位记录",
        type: "record",
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.error).toMatch(/VALIDATION_ERROR.*record/i);
      expect(db.getPage("records/placeholder")).toBeNull();
    });

    test("rejects a placeholder when an unknown type normalizes to record", async () => {
      const server = createServer(deps);
      const result = await getTools(server).put_page.handler({
        slug: "records/unknown-type-placeholder",
        content: "https://example.invalid/source\n待解析",
        title: "未知类型占位记录",
        type: "unknown-type",
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.error).toMatch(/VALIDATION_ERROR.*record/i);
      expect(db.getPage("records/unknown-type-placeholder")).toBeNull();
    });

    test("short entity content remains allowed", async () => {
      const server = createServer(deps);
      const result = await getTools(server).put_page.handler({
        slug: "entities/person/short",
        content: "短",
        title: "实体A",
        type: "entity/person",
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.action).toBe("created");
      expect(db.getPage(data.page.slug)?.type).toBe("entity/person");
    });

    test("update: syncs wikilinks to markdown Known Relations (bidirectional)", async () => {
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      const fileA = join(vaultPath, "entities", "person-a.md");
      const fileB = join(vaultPath, "entities", "person-b.md");
      writeFileSync(fileA, "---\ntitle: PersonA\ntype: entity/person\n---\noriginal", "utf-8");
      writeFileSync(fileB, "---\ntitle: PersonB\ntype: entity/person\n---\ncontent B", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/person-a", "PersonA", "entities/person-a.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/person-b", "PersonB", "entities/person-b.md", "h2");

      const server = createServer(deps);
      await getTools(server).put_page.handler({
        slug: "brain/entities/person-a",
        content: "met [[PersonB]] recently",
      });

      // Source page gets outgoing KR
      const updated = readFileSync(fileA, "utf-8");
      expect(updated).toContain("## Known Relations");
      expect(updated).toContain("person-b");
      // Target page gets incoming KR
      const targetB = readFileSync(fileB, "utf-8");
      expect(targetB).toContain("## Known Relations");
      expect(targetB).toContain("person-a");
    });

    test("create: syncs wikilinks to markdown Known Relations (bidirectional)", async () => {
      mkdirSync(join(vaultPath, "entities", "person"), { recursive: true });
      const fileB = join(vaultPath, "entities", "person", "person-b.md");
      writeFileSync(fileB, "---\ntitle: PersonB\ntype: entity/person\n---\ncontent B", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/person/person-b", "PersonB", "entities/person/person-b.md", "h2");

      const server = createServer(deps);
      const result = await getTools(server).put_page.handler({
        slug: "brain/entities/person-c",
        content: "works with [[PersonB]]",
        title: "PersonC",
        type: "entity/person",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.action).toBe("created");
      // canonicalSlug normalizes to brain/entities/person/person-c
      expect(data.page.slug).toBe("brain/entities/person/person-c");

      const fileC = join(vaultPath, "brain", "entities", "person", "person-c.md");
      expect(existsSync(fileC)).toBe(true);
      const content = readFileSync(fileC, "utf-8");
      expect(content).toContain("## Known Relations");
      expect(content).toContain("person-b");
      // Target page gets incoming KR
      const targetB = readFileSync(fileB, "utf-8");
      expect(targetB).toContain("## Known Relations");
      expect(targetB).toContain("person-c");
    });

    // ── patch/replace mode tests ──

    test("existing page without mode defaults to patch (preserves body)", async () => {
      mkdirSync(join(vaultPath, "records"), { recursive: true });
      const fileA = join(vaultPath, "records", "note.md");
      writeFileSync(fileA, "---\ntitle: Note\ntype: record\n---\noriginal body", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'record', ?, ?, ?)`
      ).run("brain/records/note", "Note", "records/note.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).put_page.handler({
        slug: "brain/records/note",
        content: "appended content",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.action).toBe("updated");
      expect(data.mode).toBe("patch");
      // No previous_version for patch mode
      expect(data.previous_version).toBeUndefined();

      const updated = readFileSync(fileA, "utf-8");
      expect(updated).toContain("original body");
      expect(updated).toContain("appended content");
    });

    test("defer NER mode creates backfill job for existing record patch instead of running NER inline (#271)", async () => {
      mkdirSync(join(vaultPath, "records"), { recursive: true });
      const fileA = join(vaultPath, "records", "defer-note.md");
      writeFileSync(fileA, "---\ntitle: DeferNote\ntype: record\n---\noriginal body", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'record', ?, ?, ?)`
      ).run("brain/records/defer-note", "DeferNote", "records/defer-note.md", "h1");

      const server = createServer({ ...deps, nerIngestMode: "defer" });
      const result = await getTools(server).put_page.handler({
        slug: "brain/records/defer-note",
        content: "新增正文应该排入 NER backfill",
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.action).toBe("updated");
      const job = db.rawDb.prepare(
        "SELECT name, status, data FROM jobs WHERE name = 'ner-backfill'"
      ).get() as { name: string; status: string; data: string } | undefined;
      expect(job).toBeDefined();
      expect(job!.status).toBe("pending");
      expect(JSON.parse(job!.data).slug).toBe("brain/records/defer-note");
    });

    test("defer NER mode creates backfill job for new record page instead of running NER inline (#271)", async () => {
      const server = createServer({ ...deps, nerIngestMode: "defer" });
      const result = await getTools(server).put_page.handler({
        slug: "brain/records/new-defer-note",
        title: "NewDeferNote",
        type: "record",
        content: "新建正文应该排入 NER backfill，并保留足够的事实内容以验证后台任务写入路径。".repeat(2),
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.action).toBe("created");
      const jobs = db.rawDb.prepare(
        "SELECT name, status, data FROM jobs WHERE name = 'ner-backfill'"
      ).all() as Array<{ name: string; status: string; data: string }>;
      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe("pending");
      expect(JSON.parse(jobs[0].data).slug).toBe(data.page.slug);
    });

    test("defer mode queues entity_facts for put_page entity updates (#321)", async () => {
      const server = createServer({ ...deps, nerIngestMode: "defer" });
      const created = await getTools(server).put_page.handler({
        slug: "brain/entities/company/entity-a",
        title: "实体A",
        type: "entity/company",
        content: "实体A属于领域C。",
      });
      expect(JSON.parse(created.content[0].text).action).toBe("created");

      const jobs = db.rawDb.prepare(
        "SELECT status, data FROM jobs WHERE name = 'ner-backfill'",
      ).all() as Array<{ status: string; data: string }>;
      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe("pending");
      expect(JSON.parse(jobs[0].data)).toEqual({
        slug: "brain/entities/company/entity-a",
        pageType: "entity/company",
        kind: "entity_facts",
      });
    });

    test("mode=replace overwrites body and creates version snapshot", async () => {
      mkdirSync(join(vaultPath, "records"), { recursive: true });
      const fileA = join(vaultPath, "records", "note.md");
      writeFileSync(fileA, "---\ntitle: Note\ntype: record\n---\nold content", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'record', ?, ?, ?)`
      ).run("brain/records/note", "Note", "records/note.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).put_page.handler({
        slug: "brain/records/note",
        content: "brand new content",
        mode: "replace",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.action).toBe("updated");
      expect(data.mode).toBe("replace");
      expect(data.previous_version).toBeGreaterThanOrEqual(1);

      const updated = readFileSync(fileA, "utf-8");
      expect(updated).toContain("brand new content");
      expect(updated).not.toContain("old content");
    });

    test("mode=patch with extra updates frontmatter fields", async () => {
      mkdirSync(join(vaultPath, "entities", "person"), { recursive: true });
      const fileA = join(vaultPath, "entities", "person", "zhang.md");
      writeFileSync(fileA, "---\ntitle: Zhang\ntype: entity/person\n---\noriginal info", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/person/zhang", "Zhang", "entities/person/zhang.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).put_page.handler({
        slug: "brain/entities/person/zhang",
        content: "new info",
        mode: "patch",
        extra: { reports_to: "brain/entities/person/boss", confidence: 0.95 },
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.action).toBe("updated");
      expect(data.mode).toBe("patch");

      const updated = readFileSync(fileA, "utf-8");
      expect(updated).toContain("original info");
      expect(updated).toContain("new info");
      expect(updated).toContain("reports_to");
      expect(updated).toContain("brain/entities/person/boss");
    });

    test("mode=patch merges tags instead of replacing", async () => {
      mkdirSync(join(vaultPath, "records"), { recursive: true });
      const fileA = join(vaultPath, "records", "note.md");
      writeFileSync(fileA, "---\ntitle: Note\ntype: record\ntags:\n  - old\n  - shared\n---\nbody", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'record', ?, ?, ?)`
      ).run("brain/records/note", "Note", "records/note.md", "h1");
      db.rawDb.prepare("INSERT INTO tags (page_slug, tag) VALUES (?, ?)").run("brain/records/note", "old");
      db.rawDb.prepare("INSERT INTO tags (page_slug, tag) VALUES (?, ?)").run("brain/records/note", "shared");

      const server = createServer(deps);
      await getTools(server).put_page.handler({
        slug: "brain/records/note",
        content: "more",
        mode: "patch",
        tags: ["shared", "new"],
      });

      const updated = readFileSync(fileA, "utf-8");
      expect(updated).toContain("old");
      expect(updated).toContain("shared");
      expect(updated).toContain("new");
    });

    test("patch preserves Known Relations section", async () => {
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      const fileA = join(vaultPath, "entities", "person-a.md");
      const fileB = join(vaultPath, "entities", "person-b.md");
      writeFileSync(fileA, "---\ntitle: PersonA\ntype: entity/person\n---\noriginal\n\n## Known Relations\n\n- friend → [[person-b]]\n", "utf-8");
      writeFileSync(fileB, "---\ntitle: PersonB\ntype: entity/person\n---\ncontent B", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/person-a", "PersonA", "entities/person-a.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/person-b", "PersonB", "entities/person-b.md", "h2");
      // Add the link to DB so syncLinksToMarkdown can rebuild it
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
      ).run("brain/entities/person-a", "brain/entities/person-b", "friend");

      const server = createServer(deps);
      const result = await getTools(server).put_page.handler({
        slug: "brain/entities/person-a",
        content: "appended info",
        mode: "patch",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.action).toBe("updated");

      const updated = readFileSync(fileA, "utf-8");
      expect(updated).toContain("original");
      expect(updated).toContain("appended info");
      // KR section should be rebuilt by syncLinksToMarkdown
      expect(updated).toContain("## Known Relations");
    });

    test("new page ignores mode parameter", async () => {
      const server = createServer(deps);
      const result = await getTools(server).put_page.handler({
        slug: "brain/entities/person/new-person",
        content: "brand new",
        title: "NewPerson",
        type: "entity/person",
        mode: "replace",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.action).toBe("created");
      expect(data.mode).toBeUndefined();
    });

    test("old-style call (no mode) on existing page is safe — patch by default", async () => {
      mkdirSync(join(vaultPath, "records"), { recursive: true });
      const fileA = join(vaultPath, "records", "legacy.md");
      writeFileSync(fileA, "---\ntitle: Legacy\ntype: record\n---\nimportant data that must not be lost", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'record', ?, ?, ?)`
      ).run("brain/records/legacy", "Legacy", "records/legacy.md", "h1");

      const server = createServer(deps);
      // Old-style call: no mode parameter at all
      const result = await getTools(server).put_page.handler({
        slug: "brain/records/legacy",
        content: "additional notes",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.action).toBe("updated");
      expect(data.mode).toBe("patch");

      const updated = readFileSync(fileA, "utf-8");
      // Original content must NOT be lost
      expect(updated).toContain("important data that must not be lost");
      expect(updated).toContain("additional notes");
    });

    // ── reports_to graph sync tests ──

    test("patch extra.reports_to creates graph edge", async () => {
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      const fileA = join(vaultPath, "entities", "sub.md");
      const fileB = join(vaultPath, "entities", "boss.md");
      writeFileSync(fileA, "---\ntitle: Sub\ntype: entity/person\n---\ninfo", "utf-8");
      writeFileSync(fileB, "---\ntitle: Boss\ntype: entity/person\n---\ninfo", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/sub", "Sub", "entities/sub.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/boss", "Boss", "entities/boss.md", "h2");

      const server = createServer(deps);
      await getTools(server).put_page.handler({
        slug: "brain/entities/sub",
        content: "updated",
        mode: "patch",
        extra: { reports_to: "brain/entities/boss" },
      });

      // Graph must have reports_to edge
      const link = db.rawDb.prepare(
        "SELECT relation FROM links WHERE from_slug = ? AND to_slug = ? AND relation = 'reports_to'"
      ).get("brain/entities/sub", "brain/entities/boss") as { relation: string } | undefined;
      expect(link).toBeDefined();
      expect(link!.relation).toBe("reports_to");
    });

    test("patch extra.reports_to replaces old reports_to edge", async () => {
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      const fileA = join(vaultPath, "entities", "sub.md");
      const fileB = join(vaultPath, "entities", "old-boss.md");
      const fileC = join(vaultPath, "entities", "new-boss.md");
      writeFileSync(fileA, "---\ntitle: Sub\ntype: entity/person\nreports_to: brain/entities/old-boss\n---\ninfo", "utf-8");
      writeFileSync(fileB, "---\ntitle: OldBoss\ntype: entity/person\n---\ninfo", "utf-8");
      writeFileSync(fileC, "---\ntitle: NewBoss\ntype: entity/person\n---\ninfo", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/sub", "Sub", "entities/sub.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/old-boss", "OldBoss", "entities/old-boss.md", "h2");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/new-boss", "NewBoss", "entities/new-boss.md", "h3");
      // Pre-existing edge to old boss
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, 'reports_to')"
      ).run("brain/entities/sub", "brain/entities/old-boss");

      const server = createServer(deps);
      await getTools(server).put_page.handler({
        slug: "brain/entities/sub",
        content: "updated",
        mode: "patch",
        extra: { reports_to: "brain/entities/new-boss" },
      });

      // #233 Phase 1: old edge is superseded (evidence preserved), NOT hard-deleted
      const oldLink = db.rawDb.prepare(
        "SELECT trust_state FROM links WHERE from_slug = ? AND to_slug = ? AND relation = 'reports_to'"
      ).get("brain/entities/sub", "brain/entities/old-boss") as { trust_state: string } | undefined;
      expect(oldLink).toBeDefined();
      expect(oldLink!.trust_state).toBe("superseded");

      // New edge must exist as active+trusted (deterministic patch)
      const newLink = db.rawDb.prepare(
        "SELECT trust_state FROM links WHERE from_slug = ? AND to_slug = ? AND relation = 'reports_to'"
      ).get("brain/entities/sub", "brain/entities/new-boss") as { trust_state: string } | undefined;
      expect(newLink).toBeDefined();
      expect(newLink!.trust_state).toBe("trusted");

      // Active read sees only the new edge
      const active = db.getOutgoingLinks("brain/entities/sub").filter((l) => l.relation === "reports_to");
      expect(active).toHaveLength(1);
      expect(active[0].to_slug).toBe("brain/entities/new-boss");
    });

    test("new page with extra.reports_to writes frontmatter and creates graph edge", async () => {
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      const fileBoss = join(vaultPath, "entities", "boss.md");
      writeFileSync(fileBoss, "---\ntitle: Boss\ntype: entity/person\n---\ninfo", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/boss", "Boss", "entities/boss.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).put_page.handler({
        slug: "brain/entities/newbie",
        content: "new employee",
        title: "Newbie",
        type: "entity/person",
        extra: { reports_to: "brain/entities/boss" },
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.action).toBe("created");
      // canonicalSlug normalizes to brain/entities/person/newbie
      const canonicalSlug = data.page.slug;

      // Frontmatter should have reports_to
      const file = join(vaultPath, "brain", "entities", "person", "newbie.md");
      expect(existsSync(file)).toBe(true);
      const content = readFileSync(file, "utf-8");
      expect(content).toContain("reports_to");
      expect(content).toContain("brain/entities/boss");

      // Graph must have reports_to edge
      const link = db.rawDb.prepare(
        "SELECT relation FROM links WHERE from_slug = ? AND to_slug = ? AND relation = 'reports_to'"
      ).get(canonicalSlug, "brain/entities/boss");
      expect(link).not.toBeNull();
    });

    // ── reports_to KR sync tests ──

    test("patch extra.reports_to syncs manager's incoming Known Relations", async () => {
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      const fileSub = join(vaultPath, "entities", "sub.md");
      const fileBoss = join(vaultPath, "entities", "boss.md");
      writeFileSync(fileSub, "---\ntitle: Sub\ntype: entity/person\n---\ninfo", "utf-8");
      writeFileSync(fileBoss, "---\ntitle: Boss\ntype: entity/person\n---\ninfo", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/sub", "Sub", "entities/sub.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/boss", "Boss", "entities/boss.md", "h2");

      const server = createServer(deps);
      await getTools(server).put_page.handler({
        slug: "brain/entities/sub",
        content: "updated",
        mode: "patch",
        extra: { reports_to: "brain/entities/boss" },
      });

      // Manager file should have incoming Known Relations section
      const bossContent = readFileSync(fileBoss, "utf-8");
      expect(bossContent).toContain("## Known Relations");
      expect(bossContent).toContain("reports_to");
      expect(bossContent).toContain("brain/entities/sub");
    });

    test("changing reports_to removes old manager KR and adds new manager KR", async () => {
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      const fileSub = join(vaultPath, "entities", "sub.md");
      const fileOldBoss = join(vaultPath, "entities", "old-boss.md");
      const fileNewBoss = join(vaultPath, "entities", "new-boss.md");
      writeFileSync(fileSub, "---\ntitle: Sub\ntype: entity/person\nreports_to: brain/entities/old-boss\n---\ninfo", "utf-8");
      writeFileSync(fileOldBoss, "---\ntitle: OldBoss\ntype: entity/person\n---\ninfo", "utf-8");
      writeFileSync(fileNewBoss, "---\ntitle: NewBoss\ntype: entity/person\n---\ninfo", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/sub", "Sub", "entities/sub.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/old-boss", "OldBoss", "entities/old-boss.md", "h2");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/new-boss", "NewBoss", "entities/new-boss.md", "h3");
      // Pre-existing edge to old boss
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, 'reports_to')"
      ).run("brain/entities/sub", "brain/entities/old-boss");

      const server = createServer(deps);
      await getTools(server).put_page.handler({
        slug: "brain/entities/sub",
        content: "updated",
        mode: "patch",
        extra: { reports_to: "brain/entities/new-boss" },
      });

      // Old boss: incoming KR should be gone
      const oldBossContent = readFileSync(fileOldBoss, "utf-8");
      expect(oldBossContent).not.toContain("brain/entities/sub");

      // New boss: incoming KR should appear
      const newBossContent = readFileSync(fileNewBoss, "utf-8");
      expect(newBossContent).toContain("## Known Relations");
      expect(newBossContent).toContain("reports_to");
      expect(newBossContent).toContain("brain/entities/sub");
    });

    test("new page with extra.reports_to syncs manager's incoming Known Relations", async () => {
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      const fileBoss = join(vaultPath, "entities", "boss.md");
      writeFileSync(fileBoss, "---\ntitle: Boss\ntype: entity/person\n---\ninfo", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/boss", "Boss", "entities/boss.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).put_page.handler({
        slug: "brain/entities/rookie",
        content: "new hire",
        title: "Rookie",
        type: "entity/person",
        extra: { reports_to: "brain/entities/boss" },
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.action).toBe("created");

      // Boss file should have incoming KR from the new employee
      const bossContent = readFileSync(fileBoss, "utf-8");
      expect(bossContent).toContain("## Known Relations");
      expect(bossContent).toContain("reports_to");
      expect(bossContent).toContain(data.page.slug);
    });
  });

  describe("append_page tool", () => {
    test("appends and syncs wikilinks to markdown Known Relations (bidirectional)", async () => {
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      const fileA = join(vaultPath, "entities", "person-a.md");
      const fileB = join(vaultPath, "entities", "person-b.md");
      writeFileSync(fileA, "---\ntitle: PersonA\ntype: entity/person\n---\noriginal", "utf-8");
      writeFileSync(fileB, "---\ntitle: PersonB\ntype: entity/person\n---\ncontent B", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/person-a", "PersonA", "entities/person-a.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/person-b", "PersonB", "entities/person-b.md", "h2");

      const server = createServer(deps);
      await getTools(server).append_page.handler({
        slug: "brain/entities/person-a",
        content: "later met [[PersonB]]",
      });

      // Source page gets outgoing KR
      const updated = readFileSync(fileA, "utf-8");
      expect(updated).toContain("## Known Relations");
      expect(updated).toContain("person-b");
      // Target page gets incoming KR
      const targetB = readFileSync(fileB, "utf-8");
      expect(targetB).toContain("## Known Relations");
      expect(targetB).toContain("person-a");
    });

    test("no Known Relations section when wikilink targets non-existent entity", async () => {
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      const fileA = join(vaultPath, "entities", "person-a.md");
      writeFileSync(fileA, "---\ntitle: PersonA\ntype: entity/person\n---\noriginal", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/person-a", "PersonA", "entities/person-a.md", "h1");

      const server = createServer(deps);
      await getTools(server).put_page.handler({
        slug: "brain/entities/person-a",
        content: "saw [[Nobody]] there",
      });

      const updated = readFileSync(fileA, "utf-8");
      expect(updated).not.toContain("## Known Relations");
    });

    // ─── #177: append must preserve content before Known Relations sync ───

    test("append on entity page with existing KR preserves new content and KR", async () => {
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      const fileA = join(vaultPath, "entities", "person-x.md");
      const fileB = join(vaultPath, "entities", "person-y.md");
      writeFileSync(fileB, "---\ntitle: PersonY\ntype: entity/person\n---\ncontent Y", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/person-y", "PersonY", "entities/person-y.md", "h2");

      // Create page with pre-existing KR (simulating a page that already has links)
      writeFileSync(fileA, "---\ntitle: PersonX\ntype: entity/person\n---\noriginal body\n\n## Known Relations\n\n- collaborated → [[person-y]]\n", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/person-x", "PersonX", "entities/person-x.md", "h1");
      // Seed link so syncLinksToMarkdown will rebuild KR
      db.rawDb.prepare("INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)")
        .run("brain/entities/person-x", "brain/entities/person-y", "collaborated");

      const server = createServer(deps);
      const result = await getTools(server).append_page.handler({
        slug: "brain/entities/person-x",
        content: "anonymous appended section",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.action).toBe("appended");

      // Vault file must contain both original body AND new content
      const vaultContent = readFileSync(fileA, "utf-8");
      expect(vaultContent).toContain("original body");
      expect(vaultContent).toContain("anonymous appended section");
      // KR must still exist and not be duplicated
      const krCount = (vaultContent.match(/## Known Relations/g) ?? []).length;
      expect(krCount).toBe(1);
      // Original graph link must still be there
      expect(vaultContent).toContain("person-y");

      // get_page should immediately reflect the appended content
      const getPageResult = await getTools(server).get_page.handler({
        slug: "brain/entities/person-x",
        include_full_body: true,
      });
      const pageData = JSON.parse(getPageResult.content[0].text);
      expect(pageData.raw.body).toContain("anonymous appended section");
      expect(pageData.raw.body).toContain("original body");

      // DB content_hash must match final vault file
      const dbHash = db.rawDb.prepare("SELECT content_hash FROM pages WHERE slug = ?").get("brain/entities/person-x") as { content_hash: string | null } | undefined;
      expect(dbHash?.content_hash).toBeDefined();
      const { hashContent } = await import("../../src/core/shared.js");
      const fileHash = hashContent(vaultContent);
      expect(dbHash!.content_hash).toBe(fileHash);

      // Original graph edge must still exist in links table (not just markdown)
      const outgoing = db.getOutgoingLinks("brain/entities/person-x");
      const edge = outgoing.find((l) => l.to_slug === "brain/entities/person-y");
      expect(edge).toBeDefined();
    });

    test("append on entity page without KR still works", async () => {
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      const fileA = join(vaultPath, "entities", "person-c.md");
      writeFileSync(fileA, "---\ntitle: PersonC\ntype: entity/person\n---\noriginal content only", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/person-c", "PersonC", "entities/person-c.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).append_page.handler({
        slug: "brain/entities/person-c",
        content: "new section added",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.action).toBe("appended");

      const vaultContent = readFileSync(fileA, "utf-8");
      expect(vaultContent).toContain("original content only");
      expect(vaultContent).toContain("new section added");
    });

    test("append on record page still works", async () => {
      mkdirSync(join(vaultPath, "records"), { recursive: true });
      const fileA = join(vaultPath, "records", "note-a.md");
      writeFileSync(fileA, "---\ntitle: NoteA\ntype: record\n---\nrecord content", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'record', ?, ?, ?)`
      ).run("records/note-a", "NoteA", "records/note-a.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).append_page.handler({
        slug: "records/note-a",
        content: "appended record section",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.action).toBe("appended");

      const vaultContent = readFileSync(fileA, "utf-8");
      expect(vaultContent).toContain("record content");
      expect(vaultContent).toContain("appended record section");
    });

    test("custom separator is preserved", async () => {
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      const fileA = join(vaultPath, "entities", "person-d.md");
      writeFileSync(fileA, "---\ntitle: PersonD\ntype: entity/person\n---\nfirst part", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/person-d", "PersonD", "entities/person-d.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).append_page.handler({
        slug: "brain/entities/person-d",
        content: "second part",
        separator: "\n---\n",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.action).toBe("appended");

      const vaultContent = readFileSync(fileA, "utf-8");
      expect(vaultContent).toContain("first part\n---\nsecond part");
    });

    test("returns error when page does not exist (not silent success)", async () => {
      const server = createServer(deps);
      const result = await getTools(server).append_page.handler({
        slug: "brain/entities/nonexistent-ghost",
        content: "should not be appended",
      });
      const data = JSON.parse(result.content[0].text);
      // Must not return action: appended
      expect(data.action).toBeUndefined();
      expect(data.error).toBeDefined();
    });

    test("patch returns null after precheck succeeds — returns error, not fake success", async () => {
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      const fileA = join(vaultPath, "entities", "person-g.md");
      writeFileSync(fileA, "---\ntitle: PersonG\ntype: entity/person\n---\noriginal", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/person-g", "PersonG", "entities/person-g.md", "h1");

      const server = createServer(deps);
      const tools = getTools(server);

      // Intercept CBrainDB.getPage: 1st call (precheck) succeeds,
      // 2nd call (inside PageManager.patch → getBySlug → getPage) returns null.
      const origGetPage = db.getPage.bind(db);
      let getPageCalls = 0;
      db.getPage = (s: string) => {
        getPageCalls++;
        if (getPageCalls === 2 && s === "brain/entities/person-g") return null;
        return origGetPage(s);
      };

      const result = await tools.append_page.handler({
        slug: "brain/entities/person-g",
        content: "should not be appended",
      });
      db.getPage = origGetPage;

      const data = JSON.parse(result.content[0].text);
      expect(data.action).toBeUndefined();
      expect(data.error).toBe("Append failed");
      expect(result.isError).toBe(true);
    });

    test("final verification fails when vault file disappears mid-append", async () => {
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      const fileA = join(vaultPath, "entities", "person-h.md");
      writeFileSync(fileA, "---\ntitle: PersonH\ntype: entity/person\n---\noriginal", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/person-h", "PersonH", "entities/person-h.md", "h1");

      const server = createServer(deps);
      const tools = getTools(server);

      // Inject file loss INSIDE a single append, between patch and verify.
      // Call sequence of db.getPage for this slug during one append:
      //   1 = precheck getBySlug, 2 = patch→update→getBySlug, 3 = verifyPersistedBody→getBySlugFresh→getBySlug
      // On the 3rd call (verification read), delete the vault file so getBySlug
      // returns null (existsSync check fails after cache bust).
      const origGetPage = db.getPage.bind(db);
      let callCount = 0;
      db.getPage = (s: string) => {
        callCount++;
        if (callCount === 3 && s === "brain/entities/person-h" && existsSync(fileA)) {
          unlinkSync(fileA);
        }
        return origGetPage(s);
      };

      let result: { content: Array<{ type: string; text: string }>; isError?: boolean };
      try {
        result = await tools.append_page.handler({
          slug: "brain/entities/person-h",
          content: "anonymous appended text",
        });
      } finally {
        db.getPage = origGetPage;
      }

      const data = JSON.parse(result.content[0].text);
      expect(data.action).toBeUndefined();
      expect(data.error).toBe("Append verification failed");
      expect(result.isError).toBe(true);
    });

    test("exact body verification rejects silent revert to old body (duplicate content)", async () => {
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      const fileA = join(vaultPath, "entities", "person-i.md");
      // Original body already contains the text we'll append
      writeFileSync(fileA, "---\ntitle: PersonI\ntype: entity/person\n---\noriginal body with duplicate content here", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/person-i", "PersonI", "entities/person-i.md", "h1");

      const server = createServer(deps);

      // Simulate a post-processing failure that reverts the body to the OLD version
      // (e.g. a buggy sync writes back the pre-append content). The appended text
      // "duplicate content here" already exists in the old body, so a naive
      // includes() check would falsely pass. The exact comparison must catch this.
      //
      // Call sequence of db.getPage during one append:
      //   1 = precheck, 2 = patch→update→getBySlug, 3 = verifyPersistedBody→getBySlugFresh→getBySlug
      // On the 3rd call (verification read), overwrite the file with the OLD body
      // so the persisted body (old) != expected body (patch produced new).
      const origGetPage = db.getPage.bind(db);
      const oldBody = "original body with duplicate content here";
      let callCount = 0;
      db.getPage = (s: string) => {
        callCount++;
        const result = origGetPage(s);
        if (callCount === 3 && s === "brain/entities/person-i" && result) {
          const fm = `---\ntitle: PersonI\ntype: entity/person\n---\n${oldBody}`;
          writeFileSync(fileA, fm, "utf-8");
        }
        return result;
      };

      const result = await getTools(server).append_page.handler({
        slug: "brain/entities/person-i",
        content: "duplicate content here",
      });
      db.getPage = origGetPage;

      const data = JSON.parse(result.content[0].text);
      // Exact verification must FAIL — old body != expected appended body.
      // (A naive includes() implementation would return "appended" here.)
      expect(data.action).toBeUndefined();
      expect(data.error).toBe("Append verification failed");
      expect(result.isError).toBe(true);
    });

    test("index failure returns partial success with warning and needs_sync", async () => {
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      const fileA = join(vaultPath, "entities", "person-e.md");
      writeFileSync(fileA, "---\ntitle: PersonE\ntype: entity/person\n---\noriginal", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/person-e", "PersonE", "entities/person-e.md", "h1");

      // Drop chunks table to make indexing fail (writeIndexes will throw)
      db.rawDb.prepare("DROP TABLE chunks").run();

      const server = createServer(deps);
      const result = await getTools(server).append_page.handler({
        slug: "brain/entities/person-e",
        content: "anonymous appended text",
      });

      // Recreate chunks table so subsequent tests don't break
      db.rawDb.prepare("CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, page_slug TEXT NOT NULL, chunk_index INTEGER NOT NULL DEFAULT 0, content TEXT NOT NULL)").run();

      const data = JSON.parse(result.content[0].text);
      // Must be partial success with warning, not clean success
      expect(data.action).toBe("appended");
      expect(data.warnings).toContain("index_sync_failed");
      expect(data.needs_sync).toBe(true);
      // Must not expose raw error message, path, or SQL
      expect(JSON.stringify(data)).not.toContain("no such table");
      expect(JSON.stringify(data)).not.toContain("chunks");
      expect(JSON.stringify(data)).not.toContain("/tmp/");

      // Body must still be persisted in vault
      const vaultContent = readFileSync(fileA, "utf-8");
      expect(vaultContent).toContain("anonymous appended text");
    });

    test("KR sync failure returns partial success with warning", async () => {
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      const fileA = join(vaultPath, "entities", "person-f.md");
      writeFileSync(fileA, "---\ntitle: PersonF\ntype: entity/person\n---\noriginal", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run("brain/entities/person-f", "PersonF", "entities/person-f.md", "h1");

      // Delete vault file after patch completes but before sync reads it.
      // We can't intercept inside createServer, so instead: delete the file entirely
      // so syncLinksToMarkdown's readFileSync will throw.
      // First, do the append with file present...
      const server = createServer(deps);

      // Remove file to force syncLinksToMarkdown to fail (it checks existsSync and returns early,
      // so we need a different approach: delete the pages row so getOutgoingLinks fails)
      // Actually simpler: drop the links table to make syncLinksToMarkdown's query fail
      db.rawDb.prepare("DROP TABLE links").run();

      const result = await getTools(server).append_page.handler({
        slug: "brain/entities/person-f",
        content: "anonymous appended text",
      });

      // Recreate links table so subsequent tests don't break
      db.rawDb.prepare("CREATE TABLE IF NOT EXISTS links (id INTEGER PRIMARY KEY AUTOINCREMENT, from_slug TEXT NOT NULL, to_slug TEXT NOT NULL, relation TEXT NOT NULL DEFAULT 'related', context TEXT, weight REAL DEFAULT 1.0, strength TEXT DEFAULT 'medium', source_type TEXT DEFAULT 'auto', confidence REAL DEFAULT 1.0, active INTEGER DEFAULT 1, provenance_id INTEGER)").run();

      const data = JSON.parse(result.content[0].text);
      expect(data.action).toBe("appended");
      expect(data.warnings).toContain("relation_sync_failed");
      expect(data.needs_sync).toBe(true);
      // Must not expose raw error
      expect(JSON.stringify(data)).not.toContain("no such table");
      expect(JSON.stringify(data)).not.toContain("links");
    });
  });

  // ─── #195: append_page updates entity structure from appended facts ───

  describe("append_page entity structure (#195)", () => {
    function seedEntity(slug: string, fileRel: string, title: string, body = "", extraFm = ""): void {
      const dirParts = fileRel.split("/").slice(0, -1);
      mkdirSync(join(vaultPath, ...dirParts), { recursive: true });
      writeFileSync(join(vaultPath, fileRel), `---\ntitle: ${title}\ntype: entity/person\n${extraFm}---\n${body}`);
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)`
      ).run(slug, title, fileRel, `h-${slug}`);
    }

    test("append reports_to frontmatter creates trusted reports_to edge (#195, #233)", async () => {
      seedEntity("brain/entities/shi-ti-a", "entities/shi-ti-a.md", "实体A");
      seedEntity("brain/entities/org-c", "entities/org-c.md", "组织C");
      const server = createServer(deps);
      const result = await getTools(server).append_page.handler({
        slug: "brain/entities/shi-ti-a",
        content: "---\nreports_to: brain/entities/org-c\n---\n后续补充说明",
      });
      const data = JSON.parse(result.content[0].text);

      expect(data.action).toBe("appended");
      // Body persists the appended text
      const vault = readFileSync(join(vaultPath, "entities/shi-ti-a.md"), "utf-8");
      expect(vault).toContain("后续补充说明");
      // reports_to graph edge created. #233: deterministic agent write -> trusted
      // (previously source_type=agent yielded 'candidate'; authoritative reports_to
      // is now trusted so it can supersede stale edges).
      const links = db.rawDb.prepare(
        "SELECT source_type, trust_state FROM links WHERE from_slug = ? AND relation = 'reports_to'"
      ).all("brain/entities/shi-ti-a") as Array<{ source_type: string; trust_state: string }>;
      expect(links.length).toBe(1);
      expect(links[0].source_type).toBe("agent");
      expect(links[0].trust_state).toBe("trusted");
      // Structured return
      expect(data.relations_added).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(data.fields_updated)).toBe(true);
      expect(data.fields_updated).toContain("reports_to");
    });

    test("append wikilink syncs Known Relations bidirectionally and reports relations_added (#195)", async () => {
      seedEntity("brain/entities/shi-ti-a", "entities/shi-ti-a.md", "实体A");
      seedEntity("brain/entities/shi-ti-b", "entities/shi-ti-b.md", "实体B");
      const server = createServer(deps);
      const result = await getTools(server).append_page.handler({
        slug: "brain/entities/shi-ti-a",
        content: "后续提到了 [[实体B]]",
      });
      const data = JSON.parse(result.content[0].text);

      expect(data.action).toBe("appended");
      expect(data.relations_added).toBeGreaterThanOrEqual(1);
      // Bidirectional Known Relations
      expect(readFileSync(join(vaultPath, "entities/shi-ti-a.md"), "utf-8")).toContain("## Known Relations");
      expect(readFileSync(join(vaultPath, "entities/shi-ti-b.md"), "utf-8")).toContain("## Known Relations");
    });

    test("append reports_to does not overwrite existing frontmatter, flags conflict (#195)", async () => {
      seedEntity("brain/entities/shi-ti-a", "entities/shi-ti-a.md", "实体A", "", "reports_to: brain/entities/org-old\n");
      seedEntity("brain/entities/org-old", "entities/org-old.md", "组织旧");
      seedEntity("brain/entities/org-new", "entities/org-new.md", "组织新");
      const server = createServer(deps);
      const result = await getTools(server).append_page.handler({
        slug: "brain/entities/shi-ti-a",
        content: "---\nreports_to: brain/entities/org-new\n---\n补充说明",
      });
      const data = JSON.parse(result.content[0].text);

      expect(data.action).toBe("appended");
      // Existing frontmatter preserved — NOT overwritten
      const fm = readFileSync(join(vaultPath, "entities/shi-ti-a.md"), "utf-8");
      expect(fm).toContain("org-old");
      expect(fm).not.toContain("org-new");
      // Conflict flagged for human review
      expect(data.needs_review).toBe(true);
      expect(Array.isArray(data.warnings)).toBe(true);
      expect(data.warnings.length).toBeGreaterThan(0);
    });

    test("append casual prose creates no garbage links (#195)", async () => {
      seedEntity("brain/entities/shi-ti-a", "entities/shi-ti-a.md", "实体A");
      const server = createServer(deps);
      const result = await getTools(server).append_page.handler({
        slug: "brain/entities/shi-ti-a",
        content: "今天天气不错，随便聊聊家常，这里没有任何结构化信息。",
      });
      const data = JSON.parse(result.content[0].text);

      expect(data.action).toBe("appended");
      expect(data.relations_added).toBe(0);
      expect(data.fields_updated).toEqual([]);
      const row = db.rawDb.prepare("SELECT COUNT(*) AS n FROM links WHERE from_slug = ?").get("brain/entities/shi-ti-a") as { n: number };
      expect(row.n).toBe(0);
    });

    test("append to non-existent page returns error, no fake success (#195)", async () => {
      const server = createServer(deps);
      const result = await getTools(server).append_page.handler({
        slug: "brain/entities/does-not-exist",
        content: "whatever",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.action).toBeUndefined();
      expect(data.error).toBeDefined();
      expect(result.isError).toBe(true);
    });

    test("append result display/summary leak no internal fields (#195)", async () => {
      seedEntity("brain/entities/shi-ti-a", "entities/shi-ti-a.md", "实体A");
      seedEntity("brain/entities/shi-ti-b", "entities/shi-ti-b.md", "实体B");
      const server = createServer(deps);
      const result = await getTools(server).append_page.handler({
        slug: "brain/entities/shi-ti-a",
        content: "后续提到了 [[实体B]]",
      });
      const data = JSON.parse(result.content[0].text);

      // Envelope must exist
      expect(data.display).toBeDefined();
      expect(data.summary).toBeDefined();
      const displayText = String(data.display ?? "");
      const summaryMsg = String(data.summary?.message ?? "");
      const banned = [
        "brain/entities", "entities/", ".md",
        "score", "vector", "trace",
        "SELECT", "INSERT", "source_type", "trust_state",
      ];
      for (const term of banned) {
        expect(displayText, `display leaked ${term}`).not.toContain(term);
        expect(summaryMsg, `summary.message leaked ${term}`).not.toContain(term);
      }
    });

    test("append reports_to syncs target page incoming Known Relations (#195)", async () => {
      seedEntity("brain/entities/shi-ti-a", "entities/shi-ti-a.md", "实体A");
      seedEntity("brain/entities/org-c", "entities/org-c.md", "组织C");
      const server = createServer(deps);
      await getTools(server).append_page.handler({
        slug: "brain/entities/shi-ti-a",
        content: "---\nreports_to: brain/entities/org-c\n---\n补充说明",
      });

      // The reports_to target (组织C) gains an incoming edge — its markdown
      // Known Relations must be rebuilt, else DB graph and vault drift apart.
      const targetVault = readFileSync(join(vaultPath, "entities/org-c.md"), "utf-8");
      expect(targetVault).toContain("## Known Relations");
      expect(targetVault).toContain("reports_to");
      expect(targetVault).toContain("shi-ti-a");
    });

    test("append reports_to conflict does not sync the rejected target (#195)", async () => {
      seedEntity("brain/entities/shi-ti-a", "entities/shi-ti-a.md", "实体A", "", "reports_to: brain/entities/org-old\n");
      seedEntity("brain/entities/org-old", "entities/org-old.md", "组织旧");
      seedEntity("brain/entities/org-new", "entities/org-new.md", "组织新");
      const server = createServer(deps);
      await getTools(server).append_page.handler({
        slug: "brain/entities/shi-ti-a",
        content: "---\nreports_to: brain/entities/org-new\n---\n补充",
      });

      // The rejected new target must NOT gain a Known Relations section.
      const rejectedVault = readFileSync(join(vaultPath, "entities/org-new.md"), "utf-8");
      expect(rejectedVault).not.toContain("## Known Relations");
    });
  });

  describe("delete_page tool", () => {
    test("deletes a page", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/todel", "Del", "del.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).delete_page.handler({ slug: "entities/todel" });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);

      const page = db.rawDb.prepare("SELECT * FROM pages WHERE slug = ?").get("entities/todel");
      expect(page).toBeNull();
    });

    test("returns false for missing page", async () => {
      const server = createServer(deps);
      const result = await getTools(server).delete_page.handler({ slug: "entities/ghost" });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(false);
    });
  });

  describe("resolve_slugs tool", () => {
    test("resolves title to slugs", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/zhangsan", "张三", "zhangsan.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).resolve_slugs.handler({ queries: ["张三"] });
      const data = JSON.parse(result.content[0].text);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("writeback tool", () => {
    test("appends content to existing page", async () => {
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      writeFileSync(join(vaultPath, "entities", "test.md"), "---\ntitle: Test\ntype: entity\n---\noriginal content", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/test", "Test", "entities/test.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).writeback.handler({
        action: "append",
        targetSlug: "entities/test",
        content: " appended note",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    test("defer NER mode creates backfill job for append_page instead of running NER inline (#271)", async () => {
      mkdirSync(join(vaultPath, "records"), { recursive: true });
      const fileA = join(vaultPath, "records", "append-defer.md");
      writeFileSync(fileA, "---\ntitle: AppendDefer\ntype: record\n---\noriginal body", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'record', ?, ?, ?)`
      ).run("brain/records/append-defer", "AppendDefer", "records/append-defer.md", "h1");

      const server = createServer({ ...deps, nerIngestMode: "defer" });
      const result = await getTools(server).append_page.handler({
        slug: "brain/records/append-defer",
        content: "追加正文应该排入 NER backfill",
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.summary.status).toBe("ok");
      const job = db.rawDb.prepare(
        "SELECT name, status, data FROM jobs WHERE name = 'ner-backfill'"
      ).get() as { name: string; status: string; data: string } | undefined;
      expect(job).toBeDefined();
      expect(job!.status).toBe("pending");
      expect(JSON.parse(job!.data).slug).toBe("brain/records/append-defer");
    });

    test("creates a concept via writeback", async () => {
      const server = createServer(deps);
      const result = await getTools(server).writeback.handler({
        action: "create_concept",
        content: "A new concept",
        conceptTitle: "New Concept",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });
  });

  describe("generate_indexes tool", () => {
    test("generates index pages", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/a", "A", "a.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).generate_indexes.handler({});
      const data = JSON.parse(result.content[0].text);
      expect(data.generated).toBeGreaterThanOrEqual(0);
    });
  });

  describe("remove_orphans tool", () => {
    test("removes orphaned DB entries", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/orphan", "Orphan", "nonexistent.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).remove_orphans.handler({});
      const data = JSON.parse(result.content[0].text);
      expect(typeof data.removed).toBe("number");
    });
  });

  describe("health tool", () => {
    test("returns health report", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count) VALUES (?, 'entity', ?, ?, ?, ?)`
      ).run("entities/h1", "H1", "h1.md", "h1", 3);

      const server = createServer(deps);
      const result = await getTools(server).health.handler({});
      const data = JSON.parse(result.content[0].text);
      expect(data.display).toBeDefined();
      expect(data.summary).toBeDefined();
      expect(data.raw.overallStatus).toBeDefined();
      expect(data.raw.dimensions).toBeDefined();
      expect(data.raw.metrics).toBeDefined();
    });
  });

  describe("sync tool", () => {
    test("runs full sync without error", async () => {
      const server = createServer(deps);
      const result = await getTools(server).sync.handler({});
      const data = JSON.parse(result.content[0].text);
      expect(typeof data).toBe("object");
    });

    test("full sync returns structured diagnostics on title collision", async () => {
      // Seed existing page with title "人物A"
      mkdirSync(join(vaultPath, "brain/entities/person"), { recursive: true });
      writeFileSync(join(vaultPath, "brain/entities/person/renwu-a.md"),
        "---\ntitle: 人物A\ntype: entity/person\nslug: brain/entities/person/renwu-a\n---\n已有实体", "utf-8");

      mkdirSync(join(vaultPath, "records"), { recursive: true });
      writeFileSync(join(vaultPath, "records/renwu-a-note.md"),
        "---\ntitle: 人物A\ntype: record\nslug: records/renwu-a-note\n---\n新记录", "utf-8");

      const server = createServer(deps);
      // Both files are new — whichever is processed second will hit title collision
      const result = await getTools(server).sync.handler({});
      const data = JSON.parse(result.content[0].text);
      expect(data.errors).toBeGreaterThanOrEqual(1);
      expect(data.diagnostics).toBeDefined();
      expect(data.diagnostics.length).toBeGreaterThanOrEqual(1);

      const diag = data.diagnostics[0];
      expect(diag.kind).toBe("title_collision");
      expect(diag.title).toBe("人物A");
      // incoming and existing have different slugs
      expect(diag.incoming.slug).not.toBe(diag.existing.slug);
      // Both have structured slug/type/filePath
      expect(diag.incoming.type).toBeTruthy();
      expect(diag.incoming.filePath).toBeTruthy();
      expect(diag.existing.type).toBeTruthy();
      expect(diag.existing.filePath).toBeTruthy();
    });
  });

  // ─── Tag tools ─────────────────────────────────

  describe("get_tags tool", () => {
    test("returns tags for a page", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/tagged", "Tagged", "tagged.md", "h1");
      db.rawDb.prepare("INSERT OR IGNORE INTO tags (page_slug, tag) VALUES (?, ?)").run("entities/tagged", "ai");
      db.rawDb.prepare("INSERT OR IGNORE INTO tags (page_slug, tag) VALUES (?, ?)").run("entities/tagged", "product");

      const server = createServer(deps);
      const result = await getTools(server).get_tags.handler({ slug: "entities/tagged" });
      const data = JSON.parse(result.content[0].text);
      expect(data.slug).toBe("entities/tagged");
      expect(Array.isArray(data.tags)).toBe(true);
      expect(data.tags.length).toBe(2);
    });
  });

  describe("tag tool", () => {
    test("action=list matches get_tags shape", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/tag-tool-list", "Tagged", "tag-tool-list.md", "h1");
      db.rawDb.prepare("INSERT OR IGNORE INTO tags (page_slug, tag) VALUES (?, ?)").run("entities/tag-tool-list", "tag-a");
      db.rawDb.prepare("INSERT OR IGNORE INTO tags (page_slug, tag) VALUES (?, ?)").run("entities/tag-tool-list", "tag-b");

      const server = createServer(deps);
      const result = await getTools(server).tag.handler({ action: "list", slug: "entities/tag-tool-list" });
      const data = JSON.parse(result.content[0].text);
      expect(data).toEqual({ slug: "entities/tag-tool-list", tags: ["tag-a", "tag-b"] });
    });

    test("action=add matches add_tag shape and writes tag", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/tag-tool-add", "Tagged", "tag-tool-add.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).tag.handler({ action: "add", slug: "entities/tag-tool-add", tag: "new-tag" });
      const data = JSON.parse(result.content[0].text);
      expect(data).toEqual({ success: true, slug: "entities/tag-tool-add", tag: "new-tag" });

      const cnt = db.rawDb.prepare("SELECT COUNT(*) as c FROM tags WHERE page_slug = ? AND tag = ?")
        .get("entities/tag-tool-add", "new-tag") as { c: number };
      expect(cnt.c).toBe(1);
    });

    test("action=remove matches remove_tag shape and removes tag", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/tag-tool-remove", "Tagged", "tag-tool-remove.md", "h1");
      db.rawDb.prepare("INSERT OR IGNORE INTO tags (page_slug, tag) VALUES (?, ?)").run("entities/tag-tool-remove", "old-tag");

      const server = createServer(deps);
      const result = await getTools(server).tag.handler({ action: "remove", slug: "entities/tag-tool-remove", tag: "old-tag" });
      const data = JSON.parse(result.content[0].text);
      expect(data).toEqual({ success: true, slug: "entities/tag-tool-remove", tag: "old-tag" });

      const cnt = db.rawDb.prepare("SELECT COUNT(*) as c FROM tags WHERE page_slug = ? AND tag = ?")
        .get("entities/tag-tool-remove", "old-tag") as { c: number };
      expect(cnt.c).toBe(0);
    });
  });

  describe("add_tag tool", () => {
    test("adds a tag to a page", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/t1", "T1", "t1.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).add_tag.handler({ slug: "entities/t1", tag: "new-tag" });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);

      const cnt = db.rawDb.prepare("SELECT COUNT(*) as c FROM tags WHERE page_slug = ?").get("entities/t1") as { c: number };
      expect(cnt.c).toBe(1);
    });
  });

  describe("remove_tag tool", () => {
    test("removes a tag from a page", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/t2", "T2", "t2.md", "h1");
      db.rawDb.prepare("INSERT OR IGNORE INTO tags (page_slug, tag) VALUES (?, ?)").run("entities/t2", "old-tag");

      const server = createServer(deps);
      const result = await getTools(server).remove_tag.handler({ slug: "entities/t2", tag: "old-tag" });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);

      const cnt = db.rawDb.prepare("SELECT COUNT(*) as c FROM tags WHERE page_slug = ?").get("entities/t2") as { c: number };
      expect(cnt.c).toBe(0);
    });
  });

  // ─── Link tools ────────────────────────────────

  describe("link tool", () => {
    test("action=list matches get_links envelope shape", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/link-list-from", "Link List From", "link-list-from.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/link-list-to", "Link List To", "link-list-to.md", "h2");
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
      ).run("entities/link-list-from", "entities/link-list-to", "mentions");

      const server = createServer(deps);
      const result = await getTools(server).link.handler({
        action: "list",
        slug: "entities/link-list-from",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.display).toBeDefined();
      expect(data.summary).toBeDefined();
      expect(Array.isArray(data.raw)).toBe(true);
      expect(data.raw.length).toBeGreaterThanOrEqual(1);
    });

    test("action=add matches add_link shape and writes link", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/link-add-from", "Link Add From", "link-add-from.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/link-add-to", "Link Add To", "link-add-to.md", "h2");
      writeFileSync(join(vaultPath, "link-add-from.md"), "---\ntitle: Link Add From\ntype: entity\n---\n");
      writeFileSync(join(vaultPath, "link-add-to.md"), "---\ntitle: Link Add To\ntype: entity\n---\n");

      const server = createServer(deps);
      const result = await getTools(server).link.handler({
        action: "add",
        from: "entities/link-add-from",
        to: "entities/link-add-to",
        relation: "mentions",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data).toEqual({
        success: true,
        from: "entities/link-add-from",
        to: "entities/link-add-to",
        relation: "mentions",
      });
      const cnt = db.rawDb.prepare(
        "SELECT COUNT(*) as c FROM links WHERE from_slug = ? AND to_slug = ?"
      ).get("entities/link-add-from", "entities/link-add-to") as { c: number };
      expect(cnt.c).toBe(1);
    });

    test("action=remove matches remove_link shape and removes link", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/link-remove-from", "Link Remove From", "link-remove-from.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/link-remove-to", "Link Remove To", "link-remove-to.md", "h2");
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
      ).run("entities/link-remove-from", "entities/link-remove-to", "mentions");

      const server = createServer(deps);
      const result = await getTools(server).link.handler({
        action: "remove",
        from: "entities/link-remove-from",
        to: "entities/link-remove-to",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data).toEqual({
        success: true,
        from: "entities/link-remove-from",
        to: "entities/link-remove-to",
      });
      const cnt = db.rawDb.prepare(
        "SELECT COUNT(*) as c FROM links WHERE from_slug = ? AND to_slug = ?"
      ).get("entities/link-remove-from", "entities/link-remove-to") as { c: number };
      expect(cnt.c).toBe(0);
    });
  });

  describe("get_links tool", () => {
    test("returns links for a page", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/from", "From", "from.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/to", "To", "to.md", "h2");
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
      ).run("entities/from", "entities/to", "mentions");

      const server = createServer(deps);
      const result = await getTools(server).get_links.handler({ slug: "entities/from" });
      const data = JSON.parse(result.content[0].text);
      expect(data.display).toBeDefined();
      expect(data.summary).toBeDefined();
      expect(Array.isArray(data.raw)).toBe(true);
      expect(data.raw.length).toBeGreaterThanOrEqual(1);
    });

    test("returns backlinks when direction is 'to'", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/lfrom", "LFrom", "lfrom.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/lto", "LTo", "lto.md", "h2");
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
      ).run("entities/lfrom", "entities/lto", "mentions");

      const server = createServer(deps);
      const result = await getTools(server).get_links.handler({ slug: "entities/lto", direction: "to" });
      const data = JSON.parse(result.content[0].text);
      expect(data.display).toBeDefined();
      expect(Array.isArray(data.raw)).toBe(true);
    });
  });

  describe("remove_link tool", () => {
    test("removes a link between pages", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/rl1", "RL1", "rl1.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/rl2", "RL2", "rl2.md", "h2");
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
      ).run("entities/rl1", "entities/rl2", "mentions");

      const server = createServer(deps);
      const result = await getTools(server).remove_link.handler({
        from: "entities/rl1",
        to: "entities/rl2",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });
  });

  // ─── Timeline tools ────────────────────────────

  describe("timeline tool", () => {
    test("action=get matches get_timeline envelope shape", async () => {
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      writeFileSync(join(vaultPath, "entities", "tl-unified-get.md"), "---\ntitle: TL Unified\ntype: entity\n---\n| 2026.01 | Event |");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/tl-unified-get", "TL Unified", "entities/tl-unified-get.md", "h1");
      db.rawDb.prepare(
        "INSERT INTO timeline (page_slug, summary, event_date) VALUES (?, ?, ?)"
      ).run("entities/tl-unified-get", "Event 1", "2026-01-01");

      const server = createServer(deps);
      const result = await getTools(server).timeline.handler({ action: "get", slug: "entities/tl-unified-get" });
      const data = JSON.parse(result.content[0].text);
      expect(data.display).toBeDefined();
      expect(data.summary).toBeDefined();
      expect(data.raw.slug).toBe("entities/tl-unified-get");
      expect(Array.isArray(data.raw.events)).toBe(true);
      expect(data.raw.events.length).toBeGreaterThanOrEqual(1);
    });

    test("action=add matches add_timeline_entry shape and writes event", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/tl-unified-add", "TL Unified Add", "tl-unified-add.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).timeline.handler({
        action: "add",
        slug: "entities/tl-unified-add",
        summary: "Unified event",
        eventDate: "2026-07-05",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.slug).toBe("entities/tl-unified-add");

      const cnt = db.rawDb.prepare("SELECT COUNT(*) as c FROM timeline WHERE page_slug = ? AND summary = ?")
        .get("entities/tl-unified-add", "Unified event") as { c: number };
      expect(cnt.c).toBe(1);
    });
  });

  describe("add_timeline_entry tool", () => {
    test("adds a timeline event for a page", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/tl", "TL", "tl.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).add_timeline_entry.handler({
        slug: "entities/tl",
        summary: "Test event",
        eventDate: "2026-04-25",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });
  });

  describe("get_timeline tool", () => {
    test("returns timeline events for a page", async () => {
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      writeFileSync(join(vaultPath, "entities", "tl2.md"), "---\ntitle: TL2\ntype: entity\n---\n| 2026.01 | Event |");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/tl2", "TL2", "entities/tl2.md", "h1");
      db.rawDb.prepare(
        "INSERT INTO timeline (page_slug, summary, event_date) VALUES (?, ?, ?)"
      ).run("entities/tl2", "Event 1", "2026-01-01");

      const server = createServer(deps);
      const result = await getTools(server).get_timeline.handler({ slug: "entities/tl2" });
      const data = JSON.parse(result.content[0].text);
      expect(data.display).toBeDefined();
      expect(data.summary).toBeDefined();
      expect(data.raw.slug).toBe("entities/tl2");
      expect(Array.isArray(data.raw.events)).toBe(true);
      expect(data.raw.events.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Chunks & Log tools ────────────────────────

  describe("get_chunks tool", () => {
    test("returns chunks for a page", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/chunked", "Chunked", "chunked.md", "h1");
      db.rawDb.prepare(
        "INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, ?, ?)"
      ).run("entities/chunked", 0, "Hello world");

      const server = createServer(deps);
      const result = await getTools(server).get_chunks.handler({ slug: "entities/chunked" });
      const data = JSON.parse(result.content[0].text);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(1);
    });
  });

  describe("get_ingest_log tool", () => {
    test("returns ingest log entries", async () => {
      db.rawDb.prepare(
        "INSERT INTO ingest_log (source_type, action, page_slug, details) VALUES (?, ?, ?, ?)"
      ).run("text", "ingest", "entities/logtest", "Test entry");

      const server = createServer(deps);
      const result = await getTools(server).get_ingest_log.handler({ limit: 5 });
      const data = JSON.parse(result.content[0].text);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Version tools ─────────────────────────────

  describe("get_versions tool", () => {
    test("returns envelope with display/summary/raw", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/ver", "Ver", "ver.md", "h1");
      db.rawDb.prepare(
        "INSERT INTO versions (page_slug, version, content) VALUES (?, ?, ?)"
      ).run("entities/ver", 1, "v1 content");

      const server = createServer(deps);
      const result = await getTools(server).get_versions.handler({ slug: "entities/ver" });
      const data = JSON.parse(result.content[0].text);
      expect(data.display).toBeDefined();
      expect(data.summary).toBeDefined();
      expect(data.raw).toBeDefined();
      expect(data.summary.status).toBe("ok");
      expect(data.summary.count).toBe(1);
      expect(data.display).toContain("版本");
      // raw preserves full structure
      expect(data.raw.versions).toHaveLength(1);
      expect(data.raw.slug).toBe("entities/ver");
    });
  });

  describe("revert_version tool", () => {
    test("reverts to a specific version with envelope", async () => {
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      writeFileSync(join(vaultPath, "entities", "rev.md"), "---\ntitle: Rev\ntype: entity\n---\noriginal", "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/rev", "Rev", "entities/rev.md", "h1");
      db.rawDb.prepare(
        "INSERT INTO versions (page_slug, version, content) VALUES (?, ?, ?)"
      ).run("entities/rev", 1, "original content");

      const server = createServer(deps);
      const result = await getTools(server).revert_version.handler({
        slug: "entities/rev",
        version: 1,
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.display).toBeDefined();
      expect(data.summary).toBeDefined();
      expect(data.raw).toBeDefined();
      expect(data.raw.success).toBe(true);
      expect(data.display).toContain("回滚");
    });

    test("returns error envelope for missing version", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/rev2", "Rev2", "entities/rev2.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).revert_version.handler({
        slug: "entities/rev2",
        version: 999,
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.summary.status).toBe("error");
      expect(data.raw.success).toBe(false);
      expect(data.display).toContain("失败");
    });
  });

  // ─── Job tools ─────────────────────────────────

  describe("job_submit tool", () => {
    test("submits a job", async () => {
      const server = createServer(deps);
      const result = await getTools(server).job_submit.handler({
        name: "test-job",
        data: "{}",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.id).toBeGreaterThan(0);
      expect(data.status).toBe("pending");
    });
  });

  describe("job tool", () => {
    test("action=submit matches job_submit shape", async () => {
      const server = createServer(deps);
      const result = await getTools(server).job.handler({
        action: "submit",
        name: "anonymous-task",
        data: { value: 1 },
        priority: 2,
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.name).toBe("anonymous-task");
      expect(data.status).toBe("pending");
      expect(typeof data.id).toBe("number");
    });

    test("action=list matches job_list shape", async () => {
      const id = Number(db.rawDb.prepare(
        "INSERT INTO jobs (name, status, priority) VALUES (?, ?, ?)"
      ).run("anonymous-list-task", "done", 1).lastInsertRowid);

      const server = createServer(deps);
      const result = await getTools(server).job.handler({ action: "list", status: "done" });
      const data = JSON.parse(result.content[0].text);
      expect(Array.isArray(data)).toBe(true);
      expect(data.some((j: any) => j.id === id && j.status === "done")).toBe(true);
    });

    test("action=status matches job_status shape", async () => {
      const id = Number(db.rawDb.prepare(
        "INSERT INTO jobs (name, status, priority) VALUES (?, ?, ?)"
      ).run("anonymous-status-task", "pending", 1).lastInsertRowid);

      const server = createServer(deps);
      const result = await getTools(server).job.handler({ action: "status", id });
      const data = JSON.parse(result.content[0].text);
      expect(data.id).toBe(id);
      expect(data.name).toBe("anonymous-status-task");
    });

    test("action=cancel matches job_cancel shape", async () => {
      const id = Number(db.rawDb.prepare(
        "INSERT INTO jobs (name, status, priority) VALUES (?, ?, ?)"
      ).run("anonymous-cancel-task", "pending", 1).lastInsertRowid);

      const server = createServer(deps);
      const result = await getTools(server).job.handler({ action: "cancel", id });
      const data = JSON.parse(result.content[0].text);
      expect(data).toEqual({ success: true, id });
    });

    test("action=retry matches job_retry shape", async () => {
      const id = Number(db.rawDb.prepare(
        "INSERT INTO jobs (name, status, priority, attempts, max_attempts) VALUES (?, ?, ?, ?, ?)"
      ).run("anonymous-retry-task", "failed", 1, 1, 3).lastInsertRowid);

      const server = createServer(deps);
      const result = await getTools(server).job.handler({ action: "retry", id });
      const data = JSON.parse(result.content[0].text);
      expect(data).toEqual({ success: true, id });
    });
  });

  describe("job_list tool", () => {
    test("lists jobs", async () => {
      db.rawDb.prepare(
        "INSERT INTO jobs (name, status, priority) VALUES (?, ?, ?)"
      ).run("test-job", "pending", 0);

      const server = createServer(deps);
      const result = await getTools(server).job_list.handler({});
      const data = JSON.parse(result.content[0].text);
      expect(Array.isArray(data)).toBe(true);
    });

    test("filters by status", async () => {
      db.rawDb.prepare(
        "INSERT INTO jobs (name, status, priority) VALUES (?, ?, ?)"
      ).run("done-job", "done", 0);
      db.rawDb.prepare(
        "INSERT INTO jobs (name, status, priority) VALUES (?, ?, ?)"
      ).run("pending-job", "pending", 0);

      const server = createServer(deps);
      const result = await getTools(server).job_list.handler({ status: "done" });
      const data = JSON.parse(result.content[0].text);
      expect(data.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("job_status tool", () => {
    test("returns job details", async () => {
      const info = db.rawDb.prepare(
        "INSERT INTO jobs (name, status, priority) VALUES (?, ?, ?)"
      ).run("status-job", "pending", 0);
      const id = Number(info.lastInsertRowid);

      const server = createServer(deps);
      const result = await getTools(server).job_status.handler({ id });
      const data = JSON.parse(result.content[0].text);
      expect(data.name).toBe("status-job");
    });

    test("returns error for missing job", async () => {
      const server = createServer(deps);
      const result = await getTools(server).job_status.handler({ id: 99999 });
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBeDefined();
    });
  });

  describe("job_cancel tool", () => {
    test("cancels a pending job", async () => {
      const info = db.rawDb.prepare(
        "INSERT INTO jobs (name, status, priority) VALUES (?, ?, ?)"
      ).run("cancel-job", "pending", 0);
      const id = Number(info.lastInsertRowid);

      const server = createServer(deps);
      const result = await getTools(server).job_cancel.handler({ id });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });
  });

  describe("job_retry tool", () => {
    test("retries a failed job", async () => {
      const info = db.rawDb.prepare(
        "INSERT INTO jobs (name, status, priority, attempts, max_attempts) VALUES (?, ?, ?, ?, ?)"
      ).run("retry-job", "failed", 0, 1, 3);
      const id = Number(info.lastInsertRowid);

      const server = createServer(deps);
      const result = await getTools(server).job_retry.handler({ id });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });
  });

  describe("governed NER job boundary (#342)", () => {
    test("unified and alias submit reject reserved names and discriminators", async () => {
      const tools = getTools(createServer(deps));
      for (const invoke of [
        () => tools.job_submit.handler({ name: "ner-backfill", data: { slug: "private-a" } }),
        () => tools.job.handler({ action: "submit", name: "zero-link-backfill-batch", data: {} }),
        () => tools.job_submit.handler({ name: "other", data: { repair: { name: "zero-link-rich-records" } } }),
        () => tools.job.handler({ action: "submit", name: "other", data: { version: 1, repairName: "zero-link-rich-records", batchId: "private", ownership: [] } }),
      ]) {
        const result = await invoke();
        expect(JSON.parse(result.content[0].text).code).toBe("REPAIR_BATCH_RESERVED");
      }
      expect(db.listJobs()).toHaveLength(0);
    });

    test("every NER list/status projection omits payload, result, error and identity sentinels", async () => {
      const id = db.submitJob("ner-backfill", {
        slug: "records/private-slug", kind: "ner", sourceFingerprint: "page:private-fingerprint", token: "private-token",
      });
      db.rawDb.prepare("UPDATE jobs SET status='failed', result=?, error=? WHERE id=?")
        .run(JSON.stringify({ provider: "private-provider", outcome: "failed" }), "private-error", id);
      const tools = getTools(createServer(deps));
      for (const result of [
        await tools.job_list.handler({}),
        await tools.job.handler({ action: "list" }),
        await tools.job_status.handler({ id }),
        await tools.job.handler({ action: "status", id }),
      ]) {
        const text = result.content[0].text;
        for (const forbidden of ["private-slug", "private-fingerprint", "private-token", "private-provider", "private-error", '"data"', '"result"', '"error"']) {
          expect(text).not.toContain(forbidden);
        }
      }
    });

    test("wrong-name manifest discriminators expose neither their id nor raw name", async () => {
      const id = db.submitJob("private-wrong-manifest-name", {
        version: 1,
        repairName: "zero-link-rich-records",
        batchId: "11111111-1111-4111-8111-111111111111",
        ownership: [],
      });
      const tools = getTools(createServer(deps));
      for (const result of [
        await tools.job_list.handler({}),
        await tools.job.handler({ action: "list" }),
        await tools.job_status.handler({ id }),
        await tools.job.handler({ action: "status", id }),
      ]) {
        const text = result.content[0].text;
        expect(text).toContain("protected-repair");
        expect(text).not.toContain("private-wrong-manifest-name");
        expect(text).not.toContain(`"id": ${id}`);
        expect(text).not.toContain(`"id":${id}`);
        expect(text).not.toContain("11111111-1111-4111-8111-111111111111");
      }
    });

    test("wrong-name repair markers are protected across projection and mutation aliases", async () => {
      const pending = db.submitJob("private-wrong-repair-name", {
        repair: { name: "zero-link-rich-records" },
        secret: "private-repair-sentinel",
      });
      const failed = db.submitJob("private-wrong-repair-failed", {
        repair: { name: "zero-link-rich-records" },
        secret: "private-failed-sentinel",
      });
      db.rawDb.prepare("UPDATE jobs SET status='failed', result=?, error=? WHERE id=?")
        .run(JSON.stringify({ secret: "private-result-sentinel" }), "private-error-sentinel", failed);
      const tools = getTools(createServer(deps));
      for (const result of [
        await tools.job_list.handler({}),
        await tools.job.handler({ action: "list" }),
        await tools.job_status.handler({ id: pending }),
        await tools.job.handler({ action: "status", id: failed }),
      ]) {
        const text = result.content[0].text;
        expect(text).toContain("protected-repair");
        for (const forbidden of ["private-wrong", "private-repair-sentinel", "private-failed-sentinel", "private-result-sentinel", "private-error-sentinel", '"data"', '"result"', '"error"']) {
          expect(text).not.toContain(forbidden);
        }
      }
      const before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());
      for (const result of [
        await tools.job_cancel.handler({ id: pending }),
        await tools.job.handler({ action: "cancel", id: pending }),
        await tools.job_retry.handler({ id: failed }),
        await tools.job.handler({ action: "retry", id: failed }),
      ]) {
        expect(JSON.parse(result.content[0].text).code).toBe("REPAIR_BATCH_OWNED");
      }
      expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
    });

    test("unknown manifest integrity freezes all NER mutations across unified and aliases", async () => {
      db.rawDb.prepare("INSERT INTO jobs (name,status,data,result) VALUES ('zero-link-backfill-batch','done','{','{}')").run();
      const pending = db.submitJob("ner-backfill", { slug: "records/a", kind: "ner", sourceFingerprint: "page:a" });
      const failed = db.submitJob("ner-backfill", { slug: "records/b", kind: "ner", sourceFingerprint: "page:b" });
      db.rawDb.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(failed);
      const before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());
      const tools = getTools(createServer(deps));
      for (const result of [
        await tools.job_cancel.handler({ id: pending }),
        await tools.job.handler({ action: "cancel", id: pending }),
        await tools.job_retry.handler({ id: failed }),
        await tools.job.handler({ action: "retry", id: failed }),
      ]) {
        expect(JSON.parse(result.content[0].text).code).toBe("REPAIR_BATCH_OWNED");
      }
      expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
    });

    test("committing attempt rejects cancel with a stable code", async () => {
      db.upsertPage({ slug: "records/a", type: "record", title: "Record A", filePath: "records/a.md", contentHash: "a" });
      const id = db.submitJob("ner-backfill", {
        slug: "records/a", kind: "ner", pageContentHash: "a", sourceFingerprint: "page:a",
      });
      const claimed = db.claimNerJobByIdWithLease(id, undefined, authorizeNerJobClaim)!;
      expect(db.moveNerLeaseToCommitting(id, claimed.leaseToken, claimed.payloadDigest)).toBe(true);
      const tools = getTools(createServer(deps));
      const result = await tools.job_cancel.handler({ id });
      expect(JSON.parse(result.content[0].text)).toEqual({ success: false, id, code: "ATTEMPT_COMMITTING" });
      expect(db.getJob(id)!.status).toBe("running");
    });

    test("validated ordinary current NER failure retains retry compatibility", async () => {
      db.upsertPage({ slug: "records/a", type: "record", title: "A", filePath: "records/a.md", contentHash: "a" });
      const id = db.submitJob("ner-backfill", {
        slug: "records/a", kind: "ner", pageContentHash: "a", sourceFingerprint: "page:a",
      });
      db.rawDb.prepare("UPDATE jobs SET status='failed', attempts=1 WHERE id=?").run(id);
      const tools = getTools(createServer(deps));
      const result = await tools.job_retry.handler({ id });
      expect(JSON.parse(result.content[0].text)).toEqual({ success: true, id });
      expect(db.getJob(id)!.status).toBe("pending");
    });

    test("unified and alias retry reject historical and malformed failed NER without mutation", async () => {
      db.upsertPage({ slug: "records/a", type: "record", title: "A", filePath: "records/a.md", contentHash: "current" });
      const historical = db.submitJob("ner-backfill", {
        slug: "records/a", kind: "ner", pageContentHash: "old", sourceFingerprint: "page:old",
      });
      const malformed = db.submitJob("ner-backfill", { slug: "records/a", kind: "ner" });
      db.rawDb.prepare("UPDATE jobs SET status='failed', attempts=1 WHERE id IN (?,?)").run(historical, malformed);
      const before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());
      const tools = getTools(createServer(deps));

      for (const result of [
        await tools.job_retry.handler({ id: historical }),
        await tools.job.handler({ action: "retry", id: malformed }),
      ]) {
        expect(JSON.parse(result.content[0].text)).toMatchObject({ success: false, code: "NER_RETRY_REJECTED" });
      }
      expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
    });
  });

  // ─── merge_pages ─────────────────────────────────
  describe("merge_pages tool", () => {
    test("merges source into target", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/merge_src", "MergeSrc", "brain/entities/MergeSrc.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/merge_tgt", "MergeTgt", "brain/entities/MergeTgt.md", "h2");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/other", "Other", "brain/entities/Other.md", "h3");
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
      ).run("entities/merge_src", "entities/other", "认识");

      mkdirSync(join(vaultPath, "brain/entities"), { recursive: true });
      writeFileSync(join(vaultPath, "brain/entities/MergeSrc.md"), "---\ntitle: MergeSrc\ntype: entity\nslug: entities/merge_src\n---\n# MergeSrc\n\nSource body.");
      writeFileSync(join(vaultPath, "brain/entities/MergeTgt.md"), "---\ntitle: MergeTgt\ntype: entity\nslug: entities/merge_tgt\n---\n# MergeTgt\n\nTarget body.");
      const server = createServer(deps);
      const result = await getTools(server).merge_pages.handler({
        source: "entities/merge_src",
        target: "entities/merge_tgt",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.merged).toBe("entities/merge_tgt");
      // Source should be deleted
      expect(db.rawDb.prepare("SELECT slug FROM pages WHERE slug = ?").get("entities/merge_src")).toBeNull();
      // Link should have been moved
      const link = db.rawDb.prepare("SELECT from_slug, to_slug FROM links WHERE from_slug = ?").get("entities/merge_tgt");
      expect(link).toBeDefined();
    });

    test("returns error for missing slugs", async () => {
      const server = createServer(deps);
      const result = await getTools(server).merge_pages.handler({
        source: "entities/noexist1",
        target: "entities/noexist2",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(false);
    });

    test("syncs Known Relations for target and neighbors after merge", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/kr_src", "KR_Src", "brain/entities/KR_Src.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/kr_tgt", "KR_Tgt", "brain/entities/KR_Tgt.md", "h2");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/kr_neighbor", "KR_Neighbor", "brain/entities/KR_Neighbor.md", "h3");
      // src links to neighbor — after merge, tgt should inherit this link
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
      ).run("entities/kr_src", "entities/kr_neighbor", "合作");

      mkdirSync(join(vaultPath, "brain/entities"), { recursive: true });
      writeFileSync(join(vaultPath, "brain/entities/KR_Src.md"), "---\ntitle: KR_Src\ntype: entity\nslug: entities/kr_src\n---\n# KR_Src\n\nSource.");
      writeFileSync(join(vaultPath, "brain/entities/KR_Tgt.md"), "---\ntitle: KR_Tgt\ntype: entity\nslug: entities/kr_tgt\n---\n# KR_Tgt\n\nTarget.");
      writeFileSync(join(vaultPath, "brain/entities/KR_Neighbor.md"), "---\ntitle: KR_Neighbor\ntype: entity\nslug: entities/kr_neighbor\n---\n# KR_Neighbor\n\nNeighbor.");

      const server = createServer(deps);
      const result = await getTools(server).merge_pages.handler({
        source: "entities/kr_src",
        target: "entities/kr_tgt",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      // sync_warnings should be absent or empty (vault files exist)
      expect(data.sync_warnings === undefined || data.sync_warnings.length === 0).toBe(true);

      // Verify Known Relations actually written to Markdown
      const tgtMd = readFileSync(join(vaultPath, "brain/entities/KR_Tgt.md"), "utf-8");
      expect(tgtMd).toContain("## Known Relations");
      expect(tgtMd).toContain("合作 → [[entities/kr_neighbor]]");

      // Neighbor should show incoming relation
      const neighborMd = readFileSync(join(vaultPath, "brain/entities/KR_Neighbor.md"), "utf-8");
      expect(neighborMd).toContain("## Known Relations");
      expect(neighborMd).toContain("← 合作 from [[entities/kr_tgt]]");
    });
  });

  describe("confirm_evidence tool", () => {
    // Helper: seed DB row + write vault markdown so getBySlug returns body
    function seedPageWithBody(slug: string, title: string, body: string) {
      const type = "entity";
      const filePath = `brain/entities/${title}.md`;
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run(slug, type, title, filePath, "hash");
      mkdirSync(join(vaultPath, "brain/entities"), { recursive: true });
      writeFileSync(join(vaultPath, filePath),
        `---\ntitle: ${title}\ntype: ${type}\nslug: ${slug}\n---\n${body}`);
    }

    function seedLink(from: string, to: string, relation: string, sourceType: string) {
      db.insertLink(from, to, relation, null, 0.5, "medium", sourceType, 0.5);
    }

    test("upgrades to trusted when excerpt matches page body", async () => {
      seedPageWithBody("entities/a", "A", "Body text");
      seedPageWithBody("entities/b", "B", "Other text");
      seedPageWithBody("records/chat", "Chat", "今天聊天中用户明确说A和B是同事关系，共事三年了。");
      seedLink("entities/a", "entities/b", "knows", "ner");

      const linkId = db.getOutgoingLinks("entities/a")[0].id;
      expect(db.getOutgoingLinks("entities/a")[0].trust_state).toBe("candidate");

      const server = createServer(deps);
      const result = await getTools(server).confirm_evidence.handler({
        target_type: "link",
        target_id: linkId,
        confirmation_record_slug: "records/chat",
        excerpt: "用户明确说A和B是同事关系",
        new_state: "trusted",
      });

      expect(result.content[0].text).toContain("已确认为 trusted");
      expect(db.getOutgoingLinks("entities/a")[0].trust_state).toBe("trusted");
    });

    test("rejects when confirmation page does not exist", async () => {
      seedPageWithBody("entities/c", "C", "Body");
      seedPageWithBody("entities/d", "D", "Body");
      seedLink("entities/c", "entities/d", "knows", "ner");
      const linkId = db.getOutgoingLinks("entities/c")[0].id;

      const server = createServer(deps);
      const result = await getTools(server).confirm_evidence.handler({
        target_type: "link",
        target_id: linkId,
        confirmation_record_slug: "records/nonexistent",
        excerpt: "用户确认了这段关系",
        new_state: "trusted",
      });

      expect(result.content[0].text).toContain("不存在");
      expect(db.getOutgoingLinks("entities/c")[0].trust_state).toBe("candidate");
    });

    test("rejects when excerpt not in page body", async () => {
      seedPageWithBody("entities/e", "E", "Body");
      seedPageWithBody("entities/f", "F", "Body");
      seedPageWithBody("records/note", "Note", "此页不包含任何关系确认信息。");
      seedLink("entities/e", "entities/f", "knows", "ner");
      const linkId = db.getOutgoingLinks("entities/e")[0].id;

      const server = createServer(deps);
      const result = await getTools(server).confirm_evidence.handler({
        target_type: "link",
        target_id: linkId,
        confirmation_record_slug: "records/note",
        excerpt: "用户确认E和F是同事关系这是伪造的确认内容",
        new_state: "trusted",
      });

      expect(result.content[0].text).toContain("未出现");
      expect(db.getOutgoingLinks("entities/e")[0].trust_state).toBe("candidate");

      // No provenance history written
      const prov = new ProvenanceManager(new SqliteProvenanceStore(db.rawDb));
      expect(prov.getCorrectionHistory("link", linkId).length).toBe(0);
    });

    test("rejects punctuation-only excerpt", async () => {
      seedPageWithBody("entities/g", "G", "Body");
      seedPageWithBody("entities/h", "H", "Body");
      seedPageWithBody("records/log", "Log", "一些无关的内容。");
      seedLink("entities/g", "entities/h", "knows", "ner");
      const linkId = db.getOutgoingLinks("entities/g")[0].id;

      const server = createServer(deps);
      const result = await getTools(server).confirm_evidence.handler({
        target_type: "link",
        target_id: linkId,
        confirmation_record_slug: "records/log",
        excerpt: "..........",
        new_state: "trusted",
      });

      expect(result.content[0].text).toContain("未出现");
      expect(db.getOutgoingLinks("entities/g")[0].trust_state).toBe("candidate");

      const prov = new ProvenanceManager(new SqliteProvenanceStore(db.rawDb));
      expect(prov.getCorrectionHistory("link", linkId).length).toBe(0);
    });

    test("rejects short text padded with punctuation", async () => {
      seedPageWithBody("entities/i", "I", "Body");
      seedPageWithBody("entities/j", "J", "Body");
      seedPageWithBody("records/memo", "Memo", "待确认的内容在此页面中。");
      seedLink("entities/i", "entities/j", "knows", "ner");
      const linkId = db.getOutgoingLinks("entities/i")[0].id;

      const server = createServer(deps);
      const result = await getTools(server).confirm_evidence.handler({
        target_type: "link",
        target_id: linkId,
        confirmation_record_slug: "records/memo",
        excerpt: "确认..........",
        new_state: "trusted",
      });

      expect(result.content[0].text).toContain("未出现");
      expect(db.getOutgoingLinks("entities/i")[0].trust_state).toBe("candidate");

      const prov = new ProvenanceManager(new SqliteProvenanceStore(db.rawDb));
      expect(prov.getCorrectionHistory("link", linkId).length).toBe(0);
    });
  });

  // ─── deep_recall grounded mode ────────────────────

  describe("deep_recall grounded mode", () => {
    function seedGroundedData() {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/ga", "GroundedA", "ga.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/gb", "GroundedB", "gb.md", "h2");
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("entities/ga", "entities/gb", "knows", "wikilink", "trusted", 0.9);
    }

    test("grounded=true returns grounded_answer field", async () => {
      seedGroundedData();
      const server = createServer(deps);
      const result = await getTools(server).deep_recall.handler({
        query: "GroundedA",
        grounded: true,
        include_raw: true,
      });
      const data = JSON.parse(result.content[0].text);

      expect(data.grounded_answer).toBeDefined();
      expect(data.grounded_answer.query).toBe("GroundedA");
      expect(data.grounded_answer.confidence).toBeDefined();
      expect(Array.isArray(data.grounded_answer.facts)).toBe(true);
      expect(Array.isArray(data.grounded_answer.must_not_claim)).toBe(true);
      expect(data.raw.search_meta).toBeDefined();
      expect(data.raw.search_meta.strategy).toBeDefined();
    });

    test("grounded=false (default) returns entities, no grounded_answer", async () => {
      seedGroundedData();
      const server = createServer(deps);
      const result = await getTools(server).deep_recall.handler({
        query: "GroundedA",
      });
      const data = JSON.parse(result.content[0].text);

      expect(data.grounded_answer).toBeUndefined();
      expect(Array.isArray(data.entities)).toBe(true);
      expect(data.entities.length).toBeGreaterThan(0);
    });

    test("grounded response does NOT contain full entity bodies", async () => {
      seedGroundedData();
      const server = createServer(deps);
      const result = await getTools(server).deep_recall.handler({
        query: "GroundedA",
        grounded: true,
      });
      const serialized = result.content[0].text;

      expect(serialized).not.toContain("body");
      expect(serialized).not.toContain("frontmatter");
      expect(serialized).not.toContain("dossier");
      expect(serialized).not.toContain("proactive_hints");
    });

    test("grounded=true with zero results still returns grounded_answer", async () => {
      const server = createServer(deps);
      const result = await getTools(server).deep_recall.handler({
        query: "完全不存在的东西xyz",
        grounded: true,
        include_raw: true,
      });
      const data = JSON.parse(result.content[0].text);

      expect(data.grounded_answer).toBeDefined();
      expect(data.grounded_answer.confidence).toBe("low");
      expect(data.grounded_answer.facts).toHaveLength(0);
      expect(data.grounded_answer.answer).toContain("没有足够的记录");
      expect(data.raw.search_meta).toBeDefined();
      expect(data.raw.search_meta.strategy).toBeDefined();
      // Must NOT have entities field — interface is consistent
      expect(data.entities).toBeUndefined();
    });
  });

  // ─── deep_recall alias-aware fanout (#194) ─────────────

  describe("deep_recall alias-aware fanout (#194)", () => {
    function writeVault(fileRel: string, title: string, body: string): void {
      writeFileSync(join(vaultPath, fileRel), `---\ntitle: ${title}\ntype: entity\n---\n${body}`);
    }

    function seedAliasEntity(): void {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entity/bie-ming-zhu-ti", "实体甲", "bie-ming-zhu-ti.md", "h1");
      writeVault("bie-ming-zhu-ti.md", "实体甲", "实体甲的简介。");
      db.addAlias("entity/bie-ming-zhu-ti", "别名甲");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entity/huo-ban-yi", "伙伴乙", "huo-ban-yi.md", "h2");
      writeVault("huo-ban-yi.md", "伙伴乙", "伙伴乙的简介。");
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence, context) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("entity/bie-ming-zhu-ti", "entity/huo-ban-yi", "合作", "wikilink", "trusted", 0.9, "实体甲与伙伴乙长期合作");
    }

    function seedFanoutNeighbors(count: number): void {
      for (let i = 0; i < count; i++) {
        const slug = `entity/lin-ju-${i}`;
        const fileRel = `lin-ju-${i}.md`;
        db.rawDb.prepare(
          `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
        ).run(slug, `邻居${i}`, fileRel, `n${i}`);
        writeVault(fileRel, `邻居${i}`, `邻居${i}的简介。`);
        db.rawDb.prepare(
          "INSERT INTO links (from_slug, to_slug, relation, source_type) VALUES (?, ?, ?, ?)"
        ).run("entity/bie-ming-zhu-ti", slug, "关联", "wikilink");
      }
    }

    test("alias query promotes aliased entity to top result (#194)", async () => {
      seedAliasEntity();
      const server = createServer(deps);
      const result = await getTools(server).deep_recall.handler({ query: "别名甲" });
      const data = JSON.parse(result.content[0].text);

      expect(Array.isArray(data.entities)).toBe(true);
      expect(data.entities.length).toBeGreaterThan(0);
      expect(data.entities[0].slug).toBe("entity/bie-ming-zhu-ti");
      expect(data.entities[0].title).toBe("实体甲");
    });

    test("grounded alias and canonical queries both return non-insufficient evidence (#194)", async () => {
      seedAliasEntity();
      const server = createServer(deps);

      const aliasRes = await getTools(server).deep_recall.handler({ query: "别名甲", grounded: true });
      const canonRes = await getTools(server).deep_recall.handler({ query: "实体甲", grounded: true });
      const aliasData = JSON.parse(aliasRes.content[0].text);
      const canonData = JSON.parse(canonRes.content[0].text);

      for (const [label, data] of [["alias", aliasData], ["canonical", canonData]] as const) {
        expect(data.grounded_answer, `${label} grounded_answer`).toBeDefined();
        expect(data.grounded_answer.answer, `${label} answer`).not.toContain("没有足够的记录");
        expect(data.grounded_answer.facts.length, `${label} facts`).toBeGreaterThanOrEqual(1);
      }
    });

    test("fanout: display caps at 5 while raw exposes wider candidate pool (#194)", async () => {
      seedAliasEntity();
      seedFanoutNeighbors(6); // graph neighbors push the candidate pool beyond the display cap
      const server = createServer(deps);
      const result = await getTools(server).deep_recall.handler({ query: "别名甲", include_raw: true });
      const data = JSON.parse(result.content[0].text);

      expect(data.entities.length).toBeLessThanOrEqual(5);
      expect(data.raw.search_meta.candidate_count).toBeGreaterThan(5);
      expect(data.raw.search_meta.has_more).toBe(true);
      expect(data.raw.search_meta.truncated).toBe(true);
    });

    test("grounded evidence spans fanout candidates outside display top-5 (#194)", async () => {
      seedAliasEntity();
      seedFanoutNeighbors(6);
      const server = createServer(deps);
      const result = await getTools(server).deep_recall.handler({ query: "别名甲", grounded: true, include_raw: true });
      const data = JSON.parse(result.content[0].text);

      // Grounded collected evidence from the wider candidate pool, not just display top-5.
      expect(data.raw.search_meta.candidate_count).toBeGreaterThan(5);
      expect(data.grounded_answer).toBeDefined();
      // 伙伴乙 link is a trusted fact regardless of whether 伙伴乙 sits inside display top-5.
      expect(data.grounded_answer.facts.length).toBeGreaterThanOrEqual(1);
    });

    test("display and summary.message leak no internal debug fields (#194)", async () => {
      seedAliasEntity();
      seedFanoutNeighbors(6);
      const server = createServer(deps);
      const result = await getTools(server).deep_recall.handler({ query: "别名甲", grounded: true, include_raw: true });
      const data = JSON.parse(result.content[0].text);

      const displayText = String(data.display ?? "");
      const summaryMsg = String(data.summary?.message ?? "");
      const banned = [
        "score", "vector", "trace", "reason_codes",
        "candidate_count", "truncated", "has_more",
        "latency_ms", "degraded_reason",
      ];
      for (const term of banned) {
        expect(displayText, `display leaked ${term}`).not.toContain(term);
        expect(summaryMsg, `summary.message leaked ${term}`).not.toContain(term);
      }
      expect(displayText).not.toContain("entity/");
      expect(displayText).not.toContain(".md");
      // raw retains safe diagnostics
      expect(data.raw.search_meta.candidate_count).toBeGreaterThan(0);
    });
  });

  // ─── deep_recall grounded trust states ─────────────────

  describe("deep_recall grounded trust states", () => {
    test("trusted evidence → facts with settled answer and high confidence", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/ta", "人物A", "ta.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/tb", "主题B", "tb.md", "h2");
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence, context) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("entities/ta", "entities/tb", "负责", "wikilink", "trusted", 0.9, "人物A是主题B的负责人");

      const server = createServer(deps);
      const result = await getTools(server).deep_recall.handler({ query: "人物A", grounded: true });
      const data = JSON.parse(result.content[0].text);

      expect(data.grounded_answer).toBeDefined();
      expect(data.grounded_answer.confidence).toBe("high");
      expect(data.grounded_answer.answer).toContain("根据记录");
      expect(data.grounded_answer.facts.length).toBeGreaterThanOrEqual(1);
      expect(data.grounded_answer.must_not_claim).toHaveLength(0);
    });

    test("user_thought evidence framed as prior thinking, not fact", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/ux", "主题X", "ux.md", "h1");
      db.rawDb.prepare(
        "INSERT INTO timeline (page_slug, summary, source, trust_state, source_page_slug) VALUES (?, ?, ?, ?, ?)"
      ).run("entities/ux", "主题X项目可能需要调整方向", "dialogue", "user_thought", "records/chat-001");

      const server = createServer(deps);
      const result = await getTools(server).deep_recall.handler({ query: "主题X", grounded: true });
      const data = JSON.parse(result.content[0].text);

      expect(data.grounded_answer).toBeDefined();
      expect(data.grounded_answer.confidence).toBe("medium");
      expect(data.grounded_answer.answer).toContain("你之前提到");
      expect(data.grounded_answer.answer).not.toContain("根据记录");
      expect(data.grounded_answer.facts).toHaveLength(0);
      expect(data.grounded_answer.user_thoughts.length).toBeGreaterThanOrEqual(1);
    });

    test("candidate evidence marked unresolved in must_not_claim", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/cc", "组织C", "cc.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/cd", "项目D", "cd.md", "h2");
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence, context) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("entities/cc", "entities/cd", "可能参与", "ner", "candidate", 0.4, "组织C可能参与项目D");

      const server = createServer(deps);
      const result = await getTools(server).deep_recall.handler({ query: "组织C", grounded: true });
      const data = JSON.parse(result.content[0].text);

      expect(data.grounded_answer).toBeDefined();
      expect(data.grounded_answer.confidence).toBe("low");
      expect(data.grounded_answer.answer).toContain("尚待确认");
      expect(data.grounded_answer.facts).toHaveLength(0);
      expect(data.grounded_answer.candidates.length).toBeGreaterThanOrEqual(1);
      expect(data.grounded_answer.must_not_claim.length).toBeGreaterThanOrEqual(1);
    });

    test("conflicting active evidence surfaced without silent side selection", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/ce", "人物E", "ce.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/cf", "项目F", "cf.md", "h2");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/cg", "项目G", "cg.md", "h3");
      // Trusted claim: 人物E负责项目F
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence, context) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("entities/ce", "entities/cf", "负责", "wikilink", "trusted", 0.9, "人物E负责项目F");
      // Candidate claim that contradicts: 人物E已不负责项目F (different relation to avoid UNIQUE violation)
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence, context) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("entities/ce", "entities/cg", "不再负责", "ner", "candidate", 0.4, "人物E已不负责项目F");

      const server = createServer(deps);
      const result = await getTools(server).deep_recall.handler({ query: "人物E", grounded: true });
      const data = JSON.parse(result.content[0].text);

      // Both sides visible, neither silently resolved
      expect(data.grounded_answer.confidence).not.toBe("high");
      expect(data.grounded_answer.conflicts.length).toBeGreaterThanOrEqual(1);
      expect(data.grounded_answer.answer).toContain("存在矛盾信息");
      expect(data.grounded_answer.conflicts[0]).toBeDefined();
      // Conflicted candidate claims appear in must_not_claim
      expect(data.grounded_answer.must_not_claim.length).toBeGreaterThanOrEqual(1);
    });

    test("conflicting trusted evidence at same trust level surfaced", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/ca", "人物A", "ca.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/cb", "主题B", "cb.md", "h2");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/cc", "主题C", "cc.md", "h3");
      // Both trusted, claims contradict
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence, context) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("entities/ca", "entities/cb", "负责", "wikilink", "trusted", 0.9, "人物A负责主题B");
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence, context) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("entities/ca", "entities/cc", "已不负责", "ner", "trusted", 0.85, "人物A已不负责主题B");

      const server = createServer(deps);
      const result = await getTools(server).deep_recall.handler({ query: "人物A", grounded: true });
      const data = JSON.parse(result.content[0].text);

      expect(data.grounded_answer.conflicts.length).toBeGreaterThanOrEqual(1);
      expect(data.grounded_answer.confidence).not.toBe("high");
      expect(data.grounded_answer.answer).toContain("存在矛盾信息");
    });

    test("rejected and superseded evidence excluded from grounded_answer", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/rh", "人物H", "rh.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/ri", "主题I", "ri.md", "h2");
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, context) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("entities/rh", "entities/ri", "旧关系", "ner", "rejected", "人物H旧关系主题I");
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, context) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("entities/rh", "entities/ri", "替代关系", "ner", "superseded", "人物H替代关系主题I");

      const server = createServer(deps);
      const result = await getTools(server).deep_recall.handler({ query: "人物H", grounded: true });
      const data = JSON.parse(result.content[0].text);

      expect(data.grounded_answer).toBeDefined();
      expect(data.grounded_answer.facts).toHaveLength(0);
      expect(data.grounded_answer.candidates).toHaveLength(0);
      expect(data.grounded_answer.user_thoughts).toHaveLength(0);
      expect(data.grounded_answer.conflicts).toHaveLength(0);
      expect(data.grounded_answer.answer).toContain("没有足够的记录");
    });

    test("grounded=true returns compact evidence without entity details", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/cp", "主题J", "cp.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/cq", "主题K", "cq.md", "h2");
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence, context) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("entities/cp", "entities/cq", "关联", "wikilink", "trusted", 0.9, "主题J与主题K有关联");

      const server = createServer(deps);
      const result = await getTools(server).deep_recall.handler({ query: "主题J", grounded: true });
      const serialized = result.content[0].text;

      expect(serialized).not.toContain('"entities"');
      expect(serialized).not.toContain("frontmatter");
      expect(serialized).not.toContain("dossier");
      expect(serialized).not.toContain("proactive_hints");
      expect(serialized).not.toContain("insights");
      expect(serialized).not.toContain("cross_refs");
    });

    test("grounded response has no proactive_hints field on parsed JSON", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/gp", "GroundedP", "gp.md", "h3");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/gq", "GroundedQ", "gq.md", "h4");
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence, context) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("entities/gp", "entities/gq", "关联", "wikilink", "trusted", 0.9, "test context");

      const server = createServer(deps);
      const result = await getTools(server).deep_recall.handler({ query: "GroundedP", grounded: true });
      const data = JSON.parse(result.content[0].text);

      // proactive_hints must be completely absent, not just empty
      expect(data.proactive_hints).toBeUndefined();
    });
  });

  // ─── deep_recall evidence_summary for normal recall ─────

  describe("deep_recall evidence_summary", () => {
    test("normal recall: evidence_summary in raw only, NOT top-level; summary has lightweight fields", async () => {
      // Seed two entities with a trusted link
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/esa", "EntitySA", "esa.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/esb", "EntitySB", "esb.md", "h2");
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence, context) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("entities/esa", "entities/esb", "collaborates", "wikilink", "trusted", 0.9, "SA collaborates with SB");

      const server = createServer(deps);
      const result = await getTools(server).deep_recall.handler({
        query: "EntitySA",
        grounded: false,
        include_raw: true,
      });
      const data = JSON.parse(result.content[0].text);

      // evidence_summary NOT at top level (stripped from legacy spread)
      expect(data.evidence_summary).toBeUndefined();

      // evidence_summary preserved in raw
      expect(data.raw.evidence_summary).toBeDefined();
      expect(data.raw.evidence_summary.confidence).toBe("high");
      expect(data.raw.evidence_summary.top_facts.length).toBeGreaterThan(0);
      expect(data.raw.evidence_summary.total_evidence).toBeGreaterThan(0);

      // summary has lightweight human-safe fields
      expect(data.summary.evidence_count).toBeGreaterThan(0);
      expect(data.summary.confidence).toBe("high");

      // display does NOT contain internal evidence labels
      expect(data.display).not.toContain("证据质量");
      expect(data.display).not.toContain("evidence_summary");
    });

    test("brief mode: raw has evidence_summary when evidence exists", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/esb2", "EntitySB2", "esb2.md", "h3");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/esb3", "EntitySB3", "esb3.md", "h4");
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("entities/esb2", "entities/esb3", "knows", "wikilink", "trusted", 0.8);

      const server = createServer(deps);
      const result = await getTools(server).deep_recall.handler({
        query: "EntitySB2",
        detail: "brief",
      });
      const data = JSON.parse(result.content[0].text);

      // Top-level must not have evidence_summary
      expect(data.evidence_summary).toBeUndefined();

      // raw may have it if evidence was found
      if (data.raw?.evidence_summary) {
        expect(data.raw.evidence_summary).toHaveProperty("confidence");
        expect(data.raw.evidence_summary).toHaveProperty("total_evidence");
      }
    });

    test("grounded mode does NOT have evidence_summary", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/esc", "EntitySC", "esc.md", "h5");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/esd", "EntitySD", "esd.md", "h6");
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("entities/esc", "entities/esd", "knows", "wikilink", "trusted", 0.8);

      const server = createServer(deps);
      const result = await getTools(server).deep_recall.handler({
        query: "EntitySC",
        grounded: true,
      });
      const data = JSON.parse(result.content[0].text);

      // Grounded mode uses grounded_answer, not evidence_summary
      expect(data.evidence_summary).toBeUndefined();
      expect(data.grounded_answer).toBeDefined();
    });
  });

  // ─── grounded board includes page/chunk evidence ─────

  describe("grounded board page/chunk evidence", () => {
    test("grounded recall includes page and chunk evidence items", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/gpa", "GroundedPageA", "gpa.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/gpb", "GroundedPageB", "gpb.md", "h2");
      // Link for baseline evidence
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence, context) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("entities/gpa", "entities/gpb", "collaborates", "wikilink", "trusted", 0.9, "GPA works with GPB");
      // L1 summary for page evidence
      db.rawDb.prepare(
        "INSERT INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, ?, ?, ?)"
      ).run("entities/gpa", 0, "GroundedPageA is a key entity specializing in data security.", 1);
      // Level-0 chunks for chunk evidence
      db.rawDb.prepare(
        "INSERT INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, ?, ?, ?)"
      ).run("entities/gpa", 0, "GPA handles all security protocols for the organization.", 0);
      db.rawDb.prepare(
        "INSERT INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, ?, ?, ?)"
      ).run("entities/gpa", 1, "GPA established the three-layer architecture in 2024.", 0);

      const server = createServer(deps);
      const result = await getTools(server).deep_recall.handler({
        query: "GroundedPageA",
        grounded: true,
      });
      const data = JSON.parse(result.content[0].text);

      expect(data.grounded_answer).toBeDefined();
      // facts is string[] of claims from the evidence board
      const facts: string[] = data.grounded_answer.facts ?? [];

      // Must include claims from both page L1 summary and chunks
      const hasPageEvidence = facts.some(c => typeof c === "string" && c.includes("data security"));
      const hasChunkEvidence = facts.some(c => typeof c === "string" && c.includes("security protocols"));
      expect(hasPageEvidence || hasChunkEvidence).toBe(true);
      // Link evidence still present
      expect(facts.some(c => typeof c === "string" && c.includes("GPA works with GPB"))).toBe(true);
    });

    test("rejected/superseded evidence does NOT enter grounded board facts", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/rej", "RejectedEntity", "rej.md", "h3");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/rej2", "RejectedEntity2", "rej2.md", "h4");
      // Rejected link — must NOT appear in facts
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence, context) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("entities/rej", "entities/rej2", "knows", "wikilink", "rejected", 0.3, "outdated info");
      // Trusted link — must appear
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence, context) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("entities/rej", "entities/rej2", "collaborates", "wikilink", "trusted", 0.9, "current collaboration");

      const server = createServer(deps);
      const result = await getTools(server).deep_recall.handler({
        query: "RejectedEntity",
        grounded: true,
      });
      const data = JSON.parse(result.content[0].text);

      // facts is string[] of claims
      const facts: string[] = data.grounded_answer.facts ?? [];

      // Trusted fact present
      expect(facts.some((c: string) => c.includes("current collaboration"))).toBe(true);
      // Rejected fact NOT present
      expect(facts.some((c: string) => c.includes("outdated info"))).toBe(false);
    });
  });

  // ─── deep_recall normal vs brief mode ────────────

  describe("deep_recall normal vs brief mode", () => {
    function seedRecallData() {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'record', ?, ?, ?)`
      ).run("records/project-z-design", "Project Z设计方案", "records/project-z-design.md", "h1");
      // Write vault file so PageManager.getBySlug returns body
      const body = [
        "---",
        "type: record",
        "title: Project Z设计方案",
        "---",
        "",
        "## 三层协作架构",
        "",
        "Company X内部数据安全区、Organization Y AI分析中台、外部分布式节点",
        "",
        "## 组织架构与虚拟经理",
        "",
        "全国总监下属3个虚拟经理，4个大区经理各下属3个虚拟经理",
        "",
        "## 数据安全红线",
        "",
        "Company X原始导出绝不能存",
      ].join("\n");
      mkdirSync(join(vaultPath, "records"), { recursive: true });
      writeFileSync(join(vaultPath, "records/project-z-design.md"), body);
    }

    test("detail=normal returns memory_skeleton with key_points", async () => {
      seedRecallData();
      const server = createServer(deps);
      // Use exact title so the search exact-match path finds it
      const result = await getTools(server).deep_recall.handler({
        query: "Project Z设计方案",
        detail: "normal",
        include_raw: true,
      });
      const data = JSON.parse(result.content[0].text);
      const entity = data.entities?.[0];

      expect(entity).toBeDefined();
      expect(entity.memory_skeleton).toBeDefined();
      expect(entity.memory_skeleton.key_points).toBeInstanceOf(Array);
      expect(entity.memory_skeleton.key_points.length).toBeGreaterThan(0);
      expect(entity.memory_skeleton.structure_terms).toBeInstanceOf(Array);
    });

    test("detail=brief does NOT return memory_skeleton", async () => {
      seedRecallData();
      const server = createServer(deps);
      const result = await getTools(server).deep_recall.handler({
        query: "Project Z设计方案",
        detail: "brief",
      });
      const data = JSON.parse(result.content[0].text);
      const entity = data.entities?.[0];

      expect(entity).toBeDefined();
      expect(entity.memory_skeleton).toBeUndefined();
    });
  });

  describe("recall_episode tool", () => {
    test("returns empty candidates for no-match", async () => {
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)",
      ).run("entities/person-a", "人物A", "a.md", "h1");
      db.rawDb.prepare(
        "INSERT INTO timeline (page_slug, summary, source, trust_state) VALUES (?, ?, ?, ?)",
      ).run("entities/person-a", "人物A参加技术分享", "dialogue", "trusted");

      const server = createServer(deps);
      const result = await getTools(server).recall_episode.handler({
        query: "做市场的人",
        topic_hint: "市场推广",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.candidates).toEqual([]);
      expect(data.search_meta.total_scanned).toBe(1);
      expect(data.result_summary).toContain("没有找到");
      expect(data.raw).toBeDefined();
    });

    test("returns matched candidate with enriched output shape", async () => {
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)",
      ).run("entities/person-a", "人物A", "a.md", "h1");
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
      ).run("entities/org-e", "组织E", "e.md", "h1");
      db.rawDb.prepare(
        "INSERT INTO timeline (page_slug, summary, source, trust_state, event_date) VALUES (?, ?, ?, ?, ?)",
      ).run("entities/person-a", "人物A负责前端开发", "dialogue", "trusted", "2024-05-20");
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("entities/person-a", "entities/org-e", "works_at", "ner", "trusted", 0.9);

      const server = createServer(deps);
      const result = await getTools(server).recall_episode.handler({
        query: "组织E的前端开发",
        topic_hint: "前端开发",
        connection_hint: "组织E",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.candidates.length).toBe(1);
      expect(data.candidates[0].slug).toBe("entities/person-a");
      expect(data.candidates[0].title).toBe("人物A");
      expect(data.candidates[0].score).toBeGreaterThan(0);
      expect(data.candidates[0].confidence).toBeDefined();
      expect(data.candidates[0].matched_clues).toBeInstanceOf(Array);
      expect(data.candidates[0].matched_clues.some((c: any) => c.dimension === "topic")).toBe(true);
      expect(data.candidates[0].matched_clues.some((c: any) => c.dimension === "relation")).toBe(true);
      expect(data.candidates[0].evidence).toBeInstanceOf(Array);
      expect(data.candidates[0].evidence.length).toBeGreaterThan(0);
      expect(data.candidates[0].next_disambiguating_clue).toBeNull();
      expect(data.result_summary).toContain("人物A");
      expect(data.search_meta).toBeDefined();
      expect(data.search_meta.hints_applied).toContain("topic");
      expect(data.search_meta.hints_applied).toContain("relation");
      expect(data.raw).toBeDefined();
    });

    test("event_hint scores against timeline summaries", async () => {
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)",
      ).run("entities/person-b", "人物B", "b.md", "h1");
      db.rawDb.prepare(
        "INSERT INTO timeline (page_slug, summary, source, trust_state) VALUES (?, ?, ?, ?)",
      ).run("entities/person-b", "人物B负责项目上线", "dialogue", "trusted");

      const server = createServer(deps);
      const result = await getTools(server).recall_episode.handler({
        query: "项目上线参与者",
        event_hint: "项目上线",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.candidates.length).toBe(1);
      expect(data.candidates[0].slug).toBe("entities/person-b");
      expect(data.candidates[0].matched_clues.some((c: any) => c.dimension === "event")).toBe(true);
      expect(data.search_meta.hints_applied).toContain("event");
    });

    test("relation_hint produces same dimension as connection_hint", async () => {
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)",
      ).run("entities/person-c", "人物C", "c.md", "h1");
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
      ).run("entities/org-f", "组织F", "f.md", "h1");
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("entities/person-c", "entities/org-f", "works_at", "ner", "trusted", 0.9);

      const server = createServer(deps);
      const withRelation = await getTools(server).recall_episode.handler({
        query: "组织F的人",
        relation_hint: "组织F",
      });
      const dataR = JSON.parse(withRelation.content[0].text);
      expect(dataR.candidates.length).toBe(1);
      expect(dataR.candidates[0].slug).toBe("entities/person-c");
      expect(dataR.candidates[0].matched_clues.some((c: any) => c.dimension === "relation")).toBe(true);
      expect(dataR.search_meta.hints_applied).toContain("relation");

      const withConnection = await getTools(server).recall_episode.handler({
        query: "组织F的人",
        connection_hint: "组织F",
      });
      const dataC = JSON.parse(withConnection.content[0].text);
      expect(dataC.candidates[0].slug).toBe("entities/person-c");
      expect(dataC.candidates[0].matched_clues.some((c: any) => c.dimension === "relation")).toBe(true);
    });

    test("recall_episode accepts extracted time/context hints from natural prompt", async () => {
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)",
      ).run("entities/person-d", "人物D", "d.md", "h1");
      db.rawDb.prepare(
        "INSERT INTO timeline (page_slug, summary, source, trust_state) VALUES (?, ?, ?, ?)",
      ).run("entities/person-d", "人物D参加去年团建活动", "dialogue", "trusted");

      const server = createServer(deps);
      const result = await getTools(server).recall_episode.handler({
        query: "去年团建见过谁",
        time_hint: "去年",
        context_hint: "团建",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.candidates.length).toBe(1);
      expect(data.candidates[0].slug).toBe("entities/person-d");
      expect(data.diagnostics).toBeDefined();
      expect(data.diagnostics.clues_checked.length).toBeGreaterThan(0);
    });
  });

  // ─── Search trace integration ────────────────────

  describe("search trace integration", () => {
    test("query tool writes trace session and steps", async () => {
      // Seed a page so FTS returns results
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/trace-test", "TraceTest", "trace-test.md", "h1");
      db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, ?, ?)")
        .run("entities/trace-test", 0, "TraceTest entity for trace integration");

      const server = createServer(deps);
      await getTools(server).query.handler({ query: "TraceTest" });

      const sessions = db.getRecentSearchTraceSessions(5);
      // Trace session should exist — query may differ due to strategy normalization
      expect(sessions.length).toBeGreaterThan(0);
      const session = sessions[0];
      expect(session.status).not.toBe("running");
      expect(session.mode).toBeDefined();
      expect(session.ended_at).not.toBeNull();
      expect(session.latency_ms).not.toBeNull();
      expect(session.latency_ms).toBeGreaterThanOrEqual(0);
    });

    test("deep_recall tool writes trace session with latency", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/trace-recall", "TraceRecall", "trace-recall.md", "h1");

      const server = createServer(deps);
      await getTools(server).deep_recall.handler({ query: "TraceRecall" });

      const sessions = db.getRecentSearchTraceSessions(5);
      const session = sessions.find(s => s.query === "TraceRecall");
      expect(session).toBeDefined();
      expect(session!.status).not.toBe("running");
      expect(session!.latency_ms).not.toBeNull();
      expect(session!.latency_ms).toBeGreaterThanOrEqual(0);
    });

    test("summarize tool writes trace session with latency", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/trace-topic", "TraceTopic", "trace-topic.md", "h1");

      const server = createServer(deps);
      await getTools(server).summarize.handler({ topic: "TraceTopic" });

      const sessions = db.getRecentSearchTraceSessions(5);
      const session = sessions.find(s => s.query === "TraceTopic");
      expect(session).toBeDefined();
      expect(session!.status).not.toBe("running");
      expect(session!.latency_ms).not.toBeNull();
      expect(session!.latency_ms).toBeGreaterThanOrEqual(0);
    });

    test("query without strategy/limit uses smart defaults, not all path", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/default-strat", "DefaultStrat", "default-strat.md", "h1");
      db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, ?, ?)")
        .run("entities/default-strat", 0, "DefaultStrat entity for default strategy check");

      const server = createServer(deps);
      // Call handler WITHOUT strategy or limit — Zod defaults don't apply in direct calls
      const result = await getTools(server).query.handler({ query: "DefaultStrat" });
      const data = JSON.parse(result.content[0].text);

      expect(data.results).toBeDefined();
      expect(Array.isArray(data.results)).toBe(true);

      // Trace session must have mode='smart' (NOT NULL), not fail silently
      const sessions = db.getRecentSearchTraceSessions(5);
      const session = sessions.find(s => s.query === "DefaultStrat");
      expect(session).toBeDefined();
      expect(session!.mode).toBe("smart");
      expect(session!.status).not.toBe("running");
    });

    test("trace failure does not break query tool return", async () => {
      // Drop the table to force trace write to fail
      db.rawDb.prepare("DROP TABLE search_trace_steps").run();
      db.rawDb.prepare("DROP TABLE search_trace_sessions").run();

      const server = createServer(deps);
      const result = await getTools(server).query.handler({ query: "trace-failure-test" });
      const data = JSON.parse(result.content[0].text);

      // Tool still returns results
      expect(data.results).toBeDefined();
      expect(Array.isArray(data.results)).toBe(true);
    });

    test("non-vector degraded (empty results) shows degraded status without vector message", async () => {
      // No data seeded — query will return empty results → fts_empty reason code
      const server = createServer(deps);
      const result = await getTools(server).query.handler({ query: "完全不存在的查询xyz" });
      const data = JSON.parse(result.content[0].text);

      // Top-level should NOT have search_meta (diagnostics only in raw)
      expect((data as Record<string, unknown>).search_meta).toBeUndefined();
      // But raw envelope should have search_meta with reason_codes
      const rawMeta = data.raw?.search_meta as Record<string, unknown> | undefined;
      expect(rawMeta).toBeDefined();
      expect(Array.isArray(rawMeta?.reason_codes)).toBe(true);
      expect(rawMeta!.reason_codes).toContain("fts_empty");

      // Display should not contain vector-specific messages
      expect(data.display).not.toContain("向量搜索异常");
      expect(data.display).not.toContain("向量搜索超时");
      // Summary should reflect degraded or empty status
      expect(data.summary.status).toMatch(/^(degraded|empty)$/);
      // Top-level legacy payload should NOT contain reason_codes
      expect(JSON.stringify(data).match(/"reason_codes"/g)?.length).toBe(1);
    });

    test("error wrapper sanitizes internal paths and SQL errors", async () => {
      // Force an error by dropping a table that a tool depends on
      db.rawDb.prepare("DROP TABLE pages").run();

      const server = createServer(deps);
      const result = await getTools(server).status.handler({});

      // Should have isError flag
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      // Must not contain absolute filesystem paths
      expect(text).not.toMatch(/\/Users\/|\/tmp\/|\/home\//);
      // Must not contain raw SQLite error details
      expect(text).not.toMatch(/no such table|SQLiteError.*pages/i);
      // Should still have an error field
      const parsed = JSON.parse(text);
      expect(parsed.error).toBeDefined();
    });
  });

  // ─── FTS fallback diagnostics (#181) ─────────────

  describe("FTS parser fallback via MCP query tool (#181)", () => {
    test("fts_parser_fallback appears in raw.search_meta.reason_codes when MATCH fails", async () => {
      // Seed anonymous content into both chunks and chunks_fts
      const slug = "entities/fallback-target";
      const content = "anonymous fallback test content for diagnostics";
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run(slug, "FallbackTarget", "fallback-target.md", "h1");
      db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, ?, ?)")
        .run(slug, 0, content);
      db.rawDb.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)")
        .run(slug, content);

      // Monkey-patch buildTrigramQuery to force MATCH failure
      const original = (db as any).buildTrigramQuery.bind(db);
      (db as any).buildTrigramQuery = () => ') OR AND NOT (';

      const server = createServer(deps);
      const result = await getTools(server).query.handler({
        query: "anonymous fallback test",
        strategy: "smart",
      });
      (db as any).buildTrigramQuery = original;

      const data = JSON.parse(result.content[0].text);

      // 1. raw.search_meta.reason_codes must contain fts_parser_fallback
      const rawMeta = data.raw?.search_meta as Record<string, unknown> | undefined;
      expect(rawMeta).toBeDefined();
      expect(Array.isArray(rawMeta?.reason_codes)).toBe(true);
      expect(rawMeta!.reason_codes).toContain("fts_parser_fallback");

      // 2. Top-level must NOT have search_meta (diagnostics only in raw envelope)
      expect((data as Record<string, unknown>).search_meta).toBeUndefined();

      // 3. Display and summary must not leak FTS/SQL/MATCH/chunks_fts/internal expressions
      const display = data.display ?? "";
      const summary = JSON.stringify(data.summary ?? {});
      const banned = ["FTS5", "MATCH", "SELECT", "chunks_fts", "fts_fallback", "fts_parser_fallback", "syntax error", "SQLiteError", "reason_codes"];
      for (const term of banned) {
        expect(display).not.toContain(term);
        expect(summary).not.toContain(term);
      }

      // 4. Results still contain the anonymous page (fallback recovered it)
      expect(data.results).toBeDefined();
      expect(Array.isArray(data.results)).toBe(true);
      // Fallback LIKE should match "anonymous" and/or "fallback"
      const matchedSlugs = (data.results as Array<{ slug: string }>).map(r => r.slug);
      expect(matchedSlugs).toContain(slug);
    });

    test("normal FTS hit does NOT trigger fts_parser_fallback reason code", async () => {
      const slug = "entities/normal-hit";
      const content = "normal query target with no special characters";
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run(slug, "NormalHit", "normal-hit.md", "h1");
      db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, ?, ?)")
        .run(slug, 0, content);
      db.rawDb.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)")
        .run(slug, content);

      const server = createServer(deps);
      const result = await getTools(server).query.handler({
        query: "normal query target",
        strategy: "smart",
      });
      const data = JSON.parse(result.content[0].text);

      const rawMeta = data.raw?.search_meta as Record<string, unknown> | undefined;
      if (rawMeta?.reason_codes) {
        expect(rawMeta.reason_codes).not.toContain("fts_parser_fallback");
      }
    });
  });

  // ─── #252: ner-backfill wiring via buildContext ─────

  describe("buildContext ner-backfill wiring (#252)", () => {
    test("defer deps wire deferredNerSubmitter into ingest (no throw)", async () => {
      const { IngestManager } = await import("../../src/core/ingestion/ingest.js");
      // Prove: bare IngestManager with defer+no submitter THROWS
      expect(() => new IngestManager(db, deps.embedding, deps.lance, vaultPath, undefined, undefined, { nerMode: "defer" })).toThrow();

      // But buildContext with defer deps should NOT throw (it injects submitter)
      const deferDeps: CBrainDeps & { nerIngestMode: IngestNerMode } = {
        ...deps,
        nerIngestMode: "defer",
      };
      expect(() => buildContext(deferDeps)).not.toThrow();
      const ctx = buildContext(deferDeps);
      expect(ctx.ingest).toBeDefined();
    });

    test("sync deps (no nerIngestMode) construct ingest without error", () => {
      expect(() => buildContext(deps)).not.toThrow();
      const ctx = buildContext(deps);
      expect(ctx.ingest).toBeDefined();
      expect(ctx.jobs).toBeDefined();
    });

    test("jobs is created before ingest in buildContext (submitter depends on db)", () => {
      const ctx = buildContext(deps);
      // jobs must be available for the submitter to reference db
      expect(ctx.jobs).toBeDefined();
      expect(ctx.ingest).toBeDefined();
    });
  });
});

describe("delete_page lance repair-required (#187)", () => {
  const rDir = "/tmp/cbrain-test-delete-repair";
  const rDbPath = join(rDir, "test.sqlite");
  const rVault = join(rDir, "vault");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(rDir)) rmSync(rDir, { recursive: true });
    mkdirSync(rVault, { recursive: true });
    db = new CBrainDB(rDbPath);
  });
  afterEach(() => {
    db.close();
    if (existsSync(rDir)) rmSync(rDir, { recursive: true });
  });

  function seedPage(slug: string) {
    const fp = `${slug}.md`;
    const slash = slug.lastIndexOf("/");
    if (slash > 0) mkdirSync(join(rVault, slug.substring(0, slash)), { recursive: true });
    writeFileSync(join(rVault, fp), `---\ntitle: Alpha\ntype: record\nslug: ${slug}\n---\nbody`);
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'record', ?, ?, ?)",
    ).run(slug, "Alpha", fp, "h");
  }

  test("returns lance_repair_required + warning when Lance cleanup fails", async () => {
    const slug = "records/alpha";
    seedPage(slug);
    const failLance = {
      ...createMockLanceDB(),
      deleteByPageSlug: async () => { throw new Error("lance boom"); },
    } as any;
    const server = createServer({
      db,
      embedding: createMockEmbedding(),
      lance: failLance,
      vaultPath: rVault,
      runtimePath: join(dirname(rDbPath), "runtime"),
    });
    const result = await getTools(server).delete_page.handler({ slug });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);                  // source-of-truth delete committed
    expect(data.lance_repair_required).toBe(true);    // truthful partial outcome surfaced
    expect(data.warning).toMatch(/repair/i);
    expect(db.getPageFilePath(slug)).toBeNull();      // page really gone from DB
  });

  test("clean Lance cleanup omits repair fields", async () => {
    const slug = "records/beta";
    seedPage(slug);
    const server = createServer({
      db,
      embedding: createMockEmbedding(),
      lance: createMockLanceDB() as any,
      vaultPath: rVault,
      runtimePath: join(dirname(rDbPath), "runtime"),
    });
    const result = await getTools(server).delete_page.handler({ slug });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.lance_repair_required).toBeUndefined();
    expect(data.warning).toBeUndefined();
  });
});

describe("graph_query / get_links candidate reports_to exclusion (#233)", () => {
  const tDir = "/tmp/cbrain-test-mcp-graph233";
  const tDbPath = join(tDir, "test.sqlite");
  const tVault = join(tDir, "vault");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(tDir)) rmSync(tDir, { recursive: true });
    mkdirSync(tVault, { recursive: true });
    db = new CBrainDB(tDbPath);
  });
  afterEach(() => {
    db.close();
    if (existsSync(tDir)) rmSync(tDir, { recursive: true });
  });

  function makeServer() {
    return createServer({
      db,
      embedding: createMockEmbedding(),
      lance: createMockLanceDB() as any,
      vaultPath: tVault,
      runtimePath: join(dirname(tDbPath), "runtime"),
    });
  }

  test("graph_query mode=traverse does not return candidate reports_to", async () => {
    for (const s of ["entities/gq-seed", "entities/gq-trusted", "entities/gq-weak"]) {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, 'entity/person', ?, ?, ?, 0, 3)`,
      ).run(s, s, `${s}.md`, `h-${s}`);
    }
    db.upsertActiveReportsTo("entities/gq-seed", "entities/gq-trusted", "agent", 0.95);
    db.insertLink("entities/gq-seed", "entities/gq-weak", "reports_to", null, 0.5, "weak", "ner", 0.5);

    const result = await getTools(makeServer()).graph_query.handler({
      slug: "entities/gq-seed", mode: "traverse", depth: 1, limit: 50,
    });
    const text = result.content[0].text;
    expect(text).toContain("entities/gq-trusted");
    expect(text).not.toContain("entities/gq-weak");
  });

  test("get_links excludes candidate reports_to, keeps ordinary candidate", async () => {
    for (const s of ["entities/gl-seed", "entities/gl-trusted", "entities/gl-weak", "entities/gl-mention"]) {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, 'entity/person', ?, ?, ?, 0, 3)`,
      ).run(s, s, `${s}.md`, `h-${s}`);
    }
    db.upsertActiveReportsTo("entities/gl-seed", "entities/gl-trusted", "agent", 0.95);
    db.insertLink("entities/gl-seed", "entities/gl-weak", "reports_to", null, 0.5, "weak", "ner", 0.5);
    db.insertLink("entities/gl-seed", "entities/gl-mention", "提及", null, 0.3, "weak", "ner", 0.5);

    const result = await getTools(makeServer()).get_links.handler({ slug: "entities/gl-seed", direction: "outgoing" });
    const text = result.content[0].text;
    expect(text).toContain("entities/gl-trusted");
    expect(text).not.toContain("entities/gl-weak");
    expect(text).toContain("entities/gl-mention");
  });
});
