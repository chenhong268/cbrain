import type { CBrainDB } from "../storage/sqlite.js";
import type { LLMProvider } from "../llm/provider.js";
import type { PageManager } from "./page.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
const TITLE_SAFETY_LIMIT = 20;
const MAX_CONTEXT_CHARS = 12000;
const CONCURRENCY = 2;

// ─── Prompts ───────────────────────────────────────────────────

const SYNTHESIS_SYSTEM = `你是一个知识图谱分析师。根据给定信息，生成实体的综合描述。
只陈述可从信息推导的事实，不编造。不确定时confidence设低。
输出JSON：{"summary": "2-3句话的综合描述", "key_facts": ["事实1", "事实2"], "confidence": 0.0到1.0}`;

const RELATION_SYSTEM = `你是一个知识图谱分析师。根据已知关系，判断实体对之间是否存在未标注的直接关系。
只输出有把握的推理，confidence低于0.6的不输出。
输出JSON：{"inferred_relations": [{"from": "slug", "to": "slug", "relation": "关系", "reasoning": "依据", "confidence": 0.0到1.0}]}`;

const INSIGHT_SYSTEM = `你是一个犀利的商业和知识分析师。从给定素材中提炼出非显而易见的洞察。

严格要求（违反任何一条就不要输出该洞察）：
1. 不要复述素材中已明确说出的观点或事实——那不叫洞察，那叫摘要
2. 洞察必须是一个推理结论：从 A 和 B 推导出素材中没人直接说过的 C
3. 必须引用素材中的具体细节作为论据，不能泛泛而谈
4. 如果找不到有说服力的推理结论，输出空数组 {"insights": []}

写作风格（去AI化）：
写出来的东西要像朋友之间聊天时突然冒出的那个发现。用短句，别超过20字一句。说话要有节奏，快慢交替。别怕语气随意，怕的是端着。不要"不仅...而且""揭示""表明""这说明"，直接说人话。把最尖锐的判断放在最前面，别铺垫。可以口语化，可以不完整，可以带点主观偏见。别总结，别升华，别收尾。像是喝咖啡时随口说的一句话，不是发在公众号上的分析文章。

好的洞察范例：
- "苏宁780亿砸向体育、地产、文创，全军覆没。巴菲特六十年只碰看得懂的东西。两个极端说同一件事：认知边界就是投资边界。"
- "保供率98%，退货率才2%。这俩数放一块才有点意思。高保供不是堆库存堆出来的，是供应链精准的副产品。"
- "大众在北美跟Google硬刚，在中国拉小鹏当队友。同一辆车，两副面孔。说白了就是没想清楚，走一步看一步。"

差的洞察（绝对不要输出）：
- "XXX揭示了认知局限性" → 摘要
- "这种模式值得深思" → 废话
- "A和B有相似之处" → 太浅
- "不仅...而且...因此..." → AI套路句式

输出JSON：{"insights": [{"title": "标题", "content": "洞察全文（100-200字，必须含具体引用）", "related_entities": ["slug1", "slug2"], "type": "trend|pattern|contrast|connection", "confidence": 0.0到1.0}]}
title规则：根据内容自拟标题，言简意赅，突出核心本质，10字以内。`;

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
        const body = [r.parsed.summary!, "", ...(r.parsed.key_facts ?? []).map((f) => `- ${f}`)].join("\n");
        this.pageMgr.update(r.slug, { body });
      }
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
    const llmBatches = this.chunk(batches.slice(0, limit), CONCURRENCY);

    for (const concurrentBatch of llmBatches) {
      const responses = await Promise.all(
        concurrentBatch.map(async (batch) => {
          const pairContext = batch
            .map(([a, b]) => `${a} ↔ ${b}（间接连接，无直接关系）`)
            .join("\n");
          const existingContext = this.buildRelationContext(batch);
          const userContent = `已知关系：\n${existingContext}\n\n待判断的实体对：\n${pairContext}`;
          const raw = await this.callLLM(RELATION_SYSTEM, userContent);
          return this.parseJSON<RelationPayload>(raw, null);
        })
      );

      for (const parsed of responses) {
        if (!parsed?.inferred_relations) continue;
        for (const r of parsed.inferred_relations) {
          if ((r.confidence ?? 0) < MIN_CONFIDENCE) continue;
          if (!r.from || !r.to || !r.relation) continue;
          if (!this.db.getPage(r.from) || !this.db.getPage(r.to)) continue;

          this.db.insertLink(r.from, r.to, r.relation, `[inferred] ${r.reasoning ?? ""}`);
          allRelations.push({
            from: r.from,
            to: r.to,
            relation: r.relation,
            reasoning: r.reasoning ?? "",
            confidence: r.confidence,
          });
        }
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

    const tasks = hubs.slice(0, limit).map((h) => ({ slug: h.slug, context: this.buildClusterContext(h.slug) }));
    const valid = tasks.filter((t) => t.context !== null);
    const batches = this.chunk(valid, CONCURRENCY);

    for (const batch of batches) {
      const responses = await Promise.all(
        batch.map(async (t) => {
          const raw = await this.callLLM(INSIGHT_SYSTEM, t.context!);
          return { slug: t.slug, parsed: this.parseJSON<InsightPayload>(raw, null) };
        })
      );

      for (const { parsed } of responses) {
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
          const truncatedTitle = rawTitle.slice(0, TITLE_SAFETY_LIMIT);
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
              tags: ["insight/auto", ...(ins.type ? [`insight/${ins.type}`] : [])],
              slug: insightSlug,
              extra: { source_entities: resolvedEntities, confidence: ins.confidence },
            });
            allInsights.push(insight);
          } catch {
            // Skip on failure
          }
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
    const hubPage = this.db.getPage(hubSlug);
    if (!hubPage) return null;

    const neighbors = new Set<string>([
      ...this.db.getOutgoingSlugs(hubSlug),
      ...this.db.getIncomingSlugs(hubSlug),
    ]);

    const lines: string[] = [
      "=== 核心实体 ===",
      this.buildPageContent(hubSlug, hubPage),
      "",
      "=== 关联素材 ===",
    ];

    let totalChars = lines.join("\n").length;
    let count = 0;
    for (const n of neighbors) {
      if (count >= 10) break;
      if (totalChars >= MAX_CONTEXT_CHARS) break;
      const nPage = this.db.getPage(n);
      if (!nPage) continue;
      const content = this.buildPageContent(n, nPage);
      lines.push(content);
      lines.push("");
      totalChars += content.length + 1;
      count++;
    }

    const result = lines.join("\n");
    return result.length > MAX_CONTEXT_CHARS
      ? result.slice(0, MAX_CONTEXT_CHARS)
      : result;
  }

  private buildPageContent(slug: string, page: { title: string; type: string; tier: number; file_path: string }): string {
    const header = `【${page.title}】（${page.type}，层级${page.tier}）`;

    const filePath = join(this.pageMgr.vaultPath, page.file_path);
    if (!existsSync(filePath)) return header;

    const raw = readFileSync(filePath, "utf-8");
    const bodyStart = raw.indexOf("---", raw.indexOf("---") + 3);
    const body = bodyStart >= 0 ? raw.slice(bodyStart + 3).trim() : raw;

    if (!body) return header;
    return `${header}\n${body}`;
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
    return firstPhrase.trim().slice(0, TITLE_SAFETY_LIMIT) || "未命名洞察";
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
