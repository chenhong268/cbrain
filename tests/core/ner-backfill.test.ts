import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite";
import { NER_BACKFILL_STALE_TTL_MS, NER_BACKFILL_JOB } from "../../src/core/ner-backfill";
import { JobQueueNerSubmitter, resolveNerBody } from "../../src/core/ner-backfill";
import { IngestManager } from "../../src/core/ingest";
import { PageManager } from "../../src/core/page";
import type { EmbeddingProvider } from "../../src/embedding/provider";
import { runNerBackfillStage } from "../../src/core/ner-backfill";
import { ContentPipeline } from "../../src/core/pipeline";
import { NerEngine, NerTimeoutError } from "../../src/core/ner";
import type { LLMProvider } from "../../src/llm/provider";

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

const testDir = "/tmp/cbrain-test-ner-backfill";
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

describe("findActiveNerJobs (#252)", () => {
  test("no jobs → empty", () => {
    expect(db.findActiveNerJobs("records/foo", NER_BACKFILL_STALE_TTL_MS)).toEqual([]);
  });
  test("pending job for slug counts as active", () => {
    db.submitJob("ner-backfill", { slug: "records/foo" });
    expect(db.findActiveNerJobs("records/foo", NER_BACKFILL_STALE_TTL_MS).length).toBe(1);
  });
  test("pending job for a different slug does not match", () => {
    db.submitJob("ner-backfill", { slug: "records/bar" });
    expect(db.findActiveNerJobs("records/foo", NER_BACKFILL_STALE_TTL_MS)).toEqual([]);
  });
  test("fresh running job counts as active", () => {
    const id = db.submitJob("ner-backfill", { slug: "records/foo" });
    db.claimJobById(id); // pending → running, started_at = now
    expect(db.findActiveNerJobs("records/foo", NER_BACKFILL_STALE_TTL_MS).length).toBe(1);
  });
  test("stale running job does NOT count as active", () => {
    const id = db.submitJob("ner-backfill", { slug: "records/foo" });
    db.claimJobById(id);
    // backdate started_at beyond TTL
    db.rawDb.prepare("UPDATE jobs SET started_at = datetime('now','-2 hours') WHERE id = ?").run(id);
    expect(db.findActiveNerJobs("records/foo", NER_BACKFILL_STALE_TTL_MS)).toEqual([]);
  });
  test("claimJobById returns null for an already-claimed (running) job", () => {
    const id = db.submitJob("ner-backfill", { slug: "records/foo" });
    expect(db.claimJobById(id)).not.toBeNull();   // first claim succeeds
    expect(db.claimJobById(id)).toBeNull();       // second claim → null (no longer pending)
  });
  test("findActiveNerJobs ignores non-ner-backfill job names", () => {
    db.submitJob("dream", { slug: "records/foo" });
    expect(db.findActiveNerJobs("records/foo", NER_BACKFILL_STALE_TTL_MS)).toEqual([]);
  });
});

describe("resetStaleJobsForNames (#252)", () => {
  test("stale running ner-backfill is reset to pending", () => {
    const id = db.submitJob("ner-backfill", { slug: "records/foo" });
    db.claimJobById(id);
    db.rawDb.prepare("UPDATE jobs SET started_at = datetime('now','-2 hours') WHERE id = ?").run(id);
    const reset = db.resetStaleJobsForNames([NER_BACKFILL_JOB], NER_BACKFILL_STALE_TTL_MS);
    expect(reset).toBe(1);
    const row = db.getJob(id)!;
    expect(row.status).toBe("pending");
  });
  test("fresh running job is NOT reset", () => {
    const id = db.submitJob("ner-backfill", { slug: "records/foo" });
    db.claimJobById(id);
    expect(db.resetStaleJobsForNames([NER_BACKFILL_JOB], NER_BACKFILL_STALE_TTL_MS)).toBe(0);
    expect(db.getJob(id)!.status).toBe("running");
  });
  test("does not touch other job names", () => {
    const id = db.submitJob("dream", {});
    db.claimJobById(id);
    db.rawDb.prepare("UPDATE jobs SET started_at = datetime('now','-2 hours') WHERE id = ?").run(id);
    expect(db.resetStaleJobsForNames([NER_BACKFILL_JOB], NER_BACKFILL_STALE_TTL_MS)).toBe(0);
  });
});

