import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { DiscoveryManager } from "../../core/discovery.js";
import type { DiscoveryType } from "../../core/discovery.js";
import { formatDiscoveryDigest, formatKnowledgeMapSurface, isDigestExcluded } from "../../core/discovery-digest.js";
import { formatDiscoveriesEnvelope } from "./format-result.js";

const TYPE_LABELS: Record<string, string> = {
  bridge: "桥接",
  community_crossing: "跨社区",
  structural_hole: "结构洞",
  trend: "趋势",
  gap: "缺口",
  contradiction: "矛盾",
  knowledge_map_isolation: "孤立记忆",
  knowledge_map_bridge: "跨领域连接",
};

const ACTIONABLE_LABELS: Record<string, string> = {
  high: "重要",
  medium: "中等",
  low: "低",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "待处理",
  seen: "已读",
  resolved: "已解决",
  dismissed: "已忽略",
};

// #244 — Knowledge Map discovery types live in the discoveries table as an
// INDEPENDENT surface. They never enter the normal round-robin / digest, so
// normal discovery ranking quotas are untouched.
const KM_TYPES = new Set(["knowledge_map_isolation", "knowledge_map_bridge"]);

type EntityInfo = { title: string; type: string };
type ActionableLevel = "high" | "medium" | "low";
type KmSurfaceType = "knowledge_map_isolation" | "knowledge_map_bridge";

interface KmSurfaceOptions {
  /** Restrict to a single KM type (when the caller filtered to one). */
  typeFilter?: KmSurfaceType;
  /** Apply the same actionable filter as the normal surface. */
  actionableFilter?: ActionableLevel;
}

function filterByActionable<T extends { actionable: string }>(rows: T[], level: ActionableLevel | undefined): T[] {
  return level ? rows.filter(r => r.actionable === level) : rows;
}

function buildKmSurface(
  db: ToolContext["db"],
  entityLookup: (slug: string) => EntityInfo | null,
  opts: KmSurfaceOptions = {},
): { cards: ReturnType<typeof formatKnowledgeMapSurface>["cards"]; display: string } {
  const wantIsolation = opts.typeFilter !== "knowledge_map_bridge";
  const wantBridge = opts.typeFilter !== "knowledge_map_isolation";
  const isolation = wantIsolation
    ? filterByActionable(db.getDiscoveriesByType("knowledge_map_isolation", 3), opts.actionableFilter)
    : [];
  const bridge = wantBridge
    ? filterByActionable(db.getDiscoveriesByType("knowledge_map_bridge", 3), opts.actionableFilter)
    : [];
  return formatKnowledgeMapSurface(isolation, bridge, entityLookup, 5);
}

function buildDiscoverySummary(normalCount: number, kmCount: number, emptyText: string): string {
  const parts: string[] = [];
  if (normalCount > 0) parts.push(`${normalCount} 条值得关注的发现`);
  if (kmCount > 0) parts.push(`${kmCount} 条知识结构观察`);
  return parts.length > 0 ? `今天有 ${parts.join("，另有 ")}` : emptyText;
}

/**
 * #244 — Stitch the normal-digest display and the KM-surface display without
 * contradicting ourselves. The normal digest returns an "暂无新的发现。" placeholder
 * when it has no cards; that placeholder must NOT be shown when the KM surface
 * carries the actual signal (and vice versa).
 *
 * `digestDisplay` is already the correct empty placeholder when normal is empty,
 * so the neither-case just falls back to it.
 */
function combineDiscoveryDisplay(
  digestDisplay: string,
  kmDisplay: string,
  hasNormalCards: boolean,
  hasKmCards: boolean,
): string {
  if (hasNormalCards && hasKmCards) return `${digestDisplay}\n\n${kmDisplay}`;
  if (hasKmCards) return kmDisplay;
  return digestDisplay;
}

