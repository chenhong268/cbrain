import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { CBrainDB, FKMigrationError, runDestructiveMigrationForTest } from "../../src/storage/sqlite.js";

// ─── Fixture helpers ──────────────────────────────────────────────

/**
 * Pre-v4 database: pages table with OLD CHECK constraint
 * that includes 'source' but not 'insight'. This triggers migratePagesConstraint.
 * type='source' is NOT converted by the body (only event/raw → record),
 * so it will cause a CHECK violation on INSERT INTO pages_new.
 */
function createPreV4DB(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    CREATE TABLE pages (
      slug TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('entity', 'concept', 'record', 'source')),
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
    CREATE TABLE links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_slug TEXT NOT NULL,
      to_slug TEXT NOT NULL,
      relation TEXT NOT NULL DEFAULT 'mentions',
      weight REAL DEFAULT 1.0,
      context TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(from_slug, to_slug, relation)
    );
    CREATE TABLE tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_slug TEXT NOT NULL,
      tag TEXT NOT NULL,
      UNIQUE(page_slug, tag)
    );
    CREATE TABLE timeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_slug TEXT NOT NULL,
      event_date TEXT,
      source TEXT,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_slug TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(page_slug, chunk_index)
    );
    CREATE TABLE ingest_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      action TEXT NOT NULL,
      page_slug TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_slug TEXT NOT NULL,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      frontmatter TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(page_slug, version)
    );
    CREATE TABLE aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_slug TEXT NOT NULL,
      alias TEXT NOT NULL,
      UNIQUE(page_slug, alias)
    );
    CREATE INDEX idx_pages_type ON pages(type);
    CREATE INDEX idx_pages_tier ON pages(tier);
    CREATE INDEX idx_links_from ON links(from_slug);
    CREATE INDEX idx_links_to ON links(to_slug);
    CREATE INDEX idx_chunks_page ON chunks(page_slug);
    CREATE INDEX idx_versions_page ON versions(page_slug);
    CREATE INDEX idx_aliases_alias ON aliases(alias);
  `);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

/** Pre-v5 DB: has correct v4 CHECK, markers for v4 migrations done, no raw→records marker. */
function createPreV5DB(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    CREATE TABLE pages (
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
    CREATE TABLE links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_slug TEXT NOT NULL,
      to_slug TEXT NOT NULL,
      relation TEXT NOT NULL DEFAULT 'mentions',
      weight REAL DEFAULT 1.0,
      context TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(from_slug, to_slug, relation)
    );
    CREATE TABLE tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_slug TEXT NOT NULL,
      tag TEXT NOT NULL,
      UNIQUE(page_slug, tag)
    );
    CREATE TABLE timeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_slug TEXT NOT NULL,
      event_date TEXT,
      source TEXT,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_slug TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(page_slug, chunk_index)
    );
    CREATE TABLE ingest_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      action TEXT NOT NULL,
      page_slug TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_slug TEXT NOT NULL,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      frontmatter TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(page_slug, version)
    );
    CREATE TABLE aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_slug TEXT NOT NULL,
      alias TEXT NOT NULL,
      UNIQUE(page_slug, alias)
    );
    CREATE INDEX idx_pages_type ON pages(type);
    CREATE INDEX idx_pages_tier ON pages(tier);
    CREATE INDEX idx_links_from ON links(from_slug);
    CREATE INDEX idx_links_to ON links(to_slug);
    CREATE INDEX idx_chunks_page ON chunks(page_slug);
    CREATE INDEX idx_versions_page ON versions(page_slug);
    CREATE INDEX idx_aliases_alias ON aliases(alias);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(page_slug, content, tokenize='trigram');
    INSERT INTO config (key, value) VALUES ('migration_v4_pages_constraint', '1');
    INSERT INTO config (key, value) VALUES ('migration_v4_chunks_summary_level', '1');
  `);
  return db;
}

/**
 * Pre-chunks-migration DB: pages has correct v4 CHECK, but chunks lacks summary_level.
 * Used to test chunks rebuild failure injection.
 * We make chunks with a column that INSERT INTO chunks_new can't handle by
 * adding a chunk whose page_slug does NOT exist in pages — the chunks_new has
 * FK(page_slug) REFERENCES pages(slug), so INSERT will fail FK check.
 */
function createPreChunksMigrationDB(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    CREATE TABLE pages (
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
    CREATE TABLE links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_slug TEXT NOT NULL,
      to_slug TEXT NOT NULL,
      relation TEXT NOT NULL DEFAULT 'mentions',
      weight REAL DEFAULT 1.0,
      context TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(from_slug, to_slug, relation)
    );
    CREATE TABLE tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_slug TEXT NOT NULL,
      tag TEXT NOT NULL,
      UNIQUE(page_slug, tag)
    );
    CREATE TABLE timeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_slug TEXT NOT NULL,
      event_date TEXT,
      source TEXT,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_slug TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(page_slug, chunk_index)
    );
    CREATE TABLE ingest_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      action TEXT NOT NULL,
      page_slug TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_slug TEXT NOT NULL,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      frontmatter TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(page_slug, version)
    );
    CREATE TABLE aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_slug TEXT NOT NULL,
      alias TEXT NOT NULL,
      UNIQUE(page_slug, alias)
    );
    CREATE INDEX idx_pages_type ON pages(type);
    CREATE INDEX idx_pages_tier ON pages(tier);
    CREATE INDEX idx_links_from ON links(from_slug);
    CREATE INDEX idx_links_to ON links(to_slug);
    CREATE INDEX idx_chunks_page ON chunks(page_slug);
    CREATE INDEX idx_versions_page ON versions(page_slug);
    CREATE INDEX idx_aliases_alias ON aliases(alias);
    -- Mark v4 pages constraint as done
    INSERT INTO config (key, value) VALUES ('migration_v4_pages_constraint', '1');
  `);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

/**
 * Pre-ontology DB: has v4 CHECK and v5 marker, but no v6 marker.
 * Pages table still has CHECK(type IN ('entity','concept','record','insight')).
 * Used to test ontology rebuild failure injection.
 *
 * To make INSERT INTO pages_new fail: seed a page whose slug has a NULL activity_weight
 * column... wait, activity_weight doesn't exist yet. The pages_new schema expects
 * COALESCE(activity_weight, 0.0) in SELECT. If activity_weight column doesn't exist,
 * COALESCE returns 0.0 for NULL which is fine.
 *
 * Better approach: make the pages table have a CHECK that prevents the new schema.
 * Or: add a row with NULL type (NOT NULL constraint will fail on INSERT).
 * Actually: just add a trigger or a different kind of constraint that blocks INSERT.
 *
 * Simplest: seed a page where slug is NULL. No, slug is PK so it can't be NULL.
 *
 * Actually: the ontology pages_new has CHECK(tier BETWEEN 1 AND 3). If we insert
 * a page with tier=0 or tier=4, INSERT INTO pages_new fails on CHECK.
 */
function createPreOntologyMigrationDB(dbPath: string, injectFailure?: boolean): Database {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    CREATE TABLE pages (
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
    CREATE TABLE links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_slug TEXT NOT NULL,
      to_slug TEXT NOT NULL,
      relation TEXT NOT NULL DEFAULT 'mentions',
      weight REAL DEFAULT 1.0,
      context TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(from_slug, to_slug, relation)
    );
    CREATE TABLE tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_slug TEXT NOT NULL,
      tag TEXT NOT NULL,
      UNIQUE(page_slug, tag)
    );
    CREATE TABLE timeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_slug TEXT NOT NULL,
      event_date TEXT,
      source TEXT,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE chunks (
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
    CREATE TABLE ingest_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      action TEXT NOT NULL,
      page_slug TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_slug TEXT NOT NULL,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      frontmatter TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(page_slug, version)
    );
    CREATE TABLE aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_slug TEXT NOT NULL,
      alias TEXT NOT NULL,
      UNIQUE(page_slug, alias)
    );
    CREATE INDEX idx_pages_type ON pages(type);
    CREATE INDEX idx_pages_tier ON pages(tier);
    CREATE INDEX idx_links_from ON links(from_slug);
    CREATE INDEX idx_links_to ON links(to_slug);
    CREATE INDEX idx_chunks_page ON chunks(page_slug);
    CREATE INDEX idx_versions_page ON versions(page_slug);
    CREATE INDEX idx_aliases_alias ON aliases(alias);
    INSERT INTO config (key, value) VALUES ('migration_v4_pages_constraint', '1');
    INSERT INTO config (key, value) VALUES ('migration_v4_chunks_summary_level', '1');
    INSERT INTO config (key, value) VALUES ('migration_v5_raw_to_records', '1');
  `);
  if (injectFailure) {
    // tier=0 violates CHECK(tier BETWEEN 1 AND 3) on pages_new INSERT
    db.prepare("INSERT INTO pages (slug, type, title, file_path, tier) VALUES (?, 'entity', ?, ?, 0)").run(
      "bad-tier-page", "Bad Tier", "bad-tier-page.md"
    );
  }
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function freshDir(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
}

