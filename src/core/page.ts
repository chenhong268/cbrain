import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
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
import { generateSlug, slugToFilePath, canonicalSlug, isValidSlugName } from "../utils/slug.js";
import { hashContent, normalizePageType, canMerge, rewriteVaultLinks, normalizeAndHashBody } from "./shared.js";
import type { Logger } from "./logger.js";
import type { LanceDBManager } from "../storage/lancedb.js";
import {
  atomicSlugChange,
  atomicTypeChange,
  type MoveFsOps,
} from "./atomic-move.js";

export { RollbackIncompleteError, CleanupIncompleteError } from "./atomic-move.js";
export type { MoveFsOps } from "./atomic-move.js";

const defaultFsOps: MoveFsOps = {
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  mkdirSync,
};

export interface CreatePageInput {
  title: string;
  type: string;
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

/**
 * Strip auto-generated link sections from a page body.
 * Removes legacy <!-- cbrain-links --> blocks, ## Known Relations section,
 * and stray **关联** lines. Returns the cleaned body (trimmed right).
 */
function stripKnownRelations(body: string): string {
  let clean = body;
  // 1) Remove legacy <!-- cbrain-links --> ... <!-- /cbrain-links --> blocks
  const LEGACY_OPEN = "<!-- cbrain-links -->";
  const LEGACY_CLOSE = "<!-- /cbrain-links -->";
  let legacyOpenIdx = clean.indexOf(LEGACY_OPEN);
  while (legacyOpenIdx !== -1) {
    const legacyCloseIdx = clean.indexOf(LEGACY_CLOSE, legacyOpenIdx);
    if (legacyCloseIdx !== -1) {
      clean = clean.substring(0, legacyOpenIdx) + clean.substring(legacyCloseIdx + LEGACY_CLOSE.length);
    } else {
      break;
    }
    legacyOpenIdx = clean.indexOf(LEGACY_OPEN);
  }
  // 2) Remove ## Known Relations section (to end of body)
  const SECTION_HEADER = "## Known Relations";
  const sectionIdx = clean.indexOf(SECTION_HEADER);
  if (sectionIdx !== -1) {
    clean = clean.substring(0, sectionIdx);
  }
  // 3) Remove any stray "**关联**" line left from legacy
  clean = clean.replace(/\n\*\*关联\*\*\n/g, "\n");
  return clean.trimEnd();
}

export class PageManager {
  private db: CBrainDB;
  readonly vaultPath: string;
  private logger: Logger | null;
  private lance: LanceDBManager | null;
  private cache = new Map<string, { page: Page; expires: number }>();
  private static CACHE_MAX = 200;
  private static CACHE_TTL = 30_000;
  private _fs: MoveFsOps = defaultFsOps;

