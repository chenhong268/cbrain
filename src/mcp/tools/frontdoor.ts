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
import { filterContentCandidates, filterContentFtsFallbackCandidates } from "../../core/retrieval/content-relevance.js";
import { applyPersonalCurrentStateGuard } from "../../core/retrieval/personal-current-state-guard.js";
import { generateProactiveHints } from "../../core/retrieval/proactive.js";
import { applyProactiveBudget, trimHint } from "./trim.js";
import { isFirstPersonQuery } from "../../core/retrieval/recall-intent.js";

type DetailLevel = "brief" | "normal" | "full";

interface FrontdoorEnvelope {
  display: string;
  summary: ToolSummary;
  raw: Record<string, unknown> & { routing: FrontdoorRoutingDecision & { latency_ms: number } };
  resultSlugs: string[];
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
        envelope = runHierarchyRecall(ctx, query, routing);
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
        envelope = await runDebugSearch(ctx, query, routing);
        break;
      default:
        envelope = await runContentRecall(ctx, query, routing, routeDetail);
        break;
    }

    const latencyMs = Date.now() - started;
    envelope.raw.routing.latency_ms = latencyMs;
    try {
      ctx.db.logQuery(`cbrain_recall.${routing.chosen_route}`, query, envelope.resultSlugs, latencyMs, session_id);
    } catch { /* non-critical */ }
    const { resultSlugs: _resultSlugs, ...toolEnvelope } = envelope;
    if (ctx.outputMode === "legacy") {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(toolEnvelope, null, 2) }],
      };
    }
    return buildToolResult({
      mode: ctx.outputMode,
      display: toolEnvelope.display,
      displayStructured: "已完成 CBrain 检索。",
      summary: toolEnvelope.summary,
      summaryStructured: structuredSummary(toolEnvelope.summary, "frontdoor"),
      data: projectFrontdoorData(toolEnvelope.display, toolEnvelope.raw),
      dataKeys: FRONTDOOR_DATA_KEYS,
      raw: toolEnvelope.raw,
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
  return withRouting(formatted, payload, routing, grounded_answer.sources.map((source) => source.slug));
}

async function runContentRecall(
  ctx: ToolContext,
  query: string,
  routing: FrontdoorRoutingDecision,
  detail: DetailLevel,
): Promise<FrontdoorEnvelope> {
  const limit = detail === "brief" ? 3 : 5;
  const identitySeed = await resolveIdentityQuestionSeed(ctx, query);
  const candidates = await ctx.search.search(query, {
    limit,
    _captureSupport: true,
    _skipDetailEnrich: true,
  });
  let results = dedupeCandidatesBySlug(
    filterContentCandidates(
      query,
      identitySeed ? [identitySeed, ...candidates] : candidates,
      identitySeed ? { deterministicIdentitySlugs: new Set([identitySeed.slug]) } : undefined,
    ),
  ).slice(0, limit);
  if (results.length === 0 && !hasExplicitUnknownCue(query)) {
    const ftsCandidates = await ctx.search.search(query, {
      strategy: "fts",
      limit,
      _captureSupport: true,
      _skipDetailEnrich: true,
    });
    results = filterContentFtsFallbackCandidates(query, ftsCandidates);
    if (results.length === 0) {
      results = selectPersonalTimePlaceRecordFallback(ctx, query, ftsCandidates);
      if (results.length === 0) results = selectRecentMeetingRecordFallback(ctx, query, limit);
    }
  }
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
      [],
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
  return withRouting({ display, summary, raw: formatted.raw }, payload, routing, slugs);
}

const IDENTITY_QUESTION_RE = /^([^，,。！？!?；;：:\n]+?)\s*(?:是\s*谁|是\s*什么人|是\s*哪位)\s*[？?。！!]*$/u;

/**
 * Seed a closed-grammar identity question from deterministic local identity
 * evidence. The resolved title is searched through HybridSearch's existing
 * exact path so content-relevance still owns admission; this function never
 * promotes a page directly.
 */
async function resolveIdentityQuestionSeed(
  ctx: ToolContext,
  query: string,
): Promise<import("../../core/retrieval/search.js").SearchResult | null> {
  const subject = extractIdentityQuestionSubject(query);
  if (!subject) return null;
  try {
    const resolved = ctx.db.resolveIdentitySubject(subject);
    if (!resolved) return null;

    const candidates = await ctx.search.search(resolved.title, {
      limit: 1,
      _captureSupport: true,
      _skipDetailEnrich: true,
      _supportRootQuery: query,
      _supportOrigin: "derived",
    });
    return candidates.find((candidate) => candidate.slug === resolved.slug && candidate.source === "exact") ?? null;
  } catch {
    // The identity seed is an optional bounded rescue. Preserve the existing
    // hybrid/FTS path when its resolver or exact probe is unavailable.
    return null;
  }
}

function extractIdentityQuestionSubject(query: string): string | null {
  try {
    let normalized = query.normalize("NFKC").trim();
    if (normalized.startsWith("请问")) {
      normalized = normalized.slice(2).trimStart().replace(/^[，,:：]\s*/u, "");
      if (normalized.startsWith("请问")) return null;
    }
    const subject = normalized.match(IDENTITY_QUESTION_RE)?.[1]?.trim();
    if (!subject) return null;
    const length = Array.from(subject).length;
    return length >= 2 && length <= 40 ? subject : null;
  } catch {
    return null;
  }
}

function dedupeCandidatesBySlug(
  candidates: readonly import("../../core/retrieval/search.js").SearchResult[],
): import("../../core/retrieval/search.js").SearchResult[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.slug)) return false;
    seen.add(candidate.slug);
    return true;
  });
}

