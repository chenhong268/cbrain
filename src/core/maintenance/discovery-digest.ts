export interface DigestCard {
  id: number;
  title: string;
  why_it_matters: string;
  evidence: string;
  suggested_action: string;
}

export interface DiscoveryDigest {
  cards: DigestCard[];
  display: string;
  _debug: {
    total_candidates: number;
    filtered: number;
    filter_reasons: Record<string, number>;
  };
}

export interface DiscoveryRow {
  id: number;
  type: string;
  entities: string;
  score: number;
  detail: string | null;
  detected_at: string;
  actionable: string;
  suggestion: string | null;
  proposed_actions: string | null;
  auto_applicable: number;
  metadata?: string | null;
}

type EntityInfo = { title: string; type: string };

const ACTIONABLE_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

function parseJsonSafe(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; }
  catch { return {}; }
}

/**
 * #246 / #267 — Types excluded from the DEFAULT discovery digest feed (daily
 * run_discovery digest, default read_discoveries). similar_entity is a
 * governance/cleanup lane; action_* rows surface through their own MCP tools
 * (run_action_candidates / read_action_candidates), not the insight digest. KM
 * types were already excluded upstream.
 */
export function isDigestExcluded(type: string): boolean {
  return type === "similar_entity" || type.startsWith("action_");
}

export function shouldFilterDiscovery(r: DiscoveryRow): string | null {
  // #244 — Knowledge Map surface: always surface (already limited at production).
  if (r.type === "knowledge_map_isolation" || r.type === "knowledge_map_bridge") {
    return null;
  }
  if (r.type === "gap") return null;
  // #246 — similar_entity is excluded from the DEFAULT feed by isDigestExcluded at
  // the call site. When it reaches here (explicit read_discoveries typeFilter), it
  // should render — so do not filter.
  if (r.type === "similar_entity") return null;
  // #310 — proactive_connection is kept out of the DEFAULT feed by the
  // run_discovery digest filter and the read_discoveries round-robin. When it
  // reaches here (explicit read_discoveries typeFilter), it should render.
  if (r.type === "proactive_connection") return null;

  const meta = parseJsonSafe(r.metadata);

  if (r.type === "bridge") {
    if (!r.suggestion) {
      return "bridge_no_suggestion";
    }
    if (typeof meta.distance === "number" && meta.distance >= 6 && r.actionable !== "high") {
      return "bridge_weak_signal";
    }
    return null;
  }

  if (r.type === "contradiction") {
    if (meta.explanation || meta.suggested_resolution) return null;
    if (r.suggestion) return null;
    return "contradiction_no_evidence";
  }

  if (r.type === "trend") {
    if (!r.suggestion) return "trend_no_suggestion";
    return null;
  }

  return "unknown_type";
}

function resolveTitle(slug: string, lookup: (s: string) => EntityInfo | null): string {
  return lookup(slug)?.title ?? slug;
}

export function formatDigestCard(
  r: DiscoveryRow,
  entityLookup: (slug: string) => EntityInfo | null,
): DigestCard {
  const slugs = JSON.parse(r.entities) as string[];
  const meta = parseJsonSafe(r.metadata);

  switch (r.type) {
    case "bridge": {
      const [a, b] = slugs;
      return {
        id: r.id,
        title: `潜在关联：${resolveTitle(a, entityLookup)} 与 ${resolveTitle(b, entityLookup)}`,
        why_it_matters: `${resolveTitle(a, entityLookup)} 和 ${resolveTitle(b, entityLookup)} 看似属于不同领域，但可能存在尚未记录的联系。`,
        evidence: "间接关系线索，需要进一步确认。",
        suggested_action: r.suggestion ?? "考虑是否需要为它们建立关联。",
      };
    }
    case "trend": {
      const slug = slugs[0];
      const dir = meta.direction as string | undefined;
      const delta = meta.delta as number | undefined;
      const isRising = dir === "trend_rising" || dir === "trend_spike";
      const dirLabel = isRising ? "上升" : "下降";
      return {
        id: r.id,
        title: `关注度${dirLabel}：${resolveTitle(slug, entityLookup)}`,
        why_it_matters: isRising
          ? "近期被频繁提及，值得留意最新动态。"
          : "近期提及次数减少，可能需要更新相关信息。",
        evidence: typeof delta === "number"
          ? `${(meta.daily_counts as unknown[])?.length ?? 7} 天内提及次数变化 ${delta > 0 ? "+" : ""}${delta}`
          : "趋势数据",
        suggested_action: r.suggestion ?? "关注此趋势变化。",
      };
    }
    case "gap": {
      const slug = slugs[0];
      const mentionCount = meta.mention_count as number | undefined;
      const linkCount = meta.link_count as number | undefined;
      return {
        id: r.id,
        title: `需要补全：${resolveTitle(slug, entityLookup)}`,
        why_it_matters: "它被多次提到，但还没有详细描述，也和其他内容缺少关联。",
        evidence: `被提及 ${mentionCount ?? "?"} 次，仅有 ${linkCount ?? 0} 条关联`,
        suggested_action: "为该实体添加更详细的描述，建立与其他实体的关联。",
      };
    }
    case "contradiction": {
      const slug = slugs[0];
      return {
        id: r.id,
        title: `信息矛盾：${resolveTitle(slug, entityLookup)}`,
        why_it_matters: "多个来源对该实体的描述存在冲突。",
        evidence: (meta.explanation as string) ?? "来源信息不一致",
        suggested_action: (meta.suggested_resolution as string) ?? r.suggestion ?? "检查矛盾来源，确认正确信息。",
      };
    }
    case "knowledge_map_isolation": {
      const slug = slugs[0];
      return {
        id: r.id,
        title: `孤立记忆：${resolveTitle(slug, entityLookup)}`,
        why_it_matters: "这条记忆被多次提及，但几乎没有和其他内容建立关联。",
        evidence: "它在知识结构中处于孤立位置。",
        suggested_action: "补一条关联，或写一段说明把它和已有内容联系起来。",
      };
    }
    case "knowledge_map_bridge": {
      const slug = slugs[0];
      return {
        id: r.id,
        title: `跨领域连接：${resolveTitle(slug, entityLookup)}`,
        why_it_matters: "这个主题把多个不同的知识领域连在了一起。",
        evidence: "它同时和不止一个知识领域相关。",
        suggested_action: "做一次复盘，巩固它已有的连接。",
      };
    }
    case "similar_entity": {
      const [a, b] = slugs;
      const titleA = resolveTitle(a, entityLookup);
      const titleB = resolveTitle(b, entityLookup);
      const matchKind = meta.match_kind as string | undefined;
      const kindLabel =
        matchKind === "alias_shadow_page" ? "名称已是别名的残留页"
        : matchKind === "shared_alias" ? "共享别名"
        : matchKind === "name_exact" ? "名称相同"
        : matchKind === "name_normalized" ? "名称仅大小写/标点不同"
        : matchKind === "name_substring" ? "名称相互包含"
        : matchKind === "edit_distance" ? "名称仅有细微拼写差异"
        : "名称高度相似";
      return {
        id: r.id,
        title: `可能重复：${titleA} 与 ${titleB}`,
        why_it_matters: `两条记忆${kindLabel}，类型相同或相近，疑似指向同一对象，合并前请核对。`,
        evidence: `${kindLabel}（置信度：${r.actionable === "high" ? "高" : "中"}）。`,
        suggested_action: "用 merge_entities 先 dry-run 核对，确认后再执行合并。",
      };
    }
    case "proactive_connection": {
      const [a, b] = slugs;
      return {
        id: r.id,
        title: `可能的连接：${resolveTitle(a, entityLookup)} 与 ${resolveTitle(b, entityLookup)}`,
        why_it_matters: "这两条记忆近期出现了多处共同信号，可能存在尚未记录的关联。",
        evidence: "综合图谱、检索与时间线索。",
        suggested_action: "确认是否需要建立关联，或忽略。",
      };
    }
    default: {
      const titles = slugs.map(s => resolveTitle(s, entityLookup)).join("、");
      return {
        id: r.id,
        title: `待确认发现：${titles}`,
        why_it_matters: "发现了一些新的线索，需要进一步确认。",
        evidence: "自动检测产生",
        suggested_action: r.suggestion ?? "查看详情。",
      };
    }
  }
}

