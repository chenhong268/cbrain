import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { setHierarchy, removeHierarchy, getHierarchyContext, getOrgTree } from "../../core/graph/hierarchy.js";
import { formatOrgTreeEnvelope } from "./format-result.js";

export function registerHierarchyTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("set_hierarchy", {
    description:
      "Set the direct manager (reports_to) for an entity. " +
      "This establishes an explicit organizational hierarchy relationship. " +
      "The relationship is stored in both page frontmatter and the knowledge graph.",
    inputSchema: {
      slug: z.string().max(500).describe("Entity slug (e.g. entity/zhang-san)"),
      reports_to: z.string().max(500).describe("Slug of the direct manager"),
    },
  }, async ({ slug, reports_to }) => {
    // Collect old manager before mutation for KR sync
    const page = ctx.pages.getBySlug(slug);
    const oldReportsTo = (page?.frontmatter as Record<string, unknown>)?.reports_to as string | undefined;

    setHierarchy(slug, reports_to, { pages: ctx.pages, graph: ctx.graph });

    // Sync Known Relations for affected slugs
    const affected = [slug, reports_to];
    if (oldReportsTo && oldReportsTo !== reports_to) affected.push(oldReportsTo);
    const setWarnings = ctx.pages.syncAffectedSlugs(affected);

    const manager = ctx.pages.getBySlug(reports_to);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: true,
          slug,
          reports_to,
          manager_title: manager?.title ?? null,
          ...(setWarnings.length > 0 ? { sync_warnings: setWarnings } : {}),
        }, null, 2),
      }],
    };
  });

  server.registerTool("get_hierarchy", {
    description:
      "Get the full hierarchy context for an entity: direct manager, subordinates, and peers.",
    inputSchema: {
      slug: z.string().max(500).describe("Entity slug"),
    },
  }, async ({ slug }) => {
    const hierarchy = getHierarchyContext(slug, { pages: ctx.pages, graph: ctx.graph });
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ slug, ...hierarchy }, null, 2),
      }],
    };
  });

  server.registerTool("remove_hierarchy", {
    description:
      "Remove the reports_to hierarchy for an entity. " +
      "Clears the frontmatter field and removes the graph link.",
    inputSchema: {
      slug: z.string().max(500).describe("Entity slug"),
    },
  }, async ({ slug }) => {
    const removed = removeHierarchy(slug, { pages: ctx.pages, graph: ctx.graph });
    if (!removed) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ error: `${slug} 未设置 reports_to` }),
        }],
        isError: true,
      };
    }
    // Sync Known Relations for slug and old manager
    const removeWarnings = ctx.pages.syncAffectedSlugs([slug, removed]);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ success: true, slug, removed, ...(removeWarnings.length > 0 ? { sync_warnings: removeWarnings } : {}) }, null, 2),
      }],
    };
  });

  // ─── get_org_tree ────────────────────────────────────────
  server.registerTool("get_org_tree", {
    description:
      "获取实体的组织架构树。沿 reports_to 边遍历，返回向上（上级链）和/或" +
      "向下（下属树）的完整层级。接受 slug 或 query（自动解析实体名）。" +
      "多候选时返回候选列表让调用方澄清。",
    inputSchema: {
      slug: z.string().max(500).optional().describe("实体 slug（已知时直接传入）"),
      query: z.string().max(500).optional().describe("实体名称（自动解析，支持模糊匹配）"),
      direction: z.enum(["up", "down", "both"]).optional().default("both").describe("遍历方向：up=上级链, down=下属树, both=完整树"),
      depth: z.number().int().min(1).max(5).optional().default(3).describe("最大遍历深度（1-5，默认 3）"),
      limit: z.number().int().min(1).max(100).optional().default(50).describe("最大返回节点数（1-100，默认 50）"),
      session_id: z.string().max(200).optional().describe("会话 ID，用于学习闭环"),
    },
  }, async ({ slug, query, direction, depth, limit, session_id }) => {
    // Validation: exactly one of slug/query
    if (!slug && !query) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "必须提供 slug 或 query 参数（二选一）" }) }],
        isError: true,
      };
    }
    if (slug && query) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "slug 和 query 只能提供一个，不要同时传" }) }],
        isError: true,
      };
    }

    const start = Date.now();
    let resolvedSlug: string | null = null;

    if (slug) {
      // Direct slug mode — verify it exists
      const page = ctx.pages.getBySlug(slug);
      if (!page) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `实体不存在: ${slug}` }) }],
          isError: true,
        };
      }
      resolvedSlug = slug;
    } else {
      // Query mode — two-phase resolution:
      // Phase 1: exact slug or exact title match → use directly (high confidence)
      // Phase 2: fuzzy title LIKE search → 0/1/many candidates (disambiguation required)
      const exactSlug = exactResolve(ctx, query!);
      if (exactSlug) {
        resolvedSlug = exactSlug;
      } else {
        // Fuzzy search for entity/concept candidates
        const candidates = searchEntityCandidates(ctx, query!);
        if (candidates.length === 0) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "未找到匹配实体", query }) }],
            isError: true,
          };
        }
        if (candidates.length === 1) {
          resolvedSlug = candidates[0].slug;
        } else {
          // Multiple candidates — MUST disambiguate, never silently pick first
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                candidates: candidates.map(c => ({ slug: c.slug, title: c.title })),
                message: "找到多个匹配实体，请指定具体是哪个",
              }),
            }],
          };
        }
      }
    }

    // Build the org tree
    const result = getOrgTree(resolvedSlug, { pages: ctx.pages, graph: ctx.graph }, { direction, depth, limit });
    if (!result) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: `无法构建组织树: ${resolvedSlug}` }) }],
        isError: true,
      };
    }

    // Learning loop: log query + bump weights
    const allSlugs = [result.seed.slug, ...result.upward.map(n => n.slug), ...result.downward.map(n => n.slug)];
    const latency = Date.now() - start;
    try { ctx.db.logQuery("get_org_tree", resolvedSlug, allSlugs, latency, session_id); } catch { /* non-critical */ }
    for (let i = 0; i < allSlugs.length; i++) {
      try { ctx.learn.bumpOnQuery(allSlugs[i], i, "get_org_tree"); } catch { /* non-critical */ }
    }

    const { display, summary, raw } = formatOrgTreeEnvelope(result);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ display, summary, raw, ...result }, null, 2),
      }],
    };
  });
}

