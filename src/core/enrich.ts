import { CBrainDB } from "../storage/sqlite.js";
import type { LLMProvider } from "../llm/provider.js";
import type { PageManager } from "./page.js";
import { statSync } from "node:fs";
import { join } from "node:path";

const HOTNESS_WEIGHTS = {
  // Direct mentions show how often an entity appears in explicit wikilinks.
  mention: 0.25,
  // Links capture graph connectedness so well-related entities are not judged by mentions alone.
  link: 0.20,
  // Activity is weighted highest because recent reads/writes should surface living context quickly.
  activity: 0.30,
  // Tier keeps long-running core entities stable even when recent activity temporarily drops.
  tier: 0.15,
  // Body richness prevents empty stubs from competing equally with substantial pages.
  body: 0.10,
} as const;

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
  private vaultPath: string;
  private pages?: PageManager;

  constructor(db: CBrainDB, thresholds?: Partial<TierThresholds>, _llm?: LLMProvider, vaultPath?: string, pages?: PageManager) {
    this.db = db;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    this.vaultPath = vaultPath ?? "";
    this.pages = pages;
  }

  computeTier(mentionCount: number, activityWeight: number = 0): number {
    const combined = mentionCount * 0.4 + activityWeight * 0.6;
    if (combined >= this.thresholds.tier1 || mentionCount >= this.thresholds.tier1) return 1;
    if (combined >= this.thresholds.tier2 || mentionCount >= this.thresholds.tier2) return 2;
    return 3;
  }

  private normalize(value: number, max: number): number {
    if (max <= 0) return 0;
    return Math.min(value / max, 1.0);
  }

  computeHotness(slug: string, tier: number): number {
    const page = this.db.getPage(slug);
    const tierData = this.db.getPageTierAndMentions(slug);
    if (!page || !tierData) return 0;

    const stats = this.db.getHotnessStats();
    const linkCount = this.db.getLinkCountForSlug(slug);

    let bodyLength = 0;
    try {
      const absPath = page.file_path.startsWith("/") ? page.file_path : join(this.vaultPath, page.file_path);
      bodyLength = statSync(absPath).size;
    } catch {
      // file may not exist yet
    }
    const bodyRichness = Math.min(Math.max(bodyLength - 200, 0) / 1800, 1.0);

    const tierScore = tier === 1 ? 1.0 : tier === 2 ? 0.5 : 0.1;

    const hotness =
      this.normalize(tierData.mention_count, stats.mentionP95) * HOTNESS_WEIGHTS.mention +
      this.normalize(linkCount, stats.linkP95) * HOTNESS_WEIGHTS.link +
      this.normalize(tierData.activity_weight, stats.activityP95) * HOTNESS_WEIGHTS.activity +
      tierScore * HOTNESS_WEIGHTS.tier +
      bodyRichness * HOTNESS_WEIGHTS.body;

    return Math.round(hotness * 1000) / 1000;
  }

  enrichEntity(slug: string): EnrichResult {
    const page = this.db.getPageTierAndMentions(slug);

    if (!page) {
      return { slug, previousTier: 0, newTier: 0, upgraded: false };
    }

    const newTier = this.computeTier(page.mention_count, page.activity_weight);

    if (newTier < page.tier) {
      this.pages?.update(slug, { extra: { tier: newTier } });
      this.db.updatePageTier(slug, newTier);
    }

    const effectiveTier = newTier < page.tier ? newTier : page.tier;
    const hotness = this.computeHotness(slug, effectiveTier);
    this.db.updateHotnessScore(slug, hotness);

    return {
      slug,
      previousTier: page.tier,
      newTier: effectiveTier,
      upgraded: newTier < page.tier,
    };
  }

  enrichAll(): EnrichResult[] {
    const pages = this.db.getEntities();

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
    const page = this.db.getPage(slug);

    if (!page) return null;

    const backlinks = this.db.getIncomingLinks(slug).length;
    const outLinks = this.db.getOutgoingLinks(slug).length;
    const tags = this.db.getTags(slug);

    return {
      slug,
      title: page.title,
      tier: page.tier,
      mentionCount: page.mention_count,
      backlinkCount: backlinks,
      outLinkCount: outLinks,
      tags,
    };
  }
}
