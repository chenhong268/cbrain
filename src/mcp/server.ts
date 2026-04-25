import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CBrainDB } from "../storage/sqlite.js";
import { LanceDBManager } from "../storage/lancedb.js";
import { HybridSearch } from "../core/search.js";
import { SyncManager } from "../core/sync.js";
import { IngestManager } from "../core/ingest.js";
import { GraphManager } from "../core/graph.js";
import { EnrichManager } from "../core/enrich.js";
import { HealthChecker } from "../core/health.js";
import { WritebackManager } from "../core/writeback.js";
import { IndexGenerator } from "../core/indexes.js";
import { NerEngine } from "../core/ner.js";
import { PageManager } from "../core/page.js";
import { chunkContent } from "../core/shared.js";
import { VersionManager } from "../core/version.js";
import { JobQueue } from "../core/jobs.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import type { LLMProvider } from "../llm/provider.js";

export interface CBrainDeps {
  db: CBrainDB;
  embedding: EmbeddingProvider;
  lance: LanceDBManager;
  vaultPath: string;
  llm?: LLMProvider;
}

export function createServer(deps: CBrainDeps): McpServer {
  const { db, embedding, lance, vaultPath, llm } = deps;

  const search = new HybridSearch(db, embedding, lance, { llm });
  const pages = new PageManager(db, vaultPath);
  const nerEngine = llm ? new NerEngine(llm) : undefined;
  const sync = new SyncManager(db, embedding, lance, { nerEngine, pages });
  const ingest = new IngestManager(db, embedding, lance, vaultPath, llm);
  const graph = new GraphManager(db);
  const enrich = new EnrichManager(db);
  const versions = new VersionManager(db, pages, vaultPath);
  const jobs = new JobQueue(db);
  const outputsDir = join(vaultPath, "..", "outputs");
  const writeback = new WritebackManager(pages, db, outputsDir);

  const server = new McpServer({
    name: "cbrain",
    version: "0.3.0",
  });

  // ─── query ───────────────────────────────────────────────
  server.registerTool("query", {
    description: "Search the knowledge brain with hybrid search (vector + FTS + graph, automatically fused).",
    inputSchema: {
      query: z.string().describe("Search query"),
      limit: z.number().optional().default(10).describe("Max results"),
    },
  }, async ({ query, limit }) => {
    const results = await search.search(query, { strategy: "all", limit });
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  });

  // ─── ingest ──────────────────────────────────────────────
  server.registerTool("ingest", {
    description: "Ingest content into the brain. Supports markdown (with frontmatter) and plain text. IMPORTANT: always provide title and pageType.",
    inputSchema: {
      content: z.string().describe("Content to ingest"),
      type: z.enum(["markdown", "text"]).optional().default("text").describe("Content type"),
      title: z.string().optional().describe("Title for this page — derive from content if not obvious"),
      tags: z.array(z.string()).optional().describe("Tags to apply"),
      pageType: z.enum(["entity", "concept", "event", "record", "source"]).optional().default("record").describe("Page type: entity (person/company), concept, event, record (doc/report), source"),
    },
  }, async ({ content, type, title, tags, pageType }) => {
    const effectiveTitle = title || content.split("\n").find(l => l.trim())?.trim().slice(0, 50) || "Untitled";
    const result = await ingest.ingest({ content, type: type ?? "text", title: effectiveTitle, tags, pageType });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });

  // ─── get_page ────────────────────────────────────────────
  server.registerTool("get_page", {
    description: "Get a page by slug. Returns frontmatter + body.",
    inputSchema: {
      slug: z.string().describe("Page slug (e.g. entities/zhangsan)"),
    },
  }, async ({ slug }) => {
    const row = db.prepare("SELECT * FROM pages WHERE slug = ?").get(slug) as Record<string, unknown> | undefined;
    if (!row) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Page not found" }) }] };
    }

    const filePath = row.file_path as string | undefined;
    const fullPath = filePath ? join(vaultPath, filePath) : undefined;

    let body: string | null = null;
    if (fullPath && existsSync(fullPath)) {
      body = readFileSync(fullPath, "utf-8");
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ ...row, body }, null, 2) }],
    };
  });

  // ─── list_pages ──────────────────────────────────────────
  server.registerTool("list_pages", {
    description: "List pages in the brain. Optional type filter.",
    inputSchema: {
      type: z.enum(["entity", "concept", "event", "record", "source"]).optional().describe("Filter by type"),
      limit: z.number().optional().default(20).describe("Max results"),
      offset: z.number().optional().default(0).describe("Offset for pagination"),
    },
  }, async ({ type, limit, offset }) => {
    let sql = "SELECT slug, type, title, tier, mention_count, updated_at FROM pages";
    const params: any[] = [];
    if (type) {
      sql += " WHERE type = ?";
      params.push(type);
    }
    sql += " ORDER BY updated_at DESC LIMIT ? OFFSET ?";
    params.push(limit ?? 20, offset ?? 0);

    const rows = db.prepare(sql).all(...params);
    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
    };
  });

  // ─── graph_query ─────────────────────────────────────────
  server.registerTool("graph_query", {
    description: "Query the knowledge graph. Traverse from a seed entity or get backlinks.",
    inputSchema: {
      slug: z.string().describe("Seed entity slug"),
      mode: z.enum(["traverse", "backlinks", "related"]).optional().default("traverse").describe("Query mode"),
      depth: z.number().optional().default(2).describe("Max traversal depth"),
      limit: z.number().optional().default(20).describe("Max results"),
    },
  }, async ({ slug, mode, depth, limit }) => {
    let result;
    switch (mode) {
      case "backlinks":
        result = graph.getBacklinks(slug);
        break;
      case "related":
        result = graph.getRelatedEntities(slug, limit);
        break;
      default:
        result = graph.traverse(slug, { maxDepth: depth, limit });
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });

  // ─── enrich ──────────────────────────────────────────────
  server.registerTool("enrich", {
    description: "Run entity enrichment. Upgrades entity tiers based on mention counts.",
    inputSchema: {
      slug: z.string().optional().describe("Specific entity slug (omit for all)"),
    },
  }, async ({ slug }) => {
    const result = slug
      ? [enrich.enrichEntity(slug)]
      : enrich.enrichAll();
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });

  // ─── sync ────────────────────────────────────────────────
  server.registerTool("sync", {
    description: "Sync vault files to SQLite + LanceDB indexes.",
    inputSchema: {
      slug: z.string().optional().describe("Sync a single page by slug (omit for full sync)"),
    },
  }, async ({ slug }) => {
    if (slug) {
      const result = await sync.syncPage(slug, vaultPath);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
    const report = await sync.syncAll(vaultPath);
    const orphans = await sync.removeOrphans(vaultPath);
    return {
      content: [{ type: "text", text: JSON.stringify({ ...report, orphansRemoved: orphans.length, orphanSlugs: orphans }, null, 2) }],
    };
  });

  // ─── health ────────────────────────────────────────────
  server.registerTool("health", {
    description: "Run an 8-dimension health check (dedup, consistency, completeness, islands, suggestions, attention, data readiness, source quality). Returns issues and writes a report file.",
    inputSchema: {},
  }, async () => {
    const outputsDir = join(vaultPath, "..", "outputs");
    const checker = new HealthChecker(db, outputsDir);
    const report = await checker.checkAll();
    return {
      content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
    };
  });

  // ─── writeback ────────────────────────────────────────────
  server.registerTool("writeback", {
    description: "Write insights back to the knowledge base. Actions: 'append' (add content to existing page), 'create_concept' (create new concept page), 'create_link' (add relation between two pages). All operations are logged.",
    inputSchema: {
      action: z.enum(["append", "create_concept", "create_link"]).describe("Writeback action"),
      targetSlug: z.string().optional().describe("Target page slug (for append)"),
      content: z.string().describe("Content to write"),
      conceptTitle: z.string().optional().describe("Title for new concept (for create_concept)"),
      fromSlug: z.string().optional().describe("Source page slug (for create_link)"),
      toSlug: z.string().optional().describe("Target page slug (for create_link)"),
      relation: z.string().optional().describe("Relation type (for create_link, e.g. 'works_at')"),
      source: z.string().optional().describe("Origin of this insight (e.g. 'query:xyz')"),
    },
  }, async (params) => {
    const result = await writeback.execute(params);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });

  // ─── generate_indexes ───────────────────────────────────
  server.registerTool("generate_indexes", {
    description: "Generate Obsidian-readable index files: All-Entities, All-Concepts, All-Sources, Dashboard.",
    inputSchema: {},
  }, async () => {
    const gen = new IndexGenerator(db, outputsDir);
    const files = gen.generateAll();
    return {
      content: [{ type: "text", text: JSON.stringify({ generated: files.length, files }, null, 2) }],
    };
  });

  // ─── remove_orphans ──────────────────────────────────────
  server.registerTool("remove_orphans", {
    description: "Remove database entries that have no corresponding vault file. Run this after manually deleting files from the vault.",
    inputSchema: {},
  }, async () => {
    const orphans = await sync.removeOrphans(vaultPath);
    return {
      content: [{ type: "text", text: JSON.stringify({ removed: orphans.length, slugs: orphans }, null, 2) }],
    };
  });

  // ─── status ──────────────────────────────────────────────
  server.registerTool("status", {
    description: "Get brain status: page counts, sync info, etc.",
    inputSchema: {},
  }, async () => {
    const totalPages = (db.prepare("SELECT COUNT(*) as cnt FROM pages").get() as any).cnt;
    const byType = db.prepare("SELECT type, COUNT(*) as cnt FROM pages GROUP BY type").all();
    const totalLinks = (db.prepare("SELECT COUNT(*) as cnt FROM links").get() as any).cnt;
    const totalChunks = (db.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as any).cnt;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ totalPages, byType, totalLinks, totalChunks, vaultPath }, null, 2),
      }],
    };
  });

  // ─── put_page ──────────────────────────────────────────────

  /** Index page content into chunks, vector, and FTS. Best-effort: errors logged, not thrown. */
  async function indexPageContent(slug: string, body: string) {
    try {
      const chunks = chunkContent(body, 500);
      if (chunks.length === 0) return;

      const embedResults = await embedding.embedBatch(chunks.map((c) => c.content));
      await lance.deleteByPageSlug(slug);
      await lance.addChunks(
        chunks.map((c, i) => ({
          pageSlug: slug,
          chunkIndex: c.index,
          content: c.content,
          vector: new Float32Array(embedResults[i].embedding),
        }))
      );

      db.prepare("DELETE FROM chunks WHERE page_slug = $slug").run({ $slug: slug });
      db.ftsDeleteByPage(slug);
      const insertChunk = db.prepare(
        "INSERT INTO chunks (page_slug, chunk_index, content) VALUES ($slug, $idx, $content)"
      );
      for (const chunk of chunks) {
        insertChunk.run({ $slug: slug, $idx: chunk.index, $content: chunk.content });
      }

      const fullContent = chunks.map((c) => c.content).join("\n\n");
      db.ftsInsert(slug, fullContent);
    } catch (err) {
      // Indexing failure should not block page creation
      console.error(`indexPageContent failed for ${slug}:`, err);
    }
  }

  server.registerTool("put_page", {
    description: "Create or update a page. If the slug exists, updates it; otherwise creates a new page.",
    inputSchema: {
      slug: z.string().describe("Page slug (e.g. entities/zhangsan)"),
      content: z.string().describe("Page body content (markdown)"),
      title: z.string().optional().describe("Page title (required for new pages)"),
      type: z.enum(["entity", "concept", "event", "record", "source"]).optional().default("record").describe("Page type (required for new pages)"),
      tags: z.array(z.string()).optional().describe("Tags to apply"),
    },
  }, async ({ slug, content, title, type, tags }) => {
    if (slug.startsWith("raw/")) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Cannot write to raw/ slug. Raw files are human domain. Create a brain/ page instead (e.g. brain/entities/name).` }) }],
      };
    }
    const existing = pages.getBySlug(slug);
    if (existing) {
      versions.createVersion(slug); // snapshot before update
      const updated = pages.update(slug, { body: content, tags });
      if (updated) await indexPageContent(slug, content);
      return {
        content: [{ type: "text", text: JSON.stringify({ action: "updated", page: updated ? { slug: updated.slug, title: updated.title } : null }, null, 2) }],
      };
    }
    if (!title) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "title is required for new pages" }) }] };
    }
    const created = pages.create({ slug, title, type: type ?? "record", body: content, tags });
    await indexPageContent(created.slug, content);
    return {
      content: [{ type: "text", text: JSON.stringify({ action: "created", page: { slug: created.slug, title: created.title } }, null, 2) }],
    };
  });

  // ─── delete_page ─────────────────────────────────────────────
  server.registerTool("delete_page", {
    description: "Delete a page by slug. Removes both the vault file and database entry.",
    inputSchema: {
      slug: z.string().describe("Page slug to delete"),
    },
  }, async ({ slug }) => {
    const success = pages.delete(slug);
    return {
      content: [{ type: "text", text: JSON.stringify({ success, slug }) }],
    };
  });

  // ─── resolve_slugs ───────────────────────────────────────────
  server.registerTool("resolve_slugs", {
    description: "Resolve page titles or partial names to slugs. Returns best match for each query.",
    inputSchema: {
      queries: z.array(z.string()).describe("List of page names or slugs to resolve"),
    },
  }, async ({ queries }) => {
    const results = db.resolveSlugs(queries);
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  });

  // ─── get_tags ────────────────────────────────────────────────
  server.registerTool("get_tags", {
    description: "Get all tags for a page.",
    inputSchema: {
      slug: z.string().describe("Page slug"),
    },
  }, async ({ slug }) => {
    const tags = db.getTags(slug);
    return {
      content: [{ type: "text", text: JSON.stringify({ slug, tags }, null, 2) }],
    };
  });

  // ─── add_tag ─────────────────────────────────────────────────
  server.registerTool("add_tag", {
    description: "Add a tag to a page.",
    inputSchema: {
      slug: z.string().describe("Page slug"),
      tag: z.string().describe("Tag to add"),
    },
  }, async ({ slug, tag }) => {
    const ok = db.addTag(slug, tag);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: ok, slug, tag }) }],
    };
  });

  // ─── remove_tag ──────────────────────────────────────────────
  server.registerTool("remove_tag", {
    description: "Remove a tag from a page.",
    inputSchema: {
      slug: z.string().describe("Page slug"),
      tag: z.string().describe("Tag to remove"),
    },
  }, async ({ slug, tag }) => {
    const ok = db.removeTag(slug, tag);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: ok, slug, tag }) }],
    };
  });

  // ─── get_links ───────────────────────────────────────────────
  server.registerTool("get_links", {
    description: "Get links for a page. Returns outgoing, incoming, or both directions.",
    inputSchema: {
      slug: z.string().describe("Page slug"),
      direction: z.enum(["outgoing", "incoming", "both"]).optional().default("both").describe("Link direction"),
    },
  }, async ({ slug, direction }) => {
    const links = graph.getLinks(slug, direction);
    return {
      content: [{ type: "text", text: JSON.stringify(links, null, 2) }],
    };
  });

  // ─── remove_link ─────────────────────────────────────────────
  server.registerTool("remove_link", {
    description: "Remove a link between two pages.",
    inputSchema: {
      from: z.string().describe("Source page slug"),
      to: z.string().describe("Target page slug"),
      relation: z.string().optional().describe("Relation type (omit to remove all relations between the two)"),
    },
  }, async ({ from, to, relation }) => {
    const ok = graph.removeLink(from, to, relation);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: ok, from, to, relation }) }],
    };
  });

  // ─── get_timeline ────────────────────────────────────────────
  server.registerTool("get_timeline", {
    description: "Get timeline entries for a page.",
    inputSchema: {
      slug: z.string().describe("Page slug"),
    },
  }, async ({ slug }) => {
    const entries = db.getTimeline(slug);
    return {
      content: [{ type: "text", text: JSON.stringify(entries, null, 2) }],
    };
  });

  // ─── add_timeline_entry ──────────────────────────────────────
  server.registerTool("add_timeline_entry", {
    description: "Add a timeline entry to a page.",
    inputSchema: {
      slug: z.string().describe("Page slug"),
      summary: z.string().describe("Timeline event summary"),
      eventDate: z.string().optional().describe("Event date (ISO format)"),
      source: z.string().optional().describe("Source of this event"),
    },
  }, async ({ slug, summary, eventDate, source }) => {
    const id = db.addTimelineEntry(slug, summary, eventDate, source);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: true, id, slug }) }],
    };
  });

  // ─── get_chunks ──────────────────────────────────────────────
  server.registerTool("get_chunks", {
    description: "Get indexed text chunks for a page.",
    inputSchema: {
      slug: z.string().describe("Page slug"),
    },
  }, async ({ slug }) => {
    const chunks = db.getChunksByPage(slug);
    return {
      content: [{ type: "text", text: JSON.stringify(chunks, null, 2) }],
    };
  });

  // ─── get_ingest_log ──────────────────────────────────────────
  server.registerTool("get_ingest_log", {
    description: "Get recent ingest log entries.",
    inputSchema: {
      limit: z.number().optional().default(50).describe("Max entries to return"),
    },
  }, async ({ limit }) => {
    const log = db.getIngestLog(limit);
    return {
      content: [{ type: "text", text: JSON.stringify(log, null, 2) }],
    };
  });

  // ─── get_config ──────────────────────────────────────────────
  server.registerTool("get_config", {
    description: "Get a configuration value.",
    inputSchema: {
      key: z.string().describe("Config key"),
    },
  }, async ({ key }) => {
    const value = db.getConfig(key);
    return {
      content: [{ type: "text", text: JSON.stringify({ key, value }) }],
    };
  });

  // ─── set_config ──────────────────────────────────────────────
  server.registerTool("set_config", {
    description: "Set a configuration value.",
    inputSchema: {
      key: z.string().describe("Config key"),
      value: z.string().describe("Config value"),
    },
  }, async ({ key, value }) => {
    db.setConfig(key, value);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: true, key }) }],
    };
  });

  // ─── get_versions ────────────────────────────────────────────
  server.registerTool("get_versions", {
    description: "Get version history for a page.",
    inputSchema: {
      slug: z.string().describe("Page slug"),
    },
  }, async ({ slug }) => {
    const versionList = versions.getVersions(slug);
    return {
      content: [{ type: "text", text: JSON.stringify(versionList, null, 2) }],
    };
  });

  // ─── revert_version ──────────────────────────────────────────
  server.registerTool("revert_version", {
    description: "Revert a page to a specific version. Creates a version snapshot before reverting.",
    inputSchema: {
      slug: z.string().describe("Page slug"),
      version: z.number().describe("Version number to revert to"),
    },
  }, async ({ slug, version }) => {
    const ok = versions.revertToVersion(slug, version);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: ok, slug, revertedTo: ok ? version : null }) }],
    };
  });

  // ─── job_submit ────────────────────────────────────────────
  server.registerTool("job_submit", {
    description: "Submit a new job to the queue",
    inputSchema: {
      name: z.string().describe("Job name (e.g. sync, embed, ner)"),
      data: z.any().optional().describe("Job payload"),
      priority: z.number().optional().describe("Priority (higher = sooner)"),
    },
  }, async ({ name, data, priority }) => {
    const id = jobs.submit(name, data, priority);
    return {
      content: [{ type: "text", text: JSON.stringify({ id, name, status: "pending" }) }],
    };
  });

  // ─── job_list ──────────────────────────────────────────────
  server.registerTool("job_list", {
    description: "List jobs, optionally filtered by status",
    inputSchema: {
      status: z.string().optional().describe("Filter by status: pending, running, done, failed, cancelled"),
    },
  }, async ({ status }) => {
    const list = jobs.list(status);
    return {
      content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
    };
  });

  // ─── job_status ────────────────────────────────────────────
  server.registerTool("job_status", {
    description: "Get detailed status of a specific job",
    inputSchema: {
      id: z.number().describe("Job ID"),
    },
  }, async ({ id }) => {
    const job = jobs.get(id);
    if (!job) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Job not found" }) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(job, null, 2) }] };
  });

  // ─── job_cancel ────────────────────────────────────────────
  server.registerTool("job_cancel", {
    description: "Cancel a pending or running job",
    inputSchema: {
      id: z.number().describe("Job ID"),
    },
  }, async ({ id }) => {
    const ok = jobs.cancel(id);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: ok, id }) }],
    };
  });

  // ─── job_retry ─────────────────────────────────────────────
  server.registerTool("job_retry", {
    description: "Retry a failed job",
    inputSchema: {
      id: z.number().describe("Job ID"),
    },
  }, async ({ id }) => {
    const ok = jobs.retry(id);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: ok, id }) }],
    };
  });

  // ─── put_raw_data ───────────────────────────────────────────
  server.registerTool("put_raw_data", {
    description: "Store raw binary data (base64-encoded) attached to a page",
    inputSchema: {
      slug: z.string().describe("Page slug"),
      key: z.string().describe("Data key (unique per page)"),
      data_base64: z.string().describe("Base64-encoded binary data"),
      mime_type: z.string().optional().describe("MIME type, defaults to application/octet-stream"),
    },
  }, async ({ slug, key, data_base64, mime_type }) => {
    db.putRawData(slug, key, Buffer.from(data_base64, "base64"), mime_type);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: true, slug, key }) }],
    };
  });

  // ─── get_raw_data ───────────────────────────────────────────
  server.registerTool("get_raw_data", {
    description: "Retrieve raw data attached to a page. Returns base64-encoded data.",
    inputSchema: {
      slug: z.string().describe("Page slug"),
      key: z.string().describe("Data key"),
    },
  }, async ({ slug, key }) => {
    const row = db.getRawData(slug, key);
    if (!row) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Raw data not found" }) }] };
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          slug,
          key,
          mime_type: row.mime_type,
          data_base64: Buffer.from(row.data).toString("base64"),
          created_at: row.created_at,
        }),
      }],
    };
  });

  // ─── list_raw_data ──────────────────────────────────────────
  server.registerTool("list_raw_data", {
    description: "List all raw data keys attached to a page",
    inputSchema: {
      slug: z.string().describe("Page slug"),
    },
  }, async ({ slug }) => {
    const keys = db.listRawDataKeys(slug);
    return {
      content: [{ type: "text", text: JSON.stringify(keys) }],
    };
  });

  // ─── delete_raw_data ────────────────────────────────────────
  server.registerTool("delete_raw_data", {
    description: "Delete raw data attached to a page",
    inputSchema: {
      slug: z.string().describe("Page slug"),
      key: z.string().describe("Data key"),
    },
  }, async ({ slug, key }) => {
    const ok = db.deleteRawData(slug, key);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: ok, slug, key }) }],
    };
  });

  return server;
}

export async function startServer(deps: CBrainDeps): Promise<void> {
  const server = createServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
