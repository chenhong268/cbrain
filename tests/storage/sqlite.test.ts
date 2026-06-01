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

  test("link decay migration adds columns", () => {
    const cols = db.prepare("PRAGMA table_info(links)").all() as any[];
    const names = new Set(cols.map((c: any) => c.name));
    expect(names).toContain("last_validated_at");
    expect(names).toContain("effective_weight");
  });

  test("applyLinkDecay recalculates effective_weight", () => {
    db.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("a", "record", "A", "a.md", "h1");
    db.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("b", "record", "B", "b.md", "h2");

    db.insertLink("a", "b", "mentions", null, 1.0, "medium", "ner", 0.7);
    db.prepare(
      "UPDATE links SET last_validated_at = datetime('now', '-6 months') WHERE from_slug = 'a' AND to_slug = 'b'"
    ).run();

    const updated = db.applyLinkDecay();
    expect(updated).toBeGreaterThan(0);

    const link = db.prepare("SELECT * FROM links WHERE from_slug = 'a' AND to_slug = 'b'").get() as any;
    expect(link.effective_weight).toBeLessThan(1.0 * 0.7);
    expect(link.effective_weight).toBeGreaterThan(0);
  });

  test("manual/wikilink links do not decay", () => {
    db.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("x", "record", "X", "x.md", "h1");
    db.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("y", "record", "Y", "y.md", "h2");

    db.insertLink("x", "y", "mentions", null, 1.0, "medium", "manual", 0.9);
    db.prepare(
      "UPDATE links SET last_validated_at = datetime('now', '-12 months') WHERE from_slug = 'x' AND to_slug = 'y'"
    ).run();

    db.applyLinkDecay();

    const link = db.prepare("SELECT * FROM links WHERE from_slug = 'x' AND to_slug = 'y'").get() as any;
    expect(link.effective_weight).toBeCloseTo(1.0 * 0.9, 2);
  });

  test("validateLinksForSlugs resets last_validated_at", () => {
    db.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("p", "record", "P", "p.md", "h1");
    db.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("q", "record", "Q", "q.md", "h2");

    db.insertLink("p", "q", "mentions", null, 1.0, "medium", "ner", 0.5);
    db.prepare(
      "UPDATE links SET last_validated_at = datetime('now', '-3 months') WHERE from_slug = 'p' AND to_slug = 'q'"
    ).run();

    db.validateLinksForSlugs(["p"]);

    const link = db.prepare("SELECT * FROM links WHERE from_slug = 'p' AND to_slug = 'q'").get() as any;
    const today = new Date().toISOString().slice(0, 10);
    expect(link.last_validated_at).toContain(today);
  });

  test("boostLinkConfidence increases confidence", () => {
    db.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("m", "record", "M", "m.md", "h1");
    db.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("n", "record", "N", "n.md", "h2");

    db.insertLink("m", "n", "mentions", null, 1.0, "medium", "ner", 0.5);

    db.boostLinkConfidence("m", "n", "mentions", 0.1);

    const link = db.prepare("SELECT * FROM links WHERE from_slug = 'm' AND to_slug = 'n'").get() as any;
    expect(link.confidence).toBeCloseTo(0.6, 2);
  });

  test("boostLinkConfidence caps at 1.0", () => {
    db.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("u", "record", "U", "u.md", "h1");
    db.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("v", "record", "V", "v.md", "h2");

    db.insertLink("u", "v", "mentions", null, 1.0, "medium", "ner", 0.95);

    db.boostLinkConfidence("u", "v", "mentions", 0.1);

    const link = db.prepare("SELECT * FROM links WHERE from_slug = 'u' AND to_slug = 'v'").get() as any;
    expect(link.confidence).toBe(1.0);
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

  // ─── Search trace ────────────────────────────────────────────

  describe("search trace", () => {
    test("creates search_trace_sessions and search_trace_steps tables", () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = tables.map(t => t.name);
      expect(names).toContain("search_trace_sessions");
      expect(names).toContain("search_trace_steps");
    });

    test("startSearchTraceSession returns id with running status", () => {
      const id = db.startSearchTraceSession({ query: "主题A", mode: "smart" });
      expect(id).toBeGreaterThan(0);

      const row = db.prepare("SELECT * FROM search_trace_sessions WHERE id = ?").get(id) as any;
      expect(row.query).toBe("主题A");
      expect(row.mode).toBe("smart");
      expect(row.status).toBe("running");
      expect(row.started_at).not.toBeNull();
      expect(row.ended_at).toBeNull();
    });

    test("finishSearchTraceSession updates fields", () => {
      const id = db.startSearchTraceSession({ query: "实体B", mode: "smart" });
      db.finishSearchTraceSession(id, {
        latencyMs: 150,
        status: "success",
        llmCalls: 3,
        totalSteps: 5,
        summaryJson: { vector_ms: 50, fts_ms: 20 },
      });

      const row = db.prepare("SELECT * FROM search_trace_sessions WHERE id = ?").get(id) as any;
      expect(row.status).toBe("success");
      expect(row.ended_at).not.toBeNull();
      expect(row.latency_ms).toBe(150);
      expect(row.llm_calls).toBe(3);
      expect(row.total_steps).toBe(5);
      expect(JSON.parse(row.summary_json)).toEqual({ vector_ms: 50, fts_ms: 20 });
    });

    test("addSearchTraceStep and getSearchTraceSteps round-trip ordered", () => {
      const id = db.startSearchTraceSession({ query: "记录C", mode: "hybrid" });
      db.addSearchTraceStep({ sessionId: id, stepIndex: 2, kind: "fts", latencyMs: 15, outputSummary: "3 results" });
      db.addSearchTraceStep({ sessionId: id, stepIndex: 0, kind: "vector", latencyMs: 42, inputJson: { k: 5 } });
      db.addSearchTraceStep({ sessionId: id, stepIndex: 1, kind: "graph", latencyMs: 8 });

      const steps = db.getSearchTraceSteps(id);
      expect(steps).toHaveLength(3);
      expect(steps[0].kind).toBe("vector");
      expect(steps[0].input_json).toEqual({ k: 5 });
      expect(steps[1].kind).toBe("graph");
      expect(steps[2].kind).toBe("fts");
      expect(steps[2].output_summary).toBe("3 results");
    });

    test("cascade delete: deleting session removes steps", () => {
      const id = db.startSearchTraceSession({ query: "主题D", mode: "fts" });
      db.addSearchTraceStep({ sessionId: id, stepIndex: 0, kind: "vector", latencyMs: 10 });
      db.addSearchTraceStep({ sessionId: id, stepIndex: 1, kind: "fts", latencyMs: 5 });

      db.prepare("DELETE FROM search_trace_sessions WHERE id = ?").run(id);

      const steps = db.getSearchTraceSteps(id);
      expect(steps).toHaveLength(0);
    });

    test("getRecentSearchTraceSessions returns newest first with limit", () => {
      const _id1 = db.startSearchTraceSession({ query: "第一", mode: "smart" });
      const id2 = db.startSearchTraceSession({ query: "第二", mode: "smart" });
      const id3 = db.startSearchTraceSession({ query: "第三", mode: "smart" });

      const sessions = db.getRecentSearchTraceSessions(2);
      expect(sessions).toHaveLength(2);
      expect(sessions[0].id).toBe(id3);
      expect(sessions[1].id).toBe(id2);
    });

    test("partial finish does not overwrite default fields", () => {
      const id = db.startSearchTraceSession({ query: "部分测试", mode: "smart" });
      db.finishSearchTraceSession(id, { status: "degraded" });

      const row = db.prepare("SELECT * FROM search_trace_sessions WHERE id = ?").get(id) as any;
      expect(row.status).toBe("degraded");
      expect(row.llm_calls).toBe(0);
      expect(row.total_steps).toBe(0);
    });

    test("getRecentSearchTraceSessions parses summary_json", () => {
      const id = db.startSearchTraceSession({ query: "JSON测试", mode: "hybrid" });
      db.finishSearchTraceSession(id, { summaryJson: { fts_ms: 30, degraded_reason: "timeout" } });

      const sessions = db.getRecentSearchTraceSessions(1);
      expect(sessions[0].summary_json).toEqual({ fts_ms: 30, degraded_reason: "timeout" });
    });

    test("step to non-existent session throws FK error", () => {
      expect(() => {
        db.addSearchTraceStep({ sessionId: 99999, stepIndex: 0, kind: "vector", latencyMs: 1 });
      }).toThrow();
    });
  });
});
