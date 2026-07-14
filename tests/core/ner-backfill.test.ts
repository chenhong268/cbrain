import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite";
import { NER_BACKFILL_STALE_TTL_MS, NER_BACKFILL_JOB } from "../../src/core/ingestion/ner-backfill";
import { JobQueueNerSubmitter, resolveNerBody } from "../../src/core/ingestion/ner-backfill";
import { IngestManager } from "../../src/core/ingestion/ingest";
import { PageManager } from "../../src/core/page";
import type { EmbeddingProvider } from "../../src/embedding/provider";
import { runNerBackfillStage } from "../../src/core/ingestion/ner-backfill";
import { ContentPipeline } from "../../src/core/ingestion/pipeline";
import { NerEngine, NerTimeoutError } from "../../src/core/ingestion/ner";
import type { LLMProvider } from "../../src/llm/provider";
import { EntityFactsTimeoutError } from "../../src/core/ingestion/entity-facts";
import { submitDeferredNerForWritePath } from "../../src/core/ingestion/ner-write-path";
import {
  enqueueZeroLinkBackfill,
  listOrdinaryCommitUnknown,
  resolveOrdinaryCommitUnknown,
  summarizeRepairBatch,
} from "../../src/core/maintenance/zero-link-backfill";

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
  const addRecord = (slug: string, hash = "page-hash") => {
    db.upsertPage({ slug, type: "record", title: slug, filePath: `${slug}.md`, contentHash: hash });
    db.insertChunk(slug, 0, "first");
    db.insertChunk(slug, 1, "second");
  };

  test("first submit returns a structured result and creates a source-identified job", () => {
    addRecord("records/foo");
    const s = new JobQueueNerSubmitter(db);
    const result = s.submitDeferredNer({ slug: "records/foo", pageType: "record", contentHash: "caller-hash" });
    expect(result).toMatchObject({ disposition: "inserted", pending: true });
    const job = db.getJob(result.jobId!)!;
    expect(job.name).toBe("ner-backfill");
    expect(job.status).toBe("pending");
    expect(JSON.parse(job.data!)).toEqual({
      slug: "records/foo",
      pageContentHash: "page-hash",
      sourceFingerprint: "page:page-hash",
      pageType: "record",
      kind: "ner",
    });
  });
  test("second submit for same source returns existing_active", () => {
    addRecord("records/foo");
    const s = new JobQueueNerSubmitter(db);
    const first = s.submitDeferredNer({ slug: "records/foo" });
    expect(first.disposition).toBe("inserted");
    expect(s.submitDeferredNer({ slug: "records/foo" })).toEqual({
      disposition: "existing_active",
      jobId: first.jobId,
      pending: true,
    });
    expect(db.listJobs("pending").length).toBe(1);
  });
  test("different slug submits a second job", () => {
    addRecord("records/foo");
    addRecord("records/bar");
    const s = new JobQueueNerSubmitter(db);
    s.submitDeferredNer({ slug: "records/foo" });
    const second = s.submitDeferredNer({ slug: "records/bar" });
    expect(second.disposition).toBe("inserted");
    expect(db.listJobs("pending").length).toBe(2);
  });
  test("same slug can queue regular NER and entity facts without cross-kind suppression", () => {
    addRecord("brain/entities/company/a");
    const s = new JobQueueNerSubmitter(db);
    expect(s.submitDeferredNer({ slug: "brain/entities/company/a" }).disposition).toBe("inserted");
    expect(s.submitDeferredNer({ slug: "brain/entities/company/a", kind: "entity_facts" }).disposition).toBe("inserted");
    expect(s.submitDeferredNer({ slug: "brain/entities/company/a", kind: "entity_facts" }).disposition).toBe("existing_active");
    expect(db.listJobs("pending")).toHaveLength(2);
  });
  test("stale old-fingerprint running row is terminalized and gets one successor", () => {
    addRecord("records/foo", "first-hash");
    const s = new JobQueueNerSubmitter(db);
    const first = s.submitDeferredNer({ slug: "records/foo" });
    db.claimJobById(first.jobId!);
    db.rawDb.prepare("UPDATE jobs SET started_at = datetime('now','-2 hours') WHERE id = ?").run(first.jobId!);
    db.updatePageHash("records/foo", "second-hash");
    const next = s.submitDeferredNer({ slug: "records/foo" });
    expect(next).toMatchObject({ disposition: "successor_pending", pending: true });
    expect(db.getJob(first.jobId!)!.status).toBe("done");
    expect(JSON.parse(db.getJob(first.jobId!)!.result!).reason).toBe("SOURCE_CHANGED");
  });

  test("reuses one old-fingerprint pending row in place", () => {
    addRecord("records/foo", "first-hash");
    const s = new JobQueueNerSubmitter(db);
    const first = s.submitDeferredNer({ slug: "records/foo" });
    db.updatePageHash("records/foo", "second-hash");
    const next = s.submitDeferredNer({ slug: "records/foo" });
    expect(next).toEqual({ disposition: "superseded_pending", jobId: first.jobId, pending: true });
    expect(JSON.parse(db.getJob(first.jobId!)!.data!).sourceFingerprint).toBe("page:second-hash");
  });

  test("sealed raw chunk changes supersede despite stable page hash", () => {
    addRecord("records/foo", "stable-hash");
    db.insertChunkWithLevel("records/foo", 0, "summary", 1, "summary-hash");
    const s = new JobQueueNerSubmitter(db);
    const first = s.submitDeferredNer({ slug: "records/foo" });
    const firstFingerprint = JSON.parse(db.getJob(first.jobId!)!.data!).sourceFingerprint;
    db.rawDb.prepare("UPDATE chunks SET content='changed' WHERE page_slug=? AND summary_level=0 AND chunk_index=0").run("records/foo");
    const next = s.submitDeferredNer({ slug: "records/foo" });
    expect(next.disposition).toBe("superseded_pending");
    expect(JSON.parse(db.getJob(next.jobId!)!.data!).sourceFingerprint).not.toBe(firstFingerprint);
  });

  test("fresh old-fingerprint running row receives exactly one waiting successor", () => {
    addRecord("records/foo", "first-hash");
    const s = new JobQueueNerSubmitter(db);
    const first = s.submitDeferredNer({ slug: "records/foo" });
    db.claimJobById(first.jobId!);
    db.updatePageHash("records/foo", "second-hash");
    const next = s.submitDeferredNer({ slug: "records/foo" });
    expect(next.disposition).toBe("successor_pending");
    expect(s.submitDeferredNer({ slug: "records/foo" })).toEqual({
      disposition: "existing_active",
      jobId: next.jobId,
      pending: true,
    });
    expect(db.rawDb.prepare("SELECT COUNT(*) count FROM jobs").get()).toEqual({ count: 2 });
  });

  test("write-path pending boolean is truthful for a rejected submission", () => {
    expect(submitDeferredNerForWritePath(new JobQueueNerSubmitter(db), {
      slug: "records/missing",
      pageType: "record",
    })).toBe(false);
  });
});

