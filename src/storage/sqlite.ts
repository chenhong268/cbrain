import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class CBrainDB {
  private db: Database;

  constructor(dbPath: string) {
    if (!existsSync(dirname(dbPath))) {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pages (
        slug TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('entity', 'concept', 'event', 'record', 'source')),
        title TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content_hash TEXT,
        tier INTEGER DEFAULT 3 CHECK(tier BETWEEN 1 AND 3),
        mention_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_slug TEXT NOT NULL,
        to_slug TEXT NOT NULL,
        relation TEXT NOT NULL DEFAULT 'mentions',
        context TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (from_slug) REFERENCES pages(slug) ON DELETE CASCADE,
        FOREIGN KEY (to_slug) REFERENCES pages(slug) ON DELETE CASCADE,
        UNIQUE(from_slug, to_slug, relation)
      );

      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page_slug TEXT NOT NULL,
        tag TEXT NOT NULL,
        FOREIGN KEY (page_slug) REFERENCES pages(slug) ON DELETE CASCADE,
        UNIQUE(page_slug, tag)
      );

      CREATE TABLE IF NOT EXISTS timeline (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page_slug TEXT NOT NULL,
        event_date TEXT NOT NULL,
        source TEXT,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (page_slug) REFERENCES pages(slug) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page_slug TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (page_slug) REFERENCES pages(slug) ON DELETE CASCADE,
        UNIQUE(page_slug, chunk_index)
      );

      CREATE TABLE IF NOT EXISTS ingest_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,
        action TEXT NOT NULL,
        page_slug TEXT,
        details TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(type);
      CREATE INDEX IF NOT EXISTS idx_pages_tier ON pages(tier);
      CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_slug);
      CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_slug);
      CREATE INDEX IF NOT EXISTS idx_links_relation ON links(relation);
      CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
      CREATE INDEX IF NOT EXISTS idx_timeline_date ON timeline(event_date);
      CREATE INDEX IF NOT EXISTS idx_chunks_page ON chunks(page_slug);

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(page_slug, content, tokenize='trigram');
    `);
  }

  prepare(sql: string) {
    return this.db.prepare(sql);
  }

  run(sql: string) {
    return this.db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  ftsInsert(pageSlug: string, content: string): void {
    this.db.prepare(
      "INSERT INTO chunks_fts(page_slug, content) VALUES ($slug, $content)"
    ).run({ $slug: pageSlug, $content: content });
  }

  ftsDeleteByPage(pageSlug: string): void {
    this.db.prepare(
      "DELETE FROM chunks_fts WHERE page_slug = $slug"
    ).run({ $slug: pageSlug });
  }

  ftsSearch(query: string, limit: number = 10): Array<{ page_slug: string; content: string; rank: number }> {
    if (query.length < 3) return [];
    const ftsQuery = this.buildTrigramQuery(query);
    return this.db.prepare(
      "SELECT page_slug, content, rank FROM chunks_fts WHERE chunks_fts MATCH $query ORDER BY rank LIMIT $limit"
    ).all({ $query: ftsQuery, $limit: limit }) as Array<{ page_slug: string; content: string; rank: number }>;
  }

  private buildTrigramQuery(query: string): string {
    // For short queries (3-6 chars), use as-is — likely a precise substring search
    if (query.length <= 6) return query;
    // For longer queries, extract overlapping trigrams and OR them
    // e.g. "张三负责什么项目" → "张三负 OR 三负责 OR 负责什 OR 责什么 OR 什么项 OR 么项目"
    const trigrams: string[] = [];
    for (let i = 0; i <= query.length - 3; i++) {
      trigrams.push(query.slice(i, i + 3));
    }
    return trigrams.join(" OR ");
  }

  close(): void {
    this.db.close();
  }
}
