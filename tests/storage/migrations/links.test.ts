import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLinkMigrations } from "../../../src/storage/migrations/index.js";

describe("runLinkMigrations", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function legacyDb(): Database {
    const dir = mkdtempSync(join(tmpdir(), "cbrain-links-migration-"));
    dirs.push(dir);
    const db = new Database(join(dir, "brain.sqlite"));
    db.exec(`
      CREATE TABLE links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_slug TEXT NOT NULL,
        to_slug TEXT NOT NULL,
        relation TEXT NOT NULL,
        context TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.prepare(
      "INSERT INTO links (from_slug, to_slug, relation, context, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("entity/source-a", "entity/target-b", "mentions", "匿名上下文", "2026-01-01T00:00:00Z");
    return db;
  }

  test("adds links weight, credibility, decay columns and index to legacy schema", () => {
    const db = legacyDb();
    try {
      runLinkMigrations(db);

      const columns = db.prepare("PRAGMA table_info(links)").all() as Array<{ name: string }>;
      const names = new Set(columns.map((column) => column.name));
      expect(names).toContain("weight");
      expect(names).toContain("strength");
      expect(names).toContain("source_type");
      expect(names).toContain("confidence");
      expect(names).toContain("last_validated_at");
      expect(names).toContain("effective_weight");

      const row = db.prepare("SELECT * FROM links").get() as {
        weight: number;
        strength: string;
        source_type: string;
        confidence: number;
        created_at: string;
        last_validated_at: string;
        effective_weight: number;
      };
      expect(row.weight).toBe(1);
      expect(row.strength).toBe("medium");
      expect(row.source_type).toBe("unknown");
      expect(row.confidence).toBe(0.5);
      expect(row.last_validated_at).toBe(row.created_at);
      expect(row.effective_weight).toBe(row.weight * row.confidence);

      const indexes = db.prepare("PRAGMA index_list(links)").all() as Array<{ name: string }>;
      expect(indexes.map((index) => index.name)).toContain("idx_links_last_validated");
    } finally {
      db.close();
    }
  });
});
