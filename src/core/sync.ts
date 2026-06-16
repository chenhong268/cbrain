import { existsSync, readFileSync } from "node:fs";
import { readFile, access, rename, mkdir, unlink } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import { CBrainDB } from "../storage/sqlite.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import { LanceDBManager } from "../storage/lancedb.js";
import { NerEngine } from "./ner.js";
import { PageManager } from "./page.js";
import { canonicalSlug, slugToFilePath } from "../utils/slug.js";
import type { Logger } from "./logger.js";
import {
  chunkContent,
  hashContent,
  collectMarkdownFiles,
  DEFAULT_CHUNK_SIZE,
  normalizePageType,
  normalizeAndHashBody,
} from "./shared.js";
import { ContentPipeline } from "./pipeline.js";
import {
  snapshotIndexState,
  restoreIndexState,
  SyncRollbackError,
  SyncSnapshotError,
  sanitizeForLog,
  type IndexSnapshot,
} from "./sync-index-safety.js";

export class TitleCollisionError extends Error {
  constructor(
    public readonly details: {
      title: string;
      incoming: { slug: string; type: string; filePath: string };
      existing: { slug: string; type: string; filePath: string };
    },
  ) {
    super(
      `Title collision: "${details.title}" — incoming ${details.incoming.slug} vs existing ${details.existing.slug}`,
    );
    this.name = "TitleCollisionError";
  }
}

export { SyncRollbackError };

export interface SyncConfig {
  chunkSize?: number;
  outputsDir?: string;
}

export interface SyncDiagnostic {
  kind: "title_collision";
  title: string;
  incoming: { slug: string; type: string; filePath: string };
  existing: { slug: string; type: string; filePath: string };
  message: string;
  filePath: string;
}

export interface SyncReport {
  synced: number;
  skipped: number;
  errors: number;
  nerEntities?: number;
  nerRelations?: number;
  nerEvents?: number;
  nerLowRelevanceSkipped?: number;
  errorDetails?: string[];
  diagnostics?: SyncDiagnostic[];
}

export interface SyncPageResult {
  success: boolean;
  skipped?: boolean;
  error?: string;
  diagnostics?: SyncDiagnostic[];
}

export class SyncManager {
  private db: CBrainDB;
  private embedding: EmbeddingProvider;
  private lance: LanceDBManager;
  private pipeline: ContentPipeline;
  private chunkSize: number;
  private _unlink: typeof unlink = unlink;

  /** @internal Test seam for unlink fault injection. */
  _setUnlink(fn: typeof unlink): void {
    this._unlink = fn;
  }
  private nerEngine: NerEngine | null;
  private pages: PageManager | null;
  private logger: Logger | null;
  private chunkEmbedCache = new Map<string, { embedding: number[]; tokenCount: number }>();

  constructor(
    db: CBrainDB,
    embedding: EmbeddingProvider,
    lance: LanceDBManager,
    config?: SyncConfig & { nerEngine?: NerEngine; pages?: PageManager; logger?: Logger }
  ) {
    this.db = db;
    this.embedding = embedding;
    this.lance = lance;
    this.chunkSize = config?.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.nerEngine = config?.nerEngine ?? null;
    this.pages = config?.pages ?? null;
    this.logger = config?.logger ?? null;
    this.pipeline = new ContentPipeline(db, embedding, lance, {
      pages: this.pages ?? undefined,
      nerEngine: this.nerEngine ?? undefined,
      logger: this.logger ?? undefined,
      chunkSize: this.chunkSize,
    });
  }

