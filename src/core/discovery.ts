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
          results.push({
            type: "bridge",
            entities: [a, b],
            score: Math.min(dist / 6, 1.0),
            metadata: { distance: dist },
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

      // Check consecutive increases
      let consecutiveUp = 0;
      for (let i = 1; i < counts.length; i++) {
        if (counts[i] > counts[i - 1]) consecutiveUp++;
        else consecutiveUp = 0;
      }

      // Check spike
      const first = counts[0], last = counts[counts.length - 1];
      const delta = last - first;

      if (consecutiveUp >= TREND_MIN_CONSECUTIVE) {
        results.push({
          type: "trend",
          entities: [slug],
          score: Math.min(consecutiveUp / TREND_WINDOW_DAYS, 1.0),
          metadata: { direction: "rising", delta, daily_counts: counts },
          actionable: delta >= 10 ? "high" : "medium",
        });
      } else if (Math.abs(delta) >= TREND_SPIKE_DELTA) {
        results.push({
          type: "trend",
          entities: [slug],
          score: Math.min(Math.abs(delta) / 20, 1.0),
          metadata: { direction: delta > 0 ? "spike" : "declining", delta, daily_counts: counts },
          actionable: Math.abs(delta) >= 10 ? "high" : "medium",
        });
      }
    }

    return results;
  }

  // Placeholder — implemented in Task 3
  detectGaps(_adj?: Map<string, Set<string>>): DetectionResult[] { return []; }

  // Placeholder — implemented in Task 4
  async detectContradictions(): Promise<DetectionResult[]> { return []; }

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
