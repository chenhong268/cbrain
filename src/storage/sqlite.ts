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
        event_date TEXT,
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

      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page_slug TEXT NOT NULL,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        frontmatter TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (page_slug) REFERENCES pages(slug) ON DELETE CASCADE,
        UNIQUE(page_slug, version)
      );

      CREATE INDEX IF NOT EXISTS idx_versions_page ON versions(page_slug);

      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed','cancelled')),
        priority INTEGER NOT NULL DEFAULT 0,
        data TEXT,
        result TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_name ON jobs(name);

      CREATE TABLE IF NOT EXISTS raw_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page_slug TEXT NOT NULL,
        key TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        data BLOB,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (page_slug) REFERENCES pages(slug) ON DELETE CASCADE,
        UNIQUE(page_slug, key)
      );

      CREATE INDEX IF NOT EXISTS idx_raw_data_page ON raw_data(page_slug);

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

  // ─── Tag operations ──────────────────────────────────────────

  getTags(pageSlug: string): string[] {
    const rows = this.db.prepare(
      "SELECT tag FROM tags WHERE page_slug = $slug ORDER BY tag"
    ).all({ $slug: pageSlug }) as Array<{ tag: string }>;
    return rows.map(r => r.tag);
  }

  addTag(pageSlug: string, tag: string): boolean {
    try {
      this.db.prepare(
        "INSERT OR IGNORE INTO tags (page_slug, tag) VALUES ($slug, $tag)"
      ).run({ $slug: pageSlug, $tag: tag });
      return true;
    } catch {
      return false;
    }
  }

  removeTag(pageSlug: string, tag: string): boolean {
    const result = this.db.prepare(
      "DELETE FROM tags WHERE page_slug = $slug AND tag = $tag"
    ).run({ $slug: pageSlug, $tag: tag });
    return result.changes > 0;
  }

  // ─── Timeline operations ─────────────────────────────────────

  getTimeline(pageSlug: string): Array<{ id: number; event_date: string | null; source: string | null; summary: string; created_at: string }> {
    return this.db.prepare(
      "SELECT id, event_date, source, summary, created_at FROM timeline WHERE page_slug = $slug ORDER BY event_date DESC, id DESC"
    ).all({ $slug: pageSlug }) as any[];
  }

  addTimelineEntry(pageSlug: string, summary: string, eventDate?: string, source?: string): number {
    const result = this.db.prepare(
      "INSERT INTO timeline (page_slug, summary, event_date, source) VALUES ($slug, $summary, $date, $source)"
    ).run({ $slug: pageSlug, $summary: summary, $date: eventDate ?? null, $source: source ?? null });
    return Number(result.lastInsertRowid);
  }

  searchTimeline(keyword?: string, dateFrom?: string, limit = 10): Array<{ page_slug: string; event_date: string | null; source: string | null; summary: string }> {
    let sql = "SELECT page_slug, event_date, source, summary FROM timeline WHERE 1=1";
    const params: Record<string, string | number> = { $limit: limit };

    if (keyword) {
      sql += " AND summary LIKE $keyword";
      params.$keyword = `%${keyword}%`;
    }
    if (dateFrom) {
      sql += " AND event_date >= $dateFrom";
      params.$dateFrom = dateFrom;
    }
    sql += " ORDER BY event_date DESC, id DESC LIMIT $limit";
    return this.db.prepare(sql).all(params) as any[];
  }

  // ─── Chunk operations ────────────────────────────────────────

  getChunksByPage(pageSlug: string): Array<{ id: number; chunk_index: number; content: string; created_at: string }> {
    return this.db.prepare(
      "SELECT id, chunk_index, content, created_at FROM chunks WHERE page_slug = $slug ORDER BY chunk_index"
    ).all({ $slug: pageSlug }) as any[];
  }

  // ─── Ingest log ──────────────────────────────────────────────

  getIngestLog(limit: number = 50): Array<{ id: number; source_type: string; action: string; page_slug: string | null; details: string | null; created_at: string }> {
    return this.db.prepare(
      "SELECT id, source_type, action, page_slug, details, created_at FROM ingest_log ORDER BY id DESC LIMIT $limit"
    ).all({ $limit: limit }) as any[];
  }

  // ─── Config operations ───────────────────────────────────────

  getConfig(key: string): string | null {
    const row = this.db.prepare(
      "SELECT value FROM config WHERE key = $key"
    ).get({ $key: key }) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setConfig(key: string, value: string): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO config (key, value) VALUES ($key, $value)"
    ).run({ $key: key, $value: value });
  }

  // ─── Slug resolution ─────────────────────────────────────────

  resolveSlugs(queries: string[]): Array<{ query: string; slug: string | null; title: string | null }> {
    return queries.map(query => {
      // Exact slug match
      const bySlug = this.db.prepare(
        "SELECT slug, title FROM pages WHERE slug = $q"
      ).get({ $q: query }) as { slug: string; title: string } | undefined;
      if (bySlug) return { query, slug: bySlug.slug, title: bySlug.title };

      // Exact title match
      const byTitle = this.db.prepare(
        "SELECT slug, title FROM pages WHERE title = $q"
      ).get({ $q: query }) as { slug: string; title: string } | undefined;
      if (byTitle) return { query, slug: byTitle.slug, title: byTitle.title };

      // Fuzzy title match (LIKE)
      const fuzzy = this.db.prepare(
        "SELECT slug, title FROM pages WHERE title LIKE $q LIMIT 1"
      ).get({ $q: `%${query}%` }) as { slug: string; title: string } | undefined;
      if (fuzzy) return { query, slug: fuzzy.slug, title: fuzzy.title };

      return { query, slug: null, title: null };
    });
  }

  // ─── Version operations ──────────────────────────────────────

  getVersionCount(pageSlug: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM versions WHERE page_slug = $slug"
    ).get({ $slug: pageSlug }) as { cnt: number };
    return row.cnt;
  }

  createVersion(pageSlug: string, content: string, frontmatter?: string): number {
    const nextVer = this.getVersionCount(pageSlug) + 1;
    this.db.prepare(
      "INSERT INTO versions (page_slug, version, content, frontmatter) VALUES ($slug, $ver, $content, $fm)"
    ).run({ $slug: pageSlug, $ver: nextVer, $content: content, $fm: frontmatter ?? null });
    return nextVer;
  }

  getVersions(pageSlug: string): Array<{ id: number; version: number; created_at: string }> {
    return this.db.prepare(
      "SELECT id, version, created_at FROM versions WHERE page_slug = $slug ORDER BY version DESC"
    ).all({ $slug: pageSlug }) as any[];
  }

  getVersion(pageSlug: string, version: number): { content: string; frontmatter: string | null; version: number; created_at: string } | null {
    return this.db.prepare(
      "SELECT content, frontmatter, version, created_at FROM versions WHERE page_slug = $slug AND version = $ver"
    ).get({ $slug: pageSlug, $ver: version }) as any ?? null;
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
    // Short queries (<3 chars) fall back to LIKE — trigram tokenizer needs ≥3 chars
    if (query.length < 3) {
      return this.db.prepare(
        "SELECT DISTINCT page_slug, content, 0.8 as rank FROM chunks WHERE content LIKE $pattern LIMIT $limit"
      ).all({ $pattern: `%${query}%`, $limit: limit }) as Array<{ page_slug: string; content: string; rank: number }>;
    }
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

  // ─── Job operations ────────────────────────────────────────────

  submitJob(name: string, data?: unknown, priority: number = 0): number {
    const result = this.db.prepare(
      "INSERT INTO jobs (name, data, priority) VALUES ($name, $data, $priority)"
    ).run({ $name: name, $data: data ? JSON.stringify(data) : null, $priority: priority });
    return Number(result.lastInsertRowid);
  }

  claimJob(): { id: number; name: string; data: string | null; attempts: number } | null {
    const row = this.db.prepare(
      "SELECT id, name, data, attempts FROM jobs WHERE status = 'pending' ORDER BY priority DESC, id ASC LIMIT 1"
    ).get() as { id: number; name: string; data: string | null; attempts: number } | undefined;
    if (!row) return null;

    this.db.prepare(
      "UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = datetime('now') WHERE id = $id"
    ).run({ $id: row.id });
    return row;
  }

  completeJob(id: number, result?: unknown): void {
    this.db.prepare(
      "UPDATE jobs SET status = 'done', result = $result, finished_at = datetime('now') WHERE id = $id"
    ).run({ $id: id, $result: result ? JSON.stringify(result) : null });
  }

  failJob(id: number, error: string): void {
    const job = this.db.prepare("SELECT attempts, max_attempts FROM jobs WHERE id = $id").get({ $id: id }) as { attempts: number; max_attempts: number } | undefined;
    const status = job && job.attempts >= job.max_attempts ? "failed" : "pending";
    this.db.prepare(
      "UPDATE jobs SET status = $status, error = $error, finished_at = CASE WHEN $status = 'failed' THEN datetime('now') ELSE NULL END WHERE id = $id"
    ).run({ $id: id, $status: status, $error: error });
  }

  listJobs(status?: string): Array<{
    id: number; name: string; status: string; priority: number;
    data: string | null; result: string | null; error: string | null;
    attempts: number; max_attempts: number;
    created_at: string; started_at: string | null; finished_at: string | null;
  }> {
    if (status) {
      return this.db.prepare(
        "SELECT id, name, status, priority, data, result, error, attempts, max_attempts, created_at, started_at, finished_at FROM jobs WHERE status = $status ORDER BY id DESC"
      ).all({ $status: status }) as any[];
    }
    return this.db.prepare(
      "SELECT id, name, status, priority, data, result, error, attempts, max_attempts, created_at, started_at, finished_at FROM jobs ORDER BY id DESC LIMIT 100"
    ).all() as any[];
  }

  getJob(id: number): {
    id: number; name: string; status: string; priority: number;
    data: string | null; result: string | null; error: string | null;
    attempts: number; max_attempts: number;
    created_at: string; started_at: string | null; finished_at: string | null;
  } | null {
    return this.db.prepare(
      "SELECT id, name, status, priority, data, result, error, attempts, max_attempts, created_at, started_at, finished_at FROM jobs WHERE id = $id"
    ).get({ $id: id }) as any ?? null;
  }

  cancelJob(id: number): boolean {
    const r = this.db.prepare(
      "UPDATE jobs SET status = 'cancelled', finished_at = datetime('now') WHERE id = $id AND status IN ('pending', 'running')"
    ).run({ $id: id });
    return r.changes > 0;
  }

  retryJob(id: number): boolean {
    const r = this.db.prepare(
      "UPDATE jobs SET status = 'pending', attempts = 0, error = NULL, started_at = NULL, finished_at = NULL WHERE id = $id AND status = 'failed'"
    ).run({ $id: id });
    return r.changes > 0;
  }

  // ─── Raw data operations ─────────────────────────────────────

  putRawData(pageSlug: string, key: string, data: Buffer, mimeType?: string): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO raw_data (page_slug, key, mime_type, data) VALUES ($slug, $key, $mime, $data)"
    ).run({ $slug: pageSlug, $key: key, $mime: mimeType ?? "application/octet-stream", $data: data });
  }

  getRawData(pageSlug: string, key: string): { mime_type: string; data: Buffer; created_at: string } | null {
    return this.db.prepare(
      "SELECT mime_type, data, created_at FROM raw_data WHERE page_slug = $slug AND key = $key"
    ).get({ $slug: pageSlug, $key: key }) as any ?? null;
  }

  listRawDataKeys(pageSlug: string): string[] {
    const rows = this.db.prepare(
      "SELECT key FROM raw_data WHERE page_slug = $slug ORDER BY key"
    ).all({ $slug: pageSlug }) as Array<{ key: string }>;
    return rows.map(r => r.key);
  }

  deleteRawData(pageSlug: string, key: string): boolean {
    const r = this.db.prepare(
      "DELETE FROM raw_data WHERE page_slug = $slug AND key = $key"
    ).run({ $slug: pageSlug, $key: key });
    return r.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
