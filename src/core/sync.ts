import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { CBrainDB } from "../storage/sqlite.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import { LanceDBManager } from "../storage/lancedb.js";
import { NerEngine } from "./ner.js";
import { PageManager } from "./page.js";
import { AuditLogger } from "./audit.js";
import type { Logger } from "./logger.js";
import {
  chunkContent,
  hashContent,
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

// Module-level cache for batch-embedded chunks in syncAll
const chunkEmbedCache = new Map<string, { embedding: number[]; tokenCount: number }>();

export class SyncManager {
  private db: CBrainDB;
  private embedding: EmbeddingProvider;
  private lance: LanceDBManager;
  private pipeline: ContentPipeline;
  private chunkSize: number;
  private nerEngine: NerEngine | null;
  private pages: PageManager | null;
  private audit: AuditLogger | null;
  private logger: Logger | null;

  constructor(
    db: CBrainDB,
    embedding: EmbeddingProvider,
    lance: LanceDBManager,
    config?: SyncConfig & { nerEngine?: NerEngine; pages?: PageManager; logger?: Logger }
  ) {
    this.db = db;
    this.embedding = embedding;
    this.lance = lance;
    this.chunkSize = config?.chunkSize ?? 500;
    this.nerEngine = config?.nerEngine ?? null;
    this.pages = config?.pages ?? null;
    this.logger = config?.logger ?? null;
    this.audit = config?.outputsDir ? new AuditLogger(config.outputsDir) : null;
    this.pipeline = new ContentPipeline(db, embedding, lance, {
      pages: this.pages ?? undefined,
      nerEngine: this.nerEngine ?? undefined,
      logger: this.logger ?? undefined,
      chunkSize: this.chunkSize,
    });
  }

  async syncAll(vaultPath: string): Promise<SyncReport> {
    const report: SyncReport = { synced: 0, skipped: 0, errors: 0, errorDetails: [] };
    const mdFiles = this.collectMarkdownFiles(vaultPath);

    // Phase 1: detect changed files + batch embed all chunks
    const changed: Array<{ filePath: string; slug: string; title: string; type: string; relPath: string; body: string; contentHash: string; frontmatter: Record<string, unknown> }> = [];
    const allChunks: Array<{ slug: string; index: number; content: string }> = [];

    for (const filePath of mdFiles) {
      try {
        const content = readFileSync(filePath, "utf-8");
        const parsed = parseFrontmatter(content);
        const relPath = relative(vaultPath, filePath);
        const slug = parsed.frontmatter.slug ?? relPath.replace(/\.md$/, "");
        const contentHash = hashContent(content);

        const existing = this.db
          .prepare("SELECT content_hash FROM pages WHERE slug = $slug")
          .get({ $slug: slug }) as { content_hash: string } | null;

        if (existing && existing.content_hash === contentHash) {
          report.skipped++;
          continue;
        }

        const title = parsed.frontmatter.title ?? slug.split("/").pop() ?? slug;
        const type = parsed.frontmatter.type ?? this.inferTypeFromPath(relPath);
        const chunks = chunkContent(parsed.body, this.chunkSize);
        for (const c of chunks) allChunks.push({ slug, index: c.index, content: c.content });
        changed.push({ filePath, slug, title, type, relPath, body: parsed.body, contentHash, frontmatter: parsed.frontmatter });
      } catch (e) {
        report.errors++;
        report.errorDetails?.push(`${filePath}: ${(e as Error).message}`);
      }
    }

    // Batch embed all chunks at once
    if (allChunks.length > 0 && this.embedding) {
      try {
        const texts = allChunks.map(c => c.content);
        const embedResults = await this.embedding.embedBatch(texts);
        for (let i = 0; i < allChunks.length; i++) {
          chunkEmbedCache.set(`${allChunks[i].slug}:${allChunks[i].index}`, embedResults[i]);
        }
      } catch (e) {
        this.logger?.warn("sync", "批量 embedding 失败，回退到逐条处理");
      }
    }

    // Phase 2: write to DB + LanceDB + wikilinks (sequential), collect NER jobs
    const nerJobs: Array<{ slug: string; text: string }> = [];

    for (const file of changed) {
      try {
        const existing = this.db
          .prepare("SELECT content_hash FROM pages WHERE slug = $slug")
          .get({ $slug: file.slug }) as { content_hash: string } | null;

        if (existing) {
          try {
            this.db.createVersion(file.slug, file.body,
              file.frontmatter ? JSON.stringify(file.frontmatter) : undefined);
          } catch { /* version snapshot best-effort */ }
        }

        this.db.prepare(
          `INSERT INTO pages (slug, type, title, file_path, content_hash, created_at, updated_at)
           VALUES ($slug, $type, $title, $filePath, $contentHash, datetime('now'), datetime('now'))
           ON CONFLICT(slug) DO UPDATE SET
             type = $type,
             title = $title,
             file_path = $filePath,
             content_hash = $contentHash,
             updated_at = datetime('now')`
        ).run({
          $slug: file.slug,
          $type: file.type,
          $title: file.title,
          $filePath: file.relPath,
          $contentHash: file.contentHash,
        });

        // Build chunks + embedResults from cache, fall back to fresh embed
        const chunks = chunkContent(file.body, this.chunkSize);
        const embedResults = chunks.map(c => chunkEmbedCache.get(`${file.slug}:${c.index}`));
        if (embedResults.every(r => r)) {
          this.pipeline.writeIndexes(file.slug, chunks, embedResults as Array<{ embedding: number[]; tokenCount: number }>);
        } else {
          const fresh = await this.pipeline.embed(file.body);
          this.pipeline.writeIndexes(file.slug, fresh.chunks, fresh.embedResults);
        }

        this.pipeline.writeIngestLog(file.slug, "vault", { hash: file.contentHash });
        report.synced++;

        this.audit?.log(AuditLogger.entry("sync_page", "success", {
          pageSlug: file.slug,
          details: { chunks: chunks.length },
        }));

        if (this.nerEngine && file.body.trim() && file.type !== "entity" && file.type !== "concept") {
          nerJobs.push({ slug: file.slug, text: file.body });
        }

        if (this.pages && file.body.trim()) {
          try {
            this.pipeline.processWikilinks(file.slug, file.body, true);
          } catch {
            // Wiki-link extraction failure should not block sync
          }
        }
      } catch (err) {
        report.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        report.errorDetails!.push(`${file.filePath}: ${msg}`);
        this.logger?.error("sync", `同步失败: ${file.slug}`, { error: msg });
        this.audit?.log(AuditLogger.entry("sync_page", "error", {
          pageSlug: file.slug,
          details: { error: msg },
        }));
      }
    }

    // Phase 3: parallel NER batch
    if (nerJobs.length > 0 && this.nerEngine) {
      const CONCURRENCY = 5;
      for (let i = 0; i < nerJobs.length; i += CONCURRENCY) {
        const batch = nerJobs.slice(i, i + CONCURRENCY);
        const extractions = await Promise.all(
          batch.map(job => this.nerEngine!.extract(job.text).catch(() => null))
        );
        for (let j = 0; j < batch.length; j++) {
          const extraction = extractions[j];
          if (!extraction) continue;
          try {
            const nerResult = await this.pipeline.processNer(batch[j].slug, batch[j].text, "record", false);
            if (nerResult) {
              report.nerEntities = (report.nerEntities ?? 0) + nerResult.entities;
              report.nerRelations = (report.nerRelations ?? 0) + nerResult.relations;
              report.nerEvents = (report.nerEvents ?? 0) + nerResult.events;
              report.nerLowRelevanceSkipped = (report.nerLowRelevanceSkipped ?? 0) + nerResult.lowRelevanceSkipped;
            }
          } catch {
            // NER failure should not block sync
          }
        }
      }
    }

    chunkEmbedCache.clear();
    return report;
  }

  async cleanStaleStubs(vaultPath: string): Promise<string[]> {
    const removed: string[] = [];
    const stubs = this.db.prepare(
      `SELECT slug, title, file_path FROM pages
       WHERE (SELECT COUNT(*) FROM tags WHERE tags.page_slug = pages.slug AND tags.tag = 'auto-extracted') > 0`
    ).all() as Array<{ slug: string; title: string; file_path: string }>;

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
    const page = this.db
      .prepare("SELECT file_path FROM pages WHERE slug = $slug")
      .get({ $slug: slug }) as { file_path: string } | null;

    const filePath = page
      ? join(vaultPath, page.file_path)
      : join(vaultPath, `${slug}.md`);

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      return { success: false, error: `File not found: ${filePath}` };
    }
    const parsed = parseFrontmatter(content);

    const effectiveSlug = parsed.frontmatter.slug ?? slug;

    if (!effectiveSlug && !page) {
      return { success: false, error: `No slug found and page not indexed: ${filePath}` };
    }
    const contentHash = hashContent(content);

    const existing = this.db
      .prepare("SELECT content_hash FROM pages WHERE slug = $slug")
      .get({ $slug: effectiveSlug }) as { content_hash: string } | null;

    if (existing && existing.content_hash === contentHash) {
      return { success: true, skipped: true };
    }

    if (existing) {
      try {
        this.db.createVersion(effectiveSlug, parsed.body,
          parsed.frontmatter ? JSON.stringify(parsed.frontmatter) : undefined);
      } catch { /* version best-effort */ }
    }

    const relPath = relative(vaultPath, filePath);
    const title = parsed.frontmatter.title ?? effectiveSlug;
    const type = parsed.frontmatter.type ?? "record";

    this.db.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash, created_at, updated_at)
       VALUES ($slug, $type, $title, $filePath, $contentHash, datetime('now'), datetime('now'))
       ON CONFLICT(slug) DO UPDATE SET
         type = $type,
         title = $title,
         file_path = $filePath,
         content_hash = $contentHash,
         updated_at = datetime('now')`
    ).run({
      $slug: effectiveSlug,
      $type: type,
      $title: title,
      $filePath: relPath,
      $contentHash: contentHash,
    });

    const { chunks, embedResults } = await this.pipeline.embed(parsed.body);
    this.pipeline.writeIndexes(effectiveSlug, chunks, embedResults);
    this.pipeline.writeIngestLog(effectiveSlug, "vault", { hash: contentHash });

    // NER — skip entity/concept pages
    if (this.nerEngine && parsed.body.trim() && type !== "entity" && type !== "concept") {
      try {
        const nerResult = await this.pipeline.processNer(effectiveSlug, parsed.body, type, false);
        if (nerResult && nerResult.entities > 0) {
          this.logger?.info("sync", `NER: ${nerResult.entities} entities from ${effectiveSlug}`);
        }
      } catch (e) {
        this.logger?.warn("sync", `NER failed for ${effectiveSlug}: ${(e as Error).message}`);
      }
    }

    // Wikilink extraction
    if (this.pages && parsed.body.trim()) {
      try {
        this.pipeline.processWikilinks(effectiveSlug, parsed.body, true);
      } catch {
        // Wiki-link extraction failure should not block sync
      }
    }

    return { success: true };
  }

  async removeOrphans(vaultPath: string): Promise<string[]> {
    const pages = this.db
      .prepare("SELECT slug, file_path FROM pages")
      .all() as Array<{ slug: string; file_path: string }>;

    const orphans: string[] = [];

    for (const page of pages) {
      const fullPath = join(vaultPath, page.file_path);
      try {
        statSync(fullPath);
      } catch {
        orphans.push(page.slug);
        if (this.pages) {
          this.pages.delete(page.slug);
        } else {
          this.db.prepare("DELETE FROM pages WHERE slug = $slug").run({ $slug: page.slug });
        }
        await this.lance.deleteByPageSlug(page.slug);
      }
    }

    return orphans;
  }

  // ─── Private ────────────────────────────────────────────────

  private collectMarkdownFiles(dir: string): string[] {
    const results: string[] = [];

    const walk = (currentDir: string) => {
      const entries = readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (extname(entry.name).toLowerCase() === ".md") {
          results.push(fullPath);
        }
      }
    };

    walk(dir);
    return results;
  }

  private inferTypeFromPath(relPath: string): string {
    const typeFromDir: Record<string, string> = {
      nodes: "entity", events: "event",
      records: "record", sources: "source",
    };
    const parts = relPath.split("/");
    if (parts.length >= 3 && parts[0] === "brain") {
      return typeFromDir[parts[1]] ?? "record";
    }
    if (parts.length >= 3 && parts[0] === "raw") {
      return typeFromDir[parts[1]] ?? "record";
    }
    if (parts.length === 2 && parts[0] === "raw") {
      return "record";
    }
    return "record";
  }
}