  constructor(db: CBrainDB, vaultPath: string, logger?: Logger, lance?: LanceDBManager) {
    this.db = db;
    this.vaultPath = vaultPath;
    this.logger = logger ?? null;
    this.lance = lance ?? null;
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

  /** @internal Test seam for filesystem fault injection. */
  _setFsOps(ops: Partial<MoveFsOps>): void {
    this._fs = { ...defaultFsOps, ...ops };
  }

  create(input: CreatePageInput): Page {
    const normalizedType = normalizePageType(input.type);
    let slug = input.slug || generateSlug(input.title, normalizedType);
    slug = canonicalSlug(slug, normalizedType);

    // Guard against invalid slug names (empty, only hyphens/special chars)
    const slugName = slug.split("/").pop()!;
    if (!isValidSlugName(slugName)) {
      throw new Error(`Invalid slug generated: "${slug}". Title: "${input.title}"`);
    }

    // Pre-check: refuse to overwrite an existing page
    const existing = this.db.getPage(slug);
    if (existing) {
      throw new Error(`Page already exists: ${slug}. Use update() instead.`);
    }

    // Also refuse if a vault file exists without a DB row (orphan)
    const fileName = slugToFilePath(slug);
    const filePath = join(this.vaultPath, fileName);
    if (existsSync(filePath)) {
      throw new Error(`Vault file already exists for slug "${slug}" without a DB row — possible orphan. Refusing to overwrite.`);
    }

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

    let dbInserted = false;
    try {
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
      dbInserted = true;

      if (input.tags && input.tags.length > 0) {
        this.db.addTags(slug, input.tags);
      }
    } catch (dbError) {
      // DB insert failed — only clean up the vault file WE just wrote
      // Do NOT deletePageCascaded: that would wipe pre-existing data for same slug
      try { unlinkSync(filePath); } catch { /* best effort */ }
      // If insertPage succeeded but addTags failed, clean up partial DB state
      if (dbInserted) {
        try { this.db.deletePageCascaded(slug); } catch { /* best effort */ }
      }
      throw dbError;
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

  /**
   * Force a fresh read from disk (invalidates cache first).
   * Returns null if the file or DB row is missing.
   */
  getBySlugFresh(slug: string): Page | null {
    this.cacheDelete(slug);
    return this.getBySlug(slug);
  }

  /**
   * Verify that the persisted body matches the expected body after relation sync.
   * Forces a cache-busted disk read, strips auto-generated Known Relations
   * from both sides, and compares exactly. Catches the case where a repeated
   * append is silently reverted to the old body (which would pass a naive
   * `includes()` check).
   *
   * @returns The verified final page, or null if verification failed.
   */
  verifyPersistedBody(slug: string, expectedBody: string): Page | null {
    const fresh = this.getBySlugFresh(slug);
    if (!fresh) return null;
    const persistedStripped = stripKnownRelations(fresh.body ?? "").trim();
    const expectedStripped = stripKnownRelations(expectedBody).trim();
    if (persistedStripped !== expectedStripped) return null;
    return fresh;
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

  /** Update a page's type. Moves file to correct directory if needed. */
  updateType(slug: string, newType: string): void {
    const normalizedType = normalizePageType(newType);
    const page = this.getBySlug(slug);
    if (!page) return;

    const newSlug = canonicalSlug(slug, normalizedType);

    if (newSlug !== slug) {
      const frontmatter: PageFrontmatter = {
        ...page.frontmatter,
        type: normalizedType,
        slug: newSlug,
        updated_at: new Date().toISOString(),
      };

      try {
        this.movePageAtomic(slug, newSlug, normalizedType, frontmatter, page.body);
      } catch (err) {
        this.logger?.error("page", "类型更新失败", { oldSlug: slug, newSlug, type: normalizedType, error: err });
        throw err;
      }
      this.logger?.info("page", "类型更新并移动文件", { oldSlug: slug, newSlug, type: normalizedType });
    } else {
      // Slug unchanged — update type in-place with file/DB atomicity
      this.updateTypeInPlace(slug, normalizedType, page);
    }
  }

  /**
   * Same-slug type change: delegates to shared atomicTypeChange.
   * If DB fails, temp is deleted and nothing changes.
   * If rename fails after DB success, DB is compensated back.
   */
  private updateTypeInPlace(slug: string, newType: string, page: Page): void {
    const oldFilePath = join(this.vaultPath, page.file_path);
    const frontmatter: PageFrontmatter = {
      ...page.frontmatter,
      type: newType,
      updated_at: new Date().toISOString(),
    };
    const content = stringifyFrontmatter(frontmatter, page.body);
    const contentHash = hashContent(content);

    try {
      // Get raw nullable hash from DB — Page interface converts NULL to ""
      const rawOldHash = this.db.getPage(slug)?.content_hash ?? null;

      atomicTypeChange(this._fs, this.db, {
        slug,
        oldType: page.type,
        oldHash: rawOldHash,
        newType,
        absPath: oldFilePath,
        stagedContent: content,
        newHash: contentHash,
      });
    } finally {
      this.cacheDelete(slug);
    }
  }

  /**
   * Atomically move a page's slug/type with filesystem coordination.
   * Delegates to shared atomicSlugChange for the stage→DB→publish→cleanup sequence.
   * Old-file deletion failure is a FAILED move — DB is compensated back.
   */
  movePageAtomic(
    oldSlug: string,
    newSlug: string,
    newType: string,
    frontmatter: PageFrontmatter,
    body: string,
  ): void {
    const page = this.getBySlug(oldSlug);
    if (!page) throw new Error(`movePageAtomic: page not found: ${oldSlug}`);

    const oldFilePath = join(this.vaultPath, page.file_path);
    const newFileName = slugToFilePath(newSlug);
    const newFilePath = join(this.vaultPath, newFileName);
    const content = stringifyFrontmatter(frontmatter, body);
    const contentHash = hashContent(content);

    if (this._fs.existsSync(newFilePath)) {
      throw new Error(`movePageAtomic: target file already exists: ${newFilePath}`);
    }

    const relativePath = relative(this.vaultPath, newFilePath);

    // Get raw nullable hash from DB — Page interface converts NULL to ""
    const rawOldHash = this.db.getPage(oldSlug)?.content_hash ?? null;

    try {
      atomicSlugChange(this._fs, this.db, {
        oldSlug,
        newSlug,
        newType,
        oldType: page.type,
        oldRelPath: page.file_path,
        oldHash: rawOldHash,
        newRelPath: relativePath,
        destAbsPath: newFilePath,
        oldAbsPath: oldFilePath,
        stagedContent: content,
        newHash: contentHash,
      });
    } finally {
      this.cacheDelete(oldSlug);
      this.cacheDelete(newSlug);
    }
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

    // Invalidate ingest dedup fingerprint only when body semantically changes
    // (CRLF/trim-equivalent bodies should not clear the hash)
    if (updates.body !== undefined && normalizeAndHashBody(updates.body) !== normalizeAndHashBody(page.body)) {
      this.db.clearIngestHash(slug);
    }

    if (updates.tags) {
      this.db.deleteTagsByPage(slug);
      this.db.addTags(slug, updates.tags);
    }

    this.logger?.info("page", "页面已更新", { slug });
    this.cacheDelete(slug);
    return this.getBySlug(slug);
  }

  /**
   * Patch an existing page: append body, merge tags, update specific frontmatter fields.
   * Preserves original body content (strips Known Relations before append — they'll be
   * rebuilt by syncLinksToMarkdown after the caller finishes post-processing).
   */
  patch(
    slug: string,
    updates: {
      body_append?: string;
      /** Separator between existing body and appended content. Defaults to "\n\n". */
      separator?: string;
      tags_merge?: string[];
      extra?: Record<string, unknown>;
    }
  ): Page | null {
    const page = this.getBySlug(slug);
    if (!page) { this.logger?.error("page", "patch 失败：页面不存在", { slug }); return null; }

    // Strip KR section before appending — syncLinksToMarkdown will rebuild it later
    const strippedBody = stripKnownRelations(page.body ?? "");
    const sep = updates.separator ?? "\n\n";
    const newBody = updates.body_append
      ? strippedBody + sep + updates.body_append
      : strippedBody;

    // Merge tags (union, dedup)
    const currentTags = (page.frontmatter.tags as string[]) ?? [];
    const mergedTags = updates.tags_merge
      ? [...new Set([...currentTags, ...updates.tags_merge])]
      : undefined;

    return this.update(slug, {
      body: newBody,
      ...(mergedTags ? { tags: mergedTags } : {}),
      extra: updates.extra,
    });
  }

  async delete(slug: string): Promise<boolean> {
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

    // SQLite-first: source of truth deleted before LanceDB best-effort cleanup
    this.db.deletePageCascaded(slug);
    this.cacheDelete(slug);
    if (this.lance) {
      try {
        await this.lance.deleteByPageSlug(slug);
      } catch (e) {
        this.logger?.warn("page", `LanceDB cleanup failed for ${slug}: ${(e as Error).message}`);
      }
    }

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

    // Strip auto-generated link sections
    const cleanBody = stripKnownRelations(body);
    const SECTION_HEADER = "## Known Relations";

    const newBody = linkLines.length > 0
      ? `${cleanBody}\n\n${SECTION_HEADER}\n\n${linkLines.join("\n")}\n`
      : cleanBody;

    const content = stringifyFrontmatter(updatedFm, newBody);
    writeFileSync(filePath, content, "utf-8");
    this.db.updatePageHash(slug, hashContent(content));
    this.cacheDelete(slug);
  }

  /** Sync Known Relations for multiple slugs, deduping and catching errors. */
  syncAffectedSlugs(slugs: Iterable<string>): Array<{ slug: string; error: string }> {
    const unique = [...new Set(slugs)];
    const warnings: Array<{ slug: string; error: string }> = [];
    for (const s of unique) {
      try {
        this.syncLinksToMarkdown(s);
      } catch (e) {
        warnings.push({ slug: s, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return warnings;
  }

  /**
   * Merge source page into target. All links, timeline entries, tags and raw data
   * are moved from source to target. Source body is appended to target body.
   * Source page is deleted after merge. Returns the merged page or null.
   */
  async merge(sourceSlug: string, targetSlug: string): Promise<Page | null> {
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
    const mergeNote = `\n\n> 合并自 ${source.title}（${sourceSlug}） — ${mergeDate}`;
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
    await this.delete(sourceSlug);

    this.logger?.info("page", "页面已合并", { source: sourceSlug, target: targetSlug });
    return this.getBySlug(targetSlug);
  }

  incrementMention(slug: string): void {
    this.db.incrementMentionCount(slug);
    this.cacheDelete(slug);
  }

}