export function formatDiscoveryDigest(
  rows: DiscoveryRow[],
  entityLookup: (slug: string) => EntityInfo | null,
  maxItems = 3,
): DiscoveryDigest {
  const filterReasons: Record<string, number> = {};
  const kept: DiscoveryRow[] = [];

  for (const r of rows) {
    // #267 — exclude action_* rows up front so they never reach shouldFilterDiscovery
    // (which would otherwise bucket them as unknown_type). This is the safety net that
    // covers read_discoveries (which does NOT pre-filter via isDigestExcluded upstream).
    if (isDigestExcluded(r.type)) {
      const key = `${r.type}_excluded`;
      filterReasons[key] = (filterReasons[key] ?? 0) + 1;
      continue;
    }
    const reason = shouldFilterDiscovery(r);
    if (reason) {
      filterReasons[reason] = (filterReasons[reason] ?? 0) + 1;
    } else {
      kept.push(r);
    }
  }

  kept.sort((a, b) => {
    const ao = ACTIONABLE_ORDER[a.actionable] ?? 9;
    const bo = ACTIONABLE_ORDER[b.actionable] ?? 9;
    if (ao !== bo) return ao - bo;
    return b.score - a.score;
  });

  const selected = kept.slice(0, maxItems);
  const cards = selected.map(r => formatDigestCard(r, entityLookup));

  const display = cards.length > 0
    ? cards.map(c => `### ${c.title}\n${c.why_it_matters}\n${c.evidence}\n**建议**：${c.suggested_action}`).join("\n\n---\n\n")
    : "暂无新的发现。";

  return {
    cards,
    display,
    _debug: {
      total_candidates: rows.length,
      filtered: rows.length - kept.length,
      filter_reasons: filterReasons,
    },
  };
}

/**
 * #244 — Independent Knowledge Map surface for read_discoveries/run_discovery.
 * Isolation cards first, then bridge cards, capped at maxItems (default 5).
 * Deterministic ordering: isolation-before-bridge, then the underlying row
 * order (actionable/score/id from the DB query). Does NOT mix into the normal
 * discovery digest, so normal ranking quotas are untouched.
 */
export function formatKnowledgeMapSurface(
  isolationRows: DiscoveryRow[],
  bridgeRows: DiscoveryRow[],
  entityLookup: (slug: string) => EntityInfo | null,
  maxItems = 5,
): { cards: DigestCard[]; display: string } {
  const isolationCards = isolationRows.map((r) => formatDigestCard(r, entityLookup));
  const bridgeCards = bridgeRows.map((r) => formatDigestCard(r, entityLookup));
  const cards = [...isolationCards, ...bridgeCards].slice(0, maxItems);
  const display =
    cards.length > 0
      ? "## 知识结构观察\n\n" +
        cards
          .map((c) => `### ${c.title}\n${c.why_it_matters}\n${c.evidence}\n**建议**：${c.suggested_action}`)
          .join("\n\n---\n\n")
      : "";
  return { cards, display };
}
