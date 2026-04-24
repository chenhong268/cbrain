import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";

describe("CBrainDB", () => {
  const testDir = "/tmp/cbrain-test-db";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("creates database file with WAL mode", () => {
    expect(existsSync(dbPath)).toBe(true);
    const result = db.prepare("PRAGMA journal_mode").get() as any;
    expect(result.journal_mode).toBe("wal");
  });

  test("creates all required tables", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as any[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("pages");
    expect(names).toContain("links");
    expect(names).toContain("tags");
    expect(names).toContain("timeline");
    expect(names).toContain("chunks");
    expect(names).toContain("ingest_log");
    expect(names).toContain("config");
  });

  test("insert and query a page", () => {
    db.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
    ).run("entities/test", "entity", "Test", "entities/test.md", "abc123");

    const row = db
      .prepare("SELECT * FROM pages WHERE slug = ?")
      .get("entities/test") as any;
    expect(row.title).toBe("Test");
    expect(row.type).toBe("entity");
    expect(row.tier).toBe(3);
    expect(row.mention_count).toBe(0);
  });

  test("transaction rolls back on error", () => {
    expect(() => {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
        ).run("entities/tx-test", "entity", "TX Test", "tx.md", "hash");

        throw new Error("rollback");
      });
    }).toThrow("rollback");

    const row = db
      .prepare("SELECT * FROM pages WHERE slug = ?")
      .get("entities/tx-test");
    expect(row).toBeNull();
  });
});
