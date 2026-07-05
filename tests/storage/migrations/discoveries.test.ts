import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDiscoveryMigrations } from "../../../src/storage/migrations/index.js";

function testDedupKey(type: string, entities: string[]): string {
  return `${type}|${[...entities].sort().join("|")}`;
}

describe("runDiscoveryMigrations", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function dbPath(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return join(dir, "brain.sqlite");
  }

  function baseDiscoveryDb(): Database {
    const db = new Database(dbPath("cbrain-discovery-migration-"));
    db.exec(`
      CREATE TABLE discoveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        entities TEXT NOT NULL,
        score REAL NOT NULL,
        detail TEXT,
        detected_at TEXT NOT NULL,
        dream_run TEXT,
        seen INTEGER DEFAULT 0
      );
    `);
    db.prepare(
      "INSERT INTO discoveries (type, entities, score, detail, detected_at, dream_run, seen) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("bridge", JSON.stringify(["entity/a", "entity/b"]), 0.7, "匿名线索", "2026-01-01T00:00:00Z", "run-a", null);
    return db;
  }

  test("adds discovery action, lifecycle, dedup columns and indexes to legacy schema", () => {
    const db = baseDiscoveryDb();
    try {
      runDiscoveryMigrations(db, testDedupKey);
      runDiscoveryMigrations(db, testDedupKey);

      const columns = db.prepare("PRAGMA table_info(discoveries)").all() as Array<{ name: string }>;
      const names = new Set(columns.map((column) => column.name));
      for (const name of [
        "actionable",
        "suggestion",
        "proposed_actions",
        "auto_applicable",
        "status",
        "metadata",
        "dedup_key",
        "last_detected_at",
        "occurrence_count",
      ]) {
        expect(names).toContain(name);
      }

      const row = db.prepare("SELECT * FROM discoveries").get() as {
        seen: number;
        actionable: string;
        auto_applicable: number;
        status: string;
        dedup_key: string;
        last_detected_at: string;
        occurrence_count: number;
      };
      expect(row.seen).toBe(0);
      expect(row.actionable).toBe("low");
      expect(row.auto_applicable).toBe(0);
      expect(row.status).toBe("pending");
      expect(row.dedup_key).toBe("bridge|entity/a|entity/b");
      expect(row.last_detected_at).toBe("2026-01-01T00:00:00Z");
      expect(row.occurrence_count).toBe(1);

      const indexes = db.prepare("PRAGMA index_list(discoveries)").all() as Array<{ name: string; unique: number }>;
      const byName = new Map(indexes.map((index) => [index.name, index]));
      expect(byName.has("idx_discoveries_actionable")).toBe(true);
      expect(byName.has("idx_discoveries_score")).toBe(true);
      expect(byName.get("idx_discoveries_dedup_key")?.unique).toBe(1);
    } finally {
      db.close();
    }
  });

  test("canonicalizes duplicate discovery keys and keeps strongest survivor state", () => {
    const db = new Database(dbPath("cbrain-discovery-dedup-migration-"));
    try {
      db.exec(`
        CREATE TABLE discoveries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          entities TEXT NOT NULL,
          score REAL NOT NULL,
          detail TEXT,
          detected_at TEXT NOT NULL,
          dream_run TEXT,
          seen INTEGER DEFAULT 0,
          actionable TEXT DEFAULT 'low',
          suggestion TEXT,
          proposed_actions TEXT,
          auto_applicable INTEGER DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending',
          metadata TEXT,
          dedup_key TEXT,
          last_detected_at TEXT,
          occurrence_count INTEGER NOT NULL DEFAULT 1
        );
      `);

      db.prepare(
        "INSERT INTO discoveries (type, entities, score, detail, detected_at, seen, status, suggestion, metadata, occurrence_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("bridge", JSON.stringify(["entity/b", "entity/a"]), 0.4, "旧匿名线索", "2026-01-01T00:00:00Z", 0, "pending", null, null, 2);
      db.prepare(
        "INSERT INTO discoveries (type, entities, score, detail, detected_at, seen, status, suggestion, metadata, occurrence_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("bridge", JSON.stringify(["entity/a", "entity/b"]), 0.9, "新匿名线索", "2026-01-03T00:00:00Z", 1, "dismissed", "忽略匿名线索", "{\"source\":\"test\"}", 3);

      runDiscoveryMigrations(db, testDedupKey);

      const rows = db.prepare("SELECT * FROM discoveries ORDER BY id").all() as Array<{
        score: number;
        seen: number;
        status: string;
        suggestion: string | null;
        metadata: string | null;
        dedup_key: string;
        last_detected_at: string;
        occurrence_count: number;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        score: 0.9,
        seen: 1,
        status: "dismissed",
        suggestion: "忽略匿名线索",
        metadata: "{\"source\":\"test\"}",
        dedup_key: "bridge|entity/a|entity/b",
        last_detected_at: "2026-01-03T00:00:00Z",
        occurrence_count: 5,
      });
    } finally {
      db.close();
    }
  });
});
