import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { ContentPipeline } from "../../src/core/ingestion/pipeline.js";
import type { ExtractionResult } from "../../src/core/ingestion/ner.js";
import { HealthChecker } from "../../src/core/maintenance/health.js";

describe("ner_quality_log storage", () => {
  const testDir = "/tmp/cbrain-test-ner-quality";
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

  test("table created on startup with anonymized columns", () => {
    const cols = db.rawDb
      .prepare("PRAGMA table_info(ner_quality_log)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);

    // Required count columns
    for (const col of [
      "extracted_entities", "extracted_concepts", "filtered_total",
      "filter_reasons_json", "resolved_existing", "alias_added",
      "stub_created", "duplicate_candidate", "relations_total",
      "relations_written", "relations_skipped", "created_at",
    ]) {
      expect(names).toContain(col);
    }

    // NO raw columns — anonymized per #167
    for (const forbidden of ["page_slug", "entity_name", "title", "body", "prompt", "file_path"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  test("migration is idempotent", () => {
    // Re-running the CREATE must not throw (IF NOT EXISTS).
    expect(() =>
      db.rawDb.exec(`
        CREATE TABLE IF NOT EXISTS ner_quality_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          extracted_entities INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
    ).not.toThrow();
  });

  test("logNerQuality inserts a row and getNerQualityStats aggregates it", () => {
    db.logNerQuality({
      extractedEntities: 3,
      extractedConcepts: 1,
      filteredTotal: 2,
      filterReasons: { generic_suffix: 1, low_relevance: 1 },
      resolvedExisting: 2,
      aliasAdded: 1,
      stubCreated: 1,
      duplicateCandidate: 0,
      relationsTotal: 4,
      relationsWritten: 3,
    });

    const stats = db.getNerQualityStats(7);
    expect(stats.runs).toBe(1);
    expect(stats.extractedEntities).toBe(3);
    expect(stats.extractedConcepts).toBe(1);
    expect(stats.filteredTotal).toBe(2);
    expect(stats.filteredRate).toBeCloseTo(2 / (4 + 2), 5); // filtered / (kept + filtered)
    expect(stats.resolvedExisting).toBe(2);
    expect(stats.aliasAdded).toBe(1);
    expect(stats.stubCreated).toBe(1);
    expect(stats.duplicateCandidate).toBe(0);
    expect(stats.relationsTotal).toBe(4);
    expect(stats.relationsSkipped).toBe(1);
    expect(stats.relationSkipRate).toBeCloseTo(0.25, 5);
    expect(stats.topFilterReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "generic_suffix", count: 1 }),
        expect.objectContaining({ reason: "low_relevance", count: 1 }),
      ]),
    );
    expect(stats.periodDays).toBe(7);
  });

  test("getNerQualityStats returns zeroed stats when no rows", () => {
    const stats = db.getNerQualityStats(7);
    expect(stats.runs).toBe(0);
    expect(stats.filteredRate).toBe(0);
    expect(stats.topFilterReasons).toEqual([]);
    expect(stats.periodDays).toBe(7);
  });

  test("getNerQualityStats respects the day window", () => {
    // Insert an old row directly (bypass the DEFAULT created_at).
    db.logNerQuality({
      extractedEntities: 1, extractedConcepts: 0, filteredTotal: 0,
      filterReasons: {}, resolvedExisting: 1, aliasAdded: 0,
      stubCreated: 0, duplicateCandidate: 0, relationsTotal: 0, relationsWritten: 0,
    });
    db.rawDb
      .prepare("UPDATE ner_quality_log SET created_at = datetime('now', '-30 days')")
      .run();
    db.logNerQuality({
      extractedEntities: 2, extractedConcepts: 0, filteredTotal: 0,
      filterReasons: {}, resolvedExisting: 2, aliasAdded: 0,
      stubCreated: 0, duplicateCandidate: 0, relationsTotal: 0, relationsWritten: 0,
    });

    const week = db.getNerQualityStats(7);
    expect(week.runs).toBe(1);          // only the recent row
    expect(week.extractedEntities).toBe(2);

    const month = db.getNerQualityStats(30);
    expect(month.runs).toBe(2);         // both rows
  });
});

describe("ContentPipeline NER quality logging", () => {
  const testDir = "/tmp/cbrain-test-ner-quality-pipe";
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

  // Minimal stubs — pipeline only reads .embedBatch from embedding and writes via db.
  const stubEmbedding = {
    embedBatch: async (texts: string[]) => texts.map(() => ({ embedding: [0, 0], tokenCount: 1 })),
    embedQuery: async () => ({ embedding: [0, 0], tokenCount: 1 }),
  } as any;
  const stubLance = {
    deleteRawChunksByPageSlug: async () => {},
    deleteL1VectorByPageSlug: async () => {},
    addChunks: async () => {},
  } as any;
  // Minimal PageManager stub so applyExtraction's stub_created branch runs and
  // populates entitySlugMap (lets one relation resolve, the other skip).
  // create() inserts a real page row so links-table FK constraints hold.
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

  test("applyExtraction records anonymized counts to ner_quality_log", async () => {
    insertPage("records/source-1", "Source", "record");
    const pipeline = new ContentPipeline(db, stubEmbedding, stubLance, {
      pages: stubPages,
      nerEngine: {} as any, // truthy — precomputed extraction bypasses .extract()
    });

    // Drive applyExtraction via the public processNer with a precomputed extraction.
    const extraction: ExtractionResult = {
      entities: [
        { name: "甲公司", type: "company", relevance: "high", context: "" },
        { name: "某模型", type: "model", relevance: "medium", context: "" },
      ],
      relations: [
        { from: "甲公司", to: "某模型", relation: "研发", context: "" },
        { from: "甲公司", to: "不存在", relation: "提及", context: "" }, // skipped (no slug)
      ],
      events: [],
      facts: [],
      filtered: [
        { name: "噪声词A", reason: "generic_suffix" },
        { name: "噪声词B", reason: "low_relevance" },
        { name: "噪声词C", reason: "generic_suffix" },
      ],
    };

    await pipeline.processNer("records/source-1", "正文…", "record", true, extraction);

    const stats = db.getNerQualityStats(7);
    expect(stats.runs).toBe(1);
    expect(stats.filteredTotal).toBe(3);
    // Two kept entities; entity/concept split is via mapEntityType — assert the sum
    // so the test doesn't bake in an ontology-mapping assumption.
    expect(stats.extractedEntities + stats.extractedConcepts).toBe(2);
    // Both candidates are new → stub_created resolver outcome.
    expect(stats.stubCreated).toBe(2);
    expect(stats.resolvedExisting).toBe(0);
    expect(stats.aliasAdded).toBe(0);
    expect(stats.duplicateCandidate).toBe(0);
    expect(stats.relationsTotal).toBe(2);
    expect(stats.relationsSkipped).toBe(1);  // the "不存在" relation
    expect(stats.topFilterReasons.find((r) => r.reason === "generic_suffix")?.count).toBe(2);

    // Anonymity: the raw page slug / entity names must NOT be persisted anywhere in the table.
    const dump = JSON.stringify(
      db.rawDb.prepare("SELECT * FROM ner_quality_log").all(),
    );
    expect(dump).not.toContain("records/source-1");
    expect(dump).not.toContain("甲公司");
    expect(dump).not.toContain("噪声词A");
  });

  test("existing-entity resolution creates one weak candidate mention without downgrading trusted evidence", async () => {
    insertPage("records/source-mention", "来源记录", "record");
    insertPage("entity/company/a", "实体A", "entity/company");
    const pipeline = new ContentPipeline(db, stubEmbedding, stubLance, {
      pages: stubPages,
      nerEngine: {} as any,
    });
    const extraction: ExtractionResult = {
      entities: [{ name: "实体A", type: "company", relevance: "high", context: "" }],
      relations: [], events: [], facts: [], filtered: [],
    };

    await pipeline.processNer("records/source-mention", "正文", "record", true, extraction, new Set(["entity/company/a"]));
    await pipeline.processNer("records/source-mention", "正文", "record", true, extraction, new Set(["entity/company/a"]));
    let row = db.rawDb.prepare(
      "SELECT COUNT(*) count, MIN(strength) strength, MIN(trust_state) trust_state FROM links WHERE from_slug=? AND to_slug=? AND relation='提及'",
    ).get("records/source-mention", "entity/company/a") as { count: number; strength: string; trust_state: string };
    expect(row).toEqual({ count: 1, strength: "weak", trust_state: "candidate" });
    expect(db.getPage("entity/company/a")!.mention_count).toBe(0);

    db.rawDb.prepare("DELETE FROM links WHERE from_slug=? AND to_slug=? AND relation='提及'").run("records/source-mention", "entity/company/a");
    db.rawDb.prepare(
      "INSERT INTO links (from_slug,to_slug,relation,weight,strength,source_type,confidence,trust_state) VALUES (?,?, '提及',0.9,'strong','manual',1,'trusted')",
    ).run("records/source-mention", "entity/company/a");
    await pipeline.processNer("records/source-mention", "正文", "record", true, extraction);
    row = db.rawDb.prepare(
      "SELECT COUNT(*) count, MIN(strength) strength, MIN(trust_state) trust_state FROM links WHERE from_slug=? AND to_slug=? AND relation='提及'",
    ).get("records/source-mention", "entity/company/a") as { count: number; strength: string; trust_state: string };
    expect(row).toEqual({ count: 1, strength: "strong", trust_state: "trusted" });
  });

  test("guarded resolution defers alias, shadow audit, mention and graph writes until final fence", async () => {
    insertPage("records/source-guard", "来源记录", "record");
    insertPage("entity/company/a", "实体A", "entity/company");
    const pipeline = new ContentPipeline(db, stubEmbedding, stubLance, {
      pages: stubPages,
      nerEngine: {} as any,
    });
    const extraction: ExtractionResult = {
      entities: [{ name: "实体A（组织）", type: "company", relevance: "high", context: "" }],
      relations: [], events: [], facts: [], filtered: [],
    };
    const phases: string[] = [];
    await expect(pipeline.processNer(
      "records/source-guard",
      "正文".repeat(100),
      "record",
      true,
      extraction,
      new Set(),
      (phase) => {
        phases.push(phase);
        if (phase === "before_commit") throw new Error("NER_SOURCE_CHANGED");
      },
    )).rejects.toThrow("NER_SOURCE_CHANGED");
    expect(phases).toEqual(["after_extract", "before_commit"]);
    expect(db.rawDb.prepare("SELECT COUNT(*) count FROM aliases").get()).toEqual({ count: 0 });
    expect(db.rawDb.prepare("SELECT COUNT(*) count FROM links").get()).toEqual({ count: 0 });
    expect(db.rawDb.prepare("SELECT COUNT(*) count FROM ingest_log WHERE source_type='verifier'").get()).toEqual({ count: 0 });
    expect(db.getPage("entity/company/a")!.mention_count).toBe(0);

    await pipeline.processNer(
      "records/source-guard", "正文", "record", true, extraction, new Set(), () => {},
    );
    expect(db.rawDb.prepare("SELECT alias, source FROM aliases").get()).toEqual({ alias: "实体A（组织）", source: "ner-resolved" });
    expect(db.rawDb.prepare("SELECT COUNT(*) count FROM links").get()).toEqual({ count: 1 });
  });

  test("guarded semantic alias preserves llm-semantic provenance", async () => {
    insertPage("records/source-semantic", "来源记录", "record");
    insertPage("entity/company/a", "实体A", "entity/company");
    const provider = {
      chat: async () => JSON.stringify({ matches: [{ candidate: "别名A", entity: "实体A", confidence: 0.95 }] }),
    };
    const pipeline = new ContentPipeline(db, stubEmbedding, stubLance, {
      pages: stubPages,
      nerEngine: { provider } as any,
    });
    const extraction: ExtractionResult = {
      entities: [{ name: "别名A", type: "company", relevance: "high", context: "" }],
      relations: [], events: [], facts: [], filtered: [],
    };
    await pipeline.processNer("records/source-semantic", "正文", "record", true, extraction, new Set(), () => {});
    expect(db.rawDb.prepare("SELECT alias, source FROM aliases").get()).toEqual({ alias: "别名A", source: "llm-semantic" });
  });

  test("after-extract guard failure happens before empty-extraction shadow audit", async () => {
    insertPage("records/source-empty", "来源记录", "record");
    const pipeline = new ContentPipeline(db, stubEmbedding, stubLance, {
      pages: stubPages,
      nerEngine: {} as any,
    });
    const extraction: ExtractionResult = { entities: [], relations: [], events: [], facts: [], filtered: [] };
    await expect(pipeline.processNer(
      "records/source-empty", "正文".repeat(300), "record", true, extraction, new Set(), () => { throw new Error("NER_ATTEMPT_REVOKED"); },
    )).rejects.toThrow("NER_ATTEMPT_REVOKED");
    expect(db.rawDb.prepare("SELECT COUNT(*) count FROM ingest_log WHERE source_type='verifier'").get()).toEqual({ count: 0 });
  });

  test("logNerQuality failure is fail-open — NER still returns, no rollback, sanitized log (#167)", async () => {
    insertPage("records/source-1", "Source", "record");

    // Capture logger.warn to assert sanitized output.
    const warnCalls: Array<{ ctx: unknown }> = [];
    const captureLogger = {
      warn: (_module: string, _msg: string, ctx?: unknown) => warnCalls.push({ ctx }),
      info: () => {},
      error: () => {},
      debug: () => {},
    } as any;

    const pipeline = new ContentPipeline(db, stubEmbedding, stubLance, {
      pages: stubPages,
      nerEngine: {} as any, // truthy — precomputed extraction bypasses .extract()
      logger: captureLogger,
    });

    // Inject an error whose message is packed with leak vectors: absolute path,
    // credential-like tokens, AND raw extraction tokens (entity names / slug).
    const leakyMessage = [
      "no such table: ner_quality_log at /Users/secret/cbrain.sqlite",
      "auth key=sk-abcd1234efgh5678 bearer=Bearer abc.def.ghi token=AKIAIOSFODNN7EXAMPLE",
      "while resolving entity=甲公司 slug=records/source-1 filtered=噪声词A rel=某模型",
    ].join(" | ");
    (db as any).logNerQuality = () => { throw new Error(leakyMessage); };;

    const extraction: ExtractionResult = {
      entities: [
        { name: "甲公司", type: "company", relevance: "high", context: "" },
        { name: "某模型", type: "model", relevance: "medium", context: "" },
      ],
      relations: [
        { from: "甲公司", to: "某模型", relation: "研发", context: "" },
      ],
      events: [],
      facts: [],
      filtered: [{ name: "噪声词A", reason: "generic_suffix" }],
    };

    // Must not throw, must not return null — observe-only metrics can't break NER.
    const result = await pipeline.processNer("records/source-1", "正文…", "record", true, extraction);
    expect(result).not.toBeNull();
    expect(result!.entities).toBe(2);

    // Already-applied writes survive (no rollback): stubs + relation link.
    const linkCount = (db.rawDb.prepare("SELECT COUNT(*) as c FROM links").get() as { c: number }).c;
    expect(linkCount).toBeGreaterThan(0);

    // Sanitized log: redaction markers present, NO original leak vectors.
    expect(warnCalls.length).toBe(1);
    const ctxJson = JSON.stringify(warnCalls[0].ctx);
    expect(ctxJson).toContain("<path>");      // absolute path redacted
    expect(ctxJson).toContain("<redacted>");  // credential / raw token redacted
    for (const forbidden of [
      "/Users/secret/cbrain.sqlite",          // absolute path
      "sk-abcd1234efgh5678",                   // api key
      "Bearer abc.def.ghi",                    // bearer token
      "AKIAIOSFODNN7EXAMPLE",                  // aws key
      "甲公司", "某模型", "噪声词A", "records/source-1",  // raw extraction tokens
    ]) {
      expect(ctxJson).not.toContain(forbidden);
    }
  });
});

describe("HealthChecker.checkNerQuality", () => {
  const testDir = "/tmp/cbrain-test-ner-quality-health";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let checker: HealthChecker;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    checker = new HealthChecker(db, join(testDir, "outputs"));
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function findNerDim(report: { dimensions: Array<{ name: string; status: string; issues: Array<{ title: string }> }> }) {
    return report.dimensions.find((d) => d.name === "NER 质量")!;
  }

  test("no NER data → pass, non-error", async () => {
    const report = await checker.checkAll();
    const dim = findNerDim(report);
    expect(dim).toBeDefined();
    expect(dim.status).toBe("pass");
    expect(dim.issues).toEqual([]);
  });

  test("low noise → pass", async () => {
    db.logNerQuality({
      extractedEntities: 8, extractedConcepts: 2, filteredTotal: 1,
      filterReasons: { low_relevance: 1 },
      resolvedExisting: 7, aliasAdded: 2, stubCreated: 1, duplicateCandidate: 0,
      relationsTotal: 5, relationsWritten: 5,
    });
    const report = await checker.checkAll();
    expect(findNerDim(report).status).toBe("pass");
  });

  test("high filtered rate → warn", async () => {
    // kept 4, filtered 8 → filteredRate = 8/12 ≈ 0.67 > 0.6
    db.logNerQuality({
      extractedEntities: 3, extractedConcepts: 1, filteredTotal: 8,
      filterReasons: { generic_suffix: 5, blacklisted: 3 },
      resolvedExisting: 3, aliasAdded: 1, stubCreated: 0, duplicateCandidate: 0,
      relationsTotal: 2, relationsWritten: 2,
    });
    const report = await checker.checkAll();
    const dim = findNerDim(report);
    expect(dim.status).toBe("warn");
    expect(dim.issues.some((i) => /过滤/.test(i.title))).toBe(true);
  });

  test("high duplicate/type-gate rate → warn", async () => {
    // outcomes: resolved 2, duplicate 4 → duplicateRate = 4/6 ≈ 0.67 > 0.4
    db.logNerQuality({
      extractedEntities: 4, extractedConcepts: 2, filteredTotal: 1,
      filterReasons: {},
      resolvedExisting: 2, aliasAdded: 0, stubCreated: 0, duplicateCandidate: 4,
      relationsTotal: 3, relationsWritten: 3,
    });
    const report = await checker.checkAll();
    expect(findNerDim(report).status).toBe("warn");
  });

  test("metrics output contains no raw names / slugs / paths", async () => {
    db.logNerQuality({
      extractedEntities: 1, extractedConcepts: 0, filteredTotal: 0,
      filterReasons: {},
      resolvedExisting: 1, aliasAdded: 0, stubCreated: 0, duplicateCandidate: 0,
      relationsTotal: 0, relationsWritten: 0,
    });
    const report = await checker.checkAll();
    const fullMd = checker.writeFullReport(report);
    // Strip reportPaths (legitimate health output paths, not vault content) before
    // checking the JSON for leaked vault slugs.
    const { reportPaths: _rp, ...detailWithoutPaths } = report;
    const detailJson = JSON.stringify(detailWithoutPaths);

    // No vault slugs / raw entity names may leak into health output.
    for (const forbidden of ["entity/", "records/", "concepts/", "甲公司", "page_slug", "file_path"]) {
      expect(detailJson).not.toContain(forbidden);
      expect(fullMd).not.toContain(forbidden);
    }
  });
});
