import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPageMigrations } from "../../../src/storage/migrations/index.js";

describe("runPageMigrations", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function legacyPagesDb(): Database {
    const dir = mkdtempSync(join(tmpdir(), "cbrain-pages-migration-"));
    dirs.push(dir);
    const db = new Database(join(dir, "brain.sqlite"));
    db.exec(`
      CREATE TABLE pages (
        slug TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content_hash TEXT,
        tier INTEGER DEFAULT 3,
        mention_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, ?, ?, ?)").run(
      "entity/a",
      "entity/person",
      "实体A",
      "brain/entities/a.md",
    );
    db.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, ?, ?, ?)").run(
      "records/b",
      "record",
      "记录B",
      "brain/records/b.md",
    );
    return db;
  }

  test("adds expiry columns and backfills only entity pages", () => {
    const db = legacyPagesDb();
    try {
      runPageMigrations(db);

      const columns = db.prepare("PRAGMA table_info(pages)").all() as Array<{ name: string }>;
      const names = new Set(columns.map((column) => column.name));
      expect(names).toContain("expires_at");
      expect(names).toContain("confidence_decay");

      const rows = db.prepare("SELECT slug, expires_at, confidence_decay FROM pages ORDER BY slug").all() as Array<{
        slug: string;
        expires_at: string | null;
        confidence_decay: number;
      }>;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ slug: "entity/a", confidence_decay: 1 });
      expect(rows[0].expires_at).toBeTruthy();
      expect(rows[1]).toMatchObject({ slug: "records/b", expires_at: null, confidence_decay: 1 });
    } finally {
      db.close();
    }
  });

  test("is idempotent and preserves existing expiry values", () => {
    const db = legacyPagesDb();
    try {
      db.exec("ALTER TABLE pages ADD COLUMN expires_at TEXT");
      db.exec("ALTER TABLE pages ADD COLUMN confidence_decay REAL DEFAULT 1.0");
      db.prepare("UPDATE pages SET expires_at = ? WHERE slug = ?").run("2026-12-31T00:00:00Z", "entity/a");

      runPageMigrations(db);
      runPageMigrations(db);

      const entity = db.prepare("SELECT expires_at, confidence_decay FROM pages WHERE slug = ?").get("entity/a") as {
        expires_at: string;
        confidence_decay: number;
      };
      const record = db.prepare("SELECT expires_at FROM pages WHERE slug = ?").get("records/b") as { expires_at: string | null };
      expect(entity).toEqual({ expires_at: "2026-12-31T00:00:00Z", confidence_decay: 1 });
      expect(record.expires_at).toBeNull();
    } finally {
      db.close();
    }
  });
});