  async syncAll(vaultPath: string): Promise<SyncReport> {
    const report: SyncReport = { synced: 0, skipped: 0, errors: 0, errorDetails: [], diagnostics: [] };
    try {
    const mdFiles = await collectMarkdownFiles(vaultPath, new Set(["outputs"]), this.logger ?? undefined);

    // Phase 1: detect changed files + batch embed all chunks
    const changed: Array<{ filePath: string; slug: string; title: string; type: string; relPath: string; body: string; contentHash: string; frontmatter: Record<string, unknown> }> = [];
    const allChunks: Array<{ slug: string; index: number; content: string }> = [];

    for (const filePath of mdFiles) {
      try {
        const content = await readFile(filePath, "utf-8");
        const parsed = parseFrontmatter(content);
        const relPath = relative(vaultPath, filePath);
        const slug = parsed.frontmatter.slug ?? relPath.replace(/\.md$/, "");
        const contentHash = hashContent(content);

        const existingPage = this.db.getPage(slug);
        const exists = !!existingPage;
        const existingHash = existingPage?.content_hash ?? null;

        // Normal content hash match — skip as before
        if (existingHash && existingHash === contentHash) {
          // Backfill tags + wikilinks even when content unchanged
          if (parsed.frontmatter?.tags && Array.isArray(parsed.frontmatter.tags)) {
            this.db.replaceTags(slug, parsed.frontmatter.tags as string[]);
          }
          if (this.pages && parsed.body.trim()) {
            try {
              this.pipeline.processWikilinks(slug, parsed.body);
            } catch { /* non-critical */ }
          }
          // Backfill reports_to even when content unchanged
          if (parsed.frontmatter?.reports_to) {
            try {
              this.pipeline.processReportsTo(slug, parsed.frontmatter);
            } catch { /* non-critical */ }
          }
          report.skipped++;
          continue;
        }

        const title = parsed.frontmatter.title ?? slug.split("/").pop() ?? slug;
        const type = normalizePageType(parsed.frontmatter.type ?? this.inferTypeFromPath(relPath));

        // Auto-promote records/X -> brain/entities/person/X when the vault already has
        // the more specific person page. Other title collisions remain diagnostics.
        await this.promoteRecordCollisionIfPerson(title, slug, type, relPath, vaultPath);

        // Skip hash match (title-collision files) — verify collision still exists
        const skipHash = !exists ? this.db.getConfig(`sync.skip.${slug}`) : null;
        if (skipHash === contentHash) {
          const pageTitle = parsed.frontmatter.title ?? slug.split("/").pop() ?? slug;
          const collision = this.db.getPageByTitleExcluding(pageTitle, slug);
          if (collision) {
            // Collision still present — keep skipping
            report.skipped++;
            continue;
          }
          // Collision resolved — clear skip hash and fall through to normal sync
          try { this.db.deleteConfig(`sync.skip.${slug}`); } catch { /* non-critical */ }
        }

        const chunks = chunkContent(parsed.body, this.chunkSize);
        for (const c of chunks) allChunks.push({ slug, index: c.index, content: c.content });
        changed.push({ filePath, slug, title, type, relPath, body: parsed.body, contentHash, frontmatter: parsed.frontmatter });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          report.skipped++;
          continue;
        }
        report.errors++;
        report.errorDetails?.push(`${filePath}: ${(e as Error).message}`);
        this.logger?.warn("sync", "文件解析失败", { file: filePath, error: String(e) });
      }
    }

    // Batch embed all chunks at once
    if (allChunks.length > 0 && this.embedding) {
      try {
        const texts = allChunks.map(c => c.content);
        const embedResults = await this.embedding.embedBatch(texts);
        for (let i = 0; i < allChunks.length; i++) {
          this.chunkEmbedCache.set(`${allChunks[i].slug}:${allChunks[i].index}`, embedResults[i]);
        }
      } catch (_e) {
        this.logger?.warn("sync", "批量 embedding 失败，回退到逐条处理");
      }
    }

    // Phase 2: write to DB + LanceDB + wikilinks (sequential), collect NER jobs
    const nerJobs: Array<{ slug: string; text: string; type: string; mentionedSlugs: Set<string> }> = [];

    for (const file of changed) {
      try {
        const existingPage = this.db.getPage(file.slug);
        const exists = !!existingPage;

        if (await this.discardRecordCollisionIfPerson(file.title, file.slug, file.type, file.relPath, vaultPath)) {
          report.skipped++;
          continue;
        }
        this.checkTitleCollision(file.title, file.slug, file.type, file.relPath);

        // Build chunks + embedResults. Fresh embed happens BEFORE any durable
        // mutation so an embedding failure touches nothing (version + ingest-hash
        // writes are deferred to post-success below).
        const chunks = chunkContent(file.body, this.chunkSize);
        let embedResults = chunks.map(c => this.chunkEmbedCache.get(`${file.slug}:${c.index}`));
        if (!embedResults.every(r => r)) {
          const fresh = await this.pipeline.embed(file.body);
          embedResults = fresh.embedResults;
        }

        const isNewAll = !exists;
        // metaSnap captures only the fields upsertPage/replaceTags can mutate
        // (title, tags). type/filePath are excluded — upsertPage's ON CONFLICT
        // clause leaves them untouched, so they need no rollback snapshot.
        const metaSnap = exists
          ? { title: existingPage?.title ?? file.title, tags: this.db.getTags(file.slug) }
          : null;
        const indexSnap = await this.snapshotOrFail(file.slug, exists);

        try {
          this.db.upsertPage({
            slug: file.slug,
            type: file.type,
            title: file.title,
            filePath: file.relPath,
          });

          if (file.frontmatter?.tags && Array.isArray(file.frontmatter.tags)) {
            this.db.replaceTags(file.slug, file.frontmatter.tags as string[]);
          }

          await this.pipeline.writeIndexes(file.slug, chunks, embedResults as Array<{ embedding: number[]; tokenCount: number }>);

          // Persist content hash only after indexes are written — ensures next sync retries on failure
          this.db.updatePageHash(file.slug, file.contentHash);
          this.pipeline.writeIngestLog(file.slug, "vault", { hash: file.contentHash });

          // Post-success metadata writes (#185 P1#3): version snapshot + ingest-hash
          // invalidation run ONLY after the failure-prone embedding+index boundary,
          // so an embedding/index failure leaves version count and ingest hash unchanged.
          if (exists) {
            try {
              this.db.createVersion(file.slug, file.body,
                file.frontmatter ? JSON.stringify(file.frontmatter) : undefined);
            } catch (e) {
              this.logger?.warn("sync", "版本快照写入失败", { slug: file.slug, error: String(e) });
            }
            try {
              const oldIngestHash = this.db.getPageIngestHash(file.slug);
              if (oldIngestHash !== null && normalizeAndHashBody(file.body) !== oldIngestHash) {
                this.db.clearIngestHash(file.slug);
              }
            } catch (e) {
              this.logger?.warn("sync", "ingest hash 失效失败", { slug: file.slug, error: String(e) });
            }
          }
        } catch (indexError) {
          const original = indexError instanceof Error ? indexError : new Error(String(indexError));
          if (isNewAll) {
            await this.cleanupNewPage(file.slug, original);
          } else {
            await this.compensateSyncFailure(file.slug, metaSnap, indexSnap, original);
          }
          // Compensation succeeded (full rollback to pre-sync state): rethrow the
          // original error so the watcher retries. If compensation itself failed,
          // the helper already threw SyncRollbackError — this line is unreachable
          // in that case, and SyncRollbackError propagates instead.
          throw original;
        }
        report.synced++;

        if (this.nerEngine && file.body.trim() && !file.type.startsWith("entity/") && !file.type.startsWith("concept/") && !file.type.startsWith("insight/")) {
          nerJobs.push({ slug: file.slug, text: file.body, type: file.type, mentionedSlugs: new Set() });
        }

        if (this.pages && file.body.trim()) {
          try {
            const wlResult = this.pipeline.processWikilinks(file.slug, file.body);
            const lastJob = nerJobs[nerJobs.length - 1];
            if (lastJob && lastJob.slug === file.slug) {
              lastJob.mentionedSlugs = wlResult.mentionedSlugs;
            }
          } catch (e) {
            this.logger?.warn("sync", "Wikilink 提取失败", { slug: file.slug, error: String(e) });
          }
        }

        // Sync reports_to frontmatter → graph link
        if (file.frontmatter?.reports_to) {
          try {
            this.pipeline.processReportsTo(file.slug, file.frontmatter);
          } catch (e) {
            this.logger?.warn("sync", "reports_to sync failed", { slug: file.slug, error: String(e) });
          }
        }
      } catch (err) {
        report.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        report.errorDetails!.push(`${file.relPath}: ${msg}`);
        if (err instanceof TitleCollisionError) {
          // Store content hash in config table so next sync skips this file
          // instead of replaying the collision error. Can't write to pages table
          // because the title unique constraint would block the insert.
          try { this.db.setConfig(`sync.skip.${file.slug}`, file.contentHash); } catch { /* non-critical */ }
          report.diagnostics ??= [];
          report.diagnostics.push({
            kind: "title_collision",
            title: err.details.title,
            incoming: err.details.incoming,
            existing: err.details.existing,
            message: msg,
            filePath: file.relPath,
          });
        }
        this.logger?.error("sync", `同步失败: ${file.slug}`, { error: msg });
      }
    }

    // Phase 3: parallel NER batch
    if (nerJobs.length > 0 && this.nerEngine) {
      const CONCURRENCY = 5;
      for (let i = 0; i < nerJobs.length; i += CONCURRENCY) {
        const batch = nerJobs.slice(i, i + CONCURRENCY);
        const extractions = await Promise.all(
          batch.map(job => this.nerEngine!.extract(job.text).catch((e) => {
              this.logger?.warn("sync", "NER extract 失败", { slug: job.slug, error: String(e) });
              return null;
            }))
        );
        for (let j = 0; j < batch.length; j++) {
          const extraction = extractions[j];
          if (!extraction) continue;
          try {
            const nerResult = await this.pipeline.processNer(batch[j].slug, batch[j].text, batch[j].type, false, extraction, batch[j].mentionedSlugs);
            if (nerResult) {
              report.nerEntities = (report.nerEntities ?? 0) + nerResult.entities;
              report.nerRelations = (report.nerRelations ?? 0) + nerResult.relations;
              report.nerEvents = (report.nerEvents ?? 0) + nerResult.events;
              report.nerLowRelevanceSkipped = (report.nerLowRelevanceSkipped ?? 0) + nerResult.lowRelevanceSkipped;
            }
          } catch (e) {
            this.logger?.warn("sync", "NER 处理失败", { slug: batch[j].slug, error: String(e) });
          }
        }
      }
    }

    this.chunkEmbedCache.clear();
    return report;
    } finally { this.chunkEmbedCache.clear(); }
  }

  async cleanStaleStubs(_vaultPath: string): Promise<string[]> {
    const removed: string[] = [];
    const stubs = this.db.getAutoExtractedPages();

    for (const stub of stubs) {
      const page = this.pages?.getBySlug(stub.slug);
      if (!page || !page.body) continue;

      const srcMatch = page.body.match(/Auto-extracted from \[\[([^\]]+)\]\]/);
      if (!srcMatch) continue;

      const sourceSlug = srcMatch[1];
      const sourcePage = this.pages?.getBySlug(sourceSlug);
      if (!sourcePage) continue;

      if (!sourcePage.body.includes(stub.title)) {
        this.pages?.delete(stub.slug);
        removed.push(stub.slug);
      }
    }
    return removed;
  }

  async syncPage(slug: string, vaultPath: string): Promise<SyncPageResult> {
    if (slug.includes("..") || slug.startsWith("/")) {
      return { success: false, error: "Invalid slug" };
    }
    const filePath = this.db.getPageFilePath(slug);
    const fullPath = filePath
      ? join(vaultPath, filePath)
      : join(vaultPath, `${slug}.md`);

    let content: string;
    try {
      content = await readFile(fullPath, "utf-8");
    } catch (e) {
      this.logger?.warn("sync", "文件读取失败", { path: fullPath, error: String(e) });
      return { success: false, error: `File not found: ${slug}` };
    }
    const parsed = parseFrontmatter(content);

    let effectiveSlug = parsed.frontmatter.slug ?? slug;

    if (!effectiveSlug && !filePath) {
      return { success: false, error: `No slug found and page not indexed: ${slug}` };
    }
    if (effectiveSlug.includes("..") || effectiveSlug.startsWith("/")) {
      return { success: false, error: "Invalid slug" };
    }
    const contentHash = hashContent(content);

    const existingPage = this.db.getPage(effectiveSlug);
    const exists = !!existingPage;
    const existingHash = existingPage?.content_hash ?? null;

    if (existingHash && existingHash === contentHash) {
      // Backfill tags + wikilinks even when content unchanged
      if (parsed.frontmatter?.tags && Array.isArray(parsed.frontmatter.tags)) {
        this.db.replaceTags(effectiveSlug, parsed.frontmatter.tags as string[]);
      }
      if (this.pages && parsed.body.trim()) {
        try {
          this.pipeline.processWikilinks(effectiveSlug, parsed.body);
        } catch { /* non-critical */ }
      }
      // Backfill reports_to even when content unchanged
      if (parsed.frontmatter?.reports_to) {
        try {
          this.pipeline.processReportsTo(effectiveSlug, parsed.frontmatter as Record<string, unknown>);
        } catch { /* non-critical */ }
      }
      // Write mention snapshot for trend detection
      try {
        const mc = this.db.getPage(effectiveSlug)?.mention_count ?? 0;
        this.db.upsertMentionSnapshot(effectiveSlug, new Date().toISOString().slice(0, 10), mc);
      } catch { /* non-critical */ }

      return { success: true, skipped: true };
    }

    const title = parsed.frontmatter.title ?? effectiveSlug;
    const type = normalizePageType(parsed.frontmatter.type ?? "record");

    // Canonicalize slug + migrate mislaid files
    const canonical = canonicalSlug(effectiveSlug, type);
    if (canonical !== effectiveSlug) {
      const newRelPath = slugToFilePath(canonical);
      const newFullPath = join(vaultPath, newRelPath);
      if (!existsSync(newFullPath)) {
        try {
          await mkdir(dirname(newFullPath), { recursive: true });
          await rename(fullPath, newFullPath);
          this.logger?.info("sync", `文件已迁移: ${relative(vaultPath, fullPath)} → ${newRelPath}`);
        } catch (e) {
          this.logger?.warn("sync", `文件迁移失败: ${(e as Error).message}`);
        }
      }
      effectiveSlug = canonical;
    }

    const relPath = slugToFilePath(effectiveSlug);

    // Check skip hash for title-collision files (must be AFTER canonicalization
    // so the key matches what was stored in the TitleCollisionError handler)
    const skipHash = !exists ? this.db.getConfig(`sync.skip.${effectiveSlug}`) : null;
    if (skipHash && skipHash === contentHash) {
      const collision = this.db.getPageByTitleExcluding(title, effectiveSlug);
      if (collision) {
        return {
          success: false,
          skipped: true,
          error: `Title collision: "${title}"`,
          diagnostics: [{
            kind: "title_collision",
            title,
            incoming: { slug: effectiveSlug, type, filePath: relPath },
            existing: { slug: collision.slug, type: collision.type, filePath: this.db.getPageFilePath(collision.slug) ?? "" },
            message: `Title collision: "${title}"`,
            filePath: relPath,
          }],
        };
      }
      // Collision resolved — clear skip hash and proceed with sync
      try { this.db.deleteConfig(`sync.skip.${effectiveSlug}`); } catch { /* non-critical */ }
    }

    // Preflight: title collision check
    try {
      await this.promoteRecordCollisionIfPerson(title, effectiveSlug, type, relPath, vaultPath);
      if (await this.discardRecordCollisionIfPerson(title, effectiveSlug, type, relPath, vaultPath)) {
        return { success: true, skipped: true };
      }
      this.checkTitleCollision(title, effectiveSlug, type, relPath);
    } catch (err) {
      if (err instanceof TitleCollisionError) {
        try { this.db.setConfig(`sync.skip.${effectiveSlug}`, contentHash); } catch { /* non-critical */ }
        return {
          success: false,
          error: err.message,
          diagnostics: [{
            kind: "title_collision",
            title: err.details.title,
            incoming: err.details.incoming,
            existing: err.details.existing,
            message: err.message,
            filePath: err.details.incoming.filePath,
          }],
        };
      }
      throw err;
    }

    // --- Embed FIRST: an embedding failure must touch nothing durable-retrievable.
    // createVersion + ingest-hash invalidation are deferred to the post-success
    // block below so they leave zero trace on embedding/index failure (#185 #1). ---
    const { chunks, embedResults } = await this.pipeline.embed(parsed.body);

    const isNew = !exists;
    // Snapshot retrievable metadata + full index state before any durable mutation.
    // (ingestHash intentionally excluded — its invalidation is logical, not rollbackable.)
    const metaSnap = exists
      ? {
          title: existingPage?.title ?? title,
          tags: this.db.getTags(effectiveSlug),
        }
      : null;
    const indexSnap: IndexSnapshot = await this.snapshotOrFail(effectiveSlug, exists);

    try {
      this.db.upsertPage({ slug: effectiveSlug, type, title, filePath: relPath });

      if (parsed.frontmatter?.tags && Array.isArray(parsed.frontmatter.tags)) {
        this.db.replaceTags(effectiveSlug, parsed.frontmatter.tags as string[]);
      }

      await this.pipeline.writeIndexes(effectiveSlug, chunks, embedResults);

      // Persist content hash only after indexes are written
      this.db.updatePageHash(effectiveSlug, contentHash);
      this.pipeline.writeIngestLog(effectiveSlug, "vault", { hash: contentHash });

      // Post-success metadata writes (#185 P1#3): version snapshot + ingest-hash
      // invalidation run ONLY after the failure-prone embedding+index boundary,
      // so an embedding/index failure leaves version count and ingest hash unchanged.
      if (exists) {
        try {
          this.db.createVersion(effectiveSlug, parsed.body,
            parsed.frontmatter ? JSON.stringify(parsed.frontmatter) : undefined);
        } catch (e) {
          this.logger?.warn("sync", "版本快照写入失败", { slug: effectiveSlug, error: String(e) });
        }
        try {
          const oldIngestHash = this.db.getPageIngestHash(effectiveSlug);
          if (oldIngestHash !== null && normalizeAndHashBody(parsed.body) !== oldIngestHash) {
            this.db.clearIngestHash(effectiveSlug);
          }
        } catch (e) {
          this.logger?.warn("sync", "ingest hash 失效失败", { slug: effectiveSlug, error: String(e) });
        }
      }
    } catch (indexError) {
      const original = indexError instanceof Error ? indexError : new Error(String(indexError));
      if (isNew) {
        await this.cleanupNewPage(effectiveSlug, original);
      } else {
        await this.compensateSyncFailure(effectiveSlug, metaSnap, indexSnap, original);
      }
      // Compensation succeeded (full rollback to pre-sync state): rethrow the
      // original error so the watcher retries. If compensation itself failed,
      // the helper already threw SyncRollbackError — this line is unreachable
      // in that case, and SyncRollbackError propagates instead.
      throw original;
    }

    // Wikilink extraction first — produces mentionedSlugs for NER dedup
    let mentionedSlugs = new Set<string>();
    if (this.pages && parsed.body.trim()) {
      try {
        const wlResult = this.pipeline.processWikilinks(effectiveSlug, parsed.body);
        mentionedSlugs = wlResult.mentionedSlugs;
      } catch (e) {
        this.logger?.warn("sync", "Wikilink 提取失败", { slug: effectiveSlug, error: String(e) });
      }
    }

    // Sync reports_to frontmatter → graph link
    if (parsed.frontmatter?.reports_to) {
      try {
        this.pipeline.processReportsTo(effectiveSlug, parsed.frontmatter as Record<string, unknown>);
      } catch (e) {
        this.logger?.warn("sync", "reports_to sync failed", { slug: effectiveSlug, error: String(e) });
      }
    }

    // NER — skip entity/concept pages
    if (this.nerEngine && parsed.body.trim() && !type.startsWith("entity/") && !type.startsWith("concept/") && !type.startsWith("insight/")) {
      try {
        const nerResult = await this.pipeline.processNer(effectiveSlug, parsed.body, type, false, undefined, mentionedSlugs);
        if (nerResult && nerResult.entities > 0) {
          this.logger?.info("sync", `NER: ${nerResult.entities} entities from ${effectiveSlug}`);
        }
      } catch (e) {
        this.logger?.warn("sync", `NER failed for ${effectiveSlug}: ${(e as Error).message}`);
      }
    }

    // Write mention snapshot for trend detection
    try {
      const mc = this.db.getPage(effectiveSlug)?.mention_count ?? 0;
      this.db.upsertMentionSnapshot(effectiveSlug, new Date().toISOString().slice(0, 10), mc);
    } catch { /* non-critical */ }

    return { success: true };
  }

  async removePage(slug: string): Promise<void> {
    this.db.deletePageCascaded(slug);
    try { this.db.deleteConfig(`sync.skip.${slug}`); } catch { /* non-critical */ }
    try {
      await this.lance.deleteByPageSlug(slug);
    } catch (e) {
      this.logger?.warn("sync", `LanceDB cleanup failed for ${slug}: ${(e as Error).message}`);
    }
  }

  async removeOrphans(vaultPath: string): Promise<string[]> {
    const cleaned = this.db.cleanDanglingLinks();
    if (cleaned > 0 && this.logger) this.logger.info("sync", `清理 ${cleaned} 条悬空链接`);

    const pages = this.db.getAllPageSlugsWithPaths();

    const orphans: string[] = [];

    for (const page of pages) {
      const fullPath = join(vaultPath, page.file_path);
      try {
        await access(fullPath);
      } catch {
        orphans.push(page.slug);
        // Clean up any title-collision skip hashes
        try { this.db.deleteConfig(`sync.skip.${page.slug}`); } catch { /* non-critical */ }
        if (this.pages) {
          // PageManager.delete() handles both SQLite + LanceDB internally
          await this.pages.delete(page.slug);
        } else {
          // SyncManager-only path: SQLite-first, LanceDB best-effort
          this.db.deletePageCascaded(page.slug);
          try {
            await this.lance.deleteByPageSlug(page.slug);
          } catch (e) {
            this.logger?.warn("sync", `LanceDB orphan cleanup failed for ${page.slug}: ${(e as Error).message}`);
          }
        }
      }
    }

    return orphans;
  }

  /**
   * Clean orphan vectors in LanceDB: vectors whose pageSlug no longer exists in SQLite.
   * Returns the list of cleaned slugs.
   */
  async cleanLanceOrphans(): Promise<string[]> {
    const lanceSlugs = await this.lance.getIndexedPageSlugs();
    if (lanceSlugs.length === 0) return [];

    const sqliteSlugs = new Set(this.db.getAllPageSlugsWithPaths().map(p => p.slug));
    const orphans = lanceSlugs.filter(s => !sqliteSlugs.has(s));

    const cleaned: string[] = [];
    for (const slug of orphans) {
      try {
        await this.lance.deleteByPageSlug(slug);
        cleaned.push(slug);
      } catch (e) {
        this.logger?.warn("sync", `Failed to clean LanceDB orphan ${slug}: ${(e as Error).message}`);
      }
    }
    return cleaned;
  }

  /** Compensate a failed existing-page sync: restore retrievable metadata + exact
   *  index state. ingestHash is intentionally NOT restored — its invalidation is a
   *  logical fact (the body changed), so a stale dedup hash must stay cleared even
   *  after rollback, or a later re-ingest of the old body would be wrongly deduped.
   *  Throws SyncRollbackError if compensation cannot fully restore. */
  private async compensateSyncFailure(
    slug: string,
    meta: { title: string; tags: string[] } | null,
    indexSnap: IndexSnapshot,
    original: Error,
  ): Promise<void> {
    const errors: Error[] = [];
    if (meta) {
      // upsertPage ON CONFLICT only mutates title + updated_at, so type/filePath
      // are read back as-is from the current row (no snapshot needed for them).
      const page = this.db.getPage(slug);
      try {
        this.db.upsertPage({
          slug,
          type: page?.type ?? "record",
          title: meta.title,
          filePath: page?.file_path ?? `${slug}.md`,
        });
      } catch (e) { errors.push(e instanceof Error ? e : new Error(String(e))); }
      try { this.db.replaceTags(slug, meta.tags); } catch (e) { errors.push(e instanceof Error ? e : new Error(String(e))); }
    }
    const restore = await restoreIndexState(this.db, this.lance, slug, indexSnap);
    if (!restore.ok) errors.push(...restore.errors);
    if (errors.length > 0) {
      this.writeRecoveryAudit(slug, original, errors);
      throw new SyncRollbackError(original, errors);
    }
  }

  /** Narrow cleanup for a newly-created page that failed during indexing.
   *  Removes this page's DB rows (via cascade: pages + chunks/links/tags/timeline/FTS/ingest_log) and Lance vectors;
   *  never touches the user's vault file.
   *  Throws SyncRollbackError if any cleanup step fails. */
  private async cleanupNewPage(slug: string, original: Error): Promise<void> {
    const errors: Error[] = [];
    try { this.db.deletePageCascaded(slug); } catch (e) { errors.push(e instanceof Error ? e : new Error(String(e))); }
    try { await this.lance.deleteByPageSlug(slug); } catch (e) { errors.push(e instanceof Error ? e : new Error(String(e))); }
    if (errors.length > 0) {
      this.writeRecoveryAudit(slug, original, errors);
      throw new SyncRollbackError(original, errors);
    }
  }

  /** Persist a sanitized recovery-required audit entry (ingest_log) so watcher/ops
   *  can recognize reindex-needed failures without string-matching raw messages.
   *  Raw error text never leaves this record — messages are redacted first. */
  private writeRecoveryAudit(slug: string, original: Error, errors: Error[]): void {
    try {
      this.pipeline.writeIngestLog(slug, "vault", {
        rollbackIncomplete: true,
        rollbackErrors: errors.map((e) => sanitizeForLog(e.message)),
        originalError: sanitizeForLog(original.message),
        reindexRequired: true,
      });
    } catch { /* audit write is non-critical */ }
  }

  /** Snapshot the index state, persisting a recovery-required audit if the
   *  snapshot itself fails (existing page + unreadable Lance). Centralized so
   *  both syncPage and syncAll share the fail-closed + audit behavior. */
  private async snapshotOrFail(slug: string, exists: boolean): Promise<IndexSnapshot> {
    try {
      return await snapshotIndexState(this.db, this.lance, slug, exists);
    } catch (snapError) {
      if (snapError instanceof SyncSnapshotError) {
        this.writeRecoveryAudit(slug, snapError, [snapError.readError]);
      }
      throw snapError;
    }
  }

  // ─── Private ────────────────────────────────────────────────

  private checkTitleCollision(title: string, slug: string, type: string, filePath: string): void {
    const collision = this.db.getPageByTitleExcluding(title, slug);
    if (collision) {
      throw new TitleCollisionError({
        title,
        incoming: { slug, type, filePath },
        existing: { slug: collision.slug, type: collision.type, filePath: this.db.getPageFilePath(collision.slug) ?? "" },
      });
    }
  }

  private async promoteRecordCollisionIfPerson(
    title: string,
    incomingSlug: string,
    incomingType: string,
    incomingFilePath: string,
    vaultPath: string,
  ): Promise<boolean> {
    if (incomingType !== "entity/person") return false;
    if (!incomingSlug.startsWith("brain/entities/person/")) return Promise.resolve(false);

    const collision = this.db.getPageByTitleExcluding(title, incomingSlug);
    if (!collision || collision.type !== "record" || !collision.slug.startsWith("records/")) return Promise.resolve(false);

    const oldSlug = collision.slug;
    const collisionFull = this.db.getPage(oldSlug);
    const oldType = collision.type;
    const oldFilePath = this.db.getPageFilePath(oldSlug);
    const oldHash: string | null = collisionFull?.content_hash ?? null;
    const oldRelPath = collisionFull?.file_path ?? oldFilePath;
    const oldAbsPath = oldFilePath ? join(vaultPath, oldFilePath) : null;

    // Compute hash of incoming file
    const incomingAbsPath = join(vaultPath, incomingFilePath);
    let newHash: string;
    try {
      const incomingContent = readFileSync(incomingAbsPath, "utf-8");
      newHash = hashContent(incomingContent);
    } catch {
      return Promise.resolve(false);
    }

    // DB move first (atomic with hash)
    try {
      this.db.movePage(oldSlug, incomingSlug, incomingType, incomingFilePath, newHash);
    } catch (dbErr) {
      this.logger?.error("sync", "promoteRecordCollision: DB move failed", {
        oldSlug, newSlug: incomingSlug, error: dbErr,
      });
      return Promise.resolve(false);
    }

    try { this.db.deleteConfig(`sync.skip.${incomingSlug}`); } catch { /* non-critical */ }
    try { this.db.deleteConfig(`sync.skip.${oldSlug}`); } catch { /* non-critical */ }

    // Delete old file — failure is a FAILED move, compensate DB back
    if (oldAbsPath) {
      try {
        await this._unlink(oldAbsPath);
      } catch (fileErr) {
        // Compensate: move DB back to old state
        try {
          this.db.movePage(incomingSlug, oldSlug, oldType, oldRelPath!, oldHash);
        } catch (compensateErr) {
          this.logger?.error("sync", "promoteRecordCollision: compensation failed after file delete failure", {
            incomingSlug, oldSlug, fileErr, compensateErr,
          });
          throw new Error(
            `Promote rollback incomplete: file delete failed (${fileErr}) and DB compensation failed (${compensateErr})`,
          );
        }
        this.logger?.warn("sync", "promoteRecordCollision: old file delete failed, move compensated", {
          oldSlug, oldAbsPath, error: fileErr,
        });
        return false;
      }
    }

    this.logger?.info("sync", "同名 record 已升级为 person", {
      title,
      oldSlug,
      newSlug: incomingSlug,
    });
    return true;
  }

  private async discardRecordCollisionIfPerson(
    title: string,
    incomingSlug: string,
    incomingType: string,
    incomingFilePath: string,
    vaultPath: string,
  ): Promise<boolean> {
    if (incomingType !== "record") return false;
    if (!incomingSlug.startsWith("records/")) return false;

    const collision = this.db.getPageByTitleExcluding(title, incomingSlug);
    if (!collision || collision.type !== "entity/person" || !collision.slug.startsWith("brain/entities/person/")) return false;

    try {
      await unlink(join(vaultPath, incomingFilePath));
    } catch { /* already gone or not writable; skip still prevents collision replay */ }
    try { this.db.deleteConfig(`sync.skip.${incomingSlug}`); } catch { /* non-critical */ }
    this.logger?.info("sync", "同名 record 已由 person 接管，跳过旧 record", {
      title,
      oldSlug: incomingSlug,
      personSlug: collision.slug,
    });
    return true;
  }

  private inferTypeFromPath(relPath: string): string {
    const parts = relPath.split("/");
    // records/X.md at root level
    if (parts[0] === "records") return "record";
    // brain/entities/person/X.md → entity/person (concrete sub-type from subdir)
    if (parts.length >= 4 && parts[0] === "brain") {
      const parentDir = parts[1]; // entities, concepts, insights
      const subDir = parts[2];    // person, company, etc.
      if (parentDir === "entities") return `entity/${subDir}`;
      if (parentDir === "concepts") return `concept/${subDir}`;
      if (parentDir === "insights") return "insight";
    }
    // brain/entities/X.md (old flat structure — can't infer concrete type)
    if (parts.length >= 3 && parts[0] === "brain") {
      const parentDir = parts[1];
      if (parentDir === "entities" || parentDir === "concepts") return "record";
      if (parentDir === "insights") return "insight";
    }
    return "record";
  }
}
