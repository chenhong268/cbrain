import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { classifyFrontdoorQuery, type FrontdoorRoutingDecision } from "../../core/retrieval/frontdoor-router.js";
import { EpisodicRecaller } from "../../core/retrieval/episodic-recall.js";
import { getOrgTree } from "../../core/graph/hierarchy.js";
import { AgenticResearchPipeline } from "../../core/agentic/pipeline.js";
import type { SearchPlanIntent } from "../../core/agentic/plan.js";
import { buildGroundedRecall } from "../../core/retrieval/grounded-answer.js";
import { collectEvidenceForSlugs } from "../../core/retrieval/evidence.js";
import { shouldCompleteEvidence } from "../../core/retrieval/recall-intent.js";
import { assembleEvidencePack } from "../../core/retrieval/evidence-completion.js";
import {
  formatEpisodeEnvelope,
  formatGroundedRecallEnvelope,
  formatOrgTreeEnvelope,
  formatQueryEnvelope,
  formatRecallEnvelope,
  formatSummarizeEnvelope,
  sanitizeDisplay,
  type ToolSummary,
} from "./format-result.js";
import { buildToolResult } from "./result-builder.js";
import { FRONTDOOR_DATA_KEYS, projectFrontdoorData, structuredSummary } from "./recall-output.js";
import { filterContentCandidates } from "../../core/retrieval/content-relevance.js";
import { applyPersonalCurrentStateGuard } from "../../core/retrieval/personal-current-state-guard.js";
import { generateProactiveHints } from "../../core/retrieval/proactive.js";
import { applyProactiveBudget, trimHint } from "./trim.js";

type DetailLevel = "brief" | "normal" | "full";

interface FrontdoorEnvelope {
  display: string;
  summary: ToolSummary;
  raw: Record<string, unknown> & { routing: FrontdoorRoutingDecision & { latency_ms: number } };
}

const DETAIL_BUDGET: Record<DetailLevel, { max_ms: number; max_searches: number; max_llm_calls: number }> = {
  brief: { max_ms: 3000, max_searches: 3, max_llm_calls: 1 },
  normal: { max_ms: 7000, max_searches: 6, max_llm_calls: 2 },
  full: { max_ms: 15000, max_searches: 12, max_llm_calls: 5 },
};

export function registerFrontdoorTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("cbrain_recall", {
    description:
      "CBrain 自然语言前门。Hermes 面向用户提问时优先调用本工具，由 CBrain 决定走证据核查、内容回忆、情境找人、组织架构、全貌总结、关系分析、复杂判断或 debug 搜索。" +
      "返回 display/summary/raw；用户只读 display/summary，raw 仅供调试和后续工具调用。",
    inputSchema: {
      query: z.string().max(1000).describe("用户的自然语言问题"),
      detail: z.enum(["brief", "normal", "full"]).optional().default("brief").describe("返回深度：brief=首轮短答，normal=标准，full=展开"),
      session_id: z.string().max(200).optional().describe("当前会话 ID，用于学习闭环"),
      include_raw: z.boolean().optional().default(false)
        .describe("structured 模式下为 true 时返回脱敏后的 audit.raw；默认 false。legacy 模式保持原输出。"),
    },
  }, async ({ query, detail, session_id, include_raw }) => {
    const started = Date.now();
    const routing = classifyFrontdoorQuery(query);
    const routeDetail = detail ?? "brief";

    let envelope: FrontdoorEnvelope;
    switch (routing.chosen_route) {
      case "grounded_recall":
        envelope = await runGroundedRecall(ctx, query, routing);
        break;
      case "episodic_recall":
        envelope = runEpisodeRecall(ctx, query, routing);
        break;
      case "hierarchy":
        envelope = runHierarchyRecall(ctx, query, routing, session_id);
        break;
      case "overview":
        envelope = await runOverviewRecall(ctx, query, routing);
        break;
      case "relationship":
        envelope = await runAgenticRecall(ctx, query, routing, routeDetail, "relationship");
        break;
      case "reasoning":
        envelope = await runAgenticRecall(ctx, query, routing, routeDetail, "gap_analysis");
        break;
      case "debug_search":
        envelope = await runDebugSearch(ctx, query, routing, session_id);
        break;
      default:
        envelope = await runContentRecall(ctx, query, routing, routeDetail);
        break;
    }

    envelope.raw.routing.latency_ms = Date.now() - started;
    if (ctx.outputMode === "legacy") {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
      };
    }
    return buildToolResult({
      mode: ctx.outputMode,
      display: envelope.display,
      displayStructured: "已完成 CBrain 检索。",
      summary: envelope.summary,
      summaryStructured: structuredSummary(envelope.summary, "frontdoor"),
      data: projectFrontdoorData(envelope.display, envelope.raw),
      dataKeys: FRONTDOOR_DATA_KEYS,
      raw: envelope.raw,
      includeRaw: include_raw ?? false,
    });
  });
}

