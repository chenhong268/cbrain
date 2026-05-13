import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ─── Row types ──────────────────────────────────────────────

export interface PageRow {
  slug: string;
  type: string;
  title: string;
  file_path: string;
  content_hash: string | null;
  tier: number;
  mention_count: number;
  expires_at: string | null;
  confidence_decay: number;
  created_at: string;
  updated_at: string;
}

export interface LinkRow {
  id: number;
  from_slug: string;
  to_slug: string;
  relation: string;
  weight: number;
  strength: string;
  context: string | null;
  created_at: string;
}

export interface PersonCard {
  ask_for: string[];
  handles: Record<string, string>;
  relationships: Array<{ slug: string; relation: string }>;
  summary?: string;
}

export interface UpsertPageData {
  slug: string;
  type: string;
  title: string;
  filePath: string;
  contentHash: string;
  personCard?: PersonCard;
}

export interface InsightRow {
  id: number;
  content: string;
  type: string;
  confidence: number;
  source_entities: string | null;
  source_type: string;
  status: string;
  created_at: string;
  expires_at: string | null;
  seen: number;
}

export interface CreateInsightInput {
  content: string;
  type: "synthesis" | "pattern" | "anomaly" | "bridge";
  confidence?: number;
  sourceEntities?: string[];
  sourceType: "reflect" | "discovery" | "manual";
  expiresAt?: string | null;
}

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
        type TEXT NOT NULL CHECK(type IN ('entity', 'concept', 'record', 'insight')),
        title TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content_hash TEXT,
        tier INTEGER DEFAULT 3 CHECK(tier BETWEEN 1 AND 3),
        mention_count INTEGER DEFAULT 0,
        expires_at TEXT,
        confidence_decay REAL DEFAULT 1.0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_slug TEXT NOT NULL,
        to_slug TEXT NOT NULL,
        relation TEXT NOT NULL DEFAULT 'mentions',
        weight REAL DEFAULT 1.0,
        strength TEXT DEFAULT 'medium' CHECK(strength IN ('strong','medium','weak')),
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

      CREATE TABLE IF NOT EXISTS discoveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        entities TEXT NOT NULL,
        score REAL NOT NULL,
        detail TEXT,
        detected_at TEXT NOT NULL,
        dream_run TEXT,
        seen INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_name ON jobs(name);

      CREATE TABLE IF NOT EXISTS insights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('synthesis','pattern','anomaly','bridge')),
        confidence REAL DEFAULT 0.5,
        source_entities TEXT,
        source_type TEXT NOT NULL CHECK(source_type IN ('reflect','discovery','manual')),
        status TEXT DEFAULT 'active' CHECK(status IN ('active','archived','dismissed')),
        created_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT,
        seen INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_insights_type ON insights(type);
      CREATE INDEX IF NOT EXISTS idx_insights_status ON insights(status);
      CREATE INDEX IF NOT EXISTS idx_insights_source_type ON insights(source_type);

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(page_slug, content, tokenize='trigram');

      CREATE TABLE IF NOT EXISTS aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page_slug TEXT NOT NULL,
        alias TEXT NOT NULL,
        FOREIGN KEY (page_slug) REFERENCES pages(slug) ON DELETE CASCADE,
        UNIQUE(page_slug, alias)
      );

      CREATE INDEX IF NOT EXISTS idx_aliases_alias ON aliases(alias);
      CREATE INDEX IF NOT EXISTS idx_aliases_page ON aliases(page_slug);
    `);

    this.migratePagesConstraint();
    this.migratePagesExpiry();
    this.migrateLinksStrength();
    this.migrateDiscoveries();
    this.migrateSearchLog();
    this.migrateRawToRecords();
    this.migratePagesPersonCard();
  }

  private migrateLinksStrength(): void {
    const cols = this.db.prepare("PRAGMA table_info(links)").all() as Array<{ name: string }>;
    const names = new Set(cols.map(c => c.name));
    if (!names.has("weight")) {
      this.db.exec("ALTER TABLE links ADD COLUMN weight REAL DEFAULT 1.0");
    }
    if (!names.has("strength")) {
      this.db.exec("ALTER TABLE links ADD COLUMN strength TEXT DEFAULT 'medium'");
    }
  }

  private migrateDiscoveries(): void {
    const cols = this.db.prepare("PRAGMA table_info(discoveries)").all() as Array<{ name: string }>;
    const names = new Set(cols.map(c => c.name));
    if (!names.has("actionable")) {
      this.db.exec("ALTER TABLE discoveries ADD COLUMN actionable TEXT DEFAULT 'low'");
    }
    if (!names.has("suggestion")) {
      this.db.exec("ALTER TABLE discoveries ADD COLUMN suggestion TEXT");
    }
    if (!names.has("proposed_actions")) {
      this.db.exec("ALTER TABLE discoveries ADD COLUMN proposed_actions TEXT");
    }
    if (!names.has("auto_applicable")) {
      this.db.exec("ALTER TABLE discoveries ADD COLUMN auto_applicable INTEGER DEFAULT 0");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_discoveries_actionable ON discoveries(actionable)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_discoveries_score ON discoveries(score)");
  }

  private migratePagesExpiry(): void {
    const cols = this.db.prepare("PRAGMA table_info(pages)").all() as Array<{ name: string }>;
    const names = new Set(cols.map(c => c.name));
    if (!names.has("expires_at")) {
      this.db.exec("ALTER TABLE pages ADD COLUMN expires_at TEXT");
    }
    if (!names.has("confidence_decay")) {
      this.db.exec("ALTER TABLE pages ADD COLUMN confidence_decay REAL DEFAULT 1.0");
    }
  }

  private migratePagesPersonCard(): void {
    const cols = this.db.prepare("PRAGMA table_info(pages)").all() as Array<{ name: string }>;
    const names = new Set(cols.map(c => c.name));
    if (!names.has("person_card")) {
      this.db.exec("ALTER TABLE pages ADD COLUMN person_card TEXT");
    }
  }

  private migratePagesConstraint(): void {
    const check = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pages'").get() as { sql: string } | undefined;
    if (check?.sql?.includes("'insight'") && !check.sql.includes("'source'") && !check.sql.includes("'event'") && !check.sql.includes("'raw'")) return;

    this.db.exec("PRAGMA foreign_keys = OFF");

    // Convert legacy event and raw pages to record before migration
    this.db.prepare("UPDATE pages SET type = 'record' WHERE type = 'event'").run();
    this.db.prepare("UPDATE pages SET type = 'record' WHERE type = 'raw'").run();

    this.db.exec(`
      CREATE TABLE pages_new (
        slug TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('entity', 'concept', 'record', 'insight')),
        title TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content_hash TEXT,
        tier INTEGER DEFAULT 3 CHECK(tier BETWEEN 1 AND 3),
        mention_count INTEGER DEFAULT 0,
        expires_at TEXT,
        confidence_decay REAL DEFAULT 1.0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO pages_new SELECT slug, type, title, file_path, content_hash, tier, mention_count, expires_at, confidence_decay, created_at, updated_at FROM pages;
      DROP TABLE pages;
      ALTER TABLE pages_new RENAME TO pages;
    `);

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(type)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_pages_tier ON pages(tier)");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  /**
   * v5 migration: raw→record type merge + path unification.
   * - Converts raw/* slugs to records/*
   * - Converts brain/records/* slugs to records/*
   * - Updates links, chunks, tags, timeline, versions tables accordingly
   */
  private migrateRawToRecords(): void {
    // Check if migration already ran
    const done = this.db.prepare("SELECT value FROM config WHERE key = 'migration_v5_raw_to_records'").get() as { value: string } | undefined;
    if (done?.value === "1") return;

    this.db.exec("PRAGMA foreign_keys = OFF");

    // 1. Update raw/* slugs → records/* in pages
    this.db.prepare("UPDATE pages SET slug = REPLACE(slug, 'raw/', 'records/'), file_path = REPLACE(file_path, 'raw/', 'records/') WHERE slug LIKE 'raw/%'").run();

    // 2. Update brain/records/* slugs → records/* in pages
    this.db.prepare("UPDATE pages SET slug = REPLACE(slug, 'brain/records/', 'records/'), file_path = REPLACE(file_path, 'brain/records/', 'records/') WHERE slug LIKE 'brain/records/%'").run();

    // 3. Update links table (from_slug and to_slug)
    this.db.prepare("UPDATE links SET from_slug = REPLACE(from_slug, 'raw/', 'records/') WHERE from_slug LIKE 'raw/%'").run();
    this.db.prepare("UPDATE links SET to_slug = REPLACE(to_slug, 'raw/', 'records/') WHERE to_slug LIKE 'raw/%'").run();
    this.db.prepare("UPDATE links SET from_slug = REPLACE(from_slug, 'brain/records/', 'records/') WHERE from_slug LIKE 'brain/records/%'").run();
    this.db.prepare("UPDATE links SET to_slug = REPLACE(to_slug, 'brain/records/', 'records/') WHERE to_slug LIKE 'brain/records/%'").run();

    // 4. Update chunks table
    this.db.prepare("UPDATE chunks SET page_slug = REPLACE(page_slug, 'raw/', 'records/') WHERE page_slug LIKE 'raw/%'").run();
    this.db.prepare("UPDATE chunks SET page_slug = REPLACE(page_slug, 'brain/records/', 'records/') WHERE page_slug LIKE 'brain/records/%'").run();

    // 5. Update tags table
    this.db.prepare("UPDATE tags SET page_slug = REPLACE(page_slug, 'raw/', 'records/') WHERE page_slug LIKE 'raw/%'").run();
    this.db.prepare("UPDATE tags SET page_slug = REPLACE(page_slug, 'brain/records/', 'records/') WHERE page_slug LIKE 'brain/records/%'").run();

    // 6. Update timeline table
    this.db.prepare("UPDATE timeline SET page_slug = REPLACE(page_slug, 'raw/', 'records/') WHERE page_slug LIKE 'raw/%'").run();
    this.db.prepare("UPDATE timeline SET page_slug = REPLACE(page_slug, 'brain/records/', 'records/') WHERE page_slug LIKE 'brain/records/%'").run();

    // 7. Update versions table
    this.db.prepare("UPDATE versions SET page_slug = REPLACE(page_slug, 'raw/', 'records/') WHERE page_slug LIKE 'raw/%'").run();
    this.db.prepare("UPDATE versions SET page_slug = REPLACE(page_slug, 'brain/records/', 'records/') WHERE page_slug LIKE 'brain/records/%'").run();

    // 8. Update ingest_log table
    this.db.prepare("UPDATE ingest_log SET page_slug = REPLACE(page_slug, 'raw/', 'records/') WHERE page_slug LIKE 'raw/%'").run();
    this.db.prepare("UPDATE ingest_log SET page_slug = REPLACE(page_slug, 'brain/records/', 'records/') WHERE page_slug LIKE 'brain/records/%'").run();

    // 9. Mark migration as done
    this.db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('migration_v5_raw_to_records', '1')").run();

    this.db.exec("PRAGMA foreign_keys = ON");
  }

  private stmtCache = new Map<string, ReturnType<typeof this.db.prepare>>();

  private prepare(sql: string) {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  run(sql: string) {
    return this.db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ─── Tag operations ──────────────────────────────────────────

  getTags(pageSlug: string): string[] {
    const rows = this.prepare(
      "SELECT tag FROM tags WHERE page_slug = $slug ORDER BY tag"
    ).all({ $slug: pageSlug }) as Array<{ tag: string }>;
    return rows.map(r => r.tag);
  }

  addTag(pageSlug: string, tag: string): boolean {
    try {
      this.prepare(
        "INSERT OR IGNORE INTO tags (page_slug, tag) VALUES ($slug, $tag)"
      ).run({ $slug: pageSlug, $tag: tag });
      return true;
    } catch (e) {
      console.error(`[db] addTag 失败: ${pageSlug}/${tag}`, e);
      return false;
    }
  }

  removeTag(pageSlug: string, tag: string): boolean {
    const result = this.prepare(
      "DELETE FROM tags WHERE page_slug = $slug AND tag = $tag"
    ).run({ $slug: pageSlug, $tag: tag });
    return result.changes > 0;
  }

  // ─── Timeline operations ─────────────────────────────────────

  getTimeline(pageSlug: string): Array<{ id: number; event_date: string | null; source: string | null; summary: string; created_at: string }> {
    return this.prepare(
      "SELECT id, event_date, source, summary, created_at FROM timeline WHERE page_slug = $slug ORDER BY event_date DESC, id DESC"
    ).all({ $slug: pageSlug }) as any[];
  }

  addTimelineEntry(pageSlug: string, summary: string, eventDate?: string, source?: string): number {
    const result = this.prepare(
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
    return this.prepare(sql).all(params) as any[];
  }

  // ─── Chunk operations ────────────────────────────────────────

  getChunksByPage(pageSlug: string): Array<{ id: number; chunk_index: number; content: string; created_at: string }> {
    return this.prepare(
      "SELECT id, chunk_index, content, created_at FROM chunks WHERE page_slug = $slug ORDER BY chunk_index"
    ).all({ $slug: pageSlug }) as any[];
  }

  // ─── Ingest log ──────────────────────────────────────────────

  getIngestLog(limit: number = 50): Array<{ id: number; source_type: string; action: string; page_slug: string | null; details: string | null; created_at: string }> {
    return this.prepare(
      "SELECT id, source_type, action, page_slug, details, created_at FROM ingest_log ORDER BY id DESC LIMIT $limit"
    ).all({ $limit: limit }) as any[];
  }

  // ─── Config operations ───────────────────────────────────────

  getConfig(key: string): string | null {
    const row = this.prepare(
      "SELECT value FROM config WHERE key = $key"
    ).get({ $key: key }) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setConfig(key: string, value: string): void {
    this.prepare(
      "INSERT OR REPLACE INTO config (key, value) VALUES ($key, $value)"
    ).run({ $key: key, $value: value });
  }

  // ─── Slug resolution ─────────────────────────────────────────

  resolveSlugs(queries: string[]): Array<{ query: string; slug: string | null; title: string | null }> {
    return queries.map(query => {
      // Exact slug match
      const bySlug = this.prepare(
        "SELECT slug, title FROM pages WHERE slug = $q"
      ).get({ $q: query }) as { slug: string; title: string } | undefined;
      if (bySlug) return { query, slug: bySlug.slug, title: bySlug.title };

      // Exact title match
      const byTitle = this.prepare(
        "SELECT slug, title FROM pages WHERE title = $q"
      ).get({ $q: query }) as { slug: string; title: string } | undefined;
      if (byTitle) return { query, slug: byTitle.slug, title: byTitle.title };

      // Fuzzy title match (LIKE)
      const fuzzy = this.prepare(
        "SELECT slug, title FROM pages WHERE title LIKE $q LIMIT 1"
      ).get({ $q: `%${query}%` }) as { slug: string; title: string } | undefined;
      if (fuzzy) return { query, slug: fuzzy.slug, title: fuzzy.title };

      return { query, slug: null, title: null };
    });
  }

  // ─── Version operations ──────────────────────────────────────

  getVersionCount(pageSlug: string): number {
    const row = this.prepare(
      "SELECT COUNT(*) as cnt FROM versions WHERE page_slug = $slug"
    ).get({ $slug: pageSlug }) as { cnt: number };
    return row.cnt;
  }

  createVersion(pageSlug: string, content: string, frontmatter?: string): number {
    const nextVer = this.getVersionCount(pageSlug) + 1;
    this.prepare(
      "INSERT INTO versions (page_slug, version, content, frontmatter) VALUES ($slug, $ver, $content, $fm)"
    ).run({ $slug: pageSlug, $ver: nextVer, $content: content, $fm: frontmatter ?? null });
    return nextVer;
  }

  getVersions(pageSlug: string): Array<{ id: number; version: number; created_at: string }> {
    return this.prepare(
      "SELECT id, version, created_at FROM versions WHERE page_slug = $slug ORDER BY version DESC"
    ).all({ $slug: pageSlug }) as any[];
  }

  getVersion(pageSlug: string, version: number): { content: string; frontmatter: string | null; version: number; created_at: string } | null {
    return this.prepare(
      "SELECT content, frontmatter, version, created_at FROM versions WHERE page_slug = $slug AND version = $ver"
    ).get({ $slug: pageSlug, $ver: version }) as any ?? null;
  }

  ftsInsert(pageSlug: string, content: string): void {
    this.prepare(
      "INSERT INTO chunks_fts(page_slug, content) VALUES ($slug, $content)"
    ).run({ $slug: pageSlug, $content: content });
  }

  ftsDeleteByPage(pageSlug: string): void {
    this.prepare(
      "DELETE FROM chunks_fts WHERE page_slug = $slug"
    ).run({ $slug: pageSlug });
  }

  ftsSearch(query: string, limit: number = 10): Array<{ page_slug: string; content: string; rank: number }> {
    // Short queries (<3 chars) fall back to LIKE with TF-weighted rank.
    // rank = tf / (1 + tf): more occurrences → higher rank → higher score.
    if (query.length < 3) {
      const pattern = `%${query}%`;
      return this.prepare(`
        SELECT page_slug, content,
          CAST(tf AS REAL) / (1.0 + CAST(tf AS REAL)) AS rank
        FROM (
          SELECT page_slug, content,
            (LENGTH(content) - LENGTH(REPLACE(content, $query, ''))) * 1.0 / LENGTH($query) AS tf
          FROM chunks
          WHERE content LIKE $pattern
        )
        GROUP BY page_slug
        ORDER BY rank DESC
        LIMIT $limit
      `).all({ $query: query, $pattern: pattern, $limit: limit }) as Array<{ page_slug: string; content: string; rank: number }>;
    }
    const ftsQuery = this.buildTrigramQuery(query);
    return this.prepare(
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
    const result = this.prepare(
      "INSERT INTO jobs (name, data, priority) VALUES ($name, $data, $priority)"
    ).run({ $name: name, $data: data ? JSON.stringify(data) : null, $priority: priority });
    return Number(result.lastInsertRowid);
  }

  claimJob(): { id: number; name: string; data: string | null; attempts: number } | null {
    const row = this.prepare(
      "SELECT id, name, data, attempts FROM jobs WHERE status = 'pending' ORDER BY priority DESC, id ASC LIMIT 1"
    ).get() as { id: number; name: string; data: string | null; attempts: number } | undefined;
    if (!row) return null;

    this.prepare(
      "UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = datetime('now') WHERE id = $id"
    ).run({ $id: row.id });
    return row;
  }

  completeJob(id: number, result?: unknown): void {
    this.prepare(
      "UPDATE jobs SET status = 'done', result = $result, finished_at = datetime('now') WHERE id = $id"
    ).run({ $id: id, $result: result ? JSON.stringify(result) : null });
  }

  failJob(id: number, error: string): void {
    const job = this.prepare("SELECT attempts, max_attempts FROM jobs WHERE id = $id").get({ $id: id }) as { attempts: number; max_attempts: number } | undefined;
    const status = job && job.attempts >= job.max_attempts ? "failed" : "pending";
    this.prepare(
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
      return this.prepare(
        "SELECT id, name, status, priority, data, result, error, attempts, max_attempts, created_at, started_at, finished_at FROM jobs WHERE status = $status ORDER BY id DESC"
      ).all({ $status: status }) as any[];
    }
    return this.prepare(
      "SELECT id, name, status, priority, data, result, error, attempts, max_attempts, created_at, started_at, finished_at FROM jobs ORDER BY id DESC LIMIT 100"
    ).all() as any[];
  }

  getJob(id: number): {
    id: number; name: string; status: string; priority: number;
    data: string | null; result: string | null; error: string | null;
    attempts: number; max_attempts: number;
    created_at: string; started_at: string | null; finished_at: string | null;
  } | null {
    return this.prepare(
      "SELECT id, name, status, priority, data, result, error, attempts, max_attempts, created_at, started_at, finished_at FROM jobs WHERE id = $id"
    ).get({ $id: id }) as any ?? null;
  }

  cancelJob(id: number): boolean {
    const r = this.prepare(
      "UPDATE jobs SET status = 'cancelled', finished_at = datetime('now') WHERE id = $id AND status IN ('pending', 'running')"
    ).run({ $id: id });
    return r.changes > 0;
  }

  retryJob(id: number): boolean {
    const r = this.prepare(
      "UPDATE jobs SET status = 'pending', attempts = 0, error = NULL, started_at = NULL, finished_at = NULL WHERE id = $id AND status = 'failed'"
    ).run({ $id: id });
    return r.changes > 0;
  }

  // ─── Page operations ──────────────────────────────────────────

  getPage(slug: string): PageRow | null {
    return this.prepare(
      "SELECT * FROM pages WHERE slug = $slug"
    ).get({ $slug: slug }) as PageRow | null;
  }

  getPageByTitle(title: string): { slug: string; type: string; title: string } | null {
    return this.prepare(
      "SELECT slug, type, title FROM pages WHERE title = $title LIMIT 1"
    ).get({ $title: title }) as { slug: string; type: string; title: string } | null;
  }

  getPageByTitleExcluding(title: string, excludeSlug: string): { slug: string; type: string; title: string } | null {
    return this.prepare(
      "SELECT slug, type, title FROM pages WHERE title = $title AND slug != $slug LIMIT 1"
    ).get({ $title: title, $slug: excludeSlug }) as { slug: string; type: string; title: string } | null;
  }

  getPageTitle(slug: string): string | null {
    const row = this.prepare(
      "SELECT title FROM pages WHERE slug = $slug"
    ).get({ $slug: slug }) as { title: string } | undefined;
    return row?.title ?? null;
  }

  getPageTitleAndType(slug: string): { title: string; type: string } | null {
    return this.prepare(
      "SELECT title, type FROM pages WHERE slug = $slug"
    ).get({ $slug: slug }) as { title: string; type: string } | null;
  }

  getPageFilePath(slug: string): string | null {
    const row = this.prepare(
      "SELECT file_path FROM pages WHERE slug = $slug"
    ).get({ $slug: slug }) as { file_path: string } | undefined;
    return row?.file_path ?? null;
  }

  getPageContentHash(slug: string): string | null {
    const row = this.prepare(
      "SELECT content_hash FROM pages WHERE slug = $slug"
    ).get({ $slug: slug }) as { content_hash: string | null } | undefined;
    return row?.content_hash ?? null;
  }

  getPageTierAndMentions(slug: string): { tier: number; mention_count: number } | null {
    return this.prepare(
      "SELECT tier, mention_count FROM pages WHERE slug = $slug"
    ).get({ $slug: slug }) as { tier: number; mention_count: number } | null;
  }

  insertPage(data: { slug: string; type: string; title: string; filePath: string; contentHash: string; tier?: number; expiresAt?: string | null; confidenceDecay?: number }): void {
    this.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash, tier, expires_at, confidence_decay, created_at, updated_at) VALUES ($slug, $type, $title, $path, $hash, $tier, $expires, $decay, datetime('now'), datetime('now'))"
    ).run({
      $slug: data.slug,
      $type: data.type,
      $title: data.title,
      $path: data.filePath,
      $hash: data.contentHash,
      $tier: data.tier ?? 3,
      $expires: data.expiresAt ?? null,
      $decay: data.confidenceDecay ?? 1.0,
    });
  }

  upsertPage(data: UpsertPageData): void {
    this.prepare(`
      INSERT INTO pages (slug, type, title, file_path, content_hash, person_card, tier, created_at, updated_at)
      VALUES ($slug, $type, $title, $path, $hash, $card, 3, datetime('now'), datetime('now'))
      ON CONFLICT(slug) DO UPDATE SET
        type = excluded.type,
        title = excluded.title,
        content_hash = excluded.content_hash,
        person_card = excluded.person_card,
        updated_at = datetime('now')
    `).run({
      $slug: data.slug,
      $type: data.type,
      $title: data.title,
      $path: data.filePath,
      $hash: data.contentHash,
      $card: data.personCard ? JSON.stringify(data.personCard) : null,
    });
  }

  updatePageHash(slug: string, hash: string): void {
    this.prepare(
      "UPDATE pages SET content_hash = $hash, updated_at = datetime('now') WHERE slug = $slug"
    ).run({ $slug: slug, $hash: hash });
  }

  updatePageTier(slug: string, tier: number): void {
    this.prepare(
      "UPDATE pages SET tier = $tier, updated_at = datetime('now') WHERE slug = $slug"
    ).run({ $slug: slug, $tier: tier });
  }

  incrementMentionCount(slug: string): void {
    this.prepare(
      "UPDATE pages SET mention_count = mention_count + 1, updated_at = datetime('now') WHERE slug = $slug"
    ).run({ $slug: slug });
  }

  deletePage(slug: string): boolean {
    const r = this.prepare("DELETE FROM pages WHERE slug = $slug").run({ $slug: slug });
    return r.changes > 0;
  }

  deletePageCascaded(slug: string): void {
    this.prepare("DELETE FROM links WHERE from_slug = $slug OR to_slug = $slug").run({ $slug: slug });
    this.prepare("DELETE FROM tags WHERE page_slug = $slug").run({ $slug: slug });
    this.prepare("DELETE FROM timeline WHERE page_slug = $slug").run({ $slug: slug });
    this.prepare("DELETE FROM chunks WHERE page_slug = $slug").run({ $slug: slug });
    this.prepare("DELETE FROM chunks_fts WHERE page_slug = $slug").run({ $slug: slug });
    this.prepare("DELETE FROM ingest_log WHERE page_slug = $slug").run({ $slug: slug });
    this.prepare("DELETE FROM pages WHERE slug = $slug").run({ $slug: slug });
  }

  getPersonCard(slug: string): PersonCard | null {
    const row = this.prepare(
      "SELECT person_card FROM pages WHERE slug = $slug"
    ).get({ $slug: slug }) as { person_card: string | null } | undefined;
    if (!row?.person_card) return null;
    try {
      return JSON.parse(row.person_card) as PersonCard;
    } catch {
      return null;
    }
  }

  updatePersonCard(slug: string, card: PersonCard): boolean {
    const r = this.prepare(
      "UPDATE pages SET person_card = $card, updated_at = datetime('now') WHERE slug = $slug"
    ).run({ $slug: slug, $card: JSON.stringify(card) });
    return r.changes > 0;
  }

  getAllPersonCards(): Array<{ slug: string; person_card: PersonCard }> {
    const rows = this.prepare(
      "SELECT slug, person_card FROM pages WHERE person_card IS NOT NULL"
    ).all() as Array<{ slug: string; person_card: string }>;
    return rows
      .map(r => {
        try {
          return { slug: r.slug, person_card: JSON.parse(r.person_card) as PersonCard };
        } catch {
          return null;
        }
      })
      .filter((r): r is { slug: string; person_card: PersonCard } => r !== null);
  }

  rewireLinks(oldSlug: string, newSlug: string): void {
    // Delete self-referencing duplicates before rewiring to avoid UNIQUE violation
    this.prepare(`
      DELETE FROM links WHERE rowid NOT IN (
        SELECT MIN(rowid) FROM links GROUP BY from_slug, to_slug, relation
      ) AND (from_slug = $old OR to_slug = $old)
    `).run({ $old: oldSlug });
    this.prepare("UPDATE links SET from_slug = $new WHERE from_slug = $old").run({ $old: oldSlug, $new: newSlug });
    this.prepare("UPDATE links SET to_slug = $new WHERE to_slug = $old").run({ $old: oldSlug, $new: newSlug });
  }

  // ─── Page list/query operations ──────────────────────────────

  listPages(opts?: { type?: string; types?: string[]; limit?: number; offset?: number; orderBy?: string }): PageRow[] {
    let sql = "SELECT * FROM pages WHERE 1=1";
    const params: Record<string, string | number> = {};
    if (opts?.type) {
      sql += " AND type = $type";
      params.$type = opts.type;
    }
    if (opts?.types && opts.types.length > 0) {
      const placeholders = opts.types.map((_, i) => `$t${i}`).join(",");
      opts.types.forEach((t, i) => { params[`$t${i}`] = t; });
      sql += ` AND type IN (${placeholders})`;
    }
    sql += ` ORDER BY ${opts?.orderBy ?? "title ASC"}`;
    if (opts?.limit !== undefined) {
      sql += " LIMIT $limit";
      params.$limit = opts.limit;
    }
    if (opts?.offset !== undefined) {
      sql += " OFFSET $offset";
      params.$offset = opts.offset;
    }
    return this.prepare(sql).all(params) as PageRow[];
  }

  listPageSlugs(opts?: { type?: string; limit?: number; offset?: number; orderBy?: string }): string[] {
    let sql = "SELECT slug FROM pages WHERE 1=1";
    const params: Record<string, string | number> = {};
    if (opts?.type) {
      sql += " AND type = $type";
      params.$type = opts.type;
    }
    sql += ` ORDER BY ${opts?.orderBy ?? "slug ASC"}`;
    if (opts?.limit !== undefined) {
      sql += " LIMIT $limit";
      params.$limit = opts.limit;
    }
    if (opts?.offset !== undefined) {
      sql += " OFFSET $offset";
      params.$offset = opts.offset;
    }
    const rows = this.prepare(sql).all(params) as Array<{ slug: string }>;
    return rows.map(r => r.slug);
  }

  getPageCount(): number {
    const row = this.prepare("SELECT COUNT(*) as cnt FROM pages").get() as { cnt: number };
    return row.cnt;
  }

  getPageCountByType(type: string): number {
    const row = this.prepare(
      "SELECT COUNT(*) as cnt FROM pages WHERE type = $type"
    ).get({ $type: type }) as { cnt: number };
    return row.cnt;
  }

  getPageCountByTypes(types: string[]): number {
    if (types.length === 0) return 0;
    const placeholders = types.map((_, i) => `$t${i}`).join(",");
    const params: Record<string, string> = {};
    types.forEach((t, i) => { params[`$t${i}`] = t; });
    const row = this.prepare(
      `SELECT COUNT(*) as cnt FROM pages WHERE type IN (${placeholders})`
    ).get(params) as { cnt: number };
    return row.cnt;
  }

  getPageTypeCounts(): Array<{ type: string; cnt: number }> {
    return this.prepare(
      "SELECT type, COUNT(*) as cnt FROM pages GROUP BY type ORDER BY cnt DESC"
    ).all() as Array<{ type: string; cnt: number }>;
  }

  getEntities(): Array<{ slug: string; title: string }> {
    return this.prepare(
      "SELECT slug, title FROM pages WHERE type = 'entity' ORDER BY slug"
    ).all() as Array<{ slug: string; title: string }>;
  }

  getEntityConceptPages(): Array<{ slug: string; title: string; type: string }> {
    return this.prepare(
      "SELECT slug, title, type FROM pages WHERE type IN ('entity', 'concept') ORDER BY title"
    ).all() as Array<{ slug: string; title: string; type: string }>;
  }

  getAutoExtractedPages(): Array<{ slug: string; title: string; file_path: string }> {
    return this.prepare(
      "SELECT slug, title, file_path FROM pages WHERE slug IN (SELECT page_slug FROM tags WHERE tag = 'auto-extracted')"
    ).all() as Array<{ slug: string; title: string; file_path: string }>;
  }

  getAllPageSlugsWithPaths(): Array<{ slug: string; file_path: string }> {
    return this.prepare(
      "SELECT slug, file_path FROM pages"
    ).all() as Array<{ slug: string; file_path: string }>;
  }

  getPagesBySlugs(slugs: string[]): PageRow[] {
    if (slugs.length === 0) return [];
    const placeholders = slugs.map((_, i) => `$s${i}`).join(",");
    const params: Record<string, string> = {};
    slugs.forEach((s, i) => { params[`$s${i}`] = s; });
    return this.prepare(
      `SELECT * FROM pages WHERE slug IN (${placeholders})`
    ).all(params) as PageRow[];
  }

  getPagesBySlugsOrdered(slugs: string[]): Array<{ slug: string }> {
    if (slugs.length === 0) return [];
    const placeholders = slugs.map((_, i) => `$s${i}`).join(",");
    const params: Record<string, string> = {};
    slugs.forEach((s, i) => { params[`$s${i}`] = s; });
    return this.prepare(
      `SELECT slug FROM pages WHERE slug IN (${placeholders}) ORDER BY mention_count DESC`
    ).all(params) as Array<{ slug: string }>;
  }

  getPagesWithoutChunks(): Array<{ slug: string; title: string; type: string }> {
    return this.prepare(
      "SELECT p.slug, p.title, p.type FROM pages p LEFT JOIN chunks c ON p.slug = c.page_slug WHERE c.id IS NULL AND p.type = 'record'"
    ).all() as Array<{ slug: string; title: string; type: string }>;
  }

  getPagesWithMissingTitle(): Array<{ slug: string; title: string }> {
    return this.prepare(
      "SELECT slug, title FROM pages WHERE title IS NULL OR title = '' OR title = slug"
    ).all() as Array<{ slug: string; title: string }>;
  }

  getPagesWithEmptyType(): Array<{ slug: string; title: string }> {
    return this.prepare(
      "SELECT slug, title FROM pages WHERE type IS NULL OR type = ''"
    ).all() as Array<{ slug: string; title: string }>;
  }

  getBareStubs(): Array<{ slug: string; title: string; type: string }> {
    return this.prepare(
      "SELECT p.slug, p.title, p.type FROM pages p WHERE p.type IN ('entity', 'concept') AND p.mention_count <= 1 AND (SELECT COUNT(*) FROM links l WHERE l.from_slug = p.slug OR l.to_slug = p.slug) <= 1"
    ).all() as Array<{ slug: string; title: string; type: string }>;
  }

  getIslandPages(): Array<{ slug: string; title: string; type: string }> {
    return this.prepare(
      "SELECT p.slug, p.title, p.type FROM pages p WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.from_slug = p.slug) AND NOT EXISTS (SELECT 1 FROM links l WHERE l.to_slug = p.slug) AND p.type IN ('entity', 'concept')"
    ).all() as Array<{ slug: string; title: string; type: string }>;
  }

  getStaleHighValuePages(days: number = 30): Array<{ slug: string; title: string; type: string; updated_at: string }> {
    return this.prepare(
      "SELECT slug, title, type, updated_at FROM pages WHERE tier <= 2 AND updated_at < datetime('now', '-' || $days || ' days') ORDER BY updated_at ASC"
    ).all({ $days: days }) as Array<{ slug: string; title: string; type: string; updated_at: string }>;
  }

  getPopularThinPages(threshold: number = 3): Array<{ slug: string; title: string; mention_count: number; type: string }> {
    return this.prepare(
      "SELECT slug, title, mention_count, type FROM pages WHERE mention_count >= $threshold AND type IN ('entity', 'concept') AND (SELECT COUNT(*) FROM chunks WHERE page_slug = pages.slug) <= 1 ORDER BY mention_count DESC"
    ).all({ $threshold: threshold }) as Array<{ slug: string; title: string; mention_count: number; type: string }>;
  }

  getPagesWithLinkCount(types: string[], orderBy?: string): Array<{ slug: string; title: string; type: string; link_count: number }> {
    const placeholders = types.map((_, i) => `$t${i}`).join(",");
    const params: Record<string, string> = {};
    types.forEach((t, i) => { params[`$t${i}`] = t; });
    const order = orderBy ?? "title ASC";
    return this.prepare(
      `SELECT p.slug, p.title, p.type, (SELECT COUNT(*) FROM links WHERE from_slug = p.slug OR to_slug = p.slug) as link_count FROM pages p WHERE p.type IN (${placeholders}) ORDER BY ${order}`
    ).all(params) as Array<{ slug: string; title: string; type: string; link_count: number }>;
  }

  getAvgMentionCount(): number {
    const row = this.prepare("SELECT AVG(mention_count) as avg FROM pages").get() as { avg: number | null };
    return row.avg ?? 0;
  }

  getRecentUpdatedPages(days: number = 7, limit: number = 10): PageRow[] {
    return this.prepare(
      "SELECT * FROM pages WHERE updated_at >= datetime('now', $days) ORDER BY updated_at DESC LIMIT $limit"
    ).all({ $days: `-${days} days`, $limit: limit }) as PageRow[];
  }

  getEntityConceptPagesUpdatedSince(since: string): Array<{ slug: string; title: string; type: string }> {
    return this.prepare(
      "SELECT slug, title, type FROM pages WHERE updated_at > $since AND type IN ('entity', 'concept') ORDER BY updated_at DESC"
    ).all({ $since: since }) as Array<{ slug: string; title: string; type: string }>;
  }

  getTopMentionedEntities(limit: number = 10): PageRow[] {
    return this.prepare(
      "SELECT * FROM pages WHERE type = 'entity' ORDER BY mention_count DESC LIMIT $limit"
    ).all({ $limit: limit }) as PageRow[];
  }

  getHighMentionEntities(minMentions: number): Array<{ slug: string; title: string; mention_count: number }> {
    return this.prepare(
      "SELECT slug, title, mention_count FROM pages WHERE type = 'entity' AND mention_count >= $min ORDER BY mention_count DESC"
    ).all({ $min: minMentions }) as Array<{ slug: string; title: string; mention_count: number }>;
  }

  getHighConnectivityEntities(minNeighbors: number): Array<{ slug: string; title: string }> {
    return this.prepare(
      `SELECT p.slug, p.title FROM pages p
       WHERE p.type = 'entity'
       AND (
         (SELECT COUNT(DISTINCT to_slug) FROM links WHERE from_slug = p.slug) +
         (SELECT COUNT(DISTINCT from_slug) FROM links WHERE to_slug = p.slug)
       ) >= $min
       ORDER BY p.mention_count DESC`
    ).all({ $min: minNeighbors }) as Array<{ slug: string; title: string }>;
  }

  // ─── Brief & Cross-ref queries ────────────────────────────────

  countNewPagesSince(hours: number): { entities: number; concepts: number } {
    const entities = (this.prepare(
      "SELECT COUNT(*) as c FROM pages WHERE type = 'entity' AND created_at > datetime('now', '-' || $h || ' hours')"
    ).get({ $h: hours }) as { c: number }).c;
    const concepts = (this.prepare(
      "SELECT COUNT(*) as c FROM pages WHERE type = 'concept' AND created_at > datetime('now', '-' || $h || ' hours')"
    ).get({ $h: hours }) as { c: number }).c;
    return { entities, concepts };
  }

  getRecentUpdatesBySlugs(slugs: string[], days: number): Array<{ slug: string; title: string; type: string; updated_at: string }> {
    if (slugs.length === 0) return [];
    const placeholders = slugs.map(() => "?").join(",");
    return this.prepare(
      `SELECT slug, title, type, updated_at FROM pages
       WHERE slug IN (${placeholders})
       AND updated_at > datetime('now', '-${days} days')
       ORDER BY updated_at DESC
       LIMIT 10`
    ).all(...slugs) as Array<{ slug: string; title: string; type: string; updated_at: string }>;
  }

  getExpiredPages(now: string): Array<{ slug: string; title: string; expires_at: string }> {
    return this.prepare(
      "SELECT slug, title, expires_at FROM pages WHERE expires_at IS NOT NULL AND expires_at < $now"
    ).all({ $now: now }) as Array<{ slug: string; title: string; expires_at: string }>;
  }

  getLowConfidenceDecayPages(threshold: number): Array<{ slug: string; title: string; confidence_decay: number }> {
    return this.prepare(
      "SELECT slug, title, confidence_decay FROM pages WHERE confidence_decay < $t"
    ).all({ $t: threshold }) as Array<{ slug: string; title: string; confidence_decay: number }>;
  }

  cleanDanglingLinks(): number {
    const r = this.prepare(
      "DELETE FROM links WHERE from_slug NOT IN (SELECT slug FROM pages) OR to_slug NOT IN (SELECT slug FROM pages)"
    ).run();
    return r.changes;
  }

  getLinksContextForSlugs(slugs: string[]): string[] {
    if (slugs.length === 0) return [];
    const placeholders = slugs.map(() => "?").join(",");
    const rows = this.prepare(
      `SELECT DISTINCT context FROM links WHERE context IS NOT NULL AND context != ''
         AND (from_slug IN (${placeholders}) OR to_slug IN (${placeholders}))`
    ).all(...slugs) as Array<{ context: string }>;
    return rows.map(r => r.context);
  }

  // ─── Link operations ──────────────────────────────────────────

  insertLink(from: string, to: string, relation: string, context?: string | null, weight?: number, strength?: string): void {
    this.prepare(
      "INSERT OR IGNORE INTO links (from_slug, to_slug, relation, context, weight, strength) VALUES ($from, $to, $rel, $ctx, $w, $s)"
    ).run({ $from: from, $to: to, $rel: relation, $ctx: context ?? null, $w: weight ?? 1.0, $s: strength ?? 'medium' });
  }

  deleteLink(from: string, to: string, relation: string): boolean {
    const r = this.prepare(
      "DELETE FROM links WHERE from_slug = $from AND to_slug = $to AND relation = $rel"
    ).run({ $from: from, $to: to, $rel: relation });
    return r.changes > 0;
  }

  deleteLinksBySlug(slug: string): void {
    this.prepare(
      "DELETE FROM links WHERE from_slug = $slug OR to_slug = $slug"
    ).run({ $slug: slug });
  }

  deleteLinksByRelation(slug: string, relation: string): void {
    this.prepare(
      "DELETE FROM links WHERE from_slug = $slug AND relation = $rel"
    ).run({ $slug: slug, $rel: relation });
  }

  getOutgoingLinks(slug: string): LinkRow[] {
    return this.prepare(
      "SELECT id, from_slug, to_slug, relation, weight, strength, context, created_at FROM links WHERE from_slug = $slug"
    ).all({ $slug: slug }) as LinkRow[];
  }

  getIncomingLinks(slug: string): LinkRow[] {
    return this.prepare(
      "SELECT id, from_slug, to_slug, relation, weight, strength, context, created_at FROM links WHERE to_slug = $slug"
    ).all({ $slug: slug }) as LinkRow[];
  }

  getOutgoingSlugs(slug: string): string[] {
    const rows = this.prepare(
      "SELECT to_slug FROM links WHERE from_slug = $slug"
    ).all({ $slug: slug }) as Array<{ to_slug: string }>;
    return rows.map(r => r.to_slug);
  }

  getIncomingSlugs(slug: string): string[] {
    const rows = this.prepare(
      "SELECT from_slug FROM links WHERE to_slug = $slug"
    ).all({ $slug: slug }) as Array<{ from_slug: string }>;
    return rows.map(r => r.from_slug);
  }

  getLinkedSlugs(slug: string, direction: "from" | "to", relation?: string): string[] {
    const col = direction === "from" ? "to_slug" : "from_slug";
    const where = direction === "from" ? "from_slug" : "to_slug";
    let sql = `SELECT ${col} as slug FROM links WHERE ${where} = $slug`;
    const params: Record<string, string> = { $slug: slug };
    if (relation) {
      sql += " AND relation = $rel";
      params.$rel = relation;
    }
    const rows = this.prepare(sql).all(params) as Array<{ slug: string }>;
    return rows.map(r => r.slug);
  }

  getAllLinks(): Array<{ from_slug: string; to_slug: string; relation: string; weight: number }> {
    return this.prepare(
      "SELECT from_slug, to_slug, relation, weight FROM links"
    ).all() as Array<{ from_slug: string; to_slug: string; relation: string; weight: number }>;
  }

  getLinkCount(): number {
    const row = this.prepare("SELECT COUNT(*) as cnt FROM links").get() as { cnt: number };
    return row.cnt;
  }

  getLinkCountBySlug(slug: string): number {
    const row = this.prepare(
      "SELECT COUNT(*) as cnt FROM links WHERE from_slug = $slug OR to_slug = $slug"
    ).get({ $slug: slug }) as { cnt: number };
    return row.cnt;
  }

  linkExists(from: string, to: string, relation: string): boolean {
    const row = this.prepare(
      "SELECT 1 FROM links WHERE from_slug = $from AND to_slug = $to AND relation = $rel"
    ).get({ $from: from, $to: to, $rel: relation });
    return row != null;
  }

  // ─── Chunk write operations ──────────────────────────────────

  deleteChunksByPage(slug: string): void {
    this.prepare("DELETE FROM chunks WHERE page_slug = $slug").run({ $slug: slug });
  }

  insertChunk(slug: string, index: number, content: string): void {
    this.prepare(
      "INSERT INTO chunks (page_slug, chunk_index, content) VALUES ($slug, $idx, $content)"
    ).run({ $slug: slug, $idx: index, $content: content });
  }

  getChunkCount(): number {
    const row = this.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as { cnt: number };
    return row.cnt;
  }

  getChunkCountByPage(slug: string): number {
    const row = this.prepare(
      "SELECT COUNT(*) as cnt FROM chunks WHERE page_slug = $slug"
    ).get({ $slug: slug }) as { cnt: number };
    return row.cnt;
  }

  // ─── Ingest log write ──────────────────────────────────────

  addIngestLog(sourceType: string, action: string, slug?: string | null, details?: string | null): void {
    this.prepare(
      "INSERT INTO ingest_log (source_type, action, page_slug, details) VALUES ($src, $action, $slug, $details)"
    ).run({ $src: sourceType, $action: action, $slug: slug ?? null, $details: details ?? null });
  }

  getRecentNerErrorCount(): number {
    const row = this.prepare(
      "SELECT COUNT(*) as cnt FROM ingest_log WHERE details LIKE '%nerError%' AND created_at > datetime('now', '-24 hours')"
    ).get() as { cnt: number };
    return row.cnt;
  }

  // ─── Timeline write operations ──────────────────────────────

  deleteTimelineByPage(slug: string): void {
    this.prepare("DELETE FROM timeline WHERE page_slug = $slug").run({ $slug: slug });
  }

  getTimelineCountByPage(slug: string): number {
    const row = this.prepare(
      "SELECT COUNT(*) as cnt FROM timeline WHERE page_slug = $slug"
    ).get({ $slug: slug }) as { cnt: number };
    return row.cnt;
  }

  rewireTimeline(oldSlug: string, newSlug: string): void {
    this.prepare(
      "UPDATE timeline SET page_slug = $new WHERE page_slug = $old"
    ).run({ $old: oldSlug, $new: newSlug });
  }

  // ─── Tag bulk operations ─────────────────────────────────────

  deleteTagsByPage(slug: string): void {
    this.prepare("DELETE FROM tags WHERE page_slug = $slug").run({ $slug: slug });
  }

  addTags(slug: string, tags: string[]): void {
    const stmt = this.prepare("INSERT OR IGNORE INTO tags (page_slug, tag) VALUES ($slug, $tag)");
    for (const tag of tags) {
      stmt.run({ $slug: slug, $tag: tag });
    }
  }

  // ─── Config operations ───────────────────────────────────────

  getAllConfig(): Array<{ key: string; value: string }> {
    return this.prepare("SELECT key, value FROM config ORDER BY key").all() as Array<{ key: string; value: string }>;
  }

  deleteConfig(key: string): void {
    this.prepare("DELETE FROM config WHERE key = $key").run({ $key: key });
  }

  // ─── Entity lookup ─────────────────────────────────────────────

  getEntitySlugByTitle(name: string): string | null {
    const row = this.prepare(
      "SELECT slug FROM pages WHERE title = $name AND type IN ('entity', 'concept')"
    ).get({ $name: name }) as { slug: string } | null;
    return row?.slug ?? null;
  }

  addAlias(pageSlug: string, alias: string): void {
    this.prepare(
      "INSERT OR IGNORE INTO aliases (page_slug, alias) VALUES ($slug, $alias)"
    ).run({ $slug: pageSlug, $alias: alias });
  }

  removeAlias(pageSlug: string, alias: string): void {
    this.prepare(
      "DELETE FROM aliases WHERE page_slug = $slug AND alias = $alias"
    ).run({ $slug: pageSlug, $alias: alias });
  }

  getSlugByAlias(alias: string): string | null {
    const row = this.prepare(
      "SELECT page_slug FROM aliases WHERE alias = $alias"
    ).get({ $alias: alias }) as { page_slug: string } | null;
    return row?.page_slug ?? null;
  }

  listAliases(pageSlug: string): string[] {
    const rows = this.prepare(
      "SELECT alias FROM aliases WHERE page_slug = $slug ORDER BY id"
    ).all({ $slug: pageSlug }) as Array<{ alias: string }>;
    return rows.map(r => r.alias);
  }

  // ─── Discoveries ──────────────────────────────────────────────

  addDiscovery(type: string, entities: string[], score: number, detail?: Record<string, unknown>, dreamRun?: string, actionable?: string, autoApplicable?: boolean): number {
    const r = this.prepare(
      "INSERT INTO discoveries (type, entities, score, detail, detected_at, dream_run, actionable, auto_applicable) VALUES ($type, $entities, $score, $detail, datetime('now'), $run, $actionable, $auto)"
    ).run({
      $type: type,
      $entities: JSON.stringify(entities),
      $score: score,
      $detail: detail ? JSON.stringify(detail) : null,
      $run: dreamRun ?? null,
      $actionable: actionable ?? "low",
      $auto: autoApplicable ? 1 : 0,
    });
    return Number(r.lastInsertRowid);
  }

  getUnseenDiscoveries(limit: number = 10): Array<{ id: number; type: string; entities: string; score: number; detail: string | null; detected_at: string; dream_run: string | null; actionable: string; suggestion: string | null; proposed_actions: string | null; auto_applicable: number }> {
    return this.prepare(
      "SELECT id, type, entities, score, detail, detected_at, dream_run, actionable, suggestion, proposed_actions, auto_applicable FROM discoveries WHERE seen = 0 ORDER BY score DESC, id DESC LIMIT $limit"
    ).all({ $limit: limit }) as any[];
  }

  markDiscoverySeen(id: number): void {
    this.prepare("UPDATE discoveries SET seen = 1 WHERE id = $id").run({ $id: id });
  }

  cleanupOldDiscoveries(days: number = 90): number {
    const r = this.prepare(
      "DELETE FROM discoveries WHERE seen = 0 AND detected_at < datetime('now', '-' || $days || ' days')"
    ).run({ $days: days });
    return r.changes;
  }

  updateDiscoverySuggestion(id: number, suggestion: string): void {
    this.prepare("UPDATE discoveries SET suggestion = $suggestion WHERE id = $id").run({ $id: id, $suggestion: suggestion });
  }

  updateDiscoveryActions(id: number, actions: { type: string; target: string; reason: string }[]): void {
    this.prepare("UPDATE discoveries SET proposed_actions = $actions WHERE id = $id").run({ $id: id, $actions: JSON.stringify(actions) });
  }

  getDiscoveriesByActionable(actionable: string, limit: number = 20): Array<{ id: number; type: string; entities: string; score: number; detail: string | null; detected_at: string; actionable: string; suggestion: string | null; proposed_actions: string | null; auto_applicable: number }> {
    return this.prepare(
      "SELECT id, type, entities, score, detail, detected_at, actionable, suggestion, proposed_actions, auto_applicable FROM discoveries WHERE actionable = $actionable AND seen = 0 ORDER BY score DESC LIMIT $limit"
    ).all({ $actionable: actionable, $limit: limit }) as any[];
  }

  countDiscoveriesByActionable(): Record<string, number> {
    const rows = this.prepare(
      "SELECT actionable, COUNT(*) as cnt FROM discoveries WHERE seen = 0 GROUP BY actionable"
    ).all() as Array<{ actionable: string; cnt: number }>;
    const result: Record<string, number> = { high: 0, medium: 0, low: 0 };
    for (const row of rows) result[row.actionable] = row.cnt;
    return result;
  }

  // ─── Insights ──────────────────────────────────────────────────

  createInsight(data: CreateInsightInput): number {
    const r = this.prepare(
      "INSERT INTO insights (content, type, confidence, source_entities, source_type, expires_at) VALUES ($content, $type, $confidence, $entities, $sourceType, $expiresAt)"
    ).run({
      $content: data.content,
      $type: data.type,
      $confidence: data.confidence ?? 0.5,
      $entities: data.sourceEntities ? JSON.stringify(data.sourceEntities) : null,
      $sourceType: data.sourceType,
      $expiresAt: data.expiresAt ?? null,
    });
    return Number(r.lastInsertRowid);
  }

  getInsight(id: number): InsightRow | null {
    return this.prepare(
      "SELECT * FROM insights WHERE id = $id"
    ).get({ $id: id }) as InsightRow | null;
  }

  listInsights(opts?: { type?: string; status?: string; sourceType?: string; limit?: number; offset?: number }): InsightRow[] {
    let sql = "SELECT * FROM insights WHERE 1=1";
    const params: Record<string, string | number> = {};
    if (opts?.type) {
      sql += " AND type = $type";
      params.$type = opts.type;
    }
    if (opts?.status) {
      sql += " AND status = $status";
      params.$status = opts.status;
    } else {
      sql += " AND status = 'active'";
    }
    if (opts?.sourceType) {
      sql += " AND source_type = $sourceType";
      params.$sourceType = opts.sourceType;
    }
    sql += " ORDER BY created_at DESC";
    if (opts?.limit !== undefined) {
      sql += " LIMIT $limit";
      params.$limit = opts.limit;
    }
    if (opts?.offset !== undefined) {
      sql += " OFFSET $offset";
      params.$offset = opts.offset;
    }
    return this.prepare(sql).all(params) as InsightRow[];
  }

  getInsightsBySourceEntities(slugs: string[], limit: number = 10): InsightRow[] {
    if (slugs.length === 0) return [];
    const conditions = slugs.map((_, i) => `source_entities LIKE $s${i}`).join(" OR ");
    const params: Record<string, string | number> = { $limit: limit };
    slugs.forEach((s, i) => { params[`$s${i}`] = `%"${s}"%`; });
    return this.prepare(
      `SELECT * FROM insights WHERE status = 'active' AND (${conditions}) ORDER BY created_at DESC LIMIT $limit`
    ).all(params) as InsightRow[];
  }

  updateInsightStatus(id: number, status: "active" | "archived" | "dismissed"): boolean {
    const r = this.prepare(
      "UPDATE insights SET status = $status WHERE id = $id"
    ).run({ $id: id, $status: status });
    return r.changes > 0;
  }

  markInsightSeen(id: number): void {
    this.prepare("UPDATE insights SET seen = 1 WHERE id = $id").run({ $id: id });
  }

  countInsights(status?: string): number {
    if (status) {
      const row = this.prepare(
        "SELECT COUNT(*) as cnt FROM insights WHERE status = $status"
      ).get({ $status: status }) as { cnt: number };
      return row.cnt;
    }
    const row = this.prepare("SELECT COUNT(*) as cnt FROM insights").get() as { cnt: number };
    return row.cnt;
  }

  archiveExpiredInsights(): number {
    const r = this.prepare(
      "UPDATE insights SET status = 'archived' WHERE expires_at IS NOT NULL AND expires_at < datetime('now') AND status = 'active'"
    ).run();
    return r.changes;
  }

  getDiscoveryById(id: number): { id: number; type: string; entities: string; score: number; detail: string | null; detected_at: string; actionable: string; suggestion: string | null; proposed_actions: string | null; auto_applicable: number } | null {
    return this.prepare(
      "SELECT id, type, entities, score, detail, detected_at, actionable, suggestion, proposed_actions, auto_applicable FROM discoveries WHERE id = $id"
    ).get({ $id: id }) as any ?? null;
  }

  private migrateSearchLog(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT NOT NULL,
        strategy TEXT NOT NULL,
        latency_ms INTEGER NOT NULL,
        hit_count INTEGER NOT NULL,
        degraded INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_search_log_created ON search_log(created_at)");
  }

  logSearch(query: string, strategy: string, latencyMs: number, hitCount: number, degraded: boolean): void {
    this.prepare(
      "INSERT INTO search_log (query, strategy, latency_ms, hit_count, degraded) VALUES ($query, $strategy, $latency, $hits, $degraded)"
    ).run({ $query: query, $strategy: strategy, $latency: latencyMs, $hits: hitCount, $degraded: degraded ? 1 : 0 });
  }

  getSearchLog(limit: number = 50): Array<{ id: number; query: string; strategy: string; latency_ms: number; hit_count: number; degraded: number; created_at: string }> {
    return this.prepare(
      "SELECT id, query, strategy, latency_ms, hit_count, degraded, created_at FROM search_log ORDER BY id DESC LIMIT $limit"
    ).all({ $limit: limit }) as Array<{ id: number; query: string; strategy: string; latency_ms: number; hit_count: number; degraded: number; created_at: string }>;
  }

  close(): void {
    this.db.close();
  }
}