/** bun:sqlite .get() returns null when no row found */
function noRow(result: unknown): boolean {
  return result === null || result === undefined;
}

/** Get table SQL from sqlite_master */
function getTableSQL(db: Database, table: string): string | null {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string } | undefined | null;
  return row?.sql ?? null;
}

// ════════════════════════════════════════════════════════════════════
// raw→records migration
// ════════════════════════════════════════════════════════════════════

describe("Atomic migrations — raw to records", () => {
  const testDir = "/tmp/cbrain-test-migration-raw";
  const dbPath = join(testDir, "brain.sqlite");

  beforeEach(() => freshDir(testDir));
  afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true }); });

  test("successful migration converts raw/* slugs across all tables", () => {
    const raw = createPreV5DB(dbPath);
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'record', ?, ?)").run("raw/meeting-2024", "Meeting", "raw/meeting-2024.md");
    raw.prepare("INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, 'mentions')").run("raw/meeting-2024", "brain/entities/person/john");
    raw.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, 0, 'content')").run("raw/meeting-2024");
    raw.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, 'content')").run("raw/meeting-2024");
    raw.prepare("INSERT INTO tags (page_slug, tag) VALUES (?, 'work')").run("raw/meeting-2024");
    raw.prepare("INSERT INTO timeline (page_slug, summary) VALUES (?, 'event')").run("raw/meeting-2024");
    raw.prepare("INSERT INTO versions (page_slug, version, content) VALUES (?, 1, 'v1')").run("raw/meeting-2024");
    raw.prepare("INSERT INTO ingest_log (source_type, action, page_slug) VALUES ('mcp', 'create', ?)").run("raw/meeting-2024");
    raw.close();

    const db = new CBrainDB(dbPath);

    const page = db.rawDb.prepare("SELECT slug FROM pages WHERE title = 'Meeting'").get() as { slug: string };
    expect(page.slug).toBe("records/meeting-2024");

    const link = db.rawDb.prepare("SELECT from_slug FROM links WHERE from_slug LIKE 'records/%'").get() as { from_slug: string };
    expect(link.from_slug).toBe("records/meeting-2024");

    const chunk = db.rawDb.prepare("SELECT page_slug FROM chunks WHERE page_slug LIKE 'records/%'").get() as { page_slug: string };
    expect(chunk.page_slug).toBe("records/meeting-2024");

    const fts = db.rawDb.prepare("SELECT page_slug FROM chunks_fts WHERE page_slug LIKE 'records/%'").get() as { page_slug: string };
    expect(fts.page_slug).toBe("records/meeting-2024");

    const tag = db.rawDb.prepare("SELECT page_slug FROM tags WHERE page_slug LIKE 'records/%'").get() as { page_slug: string };
    expect(tag.page_slug).toBe("records/meeting-2024");

    const tl = db.rawDb.prepare("SELECT page_slug FROM timeline WHERE page_slug LIKE 'records/%'").get() as { page_slug: string };
    expect(tl.page_slug).toBe("records/meeting-2024");

    const ver = db.rawDb.prepare("SELECT page_slug FROM versions WHERE page_slug LIKE 'records/%'").get() as { page_slug: string };
    expect(ver.page_slug).toBe("records/meeting-2024");

    const log = db.rawDb.prepare("SELECT page_slug FROM ingest_log WHERE page_slug LIKE 'records/%'").get() as { page_slug: string };
    expect(log.page_slug).toBe("records/meeting-2024");

    const marker = db.rawDb.prepare("SELECT value FROM config WHERE key = 'migration_v5_raw_to_records'").get() as { value: string } | undefined;
    expect(marker?.value).toBe("1");

    db.close();
  });

  test("PK collision rolls back all slug changes and leaves no marker", () => {
    const raw = createPreV5DB(dbPath);
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'record', ?, ?)").run("raw/collision-doc", "Collision Raw", "raw/collision-doc.md");
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'record', ?, ?)").run("records/collision-doc", "Collision Records", "records/collision-doc.md");
    raw.prepare("INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, 'mentions')").run("raw/collision-doc", "records/collision-doc");
    raw.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, 0, 'content')").run("raw/collision-doc");
    raw.close();

    let error: Error | undefined;
    try { new CBrainDB(dbPath); } catch (e) { error = e as Error; }

    expect(error).toBeTruthy();
    expect(error!.message).toContain("migrateRawToRecords");

    const verify = new Database(dbPath);
    verify.exec("PRAGMA foreign_keys = OFF");

    // Both original slugs should still exist
    expect(verify.prepare("SELECT slug FROM pages WHERE slug = 'raw/collision-doc'").get()).toBeTruthy();
    expect(verify.prepare("SELECT slug FROM pages WHERE slug = 'records/collision-doc'").get()).toBeTruthy();
    expect(verify.prepare("SELECT from_slug FROM links WHERE from_slug = 'raw/collision-doc'").get()).toBeTruthy();
    expect(verify.prepare("SELECT page_slug FROM chunks WHERE page_slug = 'raw/collision-doc'").get()).toBeTruthy();

    // Marker NOT written
    const marker = verify.prepare("SELECT value FROM config WHERE key = 'migration_v5_raw_to_records'").get() as { value: string } | null;
    expect(marker?.value).not.toBe("1");

    verify.close();
  });

  test("retry after collision fix succeeds", () => {
    const raw = createPreV5DB(dbPath);
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'record', ?, ?)").run("raw/collision-doc", "Collision Raw", "raw/collision-doc.md");
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'record', ?, ?)").run("records/collision-doc", "Collision Records", "records/collision-doc.md");
    raw.close();

    expect(() => new CBrainDB(dbPath)).toThrow();

    const fix = new Database(dbPath);
    fix.exec("PRAGMA foreign_keys = OFF");
    fix.prepare("DELETE FROM pages WHERE slug = 'records/collision-doc'").run();
    fix.close();

    const db = new CBrainDB(dbPath);
    const migrated = db.rawDb.prepare("SELECT slug FROM pages WHERE title = 'Collision Raw'").get() as { slug: string };
    expect(migrated.slug).toBe("records/collision-doc");
    const marker = db.rawDb.prepare("SELECT value FROM config WHERE key = 'migration_v5_raw_to_records'").get() as { value: string } | null;
    expect(marker?.value).toBe("1");
    db.close();
  });

  test("idempotent re-run does not duplicate work", () => {
    const raw = createPreV5DB(dbPath);
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'record', ?, ?)").run("raw/meeting", "Meeting", "raw/meeting.md");
    raw.close();

    const db1 = new CBrainDB(dbPath);
    db1.close();

    const db2 = new CBrainDB(dbPath);
    const page = db2.rawDb.prepare("SELECT slug FROM pages WHERE title = 'Meeting'").get() as { slug: string };
    expect(page.slug).toBe("records/meeting");
    db2.close();
  });

  test("validation catches residual brain/records/* in links.to_slug and rolls back", () => {
    // Use a trigger to block the links.to_slug brain/records/* UPDATE,
    // simulating a partial body execution that leaves stale refs.
    const raw = createPreV5DB(dbPath);
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'record', ?, ?)").run("raw/doc1", "Doc1", "raw/doc1.md");
    // Add a link with brain/records/ prefix that the body should convert
    raw.prepare("INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, 'mentions')").run("raw/doc1", "brain/records/old-rec");
    // Create a trigger that silently blocks the to_slug brain/records→records update
    raw.exec(`
      CREATE TRIGGER block_to_slug_update
      BEFORE UPDATE ON links
      FOR EACH ROW
      WHEN NEW.to_slug LIKE 'records/%' AND OLD.to_slug LIKE 'brain/records/%'
      BEGIN
        SELECT RAISE(IGNORE);
      END
    `);
    raw.close();

    // The trigger makes the UPDATE silently skip the to_slug row.
    // Body completes (no SQL error — RAISE(IGNORE) just skips the row).
    // But validate catches the residual brain/records/* in links.to_slug.
    let error: Error | undefined;
    try { new CBrainDB(dbPath); } catch (e) { error = e as Error; }

    expect(error).toBeTruthy();
    expect(error!.message).toContain("migrateRawToRecords");

    const verify = new Database(dbPath);
    verify.exec("PRAGMA foreign_keys = OFF");

    // Original slug in pages still intact (rolled back)
    const page = verify.prepare("SELECT slug FROM pages WHERE title = 'Doc1'").get() as { slug: string };
    expect(page.slug).toBe("raw/doc1");

    // Link still references original brain/records/ path (rolled back)
    const link = verify.prepare("SELECT to_slug FROM links WHERE from_slug = 'raw/doc1'").get() as { to_slug: string };
    expect(link.to_slug).toBe("brain/records/old-rec");

    // Marker NOT written
    const marker = verify.prepare("SELECT value FROM config WHERE key = 'migration_v5_raw_to_records'").get() as { value: string } | null;
    expect(marker?.value).not.toBe("1");

    verify.close();

    // Fix: drop the trigger and retry
    const fix = new Database(dbPath);
    fix.exec("PRAGMA foreign_keys = OFF");
    fix.exec("DROP TRIGGER IF EXISTS block_to_slug_update");
    fix.close();

    const db = new CBrainDB(dbPath);
    const migrated = db.rawDb.prepare("SELECT slug FROM pages WHERE title = 'Doc1'").get() as { slug: string };
    expect(migrated.slug).toBe("records/doc1");
    const markerAfter = db.rawDb.prepare("SELECT value FROM config WHERE key = 'migration_v5_raw_to_records'").get() as { value: string } | null;
    expect(markerAfter?.value).toBe("1");
    db.close();
  });
});

