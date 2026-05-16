import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { CBrainDB } from "../storage/sqlite.js";
import {
  PageFrontmatter,
  parseFrontmatter,
  stringifyFrontmatter,
} from "../utils/frontmatter.js";
import { generateSlug, slugToFilePath, canonicalSlug } from "../utils/slug.js";
import { hashContent, normalizePageType, canMerge, getLayer, rewriteVaultLinks } from "./shared.js";
import type { Logger } from "./logger.js";

export interface CreatePageInput {
  title: string;
  type: "entity" | "concept" | "record" | "insight";
  body: string;
  tags?: string[];
  slug?: string;
  expiresAt?: string | null;
  confidenceDecay?: number;
  extra?: Record<string, unknown>;
}

export interface Page {
  slug: string;
  type: string;
  title: string;
  file_path: string;
  content_hash: string;
  tier: number;
  mention_count: number;
  expires_at: string | null;
  confidence_decay: number;
  frontmatter: PageFrontmatter;
  body: string;
  created_at: string;
  updated_at: string;
}

export class PageManager {
  private db: CBrainDB;
  readonly vaultPath: string;
  private logger: Logger | null;
  private cache = new Map<string, { page: Page; expires: number }>();
  private static CACHE_MAX = 200;
  private static CACHE_TTL = 30_000;

  constructor(db: CBrainDB, vaultPath: string, logger?: Logger) {
    this.db = db;
    this.vaultPath = vaultPath;
    this.logger = logger ?? null;
  }

  private cacheGet(slug: string): Page | null {
    const entry = this.cache.get(slug);
    if (!entry) return null;
    if (Date.now() > entry.expires) { this.cache.delete(slug); return null; }
    return entry.page;
  }