async function runGroundedRecall(
  ctx: ToolContext,
  query: string,
  routing: FrontdoorRoutingDecision,
): Promise<FrontdoorEnvelope> {
  const results = await ctx.search.search(query, { limit: 10 });
  const slugs = results.map((r) => r.slug);
  const board = collectEvidenceForSlugs(ctx.db, slugs);
  const grounded_answer = buildGroundedRecall(query, board);
  const payload = { query, grounded_answer };
  const formatted = formatGroundedRecallEnvelope(payload);
  return withRouting(formatted, payload, routing);
}

async function runContentRecall(
  ctx: ToolContext,
  query: string,
  routing: FrontdoorRoutingDecision,
  detail: DetailLevel,
): Promise<FrontdoorEnvelope> {
  const limit = detail === "brief" ? 3 : 5;
  const candidates = await ctx.search.search(query, {
    limit,
    _captureSupport: true,
    _skipDetailEnrich: true,
  });
  const results = filterContentCandidates(query, candidates);
  // #385 — personal current-state guard: bounded, deterministic check before
  // presenting reminder-like search material as a current personal recommendation.
  // Activates only for a closed grammar (first-person + action/temporal intent).
  // Non-personal queries short-circuit (activated=false) with zero DB work.
  // Fails closed to insufficient-current-context when a trusted subject-to-topic
  // chain cannot be proven — search material is NOT surfaced as current advice.
  const guardResult = applyPersonalCurrentStateGuard(
    ctx.db,
    ctx.pages,
    query,
    results,
    ctx.identityPersonSlug,
  );
  if (guardResult.activated && guardResult.outcome === "insufficient_current_context") {
    const insufficientPayload = {
      query,
      entities: [] as Array<{ title: string; snippet: string }>,
      // #385: same-subject candidates are auditable context only. They are
      // deliberately not called evidence because topic relevance is unverified.
      ...(guardResult.subjectContextCandidates && guardResult.subjectContextCandidates.length > 0
        ? { subject_context_candidates: guardResult.subjectContextCandidates }
        : {}),
      summary: "无法确认当前个人状态，需要更明确的上下文",
    };
    const formatted = formatRecallEnvelope(insufficientPayload);
    const hasCandidates = !!guardResult.subjectContextCandidates && guardResult.subjectContextCandidates.length > 0;
    const display =
      guardResult.gap === "identity_mapping"
        ? `无法确认「${query}」的当前个人状态。没有可用的个人身份映射。`
        : guardResult.gap === "subject_relation"
          ? `无法确认「${query}」的当前个人状态。未找到有限范围内的受信主体关联。`
          : hasCandidates
            ? `无法确认「${query}」的当前个人状态。已找到同主体候选上下文，但尚未验证与此问题相关，缺少结构化状态信息。`
            : `无法确认「${query}」的当前个人状态。已有受信主体关联，但没有可用的语义日期状态记录。`;
    const nextSteps =
      guardResult.gap === "subject_relation"
        ? ["直接查阅相关记录", "补充主体与主题的关联"]
        : guardResult.gap === "identity_mapping"
          ? ["配置明确的个人身份映射", "直接查阅相关记录"]
          : ["直接查阅记录确认当前状态", "补充结构化状态或有效期信息"];
    return withRouting(
      {
        display,
        summary: {
          ...formatted.summary,
          status: "degraded" as const,
          degraded_reason: `个人当前状态上下文不足：${guardResult.reason ?? "未知原因"}`,
          next_steps: nextSteps,
        },
        raw: formatted.raw,
      },
      insufficientPayload,
      routing,
    );
  }
  // #385 — guard never passes for personal current-state queries (phase-1
  // always insufficient). This path is only reached for non-personal queries
  // where the guard did not activate.
  const slugs = results.map((r) => r.slug);
  const pagesBySlug = new Map<string, { slug: string; expires_at: string | null }>();
  const entities = results.map((r) => {
    const page = ctx.pages.getBySlug(r.slug);
    if (page) {
      pagesBySlug.set(r.slug, { slug: page.slug, expires_at: page.expires_at });
    }
    return {
      title: page?.title ?? r.slug,
      snippet: r.snippet,
      ...(detail !== "brief" ? { body: page?.body?.slice(0, 500) ?? "" } : {}),
    };
  });
  // #399 — keep the default cbrain_recall content path aligned with deep_recall:
  // generate bounded, explainable proactive hints from the accepted result set.
  // The shared budget keeps at most one hint and suppresses stale/duplicate noise.
  const proactiveHints = await generateProactiveHints(ctx, {
    resultSlugs: slugs,
    pagesBySlug,
    maxHints: 3,
  });
  const budgetedProactiveHints = applyProactiveBudget(
    proactiveHints.map(trimHint),
    { grounded: false, toolType: "recall" },
  );
  // #232 — reuse the same evidence-completion helper as deep_recall. Fires only
  // on temporal/history intent; the pack rides in `raw` (frontdoor's contract is
  // always-raw for detail, distinct from deep_recall's #231 compact gate), and
  // insufficient coverage surfaces as display text + summary.status.
  const evidencePack =
    shouldCompleteEvidence(query, "auto") && slugs.length > 0
      ? assembleEvidencePack(ctx.db, slugs, query)
      : undefined;
  const payload = {
    query,
    entities,
    ...(budgetedProactiveHints.length > 0 ? { proactive_hints: budgetedProactiveHints } : {}),
    ...(evidencePack ? { evidence_pack: evidencePack } : {}),
    summary: entities.length > 0 ? `有 ${entities.length} 条相关记忆` : "暂时没找到相关记忆",
  };
  const formatted = formatRecallEnvelope(payload);
  const surfaceInsufficient =
    !!evidencePack &&
    evidencePack.coverage.coverage_status !== "sufficient" &&
    formatted.summary.status !== "empty";
  const display = surfaceInsufficient ? `只找到部分线索：${formatted.display}` : formatted.display;
  const summary = surfaceInsufficient
    ? { ...formatted.summary, status: "degraded" as const, degraded_reason: "证据覆盖不足" }
    : formatted.summary;
  return withRouting({ display, summary, raw: formatted.raw }, payload, routing);
}

