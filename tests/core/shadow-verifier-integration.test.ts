import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { ContentPipeline } from "../../src/core/ingestion/pipeline.js";
import type { ExtractionResult } from "../../src/core/ingestion/ner.js";

describe("CBrainDB.getRecentVerifierCounts", () => {
  const testDir = "/tmp/cbrain-test-verifier-db";
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

  test("aggregates ner/discovery warning+error counts and reason codes", () => {
    db.addIngestLog("verifier", "ner_shadow_verifier", "records/source-1", JSON.stringify({
      surface: "ner", checks: 6,
      counts: { info: 0, warning: 1, error: 1 },
      reasonCounts: { ner_zero_from_long_body: 1, ner_invalid_event_date: 1 },
      worst: "error",
    }));
    db.addIngestLog("verifier", "discovery_shadow_verifier", null, JSON.stringify({
      surface: "discovery", type: "action_review_discovery", checks: 5,
      counts: { info: 0, warning: 2, error: 0 },
      reasonCounts: { discovery_display_private_raw: 2 },
      worst: "warning",
    }));

    const counts = db.getRecentVerifierCounts(24);
    expect(counts.ner).toEqual({ warning: 1, error: 1 });
    expect(counts.discovery).toEqual({ warning: 2, error: 0 });
    expect(counts.byCode).toEqual({
      ner_zero_from_long_body: 1,
      ner_invalid_event_date: 1,
      discovery_display_private_raw: 2,
    });
  });

  test("ignores non-verifier ingest_log rows", () => {
    db.addIngestLog("vault", "sync", "records/source-1", JSON.stringify({ nerError: true }));
    db.addIngestLog("api", "ingest", "records/source-2", "{}");
    const counts = db.getRecentVerifierCounts(24);
    expect(counts.ner).toEqual({ warning: 0, error: 0 });
    expect(counts.discovery).toEqual({ warning: 0, error: 0 });
    expect(counts.byCode).toEqual({});
  });

  test("respects the hour window", () => {
    db.addIngestLog("verifier", "ner_shadow_verifier", "x", JSON.stringify({
      surface: "ner", checks: 6, counts: { info: 0, warning: 1, error: 0 },
      reasonCounts: { ner_invalid_event_date: 1 }, worst: "warning",
    }));
    db.rawDb
      .prepare("UPDATE ingest_log SET created_at = datetime('now', '-48 hours')")
      .run();
    const counts = db.getRecentVerifierCounts(24);
    expect(counts.ner).toEqual({ warning: 0, error: 0 });
  });

  test("malformed details are skipped, not thrown", () => {
    db.addIngestLog("verifier", "ner_shadow_verifier", "x", "not-json");
    db.addIngestLog("verifier", "ner_shadow_verifier", "y", null as unknown as string);
    expect(() => db.getRecentVerifierCounts(24)).not.toThrow();
    const counts = db.getRecentVerifierCounts(24);
    expect(counts.ner).toEqual({ warning: 0, error: 0 });
  });
});