/**
 * Exact resolution: checks if query is a valid slug or exactly matches a page title.
 * Returns the slug if found, null otherwise. No fuzzy matching — safe to use directly.
 */
function exactResolve(ctx: ToolContext, query: string): string | null {
  // Check if query is itself a valid slug
  const page = ctx.pages.getBySlug(query);
  if (page) return query;

  // Check exact title match (entity/concept only)
  const titleSlug = ctx.db.getEntitySlugByTitle(query);
  if (titleSlug) return titleSlug;

  // Check exact alias match
  const aliasSlug = ctx.db.getSlugByAlias(query);
  if (aliasSlug) return aliasSlug;

  return null;
}

/**
 * Fuzzy search for entity/concept candidates by title substring match.
 * Returns up to 5 candidates ordered by type priority and mention count.
 * Caller MUST handle multi-candidate disambiguation.
 */
function searchEntityCandidates(ctx: ToolContext, query: string): Array<{ slug: string; title: string }> {
  const pattern = `%${query}%`;
  try {
    const rows = ctx.db.rawDb.prepare(
      `SELECT slug, title FROM pages
       WHERE title LIKE ? AND (type LIKE 'entity/%' OR type LIKE 'concept/%')
       ORDER BY
         CASE WHEN type = 'entity' OR type LIKE 'entity/%' THEN 0
              WHEN type = 'concept' OR type LIKE 'concept/%' THEN 1
              ELSE 2 END,
         mention_count DESC
       LIMIT 5`,
    ).all(pattern) as Array<{ slug: string; title: string }>;
    return rows;
  } catch {
    return [];
  }
}