export function registerDiscoveryTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("read_discoveries", {
    description:
      "读取知识图谱的结构发现摘要（最多 3 条）。" +
      "返回用户可见的发现卡片，包含为什么重要、依据、建议动作。" +
      "如需处理发现，用 update_discovery_status 标记已读、已解决或忽略。",
    inputSchema: {
      limit: z.number().optional().default(3).describe("Max discoveries to return"),
      actionableFilter: z.enum(["high", "medium", "low"]).optional().describe("Filter by actionable level"),
      typeFilter: z.enum(["bridge", "trend", "gap", "contradiction", "knowledge_map_isolation", "knowledge_map_bridge", "similar_entity"]).optional().describe("Filter by discovery type"),
      debug: z.boolean().optional().default(false).describe("Include internal debug info"),
    },
  }, async ({ limit, actionableFilter, typeFilter, debug }) => {
    const displayLimit = limit ?? 3;
    const fetchLimit = Math.max(displayLimit * 3, 10);
    const entityLookup = (slug: string) => ctx.db.getPage(slug);
    const isKmTypeFilter = typeFilter !== undefined && KM_TYPES.has(typeFilter);

    // Normal discovery rows. KM types never enter this path — they are surfaced
    // exclusively through the independent Knowledge Map surface below.
    let normalRows: ReturnType<typeof ctx.db.getDiscoveriesByType>;
    if (isKmTypeFilter) {
      normalRows = [];
    } else if (typeFilter) {
      normalRows = ctx.db.getDiscoveriesByType(typeFilter, fetchLimit);
    } else {
      // Type-diverse round-robin: prevent high-score bridges from crowding out gaps
      const activeTypes = ["bridge", "trend", "gap", "contradiction"] as const;
      const typeBuckets = new Map<string, ReturnType<typeof ctx.db.getDiscoveriesByType>>();

      for (const t of activeTypes) {
        const typeRows = ctx.db.getDiscoveriesByType(t, fetchLimit);
        if (actionableFilter) {
          typeBuckets.set(t, typeRows.filter(r => r.actionable === actionableFilter));
        } else {
          typeBuckets.set(t, typeRows);
        }
      }

      const nonEmpty = [...typeBuckets.entries()].filter(([, v]) => v.length > 0);
      const merged: ReturnType<typeof ctx.db.getDiscoveriesByType> = [];
      let roundIdx = 0;
      while (merged.length < fetchLimit && nonEmpty.some(([, v]) => v.length > 0)) {
        const bucket = nonEmpty[roundIdx % nonEmpty.length];
        if (bucket[1].length > 0) {
          merged.push(bucket[1].shift()!);
        }
        roundIdx++;
      }
      normalRows = merged;
    }

    const digest = formatDiscoveryDigest(normalRows, entityLookup, displayLimit);

    // #244 — independent KM surface.
    // - Suppressed when the caller explicitly filtered to a non-KM type: an
    //   explicit filter must not bleed in a different surface.
    // - Restricted to the requested type when the caller filtered to a KM type.
    // - actionableFilter applies uniformly to both normal and KM cards.
    const kmSurface = typeFilter && !isKmTypeFilter
      ? { cards: [], display: "" }
      : buildKmSurface(ctx.db, entityLookup, {
          typeFilter: isKmTypeFilter ? (typeFilter as KmSurfaceType) : undefined,
          actionableFilter,
        });
    const combinedDisplay = combineDiscoveryDisplay(
      digest.display,
      kmSurface.display,
      digest.cards.length > 0,
      kmSurface.cards.length > 0,
    );

    const summaryText = buildDiscoverySummary(digest.cards.length, kmSurface.cards.length, "今天暂无新的发现。");

    const payload: Record<string, unknown> = {
      cards: digest.cards,
    };
    if (kmSurface.cards.length > 0) {
      payload.knowledge_map_cards = kmSurface.cards;
    }
    if (debug) {
      payload._debug = digest._debug;
    }

    const { display, summary, raw } = formatDiscoveriesEnvelope({
      display: combinedDisplay,
      cards: digest.cards,
      summary: summaryText,
      extraCardCount: kmSurface.cards.length,
    });
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ display, summary, raw, result_summary: summaryText, ...payload }, null, 2),
      }],
    };
  });

  server.registerTool("run_discovery", {
    description:
      "运行发现管线，检查知识图谱中的变化和机会。完成后返回用户可见的发现摘要（最多 3 条）。" +
      "可用 read_discoveries 查看历史发现，用 update_discovery_status 标记处理状态。" +
      "建议每天运行一次。",
    inputSchema: {
      types: z.array(z.enum(["bridge", "trend", "gap", "contradiction", "similar_entity"])).optional()
        .describe("Detection types to run. Default: bridge, trend, gap."),
      debug: z.boolean().optional().default(false).describe("Include raw detection report"),
    },
  }, async ({ types, debug }) => {
    // Run only DiscoveryManager (pure graph math, no LLM, completes in seconds).
    // ReflectManager is slower (BFS + LLM suggestions) and overlaps with bridge detection.
    // Contradiction detection is LLM-heavy — skip unless explicitly requested.
    const requested = types as DiscoveryType[] | undefined;
    const wantsSimilar = requested?.includes("similar_entity") ?? false;
    const normalRequested = requested ? requested.filter((t) => t !== "similar_entity") : undefined;

    const fastTypes: DiscoveryType[] = normalRequested
      ? normalRequested.filter((t) => t !== "contradiction")
      : ["bridge", "trend", "gap"];
    const runContradiction = normalRequested?.includes("contradiction") ?? false;

    const discoveryMgr = new DiscoveryManager(ctx.db, ctx.llm);
    const report = await discoveryMgr.runDiscovery(runContradiction ? undefined : fastTypes);
    if (wantsSimilar) {
      const simReport = await discoveryMgr.runSimilarEntityDetection();
      report.total += simReport.total;
      for (const [k, v] of Object.entries(simReport.byType)) report.byType[k] = (report.byType[k] ?? 0) + v;
      for (const [k, v] of Object.entries(simReport.byActionable)) report.byActionable[k] = (report.byActionable[k] ?? 0) + v;
      report.highActionable.push(...simReport.highActionable);
    }

    // User-facing path: format new discoveries through the digest pipeline
    const newRows = ctx.db.getUnseenDiscoveries(30);
    const entityLookup = (slug: string) => ctx.db.getPage(slug);
    // #244 — split KM rows out so they never compete for the normal top-3 quota.
    const normalRows = newRows.filter(r => !KM_TYPES.has(r.type) && !isDigestExcluded(r.type));
    const digest = formatDiscoveryDigest(normalRows, entityLookup, 3);
    const kmSurface = buildKmSurface(ctx.db, entityLookup);
    const combinedDisplay = combineDiscoveryDisplay(
      digest.display,
      kmSurface.display,
      digest.cards.length > 0,
      kmSurface.cards.length > 0,
    );

    const summaryText = buildDiscoverySummary(digest.cards.length, kmSurface.cards.length, "今天暂无值得打扰你的新发现。");

    const payload: Record<string, unknown> = {
      cards: digest.cards,
    };
    if (kmSurface.cards.length > 0) {
      payload.knowledge_map_cards = kmSurface.cards;
    }

    if (debug) {
      const typeLabels = Object.entries(report.byType)
        .map(([k, v]) => `${TYPE_LABELS[k] ?? k}: ${v}`)
        .join("，");
      const actionLabels = Object.entries(report.byActionable)
        .map(([k, v]) => `${ACTIONABLE_LABELS[k] ?? k}: ${v}`)
        .join("，");
      const enrich = report.enrichment;
      const enrichLabel = enrich.skipped
        ? `enrichment 跳过（${enrich.reason}）`
        : `enrichment: 尝试 ${enrich.attempted} 个，成功 ${enrich.saved} 个，失败 ${enrich.errors} 个`;
      const skipped: string[] = [];
      if (!runContradiction) skipped.push("contradiction（用 CLI 或指定 types 运行）");
      skipped.push("reflect（社区/结构洞检测，用 CLI 运行）");
      payload._debug = {
        report: {
          total: report.total,
          byType: report.byType,
          byActionable: report.byActionable,
          enrichment: report.enrichment,
        },
        type_summary: typeLabels,
        actionable_summary: actionLabels,
        enrichment_summary: enrichLabel,
        skipped,
      };
    }

    const { display, summary, raw } = formatDiscoveriesEnvelope({
      display: combinedDisplay,
      cards: digest.cards,
      summary: summaryText,
      extraCardCount: kmSurface.cards.length,
    });
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ display, summary, raw, result_summary: summaryText, ...payload }, null, 2),
      }],
    };
  });

  server.registerTool("find_similar_entities", {
    description:
      "查找可能重复的实体/概念页面对，供人工或 Agent 核对后通过 merge_entities 合并。" +
      "默认会把候选写入 discoveries 生命周期（dismissed/resolved 不会重复打扰）。" +
      "返回 display（用户可见自然语言）和 candidates（含 slug 与推荐合并目标，供调用 merge_entities）。" +
      "绝不自动合并或写别名。",
    inputSchema: {
      limit: z.number().optional().default(20).describe("Max candidates to return"),
      scope: z.enum(["entity", "concept"]).optional().describe("Restrict to slug namespace (entity/% or concept/%)"),
      dryRun: z.boolean().optional().default(false).describe("If true, do not persist candidates"),
    },
  }, async ({ limit, scope, dryRun }) => {
    const discoveryMgr = new DiscoveryManager(ctx.db, ctx.llm);
    const report = await discoveryMgr.runSimilarEntityDetection({ dryRun, scope });

    interface CandidateOut {
      slug_a: string; slug_b: string; match_kind: string | null; type_gate: string | null;
      recommended_target: string | null; ambiguous_target: boolean; confidence: "高" | "中";
    }
    const cap = limit ?? 20;
    let out: CandidateOut[] = [];
    if (dryRun && report.candidates) {
      out = report.candidates.map((c) => ({
        slug_a: c.slugA, slug_b: c.slugB, match_kind: c.matchKind, type_gate: c.typeGate,
        recommended_target: c.recommendedTarget ?? null, ambiguous_target: c.ambiguousTarget === true,
        confidence: c.actionable === "high" ? "高" : "中",
      }));
    } else if (report.candidates && report.candidates.length > 0) {
      out = report.candidates.map((c) => ({
        slug_a: c.slugA, slug_b: c.slugB, match_kind: c.matchKind, type_gate: c.typeGate,
        recommended_target: c.recommendedTarget ?? null, ambiguous_target: c.ambiguousTarget === true,
        confidence: c.actionable === "high" ? "高" : "中",
      }));
    } else {
      const rows = ctx.db.getDiscoveriesByType("similar_entity", Math.max(cap, 20));
      out = rows.map((r) => {
        const [a, b] = JSON.parse(r.entities) as string[];
        const meta = r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : {};
        return {
          slug_a: a, slug_b: b,
          match_kind: (meta.match_kind as string) ?? null,
          type_gate: (meta.type_gate as string) ?? null,
          recommended_target: (meta.recommended_target as string) ?? null,
          ambiguous_target: meta.ambiguous_target === true,
          confidence: r.actionable === "high" ? "高" : "中",
        };
      });
    }
    out = out.slice(0, cap);

    const titleFor = (slug: string) => ctx.db.getPage(slug)?.title ?? slug;
    const kindLabel = (k: string | null) =>
      k === "alias_shadow_page" ? "名称已是别名的残留页"
      : k === "shared_alias" ? "共享别名"
      : k === "name_exact" ? "名称相同"
      : k === "name_normalized" ? "名称仅大小写/标点不同"
      : k === "name_substring" ? "名称相互包含"
      : k === "edit_distance" ? "名称仅有细微拼写差异"
      : "名称高度相似";

    const display = out.length > 0
      ? out.map((c) =>
          `### 可能重复：${titleFor(c.slug_a)} 与 ${titleFor(c.slug_b)}\n${kindLabel(c.match_kind)}（置信度：${c.confidence}）。疑似指向同一对象，合并前请核对。\n**建议**：用 merge_entities 先 dry-run 核对，确认后再执行合并。`
        ).join("\n\n---\n\n")
      : "暂无可能重复的实体。";

    const summary = out.length > 0
      ? `发现 ${out.length} 组可能重复的实体，请核对后用 merge_entities 合并。`
      : "暂无可能重复的实体。";

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ display, summary, candidates: out, result_summary: summary }, null, 2),
      }],
    };
  });

  server.registerTool("update_discovery_status", {
    description: "更新发现的处理状态。支持标记已读(seen)、已解决(resolved)、已忽略(dismissed)。",
    inputSchema: {
      ids: z.array(z.number()).describe("Discovery IDs to update"),
      status: z.enum(["seen", "resolved", "dismissed"]).describe("New status"),
    },
  }, async ({ ids, status }) => {
    for (const id of ids) {
      ctx.db.updateDiscoveryStatus(id, status);
      if (status === "seen") ctx.db.markDiscoverySeen(id);
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ updated: ids.length, status, status_label: STATUS_LABELS[status] }) }],
    };
  });

  server.registerTool("mark_discovery_seen", {
    description: "标记发现为已读。建议使用 update_discovery_status 替代。",
    inputSchema: {
      ids: z.array(z.number()).describe("Discovery IDs to mark as seen"),
    },
  }, async ({ ids }) => {
    for (const id of ids) {
      ctx.db.markDiscoverySeen(id);
      ctx.db.updateDiscoveryStatus(id, "seen");
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ marked: ids.length }) }],
    };
  });
}