describe("scoped NER attempt lease primitives (#342)", () => {
  test("only one conditional claim wins and ABA tokens cannot finish a later attempt", () => {
    const id = db.submitJob("ner-backfill", { slug: "records/item", kind: "ner", sourceFingerprint: "page:a" });
    const first = db.claimNerJobByIdWithLease(id);
    expect(first?.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.claimNerJobByIdWithLease(id)).toBeNull();
    expect(db.completeNerJobWithLease(id, "wrong-token", "claimed", { outcome: "skipped" })).toBe(false);
    expect(db.completeNerJobWithLease(id, first!.leaseToken, "claimed", { outcome: "skipped" })).toBe(true);
    expect(JSON.parse(db.getJob(id)!.data!)).not.toHaveProperty("attemptLease");
  });

  test("committing fence is conditional and a claimed token cannot complete afterward", () => {
    const id = db.submitJob("ner-backfill", { slug: "records/item", kind: "ner", sourceFingerprint: "page:a" });
    const claimed = db.claimNerJobByIdWithLease(id)!;
    expect(db.moveNerLeaseToCommitting(id, claimed.leaseToken)).toBe(true);
    expect(db.moveNerLeaseToCommitting(id, claimed.leaseToken)).toBe(false);
    expect(db.completeNerJobWithLease(id, claimed.leaseToken, "claimed", { outcome: "processed" })).toBe(false);
    expect(db.completeNerJobWithLease(id, claimed.leaseToken, "committing", { outcome: "processed" })).toBe(true);
  });

  test("entity facts never receive a scoped lease", () => {
    const id = db.submitJob("ner-backfill", { slug: "entity/a", kind: "entity_facts" });
    expect(db.claimNerJobByIdWithLease(id)).toBeNull();
    expect(JSON.parse(db.getJob(id)!.data!)).not.toHaveProperty("attemptLease");
  });
});

