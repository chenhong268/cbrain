import type { CBrainDB } from "../storage/sqlite.js";
import type { LLMProvider } from "../llm/provider.js";
import type { PageManager } from "./page.js";
import { generateSlug } from "../utils/slug.js";

// ─── Types ─────────────────────────────────────────────────────

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

// ─── Payload types for LLM JSON parsing ────────────────────────

interface SynthesisPayload {
  summary?: string;
  key_facts?: string[];
  confidence?: number;
}

interface RelationPayload {
  inferred_relations?: Array<{
    from: string;
    to: string;
    relation: string;
    reasoning: string;
    confidence: number;
  }>;
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

// ─── Constants ─────────────────────────────────────────────────

const MAX_LLM_CALLS = 50;
const MIN_MENTIONS = 3;
const MIN_NEIGHBORS = 5;
const MIN_CONFIDENCE = 0.7;
const BATCH_SIZE = 15;
const MAX_TITLE_CHARS = 10;
const MAX_CONTEXT_CHARS = 4000;

// ─── Prompts ───────────────────────────────────────────────────

const SYNTHESIS_SYSTEM = `你是一个知识图谱分析师。根据给定信息，生成实体的综合描述。
只陈述可从信息推导的事实，不编造。不确定时confidence设低。
输出JSON：{"summary": "2-3句话的综合描述", "key_facts": ["事实1", "事实2"], "confidence": 0.0到1.0}`;

const RELATION_SYSTEM = `你是一个知识图谱分析师。根据已知关系，判断实体对之间是否存在未标注的直接关系。
只输出有把握的推理，confidence低于0.6的不输出。
输出JSON：{"inferred_relations": [{"from": "slug", "to": "slug", "relation": "关系", "reasoning": "依据", "confidence": 0.0到1.0}]}`;

const INSIGHT_SYSTEM = `你是一个知识图谱分析师。分析实体簇中的模式，生成跨实体洞察。
洞察要有新意——不是复述已知关系，而是发现隐含的模式、趋势或对比。
输出JSON：{"insights": [{"title": "10字以内的精炼标题", "content": "洞察全文", "related_entities": ["slug1", "slug2"], "type": "trend|pattern|contrast|connection", "confidence": 0.0到1.0}]}
title规则：不超过10个字，提炼核心关键词，不要用"洞察""分析"等虚词开头，不要标点符号。`;

// ─── ReflectManager ────────────────────────────────────────────

export class ReflectManager {
  private db: CBrainDB;
  private llm: LLMProvider | null;
  private pageMgr: PageManager;

  constructor(db: CBrainDB, pageMgr: PageManager, llm?: LLMProvider) {
    this.db = db;
    this.pageMgr = pageMgr;
    this.llm = llm ?? null;
  }

