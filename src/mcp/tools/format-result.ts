import type { IngestResult } from "../../core/ingestion/ingest.js";
import type { DialogueIngestResult } from "../../core/ingestion/dialogue.js";
import type { EpisodicRecallResult } from "../../core/retrieval/episodic-recall.js";
import type { OrgTreeResult } from "../../core/graph/hierarchy.js";
import type { Link, GraphNode, GraphPath } from "../../core/graph/graph.js";
import type { HealthReport } from "../../core/maintenance/health.js";
import { planRepairs, type SignalLookup } from "../../core/maintenance/health-debt.js";
import { sanitizeDisplayText } from "../../core/safety/display-safety.js";
import { getOntology } from "../../ontology/loader.js";

// ─── Types ──────────────────────────────────────────────────

export interface CaptureEnvelope<T> {
  display: string;
  summary: {
    status: "recorded" | "skipped" | "needs_review";
    title: string | null;
    captured: { entities: number; relations: number; events: number } | null;
    message: string;
  };
  raw: T;
}

export interface ToolSummary {
  status: "ok" | "empty" | "degraded" | "error";
  count: number;
  truncated: boolean;
  message: string;
  degraded_reason?: string;
  next_steps?: string[];
  /** Lightweight evidence signal for Hermes — short, human-safe. */
  evidence_count?: number;
  confidence?: "high" | "medium" | "low";
}

export function toolEnvelope<T>(
  raw: T,
  display: string,
  summary: ToolSummary,
): { display: string; summary: ToolSummary; raw: T } {
  return { display, summary, raw };
}

type ToolSummaryOptions = Partial<Omit<ToolSummary, "status" | "count" | "message">>;

function makeSummary(
  status: ToolSummary["status"],
  count: number,
  message: string,
  options: ToolSummaryOptions = {},
): ToolSummary {
  return {
    status,
    count,
    truncated: false,
    message,
    ...options,
  };
}

function okEnvelope<T>(
  raw: T,
  display: string,
  count: number,
  message: string,
  options?: ToolSummaryOptions,
): { display: string; summary: ToolSummary; raw: T } {
  return toolEnvelope(raw, display, makeSummary("ok", count, message, options));
}

function emptyEnvelope<T>(
  raw: T,
  display: string,
  message: string,
  options?: ToolSummaryOptions,
): { display: string; summary: ToolSummary; raw: T } {
  return toolEnvelope(raw, display, makeSummary("empty", 0, message, options));
}

function errorEnvelope<T>(
  raw: T,
  display: string,
  message: string,
  options?: ToolSummaryOptions,
): { display: string; summary: ToolSummary; raw: T } {
  return toolEnvelope(raw, display, makeSummary("error", 0, message, options));
}

// ─── Internal identifier sanitization ───────────────────────

const SLUG_PATH_RE = /brain\/(?:entities|concepts|insights|records)\//g;

/**
 * Structured display-sanitization rule. `scope` is intent metadata for
 * maintainers (which surface the term applies to); `sanitizeDisplay` strips
 * every term regardless of scope, preserving prior behavior (#256).
 */
export interface DisplayBannedTermRule {
  term: string;
  reason: string;
  scope: "display" | "summary" | "display_summary" | "global";
}

/**
 * Structured banned-term rules. Each entry says why a term is banned and which
 * surface it applies to. Order matches the historical flat list so the derived
 * `DISPLAY_BANNED_TERMS` is identical to the pre-refactor array.
 */
export const DISPLAY_BANNED_TERM_RULES: readonly DisplayBannedTermRule[] = [
  { term: "score",           reason: "retrieval ranking score; internal signal, meaningless to user",        scope: "display_summary" },
  { term: "distance",        reason: "vector distance; internal similarity signal",                          scope: "display_summary" },
  { term: "debug",           reason: "debug flag/field; never user content",                                 scope: "global" },
  { term: "trace",           reason: "execution trace; internal audit data",                                 scope: "global" },
  { term: "threshold",       reason: "internal scoring threshold parameter",                                 scope: "display_summary" },
  { term: "latency_ms",      reason: "latency in milliseconds; internal performance metric",                  scope: "display_summary" },
  { term: "vector",          reason: "vector-search internal term",                                          scope: "display_summary" },
  { term: "degraded_reason", reason: "internal field name; summary carries it structured, display must not echo the raw name", scope: "display" },
  { term: "_stub",           reason: "stub placeholder for an unfilled entity",                              scope: "display_summary" },
  { term: "reason_codes",    reason: "degradation reason-code list; internal diagnostics",                   scope: "display_summary" },
  { term: "candidate",       reason: "candidate/unconfirmed internal marker",                                scope: "display_summary" },
  { term: "raw",             reason: "raw payload field name; internal only",                                scope: "global" },
  { term: "fts",             reason: "full-text search internal term",                                       scope: "display_summary" },
  { term: "lancedb",         reason: "vector store implementation name",                                     scope: "display_summary" },
];

/**
 * Terms that must never appear in display/summary text. Shared by formatters
 * and tests. Derived from `DISPLAY_BANNED_TERM_RULES` so the flat list cannot
 * drift from the structured rules.
 */
export const DISPLAY_BANNED_TERMS: string[] = DISPLAY_BANNED_TERM_RULES.map((r) => r.term);

/**
 * Strip internal slug paths and banned internal terms from display text.
 * "brain/entities/person-a" → "person-a"
 */
export function sanitizeDisplay(text: string): string {
  let cleaned = text.replace(SLUG_PATH_RE, "");
  for (const term of DISPLAY_BANNED_TERMS) {
    cleaned = cleaned.replace(new RegExp(`\\b${term}\\b`, "g"), "");
  }
  return cleaned;
}

// ─── Ingest ─────────────────────────────────────────────────

