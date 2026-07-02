import { CBrainDB } from "../storage/sqlite.js";
import type { LLMProvider } from "../llm/provider.js";
import type { Logger } from "./logger.js";
import { getOntology } from "../ontology/loader.js";
import { normalizeForComparison } from "./ingestion/name-similarity.js";
import {
  detectSimilarEntities,
  type DetectorInput, type DetectorPage, type PageQuality, type SimilarEntityCandidate,
} from "./ingestion/similar-entity-detector.js";

export type DiscoveryType = "bridge" | "trend" | "gap" | "contradiction" | "similar_entity";

export interface DetectionResult {
  type: DiscoveryType;
  entities: string[];
  score: number;
  metadata: Record<string, unknown>;
  actionable: "high" | "medium" | "low";
  suggestion?: string;
  _dbId?: number;
}

export interface EnrichmentDiag {
  skipped: boolean;
  reason?: string;
  llmAvailable: boolean;
  attempted: number;
  saved: number;
  errors: number;
}

export interface DiscoveryReport {
  total: number;
  byType: Record<string, number>;
  byActionable: Record<string, number>;
  highActionable: DetectionResult[];
  enrichment: EnrichmentDiag;
}

const MAX_LLM_BUDGET = 50;
const TREND_WINDOW_DAYS = 7;
const TREND_MIN_CONSECUTIVE = 3;
const TREND_SPIKE_DELTA = 5;
const GAP_MIN_MENTIONS = 8;
const GAP_MIN_MENTIONS_CONCEPT = 30;
const GAP_MAX_LINKS_ENTITY = 1;
const GAP_MAX_LINKS_CONCEPT = 0;
const GAP_MIN_TITLE_LEN = 3;
const BRIDGE_MIN_DEGREE = 2;
const BRIDGE_MAX_PER_ENTITY = 3;
const ENRICH_PER_TYPE = 25;

const GAP_ENTITY_TYPES = new Set([
  "entity/person", "entity/company", "entity/organization",
  "entity/location", "entity/place", "entity/book", "entity/drug",
  "entity/product",
]);

