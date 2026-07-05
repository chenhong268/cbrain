import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAliasMigrations } from "../../../src/storage/migrations/index.js";

describe("runAliasMigrations", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeDb(schema: "legacy" | "current"): Database {
    const dir = mkdtempSync(join(tmpdir(), "cbrain-alias-migration-"));
    dirs.push(dir);
    const db = new Database(join(dir, "brain.sqlite"));
    db.exec(`
      CREATE TABLE aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page_slug TEXT NOT NULL,
        alias TEXT NOT NULL,
        ${schema === "current" ? "source TEXT DEFAULT 'manual'," : ""}
        UNIQUE(page_slug, alias)
      );
    `);
    return db;
  }

  test("adds source column to legacy aliases and backfills default manual", () => {
    const db = makeDb("legacy");
    try {
      db.prepare("INSERT INTO aliases (page_slug, alias) VALUES (?, ?)").run("entity/a", "别名A");

      runAliasMigrations(db);

      const columns = db.prepare("PRAGMA table_info(aliases)").all() as Array<{ name: string }>;
      expect(new Set(columns.map((column) => column.name))).toContain("source");
      const row = db.prepare("SELECT page_slug, alias, source FROM aliases").get() as {
        page_slug: string;
        alias: string;
        source: string;
      };
      expect(row).toEqual({ page_slug: "entity/a", alias: "别名A", source: "manual" });
    } finally {
      db.close();
    }
  });

  test("is idempotent and preserves existing source values", () => {
    const db = makeDb("current");
    try {
      db.prepare("INSERT INTO aliases (page_slug, alias, source) VALUES (?, ?, ?)").run(
        "entity/a",
        "别名A",
        "llm-semantic",
      );

      runAliasMigrations(db);
      runAliasMigrations(db);

      const rows = db.prepare("SELECT page_slug, alias, source FROM aliases").all() as Array<{
        page_slug: string;
        alias: string;
        source: string;
      }>;
      expect(rows).toEqual([{ page_slug: "entity/a", alias: "别名A", source: "llm-semantic" }]);
    } finally {
      db.close();
    }
  });
});