export function formatIngestResult(
  result: IngestResult,
  effectiveTitle: string,
): CaptureEnvelope<IngestResult> {
  // Duplicate detection — short-circuit before created/updated logic
  if (result.outcome === "duplicate" && result.duplicateOf) {
    const display = `这份内容已经存在于《${result.duplicateOf.title}》，未重复存入。`;
    return {
      display,
      summary: {
        status: "skipped",
        title: result.duplicateOf.title,
        captured: null,
        message: display,
      },
      raw: result,
    };
  }

  const action = result.created ? "已记住" : "已更新";
  const hasNer = result.ner != null;
  const entities = result.ner?.entities ?? 0;
  const relations = result.ner?.relations ?? 0;
  const events = result.ner?.events ?? 0;

  // Build display — only include non-zero NER counts
  const parts: string[] = [`${action}：${effectiveTitle}。`];

  if (hasNer) {
    const nerParts: string[] = [];
    if (entities > 0) nerParts.push(`${entities} 个实体`);
    if (relations > 0) nerParts.push(`${relations} 条关系`);
    if (events > 0) nerParts.push(`${events} 个事件`);
    if (nerParts.length > 0) parts.push(`提取了${nerParts.join("、")}。`);
  } else if (result.linksExtracted > 0) {
    parts.push(`提取了 ${result.linksExtracted} 个链接。`);
  }

  const display = parts.join("");

  return {
    display,
    summary: {
      status: "recorded",
      title: effectiveTitle,
      captured: hasNer ? { entities, relations, events } : null,
      message: display,
    },
    raw: result,
  };
}

// ─── Dialogue ───────────────────────────────────────────────

const SKIP_REASON_LABELS: Record<string, string> = {
  "empty input": "输入为空",
  "llm error": "暂时没能完成记录，稍后可以再试",
  "parse failed": "暂时没能完成记录，稍后可以再试",
  "no actionable facts": "这段对话没有需要长期记住的新事实",
};

export function formatDialogueResult(
  result: DialogueIngestResult,
): CaptureEnvelope<DialogueIngestResult> {
  if (result.decision === "recorded") {
    const parts: string[] = ["已记住对话中的信息。"];
    const detailParts: string[] = [];
    if (result.newEntities > 0) detailParts.push(`${result.newEntities} 个新实体`);
    if (result.newRelations > 0) detailParts.push(`${result.newRelations} 条新关系`);
    if (result.newEvents > 0) detailParts.push(`${result.newEvents} 个新事件`);
    if (detailParts.length > 0) parts.push(detailParts.join("、") + "。");

    const display = parts.join("");
    return {
      display,
      summary: {
        status: "recorded",
        title: null,
        captured: {
          entities: result.newEntities,
          relations: result.newRelations,
          events: result.newEvents,
        },
        message: display,
      },
      raw: result,
    };
  }

  if (result.decision === "needs_review") {
    const display = "对话内容需要进一步确认。";
    return {
      display,
      summary: {
        status: "needs_review",
        title: null,
        captured: { entities: 0, relations: 0, events: 0 },
        message: display,
      },
      raw: result,
    };
  }

  // decision === "skipped"
  const reasonLabel = SKIP_REASON_LABELS[result.reason ?? ""] ?? "内容已跳过";
  const display = `对话未记录：${reasonLabel}。`;
  return {
    display,
    summary: {
      status: "skipped",
      title: null,
      captured: {
        entities: result.newEntities,
        relations: result.newRelations,
        events: result.newEvents,
      },
      message: display,
    },
    raw: result,
  };
}

// ─── Tool Envelope Formatters ──────────────────────────────────
//
// All formatters return { display, summary, raw }.
// Tool handlers then spread: { display, summary, raw, result_summary?, ...rest }.
// `result_summary` preserves the old summary string for backward compat.

interface RecallPayload {
  query: string;
  entities?: Array<{ title?: string; _stub?: boolean }>;
  evidence_summary?: {
    confidence: "high" | "medium" | "low";
    top_facts: string[];
    gap_count: number;
    conflict_count: number;
    total_evidence: number;
  };
  search_meta?: { degraded?: boolean; latency_ms?: number };
  summary?: string;
}

export function formatRecallEnvelope(payload: RecallPayload): {
  display: string;
  summary: ToolSummary;
  raw: RecallPayload;
} {
  const entities = payload.entities ?? [];
  const count = entities.length;
  const isDegraded = payload.search_meta?.degraded === true;

  if (count === 0) {
    return {
      display: `暂时没找到和「${payload.query}」相关的记忆。`,
      summary: {
        status: "empty",
        count: 0,
        truncated: false,
        message: "暂时没找到相关记忆",
        next_steps: ["尝试换个关键词", "用 deep_recall 换一种搜索策略"],
      },
      raw: payload,
    };
  }

  const topNames = entities
    .filter(e => !e._stub)
    .slice(0, 3)
    .map(e => e.title ?? "未知")
    .join("、");

  const es = payload.evidence_summary;

  const display = isDegraded
    ? sanitizeDisplay(`搜索花的时间长了些，先返回了 ${count} 条结果${topNames ? `，最接近的是${topNames}。` : "。"}`)
    : sanitizeDisplay(`CBrain 里有 ${count} 条相关记忆${topNames ? `，最接近的是${topNames}。` : "。"}`);

  return {
    display,
    summary: {
      status: isDegraded ? "degraded" : "ok",
      count,
      truncated: entities.some(e => e._stub),
      message: payload.summary ?? `有 ${count} 条相关记忆`,
      degraded_reason: isDegraded ? "搜索超时，降级到部分结果" : undefined,
      evidence_count: es?.total_evidence,
      confidence: es?.confidence,
    },
    raw: payload,
  };
}

/** Grounded recall has its own display logic — evidence board, not entity count. */
interface GroundedRecallPayload {
  query: string;
  grounded_answer: { facts?: unknown[]; candidates?: unknown[]; gaps?: unknown[]; conflicts?: unknown[]; confidence?: string };
  search_meta?: { degraded?: boolean; latency_ms?: number };
}

