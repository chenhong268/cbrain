import type { IngestResult } from "../../core/ingest.js";
import type { DialogueIngestResult } from "../../core/dialogue.js";
import type { EpisodicRecallResult } from "../../core/episodic-recall.js";
import type { OrgTreeResult } from "../../core/hierarchy.js";

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

// ─── Internal identifier sanitization ───────────────────────

const SLUG_PATH_RE = /brain\/(?:entities|concepts|insights|records)\//g;

/** Terms that must never appear in display/summary text. Shared by formatters and tests. */
export const DISPLAY_BANNED_TERMS = [
  "score", "distance", "debug", "trace", "threshold",
  "latency_ms", "vector", "degraded_reason", "_stub",
  "reason_codes",
];

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
      display: `未找到与「${payload.query}」相关的实体。`,
      summary: {
        status: "empty",
        count: 0,
        truncated: false,
        message: "未找到相关实体",
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
    ? sanitizeDisplay(`搜索耗时较长，返回了部分结果。找到 ${count} 个相关实体。`)
    : sanitizeDisplay(`找到 ${count} 个相关实体。${topNames ? `最相关的是${topNames}。` : ""}`);

  return {
    display,
    summary: {
      status: isDegraded ? "degraded" : "ok",
      count,
      truncated: entities.some(e => e._stub),
      message: payload.summary ?? `找到 ${count} 个相关实体`,
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

  const parts: string[] = [`已查找关于「${payload.query}」的证据。`];
  if (facts > 0) parts.push(`确认 ${facts} 条事实。`);
  if (candidates > 0) parts.push(`${candidates} 个待确认候选。`);
  if (conflicts > 0) parts.push(`${conflicts} 处矛盾。`);
  if (gaps > 0) parts.push(`${gaps} 个信息缺口。`);

  const signalCount = facts + candidates + conflicts + gaps;
  const display = sanitizeDisplay(parts.join(""));

  return {
    display,
    summary: {
      status: isDegraded ? "degraded" : (signalCount > 0 ? "ok" : "empty"),
      count: signalCount,
      truncated: false,
      message: `证据核查：${facts} 条事实，${candidates} 个候选，${conflicts} 处矛盾，${gaps} 个缺口`,
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
    return {
      display: "搜索未返回结果。",
      summary: {
        status: "empty",
        count: 0,
        truncated: false,
        message: "搜索未返回结果",
        next_steps: ["尝试换关键词", "用 deep_recall 代替 query"],
      },
      raw: payload,
    };
  }

  if (payload.degraded) {
    // Vector-specific messages only when vector_skipped is set
    const reason = payload.vector_skipped === "timeout"
      ? "向量搜索超时"
      : payload.vector_skipped === "error"
        ? "向量搜索异常"
        : "搜索未达最佳效果";
    return {
      display: sanitizeDisplay(`搜索遇到问题（${reason}），返回了 ${count} 条结果。`),
      summary: {
        status: "degraded",
        count,
        truncated: false,
        message: `搜索降级，返回 ${count} 条结果`,
        degraded_reason: reason,
      },
      raw: payload,
    };
  }

  return {
    display: sanitizeDisplay(`搜索完成，返回 ${count} 条结果。`),
    summary: {
      status: "ok",
      count,
      truncated: false,
      message: `搜索完成，返回 ${count} 条结果`,
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
    return {
      display: "页面不存在。",
      summary: {
        status: "empty",
        count: 0,
        truncated: false,
        message: "页面不存在",
      },
      raw: payload,
    };
  }

  const title = payload.title ?? "未知页面";
  const length = payload.body_length ?? 0;
  const truncated = payload.has_more === true;
  const statusLabel = truncated ? "（内容已截断）" : "（完整内容）";

  return {
    display: sanitizeDisplay(`页面「${title}」，${length} 字${statusLabel}。`),
    summary: {
      status: "ok",
      count: 1,
      truncated,
      message: `页面「${title}」，${length} 字`,
    },
    raw: payload,
  };
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
    `主题「${payload.topic}」：${count} 个实体，${links} 个链接，${events} 个时间线事件。`,
  );

  return {
    display,
    summary: {
      status: isDegraded ? "degraded" : "ok",
      count,
      truncated: (stats?.stubEntities ?? 0) > 0,
      message: payload.summary ?? `主题「${payload.topic}」：${count} 个实体`,
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
    display: sanitizeDisplay(`根据线索找到 ${count} 个候选人：${names}。`),
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
      `${title} 的组织架构：向上 ${upCount} 级，向下 ${downCount} 人，共 ${total} 个节点。`,
    ),
    summary: {
      status: "ok",
      count: total,
      truncated: false,
      message: `${title} 的组织架构：${total} 个节点`,
    },
    raw: result,
  };
}

interface DiscoveriesPayload {
  display?: string;
  cards?: Array<{ title?: string }>;
  summary?: string;
}

export function formatDiscoveriesEnvelope(payload: DiscoveriesPayload): {
  display: string;
  summary: ToolSummary;
  raw: DiscoveriesPayload;
} {
  const count = payload.cards?.length ?? 0;

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
    return {
      display: `所有 ${total} 个页面均不存在。`,
      summary: {
        status: "empty",
        count: 0,
        truncated: false,
        message: `所有 ${total} 个页面均不存在`,
        next_steps: ["检查 slug 是否正确", "用 query 搜索正确 slug"],
      },
      raw: payload,
    };
  }

  if (missing > 0) {
    return {
      display: sanitizeDisplay(`找到 ${found} 个页面，${missing} 个不存在。`),
      summary: {
        status: "degraded",
        count: found,
        truncated: false,
        message: `找到 ${found} 个页面，${missing} 个不存在`,
        degraded_reason: "部分 slug 不存在",
      },
      raw: payload,
    };
  }

  return {
    display: sanitizeDisplay(`找到 ${found} 个页面。`),
    summary: {
      status: "ok",
      count: found,
      truncated: false,
      message: `找到 ${found} 个页面`,
    },
    raw: payload,
  };
}
