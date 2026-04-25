import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { CBrainDB } from "../storage/sqlite.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import { LanceDBManager } from "../storage/lancedb.js";
import { NerEngine } from "./ner.js";
import { PageManager } from "./page.js";
import { AuditLogger } from "./audit.js";
import {
  chunkContent,
  hashContent,
  mapEntityType,
  buildStubBody,
  findEntitySlug,
  resolveEntityName,
} from "./shared.js";

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
  private nerEngine: NerEngine | null;
  private pages: PageManager | null;
  private audit: AuditLogger | null;

  constructor(
    db: CBrainDB,
    embedding: EmbeddingProvider,
    lance: LanceDBManager,
    config?: SyncConfig & { nerEngine?: NerEngine; pages?: PageManager }
  ) {
    this.db = db;
    this.embedding = embedding;
    this.lance = lance;
    this.chunkSize = config?.chunkSize ?? 500;
    this.nerEngine = config?.nerEngine ?? null;
    this.pages = config?.pages ?? null;
    this.audit = config?.outputsDir ? new AuditLogger(config.outputsDir) : null;
  }

  async syncAll(vaultPath: string): Promise<SyncReport> {
    const report: SyncReport = { synced: 0, skipped: 0, errors: 0, errorDetails: [] };
    const mdFiles = this.collectMarkdownFiles(vaultPath);

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

        // Create version snapshot before updating
        if (existing) {
          try {
            this.db.createVersion(slug, parsed.body,
              parsed.frontmatter ? JSON.stringify(parsed.frontmatter) : undefined);
          } catch { /* version snapshot best-effort */ }
        }

        const title = parsed.frontmatter.title ?? slug.split("/").pop() ?? slug;
        const type = parsed.frontmatter.type ?? this.inferTypeFromPath(relPath);

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

        await this.writeIndexes(slug, parsed.body);

        this.db.prepare(
          `INSERT INTO ingest_log (source_type, action, page_slug, details) VALUES ($source, $action, $slug, $details)`
        ).run({
          $source: "vault",
          $action: "sync",
          $slug: slug,
          $details: JSON.stringify({ hash: contentHash }),
        });

        report.synced++;

        this.audit?.log(AuditLogger.entry("sync_page", "success", {
          pageSlug: slug,
          details: { chunks: chunkContent(parsed.body, this.chunkSize).length },
        }));

        if (this.nerEngine && parsed.body.trim()) {
          try {
            const nerResult = await this.runNer(slug, parsed.body);
            report.nerEntities = (report.nerEntities ?? 0) + nerResult.entities;
            report.nerRelations = (report.nerRelations ?? 0) + nerResult.relations;
            report.nerEvents = (report.nerEvents ?? 0) + nerResult.events;
          } catch {
            // NER failure should not block sync
          }
        }
      } catch (err) {
        report.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        report.errorDetails!.push(`${filePath}: ${msg}`);
        this.audit?.log(AuditLogger.entry("sync_page", "error", {
          pageSlug: relative(vaultPath, filePath),
          details: { error: msg },
        }));
      }
    }

    return report;
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

    if (!parsed.frontmatter.slug && !page) {
      return { success: false, error: `No slug found and page not indexed: ${filePath}` };
    }

    const effectiveSlug = parsed.frontmatter.slug ?? slug;
    const contentHash = hashContent(content);

    const existing = this.db
      .prepare("SELECT content_hash FROM pages WHERE slug = $slug")
      .get({ $slug: effectiveSlug }) as { content_hash: string } | null;

    if (existing && existing.content_hash === contentHash) {
      return { success: true, skipped: true };
    }

    // Create version snapshot before updating
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

    await this.writeIndexes(effectiveSlug, parsed.body);

    this.db.prepare(
      `INSERT INTO ingest_log (source_type, action, page_slug, details) VALUES ($source, $action, $slug, $details)`
    ).run({
      $source: "vault",
      $action: "sync",
      $slug: effectiveSlug,
      $details: JSON.stringify({ hash: contentHash }),
    });

    if (this.nerEngine && parsed.body.trim()) {
      try {
        await this.runNer(effectiveSlug, parsed.body);
      } catch {
        // NER failure should not block sync
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
        this.db.prepare("DELETE FROM pages WHERE slug = $slug").run({
          $slug: page.slug,
        });
        await this.lance.deleteByPageSlug(page.slug);
      }
    }

    return orphans;
  }

  // ─── Private ────────────────────────────────────────────────

  private async writeIndexes(slug: string, body: string): Promise<void> {
    const chunks = chunkContent(body, this.chunkSize);
    if (chunks.length === 0) return;

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

    this.db.prepare("DELETE FROM chunks WHERE page_slug = $slug").run({
      $slug: slug,
    });
    this.db.ftsDeleteByPage(slug);
    const insertChunk = this.db.prepare(
      "INSERT INTO chunks (page_slug, chunk_index, content) VALUES ($slug, $idx, $content)"
    );
    for (const chunk of chunks) {
      insertChunk.run({ $slug: slug, $idx: chunk.index, $content: chunk.content });
    }

    const fullContent = chunks.map((c) => c.content).join("\n\n");
    this.db.ftsInsert(slug, fullContent);
  }

  private async runNer(
    fromSlug: string,
    text: string
  ): Promise<{ entities: number; relations: number; events: number }> {
    if (!this.nerEngine) return { entities: 0, relations: 0, events: 0 };

    const extraction = await this.nerEngine.extract(text);
    if (extraction.entities.length === 0 && extraction.relations.length === 0) {
      return { entities: 0, relations: 0, events: 0 };
    }

    const entitySlugMap = new Map<string, string>();
    const stubsCreated: string[] = [];

    for (const entity of extraction.entities) {
      const existingSlug = findEntitySlug(this.db, entity.name);
      if (existingSlug) {
        entitySlugMap.set(entity.name, existingSlug);
        this.db.prepare(
          "UPDATE pages SET mention_count = mention_count + 1 WHERE slug = $slug"
        ).run({ $slug: existingSlug });
      } else if (this.pages) {
        const entityType = mapEntityType(entity.type);
        const stub = this.pages.create({
          title: entity.name,
          type: entityType,
          body: `> Auto-extracted from [[${fromSlug}]]`,
          tags: ["auto-extracted"],
        });
        entitySlugMap.set(entity.name, stub.slug);
        stubsCreated.push(stub.slug);
      }
    }

    const writtenRelations: Array<{ from: string; to: string; relation: string }> = [];
    for (const rel of extraction.relations) {
      const fromSlugResolved = resolveEntityName(rel.from, entitySlugMap, this.db);
      const toSlugResolved = resolveEntityName(rel.to, entitySlugMap, this.db);
      if (fromSlugResolved && toSlugResolved && fromSlugResolved !== toSlugResolved) {
        this.db.prepare(
          `INSERT OR IGNORE INTO links (from_slug, to_slug, relation, context) VALUES ($from, $to, $rel, $ctx)`
        ).run({ $from: fromSlugResolved, $to: toSlugResolved, $rel: rel.relation, $ctx: rel.context });

        const fromTitle = this.pages?.getBySlug(fromSlugResolved)?.title ?? rel.from;
        const toTitle = this.pages?.getBySlug(toSlugResolved)?.title ?? rel.to;
        writtenRelations.push({ from: fromTitle, to: toTitle, relation: rel.relation });
      }
    }

    if (this.pages) {
      for (const [name, slug] of entitySlugMap) {
        if (!stubsCreated.includes(slug)) continue;
        const rels = writtenRelations.filter(r => r.from === name || r.to === name);
        if (rels.length > 0) {
          const body = buildStubBody(name, rels, fromSlug);
          this.pages.update(slug, { body });
        }
      }
    }

    for (const event of extraction.events) {
      this.db.prepare(
        `INSERT INTO timeline (page_slug, event_date, source, summary) VALUES ($slug, $date, $source, $summary)`
      ).run({
        $slug: fromSlug,
        $date: event.date ?? null,
        $source: "ner",
        $summary: event.description,
      });
    }

    return {
      entities: extraction.entities.length,
      relations: extraction.relations.length,
      events: extraction.events.length,
    };
  }

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
      entities: "entity", concepts: "concept", events: "event",
      records: "record", sources: "source",
    };
    const parts = relPath.split("/");
    // brain/<type>/<file>.md → <type>
    if (parts.length >= 3 && parts[0] === "brain") {
      return typeFromDir[parts[1]] ?? "record";
    }
    // raw/<type>/<file>.md → <type>
    if (parts.length >= 3 && parts[0] === "raw") {
      return typeFromDir[parts[1]] ?? "record";
    }
    // raw/<file>.md → record (flat raw root, no type dir)
    if (parts.length === 2 && parts[0] === "raw") {
      return "record";
    }
    // vault root .md files → record
    return "record";
  }
}
