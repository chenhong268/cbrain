import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { normalizeRelation } from "../../core/shared.js";

export function registerBatchTools(server: McpServer, ctx: ToolContext): void {
  // ─── batch_delete_pages ────────────────────────────────────
  server.registerTool("batch_delete_pages", {
    description:
      "Delete multiple pages in one call. Each slug is deleted with vault cleanup + DB cascade. " +
      "Use this instead of calling delete_page N times for bulk cleanup.",
    inputSchema: {
      slugs: z.array(z.string()).min(1).max(100).describe("Array of page slugs to delete (max 100)"),
    },
  }, async ({ slugs }) => {
    const results: { slug: string; success: boolean; error?: string }[] = [];

    for (const slug of slugs) {
      try {
        const page = ctx.pages.getBySlug(slug);
        if (!page) {
          results.push({ slug, success: false, error: "not found" });
          continue;
        }
        await ctx.pages.delete(slug);
        results.push({ slug, success: true });
      } catch (e) {
        results.push({ slug, success: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    const succeeded = results.filter(r => r.success).length;
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ total: slugs.length, succeeded, failed: slugs.length - succeeded, results }, null, 2),
      }],
    };
  });

  // ─── batch_add_links ───────────────────────────────────────
  server.registerTool("batch_add_links", {
    description:
      "Create multiple links in one call. Each link is validated (both pages must exist, no self-reference). " +
      "Links are marked source_type=manual with confidence=0.9.",
    inputSchema: {
      links: z.array(z.object({
        from: z.string().describe("Source page slug"),
        to: z.string().describe("Target page slug"),
        relation: z.string().default("提及").describe("Relation type"),
        context: z.string().optional().describe("Optional context"),
        weight: z.number().optional().describe("Link weight 0-1"),
        strength: z.enum(["strong", "medium", "weak"]).optional().describe("Link strength"),
      })).min(1).max(100).describe("Array of links to create (max 100)"),
    },
  }, async ({ links }) => {
    const results: { from: string; to: string; success: boolean; error?: string }[] = [];
    const syncedSlugs = new Set<string>();

    for (const link of links) {
      const { from, to, relation, context, weight, strength } = link;
      try {
        if (from === to) {
          results.push({ from, to, success: false, error: "self-reference" });
          continue;
        }
        if (!ctx.pages.getBySlug(from)) {
          results.push({ from, to, success: false, error: `source not found: ${from}` });
          continue;
        }
        if (!ctx.pages.getBySlug(to)) {
          results.push({ from, to, success: false, error: `target not found: ${to}` });
          continue;
        }

        ctx.db.insertLink(from, to, normalizeRelation(relation), context ?? null, weight, strength, "manual", 0.9);
        ctx.pages.incrementMention(to);
        syncedSlugs.add(from);
        syncedSlugs.add(to);
        results.push({ from, to, success: true });
      } catch (e) {
        results.push({ from, to, success: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    // Sync markdown once per affected slug (not per link)
    for (const slug of syncedSlugs) {
      try { ctx.pages.syncLinksToMarkdown(slug); } catch { /* non-critical */ }
    }

    const succeeded = results.filter(r => r.success).length;
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ total: links.length, succeeded, failed: links.length - succeeded, results }, null, 2),
      }],
    };
  });

  // ─── batch_merge_pages ─────────────────────────────────────
  server.registerTool("batch_merge_pages", {
    description:
      "Merge multiple page pairs in one call. Each pair: source is absorbed into target, then source is deleted. " +
      "Pairs are processed in order — if a source appears as a target in a later pair, the later pair will fail.",
    inputSchema: {
      pairs: z.array(z.object({
        source: z.string().describe("Page to absorb (will be deleted)"),
        target: z.string().describe("Page to keep"),
      })).min(1).max(50).describe("Array of merge pairs (max 50)"),
    },
  }, async ({ pairs }) => {
    const results: { source: string; target: string; success: boolean; error?: string }[] = [];
    const deletedSources = new Set<string>();

    for (const pair of pairs) {
      const { source, target } = pair;
      try {
        if (source === target) {
          results.push({ source, target, success: false, error: "same page" });
          continue;
        }
        if (deletedSources.has(source)) {
          results.push({ source, target, success: false, error: "source already deleted by earlier merge" });
          continue;
        }
        if (deletedSources.has(target)) {
          results.push({ source, target, success: false, error: "target already deleted by earlier merge" });
          continue;
        }

        const sourcePage = ctx.pages.getBySlug(source);
        const targetPage = ctx.pages.getBySlug(target);
        if (!sourcePage) {
          results.push({ source, target, success: false, error: `source not found: ${source}` });
          continue;
        }
        if (!targetPage) {
          results.push({ source, target, success: false, error: `target not found: ${target}` });
          continue;
        }

        await ctx.pages.merge(source, target);
        deletedSources.add(source);
        results.push({ source, target, success: true });
      } catch (e) {
        results.push({ source, target, success: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    const succeeded = results.filter(r => r.success).length;
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ total: pairs.length, succeeded, failed: pairs.length - succeeded, results }, null, 2),
      }],
    };
  });
}