  async reflectAll(): Promise<ReflectReport> {
    if (!this.llm) return emptyReport();

    const syntheses = await this.synthesizeEntities();
    const relations = await this.inferRelations();
    const insights = await this.generateInsights();

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

  // ─── Entity Synthesis ──────────────────────────────────────

  private async synthesizeEntities(): Promise<SynthesisResult[]> {
    const candidates = this.db.getHighMentionEntities(MIN_MENTIONS);
    const limit = Math.min(candidates.length, MAX_LLM_CALLS);
    const results: SynthesisResult[] = [];

    for (let i = 0; i < limit; i++) {
      const { slug } = candidates[i];
      const context = this.buildEntityContext(slug);
      if (!context) continue;

      const raw = await this.callLLM(SYNTHESIS_SYSTEM, context);
      const parsed = this.parseJSON<SynthesisPayload>(raw, null);
      if (!parsed?.summary) continue;

      results.push({
        slug,
        summary: parsed.summary,
        keyFacts: parsed.key_facts ?? [],
        confidence: parsed.confidence ?? 0.5,
      });

      const body = [
        parsed.summary,
        "",
        ...(parsed.key_facts ?? []).map((f) => `- ${f}`),
      ].join("\n");
      this.pageMgr.update(slug, { body });
    }

    return results;
  }

  // ─── Relation Inference ────────────────────────────────────

  private async inferRelations(): Promise<InferredRelation[]> {
    const pairs = this.findIndirectPairs();
    if (pairs.length === 0) return [];

    const allRelations: InferredRelation[] = [];
    const batches = this.chunk(pairs, BATCH_SIZE);
    const limit = Math.min(batches.length, MAX_LLM_CALLS);

    for (let i = 0; i < limit; i++) {
      const batch = batches[i];
      const pairContext = batch
        .map(
          ([a, b]) =>
            `${a} ↔ ${b}（间接连接，无直接关系）`
        )
        .join("\n");

      // Include existing relations for context
      const existingContext = this.buildRelationContext(batch);
      const userContent = `已知关系：\n${existingContext}\n\n待判断的实体对：\n${pairContext}`;

      const raw = await this.callLLM(RELATION_SYSTEM, userContent);
      const parsed = this.parseJSON<RelationPayload>(raw, null);
      if (!parsed?.inferred_relations) continue;

      for (const r of parsed.inferred_relations) {
        if ((r.confidence ?? 0) < MIN_CONFIDENCE) continue;
        if (!r.from || !r.to || !r.relation) continue;
        if (!this.db.getPage(r.from) || !this.db.getPage(r.to)) continue;

        this.db.insertLink(
          r.from,
          r.to,
          r.relation,
          `[inferred] ${r.reasoning ?? ""}`
        );

        allRelations.push({
          from: r.from,
          to: r.to,
          relation: r.relation,
          reasoning: r.reasoning ?? "",
          confidence: r.confidence,
        });
      }
    }

    return allRelations;
  }

  // ─── Insight Generation ────────────────────────────────────

  private async generateInsights(): Promise<GeneratedInsight[]> {
    const hubs = this.db.getHighConnectivityEntities(MIN_NEIGHBORS);
    const limit = Math.min(hubs.length, MAX_LLM_CALLS);
    const allInsights: GeneratedInsight[] = [];
    const createdSlugs = new Set<string>();

    for (let i = 0; i < limit; i++) {
      const { slug } = hubs[i];
      const context = this.buildClusterContext(slug);
      if (!context) continue;

      const raw = await this.callLLM(INSIGHT_SYSTEM, context);
      const parsed = this.parseJSON<InsightPayload>(raw, null);
      if (!parsed?.insights) continue;

      for (const ins of parsed.insights) {
        if (!ins.content) continue;

        const resolvedEntities = this.resolveRelatedEntities(ins.related_entities ?? []);

        const insight: GeneratedInsight = {
          content: ins.content,
          relatedEntities: resolvedEntities,
          type: ins.type ?? "pattern",
          confidence: ins.confidence ?? 0.5,
        };

        const rawTitle = ins.title?.trim() || this.extractTitleFallback(ins.content);
        const truncatedTitle = rawTitle.slice(0, MAX_TITLE_CHARS);
        const date = new Date().toISOString().slice(0, 10);
        const title = `${date} ${truncatedTitle}`;
        const insightSlug = generateSlug(title, "insight");

        if (this.db.getPage(insightSlug) || createdSlugs.has(insightSlug)) continue;
        createdSlugs.add(insightSlug);

        try {
          this.pageMgr.create({
            title,
            type: "insight",
            body: ins.content,
            tags: [
              "insight/auto",
              ...(ins.type ? [`insight/${ins.type}`] : []),
            ],
            slug: insightSlug,
            extra: {
              source_entities: resolvedEntities,
              confidence: ins.confidence,
            },
          });
          allInsights.push(insight);
        } catch {
          // Skip this insight on failure, continue to next
        }
      }
    }

    return allInsights;
  }

  // ─── Context Builders ──────────────────────────────────────

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
        lines.push(
          `  - ${l.from_slug} [${l.relation}]${l.context ? ` — ${l.context}` : ""}`
        );
      }
    }

