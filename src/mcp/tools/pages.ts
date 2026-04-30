import { existsSync, readFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { indexPage } from "../context.js";

export function registerPageTools(server: McpServer, ctx: ToolContext): void {
  // ─── get_page ────────────────────────────────────────────
  server.registerTool("get_page", {
    description: "Get a page by slug. Returns frontmatter + body.",
    inputSchema: {
      slug: z.string().describe("Page slug (e.g. entities/zhangsan)"),
    },
  }, async ({ slug }) => {
    const row = ctx.db.getPage(slug);
    if (!row) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Page not found" }) }] };
    }

    const filePath = row.file_path as string | undefined;
    const fullPath = filePath ? join(ctx.vaultPath, filePath) : undefined;

    // Prevent path traversal — only read files inside vault
    let body: string | null = null;
    if (fullPath) {
      const resolved = resolve(fullPath);
      const rel = relative(ctx.vaultPath, resolved);
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
    const rows = ctx.db.listPages({ type, limit: limit ?? 20, offset: offset ?? 0 });
    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
    };
  });

  // ─── put_page ──────────────────────────────────────────────
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
    const existing = ctx.pages.getBySlug(slug);
    if (existing) {
      ctx.versions.createVersion(slug); // snapshot before update
      const updated = ctx.pages.update(slug, { body: content, tags });
      if (updated) await indexPage(ctx.pipeline, slug, content);
      return {
        content: [{ type: "text", text: JSON.stringify({ action: "updated", page: updated ? { slug: updated.slug, title: updated.title } : null }, null, 2) }],
      };
    }
    // Check for same-title-different-person before creating
    if (title) {
      const dup = ctx.db.getPageByTitleExcluding(title, slug);
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
    const created = ctx.pages.create({ slug, title, type: type ?? "record", body: content, tags });
    await indexPage(ctx.pipeline, created.slug, content);
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
    const success = ctx.pages.delete(slug);
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
    const results = ctx.db.resolveSlugs(queries);
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
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
    const sourcePage = ctx.pages.getBySlug(source);
    const targetPage = ctx.pages.getBySlug(target);
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
      const sourceTags = ctx.db.getTags(source);
      const targetTags = ctx.db.getTags(target);
      const mergedTags = [...new Set([...targetTags, ...sourceTags])];
      const sourceLinks = ctx.db.getLinkCountBySlug(source);
      const timelineEntries = ctx.db.getTimelineCountByPage(source);

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

    const result = ctx.pages.merge(source, target);
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
}
