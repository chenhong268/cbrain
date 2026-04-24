import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { createHash } from "node:crypto";
import { CBrainDB } from "../storage/sqlite.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import { LanceDBManager } from "../storage/lancedb.js";

export interface SyncConfig {
  chunkSize?: number; // max chars per chunk, default 500
}

export interface SyncReport {
  synced: number;
  skipped: number;
  errors: number;
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
  private chunkSize: number;

  constructor(
    db: CBrainDB,
    embedding: EmbeddingProvider,
    lance: LanceDBManager,
    config?: SyncConfig
  ) {
    this.db = db;
    this.embedding = embedding;
    this.lance = lance;
    this.chunkSize = config?.chunkSize ?? 500;
  }

  /**
   * Scan vault directory and sync all .md files to SQLite + LanceDB.
   * - Skip files whose content hash hasn't changed.
   * - Chunk content, embed, and upsert to LanceDB.
   * - Log each sync to ingest_log.
   */
  async syncAll(vaultPath: string): Promise<SyncReport> {
    const report: SyncReport = { synced: 0, skipped: 0, errors: 0, errorDetails: [] };
    const mdFiles = this.collectMarkdownFiles(vaultPath);

    for (const filePath of mdFiles) {
      try {
        const content = readFileSync(filePath, "utf-8");
        const parsed = parseFrontmatter(content);

        const slug = parsed.frontmatter.slug;
        if (!slug) {
          report.errors++;
          report.errorDetails!.push(`Missing slug in ${filePath}`);
          continue;
        }

        const contentHash = this.hashContent(content);

        // Check if unchanged
        const existing = this.db
          .prepare("SELECT content_hash FROM pages WHERE slug = $slug")
          .get({ $slug: slug }) as { content_hash: string } | null;

        if (existing && existing.content_hash === contentHash) {
          report.skipped++;
          continue;
        }

        // Upsert page in SQLite
        const relPath = relative(vaultPath, filePath);
        const title = parsed.frontmatter.title ?? slug;
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
          $slug: slug,
          $type: type,
          $title: title,
          $filePath: relPath,
          $contentHash: contentHash,
        });

        // Chunk, embed, and upsert to LanceDB
        const chunks = this.chunkContent(parsed.body);
        const embedResults = await this.embedding.embedBatch(
          chunks.map((c) => c.content)
        );

        await this.lance.deleteByPageSlug(slug);
        await this.lance.addChunks(
          chunks.map((c, i) => ({
            pageSlug: slug,
            chunkIndex: c.index,
            content: c.content,
            vector: new Float32Array(embedResults[i].embedding),
          }))
        );

        // Update chunks table in SQLite for reference
        this.db.prepare("DELETE FROM chunks WHERE page_slug = $slug").run({
          $slug: slug,
        });
        const insertChunk = this.db.prepare(
          "INSERT INTO chunks (page_slug, chunk_index, content) VALUES ($slug, $idx, $content)"
        );
        for (const chunk of chunks) {
          insertChunk.run({ $slug: slug, $idx: chunk.index, $content: chunk.content });
        }

        // Log to ingest_log
        this.db.prepare(
          `INSERT INTO ingest_log (source_type, action, page_slug, details) VALUES ($source, $action, $slug, $details)`
        ).run({
          $source: "vault",
          $action: "sync",
          $slug: slug,
          $details: JSON.stringify({ chunks: chunks.length, hash: contentHash }),
        });

        report.synced++;
      } catch (err) {
        report.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        report.errorDetails!.push(`${filePath}: ${msg}`);
      }
    }

    return report;
  }

  /**
   * Sync a single page by slug.
   * Reads the vault file, checks hash, and syncs if changed.
   */
  async syncPage(slug: string, vaultPath: string): Promise<SyncPageResult> {
    const page = this.db
      .prepare("SELECT file_path FROM pages WHERE slug = $slug")
      .get({ $slug: slug }) as { file_path: string } | null;

    const filePath = page
      ? join(vaultPath, page.file_path)
      : this.slugToFilePath(slug, vaultPath);

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      return { success: false, error: `File not found: ${filePath}` };
    }
    const parsed = parseFrontmatter(content);

    if (!parsed.frontmatter.slug && !page) {
      return { success: false, error: `No slug found and page not indexed: ${filePath}` };
    }

    const effectiveSlug = parsed.frontmatter.slug ?? slug;
    const contentHash = this.hashContent(content);

    // Check if unchanged
    const existing = this.db
      .prepare("SELECT content_hash FROM pages WHERE slug = $slug")
      .get({ $slug: effectiveSlug }) as { content_hash: string } | null;

    if (existing && existing.content_hash === contentHash) {
      return { success: true, skipped: true };
    }

    // Delegate to syncAll with just this file
    // (but we use inline logic to avoid scanning the whole vault)
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

    const chunks = this.chunkContent(parsed.body);
    const embedResults = await this.embedding.embedBatch(
      chunks.map((c) => c.content)
    );

    await this.lance.deleteByPageSlug(effectiveSlug);
    await this.lance.addChunks(
      chunks.map((c, i) => ({
        pageSlug: effectiveSlug,
        chunkIndex: c.index,
        content: c.content,
        vector: new Float32Array(embedResults[i].embedding),
      }))
    );

    this.db.prepare("DELETE FROM chunks WHERE page_slug = $slug").run({
      $slug: effectiveSlug,
    });
    const insertChunk = this.db.prepare(
      "INSERT INTO chunks (page_slug, chunk_index, content) VALUES ($slug, $idx, $content)"
    );
    for (const chunk of chunks) {
      insertChunk.run({ $slug: effectiveSlug, $idx: chunk.index, $content: chunk.content });
    }

    this.db.prepare(
      `INSERT INTO ingest_log (source_type, action, page_slug, details) VALUES ($source, $action, $slug, $details)`
    ).run({
      $source: "vault",
      $action: "sync",
      $slug: effectiveSlug,
      $details: JSON.stringify({ chunks: chunks.length, hash: contentHash }),
    });

    return { success: true };
  }

  /**
   * Find pages in SQLite that have no corresponding vault file,
   * remove them from both SQLite and LanceDB.
   */
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
        // File doesn't exist — it's an orphan
        orphans.push(page.slug);
        this.db.prepare("DELETE FROM pages WHERE slug = $slug").run({
          $slug: page.slug,
        });
        await this.lance.deleteByPageSlug(page.slug);
      }
    }

    return orphans;
  }

  // ─── Private Helpers ──────────────────────────────────────

  /**
   * Recursively collect all .md files in a directory.
   */
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

  /**
   * Split content into chunks by paragraphs, respecting chunkSize.
   * Each paragraph is kept intact; chunks accumulate paragraphs up to chunkSize.
   */
  private chunkContent(body: string): Array<{ index: number; content: string }> {
    if (!body.trim()) {
      return [{ index: 0, content: "" }];
    }

    const paragraphs = body.split(/\n\n+/).filter((p) => p.trim().length > 0);
    const chunks: Array<{ index: number; content: string }> = [];
    let current = "";
    let index = 0;

    for (const para of paragraphs) {
      if (current.length + para.length > this.chunkSize && current.length > 0) {
        chunks.push({ index, content: current.trim() });
        index++;
        current = para;
      } else {
        current = current.length > 0 ? current + "\n\n" + para : para;
      }
    }

    if (current.trim()) {
      chunks.push({ index, content: current.trim() });
    }

    return chunks;
  }

  private hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  }

  /**
   * Attempt to resolve a slug to a file path in the vault.
   */
  private slugToFilePath(slug: string, vaultPath: string): string {
    return join(vaultPath, `${slug}.md`);
  }
}
