import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";

type TagAction = "list" | "add" | "remove";

function jsonText(payload: unknown): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

async function listTags(ctx: ToolContext, slug: string): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const dbTags = ctx.db.getTags(slug);
  const page = ctx.pages.getBySlug(slug);
  const fmTags = page?.frontmatter?.tags ?? [];
  const tags = [...new Set([...dbTags, ...fmTags])];
  return jsonText({ slug, tags });
}

async function addTag(ctx: ToolContext, slug: string, tag: string): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
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
    ctx.db.addTag(slug, tag);
  } else {
    // file missing — DB-only fallback
    ctx.db.addTag(slug, tag);
  }
  return {
    content: [{ type: "text", text: JSON.stringify({ success: true, slug, tag }) }],
  };
}

async function removeTag(ctx: ToolContext, slug: string, tag: string): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const dbRow = ctx.db.getPage(slug);
  if (!dbRow) {
    return { content: [{ type: "text", text: JSON.stringify({ error: `Page not found: ${slug}` }) }], isError: true };
  }
  const page = ctx.pages.getBySlug(slug);
  if (page) {
    const currentTags = page.frontmatter.tags ?? [];
    ctx.pages.update(slug, { tags: currentTags.filter((t) => t !== tag) });
    ctx.db.removeTag(slug, tag);
  } else {
    // file missing — DB-only fallback
    ctx.db.removeTag(slug, tag);
  }
  return {
    content: [{ type: "text", text: JSON.stringify({ success: true, slug, tag }) }],
  };
}

async function runTagAction(ctx: ToolContext, action: TagAction, slug: string, tag?: string): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if (action === "list") return listTags(ctx, slug);
  if (!tag) {
    return { content: [{ type: "text", text: JSON.stringify({ error: `tag is required for action: ${action}` }) }], isError: true };
  }
  return action === "add" ? addTag(ctx, slug, tag) : removeTag(ctx, slug, tag);
}

export function registerTagTools(server: McpServer, ctx: ToolContext): void {
  // ─── tag (unified action tool) ───────────────────────────────
  server.registerTool("tag", {
    description: "Unified tag operations. Use action=list/add/remove. Compatibility aliases get_tags/add_tag/remove_tag remain available.",
    inputSchema: {
      action: z.enum(["list", "add", "remove"]).describe("Tag operation"),
      slug: z.string().max(500).describe("Page slug"),
      tag: z.string().max(200).optional().describe("Tag for add/remove"),
    },
  }, async ({ action, slug, tag }) => runTagAction(ctx, action, slug, tag));

  // ─── get_tags ────────────────────────────────────────────────
  server.registerTool("get_tags", {
    description: "Get all tags for a page.",
    inputSchema: {
      slug: z.string().max(500).describe("Page slug"),
    },
  }, async ({ slug }) => listTags(ctx, slug));

  // ─── add_tag ─────────────────────────────────────────────────
  server.registerTool("add_tag", {
    description: "Add a tag to a page. Updates both the database and the vault file frontmatter.",
    inputSchema: {
      slug: z.string().max(500).describe("Page slug"),
      tag: z.string().max(200).describe("Tag to add"),
    },
  }, async ({ slug, tag }) => addTag(ctx, slug, tag));

  // ─── remove_tag ──────────────────────────────────────────────
  server.registerTool("remove_tag", {
    description: "Remove a tag from a page. Updates both the database and the vault file frontmatter.",
    inputSchema: {
      slug: z.string().max(500).describe("Page slug"),
      tag: z.string().max(200).describe("Tag to remove"),
    },
  }, async ({ slug, tag }) => removeTag(ctx, slug, tag));
}
