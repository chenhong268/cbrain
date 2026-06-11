import type { CBrainDB } from "../storage/sqlite.js";
import type { LLMProvider } from "../llm/provider.js";
import type { PageManager } from "./page.js";
import type { ContentPipeline } from "./pipeline.js";
import type { InsightManager } from "./insight.js";

export interface SynthesisResult {
  slug: string;
  summary: string;
  keyFacts: string[];
  confidence: number;
}

export interface InferredRelation {
  from: string;
  to: string;
  relation: string;
  reasoning: string;
  confidence: number;
}

export interface GeneratedInsight {
  content: string;
  relatedEntities: string[];
  type: string;
  confidence: number;
}

export interface ReflectReport {
  entitiesSynthesized: number;
  relationsInferred: number;
  insightsGenerated: number;
  details: {
    syntheses: Array<{ slug: string; summary: string }>;
    relations: Array<{ from: string; to: string; relation: string }>;
    insights: Array<{ content: string; related: string[] }>;
  };
}

interface SynthesisPayload {
  summary?: string;
  key_facts?: string[];
  confidence?: number;
}

interface InsightPayload {
  insights?: Array<{
    title?: string;
    content: string;
    related_entities?: string[];
    type?: string;
    confidence?: number;
  }>;
}

const MAX_LLM_CALLS = 50;
const MIN_MENTIONS = 3;
const MIN_CONFIDENCE = 0.7;
const CONCURRENCY = 3;

const W_PATH = 0.35;
const W_SOURCE = 0.25;
const W_TYPE = 0.20;
const W_CONTENT = 0.20;
const MAX_SUGGESTION_LLM = 8;
const MAX_CANDIDATE_POOL = 100;

export interface DiscoveryReport {
  total: number;
  byType: Record<string, number>;
  byActionable: Record<string, number>;
  autoApplicable: number;
}

const DISCOVERY_SUGGESTION_SYSTEM = `你是一个知识图谱分析师。根据两个实体之间的结构发现，生成简洁中文建议。
要求：1-2句话，说清楚为什么值得关注。如果有明确可操作建议，说出来。
不要废话。输出JSON：{"suggestion": "你的建议"}`;

const DISCOVERY_ACTION_SYSTEM = `你是一个知识图谱分析师。根据结构发现，判断可以采取什么操作。
输出JSON：{"actions": [{"type": "create_link|investigate", "target": "slug", "reason": "理由"}]}
只输出有明确依据的操作，不确定的用 investigate。`;

const BULLSHIT_PATTERNS = /值得深思|揭示了.{0,5}趋势|具有重要意义|我们认识到|可以推断|值得关注|无疑|显而易见|不言而喻|众所周知/;

const SYNTHESIS_SYSTEM = `你是一个知识图谱分析师。根据给定信息，生成实体的综合描述。
只陈述可从信息推导的事实，不编造。不确定时confidence设低。
输出JSON：{"summary": "2-3句话的综合描述", "key_facts": ["事实1", "事实2"], "confidence": 0.0到1.0}`;

const INSIGHT_SYSTEM = `你是一个知识图谱分析师。你的任务是从素材中判断是否存在值得记录的洞察。

核心原则：好的洞察是稀有的。找不到有力的洞察是正常的——输出空数组，不要硬编。

洞察的定义：
从素材中 A 和 B 两个事实，推导出素材中没人直接说过的结论 C。
- A 和 B 必须来自素材中的具体细节，不是泛化印象
- C 必须是 A+B 的逻辑推论，不是感受、不是评价、不是换个说法
- C 必须让人产生"我之前没想到"的反应

反例（这些不是洞察，不要输出）：
- 复述素材已有观点 → 那是摘要
- "A和B有相似之处" → 太浅
- "XXX揭示了某种趋势" → 没有说清楚是什么趋势
- "这种模式值得深思" → 废话
- 素材中只有 A，你自己补了个 B → 编造

confidence 标准：
- 0.9+：A和B来自两个不同素材，C是跨域推理且逻辑链清晰
- 0.8-0.9：A和B来自同一素材的不同部分，C有明确证据支撑
- 0.7-0.8：推理合理但存在其他解释
- <0.7：不确定，不输出

输出JSON：{"insights": [{"title": "标题（10字以内，点出核心）", "content": "洞察全文（100-200字，必须引用具体细节）", "related_entities": ["slug1", "slug2"], "type": "trend|pattern|contrast|connection", "confidence": 0.0到1.0}]}`;