  private cacheSet(slug: string, page: Page): void {
    if (this.cache.size >= PageManager.CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(slug, { page, expires: Date.now() + PageManager.CACHE_TTL });
  }

  private cacheDelete(slug: string): void {
    this.cache.delete(slug);
  }

  create(input: CreatePageInput): Page {
    const normalizedType = normalizePageType(input.type);
    let slug = input.slug || generateSlug(input.title, normalizedType);
    slug = canonicalSlug(slug, normalizedType);
    const fileName = slugToFilePath(slug);
    const filePath = join(this.vaultPath, fileName);

    const now = new Date().toISOString();
    const frontmatter: PageFrontmatter = {
      title: input.title,
      type: normalizedType,
      slug,
      tags: input.tags || [],
      tier: 3,
      created_at: now,
      updated_at: now,
      ...input.extra,
    };

    const content = stringifyFrontmatter(frontmatter, input.body);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf-8");

    const contentHash = hashContent(content);

    this.db.insertPage({
      slug,
      type: normalizedType,
      title: input.title,
      filePath: relative(this.vaultPath, filePath),
      contentHash,
      expiresAt: input.expiresAt ?? null,
      confidenceDecay: input.confidenceDecay ?? 1.0,
    });

    if (input.tags && input.tags.length > 0) {
      this.db.addTags(slug, input.tags);
    }

    this.logger?.info("page", "页面已创建", { slug, title: input.title, type: input.type });
    this.cacheDelete(slug);
    return this.getBySlug(slug)!;
  }

  getBySlug(slug: string): Page | null {
    const cached = this.cacheGet(slug);
    if (cached) return cached;

    const row = this.db.getPage(slug);

    if (!row) return null;

    const filePath = join(this.vaultPath, row.file_path);
    if (!existsSync(filePath)) return null;

    const { frontmatter, body } = parseFrontmatter(
      readFileSync(filePath, "utf-8")
    );

    const page: Page = {
      slug: row.slug,
      type: row.type,
      title: row.title,
      file_path: row.file_path,
      content_hash: row.content_hash ?? "",
      tier: row.tier,
      mention_count: row.mention_count,
      expires_at: row.expires_at ?? null,
      confidence_decay: row.confidence_decay ?? 1.0,
      frontmatter,
      body,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    this.cacheSet(slug, page);
    return page;
  }

  list(options?: {
    type?: string;
    limit?: number;
    offset?: number;
  }): Page[] {
    const slugs = this.db.listPageSlugs({
      type: options?.type,
      orderBy: "updated_at DESC",
      limit: options?.limit,
      offset: options?.offset,
    });
    return slugs.map((s) => this.getBySlug(s)).filter(Boolean) as Page[];
  }

  update(
    slug: string,
    updates: {
      body?: string;
      tags?: string[];
      extra?: Record<string, unknown>;
    }
  ): Page | null {
    const page = this.getBySlug(slug);
    if (!page) { this.logger?.error("page", "更新失败：页面不存在", { slug }); return null; }

    const now = new Date().toISOString();
    const body = updates.body ?? page.body;
    const frontmatter: PageFrontmatter = {
      ...page.frontmatter,
      updated_at: now,
      ...(updates.extra || {}),
    };

    if (updates.tags) {
      frontmatter.tags = updates.tags;
    }

    const filePath = join(this.vaultPath, page.file_path);
    const content = stringifyFrontmatter(frontmatter, body);
    writeFileSync(filePath, content, "utf-8");

    const contentHash = hashContent(content);
    this.db.updatePageHash(slug, contentHash);

    if (updates.tags) {
      this.db.deleteTagsByPage(slug);
      this.db.addTags(slug, updates.tags);
    }

    this.logger?.info("page", "页面已更新", { slug });
    this.cacheDelete(slug);
    return this.getBySlug(slug);
  }

  delete(slug: string): boolean {
    const filePath = this.db.getPageFilePath(slug);
    if (filePath === null) return false;

    // Strip [[slug]] dead links in other vault files before deleting
    const rewritten = rewriteVaultLinks(this.vaultPath, [{ oldSlug: slug }], this.db);
    if (rewritten > 0) {
      this.logger?.info("page", "死链已清理", { slug, files: rewritten });
    }

    const absPath = join(this.vaultPath, filePath);
    if (existsSync(absPath)) {
      unlinkSync(absPath);
    }

    this.db.deletePageCascaded(slug);
    this.cacheDelete(slug);

    this.logger?.info("page", "页面已删除", { slug });
    return true;
  }

  syncLinksToMarkdown(slug: string): void {
    const page = this.getBySlug(slug);
    if (!page) return;

    const outgoing = this.db.getOutgoingLinks(slug);
    const incoming = this.db.getIncomingLinks(slug);

    const linkLines: string[] = [];
    for (const l of outgoing) linkLines.push(`- ${l.relation} → [[${l.to_slug}]]`);
    for (const l of incoming) linkLines.push(`- ← ${l.relation} from [[${l.from_slug}]]`);

    const filePath = join(this.vaultPath, page.file_path);
    if (!existsSync(filePath)) return;

    const raw = readFileSync(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(raw);

    // Remove 'links' from frontmatter (legacy)
    const { links: _, ...cleanFm } = frontmatter;
    const updatedFm = { ...cleanFm, updated_at: new Date().toISOString() } as PageFrontmatter;

    // Remove any existing auto-generated link sections
    let cleanBody = body;
    // 1) Remove legacy <!-- cbrain-links --> ... <!-- /cbrain-links --> block
    const LEGACY_OPEN = "<!-- cbrain-links -->";
    const LEGACY_CLOSE = "<!-- /cbrain-links -->";
    let legacyOpenIdx = cleanBody.indexOf(LEGACY_OPEN);
    while (legacyOpenIdx !== -1) {
      const legacyCloseIdx = cleanBody.indexOf(LEGACY_CLOSE, legacyOpenIdx);
      if (legacyCloseIdx !== -1) {
        cleanBody = cleanBody.substring(0, legacyOpenIdx) + cleanBody.substring(legacyCloseIdx + LEGACY_CLOSE.length);
      } else {
        break;
      }
      legacyOpenIdx = cleanBody.indexOf(LEGACY_OPEN);
    }
    // 2) Remove ## Known Relations section (to end of body)
    const SECTION_HEADER = "## Known Relations";
    const sectionIdx = cleanBody.indexOf(SECTION_HEADER);
    if (sectionIdx !== -1) {
      cleanBody = cleanBody.substring(0, sectionIdx);
    }
    // 3) Remove any stray "**关联**" line left from legacy
    cleanBody = cleanBody.replace(/\n\*\*关联\*\*\n/g, "\n");
    cleanBody = cleanBody.trimEnd();

    const newBody = linkLines.length > 0
      ? `${cleanBody}\n\n${SECTION_HEADER}\n\n${linkLines.join("\n")}\n`
      : cleanBody;

    const content = stringifyFrontmatter(updatedFm, newBody);
    writeFileSync(filePath, content, "utf-8");
    this.db.updatePageHash(slug, hashContent(content));
    this.cacheDelete(slug);
  }

  /**
   * Merge source page into target. All links, timeline entries, tags and raw data
   * are moved from source to target. Source body is appended to target body.
   * Source page is deleted after merge. Returns the merged page or null.
   */
  merge(sourceSlug: string, targetSlug: string): Page | null {
    const source = this.getBySlug(sourceSlug);
    const target = this.getBySlug(targetSlug);
    if (!source || !target) { this.logger?.error("page", "合并失败：页面不存在", { source: sourceSlug, target: targetSlug }); return null; }
    if (sourceSlug === targetSlug) return null;
    if (!canMerge(source.type, target.type)) {
      this.logger?.error("page", "合并失败：跨层级不允许", { source: sourceSlug, sourceType: source.type, target: targetSlug, targetType: target.type });
      return null;
    }

    // Create version snapshot of target before merge
    try {
      const targetFilePath = join(this.vaultPath, target.file_path);
      if (existsSync(targetFilePath)) {
        const targetContent = readFileSync(targetFilePath, "utf-8");
        this.db.createVersion(targetSlug, targetContent);
      }
    } catch (e) {
      this.logger?.warn("page", "版本快照写入失败", { slug: targetSlug, error: String(e) });
    }

    // Collect everything BEFORE modifying DB
    const sourceBody = source.body || "";
    const targetBody = target.body || "";
    const sourceTags = this.db.getTags(sourceSlug);
    const targetTags = this.db.getTags(targetSlug);

    const mergeDate = new Date().toISOString().slice(0, 10);
    const mergeNote = `\n\n> 合并自 [[${sourceSlug}]] — ${mergeDate}`;
    const mergedBody = targetBody + mergeNote + "\n\n" + sourceBody;

    // Move links: update all references from source → target
    this.db.rewireLinks(sourceSlug, targetSlug);

    // Move timeline entries
    this.db.rewireTimeline(sourceSlug, targetSlug);

    // Merge tags (dedup)
    const allTags = [...new Set([...targetTags, ...sourceTags])];
    this.db.deleteTagsByPage(targetSlug);
    for (const tag of allTags) {
      this.db.addTag(targetSlug, tag);
    }

    // Write merged body directly (bypass update's re-read of file)
    const targetFilePath = join(this.vaultPath, target.file_path);
    const now = new Date().toISOString();
    const frontmatter = { ...target.frontmatter, updated_at: now, tags: allTags };
    const content = stringifyFrontmatter(frontmatter, mergedBody);
    writeFileSync(targetFilePath, content, "utf-8");

    const contentHash = hashContent(content);
    this.db.updatePageHash(targetSlug, contentHash);

    // Rewrite [[sourceSlug]] → [[targetSlug]] in all vault .md files
    const rewritten = rewriteVaultLinks(this.vaultPath, [{ oldSlug: sourceSlug, newSlug: targetSlug }], this.db);
    if (rewritten > 0) {
      this.logger?.info("page", "wiki-link 已重写", { oldSlug: sourceSlug, newSlug: targetSlug, files: rewritten });
    }

    // Store source title as alias so NER can still resolve it
    if (source.title !== target.title) {
      this.db.addAlias(targetSlug, source.title);
    }

    this.cacheDelete(targetSlug);

    // Delete source page (file + index)
    this.delete(sourceSlug);

    this.logger?.info("page", "页面已合并", { source: sourceSlug, target: targetSlug });
    return this.getBySlug(targetSlug);
  }

  incrementMention(slug: string): void {
    this.db.incrementMentionCount(slug);
    this.cacheDelete(slug);
  }

}
