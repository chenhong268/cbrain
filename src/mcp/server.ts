import { existsSync, readFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
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
import { ContentPipeline } from "../core/pipeline.js";
import { findEntitySlug } from "../core/shared.js";
import { VersionManager } from "../core/version.js";
import { JobQueue } from "../core/jobs.js";
import { DialogueIngest } from "../core/dialogue.js";

import { Logger } from "../core/logger.js";
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

  const outputsDir = join(vaultPath, "..", "outputs");
  const logger = new Logger(outputsDir);
  const pages = new PageManager(db, vaultPath, logger);
  const search = new HybridSearch(db, embedding, lance, { llm });
  const nerEngine = llm ? new NerEngine(llm) : undefined;
  const sync = new SyncManager(db, embedding, lance, { nerEngine, pages, logger });
  const ingest = new IngestManager(db, embedding, lance, vaultPath, llm);
  const graph = new GraphManager(db);
  const enrich = new EnrichManager(db);
  const versions = new VersionManager(db, pages, vaultPath);
  const jobs = new JobQueue(db);
  const writeback = new WritebackManager(pages, db, outputsDir);
  const pipeline = new ContentPipeline(db, embedding, lance, { pages, nerEngine, logger });

  const server = new McpServer({
    name: "cbrain",
    version: "0.3.0",
  });

  // Unified error wrapper — every tool handler gets try-catch automatically
  const origRegister = server.registerTool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool = (name: string, def: any, handler: (...a: any[]) => Promise<any>) =>
    origRegister(name, def, async (...a: any[]) => {
      try {
        return await handler(...a);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
          isError: true,
        };
      }
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
      skipNer: z.boolean().optional().default(false).describe("Skip LLM entity extraction — use for simple entries"),
    },
  }, async ({ content, type, title, tags, pageType, skipNer }) => {
    const effectiveTitle = title || content.split("\n").find(l => l.trim())?.trim().slice(0, 50) || "Untitled";
    const result = await ingest.ingest({ content, type: type ?? "text", title: effectiveTitle, tags, pageType, skipNer });
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

    // Prevent path traversal — only read files inside vault
    let body: string | null = null;
    if (fullPath) {
      const resolved = resolve(fullPath);
      const rel = relative(vaultPath, resolved);
      if (!rel.startsWith("..") && !resolved.startsWith("..")) {
        if (existsSync(resolved)) body = readFileSync(resolved, "utf-8");
      }
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
    description: "Query the knowledge graph. Traverse from a seed entity or get backlinks. Accepts a slug or entity name (auto-resolved).",
    inputSchema: {
      slug: z.string().describe("Seed entity slug or name (auto-resolved if not an exact slug)"),
      mode: z.enum(["traverse", "backlinks", "related"]).optional().default("traverse").describe("Query mode"),
      depth: z.number().optional().default(2).describe("Max traversal depth"),
      limit: z.number().optional().default(20).describe("Max results"),
    },
  }, async ({ slug, mode, depth, limit }) => {
    let resolvedSlug = slug;
    if (!pages.getBySlug(slug)) {
      const found = findEntitySlug(db, slug);
      if (found) resolvedSlug = found;
    }

    let result;
    switch (mode) {
      case "backlinks":
        result = graph.getBacklinks(resolvedSlug);
        break;
      case "related":
        result = graph.getRelatedEntities(resolvedSlug, limit);
        break;
      default:
        result = graph.traverse(resolvedSlug, { maxDepth: depth, limit });
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ resolvedSlug, result }, null, 2) }],
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
    description: "Run a 10-dimension health check (errors, dedup, slug collisions, consistency, completeness, islands, suggestions, attention, data readiness, source quality). Returns issues and writes a report file.",
    inputSchema: {},
  }, async () => {
    const checker = new HealthChecker(db, outputsDir, logger);
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
    const recentNerErrors = (db.prepare(
      "SELECT COUNT(*) as cnt FROM ingest_log WHERE details LIKE '%nerError%' AND created_at > datetime('now', '-24 hours')"
    ).get() as any).cnt;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ totalPages, byType, totalLinks, totalChunks, recentNerErrors, vaultPath }, null, 2),
      }],
    };
  });

  // ─── put_page ──────────────────────────────────────────────

  const indexPage = async (slug: string, body: string) => {
    try {
      const { chunks, embedResults } = await pipeline.embed(body);
      pipeline.writeIndexes(slug, chunks, embedResults);
    } catch (err) {
      console.error(`indexPageContent failed for ${slug}:`, err);
    }
  };

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
      if (updated) await indexPage(slug, content);
      return {
        content: [{ type: "text", text: JSON.stringify({ action: "updated", page: updated ? { slug: updated.slug, title: updated.title } : null }, null, 2) }],
      };
    }
    // Check for same-title-different-person before creating
    if (title) {
      const dup = db.prepare(
        "SELECT slug, type, title FROM pages WHERE title = $title AND slug != $slug LIMIT 1"
      ).get({ $title: title, $slug: slug }) as { slug: string; type: string; title: string } | null;
      if (dup) {
        // Suggest a disambiguated slug based on type or tags
        const context = tags?.join("-") || type || "entity";
        const suggestedSlug = slug.replace(/\/[^/]+$/, `/${title}-${context}`);
        return {
          content: [{ type: "text", text: JSON.stringify({
            action: "duplicate_title",
            title,
            message: `同名人物警告: "${title}" 已存在 (${dup.slug})。如果这是不同的人，请用不同的 slug，例如 "${suggestedSlug}"。如果是同一个人，直接用现有 slug "${dup.slug}" 更新。`,
            existingSlug: dup.slug,
            suggestedSlug,
          }) }],
        };
      }
    }
    if (!title) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "title is required for new pages" }) }] };
    }
    const created = pages.create({ slug, title, type: type ?? "record", body: content, tags });
    await indexPage(created.slug, content);
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

  // ─── add_link ────────────────────────────────────────────────
  server.registerTool("add_link", {
    description: "Create a link between two pages.",
    inputSchema: {
      from: z.string().describe("Source page slug"),
      to: z.string().describe("Target page slug"),
      relation: z.string().default("提及").describe("Relation type (e.g. '提及', 'works_at')"),
      context: z.string().optional().describe("Optional context for the relation"),
    },
  }, async ({ from, to, relation, context }) => {
    if (!pages.getBySlug(from)) return { content: [{ type: "text", text: JSON.stringify({ error: `Source page not found: ${from}` }) }], isError: true };
    if (!pages.getBySlug(to)) return { content: [{ type: "text", text: JSON.stringify({ error: `Target page not found: ${to}` }) }], isError: true };
    if (from === to) return { content: [{ type: "text", text: JSON.stringify({ error: "Cannot create self-referencing link" }) }], isError: true };

    db.prepare(
      "INSERT OR IGNORE INTO links (from_slug, to_slug, relation, context) VALUES ($from, $to, $rel, $ctx)"
    ).run({ $from: from, $to: to, $rel: relation, $ctx: context ?? null });
    pages.incrementMention(to);

    return {
      content: [{ type: "text", text: JSON.stringify({ success: true, from, to, relation }) }],
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
    const page = pages.getBySlug(slug);
    const body = page?.body ?? "";

    // Build a unified events list — structured entries + body date lines
    const events: Array<{ date?: string; summary: string; source: string }> = [];
    for (const e of entries) {
      events.push({ date: e.event_date ?? undefined, summary: e.summary, source: e.source ?? "unknown" });
    }

    const datePattern = /\b\d{4}[.\-/年]\d{1,2}/;
    for (const line of body.split("\n")) {
      if (datePattern.test(line)) {
        const cleaned = line.replace(/^\|?\s*|\s*\|?$/g, "").trim();
        if (!entries.some(e => cleaned.includes(e.summary.slice(0, 10)))) {
          events.push({ summary: cleaned, source: "body" });
        }
      }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          slug,
          title: page?.title ?? slug,
          events,
        }, null, 2),
      }],
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

    // Append to page body for brain/ pages so timeline content is searchable
    if (!slug.startsWith("raw/")) {
      const page = pages.getBySlug(slug);
      if (page) {
        const dateStr = eventDate ?? new Date().toISOString().slice(0, 10);
        const srcNote = source ? ` [来源: ${source}]` : "";
        const entry = `\n- **${dateStr}**: ${summary}${srcNote}`;

        versions.createVersion(slug);
        pages.update(slug, { body: page.body + entry });
        await indexPage(slug, page.body + entry);
      }
    }

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

  // ─── dream ──────────────────────────────────────────────────
  server.registerTool("dream", {
    description: "Run full nightly pipeline: sync → enrich → cleanup → health → report. Use for scheduled daily maintenance. Has cycle lock to prevent overlapping runs.",
    inputSchema: {},
  }, async () => {
    const { runDream } = await import("../core/dream.js");
    const report = await runDream(vaultPath, db, sync, enrich, new HealthChecker(db, outputsDir, logger), outputsDir, logger);
    const brief = [
      `同步: ${report.stages.sync.synced} 更新, ${report.stages.sync.skipped} 跳过`,
      `实体: ${report.stages.enrich.total} 总计, ${report.stages.enrich.upgraded} 升级`,
      `清理: ${report.stages.cleanup.orphans} 孤立, ${report.stages.cleanup.staleStubs} 过期`,
      `健康: ${report.stages.health.overallStatus} (${report.stages.health.dimensions} 维度, ${report.stages.health.issues} 问题)`,
      `⏱ ${(report.duration_ms / 1000).toFixed(1)}s`,
    ].join("\n");
    return {
      content: [{ type: "text", text: JSON.stringify({
        success: report.locked,
        brief,
        locked: report.locked,
        stages: report.stages,
        timestamp: report.timestamp,
        duration_ms: report.duration_ms,
      }, null, 2) }],
    };
  });

  // ─── merge_pages ────────────────────────────────────────────
  server.registerTool("merge_pages", {
    description: "Merge a source page into a target page. All links, timeline entries, tags and raw data are moved from source to target. Source body is appended to target body. Source page is deleted after merge. Use dryRun=true to preview without executing.",
    inputSchema: {
      source: z.string().describe("Slug of the source page to merge and delete"),
      target: z.string().describe("Slug of the target page to merge into"),
      dryRun: z.boolean().optional().default(false).describe("Preview merge without executing"),
    },
  }, async ({ source, target, dryRun }) => {
    const sourcePage = pages.getBySlug(source);
    const targetPage = pages.getBySlug(target);
    if (!sourcePage || !targetPage) {
      return {
        content: [{ type: "text", text: JSON.stringify({ success: false, error: `Page not found: ${!sourcePage ? source : target}` }) }],
        isError: true,
      };
    }
    if (source === target) {
      return {
        content: [{ type: "text", text: JSON.stringify({ success: false, error: "Cannot merge page into itself" }) }],
        isError: true,
      };
    }

    if (dryRun) {
      const sourceTags = db.getTags(source);
      const targetTags = db.getTags(target);
      const mergedTags = [...new Set([...targetTags, ...sourceTags])];
      const sourceLinks = (db.prepare("SELECT COUNT(*) as cnt FROM links WHERE from_slug = $slug OR to_slug = $slug").get({ $slug: source }) as any).cnt;
      const timelineEntries = (db.prepare("SELECT COUNT(*) as cnt FROM timeline WHERE page_slug = $slug").get({ $slug: source }) as any).cnt;

      return {
        content: [{ type: "text", text: JSON.stringify({
          dryRun: true,
          source: { slug: source, title: sourcePage.title, type: sourcePage.type, tags: sourceTags },
          target: { slug: target, title: targetPage.title, type: targetPage.type, tags: targetTags },
          preview: {
            mergedTags,
            linksToMove: sourceLinks,
            timelineToMove: timelineEntries,
            sourceDeleted: true,
          },
        }, null, 2) }],
      };
    }

    const result = pages.merge(source, target);
    if (!result) {
      return {
        content: [{ type: "text", text: JSON.stringify({ success: false, error: "Merge failed — check that both slugs exist and are different" }) }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ success: true, merged: result.slug, title: result.title, type: result.type }) }],
    };
  });

  // ─── ingest_dialogue ───────────────────────────────────────
  server.registerTool("ingest_dialogue", {
    description: "Ingest a dialogue/conversation into the brain. Extracts new entities, relations, and events via LLM, skipping already-known knowledge. Use for capturing key facts from conversations.",
    inputSchema: {
      text: z.string().describe("Dialogue text to ingest (conversation content)"),
    },
  }, async ({ text }) => {
    const dialogue = new DialogueIngest(db, embedding, lance, vaultPath, llm);
    const result = await dialogue.ingest(text);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });

  return server;
}

export async function startServer(deps: CBrainDeps): Promise<void> {
  const server = createServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