// ════════════════════════════════════════════════════════════════════
// pages constraint migration
// ════════════════════════════════════════════════════════════════════

describe("Atomic migrations — pages constraint rebuild", () => {
  const testDir = "/tmp/cbrain-test-migration-pages";
  const dbPath = join(testDir, "brain.sqlite");

  beforeEach(() => freshDir(testDir));
  afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true }); });

  test("CHECK constraint migration succeeds and writes marker", () => {
    const raw = createPreV4DB(dbPath);
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'record', ?, ?)").run("legacy-record", "Legacy Record", "legacy-record.md");
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'entity', ?, ?)").run("brain/entities/person/john", "实体A", "brain/entities/person/john.md");
    raw.close();

    const db = new CBrainDB(dbPath);

    // v6 ontology migration runs after v4, removing CHECK and adding new columns
    const schema = db.rawDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pages'").get() as { sql: string };
    expect(schema.sql).toContain("activity_weight");

    const marker = db.rawDb.prepare("SELECT value FROM config WHERE key = 'migration_v4_pages_constraint'").get() as { value: string } | null;
    expect(marker?.value).toBe("1");

    const temp = db.rawDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pages_new'").get();
    expect(noRow(temp)).toBe(true);

    db.close();
  });

  test("pages rebuild rolls back on CHECK violation from type='source'", () => {
    // type='source' is valid in old CHECK but NOT in new CHECK.
    // The body only converts event→record and raw→record, NOT source→record.
    // So type='source' causes INSERT INTO pages_new to fail on CHECK constraint.
    const raw = createPreV4DB(dbPath);
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'entity', ?, ?)").run("good-page", "Good Page", "good-page.md");
    // This page will trigger the failure
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'source', ?, ?)").run("source-page", "Source Page", "source-page.md");
    raw.close();

    // Save pre-migration state
    const preSchema = getTableSQL(new Database(dbPath), "pages");

    let error: Error | undefined;
    try { new CBrainDB(dbPath); } catch (e) { error = e as Error; }

    expect(error).toBeTruthy();
    expect(error!.message).toContain("migratePagesConstraint");

    const verify = new Database(dbPath);
    verify.exec("PRAGMA foreign_keys = OFF");

    // Old schema preserved
    const postSchema = getTableSQL(verify, "pages");
    expect(postSchema).toBe(preSchema);

    // Both original rows still exist
    expect(verify.prepare("SELECT slug FROM pages WHERE slug = 'good-page'").get()).toBeTruthy();
    expect(verify.prepare("SELECT slug FROM pages WHERE slug = 'source-page'").get()).toBeTruthy();
    expect(verify.prepare("SELECT type FROM pages WHERE slug = 'source-page'").get() as unknown as { type: string }).toEqual({ type: "source" });

    // No pages_new residual
    expect(noRow(verify.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pages_new'").get())).toBe(true);

    // Marker NOT written
    const marker = verify.prepare("SELECT value FROM config WHERE key = 'migration_v4_pages_constraint'").get() as { value: string } | null;
    expect(marker?.value).not.toBe("1");

    verify.close();
  });

  test("pages rebuild retry succeeds after fixing source type", () => {
    const raw = createPreV4DB(dbPath);
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'entity', ?, ?)").run("good-page", "Good Page", "good-page.md");
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'source', ?, ?)").run("source-page", "Source Page", "source-page.md");
    raw.close();

    // First attempt fails
    expect(() => new CBrainDB(dbPath)).toThrow();

    // Fix: convert source to record
    const fix = new Database(dbPath);
    fix.exec("PRAGMA foreign_keys = OFF");
    fix.prepare("UPDATE pages SET type = 'record' WHERE type = 'source'").run();
    fix.close();

    // Retry succeeds
    const db = new CBrainDB(dbPath);
    const marker = db.rawDb.prepare("SELECT value FROM config WHERE key = 'migration_v4_pages_constraint'").get() as { value: string } | null;
    expect(marker?.value).toBe("1");
    expect(verifyPageCount(db.rawDb, 2));
    db.close();
  });

  test("leftover pages_new from prior failed attempt is cleaned up", () => {
    const raw = createPreV4DB(dbPath);
    raw.exec("CREATE TABLE pages_new (slug TEXT PRIMARY KEY, dummy TEXT)");
    raw.close();

    const db = new CBrainDB(dbPath);

    expect(noRow(db.rawDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pages_new'").get())).toBe(true);
    const marker = db.rawDb.prepare("SELECT value FROM config WHERE key = 'migration_v4_pages_constraint'").get() as { value: string } | null;
    expect(marker?.value).toBe("1");

    db.close();
  });
});

