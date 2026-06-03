import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { generateDossier, extractDossier, isDossierFresh } from "../../core/dossier.js";

const DEFAULT_MAX_AGE_DAYS = 7;

export function registerDossierTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("dossier", {
    description:
      "Generate or retrieve a structured dossier (brief/profile) for an entity. " +
      "The dossier synthesizes all available data (chunks, links, timeline, related entities) into a " +
      "structured assessment covering: core positioning, key capabilities, risk flags, key relationships, " +
      "and credibility evaluation. Results are cached in the page body and auto-refreshed after " +
      `${DEFAULT_MAX_AGE_DAYS} days. Use force=true to regenerate.`,
    inputSchema: {
      slug: z.string().max(500).describe("Entity slug (e.g. entity/zhang-san)"),
      force: z.boolean().optional().default(false)
        .describe("Force regeneration even if cached dossier is fresh"),
    },
  }, async ({ slug, force }) => {
    const page = ctx.pages.getBySlug(slug);
    if (!page) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: `实体不存在: ${slug}` }) }],
        isError: true,
      };
    }

    if (!ctx.llm) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "LLM 未配置，无法生成档案" }) }],
        isError: true,
      };
    }

    // Check cache
    if (!force) {
      const freshness = isDossierFresh(page.frontmatter, DEFAULT_MAX_AGE_DAYS);
      if (freshness.fresh) {
        const cached = extractDossier(page.body);
        if (cached) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                slug,
                title: page.title,
                dossier: cached,
                cached: true,
                generated_at: freshness.updatedAt,
              }, null, 2),
            }],
          };
        }
      }
    }

    const result = await generateDossier(slug, {
      db: ctx.db,
      pages: ctx.pages,
      graph: ctx.graph,
      llm: ctx.llm,
      pipeline: ctx.pipeline,
      logger: ctx.logger,
    });

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          ...result,
          cached: false,
        }, null, 2),
      }],
    };
  });
}
