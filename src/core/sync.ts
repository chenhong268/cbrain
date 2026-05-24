import { existsSync } from "node:fs";
import { readFile, access, rename, mkdir } from "node:fs/promises";
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
} from "./shared.js";
import { ContentPipeline } from "./pipeline.js";
import type { NerPipelineResult } from "./pipeline.js";

export interface SyncConfig {
  chunkSize?: number;
  outputsDir?: string;
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
}

export interface SyncPageResult {
  success: boolean;
  skipped?: boolean;
  error?: string;
}

export class SyncManager {
  private db: CBrainDB;
  private embedding: EmbeddingProvider;
  private lance: LanceDBManager;
  private pipeline: ContentPipeline;
  private chunkSize: number;
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
    const report: SyncReport = { synced: 0, skipped: 0, errors: 0, errorDetails: [] };
    try {
    const mdFiles = await collectMarkdownFiles(vaultPath, new Set(["outputs"]));

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

        const existing = this.db.getPageContentHash(slug);

        if (existing && existing === contentHash) {
          // Backfill tags + wikilinks even when content unchanged
          if (parsed.frontmatter?.tags && Array.isArray(parsed.frontmatter.tags)) {
            this.db.replaceTags(slug, parsed.frontmatter.tags as string[]);
          }
          if (this.pages && parsed.body.trim()) {
            try {
              this.pipeline.processWikilinks(slug, parsed.body);
            } catch { /* non-critical */ }
          }
          report.skipped++;
          continue;
        }

        const title = parsed.frontmatter.title ?? slug.split("/").pop() ?? slug;
        const type = normalizePageType(parsed.frontmatter.type ?? this.inferTypeFromPath(relPath));
        const chunks = chunkContent(parsed.body, this.chunkSize);
        for (const c of chunks) allChunks.push({ slug, index: c.index, content: c.content });
        changed.push({ filePath, slug, title, type, relPath, body: parsed.body, contentHash, frontmatter: parsed.frontmatter });
      } catch (e) {
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
      } catch (e) {
        this.logger?.warn("sync", "批量 embedding 失败，回退到逐条处理");
      }
    }

    // Phase 2: write to DB + LanceDB + wikilinks (sequential), collect NER jobs
    const nerJobs: Array<{ slug: string; text: string; type: string; mentionedSlugs: Set<string> }> = [];

    for (const file of changed) {
      try {
        const existing = this.db.getPageContentHash(file.slug);

        if (existing) {
          try {
            this.db.createVersion(file.slug, file.body,
              file.frontmatter ? JSON.stringify(file.frontmatter) : undefined);
          } catch (e) {
            this.logger?.warn("sync", "版本快照写入失败", { slug: file.slug, error: String(e) });
          }
        }

        this.db.upsertPage({
          slug: file.slug,
          type: file.type,
          title: file.title,
          filePath: file.relPath,
          contentHash: file.contentHash,
        });

        if (file.frontmatter?.tags && Array.isArray(file.frontmatter.tags)) {
          this.db.replaceTags(file.slug, file.frontmatter.tags as string[]);
        }

        // Build chunks + embedResults from cache, fall back to fresh embed
        const chunks = chunkContent(file.body, this.chunkSize);
        const embedResults = chunks.map(c => this.chunkEmbedCache.get(`${file.slug}:${c.index}`));
        if (embedResults.every(r => r)) {
          this.pipeline.writeIndexes(file.slug, chunks, embedResults as Array<{ embedding: number[]; tokenCount: number }>);
        } else {
          const fresh = await this.pipeline.embed(file.body);
          this.pipeline.writeIndexes(file.slug, fresh.chunks, fresh.embedResults);
        }

        this.pipeline.writeIngestLog(file.slug, "vault", { hash: file.contentHash });
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
      } catch (err) {
        report.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        report.errorDetails!.push(`${file.filePath}: ${msg}`);
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

  async cleanStaleStubs(vaultPath: string): Promise<string[]> {
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
      return { success: false, error: `File not found: ${fullPath}` };
    }
    const parsed = parseFrontmatter(content);

    let effectiveSlug = parsed.frontmatter.slug ?? slug;

    if (!effectiveSlug && !filePath) {
      return { success: false, error: `No slug found and page not indexed: ${fullPath}` };
    }
    const contentHash = hashContent(content);

    const existing = this.db.getPageContentHash(effectiveSlug);

    if (existing && existing === contentHash) {
      // Backfill tags + wikilinks even when content unchanged
      if (parsed.frontmatter?.tags && Array.isArray(parsed.frontmatter.tags)) {
        this.db.replaceTags(effectiveSlug, parsed.frontmatter.tags as string[]);
      }
      if (this.pages && parsed.body.trim()) {
        try {
          this.pipeline.processWikilinks(effectiveSlug, parsed.body);
        } catch { /* non-critical */ }
      }
      // Write mention snapshot for trend detection
      try {
        const mc = this.db.getPage(effectiveSlug)?.mention_count ?? 0;
        this.db.upsertMentionSnapshot(effectiveSlug, new Date().toISOString().slice(0, 10), mc);
      } catch { /* non-critical */ }

      return { success: true, skipped: true };
    }

    if (existing) {
      try {
        this.db.createVersion(effectiveSlug, parsed.body,
          parsed.frontmatter ? JSON.stringify(parsed.frontmatter) : undefined);
      } catch (e) {
        this.logger?.warn("sync", "版本快照写入失败", { slug: effectiveSlug, error: String(e) });
      }
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

    this.db.upsertPage({
      slug: effectiveSlug,
      type,
      title,
      filePath: relPath,
      contentHash,
    });

    if (parsed.frontmatter?.tags && Array.isArray(parsed.frontmatter.tags)) {
      this.db.replaceTags(effectiveSlug, parsed.frontmatter.tags as string[]);
    }

    const { chunks, embedResults } = await this.pipeline.embed(parsed.body);
    this.pipeline.writeIndexes(effectiveSlug, chunks, embedResults);
    this.pipeline.writeIngestLog(effectiveSlug, "vault", { hash: contentHash });

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

  removePage(slug: string): void {
    this.db.deletePageCascaded(slug);
    this.lance.deleteByPageSlug(slug);
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
        if (this.pages) {
          await this.pages.delete(page.slug);
        } else {
          this.db.deletePageCascaded(page.slug);
        }
        await this.lance.deleteByPageSlug(page.slug);
      }
    }

    return orphans;
  }

  // ─── Private ────────────────────────────────────────────────

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
