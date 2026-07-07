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
    const result = db.rawDb.prepare("PRAGMA journal_mode").get() as any;
    expect(result.journal_mode).toBe("wal");
  });

  test("creates all required tables", () => {
    const tables = db      .rawDb.prepare(
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
    db.rawDb.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
    ).run("entities/test", "entity", "Test", "entities/test.md", "abc123");

    const row = db      .rawDb.prepare("SELECT * FROM pages WHERE slug = ?")
      .get("entities/test") as any;
    expect(row.title).toBe("Test");
    expect(row.type).toBe("entity");
    expect(row.tier).toBe(3);
    expect(row.mention_count).toBe(0);
  });

  test("link decay migration adds columns", () => {
    const cols = db.rawDb.prepare("PRAGMA table_info(links)").all() as any[];
    const names = new Set(cols.map((c: any) => c.name));
    expect(names).toContain("last_validated_at");
    expect(names).toContain("effective_weight");
  });

  test("applyLinkDecay recalculates effective_weight", () => {
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("a", "record", "A", "a.md", "h1");
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("b", "record", "B", "b.md", "h2");

    db.insertLink("a", "b", "mentions", null, 1.0, "medium", "ner", 0.7);
    db.rawDb.prepare(
      "UPDATE links SET last_validated_at = datetime('now', '-6 months') WHERE from_slug = 'a' AND to_slug = 'b'"
    ).run();

    const updated = db.applyLinkDecay();
    expect(updated).toBeGreaterThan(0);

    const link = db.rawDb.prepare("SELECT * FROM links WHERE from_slug = 'a' AND to_slug = 'b'").get() as any;
    expect(link.effective_weight).toBeLessThan(1.0 * 0.7);
    expect(link.effective_weight).toBeGreaterThan(0);
  });

  test("manual/wikilink links do not decay", () => {
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("x", "record", "X", "x.md", "h1");
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("y", "record", "Y", "y.md", "h2");

    db.insertLink("x", "y", "mentions", null, 1.0, "medium", "manual", 0.9);
    db.rawDb.prepare(
      "UPDATE links SET last_validated_at = datetime('now', '-12 months') WHERE from_slug = 'x' AND to_slug = 'y'"
    ).run();

    db.applyLinkDecay();

    const link = db.rawDb.prepare("SELECT * FROM links WHERE from_slug = 'x' AND to_slug = 'y'").get() as any;
    expect(link.effective_weight).toBeCloseTo(1.0 * 0.9, 2);
  });

  test("validateLinksForSlugs resets last_validated_at", () => {
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("p", "record", "P", "p.md", "h1");
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("q", "record", "Q", "q.md", "h2");

    db.insertLink("p", "q", "mentions", null, 1.0, "medium", "ner", 0.5);
    db.rawDb.prepare(
      "UPDATE links SET last_validated_at = datetime('now', '-3 months') WHERE from_slug = 'p' AND to_slug = 'q'"
    ).run();

    db.validateLinksForSlugs(["p"]);

    const link = db.rawDb.prepare("SELECT * FROM links WHERE from_slug = 'p' AND to_slug = 'q'").get() as any;
    const today = new Date().toISOString().slice(0, 10);
    expect(link.last_validated_at).toContain(today);
  });

  test("boostLinkConfidence increases confidence", () => {
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("m", "record", "M", "m.md", "h1");
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("n", "record", "N", "n.md", "h2");

    db.insertLink("m", "n", "mentions", null, 1.0, "medium", "ner", 0.5);

    db.boostLinkConfidence("m", "n", "mentions", 0.1);

    const link = db.rawDb.prepare("SELECT * FROM links WHERE from_slug = 'm' AND to_slug = 'n'").get() as any;
    expect(link.confidence).toBeCloseTo(0.6, 2);
  });

  test("boostLinkConfidence caps at 1.0", () => {
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("u", "record", "U", "u.md", "h1");
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("v", "record", "V", "v.md", "h2");

    db.insertLink("u", "v", "mentions", null, 1.0, "medium", "ner", 0.95);

    db.boostLinkConfidence("u", "v", "mentions", 0.1);

    const link = db.rawDb.prepare("SELECT * FROM links WHERE from_slug = 'u' AND to_slug = 'v'").get() as any;
    expect(link.confidence).toBe(1.0);
  });

  test("transaction rolls back on error", () => {
    expect(() => {
      db.transaction(() => {
        db.rawDb.prepare(
          `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
        ).run("entities/tx-test", "entity", "TX Test", "tx.md", "hash");

        throw new Error("rollback");
      });
    }).toThrow("rollback");

    const row = db      .rawDb.prepare("SELECT * FROM pages WHERE slug = ?")
      .get("entities/tx-test");
    expect(row).toBeNull();
  });

  // ─── Search trace ────────────────────────────────────────────

  describe("search trace", () => {
    test("creates search_trace_sessions and search_trace_steps tables", () => {
      const tables = db        .rawDb.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = tables.map(t => t.name);
      expect(names).toContain("search_trace_sessions");
      expect(names).toContain("search_trace_steps");
    });

    test("startSearchTraceSession returns id with running status", () => {
      const id = db.startSearchTraceSession({ query: "主题A", mode: "smart" });
      expect(id).toBeGreaterThan(0);

      const row = db.rawDb.prepare("SELECT * FROM search_trace_sessions WHERE id = ?").get(id) as any;
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

      const row = db.rawDb.prepare("SELECT * FROM search_trace_sessions WHERE id = ?").get(id) as any;
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

      db.rawDb.prepare("DELETE FROM search_trace_sessions WHERE id = ?").run(id);

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

      const row = db.rawDb.prepare("SELECT * FROM search_trace_sessions WHERE id = ?").get(id) as any;
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

  // ─── resolveSlugs type preference ───────────────────────────

  describe("resolveSlugs type preference", () => {
    test("fuzzy match prefers entity/person over record", () => {
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("entity/shi-ti-a", "entity/person", "实体A丰", "entity/shi-ti-a.md", "h1");
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("record/meeting-a", "record", "实体A的会议记录", "record/meeting-a.md", "h2");

      const results = db.resolveSlugs(["实体A"]);
      expect(results).toHaveLength(1);
      expect(results[0].slug).toBe("entity/shi-ti-a");
    });

    test("fuzzy match prefers concept/concept over record", () => {
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("concept/zhu-ti-b", "concept/concept", "主题B综述", "concept/zhu-ti-b.md", "h3");
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("source/zhu-ti-b-ref", "source", "主题B参考资料", "source/zhu-ti-b-ref.md", "h4");

      const results = db.resolveSlugs(["主题B"]);
      expect(results).toHaveLength(1);
      expect(results[0].slug).toBe("concept/zhu-ti-b");
    });

    test("exact slug match still takes priority over fuzzy", () => {
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("entity/exact", "entity/person", "精确实体", "entity/exact.md", "h5");
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("record/exact", "record", "精确记录", "record/exact.md", "h6");

      const results = db.resolveSlugs(["entity/exact"]);
      expect(results).toHaveLength(1);
      expect(results[0].slug).toBe("entity/exact");
    });

    test("real slug shapes: brain/entities/person wins over records note", () => {
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("brain/entities/person/entity-a", "entity/person", "人物D概览", "brain/entities/person/entity-a.md", "h7");
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("records/entity-a-note", "record", "人物D的会议记录", "records/entity-a-note.md", "h8");

      const results = db.resolveSlugs(["人物D"]);
      expect(results).toHaveLength(1);
      expect(results[0].slug).toBe("brain/entities/person/entity-a");
    });

    test("type=entity/person with non-entity slug prefix still wins via type column", () => {
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("custom/path/to/shi-ti-e", "entity/person", "实体E总览", "custom/path/to/shi-ti-e.md", "h9");
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("entity/shi-ti-e-note", "record", "实体E的笔记", "entity/shi-ti-e-note.md", "h10");

      const results = db.resolveSlugs(["实体E"]);
      expect(results).toHaveLength(1);
      expect(results[0].slug).toBe("custom/path/to/shi-ti-e");
    });

    test("entity wins even when record is inserted first (regression)", () => {
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("records/shi-ti-f-note", "record", "实体F的讨论记录", "records/shi-ti-f-note.md", "h11");
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("brain/entities/person/shi-ti-f", "entity/person", "实体F", "brain/entities/person/shi-ti-f.md", "h12");

      const results = db.resolveSlugs(["实体F"]);
      expect(results).toHaveLength(1);
      expect(results[0].slug).toBe("brain/entities/person/shi-ti-f");
    });

    test("concept/concept with brain slug wins over source", () => {
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("brain/concepts/concept/zhu-ti-g", "concept/concept", "主题G概念", "brain/concepts/concept/zhu-ti-g.md", "h13");
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("source/zhu-ti-g-ref", "source", "主题G参考", "source/zhu-ti-g-ref.md", "h14");

      const results = db.resolveSlugs(["主题G"]);
      expect(results).toHaveLength(1);
      expect(results[0].slug).toBe("brain/concepts/concept/zhu-ti-g");
    });

    // ─── alias-aware resolution (#194) ─────────────────────────

    test("exact alias resolves to the aliased page (#194)", () => {
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("entity/shi-ti-alias", "entity/person", "实体A", "entity/shi-ti-alias.md", "h1");
      db.addAlias("entity/shi-ti-alias", "别名A");

      const results = db.resolveSlugs(["别名A"]);
      expect(results).toHaveLength(1);
      expect(results[0].slug).toBe("entity/shi-ti-alias");
      expect(results[0].title).toBe("实体A");
    });

    test("alias batch resolves multiple aliases in one call (#194)", () => {
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("entity/bie-ming-x", "entity/person", "实体X", "entity/bie-ming-x.md", "h1");
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("entity/bie-ming-y", "entity/person", "实体Y", "entity/bie-ming-y.md", "h2");
      db.addAlias("entity/bie-ming-x", "别名X");
      db.addAlias("entity/bie-ming-y", "别名Y");

      const results = db.resolveSlugs(["别名X", "别名Y"]);
      expect(results).toHaveLength(2);
      expect(results[0].slug).toBe("entity/bie-ming-x");
      expect(results[1].slug).toBe("entity/bie-ming-y");
    });

    test("alias pass preferred over fuzzy LIKE — no false record grab (#194)", () => {
      // 精确别名命中实体；同时存在 title 含相同字符串的 record
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("entity/bie-ming-b", "entity/person", "实体B本体", "entity/bie-ming-b.md", "h1");
      db.addAlias("entity/bie-ming-b", "别名B");
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("record/bie-ming-b-note", "record", "别名B的附属记录", "record/bie-ming-b-note.md", "h2");

      const results = db.resolveSlugs(["别名B"]);
      expect(results).toHaveLength(1);
      expect(results[0].slug).toBe("entity/bie-ming-b");
    });

    test("ambiguous alias shared by entity and record prefers entity (#194)", () => {
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("entity/gong-xiang", "entity/person", "共享实体", "entity/gong-xiang.md", "h1");
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("record/gong-xiang", "record", "共享记录", "record/gong-xiang.md", "h2");
      db.addAlias("entity/gong-xiang", "共享别名");
      db.addAlias("record/gong-xiang", "共享别名");

      const results = db.resolveSlugs(["共享别名"]);
      expect(results).toHaveLength(1);
      expect(results[0].slug).toBe("entity/gong-xiang");
    });

    test("exact title still wins over alias (#194)", () => {
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("entity/shi-ti-c", "entity/person", "标题C", "entity/shi-ti-c.md", "h1");
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("entity/shi-ti-d", "entity/person", "实体D", "entity/shi-ti-d.md", "h2");
      db.addAlias("entity/shi-ti-d", "标题C");

      const results = db.resolveSlugs(["标题C"]);
      expect(results).toHaveLength(1);
      expect(results[0].slug).toBe("entity/shi-ti-c");
    });
  });
});

describe("deletePageCascaded transaction atomicity (#187)", () => {
  const txDir = "/tmp/cbrain-test-cascaded-tx";
  const txDbPath = join(txDir, "tx.sqlite");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(txDir)) rmSync(txDir, { recursive: true });
    mkdirSync(txDir, { recursive: true });
    db = new CBrainDB(txDbPath);
  });
  afterEach(() => {
    db.close();
    if (existsSync(txDir)) rmSync(txDir, { recursive: true });
  });

  test("rolls back FTS + ingest_log when the pages DELETE fails mid-cascade", () => {
    const slug = "records/alpha";
    // Seed: page + an ingest_log row + an FTS row for the slug.
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path) VALUES ($slug, 'record', 'Alpha', 'records/alpha.md')",
    ).run({ $slug: slug });
    db.rawDb.prepare(
      "INSERT INTO ingest_log (source_type, action, page_slug) VALUES ('record', 'create', $slug)",
    ).run({ $slug: slug });
    db.rawDb.prepare(
      "INSERT INTO chunks_fts (page_slug, content) VALUES ($slug, 'alpha body text')",
    ).run({ $slug: slug });

    // Inject a failure on the pages DELETE (the last statement of the cascade).
    db.rawDb.exec(
      "CREATE TRIGGER stop_pages_delete BEFORE DELETE ON pages " +
      "BEGIN SELECT RAISE(ABORT, 'injected pages delete failure'); END",
    );

    // The cascade must abort and roll back the FTS + ingest_log deletes that ran first.
    expect(() => db.deletePageCascaded(slug)).toThrow("injected pages delete failure");

    // All three stores still present — no partial delete survived the failed transaction.
    const page = db.rawDb.prepare("SELECT slug FROM pages WHERE slug = $slug").get({ $slug: slug });
    const log = db.rawDb.prepare("SELECT page_slug FROM ingest_log WHERE page_slug = $slug").get({ $slug: slug });
    const fts = db.rawDb.prepare("SELECT page_slug FROM chunks_fts WHERE page_slug = $slug").get({ $slug: slug });
    expect(page).toBeTruthy();
    expect(log).toBeTruthy();
    expect(fts).toBeTruthy();
  });

  // #311 — read methods backing proactive scoring (hub filter) + cooldown.
  describe("#311 proactive scoring/cooldown reads", () => {
    function seedPageFor311(slug: string): void {
      db.rawDb
        .prepare(
          "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)",
        )
        .run(slug, "entity", slug, `${slug}.md`, null);
    }

    test("batchGetLinkDegrees counts active link endpoints; rejected excluded; missing → 0", () => {
      for (const s of ["entity-alpha", "entity-beta", "entity-gamma", "entity-hub"]) {
        seedPageFor311(s);
      }
      // 'mentions' has no reverse relation → insertLink stores one forward row.
      // degree = endpoint count (from_slug OR to_slug), matching batchGetLinksForSlugs.
      db.insertLink("entity-alpha", "entity-hub", "mentions", null, 1.0, "medium", "ner", 0.7);
      db.insertLink("entity-beta", "entity-hub", "mentions", null, 1.0, "medium", "ner", 0.7);
      db.insertLink("entity-gamma", "entity-hub", "mentions", null, 1.0, "medium", "ner", 0.7);
      db.insertLink("entity-alpha", "entity-beta", "mentions", null, 1.0, "medium", "ner", 0.7);

      let d = db.batchGetLinkDegrees([
        "entity-alpha",
        "entity-beta",
        "entity-gamma",
        "entity-hub",
        "entity-missing",
      ]);
      expect(d.get("entity-alpha")).toBe(2); // from: hub, beta
      expect(d.get("entity-beta")).toBe(2); // from: hub; to: alpha
      expect(d.get("entity-gamma")).toBe(1); // from: hub
      expect(d.get("entity-hub")).toBe(3); // to: alpha, beta, gamma
      expect(d.get("entity-missing")).toBe(0);

      // Reject the alpha→hub row → degree drops for both endpoints.
      db.rawDb
        .prepare(
          "UPDATE links SET trust_state = 'rejected' " +
            "WHERE from_slug='entity-alpha' AND to_slug='entity-hub'",
        )
        .run();
      d = db.batchGetLinkDegrees(["entity-alpha", "entity-hub"]);
      expect(d.get("entity-alpha")).toBe(1); // only beta remains
      expect(d.get("entity-hub")).toBe(2); // beta, gamma
    });

    test("batchGetLinkDegrees excludes self-loops (adversarial: a from=to row must not double-count)", () => {
      seedPageFor311("entity-self");
      seedPageFor311("entity-other");
      db.insertLink("entity-self", "entity-other", "mentions", null, 1.0, "medium", "ner", 0.7);
      // Raw-insert a self-loop (UNIQUE(from,to,relation) allows from=to; no app guard today).
      db.rawDb
        .prepare("INSERT INTO links (from_slug, to_slug, relation) VALUES ('entity-self', 'entity-self', 'mentions')")
        .run();
      const d = db.batchGetLinkDegrees(["entity-self", "entity-other"]);
      // entity-self: 1 real edge (→other) + self-loop (must NOT count) = 1, not 3.
      expect(d.get("entity-self")).toBe(1);
      expect(d.get("entity-other")).toBe(1);
    });

    test("getDiscoveryLifecycleIndex returns all rows with lifecycle fields; producer derives dismissed + occurrence", () => {
      const meta = { source: "proactive_connection" };
      db.upsertDiscovery("proactive_connection", ["entity-alpha", "entity-beta"], 0.5, undefined, undefined, "low", false, meta);
      db.upsertDiscovery("proactive_connection", ["entity-alpha", "entity-gamma"], 0.5, undefined, undefined, "low", false, meta);
      db.upsertDiscovery("proactive_connection", ["entity-beta", "entity-gamma"], 0.5, undefined, undefined, "low", false, meta);

      const seeded = db.rawDb
        .prepare("SELECT id FROM discoveries WHERE type='proactive_connection' ORDER BY id")
        .all() as Array<{ id: number }>;
      expect(seeded).toHaveLength(3);
      db.updateDiscoveryStatus(seeded[0].id, "dismissed");
      db.updateDiscoveryStatus(seeded[1].id, "resolved");
      // seeded[2] stays pending

      const index = db.getDiscoveryLifecycleIndex("proactive_connection", 10);
      expect(index).toHaveLength(3); // ALL rows, any status
      for (const r of index) {
        expect(["dismissed", "resolved", "pending"]).toContain(r.status);
        expect(typeof r.dedup_key).toBe("string");
        expect(r.dedup_key.startsWith("proactive_connection|")).toBe(true);
        expect(typeof r.entities).toBe("string");
        expect(typeof r.occurrence_count).toBe("number");
      }
      // Producer-side derivations:
      const dismissed = index.filter((r) => r.status === "dismissed" || r.status === "resolved");
      expect(dismissed).toHaveLength(2);
      const pending = index.filter((r) => r.status === "pending");
      expect(pending).toHaveLength(1);
      // Limit respected.
      expect(db.getDiscoveryLifecycleIndex("proactive_connection", 1)).toHaveLength(1);
    });
  });
});
