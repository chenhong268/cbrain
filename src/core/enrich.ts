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

export interface ContentEnrichResult {
  slug: string;
  enriched: boolean;
  summary?: string;
}

const ENRICH_PROMPT = `根据已知关联信息，用2-3句话简洁描述这个实体。只陈述可从关联推导的事实，不编造。
输出格式：纯文本，不要标题、不要列表、不要markdown。`;

export class EnrichManager {
  private db: CBrainDB;
  private thresholds: TierThresholds;
  private llm?: LLMProvider;
  private vaultPath?: string;

  constructor(db: CBrainDB, thresholds?: Partial<TierThresholds>, llm?: LLMProvider, vaultPath?: string) {
    this.db = db;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    this.llm = llm;
    this.vaultPath = vaultPath;
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

  async enrichWithContent(slug: string): Promise<ContentEnrichResult> {
    if (!this.llm) return { slug, enriched: false };

    const page = this.db
      .prepare("SELECT title, body, tier, type FROM pages WHERE slug = $slug")
      .get({ $slug: slug }) as { title: string; body: string; tier: number; type: string } | null;
    if (!page) return { slug, enriched: false };

    // Only enrich stubs (auto-extracted, short body)
    if (!page.body.includes("Auto-extracted")) return { slug, enriched: false };

    // Gather relations for context
    const outLinks = this.db.prepare(
      "SELECT to_slug, relation FROM links WHERE from_slug = $slug"
    ).all({ $slug: slug }) as Array<{ to_slug: string; relation: string }>;

    const inLinks = this.db.prepare(
      "SELECT from_slug, relation FROM links WHERE to_slug = $slug"
    ).all({ $slug: slug }) as Array<{ from_slug: string; relation: string }>;

    if (outLinks.length + inLinks.length === 0) return { slug, enriched: false };

    const relDescriptions: string[] = [];
    for (const link of outLinks) {
      const target = this.db.prepare("SELECT title FROM pages WHERE slug = $s").get({ $s: link.to_slug }) as { title: string } | null;
      relDescriptions.push(`${page.title} → ${target?.title ?? link.to_slug} (${link.relation})`);
    }
    for (const link of inLinks) {
      const source = this.db.prepare("SELECT title FROM pages WHERE slug = $s").get({ $s: link.from_slug }) as { title: string } | null;
      relDescriptions.push(`${source?.title ?? link.from_slug} → ${page.title} (${link.relation})`);
    }

    const userPrompt = `实体名：${page.title}\n已知关联：\n${relDescriptions.map(r => `- ${r}`).join("\n")}`;

    try {
      const summary = await this.llm.chat([
        { role: "system", content: ENRICH_PROMPT },
        { role: "user", content: userPrompt },
      ]);

      const cleanSummary = summary.trim().replace(/^["']|["']$/g, "");
      const sourceLine = page.body.split("\n").find(l => l.startsWith(">")) ?? "";
      const newBody = `${sourceLine}\n\n${cleanSummary}\n\n## Known Relations\n\n${relDescriptions.map(r => `- ${r}`).join("\n")}`;

      this.db.prepare(
        "UPDATE pages SET body = $body, updated_at = datetime('now') WHERE slug = $slug"
      ).run({ $body: newBody, $slug: slug });

      // Write to vault if path configured
      if (this.vaultPath) {
        const { writeFileSync, mkdirSync } = await import("node:fs");
        const { dirname, join } = await import("node:path");
        const vaultFile = join(this.vaultPath, `${slug}.md`);
        const frontmatter = [
          "---",
          `title: "${page.title}"`,
          `type: ${page.type}`,
          `slug: "${slug}"`,
          `tags: [auto-extracted]`,
          `tier: ${page.tier}`,
          "---",
        ].join("\n");
        mkdirSync(dirname(vaultFile), { recursive: true });
        writeFileSync(vaultFile, `${frontmatter}\n${newBody}\n`, "utf-8");
      }

      return { slug, enriched: true, summary: cleanSummary };
    } catch {
      return { slug, enriched: false };
    }
  }

  async enrichAllWithContent(): Promise<ContentEnrichResult[]> {
    const pages = this.db
      .prepare("SELECT slug FROM pages WHERE body LIKE '%Auto-extracted%'")
      .all() as Array<{ slug: string }>;

    const results: ContentEnrichResult[] = [];
    for (const page of pages) {
      results.push(await this.enrichWithContent(page.slug));
    }
    return results;
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
