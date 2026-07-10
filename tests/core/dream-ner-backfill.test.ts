import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { runDream } from "../../src/core/maintenance/dream.js";
import { PageManager } from "../../src/core/page.js";
import { ContentPipeline } from "../../src/core/ingestion/pipeline.js";
import { NerEngine } from "../../src/core/ingestion/ner.js";
import { IngestManager } from "../../src/core/ingestion/ingest.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import type { SyncManager } from "../../src/core/maintenance/sync.js";
import type { EnrichManager } from "../../src/core/maintenance/enrich.js";
import type { HealthChecker } from "../../src/core/maintenance/health.js";
import type { Logger } from "../../src/core/logger.js";

// ---- mock helpers (mirrored from dream-backup.test.ts) ----

function makeMockSync(): SyncManager {
  return {
    syncAll: async () => ({ synced: 0, skipped: 0, errors: 0 }),
    removeOrphans: async () => [],
    cleanStaleStubs: async () => [],
    cleanLanceOrphans: async () => [],
  } as unknown as SyncManager;
}

function makeMockEnrich(): EnrichManager {
  return { enrichAll: () => [] } as unknown as EnrichManager;
}

function makeMockHealth(): HealthChecker {
  return {
    checkAll: async () => ({
      timestamp: new Date().toISOString(),
      overallStatus: "pass",
      dimensions: [],
      reportPaths: {},
    }),
  } as unknown as HealthChecker;
}

function createMockEmbeddingProvider(): EmbeddingProvider {
  return {
    dimensions: 128,
    embed: async (text: string) => {
      const vec = new Array(128).fill(0);
      for (let i = 0; i < text.length; i++) {
        vec[i % 128] += text.charCodeAt(i) / 65536;
      }
      return { embedding: vec, tokenCount: text.length };
    },
    embedBatch: async (texts: string[]) =>
      texts.map((t) => ({
        embedding: new Array(128).fill(0),
        tokenCount: t.length,
      })),
  };
}

function createMockLanceDB() {
  return {
    connect: async () => {},
    addChunks: async () => {},
    search: async () => [],
    fullTextSearch: async () => [],
    deleteByPageSlug: async () => {},
    deleteRawChunksByPageSlug: async () => {},
    deleteL1VectorByPageSlug: async () => {},
    readRawVectorRows: async () => [],
    readL1VectorRows: async () => [],
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

// ---- harness: wraps runDream with all required mock deps ----

interface RunDreamHarnessOpts {
  nerPipeline?: ContentPipeline;
  sharedPages?: PageManager;
  entityFactsLlm?: LLMProvider;
}

function runDreamHarness(
  db: CBrainDB,
  vaultPath: string,
  outputsDir: string,
  logger: Logger,
  dbPath: string,
  opts: RunDreamHarnessOpts = {},
): ReturnType<typeof runDream> {
  return runDream(
    vaultPath,
    db,
    makeMockSync(),
    makeMockEnrich(),
    makeMockHealth(),
    outputsDir,
    logger,
    undefined, // insightMgr
    dbPath,
    undefined, // sealDeps
    undefined, // lance
    undefined, // onStageProgress
    opts.sharedPages,
    opts.nerPipeline,
    opts.entityFactsLlm,
  );
}

// ---- tests ----

describe("Dream Stage 1.5 ner-backfill (#252)", () => {
  let testDir: string;
  let db: CBrainDB;
  let outputsDir: string;
  let logger: Logger;
  let dbPath: string;
  let vaultPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cbrain-dream-nerbackfill-"));
    dbPath = join(testDir, "brain.sqlite");
    vaultPath = join(testDir, "vault");
    outputsDir = join(testDir, "runtime");
    mkdirSync(vaultPath, { recursive: true });
    mkdirSync(outputsDir, { recursive: true });
    db = new CBrainDB(dbPath);
    logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
    } as unknown as Logger;
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("runDream report includes ner_backfill stage (zeros when no nerPipeline)", async () => {
    const report = await runDreamHarness(db, vaultPath, outputsDir, logger, dbPath);
    expect(report.stages.ner_backfill).toEqual({ processed: 0, failed: 0, timed_out: 0, skipped: 0 });
  });

  test("Stage 1.5 consumes a pending ner-backfill job when nerPipeline provided", async () => {
    // Seed a page (skipNer so no NER runs at ingest time)
    const embedding = createMockEmbeddingProvider();
    const seedIngest = new IngestManager(db, embedding, createMockLanceDB() as never, vaultPath);
    const res = await seedIngest.ingest({
      content: "提到匿名人物甲的正文内容",
      type: "text",
      title: "补抽页",
      skipNer: true,
    });

    // Submit a pending ner-backfill job for that page
    db.submitJob("ner-backfill", { slug: res.slug, pageType: "record" });

    // Build a ContentPipeline with a mock NerEngine that returns an entity
    const llm: LLMProvider = {
      name: "mock",
      chat: async () => JSON.stringify({
        entities: [{ name: "匿名人物甲", type: "person", context: "x" }],
        relations: [],
        events: [],
      }),
    };
    const pages = new PageManager(db, vaultPath);
    const nerPipeline = new ContentPipeline(db, embedding, createMockLanceDB() as never, {
      pages,
      nerEngine: new NerEngine(llm),
    });

    const report = await runDreamHarness(db, vaultPath, outputsDir, logger, dbPath, {
      nerPipeline,
      sharedPages: pages,
    });

    // Stage 1.5 must have processed exactly 1 job
    expect(report.stages.ner_backfill.processed).toBe(1);
    expect(report.stages.ner_backfill.failed).toBe(0);
    expect(report.stages.ner_backfill.skipped).toBe(0);

    // The job must be cleared (no longer pending)
    const pendingJobs = db.listJobs("pending").filter((j) => j.name === "ner-backfill");
    expect(pendingJobs.length).toBe(0);
  });

  test("Stage 1.5 consumes deferred entity facts with the shared runtime LLM", async () => {
    const embedding = createMockEmbeddingProvider();
    const seed = new IngestManager(
      db, embedding, createMockLanceDB() as never, vaultPath,
      undefined, undefined, { nerMode: "off" },
    );
    const entity = await seed.ingest({
      type: "markdown",
      content: "---\ntitle: 实体A\ntype: entity/company\n---\n实体A属于领域C。",
    });
    db.submitJob("ner-backfill", { slug: entity.slug, kind: "entity_facts" });

    const llm: LLMProvider = {
      name: "mock",
      chat: async () => JSON.stringify({ facts: [
        { field: "industry", value: "领域C", confidence: 0.9, evidence: "明确证据" },
      ] }),
    };
    const pages = new PageManager(db, vaultPath);
    const nerPipeline = new ContentPipeline(db, embedding, createMockLanceDB() as never, {
      pages,
      nerEngine: new NerEngine(llm),
    });

    const report = await runDreamHarness(db, vaultPath, outputsDir, logger, dbPath, {
      nerPipeline,
      sharedPages: pages,
      entityFactsLlm: llm,
    });
    expect(report.stages.ner_backfill.processed).toBe(1);
    expect(pages.getBySlug(entity.slug)?.frontmatter.industry).toBe("领域C");
  });
});
