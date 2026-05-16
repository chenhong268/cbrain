import { CBrainDB } from "../storage/sqlite.js";

const LAMBDA = 0.05; // time decay — half-life ~14 days
const QUERY_VALUES: Record<string, number> = {
  recall: 1.0,
  query: 1.0,
  expand: 1.5,
  graph: 0.5,
};
const POSITION_WEIGHTS = [1.0, 0.7, 0.5]; // rank 1, 2, 3; 4+ = 0.2

function positionWeight(rank: number): number {
  return rank < POSITION_WEIGHTS.length ? POSITION_WEIGHTS[rank] : 0.2;
}

function timeDecay(createdAt: string): number {
  const daysSince = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  return Math.exp(-LAMBDA * daysSince);
}

export class LearnManager {
  private db: CBrainDB;

  constructor(db: CBrainDB) {
    this.db = db;
  }

  recomputeAll(): { updated: number; topActive: string[] } {
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const stats = this.db.getQueryStatsSince(since);

    const feedbackMap = this.buildFeedbackMap(since);
    const weights = new Map<string, { weight: number; lastQueriedAt: string }>();

    for (const row of stats) {
      const queryValue = this.primaryToolValue(row.tools);
      const score = queryValue * positionWeight(Math.round(row.avg_position) - 1) * timeDecay(row.last_seen);
      const feedbackBonus = feedbackMap.get(row.slug) ?? 0;
      weights.set(row.slug, { weight: score + feedbackBonus, lastQueriedAt: row.last_seen });
    }

    const updated = this.db.batchUpdateActivityWeights(weights);

    // Co-occurrence: boost existing link weights
    this.updateCoOccurrences(since);

    // Clean old logs
    this.db.cleanOldQueryLogs(90);

    const topActive = this.db.getTopActivityEntities(5).map(e => `${e.title}(${e.activity_weight.toFixed(2)})`);
    return { updated, topActive };
  }

  bumpOnExpand(slug: string): void {
    try {
      this.db.insertFeedback(null, slug, "expanded");
      this.db.bumpActivityWeight(slug, 0.15);
    } catch { /* non-critical */ }
  }

  bumpOnWriteback(slug: string): void {
    try {
      this.db.insertFeedback(null, slug, "relevant");
      this.db.bumpActivityWeight(slug, 0.2);
    } catch { /* non-critical */ }
  }

  bumpOnQuery(slug: string, position: number, tool: string): void {
    const queryValue = QUERY_VALUES[tool] ?? 0.5;
    const delta = queryValue * positionWeight(position) * 0.1;
    if (delta > 0) this.db.bumpActivityWeight(slug, delta);
  }

  private updateCoOccurrences(since: string): void {
    const sessions = this.db.getDistinctSessionsSince(since);
    const pairCounts = new Map<string, number>();

    for (const sessionId of sessions) {
      const pairs = this.db.getSessionCoOccurrences(sessionId);
      for (const pair of pairs) {
        const key = `${pair.slug_a}|${pair.slug_b}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + pair.count);
      }
    }

    // Only boost existing links — never create new ones
    for (const [key, count] of pairCounts) {
      const [slugA, slugB] = key.split("|");
      const boost = 0.1 * count;
      try {
        this.db.boostLinkWeight(slugA, slugB, boost);
      } catch {
        // non-critical
      }
    }
  }

  private buildFeedbackMap(since: string): Map<string, number> {
    const rows = this.db.getFeedbackSince(since);
    const map = new Map<string, number>();
    for (const row of rows) {
      const bonus = row.signal === "relevant" ? 0.5 : row.signal === "irrelevant" ? -0.2 : row.signal === "expanded" ? 0.3 : 0;
      map.set(row.slug, (map.get(row.slug) ?? 0) + bonus * row.cnt);
    }
    return map;
  }

  private primaryToolValue(toolsStr: string): number {
    const tools = toolsStr.split(",");
    let best = 0.5;
    for (const t of tools) {
      const v = QUERY_VALUES[t.trim()] ?? 0.5;
      if (v > best) best = v;
    }
    return best;
  }
}
