import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import { PageManager } from "../../src/core/page.js";
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
        "add_alias", "add_link", "add_tag", "add_timeline_entry", "append_page", "archive_insight",
        "batch_add_links", "batch_delete_pages", "batch_merge_pages",
        "brain_storm", "confirm_evidence", "deep_recall", "delete_page", "dismiss_insight",
        "dossier", "dream", "dream_reset", "enrich", "expand_entity",
        "generate_indexes", "get_chunks", "get_hierarchy", "get_ingest_log", "get_insight",
        "get_links", "get_page", "get_profile", "get_provenance", "get_tags",
        "get_timeline", "get_versions", "graph_query", "health",
        "ingest", "ingest_dialogue", "job_cancel", "job_list",
        "job_retry", "job_status", "job_submit", "list_insights",
        "list_pages", "mark_discovery_seen", "merge_pages",
        "promote_discovery", "put_page", "query", "query_insights",
        "read_discoveries", "record_feedback", "relation_audit", "reload_profile", "remove_alias",
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
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/test", "Test", "test.md", "h1");
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/a", "A", "a.md", "ha");
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/b", "B", "b.md", "hb");
      db.prepare(
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
      db.prepare(
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
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/a", "A", "a.md", "h1");
      db.prepare(
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
        db.prepare(
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
      db.prepare(
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
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
         VALUES (?, 'entity/person', ?, ?, ?, ?, ?)`
      ).run("entities/a", "A", "a.md", "h1", 2, 3);
      db.prepare(
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
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/a", "A", "a.md", "h1");
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/b", "B", "b.md", "h2");
      db.prepare(
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
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/a", "A", "a.md", "h1");
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/b", "B", "b.md", "h2");
      db.prepare(
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
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count) VALUES (?, 'entity', ?, ?, ?, ?)`
      ).run("entities/a", "A", "a.md", "h1", 0);
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count) VALUES (?, 'entity', ?, ?, ?, ?)`
      ).run("entities/b", "B", "b.md", "h2", 5);
      db.prepare(
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
  });

  describe("delete_page tool", () => {
    test("deletes a page", async () => {
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/todel", "Del", "del.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).delete_page.handler({ slug: "entities/todel" });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);

      const page = db.prepare("SELECT * FROM pages WHERE slug = ?").get("entities/todel");
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
      db.prepare(
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
      db.prepare(
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
      db.prepare(
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
      db.prepare(
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
      db.prepare(
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
  });

  // ─── Tag tools ─────────────────────────────────

  describe("get_tags tool", () => {
    test("returns tags for a page", async () => {
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/tagged", "Tagged", "tagged.md", "h1");
      db.prepare("INSERT OR IGNORE INTO tags (page_slug, tag) VALUES (?, ?)").run("entities/tagged", "ai");
      db.prepare("INSERT OR IGNORE INTO tags (page_slug, tag) VALUES (?, ?)").run("entities/tagged", "product");

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
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/t1", "T1", "t1.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).add_tag.handler({ slug: "entities/t1", tag: "new-tag" });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);

      const cnt = db.prepare("SELECT COUNT(*) as c FROM tags WHERE page_slug = ?").get("entities/t1") as { c: number };
      expect(cnt.c).toBe(1);
    });
  });

  describe("remove_tag tool", () => {
    test("removes a tag from a page", async () => {
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/t2", "T2", "t2.md", "h1");
      db.prepare("INSERT OR IGNORE INTO tags (page_slug, tag) VALUES (?, ?)").run("entities/t2", "old-tag");

      const server = createServer(deps);
      const result = await getTools(server).remove_tag.handler({ slug: "entities/t2", tag: "old-tag" });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);

      const cnt = db.prepare("SELECT COUNT(*) as c FROM tags WHERE page_slug = ?").get("entities/t2") as { c: number };
      expect(cnt.c).toBe(0);
    });
  });

  // ─── Link tools ────────────────────────────────

  describe("get_links tool", () => {
    test("returns links for a page", async () => {
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/from", "From", "from.md", "h1");
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/to", "To", "to.md", "h2");
      db.prepare(
        "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
      ).run("entities/from", "entities/to", "mentions");

      const server = createServer(deps);
      const result = await getTools(server).get_links.handler({ slug: "entities/from" });
      const data = JSON.parse(result.content[0].text);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(1);
    });

    test("returns backlinks when direction is 'to'", async () => {
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/lfrom", "LFrom", "lfrom.md", "h1");
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/lto", "LTo", "lto.md", "h2");
      db.prepare(
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
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/rl1", "RL1", "rl1.md", "h1");
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/rl2", "RL2", "rl2.md", "h2");
      db.prepare(
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
      db.prepare(
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
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/tl2", "TL2", "entities/tl2.md", "h1");
      db.prepare(
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
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/chunked", "Chunked", "chunked.md", "h1");
      db.prepare(
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
      db.prepare(
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
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/ver", "Ver", "ver.md", "h1");
      db.prepare(
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
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/rev", "Rev", "entities/rev.md", "h1");
      db.prepare(
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
      db.prepare(
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
      db.prepare(
        "INSERT INTO jobs (name, status, priority) VALUES (?, ?, ?)"
      ).run("test-job", "pending", 0);

      const server = createServer(deps);
      const result = await getTools(server).job_list.handler({});
      const data = JSON.parse(result.content[0].text);
      expect(Array.isArray(data)).toBe(true);
    });

    test("filters by status", async () => {
      db.prepare(
        "INSERT INTO jobs (name, status, priority) VALUES (?, ?, ?)"
      ).run("done-job", "done", 0);
      db.prepare(
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
      const info = db.prepare(
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
      const info = db.prepare(
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
      const info = db.prepare(
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
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/merge_src", "MergeSrc", "brain/entities/MergeSrc.md", "h1");
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/merge_tgt", "MergeTgt", "brain/entities/MergeTgt.md", "h2");
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/other", "Other", "brain/entities/Other.md", "h3");
      db.prepare(
        "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
      ).run("entities/merge_src", "entities/other", "认识");

      mkdirSync(join(vaultPath, "brain/entities"), { recursive: true });
      writeFileSync(join(vaultPath, "brain/entities/MergeSrc.md"), "---\ntitle: MergeSrc\ntype: entity\nslug: entities/merge_src\n---\n# MergeSrc\n\nSource body.");
      writeFileSync(join(vaultPath, "brain/entities/MergeTgt.md"), "---\ntitle: MergeTgt\ntype: entity\nslug: entities/merge_tgt\n---\n# MergeTgt\n\nTarget body.");
      const pageMgr = new PageManager(db, vaultPath);

      const server = createServer({ ...deps, pages: pageMgr });
      const result = await getTools(server).merge_pages.handler({
        source: "entities/merge_src",
        target: "entities/merge_tgt",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.merged).toBe("entities/merge_tgt");
      // Source should be deleted
      expect(db.prepare("SELECT slug FROM pages WHERE slug = ?").get("entities/merge_src")).toBeNull();
      // Link should have been moved
      const link = db.prepare("SELECT from_slug, to_slug FROM links WHERE from_slug = ?").get("entities/merge_tgt");
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
      db.prepare(
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
});
