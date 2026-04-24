import { CBrainDB } from "../storage/sqlite.js";

export interface TierThresholds {
  tier2: number; // mentions to reach tier 2
  tier1: number; // mentions to reach tier 1
}

const DEFAULT_THRESHOLDS: TierThresholds = {
  tier2: 3,
  tier1: 10,
};

export interface EnrichResult {
  slug: string;
  previousTier: number;
  newTier: number;
  upgraded: boolean;
}

export class EnrichManager {
  private db: CBrainDB;
  private thresholds: TierThresholds;

  constructor(db: CBrainDB, thresholds?: Partial<TierThresholds>) {
    this.db = db;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  computeTier(mentionCount: number): number {
    if (mentionCount >= this.thresholds.tier1) return 1;
    if (mentionCount >= this.thresholds.tier2) return 2;
    return 3;
  }

  enrichEntity(slug: string): EnrichResult {
    const page = this.db
      .prepare("SELECT tier, mention_count FROM pages WHERE slug = $slug")
      .get({ $slug: slug }) as { tier: number; mention_count: number } | null;

    if (!page) {
      return { slug, previousTier: 0, newTier: 0, upgraded: false };
    }

    const newTier = this.computeTier(page.mention_count);

    if (newTier < page.tier) {
      this.db.prepare(
        "UPDATE pages SET tier = $tier, updated_at = datetime('now') WHERE slug = $slug"
      ).run({ $tier: newTier, $slug: slug });

      return {
        slug,
        previousTier: page.tier,
        newTier,
        upgraded: true,
      };
    }

    return {
      slug,
      previousTier: page.tier,
      newTier: page.tier,
      upgraded: false,
    };
  }

  enrichAll(): EnrichResult[] {
    const pages = this.db
      .prepare("SELECT slug FROM pages WHERE type = 'entity'")
      .all() as Array<{ slug: string }>;

    const results: EnrichResult[] = [];
    for (const page of pages) {
      results.push(this.enrichEntity(page.slug));
    }
    return results;
  }

  getUpgraded(results: EnrichResult[]): EnrichResult[] {
    return results.filter((r) => r.upgraded);
  }

  getEntityProfile(slug: string): {
    slug: string;
    title: string;
    tier: number;
    mentionCount: number;
    backlinkCount: number;
    outLinkCount: number;
    tags: string[];
  } | null {
    const page = this.db
      .prepare("SELECT title, tier, mention_count FROM pages WHERE slug = $slug")
      .get({ $slug: slug }) as { title: string; tier: number; mention_count: number } | null;

    if (!page) return null;

    const backlinks = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM links WHERE to_slug = $slug"
    ).get({ $slug: slug }) as { cnt: number };

    const outLinks = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM links WHERE from_slug = $slug"
    ).get({ $slug: slug }) as { cnt: number };

    const tags = this.db.prepare(
      "SELECT tag FROM tags WHERE page_slug = $slug"
    ).all({ $slug: slug }) as Array<{ tag: string }>;

    return {
      slug,
      title: page.title,
      tier: page.tier,
      mentionCount: page.mention_count,
      backlinkCount: backlinks.cnt,
      outLinkCount: outLinks.cnt,
      tags: tags.map((t) => t.tag),
    };
  }
}