describe("snapshotEligibleJobIds (#252)", () => {
  test("returns pending ner-backfill ids ordered by priority then id, bounded by limit", () => {
    const a = db.submitJob("ner-backfill", { slug: "a" }, 0);
    const b = db.submitJob("ner-backfill", { slug: "b" }, 5);
    const c = db.submitJob("ner-backfill", { slug: "c" }, 5);
    db.claimJobById(a);
    const ids = db.snapshotEligibleJobIds([NER_BACKFILL_JOB], 50);
    expect(ids).toEqual([b, c]);
  });
  test("respects limit", () => {
    db.submitJob("ner-backfill", { slug: "a" }, 0);
    db.submitJob("ner-backfill", { slug: "b" }, 0);
    expect(db.snapshotEligibleJobIds([NER_BACKFILL_JOB], 1).length).toBe(1);
  });
});

describe("JobQueueNerSubmitter (#252)", () => {
  test("first submit returns a job id and creates a pending ner-backfill job", () => {
    const s = new JobQueueNerSubmitter(db);
    const id = s.submitDeferredNer({ slug: "records/foo", pageType: "record" });
    expect(id).not.toBeNull();
    const job = db.getJob(id!)!;
    expect(job.name).toBe("ner-backfill");
    expect(job.status).toBe("pending");
    expect(JSON.parse(job.data!)).toEqual({ slug: "records/foo", pageType: "record" });
  });
  test("second submit for same slug is deduped (returns null, no new job)", () => {
    const s = new JobQueueNerSubmitter(db);
    const first = s.submitDeferredNer({ slug: "records/foo" });
    expect(first).not.toBeNull();
    expect(s.submitDeferredNer({ slug: "records/foo" })).toBeNull();
    expect(db.listJobs("pending").length).toBe(1);
  });
  test("different slug submits a second job", () => {
    const s = new JobQueueNerSubmitter(db);
    s.submitDeferredNer({ slug: "records/foo" });
    const second = s.submitDeferredNer({ slug: "records/bar" });
    expect(second).not.toBeNull();
    expect(db.listJobs("pending").length).toBe(2);
  });
  test("stale running same slug does NOT dedupe (new job allowed)", () => {
    const s = new JobQueueNerSubmitter(db);
    const first = s.submitDeferredNer({ slug: "records/foo" })!;
    db.claimJobById(first);
    db.rawDb.prepare("UPDATE jobs SET started_at = datetime('now','-2 hours') WHERE id = ?").run(first);
    // stale running is not "active" → submit proceeds
    expect(s.submitDeferredNer({ slug: "records/foo" })).not.toBeNull();
  });
});

describe("resolveNerBody (#252)", () => {
  test("returns current body + type for a normal (unsealed) page", async () => {
    const embedding = createMockEmbeddingProvider();
    const ingest = new IngestManager(db, embedding, createMockLanceDB() as never, testDir);
    const res = await ingest.ingest({ content: "匿名未密封页正文", type: "text", title: "匿名页", skipNer: true });
    const pm = new PageManager(db, testDir);
    const out = resolveNerBody(db, pm, res.slug);
    expect(out).not.toBeNull();
    expect(out!.type).toBe("record");
    expect(out!.body).toContain("匿名未密封页正文");
  });

  test("sealed page falls back to summary_level=0 raw chunks", async () => {
    const embedding = createMockEmbeddingProvider();
    const ingest = new IngestManager(db, embedding, createMockLanceDB() as never, testDir);
    const res = await ingest.ingest({ content: "匿名密封页原始内容片段", type: "text", title: "密封页", skipNer: true });
    // simulate sealing: insert an L1 summary chunk (summary_level=1)
    db.rawDb.prepare(
      "INSERT INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 0, ?, 1)"
    ).run(res.slug, "这是摘要，不是原始正文");
    const pm = new PageManager(db, testDir);
    const out = resolveNerBody(db, pm, res.slug);
    expect(out).not.toBeNull();
    expect(out!.body).toContain("匿名密封页原始内容片段");
    expect(out!.body).not.toContain("这是摘要");
  });

  test("sealed page with no raw chunks → null (clear fail)", async () => {
    const embedding = createMockEmbeddingProvider();
    const ingest = new IngestManager(db, embedding, createMockLanceDB() as never, testDir);
    const res = await ingest.ingest({ content: "x", type: "text", title: "空密封", skipNer: true });
    db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 0, ?, 1)").run(res.slug, "sum");
    db.rawDb.prepare("DELETE FROM chunks WHERE page_slug = ? AND summary_level = 0").run(res.slug);
    const pm = new PageManager(db, testDir);
    expect(resolveNerBody(db, pm, res.slug)).toBeNull();
  });
});