// ─── ReflectManager ────────────────────────────────────────────

export class ReflectManager {
  private db: CBrainDB;
  private llm: LLMProvider | null;
  private insightMgr: InsightManager | null;
  private logger?: import("./logger.js").Logger;

  constructor(db: CBrainDB, _pageMgr: PageManager, llm?: LLMProvider, _pipeline?: ContentPipeline, _embedding?: unknown, insightMgr?: InsightManager, logger?: import("./logger.js").Logger) {
    this.db = db;
    this.llm = llm ?? null;
    this.insightMgr = insightMgr ?? null;
    this.logger = logger;
  }

  async reflectAll(): Promise<ReflectReport> {
    if (!this.llm) return emptyReport();

    const [syntheses, relations, insights] = await Promise.all([
      this.synthesizeEntities(),
      this.inferRelations(),
      this.generateInsights(),
    ]);

    return {
      entitiesSynthesized: syntheses.length,
      relationsInferred: relations.length,
      insightsGenerated: insights.length,
      details: {
        syntheses: syntheses.map((s) => ({ slug: s.slug, summary: s.summary })),
        relations: relations.map((r) => ({
          from: r.from,
          to: r.to,
          relation: r.relation,
        })),
        insights: insights.map((i) => ({
          content: i.content,
          related: i.relatedEntities,
        })),
      },
    };
  }

  private async synthesizeEntities(): Promise<SynthesisResult[]> {
    const candidates = this.db.getHighMentionEntities(MIN_MENTIONS);
    const limit = Math.min(candidates.length, MAX_LLM_CALLS);
    const tasks = candidates.slice(0, limit).map((c) => ({ slug: c.slug, context: this.buildEntityContext(c.slug) }));
    const valid = tasks.filter((t) => t.context !== null);
    const results: SynthesisResult[] = [];

    const batches = this.chunk(valid, CONCURRENCY);
    for (const batch of batches) {
      const responses = await Promise.all(
        batch.map(async (t) => {
          const raw = await this.callLLM(SYNTHESIS_SYSTEM, t.context!);
          const parsed = this.parseJSON<SynthesisPayload>(raw, null);
          if (!parsed?.summary) return null;
          return { slug: t.slug, parsed: { summary: parsed.summary, key_facts: parsed.key_facts, confidence: parsed.confidence } };
        })
      );

      for (const r of responses) {
        if (!r) continue;
        results.push({
          slug: r.slug,
          summary: r.parsed.summary!,
          keyFacts: r.parsed.key_facts ?? [],
          confidence: r.parsed.confidence ?? 0.5,
        });
      }
    }

    return results;
  }

  private async inferRelations(): Promise<InferredRelation[]> {
    return []; // disabled — inferred relation quality too low
  }

  private async generateInsights(): Promise<GeneratedInsight[]> {
    if (!this.llm) return [];

    const existingSigs = this.buildExistingInsightSigs();
    const candidates = this.db.getHighMentionEntities(MIN_MENTIONS);
    const limit = Math.min(candidates.length, MAX_LLM_CALLS);
    const tasks = candidates.slice(0, limit).map((c) => ({ slug: c.slug, context: this.buildEntityContext(c.slug) }));
    const valid = tasks.filter((t) => t.context !== null);
    const results: GeneratedInsight[] = [];

    const batches = this.chunk(valid, CONCURRENCY);
    for (const batch of batches) {
      const responses = await Promise.all(
        batch.map(async (t) => {
          const raw = await this.callLLM(INSIGHT_SYSTEM, t.context!);
          const parsed = this.parseJSON<InsightPayload>(raw, null);
          return { slug: t.slug, parsed };
        })
      );

      for (const r of responses) {
        if (!r.parsed?.insights) continue;
        for (const item of r.parsed.insights) {
          if (BULLSHIT_PATTERNS.test(item.content)) continue;
          const confidence = item.confidence ?? 0.5;
          if (confidence < MIN_CONFIDENCE) continue;

          const entities = item.related_entities ?? [r.slug];
          const sig = new Set(entities);
          if (existingSigs.some((s) => s.size === sig.size && [...s].every((e) => sig.has(e)))) continue;

          const insight: GeneratedInsight = {
            content: item.content,
            relatedEntities: entities,
            type: item.type ?? "pattern",
            confidence,
          };
          results.push(insight);

          if (this.insightMgr) {
            try {
              await this.insightMgr.createInsight({
                content: insight.content,
                type: mapInsightType(insight.type),
                confidence: insight.confidence,
                sourceEntities: insight.relatedEntities,
                sourceType: "reflect",
              });
            } catch (e) {
              this.logger?.error("reflect", "insight 写入失败", { error: e instanceof Error ? e.message : String(e) });
            }
          }
        }
      }
    }

    return results;
  }

