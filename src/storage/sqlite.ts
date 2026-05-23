import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { REVERSE_RELATIONS } from "../core/shared.js";

const ALLOWED_ORDER_COLUMNS = new Set([
  "slug", "title", "type", "created_at", "updated_at", "mention_count", "tier",
]);
const ALLOWED_DIRECTIONS = new Set(["ASC", "DESC"]);

function sanitizeOrderBy(input: string | undefined, fallback: string): string {
  if (!input) return fallback;
  const parts = input.trim().split(/\s+/);
  if (parts.length < 1 || parts.length > 2) return fallback;
  if (!ALLOWED_ORDER_COLUMNS.has(parts[0])) return fallback;
  if (parts.length === 2 && !ALLOWED_DIRECTIONS.has(parts[1].toUpperCase())) return fallback;
  return `${parts[0]} ${parts.length === 2 ? parts[1].toUpperCase() : "ASC"}`;
}

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
  hotness_score: number;
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
  source_type: string;
  confidence: number;
  created_at: string;
}

export interface UpsertPageData {
  slug: string;
  type: string;
  title: string;
  filePath: string;
  contentHash: string;
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
    this.db.exec("PRAGMA cache_size = -64000");
    this.db.exec("PRAGMA mmap_size = 268435456");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pages (
        slug TEXT PRIMARY KEY,
        type TEXT NOT NULL,
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
        seen INTEGER NOT NULL DEFAULT 0
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
    this.migrateLinksCredibility();
    this.migrateDiscoveries();
    this.migrateSearchLog();
    this.migrateRawToRecords();
    this.migrateQueryLog();
    this.migrateActivityWeight();
    this.migrateHotnessScore();
    this.migrateQueryFeedback();
    this.migrateMissingIndexes();
    this.migrateAliasesSource();
    this.migrateChunksSummaryLevel();
    this.migrateOntologyTypes();
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

  private migrateLinksCredibility(): void {
    const cols = this.db.prepare("PRAGMA table_info(links)").all() as Array<{ name: string }>;
    const names = new Set(cols.map(c => c.name));
    if (!names.has("source_type")) {
      this.db.exec("ALTER TABLE links ADD COLUMN source_type TEXT DEFAULT 'unknown'");
    }
    if (!names.has("confidence")) {
      this.db.exec("ALTER TABLE links ADD COLUMN confidence REAL DEFAULT 0.5");
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
    this.db.exec("UPDATE discoveries SET seen = 0 WHERE seen IS NULL");
  }

  private migratePagesExpiry(): void {
    const cols = this.db.prepare("PRAGMA table_info(pages)").all() as Array<{ name: string }>;
    const names = new Set(cols.map(c => c.name));
    if (!names.has("expires_at")) {
      this.db.exec("ALTER TABLE pages ADD COLUMN expires_at TEXT");
    }
    // Backfill: entity pages without expires_at get now + 90d
    this.db.exec(
      "UPDATE pages SET expires_at = datetime('now', '+90 days') WHERE type LIKE 'entity/%' AND expires_at IS NULL"
    );
    if (!names.has("confidence_decay")) {
      this.db.exec("ALTER TABLE pages ADD COLUMN confidence_decay REAL DEFAULT 1.0");
    }
  }

  private migratePagesConstraint(): void {
    const check = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pages'").get() as { sql: string } | undefined;
    // Already has the correct constraint (v4) or no constraint at all (v6+) — skip
    if (check?.sql?.includes("'insight'") && !check.sql.includes("'source'") && !check.sql.includes("'event'") && !check.sql.includes("'raw'")) return;
    if (check?.sql && !check.sql.includes("CHECK(type IN")) return;

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

  getChunksByPage(pageSlug: string, opts?: { summaryLevel?: number }): Array<{ id: number; chunk_index: number; content: string; created_at: string }> {
    if (opts?.summaryLevel != null) {
      return this.prepare(
        "SELECT id, chunk_index, content, created_at FROM chunks WHERE page_slug = $slug AND summary_level = $level ORDER BY chunk_index"
      ).all({ $slug: pageSlug, $level: opts.summaryLevel }) as any[];
    }
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
    if (queries.length === 0) return [];

    const result = new Map<string, { slug: string; title: string }>();
    const remaining = new Set(queries);

    // Pass 1: Exact slug match (batch)
    const ph = queries.map(() => "?").join(",");
    const slugRows = this.prepare(
      `SELECT slug, title FROM pages WHERE slug IN (${ph})`
    ).all(...queries) as Array<{ slug: string; title: string }>;
    for (const row of slugRows) {
      if (remaining.has(row.slug)) {
        result.set(row.slug, row);
        remaining.delete(row.slug);
      }
    }

    // Pass 2: Exact title match (batch)
    if (remaining.size > 0) {
      const left = [...remaining];
      const ph2 = left.map(() => "?").join(",");
      const titleRows = this.prepare(
        `SELECT slug, title FROM pages WHERE title IN (${ph2})`
      ).all(...left) as Array<{ slug: string; title: string }>;
      for (const row of titleRows) {
        if (remaining.has(row.title)) {
          result.set(row.title, row);
          remaining.delete(row.title);
        }
      }
    }

    // Pass 3: Fuzzy LIKE for remaining
    if (remaining.size > 0) {
      for (const query of remaining) {
        const fuzzy = this.prepare(
          "SELECT slug, title FROM pages WHERE title LIKE $q LIMIT 1"
        ).get({ $q: `%${query}%` }) as { slug: string; title: string } | undefined;
        if (fuzzy) result.set(query, fuzzy);
      }
    }

    return queries.map(query => {
      const found = result.get(query);
      return { query, slug: found?.slug ?? null, title: found?.title ?? null };
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
    try {
      return this.prepare(
        "SELECT page_slug, content, rank FROM chunks_fts WHERE chunks_fts MATCH $query ORDER BY rank LIMIT $limit"
      ).all({ $query: ftsQuery, $limit: limit }) as Array<{ page_slug: string; content: string; rank: number }>;
    } catch (e) {
      console.warn("[ftsSearch] MATCH query failed, returning empty:", { query: ftsQuery, error: String(e) });
      return [];
    }
  }

  private buildTrigramQuery(query: string): string {
    // For short queries (3-6 chars), wrap in double quotes to avoid FTS5 syntax errors
    // from reserved words (AND, OR, NOT) or special chars (-, ")
    if (query.length <= 6) {
      return `"${query.replace(/"/g, '""')}"`;
    }
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

  getPageTierAndMentions(slug: string): { tier: number; mention_count: number; activity_weight: number } | null {
    return this.prepare(
      "SELECT tier, mention_count, COALESCE(activity_weight, 0) AS activity_weight FROM pages WHERE slug = $slug"
    ).get({ $slug: slug }) as { tier: number; mention_count: number; activity_weight: number } | null;
  }

  insertPage(data: { slug: string; type: string; title: string; filePath: string; contentHash: string; tier?: number; expiresAt?: string | null; confidenceDecay?: number }): void {
    const autoExpires = data.type.startsWith("entity/") && !data.expiresAt
      ? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ")
      : data.expiresAt ?? null;
    this.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash, tier, expires_at, confidence_decay, created_at, updated_at) VALUES ($slug, $type, $title, $path, $hash, $tier, $expires, $decay, datetime('now'), datetime('now'))"
    ).run({
      $slug: data.slug,
      $type: data.type,
      $title: data.title,
      $path: data.filePath,
      $hash: data.contentHash,
      $tier: data.tier ?? 3,
      $expires: autoExpires,
      $decay: data.confidenceDecay ?? 1.0,
    });
  }

  upsertPage(data: UpsertPageData): void {
    const isEntity = data.type.startsWith("entity/");
    const expiresAt = isEntity ? `datetime('now', '+90 days')` : null;
    this.prepare(`
      INSERT INTO pages (slug, type, title, file_path, content_hash, tier, expires_at, created_at, updated_at)
      VALUES ($slug, $type, $title, $path, $hash, 3, ${expiresAt ? expiresAt : 'NULL'}, datetime('now'), datetime('now'))
      ON CONFLICT(slug) DO UPDATE SET
        title = excluded.title,
        content_hash = excluded.content_hash,
        updated_at = datetime('now')
    `).run({
      $slug: data.slug,
      $type: data.type,
      $title: data.title,
      $path: data.filePath,
      $hash: data.contentHash,
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
    // chunks_fts (virtual table) and ingest_log have no FK → delete explicitly
    // links, tags, timeline, chunks are cleaned by ON DELETE CASCADE on pages DELETE
    this.prepare("DELETE FROM chunks_fts WHERE page_slug = $slug").run({ $slug: slug });
    this.prepare("DELETE FROM ingest_log WHERE page_slug = $slug").run({ $slug: slug });
    this.prepare("DELETE FROM pages WHERE slug = $slug").run({ $slug: slug });
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

  listPages(opts?: { type?: string; types?: string[]; typePrefix?: string; limit?: number; offset?: number; orderBy?: string }): PageRow[] {
    let sql = "SELECT * FROM pages WHERE 1=1";
    const params: Record<string, string | number> = {};
    if (opts?.typePrefix) {
      sql += " AND type LIKE $typePrefix";
      params.$typePrefix = `${opts.typePrefix}%`;
    } else if (opts?.type) {
      sql += " AND type = $type";
      params.$type = opts.type;
    }
    if (opts?.types && opts.types.length > 0) {
      const placeholders = opts.types.map((_, i) => `$t${i}`).join(",");
      opts.types.forEach((t, i) => { params[`$t${i}`] = t; });
      sql += ` AND type IN (${placeholders})`;
    }
    sql += ` ORDER BY ${sanitizeOrderBy(opts?.orderBy, "title ASC")}`;
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
    sql += ` ORDER BY ${sanitizeOrderBy(opts?.orderBy, "slug ASC")}`;
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

  getPageCountByTypePrefix(prefix: string): number {
    const row = this.prepare(
      "SELECT COUNT(*) as cnt FROM pages WHERE type LIKE $prefix"
    ).get({ $prefix: `${prefix}%` }) as { cnt: number };
    return row.cnt;
  }

  getPageTypeCounts(): Array<{ type: string; cnt: number }> {
    return this.prepare(
      "SELECT type, COUNT(*) as cnt FROM pages GROUP BY type ORDER BY cnt DESC"
    ).all() as Array<{ type: string; cnt: number }>;
  }

  getEntities(): Array<{ slug: string; title: string }> {
    return this.prepare(
      "SELECT slug, title FROM pages WHERE type LIKE 'entity/%' ORDER BY slug"
    ).all() as Array<{ slug: string; title: string }>;
  }

  getEntityConceptPages(): Array<{ slug: string; title: string; type: string }> {
    return this.prepare(
      "SELECT slug, title, type FROM pages WHERE type LIKE 'entity/%' OR type LIKE 'concept/%' ORDER BY title"
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
      `SELECT slug FROM pages WHERE slug IN (${placeholders}) ORDER BY (COALESCE(activity_weight, 0) + LOG(COALESCE(mention_count, 0) + 1)) DESC`
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
      "SELECT p.slug, p.title, p.type FROM pages p LEFT JOIN links l ON l.from_slug = p.slug OR l.to_slug = p.slug WHERE (p.type LIKE 'entity/%' OR p.type LIKE 'concept/%') AND p.mention_count <= 1 GROUP BY p.slug HAVING COUNT(l.id) <= 1"
    ).all() as Array<{ slug: string; title: string; type: string }>;
  }

  getIslandPages(): Array<{ slug: string; title: string; type: string }> {
    return this.prepare(
      "SELECT p.slug, p.title, p.type FROM pages p LEFT JOIN links l ON l.from_slug = p.slug OR l.to_slug = p.slug WHERE (p.type LIKE 'entity/%' OR p.type LIKE 'concept/%') GROUP BY p.slug HAVING COUNT(l.id) = 0"
    ).all() as Array<{ slug: string; title: string; type: string }>;
  }

  getStaleHighValuePages(days: number = 30): Array<{ slug: string; title: string; type: string; updated_at: string }> {
    return this.prepare(
      "SELECT slug, title, type, updated_at FROM pages WHERE tier <= 2 AND updated_at < datetime('now', '-' || $days || ' days') ORDER BY updated_at ASC"
    ).all({ $days: days }) as Array<{ slug: string; title: string; type: string; updated_at: string }>;
  }

  getPopularThinPages(threshold: number = 3): Array<{ slug: string; title: string; mention_count: number; type: string }> {
    return this.prepare(
      "SELECT slug, title, mention_count, type FROM pages WHERE mention_count >= $threshold AND (type LIKE 'entity/%' OR type LIKE 'concept/%') AND (SELECT COUNT(*) FROM chunks WHERE page_slug = pages.slug) <= 1 ORDER BY mention_count DESC"
    ).all({ $threshold: threshold }) as Array<{ slug: string; title: string; mention_count: number; type: string }>;
  }

  getPagesWithLinkCount(types: string[], orderBy?: string): Array<{ slug: string; title: string; type: string; link_count: number }> {
    const placeholders = types.map((_, i) => `$t${i}`).join(",");
    const params: Record<string, string> = {};
    types.forEach((t, i) => { params[`$t${i}`] = t; });
    const order = sanitizeOrderBy(orderBy, "title ASC");
    return this.prepare(
      `SELECT p.slug, p.title, p.type, COUNT(l.id) as link_count FROM pages p LEFT JOIN links l ON l.from_slug = p.slug OR l.to_slug = p.slug WHERE p.type IN (${placeholders}) GROUP BY p.slug ORDER BY ${order}`
    ).all(params) as Array<{ slug: string; title: string; type: string; link_count: number }>;
  }

  getPagesWithLinkCountByPrefix(prefix: string, orderBy?: string): Array<{ slug: string; title: string; type: string; link_count: number }> {
    const order = sanitizeOrderBy(orderBy, "title ASC");
    return this.prepare(
      `SELECT p.slug, p.title, p.type, COUNT(l.id) as link_count FROM pages p LEFT JOIN links l ON l.from_slug = p.slug OR l.to_slug = p.slug WHERE p.type LIKE $prefix GROUP BY p.slug ORDER BY ${order}`
    ).all({ $prefix: `${prefix}%` }) as Array<{ slug: string; title: string; type: string; link_count: number }>;
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
      "SELECT slug, title, type FROM pages WHERE updated_at > $since AND (type LIKE 'entity/%' OR type LIKE 'concept/%') ORDER BY updated_at DESC"
    ).all({ $since: since }) as Array<{ slug: string; title: string; type: string }>;
  }

  getTopMentionedEntities(limit: number = 10): PageRow[] {
    return this.prepare(
      "SELECT * FROM pages WHERE type LIKE 'entity/%' ORDER BY mention_count DESC LIMIT $limit"
    ).all({ $limit: limit }) as PageRow[];
  }

  getHighMentionEntities(minMentions: number): Array<{ slug: string; title: string; mention_count: number }> {
    return this.prepare(
      "SELECT slug, title, mention_count FROM pages WHERE type LIKE 'entity/%' AND mention_count >= $min ORDER BY mention_count DESC"
    ).all({ $min: minMentions }) as Array<{ slug: string; title: string; mention_count: number }>;
  }

  getHighConnectivityEntities(minNeighbors: number): Array<{ slug: string; title: string }> {
    return this.prepare(
      `SELECT p.slug, p.title FROM pages p
       WHERE p.type LIKE 'entity/%'
       AND (
         (SELECT COUNT(DISTINCT to_slug) FROM links WHERE from_slug = p.slug) +
         (SELECT COUNT(DISTINCT from_slug) FROM links WHERE to_slug = p.slug)
       ) >= $min
       ORDER BY p.mention_count DESC`
    ).all({ $min: minNeighbors }) as Array<{ slug: string; title: string }>;
  }

  // ─── Brief & Cross-ref queries ────────────────────────────────

  countNewPagesSince(hours: number): { entities: number; concepts: number } {
    const rows = this.prepare(
      "SELECT type, COUNT(*) as c FROM pages WHERE (type LIKE 'entity/%' OR type LIKE 'concept/%') AND created_at > datetime('now', '-' || $h || ' hours') GROUP BY type"
    ).all({ $h: hours }) as Array<{ type: string; c: number }>;
    const result = { entities: 0, concepts: 0 };
    for (const row of rows) {
      if (row.type.startsWith("entity/")) result.entities += row.c;
      else if (row.type.startsWith("concept/")) result.concepts += row.c;
    }
    return result;
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
    ).all(...slugs, ...slugs) as Array<{ context: string }>;
    return rows.map(r => r.context);
  }

  // ─── Link operations ──────────────────────────────────────────

  insertLink(from: string, to: string, relation: string, context?: string | null, weight?: number, strength?: string, sourceType?: string, confidence?: number, _skipReverse?: boolean): void {
    this.prepare(
      "INSERT OR IGNORE INTO links (from_slug, to_slug, relation, context, weight, strength, source_type, confidence) VALUES ($from, $to, $rel, $ctx, $w, $s, $st, $c)"
    ).run({ $from: from, $to: to, $rel: relation, $ctx: context ?? null, $w: weight ?? 1.0, $s: strength ?? 'medium', $st: sourceType ?? 'unknown', $c: confidence ?? 0.5 });

    if (!_skipReverse) {
      const reverse = REVERSE_RELATIONS[relation];
      if (reverse) {
        this.insertLink(to, from, reverse, context, weight, strength, sourceType, confidence, true);
      }
    }
  }

  deleteLink(from: string, to: string, relation: string): boolean {
    const r = this.prepare(
      "DELETE FROM links WHERE from_slug = $from AND to_slug = $to AND relation = $rel"
    ).run({ $from: from, $to: to, $rel: relation });
    const reverse = REVERSE_RELATIONS[relation];
    if (reverse) {
      this.prepare(
        "DELETE FROM links WHERE from_slug = $to AND to_slug = $from AND relation = $rel"
      ).run({ $to: to, $from: from, $rel: reverse });
    }
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
      "SELECT id, from_slug, to_slug, relation, weight, strength, context, source_type, confidence, created_at FROM links WHERE from_slug = $slug"
    ).all({ $slug: slug }) as LinkRow[];
  }

  getIncomingLinks(slug: string): LinkRow[] {
    return this.prepare(
      "SELECT id, from_slug, to_slug, relation, weight, strength, context, source_type, confidence, created_at FROM links WHERE to_slug = $slug"
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

  batchGetLinksForSlugs(slugs: string[]): Map<string, { outgoing: LinkRow[]; incoming: LinkRow[] }> {
    const result = new Map<string, { outgoing: LinkRow[]; incoming: LinkRow[] }>();
    if (slugs.length === 0) return result;
    for (const slug of slugs) result.set(slug, { outgoing: [], incoming: [] });
    const placeholders = slugs.map(() => "?").join(",");
    const outgoing = this.prepare(
      `SELECT id, from_slug, to_slug, relation, weight, strength, context, source_type, confidence, created_at FROM links WHERE from_slug IN (${placeholders})`
    ).all(...slugs) as LinkRow[];
    const incoming = this.prepare(
      `SELECT id, from_slug, to_slug, relation, weight, strength, context, source_type, confidence, created_at FROM links WHERE to_slug IN (${placeholders})`
    ).all(...slugs) as LinkRow[];
    for (const l of outgoing) result.get(l.from_slug)!.outgoing.push(l);
    for (const l of incoming) result.get(l.to_slug)!.incoming.push(l);
    return result;
  }

  batchGetTimelineForSlugs(slugs: string[]): Map<string, Array<{ id: number; event_date: string | null; source: string | null; summary: string; created_at: string }>> {
    const result = new Map<string, Array<{ id: number; event_date: string | null; source: string | null; summary: string; created_at: string }>>();
    if (slugs.length === 0) return result;
    for (const slug of slugs) result.set(slug, []);
    const placeholders = slugs.map(() => "?").join(",");
    const rows = this.prepare(
      `SELECT page_slug, id, event_date, source, summary, created_at FROM timeline WHERE page_slug IN (${placeholders}) ORDER BY event_date DESC, id DESC`
    ).all(...slugs) as Array<{ page_slug: string; id: number; event_date: string | null; source: string | null; summary: string; created_at: string }>;
    for (const r of rows) result.get(r.page_slug)!.push(r);
    return result;
  }

  batchGetTagsForSlugs(slugs: string[]): Map<string, string[]> {
    const result = new Map<string, string[]>();
    if (slugs.length === 0) return result;
    for (const slug of slugs) result.set(slug, []);
    const placeholders = slugs.map(() => "?").join(",");
    const rows = this.prepare(
      `SELECT page_slug, tag FROM tags WHERE page_slug IN (${placeholders}) ORDER BY tag`
    ).all(...slugs) as Array<{ page_slug: string; tag: string }>;
    for (const r of rows) result.get(r.page_slug)!.push(r.tag);
    return result;
  }

  getPageTitlesAndTypes(slugs: string[]): Map<string, { title: string; type: string }> {
    const result = new Map<string, { title: string; type: string }>();
    if (slugs.length === 0) return result;
    const placeholders = slugs.map(() => "?").join(",");
    const rows = this.prepare(
      `SELECT slug, title, type FROM pages WHERE slug IN (${placeholders})`
    ).all(...slugs) as Array<{ slug: string; title: string; type: string }>;
    for (const r of rows) result.set(r.slug, { title: r.title, type: r.type });
    return result;
  }

  getLinksForSlugs(slugs: string[]): Map<string, { outgoing: string[]; incoming: string[] }> {
    const result = new Map<string, { outgoing: string[]; incoming: string[] }>();
    if (slugs.length === 0) return result;
    for (const slug of slugs) result.set(slug, { outgoing: [], incoming: [] });
    const placeholders = slugs.map(() => "?").join(",");
    const outRows = this.prepare(
      `SELECT from_slug, to_slug FROM links WHERE from_slug IN (${placeholders})`
    ).all(...slugs) as Array<{ from_slug: string; to_slug: string }>;
    const inRows = this.prepare(
      `SELECT to_slug, from_slug FROM links WHERE to_slug IN (${placeholders})`
    ).all(...slugs) as Array<{ to_slug: string; from_slug: string }>;
    for (const r of outRows) result.get(r.from_slug)!.outgoing.push(r.to_slug);
    for (const r of inRows) result.get(r.to_slug)!.incoming.push(r.from_slug);
    return result;
  }

  /** Find distinct page_slugs whose chunks_fts content matches any LIKE pattern. */
  findSlugsByText(patterns: string[]): string[] {
    if (patterns.length === 0) return [];
    const clauses = patterns.map(() => "content LIKE ?").join(" OR ");
    const params = patterns.map(p => `%${p}%`);
    const rows = this.prepare(
      `SELECT DISTINCT page_slug FROM chunks_fts WHERE ${clauses}`
    ).all(...params) as Array<{ page_slug: string }>;
    return rows.map(r => r.page_slug);
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
    this.prepare("DELETE FROM chunks WHERE page_slug = $slug AND summary_level = 0").run({ $slug: slug });
  }

  insertChunk(slug: string, index: number, content: string): void {
    this.prepare(
      "INSERT INTO chunks (page_slug, chunk_index, content, summary_level) VALUES ($slug, $idx, $content, 0)"
    ).run({ $slug: slug, $idx: index, $content: content });
  }

  insertChunkWithLevel(slug: string, index: number, content: string, summaryLevel: number, contentHash: string | null): void {
    this.prepare(
      "INSERT INTO chunks (page_slug, chunk_index, content, summary_level, content_hash) VALUES ($slug, $idx, $content, $level, $hash)"
    ).run({ $slug: slug, $idx: index, $content: content, $level: summaryLevel, $hash: contentHash });
  }

  getL1Summary(slug: string): { id: number; content: string; content_hash: string | null } | null {
    return this.prepare(
      "SELECT id, content, content_hash FROM chunks WHERE page_slug = $slug AND summary_level = 1"
    ).get({ $slug: slug }) as { id: number; content: string; content_hash: string | null } | null;
  }

  deleteL1Summary(slug: string): void {
    this.prepare("DELETE FROM chunks WHERE page_slug = $slug AND summary_level = 1").run({ $slug: slug });
  }

  getPagesNeedingSeal(): string[] {
    const rows = this.prepare(
      `SELECT DISTINCT c1.page_slug FROM chunks c1
       WHERE c1.summary_level = 0
       AND NOT EXISTS (
         SELECT 1 FROM chunks c2 WHERE c2.page_slug = c1.page_slug AND c2.summary_level = 1
       )`
    ).all() as Array<{ page_slug: string }>;
    return rows.map(r => r.page_slug);
  }

  getPagesWithChangedChunks(): string[] {
    const l1Rows = this.prepare(
      "SELECT page_slug, content_hash FROM chunks WHERE summary_level = 1 AND content_hash IS NOT NULL"
    ).all() as Array<{ page_slug: string; content_hash: string }>;
    const changed: string[] = [];
    for (const row of l1Rows) {
      const currentHash = this.getRawChunkContentHash(row.page_slug);
      if (currentHash !== row.content_hash) changed.push(row.page_slug);
    }
    return changed;
  }

  getRawChunkContentHash(slug: string): string {
    const rows = this.prepare(
      "SELECT content FROM chunks WHERE page_slug = $slug AND summary_level = 0 ORDER BY chunk_index"
    ).all({ $slug: slug }) as Array<{ content: string }>;
    const combined = rows.map(r => r.content).join("\n");
    return Bun.hash(combined).toString();
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
      "SELECT slug FROM pages WHERE title = $name AND (type LIKE 'entity/%' OR type LIKE 'concept/%')"
    ).get({ $name: name }) as { slug: string } | null;
    return row?.slug ?? null;
  }

  getEntitySlugByTitleLower(name: string): string | null {
    const row = this.prepare(
      "SELECT slug FROM pages WHERE LOWER(title) = LOWER($name) AND (type LIKE 'entity/%' OR type LIKE 'concept/%')"
    ).get({ $name: name }) as { slug: string } | null;
    return row?.slug ?? null;
  }

  getEntityType(slug: string): string | null {
    const row = this.prepare(
      "SELECT type FROM pages WHERE slug = $slug"
    ).get({ $slug: slug }) as { type: string } | null;
    return row?.type ?? null;
  }

  updateType(slug: string, newType: string): void {
    this.prepare(
      "UPDATE pages SET type = $type, updated_at = CURRENT_TIMESTAMP WHERE slug = $slug"
    ).run({ $slug: slug, $type: newType });
  }

  getAllEntityTitles(): string[] {
    const rows = this.prepare(
      "SELECT title FROM pages WHERE type LIKE 'entity/%' OR type LIKE 'concept/%'"
    ).all() as Array<{ title: string }>;
    return rows.map(r => r.title);
  }

  addAlias(pageSlug: string, alias: string): void {
    this.prepare(
      "INSERT OR IGNORE INTO aliases (page_slug, alias) VALUES ($slug, $alias)"
    ).run({ $slug: pageSlug, $alias: alias });
  }

  addAliasWithSource(pageSlug: string, alias: string, source: string): void {
    this.prepare(
      "INSERT OR IGNORE INTO aliases (page_slug, alias, source) VALUES ($slug, $alias, $source)"
    ).run({ $slug: pageSlug, $alias: alias, $source: source });
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

  // ─── Query log (Phase 1) ────────────────────────────────────

  private migrateQueryLog(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS query_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool TEXT NOT NULL,
        query TEXT NOT NULL,
        result_slugs TEXT NOT NULL,
        result_count INTEGER NOT NULL,
        latency_ms INTEGER,
        session_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_query_log_created ON query_log(created_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_query_log_session ON query_log(session_id)");
  }

  logQuery(tool: string, query: string, resultSlugs: string[], latencyMs: number, sessionId?: string): void {
    this.prepare(
      "INSERT INTO query_log (tool, query, result_slugs, result_count, latency_ms, session_id) VALUES ($tool, $query, $slugs, $count, $latency, $session)"
    ).run({
      $tool: tool, $query: query, $slugs: JSON.stringify(resultSlugs),
      $count: resultSlugs.length, $latency: latencyMs, $session: sessionId ?? null,
    });
  }

  getQueryStatsSince(since: string): Array<{ slug: string; query_count: number; avg_position: number; tools: string; last_seen: string }> {
    return this.db.prepare(`
      WITH exploded AS (
        SELECT ql.tool, ql.created_at, j.value AS slug
        FROM query_log ql, json_each(ql.result_slugs) AS j
        WHERE ql.created_at >= $since
      )
      SELECT slug,
             COUNT(*) AS query_count,
             1.0 AS avg_position,
             GROUP_CONCAT(DISTINCT tool) AS tools,
             MAX(created_at) AS last_seen
      FROM exploded
      GROUP BY slug
      ORDER BY query_count DESC
    `).all({ $since: since }) as Array<{ slug: string; query_count: number; avg_position: number; tools: string; last_seen: string }>;
  }

  cleanOldQueryLogs(olderThanDays: number): number {
    this.prepare(
      "DELETE FROM query_feedback WHERE query_id IN (SELECT id FROM query_log WHERE created_at < datetime('now', '-' || $days || ' days'))"
    ).run({ $days: olderThanDays });
    const r = this.prepare(
      "DELETE FROM query_log WHERE created_at < datetime('now', '-' || $days || ' days')"
    ).run({ $days: olderThanDays });
    return r.changes;
  }

  getSessionCoOccurrences(sessionId: string): Array<{ slug_a: string; slug_b: string; count: number }> {
    const rows = this.db.prepare(`
      WITH session_slugs AS (
        SELECT j.value AS slug
        FROM query_log ql, json_each(ql.result_slugs) AS j
        WHERE ql.session_id = $session
      ),
      slug_pairs AS (
        SELECT a.slug AS slug_a, b.slug AS slug_b
        FROM session_slugs a, session_slugs b
        WHERE a.slug < b.slug
      )
      SELECT slug_a, slug_b, COUNT(*) AS count
      FROM slug_pairs
      GROUP BY slug_a, slug_b
    `).all({ $session: sessionId }) as Array<{ slug_a: string; slug_b: string; count: number }>;
    return rows;
  }

  getDistinctSessionsSince(since: string): string[] {
    const rows = this.db.prepare(
      "SELECT DISTINCT session_id FROM query_log WHERE session_id IS NOT NULL AND created_at >= $since"
    ).all({ $since: since }) as Array<{ session_id: string }>;
    return rows.map(r => r.session_id);
  }

  // ─── Activity weight (Phase 2) ──────────────────────────────

  private migrateActivityWeight(): void {
    const cols = this.db.prepare("PRAGMA table_info(pages)").all() as Array<{ name: string }>;
    const names = new Set(cols.map(c => c.name));
    if (!names.has("activity_weight")) {
      this.db.exec("ALTER TABLE pages ADD COLUMN activity_weight REAL DEFAULT 0.0");
    }
    if (!names.has("last_queried_at")) {
      this.db.exec("ALTER TABLE pages ADD COLUMN last_queried_at TEXT");
    }
  }

  batchUpdateActivityWeights(weights: Map<string, { weight: number; lastQueriedAt: string }>): number {
    if (weights.size === 0) return 0;
    const stmt = this.prepare(
      "UPDATE pages SET activity_weight = $w, last_queried_at = $t WHERE slug = $slug"
    );
    let updated = 0;
    for (const [slug, data] of weights) {
      const r = stmt.run({ $w: data.weight, $t: data.lastQueriedAt, $slug: slug });
      if (r.changes > 0) updated++;
    }
    return updated;
  }

  getActivityWeights(slugs: string[]): Map<string, number> {
    const result = new Map<string, number>();
    if (slugs.length === 0) return result;
    const placeholders = slugs.map((_, i) => `$s${i}`).join(",");
    const params: Record<string, string> = {};
    slugs.forEach((s, i) => { params[`$s${i}`] = s; });
    const rows = this.prepare(
      `SELECT slug, activity_weight FROM pages WHERE slug IN (${placeholders}) AND activity_weight > 0`
    ).all(params) as Array<{ slug: string; activity_weight: number }>;
    for (const row of rows) result.set(row.slug, row.activity_weight);
    return result;
  }

  bumpActivityWeight(slug: string, delta: number): void {
    this.prepare(
      "UPDATE pages SET activity_weight = COALESCE(activity_weight, 0) + $delta, last_queried_at = datetime('now') WHERE slug = $slug"
    ).run({ $delta: delta, $slug: slug });
  }

  getTopActivityEntities(limit: number = 10): Array<{ slug: string; title: string; activity_weight: number }> {
    return this.prepare(
      "SELECT slug, title, activity_weight FROM pages WHERE activity_weight > 0 ORDER BY activity_weight DESC LIMIT $limit"
    ).all({ $limit: limit }) as Array<{ slug: string; title: string; activity_weight: number }>;
  }

  // ─── Hotness score ───────────────────────────────────────────

  private migrateHotnessScore(): void {
    const cols = this.db.prepare("PRAGMA table_info(pages)").all() as Array<{ name: string }>;
    const names = new Set(cols.map(c => c.name));
    if (!names.has("hotness_score")) {
      this.db.exec("ALTER TABLE pages ADD COLUMN hotness_score REAL NOT NULL DEFAULT 0.0");
    }
  }

  updateHotnessScore(slug: string, score: number): void {
    this.prepare(
      "UPDATE pages SET hotness_score = $score WHERE slug = $slug"
    ).run({ $score: score, $slug: slug });
  }

  getLinkCountForSlug(slug: string): number {
    const row = this.prepare(
      "SELECT count(*) as cnt FROM links WHERE from_slug = $slug OR to_slug = $slug"
    ).get({ $slug: slug }) as { cnt: number } | null;
    return row?.cnt ?? 0;
  }

  getHotnessStats(): { mentionP95: number; linkP95: number; activityP95: number } {
    const p95 = (col: string, table: string) => {
      const row = this.prepare(
        `SELECT ${col} as val FROM ${table} WHERE ${col} > 0 ORDER BY ${col} DESC LIMIT 1 OFFSET (SELECT CAST(COUNT(*) * 0.05 AS INTEGER) FROM ${table} WHERE ${col} > 0)`
      ).get() as { val: number } | null;
      return row?.val ?? 1;
    };
    const linkRow = this.prepare(
      "SELECT MAX(cnt) as cnt FROM (SELECT count(*) as cnt FROM (SELECT from_slug as slug FROM links UNION ALL SELECT to_slug as slug FROM links) GROUP BY slug)"
    ).get() as { cnt: number } | null;
    return {
      mentionP95: p95("mention_count", "pages"),
      linkP95: linkRow?.cnt ?? 1,
      activityP95: p95("activity_weight", "pages"),
    };
  }

  getHotnessWeights(slugs: string[]): Map<string, number> {
    const result = new Map<string, number>();
    if (slugs.length === 0) return result;
    const placeholders = slugs.map((_, i) => `$s${i}`).join(",");
    const params: Record<string, string> = {};
    slugs.forEach((s, i) => { params[`$s${i}`] = s; });
    const rows = this.prepare(
      `SELECT slug, hotness_score FROM pages WHERE slug IN (${placeholders}) AND hotness_score > 0`
    ).all(params) as Array<{ slug: string; hotness_score: number }>;
    for (const row of rows) result.set(row.slug, row.hotness_score);
    return result;
  }

  getTopHotnessEntities(limit: number = 10): Array<{ slug: string; title: string; hotness_score: number }> {
    return this.prepare(
      "SELECT slug, title, hotness_score FROM pages WHERE hotness_score > 0 ORDER BY hotness_score DESC LIMIT $limit"
    ).all({ $limit: limit }) as Array<{ slug: string; title: string; hotness_score: number }>;
  }

  boostLinkWeight(slugA: string, slugB: string, boost: number): void {
    this.prepare(
      "UPDATE links SET weight = MIN(weight + $boost, 10.0) WHERE (from_slug = $a AND to_slug = $b) OR (from_slug = $b AND to_slug = $a)"
    ).run({ $a: slugA, $b: slugB, $boost: boost });
  }

  // ─── Query feedback (Phase 4) ───────────────────────────────

  private migrateQueryFeedback(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS query_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query_id INTEGER REFERENCES query_log(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        signal TEXT NOT NULL CHECK(signal IN ('relevant', 'irrelevant', 'corrected', 'expanded')),
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_feedback_slug ON query_feedback(slug)");
  }

  private migrateMissingIndexes(): void {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_pages_title ON pages(title);
      CREATE INDEX IF NOT EXISTS idx_pages_updated_at ON pages(updated_at);
      CREATE INDEX IF NOT EXISTS idx_pages_created_at ON pages(created_at);
      CREATE INDEX IF NOT EXISTS idx_pages_activity_wt ON pages(activity_weight) WHERE activity_weight > 0;
      CREATE INDEX IF NOT EXISTS idx_pages_expires_at ON pages(expires_at) WHERE expires_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tags_page_slug ON tags(page_slug);
      CREATE INDEX IF NOT EXISTS idx_timeline_page_slug ON timeline(page_slug);
      CREATE INDEX IF NOT EXISTS idx_ingest_log_created ON ingest_log(created_at);
      CREATE INDEX IF NOT EXISTS idx_feedback_created ON query_feedback(created_at);
    `);
    try {
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_pages_title_uniq ON pages(title)");
    } catch {
      console.warn("[migrate] pages has duplicate titles — unique index skipped, run dedup first");
    }
  }

  private migrateAliasesSource(): void {
    const cols = this.db.prepare("PRAGMA table_info(aliases)").all() as Array<{ name: string }>;
    const names = new Set(cols.map(c => c.name));
    if (!names.has("source")) {
      this.db.exec("ALTER TABLE aliases ADD COLUMN source TEXT DEFAULT 'manual'");
    }
  }

  private migrateChunksSummaryLevel(): void {
    const cols = this.db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>;
    const names = new Set(cols.map(c => c.name));
    if (names.has("summary_level")) return;

    this.db.exec("PRAGMA foreign_keys = OFF");
    this.db.exec(`
      CREATE TABLE chunks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page_slug TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        summary_level INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (page_slug) REFERENCES pages(slug) ON DELETE CASCADE,
        UNIQUE(page_slug, summary_level, chunk_index)
      );
      INSERT INTO chunks_new (id, page_slug, chunk_index, content, summary_level, content_hash, created_at)
        SELECT id, page_slug, chunk_index, content, 0, NULL, created_at FROM chunks;
      DROP TABLE chunks;
      ALTER TABLE chunks_new RENAME TO chunks;
    `);
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  /**
   * v6 migration: Remove type CHECK constraint from pages table to support
   * ontology type paths (e.g., entity/person, concept/concept).
   * Migrates existing flat types to path-based types.
   */
  private migrateOntologyTypes(): void {
    const done = this.db.prepare("SELECT value FROM config WHERE key = 'migration_v6_ontology_types'").get() as { value: string } | undefined;
    if (done?.value === "1") return;

    this.db.exec("PRAGMA foreign_keys = OFF");

    this.db.exec(`
      CREATE TABLE pages_new (
        slug TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content_hash TEXT,
        tier INTEGER DEFAULT 3 CHECK(tier BETWEEN 1 AND 3),
        mention_count INTEGER DEFAULT 0,
        expires_at TEXT,
        confidence_decay REAL DEFAULT 1.0,
        activity_weight REAL DEFAULT 0.0,
        last_queried_at TEXT,
        hotness_score REAL NOT NULL DEFAULT 0.0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO pages_new SELECT slug, type, title, file_path, content_hash, tier, mention_count, expires_at, confidence_decay, COALESCE(activity_weight, 0.0), last_queried_at, COALESCE(hotness_score, 0.0), created_at, updated_at FROM pages;
      DROP TABLE pages;
      ALTER TABLE pages_new RENAME TO pages;
    `);

    // Migrate old flat types → new type paths
    this.db.prepare("UPDATE pages SET type = 'entity/person' WHERE type = 'entity' AND slug LIKE 'brain/entities/%'").run();
    this.db.prepare("UPDATE pages SET type = 'concept/concept' WHERE type = 'concept' AND slug LIKE 'brain/concepts/%'").run();

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(type)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_pages_tier ON pages(tier)");
    this.db.exec("PRAGMA foreign_keys = ON");

    this.db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('migration_v6_ontology_types', '1')").run();
  }

  insertFeedback(queryId: number | null, slug: string, signal: "relevant" | "irrelevant" | "corrected" | "expanded", note?: string): void {
    this.prepare(
      "INSERT INTO query_feedback (query_id, slug, signal, note) VALUES ($qid, $slug, $signal, $note)"
    ).run({ $qid: queryId ?? null, $slug: slug, $signal: signal, $note: note ?? null });
  }

  getFeedbackSince(since: string): Array<{ slug: string; signal: string; cnt: number }> {
    return this.db.prepare(`
      SELECT slug, signal, COUNT(*) AS cnt
      FROM query_feedback
      WHERE created_at >= $since
      GROUP BY slug, signal
    `).all({ $since: since }) as Array<{ slug: string; signal: string; cnt: number }>;
  }

  // ─── Proactive hints support ──────────────────────────────────

  getRecentEventsInNetwork(
    slugs: string[],
    days: number,
    limit: number
  ): Array<{ slug: string; title: string; event_date: string | null; summary: string }> {
    if (slugs.length === 0) return [];
    const ph = slugs.map(() => "?").join(",");

    // Find 1-hop neighbor slugs
    const neighborRows = this.prepare(
      `SELECT DISTINCT to_slug AS neighbor FROM links WHERE from_slug IN (${ph})
       UNION
       SELECT DISTINCT from_slug AS neighbor FROM links WHERE to_slug IN (${ph})`
    ).all(...slugs, ...slugs) as Array<{ neighbor: string }>;
    const neighbors = neighborRows.map(r => r.neighbor).filter(n => !slugs.includes(n));
    if (neighbors.length === 0) return [];

    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const ph2 = neighbors.map(() => "?").join(",");
    const rows = this.prepare(
      `SELECT t.page_slug AS slug, p.title, t.event_date, t.summary
       FROM timeline t JOIN pages p ON p.slug = t.page_slug
       WHERE t.page_slug IN (${ph2}) AND t.event_date >= ?
       ORDER BY t.event_date DESC LIMIT ?`
    ).all(...neighbors, cutoff, limit) as Array<{ slug: string; title: string; event_date: string | null; summary: string }>;
    return rows;
  }

  getExpiringSlugsInSet(
    slugs: string[],
    withinDays: number
  ): Array<{ slug: string; title: string; expires_at: string }> {
    if (slugs.length === 0) return [];
    const ph = slugs.map(() => "?").join(",");
    const cutoff = new Date(Date.now() + withinDays * 86_400_000).toISOString().slice(0, 10);
    return this.prepare(
      `SELECT slug, title, expires_at FROM pages
       WHERE slug IN (${ph}) AND expires_at IS NOT NULL AND expires_at <= ?
       ORDER BY expires_at ASC`
    ).all(...slugs, cutoff) as Array<{ slug: string; title: string; expires_at: string }>;
  }

  // ─── Relation audit helpers ─────────────────────────────────

  getRelationDistribution(): Array<{ relation: string; count: number }> {
    return this.db.query(
      `SELECT relation, COUNT(*) as count FROM links GROUP BY relation ORDER BY count DESC`
    ).all() as Array<{ relation: string; count: number }>;
  }

  getAllLinksByRelation(relation: string): LinkRow[] {
    return this.db.query(
      `SELECT * FROM links WHERE relation = ?`
    ).all(relation) as LinkRow[];
  }

  updateLinkRelation(id: number, newRelation: string): void {
    this.db.query(
      `UPDATE links SET relation = ? WHERE id = ?`
    ).run(newRelation, id);
  }

  deleteLinkById(id: number): void {
    const link = this.db.query(`SELECT from_slug, to_slug, relation FROM links WHERE id = ?`).get(id) as { from_slug: string; to_slug: string; relation: string } | null;
    this.db.query(`DELETE FROM links WHERE id = ?`).run(id);
    if (link) {
      const reverse = REVERSE_RELATIONS[link.relation];
      if (reverse) {
        this.prepare(
          "DELETE FROM links WHERE from_slug = $to AND to_slug = $from AND relation = $rel"
        ).run({ $to: link.to_slug, $from: link.from_slug, $rel: reverse });
      }
    }
  }

  close(): void {
    this.db.close();
  }
}
