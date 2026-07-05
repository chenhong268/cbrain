import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTelemetryMigrations } from "../../../src/storage/migrations/index.js";

describe("runTelemetryMigrations", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeDb(): Database {
    const dir = mkdtempSync(join(tmpdir(), "cbrain-telemetry-migration-"));
    dirs.push(dir);
    return new Database(join(dir, "brain.sqlite"));
  }

  test("creates search log, search trace, and NER quality telemetry tables", () => {
    const db = makeDb();
    try {
      runTelemetryMigrations(db);

      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('search_log', 'search_trace_sessions', 'search_trace_steps', 'ner_quality_log') ORDER BY name",
      ).all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual([
        "ner_quality_log",
        "search_log",
        "search_trace_sessions",
        "search_trace_steps",
      ]);

      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_search_log_created', 'idx_ner_quality_log_created', 'idx_sts_started', 'idx_sts_id', 'idx_steps_session', 'idx_steps_session_index') ORDER BY name",
      ).all() as Array<{ name: string }>;
      expect(indexes.map((row) => row.name)).toEqual([
        "idx_ner_quality_log_created",
        "idx_search_log_created",
        "idx_steps_session",
        "idx_steps_session_index",
        "idx_sts_id",
        "idx_sts_started",
      ]);
    } finally {
      db.close();
    }
  });

  test("adds details_json to legacy search_log and preserves existing rows", () => {
    const db = makeDb();
    try {
      db.exec(`
        CREATE TABLE search_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          query TEXT NOT NULL,
          strategy TEXT NOT NULL,
          latency_ms INTEGER NOT NULL,
          hit_count INTEGER NOT NULL,
          degraded INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      db.prepare(
        "INSERT INTO search_log (query, strategy, latency_ms, hit_count, degraded) VALUES (?, ?, ?, ?, ?)",
      ).run("匿名查询", "smart", 12, 3, 0);

      runTelemetryMigrations(db);

      const columns = db.prepare("PRAGMA table_info(search_log)").all() as Array<{ name: string }>;
      expect(new Set(columns.map((column) => column.name))).toContain("details_json");
      const row = db.prepare(
        "SELECT query, strategy, latency_ms, hit_count, degraded, details_json FROM search_log",
      ).get() as {
        query: string;
        strategy: string;
        latency_ms: number;
        hit_count: number;
        degraded: number;
        details_json: string | null;
      };
      expect(row).toEqual({
        query: "匿名查询",
        strategy: "smart",
        latency_ms: 12,
        hit_count: 3,
        degraded: 0,
        details_json: null,
      });
    } finally {
      db.close();
    }
  });

  test("is idempotent and preserves existing telemetry values", () => {
    const db = makeDb();
    try {
      runTelemetryMigrations(db);
      db.prepare(
        "INSERT INTO search_log (query, strategy, latency_ms, hit_count, degraded, details_json) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("匿名查询", "smart", 34, 2, 1, JSON.stringify({ reason: "budget" }));
      db.prepare(
        "INSERT INTO ner_quality_log (extracted_entities, extracted_concepts, filtered_total, filter_reasons_json, resolved_existing, alias_added, stub_created, duplicate_candidate, relations_total, relations_written, relations_skipped) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(1, 2, 3, JSON.stringify({ too_generic: 1 }), 4, 5, 6, 7, 8, 9, 10);

      runTelemetryMigrations(db);
      runTelemetryMigrations(db);

      const search = db.prepare(
        "SELECT query, strategy, latency_ms, hit_count, degraded, details_json FROM search_log",
      ).get() as {
        query: string;
        strategy: string;
        latency_ms: number;
        hit_count: number;
        degraded: number;
        details_json: string;
      };
      expect(search).toEqual({
        query: "匿名查询",
        strategy: "smart",
        latency_ms: 34,
        hit_count: 2,
        degraded: 1,
        details_json: JSON.stringify({ reason: "budget" }),
      });

      const ner = db.prepare(
        "SELECT extracted_entities, extracted_concepts, filtered_total, filter_reasons_json, resolved_existing, alias_added, stub_created, duplicate_candidate, relations_total, relations_written, relations_skipped FROM ner_quality_log",
      ).get() as {
        extracted_entities: number;
        extracted_concepts: number;
        filtered_total: number;
        filter_reasons_json: string;
        resolved_existing: number;
        alias_added: number;
        stub_created: number;
        duplicate_candidate: number;
        relations_total: number;
        relations_written: number;
        relations_skipped: number;
      };
      expect(ner).toEqual({
        extracted_entities: 1,
        extracted_concepts: 2,
        filtered_total: 3,
        filter_reasons_json: JSON.stringify({ too_generic: 1 }),
        resolved_existing: 4,
        alias_added: 5,
        stub_created: 6,
        duplicate_candidate: 7,
        relations_total: 8,
        relations_written: 9,
        relations_skipped: 10,
      });
    } finally {
      db.close();
    }
  });
});
