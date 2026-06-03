import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import { ProvenanceManager } from "../../src/core/provenance.js";
import { SqliteProvenanceStore } from "../../src/storage/provenance-store.js";
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
        "act_on_review_candidate", "add_alias", "add_knowledge", "add_link", "add_tag", "add_timeline_entry", "agentic_research", "append_page", "archive_insight",
        "batch_add_links", "batch_delete_pages", "batch_merge_pages",
        "brain_storm", "confirm_evidence", "deep_recall", "delete_page", "dismiss_insight",
        "dossier", "dream", "dream_reset", "dream_status", "enrich", "expand_entity",
        "export_grounded_artifact",
        "generate_indexes", "get_chunks", "get_compounding_reviews", "get_hierarchy", "get_ingest_log", "get_insight",
        "get_links", "get_page", "get_profile", "get_provenance", "get_tags",
        "get_timeline", "get_versions", "graph_query", "health",
        "ingest", "ingest_dialogue", "job_cancel", "job_list",
        "job_retry", "job_status", "job_submit", "list_insights",
        "list_pages", "mark_discovery_seen", "merge_pages",
        "promote_discovery", "put_page", "query", "query_insights",
        "read_discoveries", "recall_episode", "record_feedback", "relation_audit", "reload_profile", "remove_alias",
        "remove_hierarchy", "remove_link", "remove_orphans", "remove_profile", "remove_tag",
        "resolve_slugs", "revert_version", "run_discovery", "set_hierarchy", "set_trust_state",
        "status", "summarize", "sync", "update_discovery_status", "update_profile", "watcher_quarantine", "writeback",
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
      expect(data.resolvedSlug).toBe("entities/a");
      expect(data.result.length).toBe(1);
      expect(data.result[0].slug).toBe("entities/b");
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
      expect(data.resolvedSlug).toBe("entities/a");
      expect(data.result.length).toBe(1);
      expect(data.result[0].from_slug).toBe("entities/b");
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
      expect(data.resolvedSlug).toBe("entities/a");
      expect(data.result.length).toBe(1);
      expect(data.result[0].slug).toBe("entities/b");
    });
  });

  describe("ingest tool", () => {
    test("ingests text content", async () => {
      const server = createServer(deps);
      const result = await getTools(server).ingest.handler({
        content: "Hello world",
        type: "text",
        title: "Test Page",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.slug).toBeDefined();
      expect(data.created).toBe(true);
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

    test("returns error without title for new page", async () => {
      const server = createServer(deps);
      const result = await getTools(server).put_page.handler({
        slug: "entities/new",
        content: "Content without title",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBeDefined();
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
      expect(data.overallStatus).toBeDefined();
      expect(data.dimensions).toBeDefined();
      expect(data.metrics).toBeDefined();
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
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(1);
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
      expect(Array.isArray(data)).toBe(true);
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
      expect(data.slug).toBe("entities/tl2");
      expect(Array.isArray(data.events)).toBe(true);
      expect(data.events.length).toBeGreaterThanOrEqual(1);
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
    test("returns versions for a page", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/ver", "Ver", "ver.md", "h1");
      db.rawDb.prepare(
        "INSERT INTO versions (page_slug, version, content) VALUES (?, ?, ?)"
      ).run("entities/ver", 1, "v1 content");

      const server = createServer(deps);
      const result = await getTools(server).get_versions.handler({ slug: "entities/ver" });
      const data = JSON.parse(result.content[0].text);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(1);
      expect(data[0].version).toBe(1);
    });
  });

  describe("revert_version tool", () => {
    test("reverts to a specific version", async () => {
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
      expect(data.success).toBe(true);
    });

    test("returns error for missing version", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/rev2", "Rev2", "entities/rev2.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).revert_version.handler({
        slug: "entities/rev2",
        version: 999,
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(false);
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
      });
      const data = JSON.parse(result.content[0].text);

      expect(data.grounded_answer).toBeDefined();
      expect(data.grounded_answer.query).toBe("GroundedA");
      expect(data.grounded_answer.confidence).toBeDefined();
      expect(Array.isArray(data.grounded_answer.facts)).toBe(true);
      expect(Array.isArray(data.grounded_answer.must_not_claim)).toBe(true);
      expect(data.search_meta).toBeDefined();
      expect(data.search_meta.strategy).toBeDefined();
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
      });
      const data = JSON.parse(result.content[0].text);

      expect(data.grounded_answer).toBeDefined();
      expect(data.grounded_answer.confidence).toBe("low");
      expect(data.grounded_answer.facts).toHaveLength(0);
      expect(data.grounded_answer.answer).toContain("没有足够的记录");
      expect(data.search_meta).toBeDefined();
      expect(data.search_meta.strategy).toBeDefined();
      // Must NOT have entities field — interface is consistent
      expect(data.entities).toBeUndefined();
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
      expect(data.summary).toContain("没有找到");
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
      expect(data.summary).toContain("人物A");
      expect(data.search_meta).toBeDefined();
      expect(data.search_meta.hints_applied).toContain("topic");
      expect(data.search_meta.hints_applied).toContain("relation");
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
  });
});