export function formatGroundedRecallEnvelope(payload: GroundedRecallPayload): {
  display: string;
  summary: ToolSummary;
  raw: GroundedRecallPayload;
} {
  const ga = payload.grounded_answer;
  const facts = ga.facts?.length ?? 0;
  const candidates = ga.candidates?.length ?? 0;
  const gaps = ga.gaps?.length ?? 0;
  const conflicts = ga.conflicts?.length ?? 0;
  const isDegraded = payload.search_meta?.degraded === true;

  const signalCount = facts + candidates + conflicts + gaps;

  const parts: string[] = [];
  if (signalCount === 0) {
    parts.push(`关于「${payload.query}」，暂时还没找到明确的依据。`);
  } else {
    parts.push(`关于「${payload.query}」，`);
    if (facts > 0) parts.push(`有 ${facts} 条依据支持。`);
    if (candidates > 0) parts.push(`还有 ${candidates} 条线索需要确认。`);
    if (conflicts > 0) parts.push(`其中 ${conflicts} 处说法不一致。`);
    if (gaps > 0) parts.push(`另有 ${gaps} 处还缺信息。`);
  }
  const display = sanitizeDisplay(parts.join(""));

  return {
    display,
    summary: {
      status: isDegraded ? "degraded" : (signalCount > 0 ? "ok" : "empty"),
      count: signalCount,
      truncated: false,
      message: `${facts} 条依据、${candidates} 处待确认、${conflicts} 处不一致、${gaps} 处待补充`,
      degraded_reason: isDegraded ? "搜索超时" : undefined,
    },
    raw: payload,
  };
}

interface QueryPayload {
  results?: Array<{ snippet?: string }>;
  degraded?: boolean;
  vector_skipped?: string;
  latency_ms?: number;
  search_meta?: { strategy?: string; latency_ms?: number; degraded?: boolean; reason_codes?: string[] };
}

export function formatQueryEnvelope(payload: QueryPayload): {
  display: string;
  summary: ToolSummary;
  raw: QueryPayload;
} {
  const count = payload.results?.length ?? 0;

  if (count === 0) {
    return toolEnvelope(
      payload,
      "没有找到相关内容。",
      {
        status: "empty",
        count: 0,
        truncated: false,
        message: "没有找到相关内容",
        next_steps: ["尝试换关键词", "用 deep_recall 代替 query"],
      },
    );
  }

  if (payload.degraded) {
    // Vector-specific messages only when vector_skipped is set
    const reasonLabel = payload.vector_skipped === "timeout"
      ? "搜索超时了"
      : payload.vector_skipped === "error"
        ? "搜索出错了"
        : "搜索未达最佳效果";
    const reason = payload.vector_skipped === "timeout"
      ? "搜索超时"
      : payload.vector_skipped === "error"
        ? "搜索出错"
        : "搜索未达最佳效果";
    return toolEnvelope(
      payload,
      sanitizeDisplay(`${reasonLabel}，先返回了 ${count} 条相关内容。`),
      {
        status: "degraded",
        count,
        truncated: false,
        message: `搜索降级，先返回 ${count} 条结果`,
        degraded_reason: reason,
      },
    );
  }

  return toolEnvelope(
    payload,
    sanitizeDisplay(`找到 ${count} 条相关内容。`),
    {
      status: "ok",
      count,
      truncated: false,
      message: `找到 ${count} 条结果`,
    },
  );
}

interface AppendPayload {
  action: string;
  title?: string | null;
  new_length?: number;
  relations_added?: number;
  fields_updated?: string[];
  needs_review?: boolean;
  warnings?: string[];
}

/**
 * append_page envelope — surfaces safe structure-update counts to the agent
 * without leaking slugs, paths, or trust internals into display/summary.
 */
export function formatAppendEnvelope(payload: AppendPayload): {
  display: string;
  summary: ToolSummary;
  raw: AppendPayload;
} {
  const title = payload.title ?? "该页面";
  const rels = payload.relations_added ?? 0;
  const fields = payload.fields_updated ?? [];
  const needsReview = payload.needs_review === true;
  const hasWarnings = (payload.warnings?.length ?? 0) > 0;

  const parts: string[] = [`已追加内容到《${title}》。`];
  if (rels > 0) parts.push(`新增 ${rels} 条关系。`);
  if (fields.length > 0) parts.push(`更新 ${fields.length} 个字段。`);
  if (needsReview) parts.push("部分字段需人工确认。");
  const display = sanitizeDisplay(parts.join(""));

  return {
    display,
    summary: {
      status: hasWarnings ? "degraded" : "ok",
      count: rels,
      truncated: false,
      message: needsReview
        ? "已追加内容，部分字段需人工确认"
        : `已追加内容，新增 ${rels} 条关系`,
      ...(hasWarnings ? { degraded_reason: "部分同步失败" } : {}),
    },
    raw: payload,
  };
}

interface GetPagePayload {
  title?: string | null;
  body_length?: number;
  has_more?: boolean;
  slug?: string;
  error?: string;
}

export function formatGetPageEnvelope(payload: GetPagePayload): {
  display: string;
  summary: ToolSummary;
  raw: GetPagePayload;
} {
  if (payload.error) {
    return emptyEnvelope(payload, "页面不存在。", "页面不存在");
  }

  const title = payload.title ?? "未知页面";
  const length = payload.body_length ?? 0;
  const truncated = payload.has_more === true;
  const lengthNote = truncated ? "只显示了前面一部分" : "内容完整";

  return okEnvelope(
    payload,
    sanitizeDisplay(`《${title}》，${length} 字，${lengthNote}。`),
    1,
    `《${title}》，${length} 字`,
    { truncated },
  );
}

interface SummarizePayload {
  topic: string;
  entities?: Array<{ title?: string; _stub?: boolean }>;
  stats?: {
    totalEntities?: number;
    detailEntities?: number;
    stubEntities?: number;
    totalLinks?: number;
    totalEvents?: number;
  };
  search_meta?: { degraded?: boolean };
  summary?: string;
}

export function formatSummarizeEnvelope(payload: SummarizePayload): {
  display: string;
  summary: ToolSummary;
  raw: SummarizePayload;
} {
  const entities = payload.entities ?? [];
  const count = entities.length;
  const stats = payload.stats;

  if (count === 0) {
    return {
      display: `未找到与「${payload.topic}」相关的内容。`,
      summary: {
        status: "empty",
        count: 0,
        truncated: false,
        message: "未找到相关内容",
        next_steps: ["尝试换个关键词", "缩小搜索范围"],
      },
      raw: payload,
    };
  }

  const links = stats?.totalLinks ?? 0;
  const events = stats?.totalEvents ?? 0;
  const isDegraded = payload.search_meta?.degraded === true;

  const display = sanitizeDisplay(
    `围绕「${payload.topic}」攒了一组材料：${count} 个人物或概念、${links} 条关系、${events} 条时间线。`,
  );

  return {
    display,
    summary: {
      status: isDegraded ? "degraded" : "ok",
      count,
      truncated: (stats?.stubEntities ?? 0) > 0,
      message: payload.summary ?? `围绕「${payload.topic}」有 ${count} 条记忆`,
      degraded_reason: isDegraded ? "搜索超时" : undefined,
    },
    raw: payload,
  };
}

