import { isComplexQuery } from "./search.js";
import type { CBrainDB } from "../storage/sqlite.js";

export interface RouteResult {
  mode: "fast" | "hybrid" | "agentic";
  intent: "entity_lookup" | "relationship" | "timeline" | "comparison" | "review" | "gap_analysis" | "keyword";
  reasons: string[];
}

type Intent = RouteResult["intent"];

const TEMPORAL_KEYWORDS = ["最近", "什么时候", "什么时候的", "上次", "下次", "上周", "这周", "上周"];
const RELATIONSHIP_KEYWORDS = ["关系", "联系", "之间", "关联"];
const COMPARISON_KEYWORDS = ["比较", "对比", "区别", "哪个好", "vs", "VS"];
const REVIEW_KEYWORDS = ["复盘", "总结", "回顾", "变化", "进展"];
const GAP_KEYWORDS = ["还", "有没有", "缺什么", "不足", "盲区", "遗漏", "不知道"];

export class QueryRouter {
  constructor(private readonly db: CBrainDB) {}

  route(query: string): RouteResult {
    const trimmed = query.trim();
    if (!trimmed) {
      return { mode: "hybrid", intent: "keyword", reasons: ["空查询"] };
    }

    const candidates = trimmed.split(/[\s,，、；;和与跟以及]+/).filter((w) => w.length >= 2);
    const resolved = this.db.resolveSlugs(candidates);
    const knownSlugs = resolved.filter((r) => r.slug !== null).map((r) => r.slug!);

    // Detect intent signals before fast path — explicit intent overrides entity count
    const hasComparison = COMPARISON_KEYWORDS.some((kw) => trimmed.includes(kw));
    const hasGap = GAP_KEYWORDS.some((kw) => trimmed.includes(kw));
    const hasRelationship = RELATIONSHIP_KEYWORDS.some((kw) => trimmed.includes(kw));
    const hasReview = REVIEW_KEYWORDS.some((kw) => trimmed.includes(kw));
    const hasTemporal = TEMPORAL_KEYWORDS.some((kw) => trimmed.includes(kw));

    // 1. Explicit intent signals → agentic or hybrid (skip fast path)
    if (hasComparison) {
      return { mode: "agentic", intent: "comparison", reasons: ["比较意图"] };
    }
    if (hasGap) {
      return { mode: "agentic", intent: "gap_analysis", reasons: ["盲区分析意图"] };
    }
    if (hasRelationship) {
      return { mode: "agentic", intent: "relationship", reasons: ["关系查询意图"] };
    }
    if (hasReview) {
      return { mode: "agentic", intent: "review", reasons: ["复盘/回顾意图"] };
    }
    if (hasTemporal) {
      return { mode: "hybrid", intent: "timeline", reasons: ["时间相关查询"] };
    }

    // 2. Exact match → fast
    const exactResolved = this.db.resolveSlugs([trimmed])[0];
    if (exactResolved?.slug) {
      return { mode: "fast", intent: "entity_lookup", reasons: [`精确匹配: ${exactResolved.slug}`] };
    }

    // 3. Single known entity + not complex → fast
    if (knownSlugs.length === 1 && !isComplexQuery(trimmed, knownSlugs, candidates)) {
      return { mode: "fast", intent: "entity_lookup", reasons: [`单实体: ${knownSlugs[0]}`] };
    }

    // 4. Complex → agentic with intent classification
    const complex = isComplexQuery(trimmed, knownSlugs, candidates);
    if (complex) {
      return { mode: "agentic", intent: classifyComplexIntent(trimmed), reasons: [`复杂查询 (${reasonSuffix(trimmed, knownSlugs)})`] };
    }

    // 5. Default → hybrid/keyword
    return { mode: "hybrid", intent: "keyword", reasons: ["普通关键词查询"] };
  }
}

function classifyComplexIntent(query: string): Intent {
  if (COMPARISON_KEYWORDS.some((kw) => query.includes(kw))) return "comparison";
  if (REVIEW_KEYWORDS.some((kw) => query.includes(kw))) return "review";
  if (GAP_KEYWORDS.some((kw) => query.includes(kw))) return "gap_analysis";
  if (TEMPORAL_KEYWORDS.some((kw) => query.includes(kw))) return "timeline";
  if (RELATIONSHIP_KEYWORDS.some((kw) => query.includes(kw))) return "relationship";
  return "relationship";
}

function reasonSuffix(query: string, knownSlugs: string[]): string {
  if (knownSlugs.length >= 2) return `${knownSlugs.length} 个已知实体`;
  const tokens = query.split(/[\s,，、；;和与跟以及]+/).filter((w) => w.length >= 2);
  if (tokens.length >= 3) return `${tokens.length} 个 token`;
  return "结构化查询";
}