// ════════════════════════════════════════════════════════════════════
// chunks summary_level migration
// ════════════════════════════════════════════════════════════════════

describe("Atomic migrations — chunks summary_level rebuild", () => {
  const testDir = "/tmp/cbrain-test-migration-chunks";
  const dbPath = join(testDir, "brain.sqlite");

  beforeEach(() => freshDir(testDir));
  afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true }); });

  test("chunks rebuild adds summary_level column and writes marker", () => {
    const raw = createPreChunksMigrationDB(dbPath);
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'entity', ?, ?)").run("test-page", "Test", "test-page.md");
    raw.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, 0, 'chunk content')").run("test-page");
    raw.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, 1, 'more content')").run("test-page");
    raw.close();

    const db = new CBrainDB(dbPath);

    const cols = db.rawDb.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map(c => c.name));
    expect(colNames.has("summary_level")).toBe(true);
    expect(colNames.has("content_hash")).toBe(true);

    const rows = db.rawDb.prepare("SELECT page_slug, chunk_index, summary_level FROM chunks ORDER BY chunk_index").all() as Array<{ page_slug: string; chunk_index: number; summary_level: number }>;
    expect(rows.length).toBe(2);
    expect(rows[0].summary_level).toBe(0);
    expect(rows[0].page_slug).toBe("test-page");

    expect(noRow(db.rawDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_new'").get())).toBe(true);

    const marker = db.rawDb.prepare("SELECT value FROM config WHERE key = 'migration_v4_chunks_summary_level'").get() as { value: string } | null;
    expect(marker?.value).toBe("1");

    db.close();
  });

  test("chunks rebuild rolls back when INSERT fails on FK constraint", () => {
    // chunks_new has FK(page_slug) REFERENCES pages(slug).
    // Seed a chunk referencing a non-existent page — INSERT INTO chunks_new fails.
    const raw = createPreChunksMigrationDB(dbPath);
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'entity', ?, ?)").run("valid-page", "Valid", "valid-page.md");
    // Chunk references non-existent page
    raw.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, 0, 'orphan chunk')").run("nonexistent-page");
    raw.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, 0, 'valid chunk')").run("valid-page");
    raw.close();

    // Save pre-migration state
    const preSchema = getTableSQL(new Database(dbPath), "chunks");
    {
      const tmp = new Database(dbPath);
      const cnt = tmp.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as { cnt: number };
      tmp.close();
      expect(cnt.cnt).toBe(2);
    }

    let error: Error | undefined;
    try { new CBrainDB(dbPath); } catch (e) { error = e as Error; }

    expect(error).toBeTruthy();
    expect(error!.message).toContain("migrateChunksSummaryLevel");

    const verify = new Database(dbPath);
    verify.exec("PRAGMA foreign_keys = OFF");

    // Old schema preserved — no summary_level
    const postSchema = getTableSQL(verify, "chunks");
    expect(postSchema).toBe(preSchema);
    expect(postSchema).not.toContain("summary_level");

    // Rows preserved
    const postCount = (verify.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as { cnt: number }).cnt;
    expect(postCount).toBe(2);

    // No chunks_new residual
    expect(noRow(verify.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_new'").get())).toBe(true);

    // Marker NOT written
    const marker = verify.prepare("SELECT value FROM config WHERE key = 'migration_v4_chunks_summary_level'").get() as { value: string } | null;
    expect(marker?.value).not.toBe("1");

    verify.close();
  });

  test("chunks rebuild retry succeeds after fixing orphan reference", () => {
    const raw = createPreChunksMigrationDB(dbPath);
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'entity', ?, ?)").run("valid-page", "Valid", "valid-page.md");
    raw.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, 0, 'orphan chunk')").run("nonexistent-page");
    raw.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, 0, 'valid chunk')").run("valid-page");
    raw.close();

    // First attempt fails
    expect(() => new CBrainDB(dbPath)).toThrow();

    // Fix: remove orphan chunk
    const fix = new Database(dbPath);
    fix.exec("PRAGMA foreign_keys = OFF");
    fix.prepare("DELETE FROM chunks WHERE page_slug = 'nonexistent-page'").run();
    fix.close();

    // Retry succeeds
    const db = new CBrainDB(dbPath);
    const cols = db.rawDb.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>;
    expect(cols.some(c => c.name === "summary_level")).toBe(true);
    const marker = db.rawDb.prepare("SELECT value FROM config WHERE key = 'migration_v4_chunks_summary_level'").get() as { value: string } | null;
    expect(marker?.value).toBe("1");
    db.close();
  });

  test("malformed chunks with wrong UNIQUE does not write marker", () => {
    // Create a DB where summary_level column exists but UNIQUE is wrong
    const raw = createPreChunksMigrationDB(dbPath);
    raw.exec("PRAGMA foreign_keys = OFF");
    // Manually add summary_level but with wrong UNIQUE constraint
    raw.exec(`
      CREATE TABLE chunks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page_slug TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        summary_level INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (page_slug) REFERENCES pages(slug) ON DELETE CASCADE,
        UNIQUE(page_slug, chunk_index)
      );
      INSERT INTO chunks_new SELECT id, page_slug, chunk_index, content, 0, NULL, created_at FROM chunks;
      DROP TABLE chunks;
      ALTER TABLE chunks_new RENAME TO chunks;
    `);
    raw.exec("PRAGMA foreign_keys = ON");
    raw.close();

    // CBrainDB construction: body sees summary_level exists → early return (no rebuild).
    // But validate checks UNIQUE must be (page_slug, summary_level, chunk_index).
    // It's (page_slug, chunk_index) → validate throws → rollback → no marker.
    let error: Error | undefined;
    try { new CBrainDB(dbPath); } catch (e) { error = e as Error; }

    expect(error).toBeTruthy();
    expect(error!.message).toContain("migrateChunksSummaryLevel");

    const verify = new Database(dbPath);
    const marker = verify.prepare("SELECT value FROM config WHERE key = 'migration_v4_chunks_summary_level'").get() as { value: string } | null;
    expect(marker?.value).not.toBe("1");
    verify.close();
  });
});