export function formatEpisodeEnvelope(result: EpisodicRecallResult): {
  display: string;
  summary: ToolSummary;
  raw: EpisodicRecallResult;
} {
  const count = result.candidates.length;

  if (count === 0) {
    return {
      display: "根据提供的线索，未找到匹配的人物。",
      summary: {
        status: "empty",
        count: 0,
        truncated: false,
        message: "未找到匹配的人物",
        next_steps: ["提供更多线索（时间、地点、事件）", "尝试用 deep_recall 搜索"],
      },
      raw: result,
    };
  }

  const names = result.candidates
    .slice(0, 3)
    .map(c => c.title)
    .join("、");

  return {
    display: sanitizeDisplay(`根据线索，匹配到 ${count} 位：${names}。`),
    summary: {
      status: "ok",
      count,
      truncated: result.candidates.length > 3,
      message: result.summary,
    },
    raw: result,
  };
}

export function formatOrgTreeEnvelope(result: OrgTreeResult): {
  display: string;
  summary: ToolSummary;
  raw: OrgTreeResult;
} {
  const upCount = result.upward.length;
  const downCount = result.downward.length;
  const total = 1 + upCount + downCount;
  const title = result.seed.title;

  return {
    display: sanitizeDisplay(
      `找到 ${title} 的上下级脉络：上级链 ${upCount} 层，下属 ${downCount} 人。`,
    ),
    summary: {
      status: "ok",
      count: total,
      truncated: false,
      message: `${title} 的组织架构，共 ${total} 人`,
    },
    raw: result,
  };
}

interface DiscoveriesPayload {
  display?: string;
  cards?: Array<{ title?: string }>;
  summary?: string;
  /**
   * Cards surfaced in a parallel surface (e.g. the Knowledge Map surface) that
   * are intentionally NOT mixed into `cards`. They still count toward the
   * summary status/count so a parallel-surface-only response is not misread as
   * "empty". #244
   */
  extraCardCount?: number;
}

export function formatDiscoveriesEnvelope(payload: DiscoveriesPayload): {
  display: string;
  summary: ToolSummary;
  raw: DiscoveriesPayload;
} {
  const count = (payload.cards?.length ?? 0) + (payload.extraCardCount ?? 0);

  if (count === 0) {
    return {
      display: payload.display ?? "今天暂无新的发现。",
      summary: {
        status: "empty",
        count: 0,
        truncated: false,
        message: payload.summary ?? "暂无新发现",
      },
      raw: payload,
    };
  }

  // Reuse existing display text if available
  const display = payload.display
    ? sanitizeDisplay(payload.display)
    : `今天有 ${count} 条值得关注的发现。`;

  return {
    display,
    summary: {
      status: "ok",
      count,
      truncated: false,
      message: payload.summary ?? `有 ${count} 条发现`,
    },
    raw: payload,
  };
}

/** Batch page retrieval envelope — ok/partial/empty based on found vs missing. */
interface GetPagesPayload {
  slugs: string[];
  detail: "brief" | "normal";
  found: number;
  missing: number;
  items?: Record<string, unknown>[];
  missingSlugs?: string[];
}

export function formatGetPagesEnvelope(payload: GetPagesPayload): {
  display: string;
  summary: ToolSummary;
  raw: GetPagesPayload;
} {
  const { slugs, found, missing } = payload;
  const total = slugs.length;

  if (found === 0) {
    return toolEnvelope(
      payload,
      `所有 ${total} 个页面均不存在。`,
      {
        status: "empty",
        count: 0,
        truncated: false,
        message: `所有 ${total} 个页面均不存在`,
        next_steps: ["检查名称是否正确", "用 query 搜索正确名称"],
      },
    );
  }

  if (missing > 0) {
    return toolEnvelope(
      payload,
      sanitizeDisplay(`找到 ${found} 个页面，${missing} 个不存在。`),
      {
        status: "degraded",
        count: found,
        truncated: false,
        message: `找到 ${found} 个页面，${missing} 个不存在`,
        degraded_reason: "部分页面不存在",
      },
    );
  }

  return toolEnvelope(
    payload,
    sanitizeDisplay(`找到 ${found} 个页面。`),
    {
      status: "ok",
      count: found,
      truncated: false,
      message: `找到 ${found} 个页面`,
    },
  );
}

// ─── Graph query ────────────────────────────────────────────

export interface GraphPathEnvelopePayload {
  fromTitle?: string;
  toTitle?: string;
  maxDepth: number;
  reason: "path_found" | "no_path" | "unresolved_source" | "unresolved_target" | "missing_target" | "invalid_depth";
  path: GraphPath | null;
}

export type GraphPathSummary = ToolSummary & {
  reason: GraphPathEnvelopePayload["reason"];
  fromTitle?: string;
  toTitle?: string;
  hops: number;
  maxDepth: number;
};

