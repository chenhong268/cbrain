import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { truncate, safeFrontmatter, trimLink, trimTimeline, getExpiryWarning, trimHint, applyProactiveBudget } from "./trim.js";
import type { Link } from "../../core/graph.js";
import type { LinkRow } from "../../storage/sqlite.js";
import { extractDossier } from "../../core/dossier.js";
import { getHierarchyContext } from "../../core/hierarchy.js";
import { generateProactiveHints } from "../../core/proactive.js";
import { extractBirthday } from "../../core/birthday.js";
import { buildMemorySkeleton } from "../../core/key-points.js";
import { type SearchTrace, applyRecallQualityGate } from "../../core/search.js";
import { classifyDegradedReasons, computeSearchDegraded } from "../../core/search-diagnostics.js";
import { traceToSteps } from "../../core/search-trace.js";
import { buildEvidenceFromBatched, buildEvidenceSummary, collectEvidenceForSlugs, type EvidenceItem } from "../../core/evidence.js";
import { buildGroundedRecall } from "../../core/grounded-answer.js";
import { formatRecallEnvelope, formatGroundedRecallEnvelope } from "./format-result.js";

export function registerRecallTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("deep_recall", {
    description:
      "【默认查询工具】查找人物、公司、概念等实体。默认返回精简视图（200字摘要+基础信息）。" +
      "需要完整上下文（关系、时间线、档案、层级）时传 detail=normal。" +
      "适用：'张三是谁'、'最近聊了什么投资的事'、'XX公司的信息'。" +
      "不要用 search + get_page + graph_query 拼凑，直接用这个一步到位。" +
      "\n\n【grounded 模式 — 仅用于核查确认】用户问以下意图时传 grounded=true：" +
      "'讨论过吗/聊过吗/CBrain里有吗/有没有遗漏/有没有依据/是不是真的/矛盾吗/为什么这么定/上次怎么定的'。" +
      "这些问题需要证据板（区分事实和候选），答案是 yes/no 或 fact/candidate 分类。" +
      "\n\n【内容回忆 — 禁止 grounded】用户问'当时怎么设计/为什么选/具体方案是什么/之前怎么讨论/怎么做的'→ 传 detail=normal，不要传 grounded=true。" +
      "这些要的是内容本身，不是证据分类。" +
      "\n\n【内容回忆首轮硬门控】⚠️ 条件判断，违反即错误：" +
      "if (用户意图 === '内容回忆' && 用户没说'展开/原文/详细全文/逐条展开/继续讲' && recall未返回insufficient/low confidence) {" +
      "  只允许调用 deep_recall 一次。" +
      "  禁止调用: get_page, expand_entity, get_timeline, query, session_search, 第二次deep_recall。" +
      "}" +
      "get_page 的触发条件：用户说'展开/原文/详细' OR recall返回insufficient OR recall返回'未找到相关实体'。不满足则禁止。" +
      "\n\n【回答模板 — 槽位式压缩，硬模板】" +
      "⚠️ 这是槽位填充，不是自由摘要。必须优先填满5个槽位：" +
      "槽位1-核心设计对象：这是什么方案/设计（1句）。" +
      "槽位2-架构/机制：具体架构分层、角色分工、流程机制等。禁止用'AI嵌入流程''新型协作模式'等纯泛化表达替代具体机制。" +
      "槽位3-为什么这样选：约束条件和决策理由。" +
      "槽位4-当时审查意见：你当时的判断和指出的问题（最多2条）。" +
      "槽位5-后续变化：最多1句，格式'另有后续XX变化可能影响方案适用范围'。" +
      "开头固定：'根据 CBrain 摘要记录，可以先还原到这个层级：'" +
      "总字数350-500字。deep_recall返回的结构词必须优先保留：架构层级名称（如三层架构）、角色数量（如6个虚拟经理）、技术名词（如数据安全/数据主权/Harness/Skills）、设计约束（如确定性/概率性）、阶段标记（如试点）。这些不能删，只能删修饰语。" +
      "用词：明确记录→'记录显示'，用户想法→'你当时认为/你当时审查指出'，不确定→'待确认/可能'。" +
      "禁止：'需要看原文/返回的是摘要/我需要看一下原文/要看原文吗/需要我展开吗/我可以继续查/如果你愿意'。" +
      "\n\n【proactive_hints 硬规则】" +
      "grounded=true：禁止展示任何 hint。" +
      "普通 recall：默认不展示 proactive_hints。只有 hint 直接改变当前问题判断时，写成一句'另有一条后续变化可能影响这个判断'，禁止展开。" +
      "禁止使用'💡 主动提示'标题。禁止逐条列出 hints。禁止展开 hint 细节。",
    inputSchema: {
      query: z.string().max(1000).describe("Search query"),
      limit: z.number().optional().default(5).describe("Max entities to recall (capped at 5, only top results are fully enriched)"),
      strategy: z.enum(["smart", "fts", "vector", "all"]).optional().default("smart")
        .describe("smart=FTS first, fallback to hybrid if empty (fastest); fts=FTS only; vector=embedding search; all=full hybrid (slowest)"),
      session_id: z.string().max(200).optional().describe("Current conversation session ID for co-occurrence tracking"),
      detail: z.enum(["normal", "brief"]).optional().default("brief")
        .describe("brief=compact view (default, 200-char body, no dossier/peers/subordinates); normal=full context with all enrichment"),
      multiStep: z.boolean().optional().default(false)
        .describe("多轮深度搜索：自动判断结果充分性、换策略重试、LLM重排序。开启条件：查询模糊/跨领域（如'心理学和投资的关系'）、首次结果不满意、需要全面覆盖时。精确查单个实体（如'阿德勒'）不需要开。"),
      grounded: z.boolean().optional().default(false)
        .describe("【仅用于核查确认】用户问'讨论过吗/聊过吗/CBrain里有吗/有没有遗漏/有没有依据/是不是真的/矛盾吗'时=true。返回证据板（facts/candidates/conflicts）而非实体详情。" +
          "⚠️ 内容回忆（'当时怎么设计的/为什么选/怎么做的'）不要传 grounded，传 detail=normal。"),
    },
  }, async ({ query, limit, strategy, session_id, detail: detailLevel, multiStep, grounded }) => {
    const cap = Math.min(limit ?? 5, 5);
    // Internal fanout: search a wider candidate pool so evidence collection and
    // alias/graph matches are not clipped at the display cap. Display still caps at `cap`.
    const candidateLimit = Math.min(Math.max(cap * 4, 10), 20);
    const trace: SearchTrace = {};

    const searchStart = Date.now();
    let searchResults: Awaited<ReturnType<typeof ctx.search.search>>;
    let usedStrategy: string = strategy ?? "smart";
    let exactSlug: string | null = null;

    // Start trace session BEFORE search to capture real latency
    let traceSessionId: number | undefined;
    try { traceSessionId = ctx.db.startSearchTraceSession({ query, mode: usedStrategy }); } catch { /* non-critical */ }

    if (usedStrategy === "smart") {
      const resolved = ctx.db.resolveSlugs([query])[0];
      exactSlug = resolved?.slug ?? null;

      searchResults = await ctx.search.search(query, { limit: candidateLimit, multiStep, _trace: trace });
      usedStrategy = "smart-hybrid";

      if (exactSlug) {
        const existingIdx = searchResults.findIndex(r => r.slug === exactSlug);
        if (existingIdx > 0) {
          const [match] = searchResults.splice(existingIdx, 1);
          searchResults.unshift({ ...match, score: 1.0 });
        } else if (existingIdx === -1) {
          searchResults.unshift({ slug: exactSlug, score: 1.0, snippet: resolved.title ?? query, source: "exact" as const });
        }
      }
    } else if (usedStrategy === "fts") {
      searchResults = await ctx.search.search(query, { strategy: "fts", limit: candidateLimit, _trace: trace });
    } else if (usedStrategy === "vector") {
      searchResults = await ctx.search.search(query, { strategy: "vector", limit: candidateLimit, _trace: trace });
    } else {
      searchResults = await ctx.search.search(query, { limit: candidateLimit, multiStep, _trace: trace });
    }

    const searchLatencyMs = Date.now() - searchStart;

    // Diagnose degraded search state
    const reasonCodes = classifyDegradedReasons(searchResults, trace, query, cap, searchLatencyMs);

    try {
      const sourceCounts: Record<string, number> = {};
      for (const r of searchResults) { sourceCounts[r.source ?? "unknown"] = (sourceCounts[r.source ?? "unknown"] ?? 0) + 1; }
      const isDegraded = computeSearchDegraded(searchLatencyMs, trace, reasonCodes);
      ctx.db.logSearch(query, usedStrategy, searchLatencyMs, searchResults.length, isDegraded, {
        strategy_path: usedStrategy, ...trace, result_sources: sourceCounts, requested_limit: candidateLimit, multistep: !!multiStep, detail_level: detailLevel ?? "brief",
        reason_codes: reasonCodes,
      });
    } catch { /* non-critical */ }

    // Finish trace session AFTER search with measured latency
    try {
      if (traceSessionId != null) {
        const steps = traceToSteps(traceSessionId, trace);
        for (const step of steps) ctx.db.addSearchTraceStep(step);
        ctx.db.finishSearchTraceSession(traceSessionId, {
          latencyMs: searchLatencyMs,
          status: computeSearchDegraded(searchLatencyMs, trace, reasonCodes) ? "degraded" : "success",
          llmCalls: trace.llm_calls,
          totalSteps: steps.length,
          summaryJson: { ...trace, reason_codes: reasonCodes },
        });
      }
    } catch { /* trace write failure must not break search */ }

    // #230 quality gate BEFORE learning/logging — filtered noise must not enter
    // query log, activity weights, grounded evidence, or proactive hints. Runs
    // on the RAW search score (record-type demotion is applied AFTER the gate
    // and only affects ranking, so a rich record's single-source FTS hit is not
    // filtered out by its demoted score).
    const pagesBySlug = new Map<string, ReturnType<typeof ctx.pages.getBySlug>>();
    for (const sr of searchResults) {
      const p = ctx.pages.getBySlug(sr.slug);
      if (p) pagesBySlug.set(sr.slug, p);
    }
    // candidateCount = wider pool searched. The gate runs on the RAW search score
    // (before record demotion) so a rich record page with a genuine single-source
    // FTS hit (rrf rank-1 ≈ 0.016 > 0.01) survives — record demotion is applied
    // AFTER the gate and only affects ranking, not filtering.
    const candidateCount = searchResults.length;
    // Per-slug link counts so isBareStubCandidate can tell apart true bare stubs
    // (≤1 link) from tier-3 entities that are structurally connected (many links)
    // — without this, a well-connected tier-3 entity would be misclassified.
    const candidateLinks = ctx.db.batchGetLinksForSlugs(searchResults.map(r => r.slug));
    const linkCounts = new Map<string, number>();
    for (const sr of searchResults) {
      const l = candidateLinks.get(sr.slug);
      linkCounts.set(sr.slug, (l?.outgoing.length ?? 0) + (l?.incoming.length ?? 0));
    }
    // Gate pages via db.getPage (vault-independent). PageManager.getBySlug can
    // return null when the vault file is absent, which would silently disable
    // the bare-stub check; db.getPage reads the row directly so the gate always
    // has tier/type/mention_count to decide on.
    const gatePages = new Map<string, { tier?: number; type?: string; mention_count?: number }>();
    for (const sr of searchResults) {
      const p = ctx.db.getPage(sr.slug);
      if (p) gatePages.set(sr.slug, { tier: p.tier, type: p.type, mention_count: p.mention_count });
    }
    const gateResult = applyRecallQualityGate(searchResults, {
      pagesBySlug: gatePages,
      linkCounts,
      exactSlugs: exactSlug ? new Set([exactSlug]) : new Set(),
    });
    searchResults = gateResult.results;

    // Record-type demotion affects RANKING only, not gate filtering. A record
    // page that cleared the gate on raw score is kept but ranked below richer
    // entity/concept evidence — preserves "之前讨论过/当时怎么设计" recall that
    // often depends on record pages with a single-source FTS hit.
    const RECORD_SCORE_FACTOR = 0.5;
    for (const sr of searchResults) {
      if (gatePages.get(sr.slug)?.type === "record") sr.score *= RECORD_SCORE_FACTOR;
    }
    searchResults.sort((a, b) => b.score - a.score);

    // Learning loop: log query + bump activity weights (gate-filtered results only)
    const resultSlugs = searchResults.map(r => r.slug);
    try { ctx.db.logQuery("recall", query, resultSlugs, searchLatencyMs, session_id); } catch { /* non-critical */ }
    for (let i = 0; i < searchResults.length; i++) {
      try { ctx.learn.bumpOnQuery(searchResults[i].slug, i, "recall"); } catch { /* non-critical */ }
    }

    const isSearchDegraded = computeSearchDegraded(searchLatencyMs, trace, reasonCodes);
    // Fanout diagnostics — surfaced ONLY in raw/search_meta, never in display/summary.
    // candidate_count reflects the wider pool searched; truncated/has_more signal that
    // display was capped (distinct from ToolSummary.truncated which tracks _stub bodies).
    const candidateHasMore = candidateCount > cap;
    const diagnosticMeta = {
      strategy: usedStrategy,
      latency_ms: searchLatencyMs,
      degraded: isSearchDegraded || undefined,
      candidate_count: candidateCount,
      ...(candidateHasMore ? { truncated: true, has_more: true } : {}),
      ...(reasonCodes.length > 0 ? { reason_codes: reasonCodes } : {}),
      ...(gateResult.filteredCount > 0 ? { quality_gate: { filtered: gateResult.filteredCount, reason_codes: gateResult.reasonCodes } } : {}),
    };

    if (searchResults.length === 0) {
      if (grounded) {
        const emptyBoard = { facts: [], user_thoughts: [], candidates: [], gaps: [], conflicts: [] as Array<{ claim: string; evidence: EvidenceItem[] }> };
        const groundedResult = buildGroundedRecall(query, emptyBoard);
        const groundedPayload = { query, grounded_answer: groundedResult, search_meta: diagnosticMeta };
        const { display, summary, raw } = formatGroundedRecallEnvelope(groundedPayload);
        const { search_meta: _gm, ...groundedLegacy } = groundedPayload;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ display, summary, raw, ...groundedLegacy }, null, 2),
          }],
        };
      }
      const emptyPayload = { query, entities: [], summary: "暂时没找到相关记忆", search_meta: diagnosticMeta };
      const { display: emptyDisplay, summary: emptySummary, raw: emptyRaw } = formatRecallEnvelope(emptyPayload);
      const { summary: emptyLegacySummary, search_meta: _em, ...emptyRest } = emptyPayload;
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ display: emptyDisplay, summary: emptySummary, raw: emptyRaw, result_summary: emptyLegacySummary, ...emptyRest }, null, 2),
        }],
      };
    }

    // ── Grounded mode: return evidence structure ──
    if (grounded) {
      const board = collectEvidenceForSlugs(ctx.db, resultSlugs);
      const groundedResult = buildGroundedRecall(query, board);

      const groundedPayload = {
        query,
        grounded_answer: groundedResult,
        search_meta: diagnosticMeta,
      };
      const { display: gDisplay, summary: gSummary, raw: gRaw } = formatGroundedRecallEnvelope(groundedPayload);
      const { search_meta: _gm2, ...groundedLegacy2 } = groundedPayload;
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ display: gDisplay, summary: gSummary, raw: gRaw, ...groundedLegacy2 }, null, 2),
        }],
      };
    }

    // ── Batch enrichment for all result entities ─────────────────
    // (pagesBySlug, record-type demotion, and the #230 quality gate already
    // ran above — before learning/logging — so noise never enters query log,
    // activity weights, grounded evidence, or proactive hints.)

    // Fanout: searched candidateLimit candidates; enrich/display only the top `cap`.
    // The wider pool was already consumed for grounded evidence (resultSlugs above)
    // and is surfaced as counts in raw/search_meta — never in display.
    if (searchResults.length > cap) {
      searchResults = searchResults.slice(0, cap);
    }

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
        timelineBySlug.set(slug, trimTimeline(rawTimeline as Array<{ summary: string; event_date: string | null; source: string | null; created_at: string; id: number; trust_state?: string; source_page_slug?: string; evidence?: string; source_type?: string }>, 3));

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
      const birthdayInfo = entityType?.startsWith("entity/") ? extractBirthday(page?.body ?? "") : null;

      const l1Summary = isBrief ? null : ctx.db.getL1Summary(slug);
      const memorySkeleton = isBrief ? undefined : buildMemorySkeleton(
        page?.body, page?.frontmatter, l1Summary?.content,
      );

      return {
        slug,
        title: page?.title ?? slug,
        type: page?.frontmatter?.type ?? page?.type ?? "unknown",
        relevance: sr.score,
        quality,
        tier,
        snippet: sr.detail?.snippet ?? sr.snippet,
        body: truncate(page?.body, isBrief ? 200 : 500),
        frontmatter: safeFrontmatter(page?.frontmatter ?? null),
        ...(isBrief ? {} : {
          dossier: dossier ?? undefined,
          dossier_updated: (page?.frontmatter as Record<string, unknown> | undefined)?.dossier_updated as string | undefined,
          memory_skeleton: memorySkeleton,
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

    // Hotness-based stub: low-hotness entities get trimmed to snippet only
    const hotnessWeights = topSlugs.length > 0 ? ctx.db.getHotnessWeights(topSlugs) : new Map<string, number>();
    for (const e of entities) {
      const slug = (e as { slug: string }).slug;
      const tier = (e as { tier?: number }).tier;
      const hotness = hotnessWeights.get(slug) ?? 0;
      if (hotness < 0.3 && (tier == null || tier >= 3)) {
        (e as Record<string, unknown>)._stub = true;
        if ((e as { body?: string }).body) {
          (e as { body: string }).body = ((e as { snippet?: string }).snippet ?? "").slice(0, 200);
        }
      }
    }

    const totalLinks = entities.reduce(
      (n, e) => n + ((e as { links: { outgoing: unknown[]; incoming: unknown[] } }).links?.outgoing?.length ?? 0) +
        ((e as { links: { outgoing: unknown[]; incoming: unknown[] } }).links?.incoming?.length ?? 0),
      0,
    );
    const totalTimeline = entities.reduce((n, e) => n + ((e as { timeline: unknown[] }).timeline?.length ?? 0), 0);
    const lowQuality = entities.filter((e) => (e as { quality?: string }).quality === "low").length;
    const expiredCount = entities.filter(e => (e as { expiry_warning?: string }).expiry_warning?.startsWith("⚠️")).length;
    const evidenceBoard = buildEvidenceFromBatched(
      batchLinks,
      timelineBySlug as Map<string, Array<{ id: number; event_date: string | null; source: string | null; summary: string; created_at: string; trust_state?: string; source_page_slug?: string; evidence?: string }>>,
      topSlugs,
    );
    const evidenceSummary = buildEvidenceSummary(evidenceBoard) ?? undefined;

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

    try { ctx.db.validateLinksForSlugs(topSlugs); } catch { /* non-critical */ }

    const payload = {
      query,
      search_meta: diagnosticMeta,
      entities,
      evidence_summary: evidenceSummary,
      insights: relatedInsights.length > 0 ? relatedInsights : undefined,
      cross_refs: uniqueRefs.length > 0 ? uniqueRefs : undefined,
      proactive_hints: (() => {
        const budgeted = applyProactiveBudget(proactiveHints.map(trimHint), { grounded: false, toolType: "recall" });
        return budgeted.length > 0 ? budgeted : undefined;
      })(),
      summary: `有 ${entities.length} 条相关记忆${lowQuality > 0 ? `（其中 ${lowQuality} 条信息较少）` : ""}，${totalLinks} 条关系，${totalTimeline} 条时间线` +
        (expiredCount > 0 ? `，${expiredCount} 条已过期` : "") +
        (relatedInsights.length > 0 ? `，${relatedInsights.length} 条相关洞察` : "") +
        (uniqueRefs.length > 0 ? `，${uniqueRefs.length} 条关联更新` : ""),
    };

    const { display, summary: envelopeSummary, raw } = formatRecallEnvelope(payload);
    const { summary: legacySummary, search_meta: _rm, evidence_summary: _es, ...payloadRest } = payload;
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ display, summary: envelopeSummary, raw, result_summary: legacySummary, ...payloadRest }, null, 2),
      }],
    };
  });
}