  private async generateInsightsForSlugs(slugs: string[]): Promise<GeneratedInsight[]> {
    if (!this.llm || slugs.length === 0) return [];

    const existingSigs = this.buildExistingInsightSigs();
    const tasks = slugs.map((slug) => ({ slug, context: this.buildEntityContext(slug) })).filter((t) => t.context !== null);
    const results: GeneratedInsight[] = [];

    const batches = this.chunk(tasks, CONCURRENCY);
    for (const batch of batches) {
      const responses = await Promise.all(
        batch.map(async (t) => {
          const raw = await this.callLLM(INSIGHT_SYSTEM, t.context!);
          const parsed = this.parseJSON<InsightPayload>(raw, null);
          return { slug: t.slug, parsed };
        })
      );

      for (const r of responses) {
        if (!r.parsed?.insights) continue;
        for (const item of r.parsed.insights) {
          if (BULLSHIT_PATTERNS.test(item.content)) continue;
          const confidence = item.confidence ?? 0.5;
          if (confidence < MIN_CONFIDENCE) continue;

          const entities = item.related_entities ?? [r.slug];
          const sig = new Set(entities);
          if (existingSigs.some((s) => s.size === sig.size && [...s].every((e) => sig.has(e)))) continue;

          const insight: GeneratedInsight = {
            content: item.content,
            relatedEntities: entities,
            type: item.type ?? "pattern",
            confidence,
          };
          results.push(insight);

          if (this.insightMgr) {
            try {
              await this.insightMgr.createInsight({
                content: insight.content,
                type: mapInsightType(insight.type),
                confidence: insight.confidence,
                sourceEntities: insight.relatedEntities,
                sourceType: "reflect",
              });
            } catch (e) {
              this.logger?.error("reflect", "insight 写入失败", { error: e instanceof Error ? e.message : String(e) });
            }
          }
        }
      }
    }

    return results;
  }

  async reflectIncremental(): Promise<ReflectReport> {
    if (!this.llm) return emptyReport();

    const lastRun = this.db.getConfig("reflect.last_run_at");
    const since = lastRun ?? new Date(0).toISOString();

    const changed = this.db.getEntityConceptPagesUpdatedSince(since);
    if (changed.length === 0) {
      return emptyReport();
    }

    const slugs = changed.map((p) => p.slug).slice(0, MAX_LLM_CALLS);

    const [syntheses, insights] = await Promise.all([
      this.synthesizeEntitiesForSlugs(slugs),
      this.generateInsightsForSlugs(slugs),
    ]);

    const now = new Date().toISOString();
    this.db.setConfig("reflect.last_run_at", now);

    return {
      entitiesSynthesized: syntheses.length,
      relationsInferred: 0,
      insightsGenerated: insights.length,
      details: {
        syntheses: syntheses.map((s) => ({ slug: s.slug, summary: s.summary })),
        relations: [],
        insights: insights.map((i) => ({
          content: i.content,
          related: i.relatedEntities,
        })),
      },
    };
  }

