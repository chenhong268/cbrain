import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";

export function registerTagTools(server: McpServer, ctx: ToolContext): void {
  // ─── get_tags ────────────────────────────────────────────────
  server.registerTool("get_tags", {
    description: "Get all tags for a page.",
    inputSchema: {
      slug: z.string().describe("Page slug"),
    },
  }, async ({ slug }) => {
    const dbTags = ctx.db.getTags(slug);
    const page = ctx.pages.getBySlug(slug);
    const fmTags = page?.frontmatter?.tags ?? [];
    const tags = [...new Set([...dbTags, ...fmTags])];
    return {
      content: [{ type: "text", text: JSON.stringify({ slug, tags }, null, 2) }],
    };
  });

  // ─── add_tag ─────────────────────────────────────────────────
  server.registerTool("add_tag", {
    description: "Add a tag to a page. Updates both the database and the vault file frontmatter.",
    inputSchema: {
      slug: z.string().describe("Page slug"),
      tag: z.string().describe("Tag to add"),
    },
  }, async ({ slug, tag }) => {
    const dbRow = ctx.db.getPage(slug);
    if (!dbRow) {
      return { content: [{ type: "text", text: JSON.stringify({ error: `Page not found: ${slug}` }) }], isError: true };
    }
    const page = ctx.pages.getBySlug(slug);
    if (page) {
      const currentTags = page.frontmatter.tags ?? [];
      if (currentTags.includes(tag)) {
        return { content: [{ type: "text", text: JSON.stringify({ success: true, slug, tag, note: "tag already exists" }) }] };
      }
      ctx.pages.update(slug, { tags: [...currentTags, tag] });
    } else {
      // file missing — DB-only fallback
      ctx.db.addTag(slug, tag);
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ success: true, slug, tag }) }],
    };
  });

  // ─── remove_tag ──────────────────────────────────────────────
  server.registerTool("remove_tag", {
    description: "Remove a tag from a page. Updates both the database and the vault file frontmatter.",
    inputSchema: {
      slug: z.string().describe("Page slug"),
      tag: z.string().describe("Tag to remove"),
    },
  }, async ({ slug, tag }) => {
    const dbRow = ctx.db.getPage(slug);
    if (!dbRow) {
      return { content: [{ type: "text", text: JSON.stringify({ error: `Page not found: ${slug}` }) }], isError: true };
    }
    const page = ctx.pages.getBySlug(slug);
    if (page) {
      const currentTags = page.frontmatter.tags ?? [];
      ctx.pages.update(slug, { tags: currentTags.filter((t) => t !== tag) });
    } else {
      // file missing — DB-only fallback
      ctx.db.removeTag(slug, tag);
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ success: true, slug, tag }) }],
    };
  });
}