// ════════════════════════════════════════════════════════════════════
// ontology types migration
// ════════════════════════════════════════════════════════════════════

describe("Atomic migrations — ontology types rebuild", () => {
  const testDir = "/tmp/cbrain-test-migration-ontology";
  const dbPath = join(testDir, "brain.sqlite");

  beforeEach(() => freshDir(testDir));
  afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true }); });

  test("ontology migration adds columns and converts flat types", () => {
    const raw = createPreOntologyMigrationDB(dbPath);
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'entity', ?, ?)").run("brain/entities/person/john", "实体A", "brain/entities/person/john.md");
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'concept', ?, ?)").run("brain/concepts/concept-1", "概念B", "brain/concepts/concept-1.md");
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'record', ?, ?)").run("records/note-1", "记录C", "records/note-1.md");
    raw.close();

    const db = new CBrainDB(dbPath);

    const entity = db.rawDb.prepare("SELECT type FROM pages WHERE slug = 'brain/entities/person/john'").get() as { type: string };
    expect(entity.type).toBe("entity/person");
    const concept = db.rawDb.prepare("SELECT type FROM pages WHERE slug = 'brain/concepts/concept-1'").get() as { type: string };
    expect(concept.type).toBe("concept/concept");
    const record = db.rawDb.prepare("SELECT type FROM pages WHERE slug = 'records/note-1'").get() as { type: string };
    expect(record.type).toBe("record");

    const cols = db.rawDb.prepare("PRAGMA table_info(pages)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map(c => c.name));
    expect(colNames.has("activity_weight")).toBe(true);
    expect(colNames.has("hotness_score")).toBe(true);

    const schema = db.rawDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pages'").get() as { sql: string };
    expect(schema.sql).not.toContain("CHECK(type IN");

    const marker = db.rawDb.prepare("SELECT value FROM config WHERE key = 'migration_v6_ontology_types'").get() as { value: string } | null;
    expect(marker?.value).toBe("1");

    db.close();
  });

  test("ontology rebuild rolls back on CHECK violation from invalid tier", () => {
    // pages_new has CHECK(tier BETWEEN 1 AND 3).
    // Seed a page with tier=0 — this passes the old CHECK (which doesn't check tier)
    // Wait, old pages also has CHECK(tier BETWEEN 1 AND 3). Need a different injection.
    //
    // Actually: the ontology pages_new has MORE columns than old pages.
    // The INSERT INTO pages_new SELECT ... COALESCE(activity_weight, 0.0) ...
    // If old pages doesn't have activity_weight, COALESCE(NULL, 0.0) = 0.0 — that works.
    //
    // Better injection: create a pages table WITHOUT CHECK(tier ...) but with tier=0,
    // so the INSERT into pages_new (which has CHECK(tier BETWEEN 1 AND 3)) fails.
    // Actually the pre-ontology fixture already has CHECK(tier...). Let me just
    // use the createPreOntologyMigrationDB with injectFailure=true.
    //
    // The fixture injects tier=0 which violates CHECK(tier BETWEEN 1 AND 3).
    // But wait — the old pages table also has that CHECK. So tier=0 can't be inserted.
    //
    // I need to think differently. What if I create pages without the tier CHECK,
    // insert tier=0, then the ontology pages_new (with CHECK) rejects it?
    const raw = new Database(dbPath);
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec("PRAGMA foreign_keys = OFF");
    // Pages WITHOUT CHECK on tier
    raw.exec(`
      CREATE TABLE pages (
        slug TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('entity', 'concept', 'record', 'insight')),
        title TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content_hash TEXT,
        tier INTEGER DEFAULT 3,
        mention_count INTEGER DEFAULT 0,
        expires_at TEXT,
        confidence_decay REAL DEFAULT 1.0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page_slug TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        summary_level INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(page_slug, summary_level, chunk_index)
      );
      CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_slug TEXT NOT NULL, to_slug TEXT NOT NULL,
        relation TEXT NOT NULL DEFAULT 'mentions',
        weight REAL DEFAULT 1.0, context TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(from_slug, to_slug, relation)
      );
      CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, page_slug TEXT NOT NULL, tag TEXT NOT NULL, UNIQUE(page_slug, tag));
      CREATE TABLE timeline (id INTEGER PRIMARY KEY AUTOINCREMENT, page_slug TEXT NOT NULL, event_date TEXT, source TEXT, summary TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE ingest_log (id INTEGER PRIMARY KEY AUTOINCREMENT, source_type TEXT NOT NULL, action TEXT NOT NULL, page_slug TEXT, details TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE versions (id INTEGER PRIMARY KEY AUTOINCREMENT, page_slug TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL, frontmatter TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(page_slug, version));
      CREATE TABLE aliases (id INTEGER PRIMARY KEY AUTOINCREMENT, page_slug TEXT NOT NULL, alias TEXT NOT NULL, UNIQUE(page_slug, alias));
      CREATE INDEX idx_pages_type ON pages(type);
      CREATE INDEX idx_pages_tier ON pages(tier);
      CREATE INDEX idx_links_from ON links(from_slug);
      CREATE INDEX idx_links_to ON links(to_slug);
      CREATE INDEX idx_chunks_page ON chunks(page_slug);
      CREATE INDEX idx_versions_page ON versions(page_slug);
      CREATE INDEX idx_aliases_alias ON aliases(alias);
    `);
    // Mark upstream migrations as done
    raw.exec("INSERT INTO config (key, value) VALUES ('migration_v4_pages_constraint', '1')");
    raw.exec("INSERT INTO config (key, value) VALUES ('migration_v4_chunks_summary_level', '1')");
    raw.exec("INSERT INTO config (key, value) VALUES ('migration_v5_raw_to_records', '1')");
    // Seed data: valid page + page with tier=0
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'entity', ?, ?)").run("good-page", "Good Page", "good-page.md");
    raw.prepare("INSERT INTO pages (slug, type, title, file_path, tier) VALUES (?, 'entity', ?, ?, 0)").run("bad-tier", "Bad Tier", "bad-tier.md");
    raw.exec("PRAGMA foreign_keys = ON");
    raw.close();

    let error: Error | undefined;
    try { new CBrainDB(dbPath); } catch (e) { error = e as Error; }

    expect(error).toBeTruthy();
    expect(error!.message).toContain("migrateOntologyTypes");

    const verify = new Database(dbPath);
    verify.exec("PRAGMA foreign_keys = OFF");

    // The ontology rebuild (CREATE pages_new → INSERT → DROP → RENAME) rolled back,
    // so pages table still has the old CHECK(type IN ...) constraint.
    // ALTER TABLE migrations that ran BEFORE ontology are committed separately and persist.
    const postSchema = getTableSQL(verify, "pages");
    expect(postSchema).toContain("CHECK(type IN"); // ontology would have removed this

    // Both rows preserved with original data
    const good = verify.prepare("SELECT type FROM pages WHERE slug = 'good-page'").get() as { type: string };
    expect(good.type).toBe("entity");
    const bad = verify.prepare("SELECT tier FROM pages WHERE slug = 'bad-tier'").get() as { tier: number };
    expect(bad.tier).toBe(0);

    // No pages_new residual
    expect(noRow(verify.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pages_new'").get())).toBe(true);

    // Marker NOT written
    const marker = verify.prepare("SELECT value FROM config WHERE key = 'migration_v6_ontology_types'").get() as { value: string } | null;
    expect(marker?.value).not.toBe("1");

    verify.close();
  });

  test("ontology rebuild retry succeeds after fixing bad data", () => {
    const raw = new Database(dbPath);
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec(`
      CREATE TABLE pages (
        slug TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('entity', 'concept', 'record', 'insight')),
        title TEXT NOT NULL, file_path TEXT NOT NULL, content_hash TEXT,
        tier INTEGER DEFAULT 3, mention_count INTEGER DEFAULT 0,
        expires_at TEXT, confidence_decay REAL DEFAULT 1.0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page_slug TEXT NOT NULL, chunk_index INTEGER NOT NULL, content TEXT NOT NULL,
        summary_level INTEGER NOT NULL DEFAULT 0, content_hash TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(page_slug, summary_level, chunk_index)
      );
      CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE links (id INTEGER PRIMARY KEY AUTOINCREMENT, from_slug TEXT NOT NULL, to_slug TEXT NOT NULL, relation TEXT NOT NULL DEFAULT 'mentions', weight REAL DEFAULT 1.0, context TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(from_slug, to_slug, relation));
      CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, page_slug TEXT NOT NULL, tag TEXT NOT NULL, UNIQUE(page_slug, tag));
      CREATE TABLE timeline (id INTEGER PRIMARY KEY AUTOINCREMENT, page_slug TEXT NOT NULL, event_date TEXT, source TEXT, summary TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE ingest_log (id INTEGER PRIMARY KEY AUTOINCREMENT, source_type TEXT NOT NULL, action TEXT NOT NULL, page_slug TEXT, details TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE versions (id INTEGER PRIMARY KEY AUTOINCREMENT, page_slug TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL, frontmatter TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(page_slug, version));
      CREATE TABLE aliases (id INTEGER PRIMARY KEY AUTOINCREMENT, page_slug TEXT NOT NULL, alias TEXT NOT NULL, UNIQUE(page_slug, alias));
      CREATE INDEX idx_pages_type ON pages(type);
      CREATE INDEX idx_pages_tier ON pages(tier);
      CREATE INDEX idx_links_from ON links(from_slug);
      CREATE INDEX idx_links_to ON links(to_slug);
      CREATE INDEX idx_chunks_page ON chunks(page_slug);
      CREATE INDEX idx_versions_page ON versions(page_slug);
      CREATE INDEX idx_aliases_alias ON aliases(alias);
    `);
    raw.exec("INSERT INTO config (key, value) VALUES ('migration_v4_pages_constraint', '1')");
    raw.exec("INSERT INTO config (key, value) VALUES ('migration_v4_chunks_summary_level', '1')");
    raw.exec("INSERT INTO config (key, value) VALUES ('migration_v5_raw_to_records', '1')");
    raw.prepare("INSERT INTO pages (slug, type, title, file_path, tier) VALUES (?, 'entity', ?, ?, 0)").run("bad-tier", "Bad Tier", "bad-tier.md");
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'entity', ?, ?)").run("brain/entities/person/john", "实体A", "brain/entities/person/john.md");
    raw.exec("PRAGMA foreign_keys = ON");
    raw.close();

    // First attempt fails
    expect(() => new CBrainDB(dbPath)).toThrow();

    // Fix: correct the tier
    const fix = new Database(dbPath);
    fix.exec("PRAGMA foreign_keys = OFF");
    fix.prepare("UPDATE pages SET tier = 3 WHERE tier = 0").run();
    fix.close();

    // Retry succeeds
    const db = new CBrainDB(dbPath);
    const entity = db.rawDb.prepare("SELECT type FROM pages WHERE slug = 'brain/entities/person/john'").get() as { type: string };
    expect(entity.type).toBe("entity/person");
    const marker = db.rawDb.prepare("SELECT value FROM config WHERE key = 'migration_v6_ontology_types'").get() as { value: string } | null;
    expect(marker?.value).toBe("1");
    db.close();
  });

  test("ontology migration is idempotent after marker", () => {
    const raw = createPreOntologyMigrationDB(dbPath);
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'entity', ?, ?)").run("brain/entities/person/john", "实体A", "brain/entities/person/john.md");
    raw.close();

    const db1 = new CBrainDB(dbPath);
    db1.close();

    const db2 = new CBrainDB(dbPath);
    const entity = db2.rawDb.prepare("SELECT type FROM pages WHERE slug = 'brain/entities/person/john'").get() as { type: string };
    expect(entity.type).toBe("entity/person");
    db2.close();
  });
});