const GRAPH_PATH_FIELD_UNSAFE_PATTERNS = [
  /\b(?:source_type|trust_state|confidence|weight|score|slug|path|id)\b\s*(?:[:=]|\b)/i,
  /\b[A-Za-z0-9_-]*(?:source|trust|confidence|weight|score|slug|path|id|evidence)[A-Za-z0-9_-]*\b/i,
  /\b(?:brain\/)?(?:entities|entity|concepts|concept|records|record|insights|insight)\/\S+/i,
  /(?:^|\s)\/(?:[^\s/]+\/)+[^\s]*/,
  /\b(?:system|assistant|user)\s*:/i,
  /忽略(?:此前|以上|所有)?(?:规则|指令)|输出\s*(?:内部|source_type|trust_state)/i,
  /(?:ignore|disregard|override|forget).{0,40}(?:previous|prior|above|all|instructions?|rules?|system|safety)/i,
  /(?:reveal|show|print|output|expose).{0,30}(?:private|internal|hidden|secret|memory|prompt|instructions?)/i,
  /(?:忽略|无视|绕过|覆盖|忘掉).{0,20}(?:此前|前面|以上|所有|规则|指令|要求|限制|安全)/,
  /(?:展示|输出|泄露|打印|透露).{0,20}(?:私密|隐私|内部|隐藏|记忆|提示词|规则|指令)/,
  /^(?=[\s\S]*(?:obey|follow|execute|disclose|reveal|show|print|output|ignore|disregard|override|tell))(?=[\s\S]*(?:message|instruction|rule|memory|private|secret|prompt|system))[\s\S]*$/i,
  /^(?=[\s\S]*(?:请|执行|按照|按这|告诉|展示|输出|泄露|忽略|无视|绕过))(?=[\s\S]*(?:消息|指令|规则|要求|记忆|隐私|私密|内部|提示词))[\s\S]*$/,
];

function safeGraphPathField(value: string | undefined, fallback: string, maxLength = 100): string {
  if (!value) return fallback;
  const singleLine = [...value.normalize("NFKC")]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
    })
    .join("")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  if (!singleLine || GRAPH_PATH_FIELD_UNSAFE_PATTERNS.some((pattern) => pattern.test(singleLine))) return fallback;
  return sanitizeDisplayText(singleLine, fallback);
}