describe("ContentPipeline NER shadow verifier hook", () => {
  const testDir = "/tmp/cbrain-test-verifier-ner";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    process.env.CBRAIN_SHADOW_VERIFIER_DISABLE = ""; // ensure enabled
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  const stubEmbedding = {
    embedBatch: async (t: string[]) => t.map(() => ({ embedding: [0, 0], tokenCount: 1 })),
    embedQuery: async () => ({ embedding: [0, 0], tokenCount: 1 }),
  } as any;
  const stubLance = {
    deleteRawChunksByPageSlug: async () => {},
    deleteL1VectorByPageSlug: async () => {},
    addChunks: async () => {},
  } as any;
  const insertPage = (slug: string, title: string, type: string) => {
    db.rawDb
      .prepare("INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(slug, type, title, `${slug.replace("/", "-")}.md`, "h1", 0, 3);
  };
  const stubPages = {
    create: (input: { title: string }) => {
      const slug = `stub/${input.title}`;
      insertPage(slug, input.title, "entity/person");
      return { slug };
    },
    getBySlug: () => null,
    update: () => {},
    incrementMention: () => {},
    updateType: () => {},
  } as any;

  function verifierRows() {
    return db.rawDb
      .prepare("SELECT action, page_slug, details FROM ingest_log WHERE source_type = 'verifier'")
      .all() as Array<{ action: string; page_slug: string | null; details: string | null }>;
  }

  test("long body zero extraction writes ner_shadow_verifier error row before early-return", async () => {
    insertPage("records/source-1", "Source", "record");
    const pipeline = new ContentPipeline(db, stubEmbedding, stubLance, {
      pages: stubPages,
      nerEngine: {} as any,
    });
    const longBody = "正文".repeat(300); // 600 chars
    const extraction: ExtractionResult = {
      entities: [], relations: [], events: [], facts: [], filtered: [],
    };

    await pipeline.processNer("records/source-1", longBody, "record", true, extraction);

    const rows = verifierRows();
    expect(rows.length).toBe(1);
    expect(rows[0].action).toBe("ner_shadow_verifier");
    expect(rows[0].page_slug).toBe("records/source-1");
    const summary = JSON.parse(rows[0].details!);
    expect(summary.counts.error).toBe(1);
    expect(summary.reasonCounts.ner_zero_from_long_body).toBe(1);
    expect(summary.worst).toBe("error");
  });

  test("normal extraction writes a ner_shadow_verifier row with zero warning/error", async () => {
    insertPage("records/source-1", "Source", "record");
    const pipeline = new ContentPipeline(db, stubEmbedding, stubLance, {
      pages: stubPages, nerEngine: {} as any,
    });
    const extraction: ExtractionResult = {
      entities: [{ name: "实体A", type: "company", relevance: "high", context: "" }],
      relations: [], events: [], facts: [], filtered: [],
    };

    await pipeline.processNer("records/source-1", "正文".repeat(50), "record", true, extraction);

    const rows = verifierRows();
    expect(rows.length).toBe(1);
    const summary = JSON.parse(rows[0].details!);
    expect(summary.counts.warning).toBe(0);
    expect(summary.counts.error).toBe(0);
    expect(summary.worst).toBe("none");
  });

  test("details never leak raw entity names (reason codes only)", async () => {
    insertPage("records/source-1", "Source", "record");
    const pipeline = new ContentPipeline(db, stubEmbedding, stubLance, {
      pages: stubPages, nerEngine: {} as any,
    });
    const extraction: ExtractionResult = {
      entities: [
        { name: "实体A", type: "company", relevance: "high", context: "" },
        { name: "实体A", type: "person", relevance: "high", context: "" }, // dup conflict → warning
      ],
      relations: [{ from: "实体A", to: "孤儿B", relation: "提及", context: "" }],
      events: [], facts: [], filtered: [],
    };

    await pipeline.processNer("records/source-1", "正文".repeat(50), "record", true, extraction);

    const rows = verifierRows();
    expect(rows.length).toBe(1);
    const detailsJson = rows[0].details!;
    for (const forbidden of ["实体A", "孤儿B"]) {
      expect(detailsJson).not.toContain(forbidden);
    }
    const summary = JSON.parse(detailsJson);
    expect(summary.reasonCounts).toEqual({
      ner_relation_endpoint_missing: 1,
      ner_duplicate_name_conflicting_type: 1,
    });
  });

  test("verifier throw is fail-open: NER still succeeds, sanitized warn logged", async () => {
    insertPage("records/source-1", "Source", "record");
    const warnCalls: unknown[] = [];
    const captureLogger = {
      warn: (_m: string, _msg: string, ctx?: unknown) => warnCalls.push(ctx),
      info: () => {}, error: () => {}, debug() {},
    } as any;
    const pipeline = new ContentPipeline(db, stubEmbedding, stubLance, {
      pages: stubPages, nerEngine: {} as any, logger: captureLogger,
    });
    // Force verifier failure by corrupting addIngestLog with a leaky message.
    const leaky = "boom at /Users/secret/x.sqlite entity=实体A slug=records/source-1";
    (db as any).addIngestLog = () => { throw new Error(leaky); };

    const extraction: ExtractionResult = {
      entities: [{ name: "实体A", type: "company", relevance: "high", context: "" }],
      relations: [], events: [], facts: [], filtered: [],
    };
    const result = await pipeline.processNer("records/source-1", "正文".repeat(50), "record", true, extraction);

    expect(result).not.toBeNull();      // NER still completed
    expect(result!.entities).toBe(1);   // entity written
    expect(warnCalls.length).toBe(1);
    const ctx = JSON.stringify(warnCalls[0]);
    expect(ctx).not.toContain("实体A");
    expect(ctx).not.toContain("/Users/secret/x.sqlite");
    expect(ctx).not.toContain("records/source-1");
  });

  test("CBRAIN_SHADOW_VERIFIER_DISABLE=1 writes no verifier rows", async () => {
    process.env.CBRAIN_SHADOW_VERIFIER_DISABLE = "1";
    insertPage("records/source-1", "Source", "record");
    const pipeline = new ContentPipeline(db, stubEmbedding, stubLance, {
      pages: stubPages, nerEngine: {} as any,
    });
    const extraction: ExtractionResult = {
      entities: [], relations: [], events: [], facts: [], filtered: [],
    };
    await pipeline.processNer("records/source-1", "正文".repeat(300), "record", true, extraction);
    expect(verifierRows().length).toBe(0);
  });
});
