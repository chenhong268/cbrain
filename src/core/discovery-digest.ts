export interface DigestCard {
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

export function shouldFilterDiscovery(r: DiscoveryRow): string | null {
  if (r.type === "gap") return null;

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
        title: `需要补全：${resolveTitle(slug, entityLookup)}`,
        why_it_matters: "被频繁提及但缺少详细描述和关联。",
        evidence: `被提及 ${mentionCount ?? "?"} 次，仅有 ${linkCount ?? 0} 条关联`,
        suggested_action: "为该实体添加更详细的描述，建立与其他实体的关联。",
      };
    }
    case "contradiction": {
      const slug = slugs[0];
      return {
        title: `信息矛盾：${resolveTitle(slug, entityLookup)}`,
        why_it_matters: "多个来源对该实体的描述存在冲突。",
        evidence: (meta.explanation as string) ?? "来源信息不一致",
        suggested_action: (meta.suggested_resolution as string) ?? r.suggestion ?? "检查矛盾来源，确认正确信息。",
      };
    }
    default: {
      const titles = slugs.map(s => resolveTitle(s, entityLookup)).join("、");
      return {
        title: `待确认发现：${titles}`,
        why_it_matters: "检测到新的结构发现，需要进一步确认。",
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
