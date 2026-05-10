import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";

export function registerBrainstormTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("brain_storm", {
    description:
      "Deep reasoning and knowledge gap analysis. Unlike search/query which finds existing facts, " +
      "brain_storm SYNTHESIZES and IDENTIFIES WHAT'S MISSING. " +
      "Returns: findings (what the graph knows), gaps (what's missing — the most valuable output), " +
      "connections (cross-domain structural links), search_queries (what to search externally), " +
      "and follow-up questions. " +
      "Use this for: analysis, diagnosis, strategy questions, identifying blind spots, " +
      "cross-domain synthesis. " +
      "Do NOT use for: simple entity lookup, fact retrieval, listing related items (use search/query for those).",
    inputSchema: {
      query: z.string().describe("The question or topic to think about"),
      context: z.string().optional().describe("Additional context (role, situation, background)"),
    },
  }, async ({ query, context }) => {
    const results: {
      findings: string[];
      gaps: string[];
      connections: { type: string; title: string; content: string }[];
      questions: string[];
      suggestions: string[];
      search_queries: string[];
    } = {
      findings: [],
      gaps: [],
      connections: [],
      questions: [],
      suggestions: [],
      search_queries: [],
    };

    if (!ctx.llm) {
      results.gaps.push("LLM not configured — cannot reason");
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    }

    // ── Stage 1: 感知 — multi-path embedding search ──
    const queryText = context ? `${query} ${context}` : query;
    const seen = new Set<string>();
    const fragments: { title: string; type: string; body: string }[] = [];

    try {
      const results1 = await ctx.search.search(queryText, { strategy: "all", limit: 8 });
      const results2 = await ctx.search.search(query, { strategy: "all", limit: 5 });

      for (const r of [...results1, ...results2]) {
        if (seen.has(r.slug)) continue;
        seen.add(r.slug);

        const page = ctx.pages.getBySlug(r.slug);
        if (!page || !page.body || page.body.length < 50) continue;

        fragments.push({
          title: page.title,
          type: page.type,
          body: page.body.substring(0, 600),
        });

        if (fragments.length >= 10) break;
      }
    } catch (e) {
      results.gaps.push(`搜索失败: ${e instanceof Error ? e.message : String(e)}，跳过感知阶段直接推理`);
    }

    // ── Stage 2: 推理+自省 — LLM synthesizes ──
    const analysisPrompt = `You are analyzing a personal knowledge graph to help answer a question. Be intellectually honest — if there's not enough information, say so. Never fabricate.

User question: "${query}"
${context ? `Context: ${context}` : ""}

Knowledge fragments from the graph:
${fragments.map((f, i) => `[${i + 1}] ${f.title} (${f.type}): ${f.body}`).join("\n\n")}
${fragments.length === 0 ? "(No relevant knowledge found in the graph)" : ""}

Analyze and return JSON:
{
  "findings": ["what the knowledge graph DOES contain about this question"],
  "gaps": ["what important information is MISSING — be specific"],
  "questions": ["follow-up questions to ask the user to fill the gaps"],
  "suggestions": ["actionable suggestions based on available knowledge, if any"],
  "connections": [
    {"title": "short insight title", "content": "synthesis connecting different domains (1-2 sentences)", "confidence": 0.0-1.0}
  ],
  "search_queries": ["suggested web search queries to fill knowledge gaps"]
}

Rules:
- All output MUST be in Chinese (the user's knowledge graph is Chinese, all titles and content must be Chinese)
- If knowledge is insufficient, findings can be empty. That's OK.
- gaps must be specific — not "missing info" but "missing: team's current AI tool usage"
- connections: only include if you genuinely discovered a structural connection between different knowledge domains. confidence < 0.7 should not be included. If none, return empty array.
- Do NOT make up facts not in the provided fragments.`;

    let analysis: any;
    try {
      const raw = await ctx.llm.chat([{ role: "user", content: analysisPrompt }]);
      const clean = raw.replace(/```json|```/g, "").trim();
      analysis = JSON.parse(clean);
    } catch {
      results.gaps.push("LLM analysis failed to produce valid output");
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    }

    results.findings = analysis.findings || [];
    results.gaps = analysis.gaps || [];
    results.questions = analysis.questions || [];
    results.suggestions = analysis.suggestions || [];
    results.search_queries = analysis.search_queries || [];

    // ── Stage 3: connections — store structural connections back to CBrain ──
    const connections = (analysis.connections || []) as Array<{
      title: string; content: string; confidence: number;
    }>;

    for (const ins of connections) {
      if ((ins.confidence || 0) < 0.7) continue;
      if (!ins.title || !ins.content) continue;

      try {
        const date = new Date().toISOString().slice(0, 10);
        const fullTitle = `${date} ${ins.title.slice(0, 50)}`;
        const pathPart = fullTitle.replace(/[^一-鿿a-zA-Z0-9\s-]/g, "").replace(/\s+/g, "-").toLowerCase();
        if (pathPart.replace(/-/g, "").length < 3) continue;
        const slug = `brain/insights/${pathPart}`;

        // Avoid duplicates
        if (ctx.db.getPage(slug)) continue;

        ctx.pages.create({
          title: fullTitle,
          type: "insight",
          body: ins.content,
          tags: ["insight/cross-domain", "insight/auto"],
          slug,
        });
        results.connections.push({ type: "connection", title: fullTitle, content: ins.content });
      } catch {
        // Non-blocking
      }
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
    };
  });
}