    if (outLinks.length > 0) {
      lines.push("关联到：");
      for (const l of outLinks.slice(0, 20)) {
        lines.push(
          `  - ${l.to_slug} [${l.relation}]${l.context ? ` — ${l.context}` : ""}`
        );
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

  private buildClusterContext(hubSlug: string): string | null {
    const hubCtx = this.buildEntityContext(hubSlug);
    if (!hubCtx) return null;

    const neighbors = new Set<string>([
      ...this.db.getOutgoingSlugs(hubSlug),
      ...this.db.getIncomingSlugs(hubSlug),
    ]);

    const lines: string[] = [
      "=== 核心实体 ===",
      hubCtx,
      "",
      "=== 邻居实体 ===",
    ];

    let totalChars = hubCtx.length;
    let count = 0;
    for (const n of neighbors) {
      if (count >= 10) break;
      if (totalChars >= MAX_CONTEXT_CHARS) break;
      const nCtx = this.buildEntityContext(n);
      if (nCtx) {
        lines.push(nCtx);
        lines.push("");
        totalChars += nCtx.length + 1;
        count++;
      }
    }

    const result = lines.join("\n");
    return result.length > MAX_CONTEXT_CHARS
      ? result.slice(0, MAX_CONTEXT_CHARS)
      : result;
  }

  private buildRelationContext(
    pairs: Array<[string, string]>
  ): string {
    const slugs = new Set<string>();
    for (const [a, b] of pairs) {
      slugs.add(a);
      slugs.add(b);
    }

    const lines: string[] = [];
    for (const slug of slugs) {
      const out = this.db.getOutgoingLinks(slug);
      if (out.length === 0) continue;
      lines.push(`${slug} 的关系：`);
      for (const l of out.slice(0, 10)) {
        lines.push(`  → ${l.to_slug} [${l.relation}]`);
      }
    }

    return lines.length > 0 ? lines.join("\n") : "（无已知关系）";
  }

  // ─── Graph Queries ─────────────────────────────────────────

  private findIndirectPairs(): Array<[string, string]> {
    const allLinks = this.db.getAllLinks();

    const adj = new Map<string, Set<string>>();
    for (const { from_slug, to_slug } of allLinks) {
      let neighbors = adj.get(from_slug);
      if (!neighbors) {
        neighbors = new Set();
        adj.set(from_slug, neighbors);
      }
      neighbors.add(to_slug);
    }

    const seen = new Set<string>();
    const result: Array<[string, string]> = [];

    for (const [a, aNeighbors] of adj) {
      for (const b of aNeighbors) {
        const bNeighbors = adj.get(b);
        if (!bNeighbors) continue;

        for (const c of bNeighbors) {
          if (c === a) continue;
          if (aNeighbors.has(c)) continue;

          const key = [a, c].sort().join("→");
          if (seen.has(key)) continue;
          seen.add(key);
          result.push([a, c]);
        }
      }
    }

    return result;
  }

  // ─── LLM Helpers ───────────────────────────────────────────

  private async callLLM(
    systemPrompt: string,
    userContent: string
  ): Promise<string> {
    if (!this.llm) return "";
    return this.llm.chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ]);
  }

  private parseJSON<T>(raw: string, fallback: T | null): T | null {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  private resolveRelatedEntities(entities: string[]): string[] {
    if (entities.length === 0) return [];
    const resolved = this.db.resolveSlugs(entities);
    return resolved.filter(r => r.slug !== null).map(r => r.slug!);
  }

  private extractTitleFallback(content: string): string {
    const firstPhrase = content.split(/[。，！？\n.!?]/)[0] ?? content;
    return firstPhrase.trim().slice(0, MAX_TITLE_CHARS) || "未命名洞察";
  }
}

// ─── Helpers ───────────────────────────────────────────────────

function emptyReport(): ReflectReport {
  return {
    entitiesSynthesized: 0,
    relationsInferred: 0,
    insightsGenerated: 0,
    details: { syntheses: [], relations: [], insights: [] },
  };
}