function hasExplicitUnknownCue(query: string): boolean {
  // A caller who explicitly says the clue is unknown is not asking us to turn
  // a partial keyword overlap into a fact. Keep the normal empty response.
  return /(?:未知|不清楚|不确定)/u.test(query);
}

const PERSONAL_ACTIVITY_RE = /(?:做了什么|干了什么|参加了什么|开了什么|去了哪里|见了谁|发生了什么)/u;
const RECORD_ACTIVITY_RE = /(?:会议|会面|拜访|沟通|讨论|参加|主持|到访|出席|培训|调研|出差|处理|完成|安排|跟进|访问)/u;
const EXPLICIT_DATE_RE = /(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?/u;
const RELATIVE_DATE_RE = /(今天|昨天|前天)/u;
const TIME_PLACE_FALLBACK_DOMINANCE_RATIO = 2;

/**
 * Narrow rescue for a first-person question about an explicitly dated activity
 * at an explicitly named place. This is deliberately after normal content and
 * FTS admission: it is only for record pages where the configured identity,
 * date, and place can all be proven from one page body.
 */
function selectPersonalTimePlaceRecordFallback(
  ctx: Pick<ToolContext, "identityPersonSlug" | "pages">,
  query: string,
  candidates: readonly import("../../core/retrieval/search.js").SearchResult[],
): import("../../core/retrieval/search.js").SearchResult[] {
  const evidence = parsePersonalTimePlaceQuery(query);
  if (!evidence || !ctx.identityPersonSlug) return [];

  const identityPage = ctx.pages.getBySlug(ctx.identityPersonSlug);
  if (!identityPage?.title) return [];

  const strongestBySlug = new Map<string, import("../../core/retrieval/search.js").SearchResult>();
  for (const candidate of candidates) {
    if (candidate.source !== "fts" || !Number.isFinite(candidate.score) || candidate.score <= 0) continue;
    const current = strongestBySlug.get(candidate.slug);
    if (!current || candidate.score > current.score) strongestBySlug.set(candidate.slug, candidate);
  }
  const [top, runnerUp] = [...strongestBySlug.values()].sort((left, right) => right.score - left.score);
  if (!top || (runnerUp && top.score < runnerUp.score * TIME_PLACE_FALLBACK_DOMINANCE_RATIO)) return [];

  const page = ctx.pages.getBySlug(top.slug);
  if (page?.type !== "record") return [];
  if (!recordBodyMatchesPersonalTimePlace(page.body, identityPage.title, evidence)) return [];
  return [top];
}

/**
 * #424: a closed recent-meeting question may have no trigram hits at all.
 * This permanent, bounded rescue reads existing indexes then verifies source
 * text; it neither infers geography nor promotes records into trusted facts.
 * Revisit with #424 if the shared content-recall path gains equivalent support.
 */
function selectRecentMeetingRecordFallback(
  ctx: Pick<ToolContext, "identityPersonSlug" | "pages" | "db" | "logger">,
  query: string,
  limit: number,
): import("../../core/retrieval/search.js").SearchResult[] {
  const match = query.normalize("NFKC").trim().match(/^我(?:最近|近期)在([^，,。？！?\n]{2,24})参加(?:了|过)?(?:什么|哪些)会议[？?]?$/u);
  if (!match || !ctx.identityPersonSlug) return [];
  const identity = ctx.pages.getBySlug(ctx.identityPersonSlug)?.title;
  if (!identity) return [];
  const place = match[1]!.trim();
  const results: import("../../core/retrieval/search.js").SearchResult[] = [];
  for (const slug of ctx.db.findRecentMeetingRecordCandidates(place)) {
    const page = ctx.pages.getBySlug(slug);
    if (page?.type !== "record" || page.body.length > 32_000) continue;
    const evidence = recentMeetingEvidence(page.body, identity, place);
    if (!evidence) continue;
    results.push({ slug, score: evidence.date, snippet: evidence.text, source: "fts" });
  }
  results.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
  // Scalar-only observation; never log identity, location, title or source text.
  ctx.logger?.info("recall", "recent meeting record rescue", { accepted: results.length });
  return results.slice(0, limit);
}

function recentMeetingEvidence(body: string, identity: string, place: string): { date: number; text: string } | null {
  const escapedIdentity = identity.normalize("NFKC").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const actor = new RegExp(`(?:^|[\\s，,:：])${escapedIdentity}\\s*(?:作为(?:参会人|代表|主持人)[，,]?\\s*)?(?:(?:在|于)[^，,。；;\\n]{1,60})?\\s*(?:参加|出席|主持)(?:了|过)?[^。；;\\n]{0,60}(?:会议|例会|研讨会)`, "u");
  const attendee = /(?:参会人|参会人员|出席人员|主持人)[:：]\s*([^\n。]+)/u;
  const today = new Date();
  const end = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  // A newly supported "recent" rescue uses the past 30 calendar days. Source
  // event dates, never file modification/ingestion dates, determine eligibility.
  const start = end - 29 * 86_400_000;
  const normalized = body.normalize("NFKC").replace(/\*\*/gu, "").replace(/^\s*[-*] +/gmu, "").replace(/^ {1,3}(?=#{1,6} )/gmu, "");
  const field = /^(?:(?:会议|活动)?(?:日期|时间)|地点|城市|区域|会议|参会人|参会人员|出席人员|主持人)[:：]/u;
  // Collapse spacing only inside a contiguous metadata group, not between
  // unrelated prose events. Keep the meeting heading with its metadata.
  const lines: string[] = [];
  let blank = false;
  for (const line of normalized.split("\n")) {
    if (!line.trim()) { blank = true; continue; }
    const before = lines.at(-1)?.trim() ?? "";
    if (blank && !(field.test(line.trim()) && (field.test(before) || /^#{1,6} /u.test(before)))) lines.push("");
    lines.push(line);
    blank = false;
  }
  const compact = lines.join("\n");
  const blocks = compact.split(/\n\s*\n/u);
  // A single-event meeting record may put its attendee roster in a table.
  // Multiple event headings or dates remain ambiguous and are not combined.
  if ([...compact.matchAll(/^# /gmu)].length === 1 && /^# .*会议/mu.test(compact)
    && !/^#{2,6} (?!会议(?:性质|背景|议程|概况|说明|信息)\s*$)[^\n]*(?:会议|例会|研讨会)/mu.test(compact)) blocks.push(compact);
  for (const block of blocks) {
    const fieldFamilies = [/^[ \t]*(?:会议|活动)?(?:日期|时间)[:：]/gmu, /^[ \t]*(?:地点|城市|区域)[:：]/gmu, /^[ \t]*(?:参会人|参会人员|出席人员|主持人)[:：]/gmu, /^[ \t]*会议[:：]/gmu];
    if (fieldFamilies.some(pattern => [...block.matchAll(pattern)].length > 1)) continue;
    const dates = [...block.matchAll(/(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?/gu)];
    if (dates.length !== 1) continue; // Do not borrow a new date for an old event.
    const eventDate = dates[0]!;
    const datePrefix = block.slice(0, eventDate.index).split("\n").at(-1)!.trim();
    if (!/^(?:(?:会议|活动)?(?:日期|时间)[:：]\s*)?$/u.test(datePrefix)) continue;
    const [, y, m, d] = eventDate;
    const date = Date.UTC(Number(y), Number(m) - 1, Number(d));
    const parsed = new Date(date);
    if (parsed.getUTCFullYear() !== Number(y) || parsed.getUTCMonth() !== Number(m) - 1 || parsed.getUTCDate() !== Number(d) || date < start || date > end) continue;
    if (!/(?:会议|例会|研讨会)/u.test(block)) continue;
    if (/(?:未参会|拟参会|计划参会|未参加|未出席|未在|没有参加|没有出席|未能|未曾|并未|不曾|没有到场|未到场|缺席|待确认|待核实|是否|[?？]|计划|拟参加|将参加|取消)/u.test(block)) continue;
    const actors = attendee.exec(block)?.[1]?.split(/[、，,\s]+/u) ?? [];
    const narrative = actor.exec(block)?.[0];
    const tableRow = [...block.matchAll(/^#{2,6} [^\n]*参会人员\s*\n((?:\|[^\n]*(?:\n|$))+)/gmu)]
      .flatMap(match => match[1]!.split("\n"))
      .find(line => line.split("|")[1]?.trim().replace(/^\[\[|\]\]$/gu, "") === identity.normalize("NFKC"));
    if (!narrative && !actors.includes(identity.normalize("NFKC")) && !tableRow) continue;
    const location = narrative?.match(/(?:在|于)([^，,。；;\n]{1,80}?)(?:参加|出席|主持)/u)?.[1]
      ?? (actors.length > 0 || tableRow ? block.match(/(?:地点|城市|区域)[:：]\s*([^\n。]+)/u)?.[1] : undefined);
    if (!location) continue;
    // Direct place or explicit city(region) notation, not a region mentioned
    // in the meeting's agenda. No hard-coded city-to-region dictionary.
    const loc = location.trim();
    const regional = loc.match(/^[^()]{1,24}\((?:属于|位于)?([^()]+)\)$/u)?.[1];
    if (loc !== place && regional?.trim() !== place && !(tableRow && loc.split(/[，,]/u)[0]?.trim() === place)) continue;
    // Show the proof, even when the record begins with a long introduction.
    const text = block.split("\n").filter(line => line.includes(eventDate[0])
      || (narrative ? line.includes(narrative) : field.test(line.trim()) || /^#{1,6} .*会议/u.test(line) || line === tableRow || /^#{2,6} .*参会人员/u.test(line))).join("\n").trim();
    if (text.length > 1_500) continue; // Never truncate away accepted evidence.
    return { date, text };
  }
  return null;
}

type PersonalTimePlaceEvidence = {
  readonly year: string;
  readonly month: string;
  readonly day: string;
  readonly place: string;
};

function parsePersonalTimePlaceQuery(query: string): PersonalTimePlaceEvidence | null {
  if (!isFirstPersonQuery(query) || !PERSONAL_ACTIVITY_RE.test(query)) return null;
  try {
    const normalized = query.normalize("NFKC").trim();
    const date = resolvePersonalQueryDate(normalized);
    if (!date) return null;
    const activity = normalized.search(PERSONAL_ACTIVITY_RE);
    const prefix = normalized.slice(0, activity);
    const placeMarker = Math.max(prefix.lastIndexOf("在"), prefix.lastIndexOf("于"));
    if (placeMarker < 0) return null;
    const place = prefix.slice(placeMarker + 1).replace(EXPLICIT_DATE_RE, "").trim();
    if (Array.from(place).length < 2 || Array.from(place).length > 24) return null;
    return { ...date, place };
  } catch {
    return null;
  }
}

function resolvePersonalQueryDate(query: string): Omit<PersonalTimePlaceEvidence, "place"> | null {
  const explicit = query.match(EXPLICIT_DATE_RE);
  if (explicit) return { year: explicit[1]!, month: explicit[2]!, day: explicit[3]! };
  const relative = query.match(RELATIVE_DATE_RE)?.[1];
  if (!relative) return null;
  const offset = relative === "今天" ? 0 : relative === "昨天" ? -1 : -2;
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return {
    year: String(date.getFullYear()),
    month: String(date.getMonth() + 1),
    day: String(date.getDate()),
  };
}

function recordBodyMatchesPersonalTimePlace(
  body: string,
  identityTitle: string,
  evidence: PersonalTimePlaceEvidence,
): boolean {
  try {
    const normalized = body.normalize("NFKC");
    const date = new RegExp(
      `${evidence.year}\\s*(?:年|[-/.])\\s*0?${Number(evidence.month)}\\s*(?:月|[-/.])\\s*0?${Number(evidence.day)}\\s*日?`,
      "u",
    );
    return normalized.includes(identityTitle.normalize("NFKC"))
      && normalized.includes(evidence.place)
      && RECORD_ACTIVITY_RE.test(normalized)
      && date.test(normalized);
  } catch {
    return false;
  }
}

function runEpisodeRecall(
  ctx: ToolContext,
  query: string,
  routing: FrontdoorRoutingDecision,
): FrontdoorEnvelope {
  const recaller = new EpisodicRecaller(ctx.db);
  const payload = recaller.recall({ query, limit: 5 });
  const formatted = formatEpisodeEnvelope(payload);
  return withRouting(formatted, payload as unknown as Record<string, unknown>, routing, payload.candidates.map((candidate) => candidate.slug));
}

function runHierarchyRecall(
  ctx: ToolContext,
  query: string,
  routing: FrontdoorRoutingDecision,
): FrontdoorEnvelope {
  const seedSlug = resolveSeedSlug(ctx, query);
  if (!seedSlug) {
    const payload = { query, entities: [], summary: "未找到可展开组织架构的实体" };
    const formatted = formatRecallEnvelope(payload);
    return withRouting(formatted, payload, routing, []);
  }

  const result = getOrgTree(seedSlug, { pages: ctx.pages, graph: ctx.graph }, { direction: "both", depth: 3, limit: 50 });
  if (!result) {
    const payload = { query, entities: [], summary: "无法构建组织架构" };
    const formatted = formatRecallEnvelope(payload);
    return withRouting(formatted, payload, routing, []);
  }

  const allSlugs = [result.seed.slug, ...result.upward.map((n) => n.slug), ...result.downward.map((n) => n.slug)];
  const formatted = formatOrgTreeEnvelope(result);
  return withRouting(formatted, result as unknown as Record<string, unknown>, routing, allSlugs);
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
  return withRouting(formatted, payload, routing, selected.map((result) => result.slug));
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
    resultSlugs: result.answer_context.sourceSlugs.map((source) => source.slug),
  };
}

async function runDebugSearch(
  ctx: ToolContext,
  query: string,
  routing: FrontdoorRoutingDecision,
): Promise<FrontdoorEnvelope> {
  const results = await ctx.search.search(query, { strategy: "all", limit: 10 });
  const payload = {
    results,
    search_meta: { strategy: "frontdoor-debug" },
  };
  const formatted = formatQueryEnvelope(payload);
  return withRouting(formatted, payload, routing, results.map((result) => result.slug));
}

function withRouting(
  formatted: { display: string; summary: ToolSummary; raw: object },
  payload: object,
  routing: FrontdoorRoutingDecision,
  resultSlugs: string[] = [],
): FrontdoorEnvelope {
  return {
    display: formatted.display,
    summary: formatted.summary,
    raw: { ...(payload as Record<string, unknown>), routing: { ...routing, latency_ms: 0 } },
    resultSlugs,
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
