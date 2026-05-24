import { CBrainDB } from "../storage/sqlite.js";
import type { LLMProvider } from "../llm/provider.js";
import type { Logger } from "./logger.js";

export type DiscoveryType = "bridge" | "trend" | "gap" | "contradiction";

export interface DetectionResult {
  type: DiscoveryType;
  entities: string[];
  score: number;
  metadata: Record<string, unknown>;
  actionable: "high" | "medium" | "low";
}

export interface DiscoveryReport {
  total: number;
  byType: Record<string, number>;
  byActionable: Record<string, number>;
  highActionable: DetectionResult[];
}

const MAX_LLM_BUDGET = 20;
const TREND_WINDOW_DAYS = 7;
const TREND_MIN_CONSECUTIVE = 3;
const TREND_SPIKE_DELTA = 5;
const GAP_MIN_MENTIONS = 5;
const GAP_MAX_LINKS = 2;

export class DiscoveryManager {
  private db: CBrainDB;
  private llm?: LLMProvider;
  private logger?: Logger;
  private llmBudget: number;

  constructor(db: CBrainDB, llm?: LLMProvider, logger?: Logger) {
    this.db = db;
    this.llm = llm;
    this.logger = logger;
    this.llmBudget = MAX_LLM_BUDGET;
  }

  async runDiscovery(types?: DiscoveryType[]): Promise<DiscoveryReport> {
    const run = (t: DiscoveryType) => !types || types.includes(t);
    this.llmBudget = MAX_LLM_BUDGET;

    const graph = this.buildAdjacency();
    const results: DetectionResult[] = [];

    if (run("bridge")) results.push(...this.detectBridges(graph));
    if (run("trend")) results.push(...this.detectTrends());
    if (run("gap")) results.push(...this.detectGaps(graph));
    if (run("contradiction")) results.push(...await this.detectContradictions());

    // Deduplicate by entity pair key
    const seen = new Set<string>();
    const deduped = results.filter(r => {
      const key = [r.type, ...r.entities.sort()].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Persist
    const byType: Record<string, number> = {};
    const byActionable: Record<string, number> = { high: 0, medium: 0, low: 0 };
    const highActionable: DetectionResult[] = [];

    for (const r of deduped) {
      this.db.addDiscovery(
        r.type, r.entities, r.score,
        undefined, undefined, r.actionable,
        false, r.metadata,
      );
      byType[r.type] = (byType[r.type] ?? 0) + 1;
      byActionable[r.actionable]++;
      if (r.actionable === "high") highActionable.push(r);
    }

    this.logger?.info("discovery", `检测完成: ${deduped.length} 个发现`);
    return { total: deduped.length, byType, byActionable, highActionable };
  }

  detectBridges(adj?: Map<string, Set<string>>): DetectionResult[] {
    const graph = adj ?? this.buildAdjacency();
    const results: DetectionResult[] = [];
    const entities = this.db.getEntityConceptPages();

    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const a = entities[i].slug, b = entities[j].slug;
        const dist = this.bfsDistance(a, b, graph);
        if (dist >= 4) {
          const neighborsA = graph.get(a) ?? new Set<string>();
          const neighborsB = graph.get(b) ?? new Set<string>();
          const shared = [...neighborsA].filter(n => neighborsB.has(n)).length;
          results.push({
            type: "bridge",
            entities: [a, b],
            score: Math.min(dist / 6, 1.0),
            metadata: { distance: dist, shared_neighbors: shared },
            actionable: "high",
          });
        }
      }
    }

    return results;
  }

  detectTrends(): DetectionResult[] {
    const results: DetectionResult[] = [];
    const entities = this.db.getEntityConceptPages();

    for (const { slug } of entities) {
      const snapshots = this.db.getMentionSnapshots(slug, TREND_WINDOW_DAYS);
      if (snapshots.length < 2) continue;

      const counts = snapshots.map(s => s.mention_count);

      // Track max consecutive up/down streaks
      let maxUp = 0, curUp = 0;
      let maxDown = 0, curDown = 0;
      for (let i = 1; i < counts.length; i++) {
        if (counts[i] > counts[i - 1]) { curUp++; curDown = 0; maxUp = Math.max(maxUp, curUp); }
        else if (counts[i] < counts[i - 1]) { curDown++; curUp = 0; maxDown = Math.max(maxDown, curDown); }
        else { curUp = 0; curDown = 0; }
      }

      const first = counts[0], last = counts[counts.length - 1];
      const delta = last - first;

      if (maxUp >= TREND_MIN_CONSECUTIVE) {
        results.push({
          type: "trend",
          entities: [slug],
          score: Math.min(maxUp / TREND_WINDOW_DAYS, 1.0),
          metadata: { direction: "trend_rising", delta, daily_counts: counts },
          actionable: delta >= 10 ? "high" : "medium",
        });
      } else if (maxDown >= TREND_MIN_CONSECUTIVE) {
        results.push({
          type: "trend",
          entities: [slug],
          score: Math.min(maxDown / TREND_WINDOW_DAYS, 1.0),
          metadata: { direction: "trend_declining", delta, daily_counts: counts },
          actionable: Math.abs(delta) >= 10 ? "high" : "medium",
        });
      } else if (Math.abs(delta) >= TREND_SPIKE_DELTA) {
        results.push({
          type: "trend",
          entities: [slug],
          score: Math.min(Math.abs(delta) / 20, 1.0),
          metadata: { direction: delta > 0 ? "trend_spike" : "trend_declining", delta, daily_counts: counts },
          actionable: Math.abs(delta) >= 10 ? "high" : "medium",
        });
      }
    }

    return results;
  }

