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
import type { EmbeddingProvider } from "../embedding/provider.js";

export interface CBrainDeps {
  db: CBrainDB;
  embedding: EmbeddingProvider;
  lance: LanceDBManager;
  vaultPath: string;
}

export function createServer(deps: CBrainDeps): McpServer {
  const { db, embedding, lance, vaultPath } = deps;

  const search = new HybridSearch(db, embedding, lance);
  const sync = new SyncManager(db, embedding, lance);
  const ingest = new IngestManager(db, embedding, lance, vaultPath);
  const graph = new GraphManager(db);
  const enrich = new EnrichManager(db);

  const server = new McpServer({
    name: "cbrain",
    version: "0.1.0",
  });

  // ─── query ───────────────────────────────────────────────
  server.registerTool("query", {
    description: "Search the knowledge brain. Supports vector, fts, graph, and hybrid strategies.",
    inputSchema: {
      query: z.string().describe("Search query"),
      strategy: z.enum(["vector", "fts", "graph", "all"]).optional().default("all").describe("Search strategy"),
      limit: z.number().optional().default(10).describe("Max results"),
    },
  }, async ({ query, strategy, limit }) => {
    const results = await search.search(query, { strategy, limit });
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

  return server;
}

export async function startServer(deps: CBrainDeps): Promise<void> {
  const server = createServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