function runEpisodeRecall(
  ctx: ToolContext,
  query: string,
  routing: FrontdoorRoutingDecision,
): FrontdoorEnvelope {
  const recaller = new EpisodicRecaller(ctx.db);
  const payload = recaller.recall({ query, limit: 5 });
  const formatted = formatEpisodeEnvelope(payload);
  return withRouting(formatted, payload as unknown as Record<string, unknown>, routing);
}

function runHierarchyRecall(
  ctx: ToolContext,
  query: string,
  routing: FrontdoorRoutingDecision,
  sessionId?: string,
): FrontdoorEnvelope {
  const seedSlug = resolveSeedSlug(ctx, query);
  if (!seedSlug) {
    const payload = { query, entities: [], summary: "未找到可展开组织架构的实体" };
    const formatted = formatRecallEnvelope(payload);
    return withRouting(formatted, payload, routing);
  }

  const result = getOrgTree(seedSlug, { pages: ctx.pages, graph: ctx.graph }, { direction: "both", depth: 3, limit: 50 });
  if (!result) {
    const payload = { query, entities: [], summary: "无法构建组织架构" };
    const formatted = formatRecallEnvelope(payload);
    return withRouting(formatted, payload, routing);
  }

  const allSlugs = [result.seed.slug, ...result.upward.map((n) => n.slug), ...result.downward.map((n) => n.slug)];
  try { ctx.db.logQuery("cbrain_recall.hierarchy", query, allSlugs, 0, sessionId); } catch { /* non-critical */ }

  const formatted = formatOrgTreeEnvelope(result);
  return withRouting(formatted, result as unknown as Record<string, unknown>, routing);
}

async function runOverviewRecall(
  ctx: ToolContext,
  query: string,
  routing: FrontdoorRoutingDecision,
): Promise<FrontdoorEnvelope> {
  const results = await ctx.search.search(query, { limit: 5 });
  const selected = results.slice(0, 5);
  const entities = selected.map((r) => {
    const page = ctx.pages.getBySlug(r.slug);
    const entity: { title: string; snippet: string; type?: string } = {
      title: page?.title ?? r.slug,
      snippet: r.snippet,
    };
    if (page?.type) entity.type = page.type;
    return entity;
  });

  // #395 — batch-read active links + timeline once over the bounded selection
  // (no N+1). totalLinks = Σ active outgoing + incoming rows; totalEvents =
  // Σ active timeline rows (active = batch default includeInactive=false:
  // trust_state NULL or not rejected/superseded). Deliberately NOT reusing
  // hydrateRecallSlugs / isCurrentFactLink — that reports_to trust-state
  // filter is a recall-display concern, not overview's 全貌概览 semantics; the
  // #395 contract scopes the count to active rows (not deduped, not
  // isCurrentFactLink-filtered), so candidate reports_to edges are included.
  // Missing map entries count as zero (defensive — batch methods pre-seed every
  // slug, but never trust that here). Empty selection stays all-zero, no batches.
  let totalLinks = 0;
  let totalEvents = 0;
  if (selected.length > 0) {
    const slugs = selected.map((r) => r.slug);
    const linksBySlug = ctx.db.batchGetLinksForSlugs(slugs);
    const timelineBySlug = ctx.db.batchGetTimelineForSlugs(slugs);
    for (const slug of slugs) {
      const links = linksBySlug.get(slug);
      if (links) totalLinks += links.outgoing.length + links.incoming.length;
      const timeline = timelineBySlug.get(slug);
      if (timeline) totalEvents += timeline.length;
    }
  }

  const payload = {
    topic: query,
    entities,
    stats: { totalEntities: entities.length, totalLinks, totalEvents },
  };
  const formatted = formatSummarizeEnvelope(payload);
  return withRouting(formatted, payload, routing);
}

