import type { CBrainDB, InsightRow, CreateInsightInput } from "../storage/sqlite.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import type { LanceDBManager } from "../storage/lancedb.js";

export { type InsightRow, type CreateInsightInput } from "../storage/sqlite.js";

export interface InsightFilters {
  type?: "synthesis" | "pattern" | "anomaly" | "bridge";
  status?: "active" | "archived" | "dismissed";
  sourceType?: "reflect" | "discovery" | "manual";
  limit?: number;
  offset?: number;
}

const DEFAULT_TTL_DAYS = 90;

export class InsightManager {
  constructor(
    private db: CBrainDB,
    private embedding: EmbeddingProvider,
    private lance: LanceDBManager,
  ) {}

  async createInsight(data: CreateInsightInput): Promise<InsightRow> {
    const ttlDays = parseInt(this.db.getConfig("insight.ttl_days") ?? String(DEFAULT_TTL_DAYS), 10);
    const expiresAt = data.expiresAt !== undefined
      ? data.expiresAt
      : new Date(Date.now() + ttlDays * 86_400_000).toISOString();
    const id = this.db.createInsight({ ...data, expiresAt });
    const row = this.db.getInsight(id);

    // Embed and store in LanceDB for vector search
    if (row) {
      try {
        const { embedding } = await this.embedding.embed(data.content);
        await this.lance.addInsightVector({
          id,
          content: data.content,
          vector: new Float32Array(embedding),
        });
      } catch (e) {
        console.error(`[insight] embedding 失败 for insight #${id}:`, e);
      }
    }

    return row!;
  }

  listInsights(filters?: InsightFilters): InsightRow[] {
    return this.db.listInsights(filters);
  }

  getInsight(id: number): InsightRow | null {
    return this.db.getInsight(id);
  }

  async queryInsights(query: string, limit: number = 10): Promise<InsightRow[]> {
    try {
      const { embedding } = await this.embedding.embed(query);
      const vectorResults = await this.lance.searchInsights(embedding, limit * 2);

      if (vectorResults.length === 0) return [];

      // Fetch full rows and filter to active
      const ids = vectorResults.map(r => r.id);
      const rows: InsightRow[] = [];
      for (const id of ids) {
        const row = this.db.getInsight(id);
        if (row && row.status === "active") {
          rows.push(row);
        }
        if (rows.length >= limit) break;
      }
      return rows;
    } catch (e) {
      console.error("[insight] queryInsights 失败:", e);
      return [];
    }
  }

  archiveInsight(id: number): boolean {
    return this.db.updateInsightStatus(id, "archived");
  }

  dismissInsight(id: number): boolean {
    return this.db.updateInsightStatus(id, "dismissed");
  }

  getInsightsForEntities(slugs: string[], limit: number = 5): InsightRow[] {
    return this.db.getInsightsBySourceEntities(slugs, limit);
  }

  archiveExpired(): number {
    return this.db.archiveExpiredInsights();
  }

  countActive(): number {
    return this.db.countInsights("active");
  }
}