function pipelineWith(llm: LLMProvider): ContentPipeline {
  return new ContentPipeline(db, createMockEmbeddingProvider(), createMockLanceDB() as never, {
    pages: new PageManager(db, testDir),
    nerEngine: new NerEngine(llm),
  });
}

describe("runNerBackfillStage (#252)", () => {
  test("consumes a pending job and produces entity/link output", async () => {
    const embedding = createMockEmbeddingProvider();
    const seedIngest = new IngestManager(db, embedding, createMockLanceDB() as never, testDir);
    const res = await seedIngest.ingest({ content: "提到匿名实体乙的正文", type: "text", title: "p1", skipNer: true });
    db.submitJob("ner-backfill", { slug: res.slug, pageType: "record" });

    const llm: LLMProvider = {
      name: "mock",
      chat: async () => JSON.stringify({
        entities: [{ name: "匿名实体乙", type: "person", context: "x" }], relations: [], events: [],
      }),
    };
    const pages = new PageManager(db, testDir);
    const counts = await runNerBackfillStage(db, pipelineWith(llm), pages);
    expect(counts.processed).toBe(1);
    expect(db.listJobs("pending").length).toBe(0);
    const stub = db.rawDb.prepare("SELECT * FROM pages WHERE title = ?").get("匿名实体乙") as any;
    expect(stub).toBeTruthy();
  });

  test("stale running job is recovered and processed in the same run", async () => {
    const embedding = createMockEmbeddingProvider();
    const seedIngest = new IngestManager(db, embedding, createMockLanceDB() as never, testDir);
    const res = await seedIngest.ingest({ content: "提到匿名实体丙", type: "text", title: "p2", skipNer: true });
    const id = db.submitJob("ner-backfill", { slug: res.slug });
    db.claimJobById(id);
    db.rawDb.prepare("UPDATE jobs SET started_at = datetime('now','-2 hours') WHERE id = ?").run(id);

    const llm: LLMProvider = { name: "mock", chat: async () => '{"entities":[],"relations":[],"events":[]}' };
    const counts = await runNerBackfillStage(db, pipelineWith(llm), new PageManager(db, testDir));
    expect(counts.processed).toBe(1);
    expect(db.getJob(id)!.status).toBe("done");
  });

  test("a failing job is attempted at most once per run (no retry starvation)", async () => {
    const embedding = createMockEmbeddingProvider();
    const seedIngest = new IngestManager(db, embedding, createMockLanceDB() as never, testDir);
    const res = await seedIngest.ingest({ content: "失败页正文", type: "text", title: "p3", skipNer: true });
    db.submitJob("ner-backfill", { slug: res.slug });

    const llm: LLMProvider = { name: "mock", chat: async () => { throw new Error("boom"); } };
    const counts = await runNerBackfillStage(db, pipelineWith(llm), new PageManager(db, testDir), { maxItems: 50 });
    expect(counts.failed).toBe(1);
    const job = db.listJobs("pending")[0];
    expect(job.attempts).toBe(1);
    expect(job.status).toBe("pending");
  });

  test("NER timeout during processing → timed_out count, job retryable, no index corruption", async () => {
    const embedding = createMockEmbeddingProvider();
    const seedIngest = new IngestManager(db, embedding, createMockLanceDB() as never, testDir);
    const res = await seedIngest.ingest({ content: "超时页正文", type: "text", title: "p4", skipNer: true });
    db.submitJob("ner-backfill", { slug: res.slug });

    class TimeoutNer extends NerEngine {
      async extract(_text: string, _timeoutMs?: number): Promise<never> { throw new NerTimeoutError(100); }
    }
    const pipeline = new ContentPipeline(db, embedding, createMockLanceDB() as never, {
      pages: new PageManager(db, testDir), nerEngine: new TimeoutNer({ name: "m", chat: async () => "x" } as any),
    });
    const counts = await runNerBackfillStage(db, pipeline, new PageManager(db, testDir));
    expect(counts.timed_out).toBe(1);
    expect(db.listJobs("pending")[0].status).toBe("pending");
    expect(db.getPage(res.slug)).not.toBeNull();
  });

  test("no usable body (sealed, no raw chunks) → job failed once with clear reason", async () => {
    db.submitJob("ner-backfill", { slug: "records/does-not-exist" });
    const llm: LLMProvider = { name: "mock", chat: async () => '{"entities":[],"relations":[],"events":[]}' };
    const counts = await runNerBackfillStage(db, pipelineWith(llm), new PageManager(db, testDir));
    expect(counts.failed).toBe(1);
  });
});
