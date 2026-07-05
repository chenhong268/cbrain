import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { normalizeRelation } from "../../core/shared.js";
import { sanitizeError } from "../server.js";

const BATCH_SAFETY_GATE = 20;

type BatchAction = "delete_pages" | "add_links" | "merge_pages";

interface BatchLinkInput {
  from: string;
  to: string;
  relation: string;
  context?: string;
  weight?: number;
  strength?: "strong" | "medium" | "weak";
}

interface BatchMergePairInput {
  source: string;
  target: string;
}

function textJson(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(message: string): { content: Array<{ type: "text"; text: string }>; isError: boolean } {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

async function deletePages(ctx: ToolContext, slugs: string[], confirmLargeBatch?: boolean) {
  if (slugs.length >= BATCH_SAFETY_GATE && !confirmLargeBatch) {
    return textJson({
      preview: true,
      warning: `批量删除 ${slugs.length} 个页面，超过安全阈值 ${BATCH_SAFETY_GATE}。请确认后重新调用。`,
      itemCount: slugs.length,
      slugs,
      instruction: "设置 confirm_large_batch: true 以执行删除操作",
    });
  }

  const results: { slug: string; success: boolean; lance_repair_required?: boolean; warning?: string; error?: string }[] = [];

  for (const slug of slugs) {
    try {
      const page = ctx.pages.getBySlug(slug);
      if (!page) {
        results.push({ slug, success: false, error: "not found" });
        continue;
      }
      const r = await ctx.pages.deleteDetailed(slug);
      const item: { slug: string; success: boolean; lance_repair_required?: boolean; warning?: string } = {
        slug,
        success: r.committed,
      };
      if (r.lanceRepairRequired) {
        item.lance_repair_required = true;
        item.warning = "vector cleanup failed — repair required (reindex)";
      }
      results.push(item);
    } catch (e) {
      results.push({ slug, success: false, error: sanitizeError(e instanceof Error ? e.message : String(e)) });
    }
  }

  const succeeded = results.filter(r => r.success).length;
  return textJson({ total: slugs.length, succeeded, failed: slugs.length - succeeded, results });
}

async function addLinks(ctx: ToolContext, links: BatchLinkInput[], confirmLargeBatch?: boolean) {
  if (links.length >= BATCH_SAFETY_GATE && !confirmLargeBatch) {
    return textJson({
      preview: true,
      warning: `批量创建 ${links.length} 条链接，超过安全阈值 ${BATCH_SAFETY_GATE}。请确认后重新调用。`,
      itemCount: links.length,
      links: links.map(l => ({ from: l.from, to: l.to, relation: l.relation })),
      instruction: "设置 confirm_large_batch: true 以执行创建操作",
    });
  }

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

      ctx.db.insertLink(from, to, normalizeRelation(relation), context ?? null, weight, strength, "agent", 0.9);
      ctx.pages.incrementMention(to);
      syncedSlugs.add(from);
      syncedSlugs.add(to);
      results.push({ from, to, success: true });
    } catch (e) {
      results.push({ from, to, success: false, error: sanitizeError(e instanceof Error ? e.message : String(e)) });
    }
  }

  const syncWarnings = ctx.pages.syncAffectedSlugs(syncedSlugs);
  const succeeded = results.filter(r => r.success).length;
  return textJson({
    total: links.length,
    succeeded,
    failed: links.length - succeeded,
    results,
    ...(syncWarnings.length > 0 ? { sync_warnings: syncWarnings } : {}),
  });
}

async function mergePages(ctx: ToolContext, pairs: BatchMergePairInput[], confirmLargeBatch?: boolean) {
  if (pairs.length >= BATCH_SAFETY_GATE && !confirmLargeBatch) {
    return textJson({
      preview: true,
      warning: `批量合并 ${pairs.length} 对页面，超过安全阈值 ${BATCH_SAFETY_GATE}。请确认后重新调用。`,
      itemCount: pairs.length,
      pairs,
      instruction: "设置 confirm_large_batch: true 以执行合并操作",
    });
  }

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
      results.push({ source, target, success: false, error: sanitizeError(e instanceof Error ? e.message : String(e)) });
    }
  }

  const allAffected = new Set<string>();
  for (const r of results) {
    if (r.success) {
      allAffected.add(r.target);
      for (const n of ctx.db.getLinkNeighborSlugs(r.target)) {
        allAffected.add(n);
      }
    }
  }
  const syncWarnings = ctx.pages.syncAffectedSlugs(allAffected);
  const succeeded = results.filter(r => r.success).length;
  return textJson({
    total: pairs.length,
    succeeded,
    failed: pairs.length - succeeded,
    results,
    ...(syncWarnings.length > 0 ? { sync_warnings: syncWarnings } : {}),
  });
}