// ════════════════════════════════════════════════════════════════════
// Cross-cutting: FK state, integrity, constructor cleanup
// ════════════════════════════════════════════════════════════════════

describe("Atomic migrations — cross-cutting", () => {
  const testDir = "/tmp/cbrain-test-migration-cross";
  const dbPath = join(testDir, "brain.sqlite");

  beforeEach(() => freshDir(testDir));
  afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true }); });

  test("FK state is ON after successful migration", () => {
    const raw = createPreV4DB(dbPath);
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'entity', ?, ?)").run("test-page", "Test", "test-page.md");
    raw.close();

    const db = new CBrainDB(dbPath);
    const fk = db.rawDb.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
    db.close();
  });

  test("FK state restored to ON after runner failure on same connection", () => {
    // Construct a DB with valid data so the constructor succeeds.
    // Then call runDestructiveMigration via (db as any) with a body that throws.
    // Verify FK is still ON on the same rawDb connection after the failure.
    const raw = createPreV4DB(dbPath);
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'entity', ?, ?)").run("test-page", "Test", "test-page.md");
    raw.close();

    const db = new CBrainDB(dbPath);

    // FK should be ON after successful construction
    const fkBefore = db.rawDb.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(fkBefore.foreign_keys).toBe(1);

    // Call runDestructiveMigration with a failing body — must not corrupt FK state
    expect(() => {
      (db as any).runDestructiveMigration({
        name: "test_fail",
        completionKey: "test_fail_marker",
        body: () => { throw new Error("injected failure"); },
      });
    }).toThrow("test_fail");

    // FK state must be restored to ON on the SAME connection
    const fkAfter = db.rawDb.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(fkAfter.foreign_keys).toBe(1);

    // Marker must NOT be written
    const marker = db.rawDb.prepare("SELECT value FROM config WHERE key = 'test_fail_marker'").get() as { value: string } | null;
    expect(marker?.value).not.toBe("1");

    db.close();
  });

  test("FK state restored to OFF after runner failure when originally OFF", () => {
    // Verify the runner restores the original FK state, not blindly sets ON.
    const raw = createPreV4DB(dbPath);
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'entity', ?, ?)").run("test-page", "Test", "test-page.md");
    raw.close();

    const db = new CBrainDB(dbPath);

    // Manually turn FK OFF on the connection
    db.rawDb.exec("PRAGMA foreign_keys = OFF");
    const fkOff = db.rawDb.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(fkOff.foreign_keys).toBe(0);

    // Run a failing migration — runner should restore FK to OFF (the pre-call state)
    expect(() => {
      (db as any).runDestructiveMigration({
        name: "test_fail_off",
        completionKey: "test_fail_off_marker",
        body: () => { throw new Error("injected failure"); },
      });
    }).toThrow("test_fail_off");

    // FK state must be restored to OFF, not forced to ON
    const fkAfter = db.rawDb.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(fkAfter.foreign_keys).toBe(0);

    db.close();
  });

  test("integrity check passes after successful migration", () => {
    const raw = createPreV4DB(dbPath);
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'entity', ?, ?)").run("test-page", "Test", "test-page.md");
    raw.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, 0, 'content')").run("test-page");
    raw.close();

    const db = new CBrainDB(dbPath);
    const result = db.rawDb.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    expect(result.integrity_check).toBe("ok");
    db.close();
  });

  test("constructor closes DB on migration failure", () => {
    const raw = createPreV5DB(dbPath);
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'record', ?, ?)").run("raw/collision", "Collision Raw", "raw/collision.md");
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'record', ?, ?)").run("records/collision", "Collision Records", "records/collision.md");
    raw.close();

    expect(() => new CBrainDB(dbPath)).toThrow();

    // DB file should still be usable (not locked/corrupted)
    const verify = new Database(dbPath);
    verify.exec("PRAGMA journal_mode = WAL");
    const count = verify.prepare("SELECT COUNT(*) as cnt FROM pages").get() as { cnt: number };
    expect(count.cnt).toBe(2);
    verify.close();
  });
});

