import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQueryInteractionMigrations } from "../../../src/storage/migrations/index.js";

describe("runQueryInteractionMigrations", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeDb(): Database {
    const dir = mkdtempSync(join(tmpdir(), "cbrain-query-interaction-migration-"));
    dirs.push(dir);
    return new Database(join(dir, "brain.sqlite"));
  }

  test("creates query log, feedback, and wakeup snapshot tables with indexes", () => {
    const db = makeDb();
    try {
      runQueryInteractionMigrations(db);

      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('query_log', 'query_feedback', 'brain_snapshots', 'brain_snapshot_items') ORDER BY name",
      ).all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual([
        "brain_snapshot_items",
        "brain_snapshots",
        "query_feedback",
        "query_log",
      ]);

      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_query_log_created', 'idx_query_log_session', 'idx_feedback_slug', 'idx_feedback_created') ORDER BY name",
      ).all() as Array<{ name: string }>;
      expect(indexes.map((row) => row.name)).toEqual([
        "idx_feedback_created",
        "idx_feedback_slug",
        "idx_query_log_created",
        "idx_query_log_session",
      ]);
    } finally {
      db.close();
    }
  });

  test("preserves legacy query feedback and snapshot rows", () => {
    const db = makeDb();
    try {
      db.exec(`
        CREATE TABLE query_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tool TEXT NOT NULL,
          query TEXT NOT NULL,
          result_slugs TEXT NOT NULL,
          result_count INTEGER NOT NULL,
          latency_ms INTEGER,
          session_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE query_feedback (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          query_id INTEGER REFERENCES query_log(id) ON DELETE CASCADE,
          slug TEXT NOT NULL,
          signal TEXT NOT NULL CHECK(signal IN ('relevant', 'irrelevant', 'corrected', 'expanded')),
          note TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE brain_snapshots (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'wakeup_diff',
          page_count INTEGER NOT NULL,
          link_count INTEGER NOT NULL,
          health_issue_count INTEGER
        );
        CREATE TABLE brain_snapshot_items (
          snapshot_id TEXT NOT NULL REFERENCES brain_snapshots(id) ON DELETE CASCADE,
          slug TEXT NOT NULL,
          title TEXT NOT NULL,
          content_hash TEXT,
          tier INTEGER,
          mention_count INTEGER,
          link_count INTEGER,
          updated_at TEXT,
          page_type TEXT,
          confidence_decay REAL,
          PRIMARY KEY (snapshot_id, slug)
        );
      `);
      db.prepare(
        "INSERT INTO query_log (tool, query, result_slugs, result_count, latency_ms, session_id) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("deep_recall", "匿名查询", JSON.stringify(["entity/a"]), 1, 12, "session-a");
      db.prepare(
        "INSERT INTO query_feedback (query_id, slug, signal, note) VALUES (?, ?, ?, ?)",
      ).run(1, "entity/a", "relevant", "匿名反馈");
      db.prepare(
        "INSERT INTO brain_snapshots (id, created_at, kind, page_count, link_count, health_issue_count) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("snapshot-a", "2026-01-01T00:00:00Z", "wakeup_diff", 2, 3, 4);
      db.prepare(
        "INSERT INTO brain_snapshot_items (snapshot_id, slug, title, content_hash, tier, mention_count, link_count, updated_at, page_type, confidence_decay) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("snapshot-a", "entity/a", "实体A", "hash-a", 2, 5, 6, "2026-01-01T00:00:00Z", "entity/person", 0.9);

      runQueryInteractionMigrations(db);

      const feedback = db.prepare(
        "SELECT q.tool, q.query, q.result_slugs, q.result_count, q.latency_ms, q.session_id, f.slug, f.signal, f.note FROM query_log q JOIN query_feedback f ON f.query_id = q.id",
      ).get() as {
        tool: string;
        query: string;
        result_slugs: string;
        result_count: number;
        latency_ms: number;
        session_id: string;
        slug: string;
        signal: string;
        note: string;
      };
      expect(feedback).toEqual({
        tool: "deep_recall",
        query: "匿名查询",
        result_slugs: JSON.stringify(["entity/a"]),
        result_count: 1,
        latency_ms: 12,
        session_id: "session-a",
        slug: "entity/a",
        signal: "relevant",
        note: "匿名反馈",
      });

      const snapshot = db.prepare(
        "SELECT s.id, s.page_count, s.link_count, s.health_issue_count, i.slug, i.title, i.content_hash, i.tier, i.mention_count, i.link_count AS item_link_count, i.page_type, i.confidence_decay FROM brain_snapshots s JOIN brain_snapshot_items i ON i.snapshot_id = s.id",
      ).get() as {
        id: string;
        page_count: number;
        link_count: number;
        health_issue_count: number;
        slug: string;
        title: string;
        content_hash: string;
        tier: number;
        mention_count: number;
        item_link_count: number;
        page_type: string;
        confidence_decay: number;
      };
      expect(snapshot).toEqual({
        id: "snapshot-a",
        page_count: 2,
        link_count: 3,
        health_issue_count: 4,
        slug: "entity/a",
        title: "实体A",
        content_hash: "hash-a",
        tier: 2,
        mention_count: 5,
        item_link_count: 6,
        page_type: "entity/person",
        confidence_decay: 0.9,
      });
    } finally {
      db.close();
    }
  });

  test("is idempotent and preserves existing query interaction values", () => {
    const db = makeDb();
    try {
      runQueryInteractionMigrations(db);
      db.prepare(
        "INSERT INTO query_log (tool, query, result_slugs, result_count, latency_ms, session_id) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("cbrain_recall", "匿名查询", JSON.stringify(["entity/a", "entity/b"]), 2, 34, "session-b");
      db.prepare(
        "INSERT INTO query_feedback (query_id, slug, signal, note) VALUES (?, ?, ?, ?)",
      ).run(1, "entity/b", "expanded", "匿名补充");
      db.prepare(
        "INSERT INTO brain_snapshots (id, created_at, kind, page_count, link_count, health_issue_count) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("snapshot-b", "2026-01-02T00:00:00Z", "wakeup_diff", 7, 8, 9);
      db.prepare(
        "INSERT INTO brain_snapshot_items (snapshot_id, slug, title, content_hash, tier, mention_count, link_count, updated_at, page_type, confidence_decay) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("snapshot-b", "entity/b", "实体B", "hash-b", 1, 10, 11, "2026-01-02T00:00:00Z", "entity/org", 0.8);

      runQueryInteractionMigrations(db);
      runQueryInteractionMigrations(db);

      const counts = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM query_log) AS query_logs,
          (SELECT COUNT(*) FROM query_feedback) AS feedback,
          (SELECT COUNT(*) FROM brain_snapshots) AS snapshots,
          (SELECT COUNT(*) FROM brain_snapshot_items) AS items
      `).get() as { query_logs: number; feedback: number; snapshots: number; items: number };
      expect(counts).toEqual({ query_logs: 1, feedback: 1, snapshots: 1, items: 1 });

      const row = db.prepare(
        "SELECT q.tool, q.query, q.result_count, f.signal, s.page_count, i.title FROM query_log q JOIN query_feedback f ON f.query_id = q.id JOIN brain_snapshots s ON s.id = 'snapshot-b' JOIN brain_snapshot_items i ON i.snapshot_id = s.id",
      ).get() as { tool: string; query: string; result_count: number; signal: string; page_count: number; title: string };
      expect(row).toEqual({
        tool: "cbrain_recall",
        query: "匿名查询",
        result_count: 2,
        signal: "expanded",
        page_count: 7,
        title: "实体B",
      });
    } finally {
      db.close();
    }
  });
});
