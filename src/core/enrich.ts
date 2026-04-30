import { CBrainDB } from "../storage/sqlite.js";
import type { LLMProvider } from "../llm/provider.js";

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

const ENRICH_PROMPT = `根据已知关联信息，用2-3句话简洁描述这个实体。只陈述可从关联推导的事实，不编造。
	输出格式：纯文本，不要标题、不要列表、不要markdown。`;

export class EnrichManager {
  private db: CBrainDB;
  private thresholds: TierThresholds;
  private llm?: LLMProvider;

  constructor(db: CBrainDB, thresholds?: Partial<TierThresholds>, llm?: LLMProvider) {
    this.db = db;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    this.llm = llm;
  }

  computeTier(mentionCount: number): number {
    if (mentionCount >= this.thresholds.tier1) return 1;
    if (mentionCount >= this.thresholds.tier2) return 2;
    return 3;
  }

  enrichEntity(slug: string): EnrichResult {
    const page = this.db.getPageTierAndMentions(slug);

    if (!page) {
      return { slug, previousTier: 0, newTier: 0, upgraded: false };
    }

    const newTier = this.computeTier(page.mention_count);

    if (newTier < page.tier) {
      this.db.updatePageTier(slug, newTier);

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