  private async synthesizeEntitiesForSlugs(slugs: string[]): Promise<SynthesisResult[]> {
    const tasks = slugs.map((slug) => ({ slug, context: this.buildEntityContext(slug) })).filter((t) => t.context !== null);
    const results: SynthesisResult[] = [];

    const batches = this.chunk(tasks, CONCURRENCY);
    for (const batch of batches) {
      const responses = await Promise.all(
        batch.map(async (t) => {
          const raw = await this.callLLM(SYNTHESIS_SYSTEM, t.context!);
          const parsed = this.parseJSON<SynthesisPayload>(raw, null);
          if (!parsed?.summary) return null;
          return { slug: t.slug, parsed: { summary: parsed.summary, key_facts: parsed.key_facts, confidence: parsed.confidence } };
        })
      );

      for (const r of responses) {
        if (!r) continue;
        results.push({
          slug: r.slug,
          summary: r.parsed.summary!,
          keyFacts: r.parsed.key_facts ?? [],
          confidence: r.parsed.confidence ?? 0.5,
        });
      }
    }

    return results;
  }

  private buildEntityContext(slug: string): string | null {
    const page = this.db.getPage(slug);
    if (!page) return null;

    const inLinks = this.db.getIncomingLinks(slug);
    const outLinks = this.db.getOutgoingLinks(slug);
    const timeline = this.db.getTimeline(slug);
    const tags = this.db.getTags(slug);

    const lines: string[] = [
      `实体：${page.title}（slug: ${slug}）`,
      `类型：${page.type}，层级：${page.tier}，被引用 ${page.mention_count} 次`,
    ];

    if (tags.length > 0) lines.push(`标签：${tags.join(", ")}`);

    if (inLinks.length > 0) {
      lines.push("被引用：");
      for (const l of inLinks.slice(0, 20)) {
        lines.push(`  - ${l.from_slug} [${l.relation}]${l.context ? ` — ${l.context}` : ""}`);
      }
    }

    if (outLinks.length > 0) {
      lines.push("关联到：");
      for (const l of outLinks.slice(0, 20)) {
        lines.push(`  - ${l.to_slug} [${l.relation}]${l.context ? ` — ${l.context}` : ""}`);
      }
    }

    if (timeline.length > 0) {
      lines.push("时间线：");
      for (const t of timeline.slice(0, 10)) {
        lines.push(`  - ${t.event_date ?? "未知日期"}: ${t.summary}`);
      }
    }

    return lines.join("\n");
  }

  private buildExistingInsightSigs(): Array<Set<string>> {
    const sigs: Array<Set<string>> = [];
    const insights = this.db.listInsights({ status: "active" });
    for (const insight of insights) {
      try {
        const entities: string[] = insight.source_entities
          ? JSON.parse(insight.source_entities)
          : [];
        if (entities.length > 0) sigs.push(new Set(entities));
      } catch { /* skip malformed */ }
    }
    return sigs;
  }

  private buildAdjacency(): Map<string, Set<string>> {
    const allLinks = this.db.getAllLinks();
    const adj = new Map<string, Set<string>>();
    for (const { from_slug, to_slug } of allLinks) {
      if (!adj.has(from_slug)) adj.set(from_slug, new Set());
      if (!adj.has(to_slug)) adj.set(to_slug, new Set());
      adj.get(from_slug)!.add(to_slug);
      adj.get(to_slug)!.add(from_slug);
    }
    return adj;
  }

  private findIndirectPairs(adj?: Map<string, Set<string>>): Array<[string, string]> {
    const a = adj ?? this.buildAdjacency();
    const seen = new Set<string>();
    const result: Array<[string, string]> = [];
    for (const [node, nodeNeighbors] of a) {
      for (const b of nodeNeighbors) {
        const bNeighbors = a.get(b);
        if (!bNeighbors) continue;
        for (const c of bNeighbors) {
          if (c === node) continue;
          if (nodeNeighbors.has(c)) continue;
          const key = [node, c].sort().join("→");
          if (seen.has(key)) continue;
          seen.add(key);
          result.push([node, c]);
        }
      }
    }
    return result;
  }

  // ─── Discovery Pipeline ──────────────────────────────────────

