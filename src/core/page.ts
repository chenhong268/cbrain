import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { CBrainDB } from "../storage/sqlite.js";
import {
  PageFrontmatter,
  parseFrontmatter,
  stringifyFrontmatter,
} from "../utils/frontmatter.js";
import { generateSlug, slugToFilePath, canonicalSlug } from "../utils/slug.js";
import { hashContent, normalizePageType } from "./shared.js";
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

  constructor(db: CBrainDB, vaultPath: string, logger?: Logger) {
    this.db = db;
    this.vaultPath = vaultPath;
    this.logger = logger ?? null;
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
    return this.getBySlug(slug)!;
  }

  getBySlug(slug: string): Page | null {
    const row = this.db.getPage(slug);

    if (!row) return null;

    const filePath = join(this.vaultPath, row.file_path);
    if (!existsSync(filePath)) return null;

    const { frontmatter, body } = parseFrontmatter(
      readFileSync(filePath, "utf-8")
    );

    return {
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
    if (slug.startsWith("raw/")) {
      this.logger?.warn("page", "拒绝写入 raw/ 目录", { slug });
      return null;
    }
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
    return this.getBySlug(slug);
  }

  delete(slug: string): boolean {
    const filePath = this.db.getPageFilePath(slug);
    if (filePath === null) return false;

    const absPath = join(this.vaultPath, filePath);
    if (existsSync(absPath)) {
      unlinkSync(absPath);
    }

    this.db.deletePageCascaded(slug);

    this.logger?.info("page", "页面已删除", { slug });
    return true;
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

    // Delete source page (file + index)
    this.delete(sourceSlug);

    this.logger?.info("page", "页面已合并", { source: sourceSlug, target: targetSlug });
    return this.getBySlug(targetSlug);
  }

  incrementMention(slug: string): void {
    this.db.incrementMentionCount(slug);
  }

}