function stripJsonFence(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

const TYPE_LABELS: Record<string, string> = {
  bridge: "桥接",
  community_crossing: "跨社区",
  structural_hole: "结构洞",
  trend: "趋势",
  gap: "缺口",
  contradiction: "矛盾",
};

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

    if (run("bridge")) { for (const r of this.detectBridges(graph)) results.push(r); }
    if (run("trend")) { for (const r of this.detectTrends()) results.push(r); }
    if (run("gap")) { for (const r of this.detectGaps(graph)) results.push(r); }
    if (run("contradiction")) results.push(...await this.detectContradictions());

    // Deduplicate by entity pair key within this run
    const seen = new Set<string>();
    const deduped = results.filter(r => {
      const key = [r.type, ...r.entities.sort()].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Persist via upsert — only truly new rows count toward totals
    const byType: Record<string, number> = {};
    const byActionable: Record<string, number> = { high: 0, medium: 0, low: 0 };
    const highActionable: DetectionResult[] = [];
    let newCount = 0;

    for (const r of deduped) {
      const { id, inserted } = this.db.upsertDiscovery(
        r.type, r.entities, r.score,
        undefined, undefined, r.actionable,
        false, r.metadata,
      );
      if (!inserted) continue;
      newCount++;
      byType[r.type] = (byType[r.type] ?? 0) + 1;
      byActionable[r.actionable]++;
      if (r.actionable === "high") {
        highActionable.push(r);
        r._dbId = id;
      }
    }

    // Only newly inserted high-actionable findings get LLM enrichment
    const enrichment = await this.enrichHighActionable(highActionable);

    this.logger?.info("discovery", `检测完成: ${newCount} 个新发现`);
    return { total: newCount, byType, byActionable, highActionable, enrichment };
  }

  /**
   * #246 — On-demand similar-entity detection lane. Structurally separate from
   * runDiscovery(): runDiscovery NEVER calls this. Builds DetectorInput in bulk,
   * runs the pure detector, and feeds results through the existing dedup →
   * upsertDiscovery loop. Persists candidates only; merges nothing.
   */
  async runSimilarEntityDetection(options: { dryRun?: boolean; scope?: "entity" | "concept" } = {}): Promise<DiscoveryReport & { candidates?: SimilarEntityCandidate[] }> {
    this.llmBudget = MAX_LLM_BUDGET;
    const byType: Record<string, number> = {};
    const byActionable: Record<string, number> = { high: 0, medium: 0, low: 0 };
    const highActionable: DetectionResult[] = [];
    const empty: DiscoveryReport = { total: 0, byType, byActionable, highActionable, enrichment: { skipped: true, reason: "no_candidates", llmAvailable: !!this.llm, attempted: 0, saved: 0, errors: 0 } };

    let entityPages = this.db.getEntityConceptPages();

    // HIGH 1: scope filters the page universe BEFORE any alias/quality/detector/upsert work
    if (options.scope === "entity") entityPages = entityPages.filter(p => p.type.startsWith("entity/"));
    else if (options.scope === "concept") entityPages = entityPages.filter(p => p.type.startsWith("concept/"));

    if (entityPages.length < 2) return empty;

    // HIGH 2: build own-title normalization map, then filter own-title aliases during bulk load
    const pageTitleNormBySlug = new Map<string, string>();
    for (const p of entityPages) pageTitleNormBySlug.set(p.slug, normalizeForComparison(p.title));

    const registeredAliasesBySlug = new Map<string, Set<string>>();
    for (const { page_slug, alias } of this.db.getAliasesBySlugBulk()) {
      const norm = normalizeForComparison(alias);
      if (!norm) continue;
      if (norm === pageTitleNormBySlug.get(page_slug)) continue; // own-title alias — skip (#246 HIGH 2)
      const set = registeredAliasesBySlug.get(page_slug);
      if (set) set.add(norm); else registeredAliasesBySlug.set(page_slug, new Set([norm]));
    }

    // qualityBySlug + linkDegree (build the degree map once, reuse for isStub + detector input).
    const qualityBySlug = new Map<string, PageQuality>();
    const linkDegreeMap = new Map<string, number>();
    const adj = this.buildAdjacency();
    for (const [slug, neighbors] of adj) linkDegreeMap.set(slug, neighbors.size);

    for (const row of this.db.getEntityConceptQuality()) {
      const linkDegree = linkDegreeMap.get(row.slug) ?? 0;
      qualityBySlug.set(row.slug, {
        isStub: row.mention_count === 0 && linkDegree === 0 && row.alias_count === 0 && row.tag_count === 0,
        bodyChars: row.body_chars,
        chunkCount: row.chunk_count,
        mentionCount: row.mention_count,
        aliasCount: row.alias_count,
        tagCount: row.tag_count,
      });
    }

    const detectorInput: DetectorInput = {
      pages: entityPages as DetectorPage[],
      registeredAliasesBySlug,
      linkDegree: linkDegreeMap,
      qualityBySlug,
      areTypesAffine: (a, b) => getOntology().areTypesAffine(a, b),
    };
    const report = detectSimilarEntities(detectorInput);

    if (options.dryRun) {
      const byActionableDry = { high: 0, medium: 0, low: 0 };
      for (const c of report.candidates) byActionableDry[c.actionable]++;
      return {
        total: report.candidates.length,
        byType: { similar_entity: report.candidates.length },
        byActionable: byActionableDry,
        highActionable: [],
        enrichment: { skipped: true, reason: "dry_run", llmAvailable: !!this.llm, attempted: 0, saved: 0, errors: 0 },
        candidates: report.candidates,
      };
    }

    const seen = new Set<string>();
    let newCount = 0;
    const insertedCandidates: SimilarEntityCandidate[] = [];
    for (const c of report.candidates) {
      const key = [c.slugA, c.slugB].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const metadata: Record<string, unknown> = {
        match_kind: c.matchKind,
        name_score: c.nameScore,
        type_gate: c.typeGate,
        reason_code: c.reasonCode,
      };
      if (c.editDistance !== undefined) metadata.edit_distance = c.editDistance;
      if (c.recommendedTarget) metadata.recommended_target = c.recommendedTarget;
      if (c.ambiguousTarget) metadata.ambiguous_target = true;
      if (c.sharedAlias) metadata.shared_alias = c.sharedAlias;

      const { id, inserted } = this.db.upsertDiscovery(
        "similar_entity", [c.slugA, c.slugB], c.nameScore,
        undefined, undefined, c.actionable, false, metadata,
      );
      if (!inserted) continue;
      newCount++;
      insertedCandidates.push(c);
      byType.similar_entity = (byType.similar_entity ?? 0) + 1;
      byActionable[c.actionable]++;
      if (c.actionable === "high") {
        const r: DetectionResult = {
          type: "similar_entity", entities: [c.slugA, c.slugB], score: c.nameScore,
          metadata, actionable: "high",
        };
        r._dbId = id;
        highActionable.push(r);
      }
    }

    this.logger?.info("discovery", `similar_entity: ${newCount} 个新候选 (truncated=${report.truncated})`);
    return {
      total: newCount, byType, byActionable, highActionable,
      enrichment: { skipped: true, reason: "no_enrichment", llmAvailable: !!this.llm, attempted: 0, saved: 0, errors: 0 },
      candidates: insertedCandidates,
    };
  }

  detectBridges(adj?: Map<string, Set<string>>): DetectionResult[] {
    const graph = adj ?? this.buildAdjacency();
    const results: DetectionResult[] = [];
    const entities = this.db.getEntityConceptPages().slice(0, 200);

    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const a = entities[i].slug, b = entities[j].slug;
        const neighborsA = graph.get(a) ?? new Set<string>();
        const neighborsB = graph.get(b) ?? new Set<string>();
        if (neighborsA.size < BRIDGE_MIN_DEGREE || neighborsB.size < BRIDGE_MIN_DEGREE) continue;

        const dist = this.bfsDistance(a, b, graph);
        if (dist < 4 || !Number.isFinite(dist)) continue;

        const shared = [...neighborsA].filter(n => neighborsB.has(n)).length;

        const score = Math.min(dist / 6, 1.0);

        results.push({
          type: "bridge",
          entities: [a, b],
          score,
          metadata: { distance: dist, shared_neighbors: shared },
          actionable: dist >= 8 ? "high" : "medium",
        });
      }
    }

    results.sort((a, b) => b.score - a.score);

    // Suppress super-nodes: limit each entity to at most BRIDGE_MAX_PER_ENTITY bridges
    const entityCount = new Map<string, number>();
    const filtered: DetectionResult[] = [];
    for (const r of results) {
      const [a, b] = r.entities;
      if ((entityCount.get(a) ?? 0) >= BRIDGE_MAX_PER_ENTITY) continue;
      if ((entityCount.get(b) ?? 0) >= BRIDGE_MAX_PER_ENTITY) continue;
      entityCount.set(a, (entityCount.get(a) ?? 0) + 1);
      entityCount.set(b, (entityCount.get(b) ?? 0) + 1);
      filtered.push(r);
      if (filtered.length >= 50) break;
    }
    return filtered;
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

    for (const { slug, type } of entities) {
      const page = this.db.getPage(slug);
      if (!page) continue;

      const isEntity = type.startsWith("entity/");
      const isConcept = type.startsWith("concept/");

      if (isEntity && !GAP_ENTITY_TYPES.has(type)) continue;
      if (!isEntity && !isConcept) continue;

      const minMentions = isConcept ? GAP_MIN_MENTIONS_CONCEPT : GAP_MIN_MENTIONS;
      if (page.mention_count < minMentions) continue;
      if (page.title.length < GAP_MIN_TITLE_LEN) continue;

      const neighbors = graph.get(slug);
      const linkCount = neighbors ? neighbors.size : 0;
      const maxLinks = isConcept ? GAP_MAX_LINKS_CONCEPT : GAP_MAX_LINKS_ENTITY;
      if (linkCount > maxLinks) continue;

      const mentionScore = Math.min(Math.log2(page.mention_count) / Math.log2(50), 1.0);
      const isolationScore = linkCount === 0 ? 1.0 : 1.0 / (1.0 + linkCount);
      const score = mentionScore * 0.6 + isolationScore * 0.4;

      results.push({
        type: "gap",
        entities: [slug],
        score: Math.min(score, 1.0),
        metadata: {
          mention_count: page.mention_count,
          link_count: linkCount,
          neighbor_slugs: neighbors ? [...neighbors] : [],
        },
        actionable: score >= 0.7 ? "high" : "medium",
      });
    }

    return results;
  }

  private async enrichHighActionable(items: DetectionResult[]): Promise<EnrichmentDiag> {
    if (!this.llm) {
      return { skipped: true, reason: "llm_not_available", llmAvailable: false, attempted: 0, saved: 0, errors: 0 };
    }
    if (items.length === 0) {
      return { skipped: true, reason: "no_high_actionable", llmAvailable: true, attempted: 0, saved: 0, errors: 0 };
    }

    const byType = new Map<string, DetectionResult[]>();
    for (const item of items) {
      const arr = byType.get(item.type) ?? [];
      arr.push(item);
      byType.set(item.type, arr);
    }
    const toEnrich: DetectionResult[] = [];
    for (const [, arr] of byType) {
      toEnrich.push(...arr.slice(0, ENRICH_PER_TYPE));
    }

    let saved = 0;
    let errors = 0;
    for (const item of toEnrich) {
      if (this.llmBudget <= 0) break;

      const titles = item.entities
        .map(s => this.db.getPage(s)?.title ?? s)
        .join("、");
      const typeLabel = TYPE_LABELS[item.type] ?? item.type;

      try {
        const raw = await this.llm.chat([
          { role: "system", content: "你是知识图谱分析专家。用中文回复，只返回 JSON，不要其他内容。" },
          { role: "user", content: `知识图谱发现了一个${typeLabel}：涉及 ${titles}（score: ${item.score.toFixed(2)}）。\n元数据：${JSON.stringify(item.metadata)}\n\n用一句话建议该如何处理这个发现。返回JSON：{"suggestion": "..."}` },
        ]);
        this.llmBudget--;
        const parsed = JSON.parse(stripJsonFence(raw));
        if (parsed.suggestion && item._dbId) {
          this.db.updateDiscoverySuggestion(item._dbId, parsed.suggestion);
          item.suggestion = parsed.suggestion;
          saved++;
        }
      } catch {
        this.llmBudget--;
        errors++;
      }
    }

    return { skipped: false, llmAvailable: true, attempted: toEnrich.length, saved, errors };
  }

  async detectContradictions(): Promise<DetectionResult[]> {
    if (!this.llm) return [];

    const results: DetectionResult[] = [];
    const entities = this.db.getEntityConceptPages();

    for (const { slug } of entities) {
      if (this.llmBudget <= 0) break;

      const incoming = this.db.getIncomingLinks(slug);
      const sources = incoming.filter(l => l.from_slug.startsWith("records/"));
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

        const parsed = JSON.parse(stripJsonFence(raw));
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
