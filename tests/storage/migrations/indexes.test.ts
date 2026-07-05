import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMissingIndexMigrations } from "../../../src/storage/migrations/index.js";

describe("runMissingIndexMigrations", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function openDb(): Database {
    const dir = mkdtempSync(join(tmpdir(), "cbrain-index-migrations-"));
    dirs.push(dir);
    const db = new Database(join(dir, "brain.sqlite"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      CREATE TABLE pages (
        slug TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content_hash TEXT,
        tier INTEGER DEFAULT 3,
        mention_count INTEGER DEFAULT 0,
        expires_at TEXT,
        confidence_decay REAL DEFAULT 1.0,
        activity_weight REAL DEFAULT 0.0,
        last_queried_at TEXT,
        hotness_score REAL NOT NULL DEFAULT 0.0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
      CREATE TABLE ingest_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,
        action TEXT NOT NULL,
        page_slug TEXT,
        details TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    return db;
  }

  function indexNames(db: Database): Set<string> {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
  }

  test("creates page, tag, timeline, and ingest log indexes", () => {
    const db = openDb();
    try {
      runMissingIndexMigrations(db);

      const indexes = indexNames(db);
      for (const expected of [
        "idx_pages_type",
        "idx_pages_tier",
        "idx_pages_title",
        "idx_pages_updated_at",
        "idx_pages_created_at",
        "idx_pages_activity_wt",
        "idx_pages_expires_at",
        "idx_pages_title_uniq",
        "idx_tags_page_slug",
        "idx_timeline_page_slug",
        "idx_ingest_log_created",
      ]) {
        expect(indexes.has(expected)).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  test("is idempotent and skips only title unique index when duplicate titles exist", () => {
    const db = openDb();
    try {
      db.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'entity/person', ?, ?)").run(
        "brain/entities/person/shi-ti-a",
        "实体A",
        "brain/entities/person/shi-ti-a.md",
      );
      db.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, 'entity/company', ?, ?)").run(
        "brain/entities/company/shi-ti-a",
        "实体A",
        "brain/entities/company/shi-ti-a.md",
      );

      runMissingIndexMigrations(db);
      runMissingIndexMigrations(db);

      const indexes = indexNames(db);
      expect(indexes.has("idx_pages_title_uniq")).toBe(false);
      expect(indexes.has("idx_pages_title")).toBe(true);
      expect(indexes.has("idx_tags_page_slug")).toBe(true);
      expect(indexes.has("idx_timeline_page_slug")).toBe(true);
      expect(indexes.has("idx_ingest_log_created")).toBe(true);
    } finally {
      db.close();
    }
  });

  test("propagates real schema conflicts instead of swallowing index errors", () => {
    const db = openDb();
    try {
      db.exec("CREATE VIEW idx_pages_title AS SELECT 1");

      expect(() => runMissingIndexMigrations(db)).toThrow("idx_pages_title");
    } finally {
      db.close();
    }
  });
});
