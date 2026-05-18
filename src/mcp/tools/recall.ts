import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { truncate, safeFrontmatter, trimLink, trimTimeline, getExpiryWarning, trimHint } from "./trim.js";
import type { Link } from "../../core/graph.js";
import type { LinkRow } from "../../storage/sqlite.js";
import { extractDossier } from "../../core/dossier.js";
import { getHierarchyContext } from "../../core/hierarchy.js";
import { generateProactiveHints } from "../../core/proactive.js";
import { extractBirthday } from "../../core/birthday.js";

export function registerRecallTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("deep_recall", {
    description:
      "【默认查询工具】查找人物、公司、概念等实体。默认返回精简视图（200字摘要+基础信息）。" +
      "需要完整上下文（关系、时间线、档案、层级）时传 detail=normal。" +
      "适用：'张三是谁'、'最近聊了什么投资的事'、'XX公司的信息'。" +
      "不要用 search + get_page + graph_query 拼凑，直接用这个一步到位。" +
      "⚠️ 返回中的 proactive_hints 是系统主动发现的你可能不知道的重要信息（过期提醒、关联人动态、隐藏联系等）。你必须把每一条 hint 原样展示给用户，用 '💡 主动提示：' 开头，逐条列出。不要省略任何一条。",
    inputSchema: {
      query: z.string().describe("Search query"),
      limit: z.number().optional().default(5).describe("Max entities to recall (capped at 5, only top results are fully enriched)"),
      strategy: z.enum(["smart", "fts", "vector", "all"]).optional().default("smart")
        .describe("smart=FTS first, fallback to hybrid if empty (fastest); fts=FTS only; vector=embedding search; all=full hybrid (slowest)"),
      session_id: z.string().optional().describe("Current conversation session ID for co-occurrence tracking"),
      detail: z.enum(["normal", "brief"]).optional().default("brief")
        .describe("brief=compact view (default, 200-char body, no dossier/peers/subordinates); normal=full context with all enrichment"),
    },
  }, async ({ query, limit, strategy, session_id, detail: detailLevel }) => {
    const cap = Math.min(limit ?? 5, 5);

    const searchStart = Date.now();
    let searchResults: Awaited<ReturnType<typeof ctx.search.search>>;
    let usedStrategy: string = strategy;

    if (strategy === "smart") {
      // Exact slug/title match fast path
      const resolved = ctx.db.resolveSlugs([query])[0];
      const exactSlug = resolved?.slug ?? null;

      let ftsRaw: Awaited<ReturnType<typeof ctx.db.ftsSearch>> = [];
      try { ftsRaw = ctx.db.ftsSearch(query, cap); } catch { /* fts failure is non-fatal */ }
      if (ftsRaw.length > 0) {
        searchResults = ftsRaw.map(r => ({ slug: r.page_slug, score: 1 / (1 + r.rank), snippet: r.content.slice(0, 200), source: "fts" as const }));
        usedStrategy = "smart-fts";
      } else {
        searchResults = await ctx.search.search(query, { limit: cap });
        usedStrategy = "smart-hybrid";
      }

      // Promote exact match to top
      if (exactSlug) {
        const existingIdx = searchResults.findIndex(r => r.slug === exactSlug);
        if (existingIdx > 0) {
          const [match] = searchResults.splice(existingIdx, 1);
          searchResults.unshift({ ...match, score: 1.0 });
        } else if (existingIdx === -1) {
          searchResults.unshift({ slug: exactSlug, score: 1.0, snippet: resolved.title ?? query, source: "exact" as const });
        }
      }
    } else if (strategy === "fts") {
      searchResults = await ctx.search.search(query, { strategy: "fts", limit: cap });
    } else if (strategy === "vector") {
      searchResults = await ctx.search.search(query, { strategy: "vector", limit: cap });
    } else {
      searchResults = await ctx.search.search(query, { limit: cap });
    }

    const searchLatencyMs = Date.now() - searchStart;

    try { ctx.db.logSearch(query, usedStrategy, searchLatencyMs, searchResults.length, searchLatencyMs > 2000); } catch { /* non-critical */ }

    // Learning loop: log query + bump activity weights
    const resultSlugs = searchResults.map(r => r.slug);
    try { ctx.db.logQuery("recall", query, resultSlugs, searchLatencyMs, session_id); } catch { /* non-critical */ }
    for (let i = 0; i < searchResults.length; i++) {
      try { ctx.learn.bumpOnQuery(searchResults[i].slug, i, "recall"); } catch { /* non-critical */ }
    }

    if (searchResults.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ query, entities: [], summary: "未找到相关实体" }, null, 2),
        }],
      };
    }

    // ── Batch enrichment for all result entities ─────────────────
    const pagesBySlug = new Map<string, ReturnType<typeof ctx.pages.getBySlug>>();
    for (const sr of searchResults) {
      const p = ctx.pages.getBySlug(sr.slug);
      if (p) pagesBySlug.set(sr.slug, p);
    }

    // Type demotion: record-type results rank lower
    const RECORD_SCORE_FACTOR = 0.5;
    for (const sr of searchResults) {
      const page = pagesBySlug.get(sr.slug);
      const type = page?.frontmatter?.type ?? page?.type;
      if (type === "record") sr.score *= RECORD_SCORE_FACTOR;
    }
    searchResults.sort((a, b) => b.score - a.score);

    // Batch enrichment: collect all slugs, then batch-fetch links/timeline/tags
    const topSlugs = searchResults.map(r => r.slug);
    const isBrief = detailLevel === "brief";

    const linksBySlug = new Map<string, { outgoing: Record<string, unknown>[]; incoming: Record<string, unknown>[] }>();
    const timelineBySlug = new Map<string, Record<string, unknown>[]>();
    const tagsBySlug = new Map<string, string[]>();
    const relatedBySlug = new Map<string, { slug: string; title: string; type: string }[]>();
    const hierarchyBySlug = new Map<string, ReturnType<typeof getHierarchyContext>>();

    // Brief mode: only fetch tags (cheap, always needed); skip heavy enrichment
    const batchLinks = ctx.db.batchGetLinksForSlugs(topSlugs);
    const batchTags = ctx.db.batchGetTagsForSlugs(topSlugs);
    for (const slug of topSlugs) {
      const page = pagesBySlug.get(slug);
      const dbTags = batchTags.get(slug) ?? [];
      const fmTags = (page as { frontmatter?: { tags?: string[] } } | undefined)?.frontmatter?.tags ?? [];
      tagsBySlug.set(slug, [...new Set([...dbTags, ...fmTags])]);
    }

    if (!isBrief) {
      const batchTimeline = ctx.db.batchGetTimelineForSlugs(topSlugs);

      for (const slug of topSlugs) {
        const rawLinks = batchLinks.get(slug) ?? { outgoing: [], incoming: [] };
        const toLink = (l: LinkRow): Link => ({
          ...l, context: l.context ?? undefined, source_type: l.source_type ?? undefined, confidence: l.confidence ?? undefined,
        });
        const outgoing = rawLinks.outgoing.map(toLink).map(trimLink).filter(Boolean) as Record<string, unknown>[];
        const incoming = rawLinks.incoming.map(toLink).map(trimLink).filter(Boolean) as Record<string, unknown>[];
        linksBySlug.set(slug, { outgoing, incoming });

        const rawTimeline = batchTimeline.get(slug) ?? [];
        timelineBySlug.set(slug, trimTimeline(rawTimeline as Array<{ summary: string; event_date: string | null; source: string | null; created_at: string; id: number }>, 3));

        try { relatedBySlug.set(slug, ctx.graph.getRelatedEntities(slug, 5)); } catch { relatedBySlug.set(slug, []); }

        try { hierarchyBySlug.set(slug, getHierarchyContext(slug, { pages: ctx.pages, graph: ctx.graph })); } catch { /* non-critical */ }
      }
    }

    // Build entity objects — all fully enriched (no stubs)
    const entities = searchResults.map((sr) => {
      const slug = sr.slug;
      const page = pagesBySlug.get(slug);
      const links = linksBySlug.get(slug) ?? { outgoing: [], incoming: [] };
      const timeline = timelineBySlug.get(slug) ?? [];
      const tags = tagsBySlug.get(slug) ?? [];
      const related = relatedBySlug.get(slug) ?? [];
      const tier = page?.frontmatter?.tier ?? page?.tier;
      const quality = tier != null
        ? (tier <= 1 ? "high" : tier === 2 ? "ok" : "low")
        : "unknown";

      const dossier = !isBrief && page ? extractDossier(page.body) : undefined;
      const hierarchy = hierarchyBySlug.get(slug);
      const entityType = page?.frontmatter?.type ?? page?.type;
      const birthdayInfo = entityType === "entity" ? extractBirthday(page?.body ?? "") : null;

      return {
        slug,
        title: page?.title ?? slug,
        type: page?.frontmatter?.type ?? page?.type ?? "unknown",
        relevance: sr.score,
        quality,
        tier,
        snippet: sr.snippet,
        body: truncate(page?.body, isBrief ? 200 : 500),
        frontmatter: safeFrontmatter(page?.frontmatter ?? null),
        ...(isBrief ? {} : {
          dossier: dossier ?? undefined,
          dossier_updated: (page?.frontmatter as Record<string, unknown> | undefined)?.dossier_updated as string | undefined,
          links,
          timeline,
          related,
          reports_to: hierarchy?.reports_to ?? undefined,
          reports_to_title: hierarchy?.reports_to_title ?? undefined,
          subordinates: hierarchy?.subordinates.length ? hierarchy.subordinates : undefined,
          peers: hierarchy?.peers.length ? hierarchy.peers : undefined,
        }),
        tags,
        expiry_warning: getExpiryWarning(page?.expires_at),
        birthday: birthdayInfo?.birthday ?? undefined,
        ...(isBrief ? {} : {
          age: birthdayInfo?.age ?? undefined,
          zodiac: birthdayInfo?.zodiac ?? undefined,
          shengxiao: birthdayInfo?.shengxiao ?? undefined,
        }),
      };
    });

    const totalLinks = entities.reduce(
      (n, e) => n + ((e as { links: { outgoing: unknown[]; incoming: unknown[] } }).links?.outgoing?.length ?? 0) +
        ((e as { links: { outgoing: unknown[]; incoming: unknown[] } }).links?.incoming?.length ?? 0),
      0,
    );
    const totalTimeline = entities.reduce((n, e) => n + ((e as { timeline: unknown[] }).timeline?.length ?? 0), 0);
    const lowQuality = entities.filter((e) => (e as { quality?: string }).quality === "low").length;
    const expiredCount = entities.filter(e => (e as { expiry_warning?: string }).expiry_warning?.startsWith("⚠️")).length;

    // Cross-references — single batch query across all top-N entities
    const allRelatedSlugs = new Set<string>();
    for (const slug of topSlugs) {
      const links = linksBySlug.get(slug);
      const related = relatedBySlug.get(slug);
      if (links) {
        for (const l of links.outgoing) allRelatedSlugs.add(l.to_slug as string);
        for (const l of links.incoming) allRelatedSlugs.add(l.from_slug as string);
      }
      if (related) for (const r of related) allRelatedSlugs.add(r.slug);
    }
    const allRecent = allRelatedSlugs.size > 0 ? ctx.db.getRecentUpdatesBySlugs([...allRelatedSlugs], 7) : [];
    const crossRefs: { subject: string; related: string; type: string; updated_at: string }[] = [];
    for (const slug of topSlugs) {
      const entityTitle = (pagesBySlug.get(slug) as { title?: string } | undefined)?.title ?? slug;
      const links = linksBySlug.get(slug);
      const related = relatedBySlug.get(slug);
      const entityRelatedSlugs = new Set<string>();
      if (links) {
        for (const l of links.outgoing) entityRelatedSlugs.add(l.to_slug as string);
        for (const l of links.incoming) entityRelatedSlugs.add(l.from_slug as string);
      }
      if (related) for (const r of related) entityRelatedSlugs.add(r.slug);
      for (const r of allRecent) {
        if (entityRelatedSlugs.has(r.slug)) {
          crossRefs.push({ subject: entityTitle, related: r.title, type: r.type, updated_at: r.updated_at });
        }
      }
    }
    const seen = new Set<string>();
    const uniqueRefs = crossRefs.filter(r => {
      const key = `${r.subject}↔${r.related}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 10);

    // Related insights — single batch call
    const relatedInsights = ctx.insights.getInsightsForEntities(topSlugs, 5).map(i => ({
      id: i.id, type: i.type,
      content: i.content.length > 150 ? i.content.slice(0, 150) + "..." : i.content,
      confidence: i.confidence,
    }));

    // Proactive hints — context-aware suggestions
    const proactiveHints = await generateProactiveHints(ctx, {
      resultSlugs: searchResults.map(r => r.slug),
      linksBySlug: batchLinks,
      pagesBySlug: pagesBySlug as Map<string, { slug: string; expires_at: string | null }>,
      maxHints: 3,
    });

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(
          {
            query,
            search_meta: { strategy: usedStrategy, latency_ms: searchLatencyMs, degraded: searchLatencyMs > 2000 },
            entities,
            insights: relatedInsights.length > 0 ? relatedInsights : undefined,
            cross_refs: uniqueRefs.length > 0 ? uniqueRefs : undefined,
            proactive_hints: proactiveHints.length > 0 ? proactiveHints.map(trimHint) : undefined,
            summary: `找到 ${entities.length} 个实体（${lowQuality} 个低质量），${totalLinks} 个链接，${totalTimeline} 个时间线事件` +
              (expiredCount > 0 ? `，${expiredCount} 个已过期` : "") +
              (relatedInsights.length > 0 ? `，${relatedInsights.length} 条相关洞察` : "") +
              (uniqueRefs.length > 0 ? `，${uniqueRefs.length} 个关联更新` : ""),
          },
          null,
          2,
        ),
      }],
    };
  });
}
