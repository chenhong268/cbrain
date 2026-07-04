import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { ContentPipeline } from "../../src/core/ingestion/pipeline.js";
import type { ExtractionResult } from "../../src/core/ingestion/ner.js";
import { ActionCandidateManager } from "../../src/core/maintenance/action-candidates.js";
import { DiscoveryManager } from "../../src/core/maintenance/discovery.js";
import { HealthChecker, type HealthDimension } from "../../src/core/maintenance/health.js";

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

  test("fail-open sanitizes event/fact/context fields in error messages", async () => {
    insertPage("records/source-1", "Source", "record");
    const warnCalls: unknown[] = [];
    const captureLogger = {
      warn: (_m: string, _msg: string, ctx?: unknown) => warnCalls.push(ctx),
      info: () => {}, error: () => {}, debug() {},
    } as any;
    const pipeline = new ContentPipeline(db, stubEmbedding, stubLance, {
      pages: stubPages, nerEngine: {} as any, logger: captureLogger,
    });
    // Leaky error embedding previously-unredacted fields.
    const leaky = [
      "boom",
      "ctx=实体A是某公司的高管",            // entity context snippet
      "rel=孤儿B 介绍 实体C",                // relation context
      "event=2026年发布于 描述敏感事件D",     // event description
      "participants=实体E,实体F",            // participant names
      "fact=实体G field=role value=敏感职位 evidence=据正文",
    ].join(" | ");
    (db as any).addIngestLog = () => { throw new Error(leaky); };

    const extraction: ExtractionResult = {
      entities: [{ name: "实体A", type: "company", relevance: "high", context: "实体A是某公司的高管" }],
      relations: [{ from: "实体A", to: "孤儿B", relation: "介绍", context: "实体C" }],
      events: [{ date: "2026-07-03", description: "描述敏感事件D", participants: ["实体E", "实体F"] }],
      facts: [{ entity: "实体G", field: "role", value: "敏感职位", confidence: 0.9, evidence: "据正文" }],
      filtered: [],
    };

    const result = await pipeline.processNer("records/source-1", "正文".repeat(50), "record", true, extraction);
    expect(result).not.toBeNull();
    expect(warnCalls.length).toBe(1);
    const ctx = JSON.stringify(warnCalls[0]);
    for (const forbidden of [
      "实体A是某公司的高管", "实体C", "描述敏感事件D", "实体E", "实体F",
      "敏感职位", "据正文", "实体G",
    ]) {
      expect(ctx).not.toContain(forbidden);
    }
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

describe("Discovery shadow verifier hooks", () => {
  const testDir = "/tmp/cbrain-test-verifier-disc";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    process.env.CBRAIN_SHADOW_VERIFIER_DISABLE = "";
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function verifierRows() {
    return db.rawDb
      .prepare("SELECT action, page_slug, details FROM ingest_log WHERE source_type = 'verifier'")
      .all() as Array<{ action: string; page_slug: string | null; details: string | null }>;
  }

  test("persistDrafts writes a discovery_shadow_verifier row per draft; page_slug is null", () => {
    const mgr = new ActionCandidateManager(db);
    mgr.persistDrafts([{
      type: "action_health_review",
      entities: ["health:test:scope"],
      score: 0.6,
      actionable: "medium",
      displayTitle: "有一项健康问题需要人工确认",
      displayReason: "这项信号可能影响知识质量",
      suggestedAction: "人工确认后再决定",
      evidence: [{ source: "health", ref: "health:test:scope", kind: "test" }],
      proposedActions: [{ type: "review", target: "health:test:scope", reason: "复核" }],
      metadata: {},
    }]);

    const rows = verifierRows().filter((r) => r.action === "discovery_shadow_verifier");
    expect(rows.length).toBe(1);
    expect(rows[0].page_slug).toBeNull();
    const summary = JSON.parse(rows[0].details!);
    expect(summary.counts.warning).toBe(0);
    expect(summary.counts.error).toBe(0);
    expect(summary.type).toBe("action_health_review");
  });

  // Note: the unsafe-display case (`discovery_display_private_raw`) is NOT
  // re-tested through persistDrafts because persistDrafts' own
  // assertSafeActionDisplay guard throws on `/Users/` BEFORE the verifier
  // runs — that stronger guard subsumes the verifier check on this path.
  // The verifier check stays valuable on discovery.ts sites B/C (LLM
  // enrichment suggestion text is NOT assert-guarded) and is unit-covered in
  // shadow-verifier.test.ts.

  test("verifier details never leak entity refs / dedup_key / display text", () => {
    const mgr = new ActionCandidateManager(db);
    mgr.persistDrafts([{
      type: "action_health_review",
      entities: ["health:dim:k:records/sensitive-slug"],
      score: 0.6,
      actionable: "medium",
      displayTitle: "敏感标题实体Z",
      displayReason: "理由",
      suggestedAction: "动作",
      evidence: [{ source: "health", ref: "health:dim:k:records/sensitive-slug", kind: "k" }],
      proposedActions: [{ type: "review", target: "health:dim:k:records/sensitive-slug", reason: "r" }],
      metadata: { source_ref: "health:dim:k:records/sensitive-slug" },
    }]);
    const details = verifierRows()[0].details!;
    for (const forbidden of ["records/sensitive-slug", "敏感标题实体Z", "health:dim:k:records/sensitive-slug"]) {
      expect(details).not.toContain(forbidden);
    }
  });

  test("verifier throw inside discovery path is fail-open: candidate still persisted", () => {
    const leaky = "boom entity=实体A /Users/secret";
    (db as any).addIngestLog = () => { throw new Error(leaky); };
    const warnCalls: unknown[] = [];
    const mgr = new ActionCandidateManager(db, {
      warn: (_m: string, _s: string, ctx?: unknown) => warnCalls.push(ctx),
      info: () => {}, error: () => {}, debug() {},
    } as any);
    const report = mgr.persistDrafts([{
      type: "action_health_review",
      entities: ["health:x:y"],
      score: 0.6, actionable: "medium",
      displayTitle: "标题", displayReason: "理由", suggestedAction: "动作",
      evidence: [{ source: "health", ref: "health:x:y", kind: "k" }],
      proposedActions: [{ type: "review", target: "health:x:y", reason: "r" }],
      metadata: {},
    }]);
    expect(report.total).toBe(1);
  });

  test("fail-open verifier error is observable via manager logger (sanitized)", () => {
    // Two captures: warn (must fire) and the sanitized payload (no raw tokens).
    const warnCalls: Array<{ msg: string; ctx: unknown }> = [];
    const mgr = new ActionCandidateManager(db, {
      warn: (_module: string, msg: string, ctx?: unknown) => warnCalls.push({ msg, ctx }),
      info: () => {}, error: () => {}, debug() {},
    } as any);
    // Leaky error: path + raw display text. Both are redaction-design vectors
    // (sanitizeForLog handles /Users/ paths; displayTexts are split-joined to
    // <redacted>). Verifier errors in production come from these sources.
    (db as any).addIngestLog = () => {
      throw new Error("boom at /Users/secret/x.md display=敏感标题实体Z");
    };
    const report = mgr.persistDrafts([{
      type: "action_health_review",
      entities: ["health:x:y"],
      score: 0.6, actionable: "medium",
      displayTitle: "敏感标题实体Z", displayReason: "理由", suggestedAction: "动作",
      evidence: [{ source: "health", ref: "health:x:y", kind: "k" }],
      proposedActions: [{ type: "review", target: "health:x:y", reason: "r" }],
      metadata: {},
    }]);
    // fail-open: candidate still persisted
    expect(report.total).toBe(1);
    // observable: warn fired
    expect(warnCalls.length).toBe(1);
    // sanitized: raw tokens redacted
    const ctxJson = JSON.stringify(warnCalls[0].ctx);
    expect(ctxJson).not.toContain("/Users/secret/x.md");
    expect(ctxJson).not.toContain("敏感标题实体Z");
  });

  test("DiscoveryManager.runDiscovery gap path writes discovery_shadow_verifier rows (page_slug=null)", async () => {
    // Seed a high-mention, zero-link entity page → deterministic gap detector fires
    // (no LLM needed: types=["gap"] skips detectContradictions). Proves discovery.ts wiring.
    db.rawDb
      .prepare("INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("entity/test-entity", "entity/person", "实体A", "entity-test-entity.md", "h1", 10, 3);
    const mgr = new DiscoveryManager(db, undefined, { warn() {}, info() {}, error() {}, debug() {} } as any);
    await mgr.runDiscovery(["gap"]);
    const discRows = verifierRows().filter((r) => r.action === "discovery_shadow_verifier");
    expect(discRows.length).toBeGreaterThan(0);
    expect(discRows.every((r) => r.page_slug === null)).toBe(true);
    for (const row of discRows) {
      const summary = JSON.parse(row.details!);
      expect(summary.reasonCounts.discovery_high_actionable_no_evidence ?? 0).toBe(0);
    }
    // If this fails because detectGaps did not fire under this seed, adjust the seed
    // (raise mention_count / widen title) rather than deleting the test.
  });
});

describe("HealthChecker.checkVerifierQuality", () => {
  const testDir = "/tmp/cbrain-test-verifier-health";
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

  function findVerifierDim(report: { dimensions: HealthDimension[] }): HealthDimension {
    return report.dimensions.find((d) => d.name === "生成质量影子校验")!;
  }
  function writeNerRow(warning: number, error: number) {
    db.addIngestLog("verifier", "ner_shadow_verifier", "x", JSON.stringify({
      surface: "ner", checks: 6,
      counts: { info: 0, warning, error },
      reasonCounts: error > 0 ? { ner_zero_from_long_body: error } : { ner_invalid_event_date: warning },
      worst: error > 0 ? "error" : "warning",
    }));
  }
  function writeDiscoveryRow(warning: number, error: number) {
    db.addIngestLog("verifier", "discovery_shadow_verifier", null, JSON.stringify({
      surface: "discovery", type: "gap", checks: 5,
      counts: { info: 0, warning, error },
      reasonCounts: error > 0
        ? { discovery_high_actionable_no_evidence: error }
        : { discovery_display_private_raw: warning },
      worst: error > 0 ? "error" : "warning",
    }));
  }

  test("clean → pass, no issues", async () => {
    const report = await checker.checkAll();
    const dim = findVerifierDim(report);
    expect(dim.status).toBe("pass");
    expect(dim.issues).toEqual([]);
  });

  test("ner error → dimension fail, issue severity high", async () => {
    writeNerRow(0, 2);
    const report = await checker.checkAll();
    const dim = findVerifierDim(report);
    expect(dim.status).toBe("fail");
    expect(dim.issues.some((i) => i.severity === "high")).toBe(true);
  });

  test("warning only → warn, issue severity medium", async () => {
    writeNerRow(3, 0);
    const report = await checker.checkAll();
    const dim = findVerifierDim(report);
    expect(dim.status).toBe("warn");
    expect(dim.issues.some((i) => i.severity === "medium")).toBe(true);
  });

  test("discovery verifier errors are observe-only warnings in health", async () => {
    writeDiscoveryRow(0, 299);
    const report = await checker.checkAll();
    const dim = findVerifierDim(report);
    expect(dim.status).toBe("warn");
    expect(dim.issues.every((i) => i.severity !== "high")).toBe(true);
    expect(dim.issues.some((i) => i.severity === "medium")).toBe(true);
  });

  test("issue text says '生成质量风险' (not 'data corruption' / '损坏')", async () => {
    writeNerRow(0, 1);
    const report = await checker.checkAll();
    const dim = findVerifierDim(report);
    const text = JSON.stringify(dim);
    expect(text).toContain("生成质量风险");
    expect(text).not.toContain("损坏");
    expect(text).not.toContain("腐坏");
  });

  test("health output contains no raw slugs / entity names / page_slug field name", async () => {
    writeNerRow(0, 1);
    db.addIngestLog("verifier", "discovery_shadow_verifier", null, JSON.stringify({
      surface: "discovery", type: "action_review_discovery", checks: 5,
      counts: { info: 0, warning: 1, error: 0 },
      reasonCounts: { discovery_display_private_raw: 1 }, worst: "warning",
    }));
    const report = await checker.checkAll();
    const fullMd = checker.writeFullReport(report);
    const { reportPaths: _rp, ...rest } = report;
    const json = JSON.stringify(rest);
    for (const forbidden of ["entity/", "records/", "page_slug", "file_path", "实体A"]) {
      expect(json).not.toContain(forbidden);
      expect(fullMd).not.toContain(forbidden);
    }
  });
});
