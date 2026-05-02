import type { CBrainDB } from "../storage/sqlite.js";
import type { LLMProvider } from "../llm/provider.js";
import type { PageManager } from "./page.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readPageFile } from "../utils/frontmatter.js";
import { normalizeRelation } from "./shared.js";
import type { ContentPipeline } from "./pipeline.js";
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
const TITLE_SAFETY_LIMIT = 10;
const MAX_CONTEXT_CHARS = 12000;
const CONCURRENCY = 3;

// ─── Prompts ───────────────────────────────────────────────────

const SYNTHESIS_SYSTEM = `你是一个知识图谱分析师。根据给定信息，生成实体的综合描述。
只陈述可从信息推导的事实，不编造。不确定时confidence设低。
输出JSON：{"summary": "2-3句话的综合描述", "key_facts": ["事实1", "事实2"], "confidence": 0.0到1.0}`;

const RELATION_SYSTEM = `你是一个知识图谱分析师。根据已知关系，判断实体对之间是否存在未标注的直接关系。
只输出有把握的推理，confidence低于0.6的不输出。

关系类型（必须用以下之一）：
- 认识 / 提及 / 任职 / 创立 / 归属 / 合作 / 竞争 / 资本 / 制造 / 间接关联

输出JSON：{"inferred_relations": [{"from": "slug", "to": "slug", "relation": "关系", "reasoning": "依据", "confidence": 0.0到1.0}]}`;

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
  private pageMgr: PageManager;
  private pipeline: ContentPipeline | null;

  constructor(db: CBrainDB, pageMgr: PageManager, llm?: LLMProvider, pipeline?: ContentPipeline) {
    this.db = db;
    this.pageMgr = pageMgr;
    this.llm = llm ?? null;
    this.pipeline = pipeline ?? null;
  }

  async reflectAll(): Promise<ReflectReport> {
    if (!this.llm) return emptyReport();

    // All three phases are independent — run in parallel
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

          this.db.insertLink(r.from, r.to, normalizeRelation(r.relation), `[inferred] ${r.reasoning ?? ""}`);
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

    // Build dedup set from existing insights — same source entity combo won't re-fire
    const existingSigs = this.buildExistingInsightSigs();

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
          const confidence = ins.confidence ?? 0.5;

          // Confidence gate — below threshold, skip
          if (confidence < 0.8) continue;

          // Dedup — >50% source entity overlap with an existing insight
          if (resolvedEntities.length > 0) {
            if (this.hasOverlap(resolvedEntities, existingSigs)) continue;
            existingSigs.push(new Set(resolvedEntities));
          }

          const insight: GeneratedInsight = {
            content: ins.content,
            relatedEntities: resolvedEntities,
            type: ins.type ?? "pattern",
            confidence,
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

            // Index immediately — insight is searchable without waiting for sync
            if (this.pipeline) {
              try {
                const { chunks, embedResults } = await this.pipeline.embed(ins.content);
                this.pipeline.writeIndexes(insightSlug, chunks, embedResults);
              } catch {
                // Index failure is non-blocking
              }
            }

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

  // ─── Dedup ──────────────────────────────────────────────────

  private buildExistingInsightSigs(): Array<Set<string>> {
    const sigs: Array<Set<string>> = [];
    const insights = this.db.listPages({ type: "insight" });
    for (const page of insights) {
      try {
        const filePath = join(this.pageMgr.vaultPath, page.file_path);
        if (!existsSync(filePath)) continue;
        const { frontmatter } = readPageFile(filePath);
        const entities: string[] = (frontmatter.source_entities as string[]) ?? [];
        if (entities.length > 0) {
          sigs.push(new Set(entities));
        }
      } catch {
        // Corrupted file, skip
      }
    }
    return sigs;
  }

  private hasOverlap(entities: string[], existing: Array<Set<string>>): boolean {
    if (entities.length === 0) return false;
    const set = new Set(entities);
    for (const existingSet of existing) {
      let overlap = 0;
      for (const e of existingSet) {
        if (set.has(e)) overlap++;
      }
      const minSize = Math.min(set.size, existingSet.size);
      if (minSize > 0 && overlap / minSize > 0.5) return true;
    }
    return false;
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
