import { isComplexQuery } from "./search.js";
import type { CBrainDB } from "../storage/sqlite.js";

export interface RouteResult {
  mode: "fast" | "hybrid" | "agentic";
  intent: "entity_lookup" | "relationship" | "timeline" | "comparison" | "review" | "gap_analysis" | "keyword";
  reasons: string[];
}

type Intent = RouteResult["intent"];

const TEMPORAL_KEYWORDS = ["最近", "什么时候", "什么时候的", "上次", "下次", "上周", "这周", "时间线", "last time", "previously", "what changed"];
const RELATIONSHIP_KEYWORDS = ["关系", "联系", "之间", "关联", "relationship", "connected"];
const COMPARISON_KEYWORDS = ["对比", "区别", "哪个好", "哪个更", "vs", "VS", "compare", "difference", "differ"];
const REVIEW_KEYWORDS = ["复盘", "总结", "回顾", "变化", "进展", "summarize", "overview", "review of", "walk me through"];
const GAP_KEYWORDS = ["还", "有没有", "缺什么", "不足", "盲区", "遗漏", "不知道"];

// #255 — 比较 weak signal: adverb (比较+adj) never escalates; compare-structure does.
const COMPARISON_ADVERB_RE = /比较(重要|好|像|类似|复杂|大|小|多|少|强|弱|快|慢|新|旧|长|短|高|低|常见|明显|简单|稳定|活跃|特殊|普通|关键|主流|合理|接近)/;
const COMPARISON_STRUCTURE_RE = /比较[\s\S]{0,15}(和|与|跟)|(和|与|跟)[\s\S]{0,15}比较(一下)?/;

function isComparisonIntent(query: string): boolean {
  if (COMPARISON_KEYWORDS.some((kw) => query.includes(kw))) return true;
  if (query.includes("比较")) {
    if (COMPARISON_ADVERB_RE.test(query)) return false;
    return COMPARISON_STRUCTURE_RE.test(query);
  }
  return false;
}

export class QueryRouter {
  constructor(private readonly db: CBrainDB) {}

  route(query: string): RouteResult {
    const trimmed = query.trim();
    if (!trimmed) {
      return { mode: "hybrid", intent: "keyword", reasons: ["空查询"] };
    }

    // 1. Exact full-query title/slug match → fast (highest priority)
    const exactResolved = this.db.resolveSlugs([trimmed])[0];
    if (exactResolved?.slug) {
      return { mode: "fast", intent: "entity_lookup", reasons: [`精确匹配: ${exactResolved.slug}`] };
    }

    // Tokenize + resolve for downstream routing
    const candidates = trimmed.split(/[\s,，、；;和与跟以及]+/).filter((w) => w.length >= 2);
    const resolved = this.db.resolveSlugs(candidates);
    const knownSlugs = resolved.filter((r) => r.slug !== null).map((r) => r.slug!);

    // 2. Intent signals (only for non-exact queries)
    const hasComparison = isComparisonIntent(trimmed);
    const hasGap = GAP_KEYWORDS.some((kw) => trimmed.includes(kw));
    const hasRelationship = RELATIONSHIP_KEYWORDS.some((kw) => trimmed.includes(kw));
    const hasReview = REVIEW_KEYWORDS.some((kw) => trimmed.includes(kw));
    const hasTemporal = TEMPORAL_KEYWORDS.some((kw) => trimmed.includes(kw));

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
    // Timeline: entity-specific → agentic, generic → hybrid
    if (hasTemporal) {
      if (knownSlugs.length >= 1) {
        return { mode: "agentic", intent: "timeline", reasons: [`实体+时间线: ${knownSlugs.join(", ")}`] };
      }
      return { mode: "hybrid", intent: "timeline", reasons: ["时间相关查询"] };
    }

    // 3. Single known entity + not complex → fast
    if (knownSlugs.length === 1 && !isComplexQuery(trimmed, knownSlugs, candidates)) {
      return { mode: "fast", intent: "entity_lookup", reasons: [`单实体: ${knownSlugs[0]}`] };
    }

    // 4. Complex → agentic ONLY with a strong intent signal (#255: neutral actions stay hybrid)
    const complex = isComplexQuery(trimmed, knownSlugs, candidates);
    const hasStrongIntent = hasComparison || hasGap || hasRelationship || hasReview || hasTemporal;
    if (complex && hasStrongIntent) {
      return { mode: "agentic", intent: classifyComplexIntent(trimmed), reasons: [`复杂查询 (${reasonSuffix(trimmed, knownSlugs)})`] };
    }

    // 5. Default → hybrid/keyword
    return { mode: "hybrid", intent: "keyword", reasons: ["普通关键词查询"] };
  }
}

function classifyComplexIntent(query: string): Intent {
  if (isComparisonIntent(query)) return "comparison";
  if (REVIEW_KEYWORDS.some((kw) => query.includes(kw))) return "review";
  if (GAP_KEYWORDS.some((kw) => query.includes(kw))) return "gap_analysis";
  if (TEMPORAL_KEYWORDS.some((kw) => query.includes(kw))) return "timeline";
  if (RELATIONSHIP_KEYWORDS.some((kw) => query.includes(kw))) return "relationship";
  return "keyword";
}

function reasonSuffix(query: string, knownSlugs: string[]): string {
  if (knownSlugs.length >= 2) return `${knownSlugs.length} 个已知实体`;
  const tokens = query.split(/[\s,，、；;和与跟以及]+/).filter((w) => w.length >= 2);
  if (tokens.length >= 3) return `${tokens.length} 个 token`;
  return "结构化查询";
}