  async runDiscovery(dreamRun?: string): Promise<DiscoveryReport> {
    const adj = this.buildAdjacency();
    const pool = await this.buildCandidatePool(adj);
    const scored: Array<{ pair: [string, string]; score: number }> = [];
    for (const pair of pool) {
      const s = await this.scoreCandidate(pair[0], pair[1], adj);
      if (s > 0.3) scored.push({ pair, score: s });
    }
    scored.sort((a, b) => b.score - a.score);

    const byType: Record<string, number> = {};
    const byActionable: Record<string, number> = { high: 0, medium: 0, low: 0 };
    let autoApplicable = 0;
    let total = 0;
    let suggestionCount = 0;

    for (let i = 0; i < Math.min(scored.length, 20); i++) {
      const { pair, score } = scored[i];
      const dist = this.bfsDistance(pair[0], pair[1], adj);
      if (dist === Infinity) continue;
      const sourcesA = this.getSourcePages(pair[0]);
      const sourcesB = this.getSourcePages(pair[1]);
      const jaccard = this.jaccardDistance(sourcesA, sourcesB);
      const type = dist >= 4 ? "bridge" : dist >= 2 ? "community_crossing" : "structural_hole";

      const pageA = this.db.getPage(pair[0]);
      const pageB = this.db.getPage(pair[1]);
      const typeA = pageA?.type ?? "unknown";
      const typeB = pageB?.type ?? "unknown";
      const actionable = this.classifyActionable(score, type, typeA, typeB);

      const isAutoApplicable = score >= 0.8 && !!pageA && !!pageB;
      const { id, inserted } = this.db.upsertDiscovery(type, pair, Math.round(score * 100) / 100, {
        distance: dist,
        sourceJaccard: Math.round(jaccard * 100) / 100,
      }, dreamRun, actionable, isAutoApplicable);

      // Only inserted rows contribute to public/new-finding counters
      if (!inserted) continue;

      if (isAutoApplicable) autoApplicable++;
      byType[type] = (byType[type] ?? 0) + 1;
      byActionable[actionable]++;
      total++;

      // LLM suggestion for actionable != low, budget limited
      if (actionable !== "low" && this.llm && suggestionCount < MAX_SUGGESTION_LLM) {
        suggestionCount++;
        try {
          const titleA = pageA?.title ?? pair[0];
          const titleB = pageB?.title ?? pair[1];
          const suggestionRaw = await this.callLLM(
            DISCOVERY_SUGGESTION_SYSTEM,
            `发现类型：${type}，距离：${dist}跳，Jaccard：${jaccard.toFixed(2)}\n实体A：${titleA}（${typeA}）\n实体B：${titleB}（${typeB}）\n得分：${score.toFixed(2)}`
          );
          const parsed = this.parseJSON<{ suggestion: string }>(suggestionRaw, null);
          const suggestion = parsed?.suggestion ?? suggestionRaw;
          if (suggestion) this.db.updateDiscoverySuggestion(id, suggestion);

          if (actionable === "high") {
            const actionRaw = await this.callLLM(
              DISCOVERY_ACTION_SYSTEM,
              `实体A：${titleA}（${pair[0]}）\n实体B：${titleB}（${pair[1]}）\n发现类型：${type}，得分：${score.toFixed(2)}`
            );
            const parsed = this.parseJSON<{ actions: Array<{ type: string; target: string; reason: string }> }>(actionRaw, null);
            if (parsed?.actions?.length) this.db.updateDiscoveryActions(id, parsed.actions);
          }
        } catch {
          // LLM failure is non-fatal, suggestion stays null
        }
      }
    }

    this.db.setConfig("discovery.last_run_at", new Date().toISOString());

    return { total, byType, byActionable, autoApplicable };
  }

  private classifyActionable(score: number, type: string, typeA: string, typeB: string): string {
    const mixedTypes = (typeA.startsWith("entity/") && typeB.startsWith("concept/")) || (typeA.startsWith("concept/") && typeB.startsWith("entity/"));
    if (score >= 0.7 && (mixedTypes || type === "bridge")) return "high";
    if (score >= 0.5) return "medium";
    return "low";
  }

  private bfsDistance(a: string, b: string, adj?: Map<string, Set<string>>): number {
    if (a === b) return 0;
    const g = adj ?? this.buildAdjacency();
    const visited = new Set<string>([a]);
    let frontier = new Set<string>([a]);
    let dist = 0;
    while (frontier.size > 0) {
      dist++;
      const next = new Set<string>();
      for (const node of frontier) {
        for (const neighbor of g.get(node) ?? []) {
          if (neighbor === b) return dist;
          if (!visited.has(neighbor)) { visited.add(neighbor); next.add(neighbor); }
        }
      }
      frontier = next;
    }
    return Infinity;
  }