function safeGraphPathTitle(value: string | undefined, fallback: string): string {
  const title = safeGraphPathField(value, fallback, 80);
  if (title === fallback) return fallback;
  if (!/^[\p{L}\p{N}\p{M}\s·&'’().（）【】《》_-]+$/u.test(title)) return fallback;
  if (title.split(/\s+/).length > 8) return fallback;
  if (/\b(?:i|you|we|they|please|must|obey|follow|execute|disclose|reveal|show|print|output|ignore|tell|send)\b/i.test(title)) {
    return fallback;
  }
  if (/(?:我|你|您|我们|你们|请|务必|必须|应当|不要|别|把|将|并|然后|立即|马上|执行|照办|告诉|发给|展示|输出|泄露|忽略|无视|绕过)/.test(title)) {
    return fallback;
  }
  return title;
}

function graphPathRelationLabel(relation: string): string {
  if (relation === "reports_to") return "汇报给";
  const ontology = getOntology();
  const direct = ontology.getRelationType(relation);
  if (direct) return safeGraphPathField(direct.label, "关联", 40);
  const resolved = ontology.resolveAlias(relation);
  if (resolved !== "提及" || relation === "提及" || relation === "mentions") {
    return safeGraphPathField(ontology.getRelationType(resolved)?.label ?? resolved, "关联", 40);
  }
  return "关联";
}

export function formatGraphPathEnvelope(payload: GraphPathEnvelopePayload): {
  display: string;
  summary: GraphPathSummary;
  raw: GraphPathEnvelopePayload;
} {
  const safeFromTitle = payload.fromTitle ? safeGraphPathTitle(payload.fromTitle, "起点实体") : undefined;
  const safeToTitle = payload.toTitle ? safeGraphPathTitle(payload.toTitle, "目标实体") : undefined;
  if (payload.reason !== "path_found") {
    const status = payload.reason === "no_path" ? "empty" : "error";
    const displayByReason: Record<Exclude<GraphPathEnvelopePayload["reason"], "path_found">, string> = {
      no_path: safeFromTitle && safeToTitle
        ? `在 ${payload.maxDepth} 跳范围内，未找到 ${safeFromTitle} 与 ${safeToTitle} 的连接。`
        : "在指定范围内未找到关系路径。",
      missing_target: "需要提供目标实体。",
      unresolved_source: "未找到起点实体。",
      unresolved_target: "未找到目标实体。",
      invalid_depth: "路径深度需要是 1 到 6 的整数。",
    };
    const display = displayByReason[payload.reason];
    return {
      display,
      summary: {
        status,
        count: 0,
        truncated: false,
        message: display,
        reason: payload.reason,
        fromTitle: safeFromTitle,
        toTitle: safeToTitle,
        hops: 0,
        maxDepth: payload.maxDepth,
      },
      raw: payload,
    };
  }

  if (!payload.path) {
    const display = "关系路径结果不可用。";
    return {
      display,
      summary: {
        status: "error",
        count: 0,
        truncated: false,
        message: display,
        reason: "path_found",
        fromTitle: safeFromTitle,
        toTitle: safeToTitle,
        hops: 0,
        maxDepth: payload.maxDepth,
      },
      raw: payload,
    };
  }

  if (payload.path.depth === 0) {
    const title = safeGraphPathTitle(payload.path.nodes[0]?.title ?? payload.fromTitle, "该条目");
    const display = `${title} 与自身是同一条目。`;
    return {
      display,
      summary: {
        status: "ok",
        count: 0,
        truncated: false,
        message: "起点与目标是同一条目",
        reason: "path_found",
        fromTitle: title,
        toTitle: title,
        hops: 0,
        maxDepth: payload.maxDepth,
      },
      raw: payload,
    };
  }

  const lines: string[] = [];
  for (let i = 0; i < payload.path.edges.length; i++) {
    const from = payload.path.nodes[i];
    const to = payload.path.nodes[i + 1];
    const edge = payload.path.edges[i];
    if (!from || !to) continue;
    const fromTitle = safeGraphPathTitle(from.title, "起点实体");
    const toTitle = safeGraphPathTitle(to.title, "目标实体");
    const relation = graphPathRelationLabel(edge.relation || "关联");
    const pending = edge.trust_state === "candidate" ? "（待确认关系）" : "";
    const forward = edge.from_slug === from.slug && edge.to_slug === to.slug;
    lines.push(forward
      ? `${fromTitle} —${relation}${pending}→ ${toTitle}`
      : `${fromTitle} ←${relation}${pending}— ${toTitle}`);
  }
  const display = sanitizeDisplay(lines.join("\n"));
  const fromTitle = safeGraphPathTitle(payload.path.nodes[0]?.title ?? payload.fromTitle, "起点实体");
  const toTitle = safeGraphPathTitle(payload.path.nodes.at(-1)?.title ?? payload.toTitle, "目标实体");
  return {
    display,
    summary: {
      status: "ok",
      count: payload.path.edges.length,
      truncated: false,
      message: `找到一条 ${payload.path.depth} 跳关系路径`,
      reason: "path_found",
      fromTitle,
      toTitle,
      hops: payload.path.depth,
      maxDepth: payload.maxDepth,
    },
    raw: payload,
  };
}

interface GraphQueryPayload {
  resolvedSlug: string;
  result: Link[] | GraphNode[];
}

export function formatGraphEnvelope(
  payload: GraphQueryPayload,
  titleResolver: (slug: string) => string | null,
): { display: string; summary: ToolSummary; raw: GraphQueryPayload } {
  const items = payload.result;
  const count = items.length;

  if (count === 0) {
    return {
      display: "未找到相关关系。",
      summary: {
        status: "empty",
        count: 0,
        truncated: false,
        message: "图谱查询无结果",
        next_steps: ["检查实体名称是否正确", "尝试 related 模式"],
      },
      raw: payload,
    };
  }

  const lines: string[] = [];
  const isLinks = items.length > 0 && "from_slug" in items[0];

  if (isLinks) {
    const links = items as Link[];
    for (const link of links.slice(0, 8)) {
      const fromTitle = titleResolver(link.from_slug) ?? "（未命名）";
      const toTitle = titleResolver(link.to_slug) ?? "（未命名）";
      const rel = link.relation || "关联";
      const ctx = link.context ? `（${link.context}）` : "";
      const trustLabel = link.trust_state === "confirmed" ? "" : "待确认：";
      lines.push(`${trustLabel}${fromTitle} —${rel}→ ${toTitle}${ctx}`);
    }
    if (links.length > 8) {
      lines.push(`...还有 ${links.length - 8} 条关系`);
    }
  } else {
    const nodes = items as GraphNode[];
    for (const node of nodes.slice(0, 8)) {
      const nodeTitle = node.title || "（未命名）";
      const depthNote = node.depth > 1 ? `（隔 ${node.depth} 层）` : "";
      lines.push(`${nodeTitle}${depthNote}`);
    }
    if (nodes.length > 8) {
      lines.push(`...还有 ${nodes.length - 8} 条相关内容`);
    }
  }

  return {
    display: sanitizeDisplay(lines.join("\n")),
    summary: {
      status: "ok",
      count,
      truncated: count > 8,
      message: `找到 ${count} 条关系`,
    },
    raw: payload,
  };
}

// ─── Links ──────────────────────────────────────────────────

export function formatLinksEnvelope(
  links: Link[],
  seedSlug: string,
  titleResolver: (slug: string) => string | null,
): { display: string; summary: ToolSummary; raw: Link[] } {
  const count = links.length;

  if (count === 0) {
    return {
      display: "该页面暂无已知关系。",
      summary: {
        status: "empty",
        count: 0,
        truncated: false,
        message: "无关联关系",
      },
      raw: links,
    };
  }

  const lines: string[] = [];
  for (const link of links.slice(0, 10)) {
    const otherSlug = link.from_slug === seedSlug ? link.to_slug : link.from_slug;
    const otherTitle = titleResolver(otherSlug) ?? "（未命名）";
    const rel = link.relation || "关联";
    const direction = link.from_slug === seedSlug ? "→" : "←";
    const trustLabel = link.trust_state === "confirmed" ? "已知" : "待确认";
    const ctx = link.context ? `（${link.context}）` : "";
    lines.push(`${trustLabel}：${otherTitle} ${direction} ${rel}${ctx}`);
  }
  if (count > 10) {
    lines.push(`...还有 ${count - 10} 条关系`);
  }

  return {
    display: sanitizeDisplay(lines.join("\n")),
    summary: {
      status: "ok",
      count,
      truncated: count > 10,
      message: `${count} 条关联关系`,
    },
    raw: links,
  };
}

// ─── Timeline ───────────────────────────────────────────────

interface TimelineEvent {
  id?: number;
  date?: string;
  summary: string;
  source?: string;
  source_category?: string;
  trust_state?: string;
  source_page_slug?: string;
  evidence?: string;
}

interface TimelinePayload {
  slug: string;
  title: string;
  events: TimelineEvent[];
}

export function formatTimelineEnvelope(
  payload: TimelinePayload,
): { display: string; summary: ToolSummary; raw: TimelinePayload } {
  const { title, events } = payload;
  const count = events.length;
  // Use safe display title — fall back to generic label if title looks like a slug
  const displayTitle = isSlugLike(title) ? "该页面" : title;

  if (count === 0) {
    return {
      display: `${displayTitle}暂无时间线记录。`,
      summary: {
        status: "empty",
        count: 0,
        truncated: false,
        message: "无时间线事件",
      },
      raw: payload,
    };
  }

  // Pick up to 5 key events, prefer dated ones
  const dated = events.filter(e => e.date).sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  const undated = events.filter(e => !e.date);
  const selected = [...dated, ...undated].slice(0, 5);

  const lines: string[] = [`${displayTitle}的时间线（${count} 个事件）：`];
  for (const e of selected) {
    const datePrefix = e.date ? `${e.date} ` : "";
    const trustLabel = e.trust_state === "confirmed" ? "" : "待确认：";
    lines.push(`- ${datePrefix}${trustLabel}${e.summary}`);
  }
  if (count > 5) {
    lines.push(`- ...还有 ${count - 5} 个事件`);
  }

  return {
    display: sanitizeDisplay(lines.join("\n")),
    summary: {
      status: "ok",
      count,
      truncated: count > 5,
      message: `${title} 时间线：${count} 个事件`,
    },
    raw: payload,
  };
}

/**
 * Detect if a string looks like an internal slug (contains / or known prefixes).
 * Used to avoid leaking slugs into display text.
 */
function isSlugLike(text: string): boolean {
  if (!text) return true;
  return text.includes("/") || /^(entities|concepts|records|insights|events|brain)\b/.test(text);
}

// ─── Health ─────────────────────────────────────────────────

/**
 * Attention-summary labels for each repair group. Display-layer wording only —
 * the grouping itself comes from planRepairs (no parallel taxonomy). #306
 */
const ATTENTION_GROUP_LABEL: Record<"blocked" | "auto_repairable" | "needs_review", string> = {
  blocked: "阻塞项：需先恢复运行条件",
  auto_repairable: "可安全修复项：建议先 dry-run 预览",
  needs_review: "需人工确认：涉及事实或关系判断",
};

export function formatHealthEnvelope(
  report: HealthReport,
  signalLookup?: SignalLookup,
): { display: string; summary: ToolSummary; raw: HealthReport } {
  const statusIcon = report.overallStatus === "pass" ? "✅" : "⚠️";
  const statusLabel = report.overallStatus === "pass" ? "健康" : report.overallStatus === "warn" ? "需注意" : "有问题";
  const summaryStatus: ToolSummary["status"] = report.overallStatus === "pass" ? "ok" : "degraded";

  // Reuse health-debt classification — do NOT re-classify here. #306
  const plan = planRepairs(report, signalLookup);
  const total = plan.actions.length;

  if (total === 0) {
    return {
      display: `${statusIcon} 大脑状态：${statusLabel}，无问题。`,
      summary: {
        status: summaryStatus,
        count: 0,
        truncated: false,
        message: "健康检查通过",
      },
      raw: report,
    };
  }

  const { blocked, auto_repairable, needs_review, observe_only } = plan.counts;

  const lines: string[] = [`${statusIcon} 大脑状态：${statusLabel}（共 ${total} 条信号）`];

  // Priority order: blocked → auto_repairable → needs_review (at most 3 group lines).
  const actionLines: string[] = [];
  if (blocked > 0) actionLines.push(`- ${blocked} 个${ATTENTION_GROUP_LABEL.blocked}`);
  if (auto_repairable > 0) actionLines.push(`- ${auto_repairable} 个${ATTENTION_GROUP_LABEL.auto_repairable}`);
  if (needs_review > 0) actionLines.push(`- ${needs_review} 个${ATTENTION_GROUP_LABEL.needs_review}`);

  if (actionLines.length > 0) {
    lines.push("优先处理：");
    lines.push(...actionLines);
  }

  // Observe-only: count only, never dump items. Wording depends on whether
  // actionable groups exist (avoid "其余" when nothing precedes it).
  if (observe_only > 0) {
    const observeLine = actionLines.length > 0
      ? `其余 ${observe_only} 条为观察项，默认不打扰。`
      : `${observe_only} 条为观察项，默认不打扰。`;
    lines.push(observeLine);
  }

  // Raw details preserved — avoid the banned literal "raw" in display.
  lines.push("完整明细已保留。");

  // Structured next_steps for the agent (fixed wording, no commands/functions).
  const nextSteps: string[] = [];
  if (blocked > 0) nextSteps.push("先恢复运行条件后再检查");
  if (auto_repairable > 0) nextSteps.push("用试运行预览可修复项");
  if (needs_review > 0) nextSteps.push("逐项人工核实");
  if (observe_only > 0 && actionLines.length === 0) nextSteps.push("无需处理，保持观察");

  return {
    display: sanitizeDisplay(lines.join("\n")),
    summary: {
      status: summaryStatus,
      count: total,
      truncated: observe_only > 0,
      message: `${statusLabel}：${total} 条信号`,
      next_steps: nextSteps.length > 0 ? nextSteps : undefined,
    },
    raw: report,
  };
}

// ─── Dream Status ───────────────────────────────────────────

interface DreamProgress {
  current_stage?: string;
  brief?: string;
  [key: string]: unknown;
}

interface DreamJob {
  id: number;
  status: string;
  result?: string | null;
  error?: string | null;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
}

export function formatDreamStatusEnvelope(
  job: DreamJob,
  progress: DreamProgress,
): { display: string; summary: ToolSummary; raw: Record<string, unknown> } {
  // Every branch preserves full raw for audit
  const raw = { job, progress };

  if (job.status === "pending") {
    return {
      display: "🧠 Dream 已提交，等待执行。",
      summary: { status: "ok", count: 0, truncated: false, message: "Dream 已提交" },
      raw,
    };
  }

  if (job.status === "running") {
    const stage = progress.current_stage ?? "处理中";
    return {
      display: `🧠 Dream 执行中：${stage}`,
      summary: { status: "ok", count: 0, truncated: false, message: `执行中：${stage}` },
      raw,
    };
  }

  if (job.status === "failed") {
    return {
      display: `🧠 Dream 执行失败。请稍后重试或检查日志。`,
      summary: { status: "error", count: 0, truncated: false, message: job.error ?? "Dream 失败" },
      raw,
    };
  }

  // Completed (DB stores "done"; "completed" kept for backward compat / tests)
  const isCompleted = job.status === "done" || job.status === "completed";

  if (isCompleted && progress.brief) {
    // Clean the brief: remove internal terms
    const cleanBrief = sanitizeDreamBrief(progress.brief);
    return {
      display: sanitizeDisplay(cleanBrief),
      summary: { status: "ok", count: 0, truncated: false, message: "Dream 完成" },
      raw,
    };
  }

  // Fallback: generic completed message
  if (isCompleted) {
    return {
      display: "🧠 Dream 已完成。",
      summary: { status: "ok", count: 0, truncated: false, message: "Dream 完成" },
      raw,
    };
  }

  // Unknown status — safe fallback
  return {
    display: `🧠 Dream 状态：${job.status}`,
    summary: { status: "ok", count: 0, truncated: false, message: `状态: ${job.status}` },
    raw,
  };
}

function sanitizeDreamBrief(brief: string): string {
  // Remove internal implementation terms but keep the structure
  return brief
    .replace(/Seal:/g, "摘要压缩：")
    .replace(/LanceDB:.*fragments.*files.*/g, "向量索引已优化")
    .replace(/搜索:.*降级/g, "搜索质量已检查")
    .replace(/\d+(\.\d+)?s$/, "")  // Remove duration line
    .replace(/⏱.*/g, "")           // Remove timer icon line
    .replace(/\n{3,}/g, "\n\n")    // Collapse extra newlines
    .trim();
}

// ─── Versions ───────────────────────────────────────────────

interface VersionInfo {
  version: number;
  created_at: string;
}

export function formatVersionsEnvelope(
  versions: VersionInfo[],
  slug: string,
  title: string | null,
): { display: string; summary: ToolSummary; raw: { slug: string; title: string | null; versions: VersionInfo[] } } {
  const raw = { slug, title, versions };
  const displayName = title || "该页面";

  if (versions.length === 0) {
    return emptyEnvelope(raw, `📄 ${displayName}暂无版本历史。`, "无版本记录");
  }

  const latest = versions[0];
  const lines: string[] = [
    `📄 ${displayName}有 ${versions.length} 个版本。`,
    `最近版本：v${latest.version}（${formatDate(latest.created_at)}）`,
  ];
  if (versions.length > 1) {
    lines.push(`最早版本：v${versions[versions.length - 1].version}`);
  }

  return okEnvelope(raw, sanitizeDisplay(lines.join("\n")), versions.length, `${versions.length} 个版本`);
}

export function formatRevertEnvelope(
  success: boolean,
  slug: string,
  version: number,
  title: string | null,
): { display: string; summary: ToolSummary; raw: { slug: string; version: number; success: boolean } } {
  const raw = { slug, version, success };
  const displayName = title || "该页面";

  if (success) {
    return okEnvelope(raw, `📄 已将${displayName}回滚到版本 ${version}。`, 1, `回滚到 v${version}`);
  }

  return errorEnvelope(raw, `📄 回滚失败：${displayName}没有版本 ${version}。`, `版本 ${version} 不存在`);
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  } catch {
    return iso;
  }
}

// ─── Profile ────────────────────────────────────────────────

interface ProfileEntry {
  id: string;
  type: string;
  category: string;
  scope: string;
  content: string;
  tags?: string[];
  updated_at: string;
  [key: string]: unknown;
}

export function formatGetProfileEnvelope(
  entries: ProfileEntry[],
  stats: { total: number; byScope: Record<string, number>; byType: Record<string, number>; modules: number },
  modules: { name: string; enabled: boolean; count: number }[],
  filter?: Record<string, unknown>,
): { display: string; summary: ToolSummary; raw: Record<string, unknown> } {
  const enabledModules = modules.filter(m => m.enabled);
  const metaBase: Record<string, unknown> = {
    total: stats.total,
    filtered: entries.length,
    loaded_modules: enabledModules.map(m => m.name),
  };
  if (filter?.scope) metaBase.scope = filter.scope;
  if (filter?.category) metaBase.category = filter.category;
  if (filter?.type) metaBase.type = filter.type;
  const raw = { entries, meta: metaBase };

  if (entries.length === 0) {
    return {
      display: "👤 暂无匹配的用户偏好记录。",
      summary: { status: "empty", count: 0, truncated: false, message: "无匹配条目" },
      raw,
    };
  }

  // Summarize: show count + breakdown by type, truncate content preview
  const typeCounts: Record<string, number> = {};
  for (const e of entries) {
    typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
  }
  const breakdown = Object.entries(typeCounts)
    .map(([t, c]) => `${c} 个${typeLabel(t)}`)
    .join("、");

  const lines: string[] = [
    `👤 匹配到 ${entries.length} 条偏好（共 ${stats.total} 条，${breakdown}）。`,
  ];
  // Show up to 3 entries as preview (content snippet only)
  const preview = entries.slice(0, 3);
  for (const e of preview) {
    const snippet = e.content.length > 40 ? `${e.content.slice(0, 40)}...` : e.content;
    lines.push(`- ${typeLabel(e.type)}：${snippet}`);
  }
  if (entries.length > 3) {
    lines.push(`- ...还有 ${entries.length - 3} 条`);
  }

  return {
    display: sanitizeDisplay(lines.join("\n")),
    summary: { status: "ok", count: entries.length, truncated: entries.length > 3, message: `${entries.length} 条偏好` },
    raw,
  };
}

export function formatUpdateProfileEnvelope(
  updated: ProfileEntry[],
): { display: string; summary: ToolSummary; raw: { updated: string[]; count: number } } {
  const ids = updated.map(e => e.id);
  const raw = { updated: ids, count: ids.length };

  return {
    display: `👤 已更新 ${ids.length} 条偏好。`,
    summary: { status: "ok", count: ids.length, truncated: false, message: `${ids.length} 条已更新` },
    raw,
  };
}

export function formatRemoveProfileEnvelope(
  removed: string[],
): { display: string; summary: ToolSummary; raw: { removed: string[]; count: number } } {
  const raw = { removed, count: removed.length };

  if (removed.length === 0) {
    return emptyEnvelope(raw, "👤 未找到匹配的偏好记录。", "无删除");
  }

  return okEnvelope(raw, `👤 已删除 ${removed.length} 条偏好。`, removed.length, `${removed.length} 条已删除`);
}

export function formatReloadProfileEnvelope(
  stats: { total: number; byScope: Record<string, number>; byType: Record<string, number>; modules: number },
  modules: { name: string; enabled: boolean; count: number }[],
): { display: string; summary: ToolSummary; raw: Record<string, unknown> } {
  const enabledModules = modules.filter(m => m.enabled);
  const raw = {
    reloaded: true,
    total_entries: stats.total,
    modules: modules.map(m => ({ name: m.name, enabled: m.enabled, entries: m.count })),
  };

  const modNames = enabledModules.map(m => m.name);
  const lines: string[] = [
    `👤 偏好数据已重新加载：${stats.total} 条记录，${enabledModules.length} 个模块。`,
  ];
  if (modNames.length > 0) {
    lines.push(`模块：${modNames.join("、")}`);
  }

  return {
    display: sanitizeDisplay(lines.join("\n")),
    summary: { status: "ok", count: stats.total, truncated: false, message: "重新加载完成" },
    raw,
  };
}

function typeLabel(type: string): string {
  const labels: Record<string, string> = {
    preference: "偏好",
    constraint: "约束",
    context: "背景",
    habit: "习惯",
  };
  return labels[type] ?? type;
}