async function runAgenticRecall(
  ctx: ToolContext,
  query: string,
  routing: FrontdoorRoutingDecision,
  detail: DetailLevel,
  intentHint: SearchPlanIntent,
): Promise<FrontdoorEnvelope> {
  const pipeline = new AgenticResearchPipeline({
    db: ctx.db,
    search: ctx.search,
    graph: ctx.graph,
    pages: ctx.pages,
    llm: ctx.llm,
  });
  const result = await pipeline.run({
    query,
    intentHint,
    budgetOverride: DETAIL_BUDGET[detail],
  });
  const evidenceCount =
    result.evidence_board.facts.length +
    result.evidence_board.user_thoughts.length +
    result.evidence_board.candidates.length +
    result.evidence_board.conflicts.length +
    result.evidence_board.gaps.length;
  const display = sanitizeDisplay(`已完成分析：找到 ${evidenceCount} 条证据线索。`);
  const summary: ToolSummary = {
    status: result.status === "ok" || result.status === "partial" ? "ok" : result.status === "insufficient" ? "empty" : "degraded",
    count: evidenceCount,
    truncated: false,
    message: `已完成分析，证据线索 ${evidenceCount} 条`,
  };
  return {
    display,
    summary,
    raw: { result: mapSafe(result), routing: { ...routing, latency_ms: 0 } },
  };
}

async function runDebugSearch(
  ctx: ToolContext,
  query: string,
  routing: FrontdoorRoutingDecision,
  sessionId?: string,
): Promise<FrontdoorEnvelope> {
  const results = await ctx.search.search(query, { strategy: "all", limit: 10 });
  const payload = {
    results,
    search_meta: { strategy: "frontdoor-debug" },
  };
  try { ctx.db.logQuery("cbrain_recall.debug", query, results.map((r) => r.slug), 0, sessionId); } catch { /* non-critical */ }
  const formatted = formatQueryEnvelope(payload);
  return withRouting(formatted, payload, routing);
}

function withRouting(
  formatted: { display: string; summary: ToolSummary; raw: object },
  payload: object,
  routing: FrontdoorRoutingDecision,
): FrontdoorEnvelope {
  return {
    display: formatted.display,
    summary: formatted.summary,
    raw: { ...(payload as Record<string, unknown>), routing: { ...routing, latency_ms: 0 } },
  };
}

function resolveSeedSlug(ctx: ToolContext, query: string): string | null {
  const exact = ctx.db.resolveSlugs([query])[0]?.slug;
  if (exact) return exact;

  const containedTitle = findContainedEntityTitle(ctx, query);
  if (containedTitle) return containedTitle;

  const tokenCandidates = query
    .split(/[\s,，。！？、；：()（）]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  const tokenResolved = ctx.db.resolveSlugs(tokenCandidates).find((r) => r.slug)?.slug;
  if (tokenResolved) return tokenResolved;

  return findContainedEntityTitle(ctx, query);
}

function findContainedEntityTitle(ctx: ToolContext, query: string): string | null {
  try {
    const rows = ctx.db.rawDb.prepare(
      `SELECT slug, title FROM pages
       WHERE (type = 'entity' OR type LIKE 'entity/%' OR type = 'concept' OR type LIKE 'concept/%')
       ORDER BY length(title) DESC, mention_count DESC
       LIMIT 200`,
    ).all() as Array<{ slug: string; title: string }>;
    const hit = rows.find((row) => row.title.length >= 2 && query.includes(row.title));
    return hit?.slug ?? null;
  } catch {
    return null;
  }
}

function mapSafe(value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(value);
  if (Array.isArray(value)) return value.map(mapSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, mapSafe(v)]));
  }
  return value;
}