  private labelPropagation(adj?: Map<string, Set<string>>): Map<string, number> {
    const g = adj ?? this.buildAdjacency();
    const nodeList = [...g.keys()];
    const labels = new Map<string, number>();
    for (let i = 0; i < nodeList.length; i++) labels.set(nodeList[i], i);
    for (let iter = 0; iter < 20; iter++) {
      let changed = false;
      for (const node of nodeList) {
        const neighbors = g.get(node);
        if (!neighbors || neighbors.size === 0) continue;
        const counts = new Map<number, number>();
        for (const nb of neighbors) counts.set(labels.get(nb)!, (counts.get(labels.get(nb)!) ?? 0) + 1);
        let best = labels.get(node)!, bestCount = 0;
        for (const [lbl, cnt] of counts) { if (cnt > bestCount) { best = lbl; bestCount = cnt; } }
        if (best !== labels.get(node)) { labels.set(node, best); changed = true; }
      }
      if (!changed) break;
    }
    return labels;
  }

  private getSourcePages(slug: string): Set<string> {
    const sources = new Set<string>();
    for (const l of this.db.getIncomingLinks(slug)) {
      if (l.from_slug.startsWith("records/")) sources.add(l.from_slug);
    }
    return sources;
  }

  // Neutral prior: when both sets are empty, return 0.5 distance (similarity 0.5)
  // — neither rewards nor penalizes pairs with no source/neighbor evidence.
  private jaccardDistance(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0.5;
    const intersection = [...a].filter(x => b.has(x)).length;
    return 1 - intersection / new Set([...a, ...b]).size;
  }

  private async scoreCandidate(a: string, b: string, adj?: Map<string, Set<string>>): Promise<number> {
    const dist = this.bfsDistance(a, b, adj);
    if (dist === Infinity) return 0;
    const pathScore = dist >= 6 ? 1.0 : dist <= 1 ? 0 : (dist - 1) / 5;
    const sourceScore = this.jaccardDistance(this.getSourcePages(a), this.getSourcePages(b));
    const pa = this.db.getPage(a), pb = this.db.getPage(b);
    const ta = pa?.type ?? "", tb = pb?.type ?? "";
    const typeScore = (ta.startsWith("entity/") && tb.startsWith("concept/")) || (ta.startsWith("concept/") && tb.startsWith("entity/")) ? 1.0 : ta.startsWith("concept/") && tb.startsWith("concept/") ? 0.5 : 0.3;
    const neighborsA = adj?.get(a) ?? new Set<string>();
    const neighborsB = adj?.get(b) ?? new Set<string>();
    const contentScore = 1 - this.jaccardDistance(neighborsA, neighborsB);
    return W_PATH * pathScore + W_SOURCE * sourceScore + W_TYPE * typeScore + W_CONTENT * contentScore;
  }

  private async buildCandidatePool(adj?: Map<string, Set<string>>): Promise<Array<[string, string]>> {
    const seen = new Set<string>();
    const key = (a: string, b: string) => [a, b].sort().join("|||");
    for (const [a, c] of this.findIndirectPairs(adj)) seen.add(key(a, c));
    const communities = this.labelPropagation(adj);
    const groups = new Map<number, string[]>();
    for (const [slug, lbl] of communities) groups.set(lbl, [...(groups.get(lbl) ?? []), slug]);
    const groupList = [...groups.values()].filter(g => g.length >= 2);
    if (groupList.length >= 2) {
      for (let i = 0; i < groupList.length - 1; i++) {
        for (let j = i + 1; j < Math.min(groupList.length, i + 5); j++) {
          seen.add(key(groupList[i][Math.floor(Math.random() * groupList[i].length)], groupList[j][Math.floor(Math.random() * groupList[j].length)]));
        }
      }
    }
    const entities = this.db.getEntityConceptPages();
    if (entities.length >= 10) {
      for (let i = 0; i < 30; i++) {
        const a = entities[Math.floor(Math.random() * entities.length)].slug;
        const b = entities[Math.floor(Math.random() * entities.length)].slug;
        if (a !== b) seen.add(key(a, b));
      }
    }
    const all = [...seen].map(k => k.split("|||") as [string, string]);
    if (all.length <= MAX_CANDIDATE_POOL) return all;
    const shuffled = all.sort(() => Math.random() - 0.5);
    return shuffled.slice(0, MAX_CANDIDATE_POOL);
  }