describe("ordinary commit-unknown audit resolution (#342)", () => {
  function seedUnknown(hash = "hash-a") {
    db.upsertPage({ slug: "records/item", type: "record", title: "记录A", filePath: "records/item.md", contentHash: hash });
    db.insertChunk("records/item", 0, "first");
    db.insertChunk("records/item", 1, "second");
    const id = db.submitJob("ner-backfill", {
      slug: "records/item",
      kind: "ner",
      pageContentHash: hash,
      sourceFingerprint: `page:${hash}`,
    });
    db.rawDb.prepare("UPDATE jobs SET status='done', result=?, finished_at=datetime('now') WHERE id=?")
      .run(JSON.stringify({ outcome: "commit_unknown", kind: "ner" }), id);
    return id;
  }

  test("list returns only scalar count and ordinary ids", () => {
    const id = seedUnknown();
    expect(listOrdinaryCommitUnknown(db)).toEqual({ count: 1, jobIds: [id], integrityConflicts: 0 });
    expect(JSON.stringify(listOrdinaryCommitUnknown(db))).not.toContain("records/item");
  });

  test("accept enters processed ledger and clears audit debt", () => {
    const id = seedUnknown();
    expect(resolveOrdinaryCommitUnknown(db, id, "accept")).toEqual({ jobId: id, decision: "accept", success: true, successorCount: 0 });
    expect(listOrdinaryCommitUnknown(db).count).toBe(0);
    expect(JSON.parse(db.getJob(id)!.result!).outcome).toBe("processed");
  });

  test("retry requires the same current source and resets the predecessor", () => {
    const id = seedUnknown();
    expect(resolveOrdinaryCommitUnknown(db, id, "retry").success).toBe(true);
    expect(db.getJob(id)).toMatchObject({ status: "pending", result: null, attempts: 0 });
  });

  test("release-successor requires exactly one different current pending row", () => {
    const id = seedUnknown();
    db.updatePageHash("records/item", "hash-b");
    const successor = db.submitJob("ner-backfill", {
      slug: "records/item", kind: "ner", pageContentHash: "hash-b", sourceFingerprint: "page:hash-b",
    });
    expect(resolveOrdinaryCommitUnknown(db, id, "release-successor")).toEqual({
      jobId: id, decision: "release-successor", success: true, successorCount: 1,
    });
    expect(db.getJob(successor)!.status).toBe("pending");
    expect(listOrdinaryCommitUnknown(db).count).toBe(0);
  });

  test("marked debt has batch rollback precedence and zero mutation", async () => {
    db.upsertPage({ slug: "records/item", type: "record", title: "记录A", filePath: "records/item.md", contentHash: "hash-a" });
    db.insertChunk("records/item", 0, "first");
    db.insertChunk("records/item", 1, "second");
    const receipt = enqueueZeroLinkBackfill(db, 1);
    const child = db.rawDb.prepare("SELECT id FROM jobs WHERE name='ner-backfill'").get() as { id: number };
    const raw = db.getJob(child.id)!;
    const result = { outcome: "commit_unknown", kind: "ner", repair: JSON.parse(raw.data!).repair };
    db.rawDb.prepare("UPDATE jobs SET status='done', result=? WHERE id=?").run(JSON.stringify(result), child.id);
    const before = JSON.stringify(db.getJob(child.id));
    expect(() => resolveOrdinaryCommitUnknown(db, child.id, "accept")).toThrow("BATCH_ROLLBACK_REQUIRED");
    expect(JSON.stringify(db.getJob(child.id))).toBe(before);
    expect(receipt.batchId).toBeTruthy();
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

  test("missing source is terminal skipped with a fixed private-safe reason", async () => {
    const id = db.submitJob("ner-backfill", { slug: "records/does-not-exist" });
    const llm: LLMProvider = { name: "mock", chat: async () => '{"entities":[],"relations":[],"events":[]}' };
    const counts = await runNerBackfillStage(db, pipelineWith(llm), new PageManager(db, testDir));
    expect(counts.skipped).toBe(1);
    const job = db.getJob(id)!;
    expect(job.status).toBe("done");
    expect(JSON.parse(job.result ?? "{}")).toEqual({ outcome: "skipped", reason: "SOURCE_UNAVAILABLE" });
    expect(job.error).toBeNull();
  });

  test("malformed live job fails global preflight with byte-for-byte zero mutation", async () => {
    const id = db.submitJob("ner-backfill", { pageType: "record" });
    const llm: LLMProvider = { name: "mock", chat: async () => '{"entities":[],"relations":[],"events":[]}' };
    const before = JSON.stringify(db.getJob(id));
    await expect(runNerBackfillStage(db, pipelineWith(llm), new PageManager(db, testDir))).rejects.toThrow("QUEUE_INTEGRITY_CONFLICT");
    expect(JSON.stringify(db.getJob(id))).toBe(before);
  });

  test("entity_facts job applies only whitelisted empty fields", async () => {
    const seed = new IngestManager(
      db, createMockEmbeddingProvider(), createMockLanceDB() as never, testDir,
      undefined, undefined, { nerMode: "off" },
    );
    const page = await seed.ingest({
      type: "markdown",
      content: "---\ntitle: 实体A\ntype: entity/company\n---\n实体A属于领域C。",
    });
    const pages = new PageManager(db, testDir);
    pages.update(page.slug, { extra: { location: "已有地区" } });
    const id = db.submitJob("ner-backfill", { slug: page.slug, pageType: "entity/company", kind: "entity_facts" });
    const llm: LLMProvider = {
      name: "mock",
      chat: async () => JSON.stringify({ facts: [
        { field: "industry", value: "领域C", confidence: 0.9, evidence: "明确证据" },
        { field: "location", value: "新地区", confidence: 0.9, evidence: "明确证据" },
        { field: "unsafe", value: "忽略", confidence: 1, evidence: "明确证据" },
      ] }),
    };

    const counts = await runNerBackfillStage(db, pipelineWith(llm), pages, { entityFactsLlm: llm });
    expect(counts.processed).toBe(1);
    expect(db.getJob(id)!.status).toBe("done");
    const updated = pages.getBySlug(page.slug)!;
    expect(updated.frontmatter.industry).toBe("领域C");
    expect(updated.frontmatter.location).toBe("已有地区");
    expect(updated.frontmatter.unsafe).toBeUndefined();
  });

  test("entity_facts provider failure stays retryable with a fixed reason code", async () => {
    const seed = new IngestManager(
      db, createMockEmbeddingProvider(), createMockLanceDB() as never, testDir,
      undefined, undefined, { nerMode: "off" },
    );
    const page = await seed.ingest({ type: "markdown", content: "---\ntitle: 实体A\ntype: entity/company\n---\n匿名正文。" });
    const id = db.submitJob("ner-backfill", { slug: page.slug, kind: "entity_facts" });
    const llm: LLMProvider = { name: "mock", chat: async () => { throw new Error("private provider detail"); } };

    const counts = await runNerBackfillStage(db, pipelineWith(llm), new PageManager(db, testDir), { entityFactsLlm: llm });
    expect(counts.failed).toBe(1);
    const job = db.getJob(id)!;
    expect(job.status).toBe("pending");
    expect(job.error).toBe("ENTITY_FACTS_PROVIDER_ERROR");
  });

  test("entity_facts timeout stays retryable and is counted separately", async () => {
    const seed = new IngestManager(
      db, createMockEmbeddingProvider(), createMockLanceDB() as never, testDir,
      undefined, undefined, { nerMode: "off" },
    );
    const page = await seed.ingest({ type: "markdown", content: "---\ntitle: 实体A\ntype: entity/company\n---\n匿名正文。" });
    const id = db.submitJob("ner-backfill", { slug: page.slug, kind: "entity_facts" });
    const llm: LLMProvider = { name: "mock", chat: async () => { throw new EntityFactsTimeoutError(10); } };

    const counts = await runNerBackfillStage(db, pipelineWith(llm), new PageManager(db, testDir), { entityFactsLlm: llm });
    expect(counts.timed_out).toBe(1);
    expect(db.getJob(id)!.status).toBe("pending");
    expect(db.getJob(id)!.error).toBe("ENTITY_FACTS_TIMEOUT");
  });

  test("UUID-filtered repair consumes only its manifest and finalizes without extra LLM work", async () => {
    const ingest = new IngestManager(db, createMockEmbeddingProvider(), createMockLanceDB() as never, testDir);
    const page = await ingest.ingest({ content: "匿名修复页正文", type: "text", title: "修复页", skipNer: true });
    db.insertChunk(page.slug, 99, "第二片段");
    const unrelated = db.submitJob("ner-backfill", { slug: "records/unrelated" });
    const receipt = enqueueZeroLinkBackfill(db, 1);
    let calls = 0;
    const guardedPipeline = {
      processNer: async (...args: unknown[]) => {
        calls++;
        const guard = args[6] as ((phase: "after_extract" | "before_commit") => void);
        guard("after_extract");
        guard("before_commit");
        return { entities: 0 };
      },
    } as unknown as ContentPipeline;
    const counts = await runNerBackfillStage(db, guardedPipeline, new PageManager(db, testDir), {
      maxItems: 1,
      batchId: receipt.batchId,
    });
    expect(counts.processed).toBe(1);
    expect(calls).toBe(1);
    expect(db.getJob(unrelated)!.status).toBe("pending");
    expect(summarizeRepairBatch(db, receipt.batchId!)).toMatchObject({
      finalized: true,
      selected: 1,
      done: 1,
      outcomes: { terminalNoGraphLinks: 1, commitUnknown: 0 },
    });

    const second = await runNerBackfillStage(db, guardedPipeline, new PageManager(db, testDir), {
      maxItems: 1,
      batchId: receipt.batchId,
    });
    expect(second).toEqual({ processed: 0, failed: 0, timed_out: 0, skipped: 0 });
    expect(calls).toBe(1);
  });

  test("source drift before LLM is terminal source_changed with zero pipeline calls", async () => {
    const ingest = new IngestManager(db, createMockEmbeddingProvider(), createMockLanceDB() as never, testDir);
    const page = await ingest.ingest({ content: "匿名漂移页正文", type: "text", title: "漂移页", skipNer: true });
    db.insertChunk(page.slug, 99, "第二片段");
    const receipt = enqueueZeroLinkBackfill(db, 1);
    const row = db.getPage(page.slug)!;
    writeFileSync(join(testDir, row.file_path), "changed bytes", "utf8");
    let calls = 0;
    const pipeline = { processNer: async () => { calls++; return null; } } as unknown as ContentPipeline;
    const counts = await runNerBackfillStage(db, pipeline, new PageManager(db, testDir), {
      maxItems: 1,
      batchId: receipt.batchId,
    });
    expect(calls).toBe(0);
    expect(counts.skipped).toBe(1);
    expect(summarizeRepairBatch(db, receipt.batchId!)).toMatchObject({ finalized: true, outcomes: { sourceChanged: 1 } });
  });

  test("post-fence exception becomes commit_unknown and keeps manifest unfinalized", async () => {
    const ingest = new IngestManager(db, createMockEmbeddingProvider(), createMockLanceDB() as never, testDir);
    const page = await ingest.ingest({ content: "匿名未知提交页", type: "text", title: "未知提交页", skipNer: true });
    db.insertChunk(page.slug, 99, "第二片段");
    const receipt = enqueueZeroLinkBackfill(db, 1);
    const pipeline = {
      processNer: async (...args: unknown[]) => {
        const guard = args[6] as ((phase: "after_extract" | "before_commit") => void);
        guard("after_extract");
        guard("before_commit");
        throw new Error("synthetic post-fence failure");
      },
    } as unknown as ContentPipeline;
    const counts = await runNerBackfillStage(db, pipeline, new PageManager(db, testDir), {
      maxItems: 1,
      batchId: receipt.batchId,
    });
    expect(counts.failed).toBe(1);
    expect(summarizeRepairBatch(db, receipt.batchId!)).toMatchObject({
      finalized: false,
      done: 1,
      outcomes: { commitUnknown: 1 },
    });
  });

  test("filtered consumer rejects a limit that differs from manifest selection", async () => {
    const ingest = new IngestManager(db, createMockEmbeddingProvider(), createMockLanceDB() as never, testDir);
    const page = await ingest.ingest({ content: "匿名批次限制页", type: "text", title: "限制页", skipNer: true });
    db.insertChunk(page.slug, 99, "第二片段");
    const receipt = enqueueZeroLinkBackfill(db, 1);
    await expect(runNerBackfillStage(db, {} as ContentPipeline, new PageManager(db, testDir), {
      maxItems: 2,
      batchId: receipt.batchId,
    })).rejects.toThrow("BATCH_LIMIT_MISMATCH");
  });
});