// ════════════════════════════════════════════════════════════════════
// Index regression — verify pages indexes survive table rebuilds
// ════════════════════════════════════════════════════════════════════

describe("Atomic migrations — index preservation after rebuild", () => {
  const testDir = "/tmp/cbrain-test-migration-indexes";
  const dbPath = join(testDir, "brain.sqlite");

  // Complete set of pages indexes that must exist after construction.
  // Includes partial indexes (activity_wt, expires_at).
  const EXPECTED_PAGE_INDEXES = [
    "idx_pages_type",
    "idx_pages_tier",
    "idx_pages_title",
    "idx_pages_updated_at",
    "idx_pages_created_at",
    "idx_pages_activity_wt",
    "idx_pages_expires_at",
    "idx_pages_title_uniq",
  ];

  /** Get all index names on the pages table */
  function getPagesIndexes(db: Database): Set<string> {
    const rows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pages'"
    ).all() as Array<{ name: string }>;
    return new Set(rows.map(r => r.name));
  }

  function assertAllIndexesPresent(db: Database): void {
    const indexes = getPagesIndexes(db);
    for (const idx of EXPECTED_PAGE_INDEXES) {
      expect(indexes.has(idx)).toBe(true);
    }
  }

  beforeEach(() => freshDir(testDir));
  afterEach(() => { if (existsSync(testDir)) rmSync(testDir, { recursive: true }); });

  test("fresh DB construction preserves all pages indexes", () => {
    const db = new CBrainDB(dbPath);

    db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'entity/person', ?, ?)").run(
      "brain/entities/person/shi-ti-a", "实体A", "brain/entities/person/shi-ti-a.md"
    );
    db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'record', ?, ?)").run(
      "records/ji-lu-1", "记录甲", "records/ji-lu-1.md"
    );

    assertAllIndexesPresent(db.rawDb);

    // Verify unique index actually rejects duplicates
    expect(() => {
      db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'record', ?, ?)").run(
        "records/ji-lu-1-dup", "记录甲", "records/ji-lu-1-dup.md"
      );
    }).toThrow();

    db.close();
  });

  test("legacy pre-v4 migration preserves all pages indexes", () => {
    const raw = createPreV4DB(dbPath);
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'entity', ?, ?)").run(
      "brain/entities/person/shi-ti-b", "实体B", "brain/entities/person/shi-ti-b.md"
    );
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'record', ?, ?)").run(
      "legacy-record", "旧记录", "legacy-record.md"
    );
    raw.close();

    const db = new CBrainDB(dbPath);
    assertAllIndexesPresent(db.rawDb);

    expect(() => {
      db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'entity/person', ?, ?)").run(
        "brain/entities/person/shi-ti-b-dup", "实体B", "brain/entities/person/shi-ti-b-dup.md"
      );
    }).toThrow();

    db.close();
  });

  test("legacy ontology migration preserves all pages indexes", () => {
    const raw = createPreOntologyMigrationDB(dbPath);
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'entity', ?, ?)").run(
      "brain/entities/person/shi-ti-c", "实体C", "brain/entities/person/shi-ti-c.md"
    );
    raw.close();

    const db = new CBrainDB(dbPath);
    assertAllIndexesPresent(db.rawDb);

    expect(() => {
      db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'entity/person', ?, ?)").run(
        "brain/entities/person/shi-ti-c-dup", "实体C", "brain/entities/person/shi-ti-c-dup.md"
      );
    }).toThrow();

    db.close();
  });

  test("legacy duplicate titles: real ontology rebuild preserves data and warns", () => {
    // Use a pre-ontology fixture with duplicate titles and NO v6 marker.
    // This exercises the REAL ontology migration path — ensurePagesIndexes
    // skips idx_pages_title_uniq, validatePagesIndexes must also tolerate
    // its absence when duplicates exist.
    const raw = createPreOntologyMigrationDB(dbPath);
    // Seed two pages with the same title but different slugs/types
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'entity', ?, ?)").run(
      "brain/entities/person/shi-ti-d", "实体D", "brain/entities/person/shi-ti-d.md"
    );
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'entity', ?, ?)").run(
      "brain/entities/company/shi-ti-d", "实体D", "brain/entities/company/shi-ti-d.md"
    );
    raw.close();

    // Spy on console.warn with try/finally to guarantee restore
    const warnMessages: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnMessages.push(String(args[1] ?? args[0])); };

    let db: CBrainDB;
    try {
      db = new CBrainDB(dbPath);
    } finally {
      console.warn = origWarn;
    }

    // Both pages must still exist (ontology rebuild preserved them)
    const count = db.rawDb.prepare("SELECT COUNT(*) as cnt FROM pages WHERE title = '实体D'").get() as { cnt: number };
    expect(count.cnt).toBe(2);

    // Ontology migration marker must be written (migration actually ran)
    const marker = db.rawDb.prepare("SELECT value FROM config WHERE key = 'migration_v6_ontology_types'").get() as { value: string } | undefined;
    expect(marker?.value).toBe("1");

    // Warning must have been emitted about duplicate titles
    expect(warnMessages.some(m => m.includes("duplicate titles"))).toBe(true);

    // Non-unique indexes must exist; unique index must NOT (duplicates prevent it)
    const indexes = getPagesIndexes(db.rawDb);
    for (const idx of EXPECTED_PAGE_INDEXES) {
      if (idx === "idx_pages_title_uniq") {
        expect(indexes.has(idx)).toBe(false);
      } else {
        expect(indexes.has(idx)).toBe(true);
      }
    }

    db.close();
  });

  test("index creation failure (schema conflict) prevents startup", () => {
    // Create a DB where an index name is already taken by a non-index object
    // (a table with the same name as an expected index), which will cause
    // CREATE INDEX to fail with a real error — not a "missing column" case.
    const raw = new Database(dbPath);
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec(`
      CREATE TABLE pages (
        slug TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, file_path TEXT NOT NULL,
        content_hash TEXT, tier INTEGER DEFAULT 3, mention_count INTEGER DEFAULT 0,
        expires_at TEXT, confidence_decay REAL DEFAULT 1.0, activity_weight REAL DEFAULT 0.0,
        last_queried_at TEXT, hotness_score REAL NOT NULL DEFAULT 0.0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    raw.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    raw.exec("CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, page_slug TEXT NOT NULL, chunk_index INTEGER NOT NULL, content TEXT NOT NULL, summary_level INTEGER NOT NULL DEFAULT 0, content_hash TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(page_slug, summary_level, chunk_index))");
    raw.exec("CREATE TABLE links (id INTEGER PRIMARY KEY AUTOINCREMENT, from_slug TEXT NOT NULL, to_slug TEXT NOT NULL, relation TEXT NOT NULL DEFAULT 'mentions', weight REAL DEFAULT 1.0, context TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(from_slug, to_slug, relation))");
    raw.exec("CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, page_slug TEXT NOT NULL, tag TEXT NOT NULL, UNIQUE(page_slug, tag))");
    raw.exec("CREATE TABLE timeline (id INTEGER PRIMARY KEY AUTOINCREMENT, page_slug TEXT NOT NULL, event_date TEXT, source TEXT, summary TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    raw.exec("CREATE TABLE ingest_log (id INTEGER PRIMARY KEY AUTOINCREMENT, source_type TEXT NOT NULL, action TEXT NOT NULL, page_slug TEXT, details TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    raw.exec("CREATE TABLE versions (id INTEGER PRIMARY KEY AUTOINCREMENT, page_slug TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL, frontmatter TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(page_slug, version))");
    raw.exec("CREATE TABLE aliases (id INTEGER PRIMARY KEY AUTOINCREMENT, page_slug TEXT NOT NULL, alias TEXT NOT NULL, UNIQUE(page_slug, alias))");
    raw.exec("INSERT INTO config VALUES ('migration_v4_pages_constraint', '1')");
    raw.exec("INSERT INTO config VALUES ('migration_v4_chunks_summary_level', '1')");
    raw.exec("INSERT INTO config VALUES ('migration_v5_raw_to_records', '1')");
    raw.exec("INSERT INTO config VALUES ('migration_v6_ontology_types', '1')");
    // Seed a page so no title collision
    raw.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'entity/person', ?, ?)").run(
      "brain/entities/person/shi-ti-e", "实体E", "brain/entities/person/shi-ti-e.md"
    );
    // Create a VIEW with the same name as an expected index — this causes
    // CREATE INDEX to fail with "there is already another table or index with this name"
    raw.exec("CREATE VIEW idx_pages_title AS SELECT 1");
    raw.exec("PRAGMA foreign_keys = ON");
    raw.close();

    // CBrainDB construction must fail — the schema conflict is a real error,
    // not a "missing column" or "duplicate title" situation
    let error: Error | undefined;
    try { new CBrainDB(dbPath); } catch (e) { error = e as Error; }

    expect(error).toBeTruthy();
    // Error should NOT be swallowed — it must mention the conflicting index name
    expect(error!.message).toContain("idx_pages_title");

    // DB must still be usable (constructor closed it cleanly)
    const verify = new Database(dbPath);
    verify.exec("PRAGMA journal_mode = WAL");
    const page = verify.prepare("SELECT title FROM pages WHERE slug = 'brain/entities/person/shi-ti-e'").get() as { title: string };
    expect(page.title).toBe("实体E");
    verify.close();
  });
});

// ─── runDestructiveMigration FK failure → FKMigrationError (#209) ────

describe("runDestructiveMigration FK failure → summarized FKMigrationError (#209)", () => {
  const tmp = "/tmp/cbrain-test-fk-migration";
  beforeEach(() => { if (existsSync(tmp)) rmSync(tmp, { recursive: true }); mkdirSync(tmp, { recursive: true }); });
  afterEach(() => { if (existsSync(tmp)) rmSync(tmp, { recursive: true }); });

  test("FK violation throws FKMigrationError with by-table counts, no raw rowids", () => {
    const dbPath = join(tmp, "brain.sqlite");
    const db = new CBrainDB(dbPath); // 空 DB: initSchema + migrate 干净通过
    // 手动制造 orphan derived rows(绕 FK,模拟 legacy 数据债)
    const internal = (db as unknown as { db: Database }).db;
    internal.exec("PRAGMA foreign_keys = OFF");
    internal.prepare("INSERT INTO tags (page_slug, tag) VALUES ('orphan-a', 'x'), ('orphan-b', 'y')").run();
    internal.exec("PRAGMA foreign_keys = ON");

    expect(() => runDestructiveMigrationForTest(db, "test-migration", "test.fk.test", () => {}))
      .toThrow(FKMigrationError);
    try {
      runDestructiveMigrationForTest(db, "test-migration", "test.fk.test", () => {});
    } catch (e) {
      const err = e as FKMigrationError;
      expect(err).toBeInstanceOf(FKMigrationError);
      expect(err.migrationName).toBe("test-migration");
      expect(err.total).toBe(2);
      expect(err.violationsByTable.tags).toBe(2);
      // anonymized: message carries no slug/tag value
      expect(err.message).not.toMatch(/orphan-a|orphan-b/);
    }
    db.close();
  });
});

// ─── Helper ──────────────────────────────────────────────────────

function verifyPageCount(db: Database, expected: number): boolean {
  const count = db.prepare("SELECT COUNT(*) as cnt FROM pages").get() as { cnt: number };
  return count.cnt === expected;
}

// ─── repairOrphanedDerivedRows (#209) ──────────────────────────────

describe("repairOrphanedDerivedRows (#209)", () => {
  const tmp = "/tmp/cbrain-test-fk-repair";
  beforeEach(() => { if (existsSync(tmp)) rmSync(tmp, { recursive: true }); mkdirSync(tmp, { recursive: true }); });
  afterEach(() => { if (existsSync(tmp)) rmSync(tmp, { recursive: true }); });

  test("deletes orphan derived rows; valid (non-orphan) rows + pages untouched; FK clean after", () => {
    const dbPath = join(tmp, "brain.sqlite");
    const db = new CBrainDB(dbPath); // 空 DB: initSchema + migrate 干净通过
    const internal = (db as unknown as { db: Database }).db;
    // legacy 数据债:orphan tags(2,引用不存在的 page)+ 一个合法 tag(real-page)
    internal.exec("PRAGMA foreign_keys = OFF");
    internal.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES ('real-page', 'note', 't', 'real.md')").run();
    internal.prepare("INSERT INTO tags (page_slug, tag) VALUES ('real-page', 'keep'), ('orphan-1', 'drop1'), ('orphan-2', 'drop2')").run();
    internal.exec("PRAGMA foreign_keys = ON");

    const before = db.checkFkViolations();
    expect(before.total).toBe(2); // 2 orphan tags
    expect(before.byTable.tags).toBe(2);

    const result = db.repairOrphanedDerivedRows();
    expect(result.repairedByTable.tags).toBe(2);
    expect(result.remaining).toBe(0);

    const remainingTags = internal.prepare("SELECT COUNT(*) c FROM tags").get() as { c: number };
    expect(remainingTags.c).toBe(1); // real-page's tag survives (non-orphan)
    const pages = internal.prepare("SELECT COUNT(*) c FROM pages").get() as { c: number };
    expect(pages.c).toBe(1); // pages NEVER deleted
    db.close();
  });
});