  async diagnoseCandidates(): Promise<{
    poolSize: number; bySource: { indirect: number; crossCommunity: number; randomDistant: number };
    topCandidates: Array<{ rank: number; score: number; dist: number; sourceJaccard: number; typeMix: string; entityA: string; entityB: string }>;
    scoreDistribution: Array<{ bucket: string; count: number }>;
  }> {
    const adj = this.buildAdjacency();
    const pool = await this.buildCandidatePool(adj);
    const scored: Array<{ pair: [string, string]; score: number }> = [];
    for (const pair of pool) {
      scored.push({ pair, score: await this.scoreCandidate(pair[0], pair[1], adj) });
    }
    scored.sort((a, b) => b.score - a.score);

    const indirectSet = new Set(this.findIndirectPairs(adj).map(([a, b]) => [a, b].sort().join("|||")));
    const labels = this.labelPropagation(adj);
    let byIndirect = 0, byCross = 0, byRandom = 0;
    for (const { pair } of scored) {
      const k = pair[0] < pair[1] ? `${pair[0]}|||${pair[1]}` : `${pair[1]}|||${pair[0]}`;
      if (indirectSet.has(k)) { byIndirect++; continue; }
      const aL = labels.get(pair[0]), bL = labels.get(pair[1]);
      if (aL !== undefined && bL !== undefined && aL !== bL) byCross++;
      else byRandom++;
    }

    const top10 = scored.slice(0, 10).map(({ pair, score }, i) => {
      const dist = this.bfsDistance(pair[0], pair[1], adj);
      const pa = this.db.getPage(pair[0]), pb = this.db.getPage(pair[1]);
      const sourcesA = this.getSourcePages(pair[0]), sourcesB = this.getSourcePages(pair[1]);
      return {
        rank: i + 1,
        score: Math.round(score * 100) / 100,
        dist: dist === Infinity ? -1 : dist,
        sourceJaccard: Math.round(this.jaccardDistance(sourcesA, sourcesB) * 100) / 100,
        typeMix: `${pa?.type ?? "-"}-${pb?.type ?? "-"}`,
        entityA: pa?.title ?? pair[0],
        entityB: pb?.title ?? pair[1],
      };
    });

    const buckets = [{ bucket: "0.0-0.2", min: 0, max: 0.2 }, { bucket: "0.2-0.4", min: 0.2, max: 0.4 }, { bucket: "0.4-0.6", min: 0.4, max: 0.6 }, { bucket: "0.6-0.8", min: 0.6, max: 0.8 }, { bucket: "0.8-1.0", min: 0.8, max: 1.0 }];
    return {
      poolSize: pool.length,
      bySource: { indirect: byIndirect, crossCommunity: byCross, randomDistant: byRandom },
      topCandidates: top10,
      scoreDistribution: buckets.map(b => ({ bucket: b.bucket, count: scored.filter(s => s.score >= b.min && s.score < b.max).length })),
    };
  }

  // ─── LLM Helpers ───────────────────────────────────────────

  private async callLLM(systemPrompt: string, userContent: string): Promise<string> {
    if (!this.llm) return "";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.llm.chat([
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ]);
      } catch (e) {
        if (attempt === 2) throw e;
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      }
    }
    return "";
  }

  private parseJSON<T>(raw: string, fallback: T | null): T | null {
    try { return JSON.parse(raw) as T; } catch { return fallback; }
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
  }
}

function mapInsightType(llmType: string): "synthesis" | "pattern" | "anomaly" | "bridge" {
  switch (llmType) {
    case "trend": return "pattern";
    case "contrast": return "anomaly";
    case "connection": return "bridge";
    default: return "pattern";
  }
}

function emptyReport(): ReflectReport {
  return {
    entitiesSynthesized: 0,
    relationsInferred: 0,
    insightsGenerated: 0,
    details: { syntheses: [], relations: [], insights: [] },
  };
}