  detectGaps(adj?: Map<string, Set<string>>): DetectionResult[] {
    const graph = adj ?? this.buildAdjacency();
    const results: DetectionResult[] = [];
    const entities = this.db.getEntityConceptPages();

    for (const { slug } of entities) {
      const page = this.db.getPage(slug);
      if (!page || page.mention_count < GAP_MIN_MENTIONS) continue;

      const neighbors = graph.get(slug);
      const linkCount = neighbors ? neighbors.size : 0;
      if (linkCount >= GAP_MAX_LINKS) continue;

      results.push({
        type: "gap",
        entities: [slug],
        score: Math.min(page.mention_count / 20, 1.0),
        metadata: {
          mention_count: page.mention_count,
          link_count: linkCount,
          neighbor_slugs: neighbors ? [...neighbors] : [],
        },
        actionable: page.mention_count >= 10 ? "high" : "medium",
      });
    }

    return results;
  }

  async detectContradictions(): Promise<DetectionResult[]> {
    if (!this.llm) return [];

    const results: DetectionResult[] = [];
    const entities = this.db.getEntityConceptPages();

    for (const { slug } of entities) {
      if (this.llmBudget <= 0) break;

      const incoming = this.db.getIncomingLinks(slug);
      const sources = incoming.filter(l => l.from_slug.startsWith("record/"));
      if (sources.length < 2) continue;

      const sourceInfos = sources.slice(0, 5).map(s => {
        const p = this.db.getPage(s.from_slug);
        return {
          slug: s.from_slug,
          title: p?.title ?? s.from_slug,
          context: s.context ?? "",
        };
      });

      if (this.llmBudget <= 0) break;
      this.llmBudget--;

      try {
        const prompt = `以下是关于"${this.db.getPage(slug)?.title ?? slug}"的多个来源信息：\n\n` +
          sourceInfos.map((s, i) => `来源${i + 1}（${s.title}）：${s.context || "（无上下文）"}`).join("\n\n") +
          `\n\n请判断这些来源之间是否存在信息矛盾。返回JSON：{"has_contradiction": boolean, "confidence": number, "explanation": string, "suggested_resolution": string}`;

        const raw = await this.llm.chat([
          { role: "system", content: "你是信息一致性分析专家。只返回JSON，不要其他内容。" },
          { role: "user", content: prompt },
        ]);

        const parsed = JSON.parse(raw);
        if (parsed.has_contradiction && parsed.confidence >= 0.7) {
          results.push({
            type: "contradiction",
            entities: [slug, ...sourceInfos.map(s => s.slug)],
            score: parsed.confidence,
            metadata: {
              explanation: parsed.explanation,
              suggested_resolution: parsed.suggested_resolution,
              source_count: sources.length,
            },
            actionable: "high",
          });
        }
      } catch {
        // Invalid JSON or LLM error — skip
      }
    }

    return results;
  }

  private buildAdjacency(): Map<string, Set<string>> {
    const adj = new Map<string, Set<string>>();
    const links = this.db.getAllLinks();
    for (const l of links) {
      if (!adj.has(l.from_slug)) adj.set(l.from_slug, new Set());
      if (!adj.has(l.to_slug)) adj.set(l.to_slug, new Set());
      adj.get(l.from_slug)!.add(l.to_slug);
      adj.get(l.to_slug)!.add(l.from_slug);
    }
    return adj;
  }

  private bfsDistance(a: string, b: string, adj: Map<string, Set<string>>): number {
    if (a === b) return 0;
    const visited = new Set<string>([a]);
    let frontier = new Set<string>([a]);
    let dist = 0;
    while (frontier.size > 0) {
      dist++;
      const next = new Set<string>();
      for (const node of frontier) {
        const neighbors = adj.get(node);
        if (!neighbors) continue;
        for (const n of neighbors) {
          if (n === b) return dist;
          if (!visited.has(n)) {
            visited.add(n);
            next.add(n);
          }
        }
      }
      frontier = next;
      if (dist > 10) break;
    }
    return Infinity;
  }
}