function runBatchAction(
  ctx: ToolContext,
  action: BatchAction,
  args: {
    slugs?: string[];
    links?: BatchLinkInput[];
    pairs?: BatchMergePairInput[];
    confirm_large_batch?: boolean;
  },
) {
  if (action === "delete_pages") {
    if (!args.slugs) return errorResult("slugs is required for action: delete_pages");
    return deletePages(ctx, args.slugs, args.confirm_large_batch);
  }
  if (action === "add_links") {
    if (!args.links) return errorResult("links is required for action: add_links");
    return addLinks(ctx, args.links, args.confirm_large_batch);
  }
  if (!args.pairs) return errorResult("pairs is required for action: merge_pages");
  return mergePages(ctx, args.pairs, args.confirm_large_batch);
}

const linkInputSchema = z.object({
  from: z.string().max(500).describe("Source page slug"),
  to: z.string().max(500).describe("Target page slug"),
  relation: z.string().max(100).default("提及").describe("Relation type"),
  context: z.string().max(10_000).optional().describe("Optional context"),
  weight: z.number().optional().describe("Link weight 0-1"),
  strength: z.enum(["strong", "medium", "weak"]).optional().describe("Link strength"),
});

const mergePairSchema = z.object({
  source: z.string().max(500).describe("Page to absorb (will be deleted)"),
  target: z.string().max(500).describe("Page to keep"),
});

export function registerBatchTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("batch", {
    description:
      "Unified batch operations. Use action=delete_pages/add_links/merge_pages. " +
      "Compatibility aliases batch_delete_pages/batch_add_links/batch_merge_pages remain available.",
    inputSchema: {
      action: z.enum(["delete_pages", "add_links", "merge_pages"]).describe("Batch operation"),
      slugs: z.array(z.string().max(500)).min(1).max(100).optional().describe("Page slugs for action=delete_pages"),
      links: z.array(linkInputSchema).min(1).max(100).optional().describe("Links for action=add_links"),
      pairs: z.array(mergePairSchema).min(1).max(50).optional().describe("Merge pairs for action=merge_pages"),
      confirm_large_batch: z.boolean().default(false).describe("Confirm execution for 20+ items/pairs"),
    },
  }, async ({ action, slugs, links, pairs, confirm_large_batch }) =>
    runBatchAction(ctx, action, { slugs, links, pairs, confirm_large_batch }));

  // ─── batch_delete_pages ────────────────────────────────────
  server.registerTool("batch_delete_pages", {
    description:
      "Delete multiple pages in one call. Each slug is deleted with vault cleanup + DB cascade. " +
      "Use this instead of calling delete_page N times for bulk cleanup.",
    inputSchema: {
      slugs: z.array(z.string().max(500)).min(1).max(100).describe("Array of page slugs to delete (max 100)"),
      confirm_large_batch: z.boolean().default(false).describe("Confirm execution for 20+ items. Without this, 20+ items returns preview only."),
    },
  }, async ({ slugs, confirm_large_batch }) => deletePages(ctx, slugs, confirm_large_batch));

  // ─── batch_add_links ───────────────────────────────────────
  server.registerTool("batch_add_links", {
    description:
      "Create multiple links in one call. Each link is validated (both pages must exist, no self-reference). " +
      "Links are marked source_type=agent (agent_inference) with confidence=0.9. To mark links as user-confirmed, use confirm_evidence.",
    inputSchema: {
      links: z.array(linkInputSchema).min(1).max(100).describe("Array of links to create (max 100)"),
      confirm_large_batch: z.boolean().default(false).describe("Confirm execution for 20+ items. Without this, 20+ items returns preview only."),
    },
  }, async ({ links, confirm_large_batch }) => addLinks(ctx, links, confirm_large_batch));

  // ─── batch_merge_pages ─────────────────────────────────────
  server.registerTool("batch_merge_pages", {
    description:
      "Merge multiple page pairs in one call. Each pair: source is absorbed into target, then source is deleted. " +
      "Pairs are processed in order — if a source appears as a target in a later pair, the later pair will fail.",
    inputSchema: {
      pairs: z.array(mergePairSchema).min(1).max(50).describe("Array of merge pairs (max 50)"),
      confirm_large_batch: z.boolean().default(false).describe("Confirm execution for 20+ pairs. Without this, 20+ pairs returns preview only."),
    },
  }, async ({ pairs, confirm_large_batch }) => mergePages(ctx, pairs, confirm_large_batch));
}
