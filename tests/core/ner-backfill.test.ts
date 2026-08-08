import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildNerAttemptIdentity, CBrainDB } from "../../src/storage/sqlite";
import { NER_BACKFILL_STALE_TTL_MS, NER_BACKFILL_JOB } from "../../src/core/ingestion/ner-backfill";
import { JobQueueNerSubmitter, resolveNerBody } from "../../src/core/ingestion/ner-backfill";
import { IngestManager } from "../../src/core/ingestion/ingest";
import { PageManager } from "../../src/core/page";
import type { EmbeddingProvider } from "../../src/embedding/provider";
import { runNerBackfillStage } from "../../src/core/ingestion/ner-backfill";
import { ContentPipeline } from "../../src/core/ingestion/pipeline";
import { NerEngine, NerTimeoutError } from "../../src/core/ingestion/ner";
import type { LLMProvider } from "../../src/llm/provider";
import { DeterministicEmbeddingProvider } from "../../src/embedding/deterministic";
import { LanceDBManager } from "../../src/storage/lancedb";
import { canonicalSlug } from "../../src/utils/slug";
import { EntityFactsTimeoutError } from "../../src/core/ingestion/entity-facts";
import { submitDeferredNerForWritePath } from "../../src/core/ingestion/ner-write-path";
import {
  deriveZeroLinkSource,
  enqueueZeroLinkBackfill,
  finalizeRepairBatch,
  getRepairBatchAttemptIdentity,
  listOrdinaryCommitUnknown,
  planZeroLinkBackfill,
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
    db.claimNerJobByIdWithLease(first.jobId!);
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
    db.claimNerJobByIdWithLease(first.jobId!);
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

  test("raw-derived running/successor pair permits a null page content hash", () => {
    addRecord("records/foo");
    db.rawDb.prepare("UPDATE pages SET content_hash=NULL WHERE slug='records/foo'").run();
    const submitter = new JobQueueNerSubmitter(db);
    const first = submitter.submitDeferredNer({ slug: "records/foo" });
    db.claimNerJobByIdWithLease(first.jobId!);
    db.rawDb.prepare("UPDATE chunks SET content='changed' WHERE page_slug='records/foo' AND chunk_index=0").run();

    expect(submitter.submitDeferredNer({ slug: "records/foo" }).disposition).toBe("successor_pending");
    expect(planZeroLinkBackfill(db)).toMatchObject({ status: "ok", stateConflicts: 0, active: 1 });
  });

  test("write-path pending boolean is truthful for a rejected submission", () => {
    expect(submitDeferredNerForWritePath(new JobQueueNerSubmitter(db), {
      slug: "records/missing",
      pageType: "record",
    })).toBe(false);
  });

  test("ordinary submit never strips an active repair batch marker", () => {
    addRecord("records/foo");
    const receipt = enqueueZeroLinkBackfill(db, 1);
    const child = db.rawDb.prepare("SELECT id FROM jobs WHERE name='ner-backfill'").get() as { id: number };
    const before = db.getJob(child.id)!;

    const result = new JobQueueNerSubmitter(db).submitDeferredNer({ slug: "records/foo" });

    expect(result).toEqual({ disposition: "existing_active", jobId: child.id, pending: true });
    expect(db.getJob(child.id)).toEqual(before);
    expect(JSON.parse(db.getJob(child.id)!.data!).repair.batchId).toBe(receipt.batchId);
    expect(db.rawDb.prepare("SELECT COUNT(*) count FROM jobs WHERE name='ner-backfill'").get()).toEqual({ count: 1 });
  });

  test("ordinary submit cannot replace a running repair child", () => {
    addRecord("records/foo");
    const receipt = enqueueZeroLinkBackfill(db, 1);
    const child = db.rawDb.prepare("SELECT id FROM jobs WHERE name='ner-backfill'").get() as { id: number };
    getRepairBatchAttemptIdentity(db, receipt.batchId!, child.id);
    const identity = buildNerAttemptIdentity(JSON.parse(db.getJob(child.id)!.data!))!;
    db.claimNerJobByIdWithLease(child.id, identity);
    const before = db.getJob(child.id)!;

    expect(new JobQueueNerSubmitter(db).submitDeferredNer({ slug: "records/foo" })).toEqual({
      disposition: "existing_active",
      jobId: child.id,
      pending: true,
    });
    expect(db.getJob(child.id)).toEqual(before);
  });

  test("finalized repair dedupes the same fingerprint but permits a changed source epoch", () => {
    addRecord("records/foo", "first-hash");
    const receipt = enqueueZeroLinkBackfill(db, 1);
    const child = db.rawDb.prepare("SELECT id, data FROM jobs WHERE name='ner-backfill'").get() as { id: number; data: string };
    const repair = JSON.parse(child.data).repair;
    db.rawDb.prepare("UPDATE jobs SET status='done', result=?, finished_at=datetime('now') WHERE id=?")
      .run(JSON.stringify({ outcome: "processed", kind: "ner", repair, graphOutcome: "terminal_no_graph_links", activeLinkCount: 0 }), child.id);
    finalizeRepairBatch(db, receipt.batchId!);
    const submitter = new JobQueueNerSubmitter(db);

    expect(submitter.submitDeferredNer({ slug: "records/foo" }).disposition).toBe("already_processed");
    db.updatePageHash("records/foo", "second-hash");
    expect(submitter.submitDeferredNer({ slug: "records/foo" }).disposition).toBe("inserted");
  });
});

describe("scoped NER attempt lease primitives (#342)", () => {
  const addRecord = (slug: string, hash: string) => {
    db.upsertPage({ slug, type: "record", title: slug, filePath: `${slug}.md`, contentHash: hash });
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO chunks (page_slug,chunk_index,content,summary_level) VALUES (?,0,'first',0)",
    ).run(slug);
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO chunks (page_slug,chunk_index,content,summary_level) VALUES (?,1,'second',0)",
    ).run(slug);
  };

  const addUnfinalizedManifest = (jobId: number, data: Record<string, any>) => {
    const repair = data.repair as Record<string, unknown>;
    db.rawDb.prepare(
      `INSERT INTO jobs (name,status,priority,data,result,attempts,max_attempts,finished_at)
       VALUES ('zero-link-backfill-batch', 'done', 0, ?, ?, 0, 1, datetime('now'))`,
    ).run(
      JSON.stringify({
        version: 1,
        repairName: "zero-link-rich-records",
        batchId: repair.batchId,
        ownership: [{ jobId, slug: data.slug, contentFingerprint: repair.contentFingerprint }],
      }),
      JSON.stringify({ finalized: false }),
    );
  };

  test("only one conditional claim wins and ABA tokens cannot finish a later attempt", () => {
    addRecord("records/item", "a");
    const id = db.submitJob("ner-backfill", { slug: "records/item", kind: "ner", pageContentHash: "a", sourceFingerprint: "page:a" });
    const first = db.claimNerJobByIdWithLease(id);
    expect(first?.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.claimNerJobByIdWithLease(id)).toBeNull();
    expect(db.completeNerJobWithLease(id, "wrong-token", "claimed", first!.payloadDigest, { outcome: "skipped" })).toBe(false);
    expect(db.completeNerJobWithLease(id, first!.leaseToken, "claimed", first!.payloadDigest, { outcome: "skipped" })).toBe(true);
    expect(JSON.parse(db.getJob(id)!.data!)).not.toHaveProperty("attemptLease");
  });

  test("committing fence is conditional and a claimed token cannot complete afterward", () => {
    addRecord("records/item", "a");
    const id = db.submitJob("ner-backfill", { slug: "records/item", kind: "ner", pageContentHash: "a", sourceFingerprint: "page:a" });
    const claimed = db.claimNerJobByIdWithLease(id)!;
    expect(db.moveNerLeaseToCommitting(id, claimed.leaseToken, claimed.payloadDigest)).toBe(true);
    expect(db.moveNerLeaseToCommitting(id, claimed.leaseToken, claimed.payloadDigest)).toBe(false);
    expect(db.completeNerJobWithLease(id, claimed.leaseToken, "claimed", claimed.payloadDigest, { outcome: "processed" })).toBe(false);
    expect(db.completeNerJobWithLease(id, claimed.leaseToken, "committing", claimed.payloadDigest, { outcome: "processed" })).toBe(true);
  });

  test("entity facts never receive a scoped lease", () => {
    const id = db.submitJob("ner-backfill", { slug: "entity/a", kind: "entity_facts" });
    expect(db.claimNerJobByIdWithLease(id)).toBeNull();
    expect(JSON.parse(db.getJob(id)!.data!)).not.toHaveProperty("attemptLease");
  });

  test("lease authority is revoked when any scheduled identity field changes in place", () => {
    addRecord("records/item", "a");
    for (const mutate of [
      (data: Record<string, unknown>) => { data.sourceFingerprint = "page:b"; },
      (data: Record<string, unknown>) => { data.slug = "records/other"; },
      (data: Record<string, unknown>) => { data.kind = "entity_facts"; },
      (data: Record<string, unknown>) => { data.repair = { name: "zero-link-rich-records", version: 1, contentFingerprint: "page:a", sourceKind: "vault_hash", batchId: "11111111-1111-4111-8111-111111111111" }; },
    ]) {
      const id = db.submitJob("ner-backfill", { slug: "records/item", kind: "ner", pageContentHash: "a", sourceFingerprint: "page:a" });
      const claimed = db.claimNerJobByIdWithLease(id)!;
      const mutated = JSON.parse(db.getJob(id)!.data!);
      mutate(mutated);
      db.rawDb.prepare("UPDATE jobs SET data=? WHERE id=?").run(JSON.stringify(mutated), id);

      expect(db.validateNerJobLease(id, claimed.leaseToken, "claimed", claimed.payloadDigest)).toBe(false);
      expect(db.moveNerLeaseToCommitting(id, claimed.leaseToken, claimed.payloadDigest)).toBe(false);
      expect(db.completeNerJobWithLease(id, claimed.leaseToken, "claimed", claimed.payloadDigest, { outcome: "processed" })).toBe(false);
      expect(db.getJob(id)!.status).toBe("running");
      db.rawDb.prepare("DELETE FROM jobs").run();
    }
  });

  test("lease authority binds the complete ordinary and repair payload", () => {
    const ordinaryMutations = [
      (data: Record<string, any>) => { data.pageContentHash = "hash-b"; },
      (data: Record<string, any>) => { data.extra = "injected"; },
    ];
    const repairMutations = [
      (data: Record<string, any>) => { data.repair.name = "other"; },
      (data: Record<string, any>) => { data.repair.version = 2; },
      (data: Record<string, any>) => { data.repair.sourceKind = "raw_chunks"; },
      (data: Record<string, any>) => { data.repair.extra = "injected"; },
    ];
    const payloads: Array<{ data: Record<string, unknown>; mutate: (data: Record<string, any>) => void }> = [
      ...ordinaryMutations.map((mutate) => ({
        data: { slug: "records/item", kind: "ner", pageContentHash: "hash-a", sourceFingerprint: "page:hash-a" },
        mutate,
      })),
      ...repairMutations.map((mutate) => ({
        data: {
          slug: "records/item",
          kind: "ner",
          contentHash: "hash-a",
          repair: {
            name: "zero-link-rich-records",
            version: 1,
            contentFingerprint: "page:hash-a",
            sourceKind: "vault_hash",
            batchId: "11111111-1111-4111-8111-111111111111",
          },
        },
        mutate,
      })),
    ];

    for (const { data, mutate } of payloads) {
      addRecord("records/item", "hash-a");
      const id = db.submitJob("ner-backfill", data);
      if (data.repair) addUnfinalizedManifest(id, data);
      const claimed = db.claimNerJobByIdWithLease(id)!;
      const changed = JSON.parse(db.getJob(id)!.data!);
      mutate(changed);
      db.rawDb.prepare("UPDATE jobs SET data=? WHERE id=?").run(JSON.stringify(changed), id);
      expect(db.validateNerJobLease(id, claimed.leaseToken, "claimed", claimed.payloadDigest)).toBe(false);
      expect(db.moveNerLeaseToCommitting(id, claimed.leaseToken, claimed.payloadDigest)).toBe(false);
      expect(db.completeNerJobWithLease(id, claimed.leaseToken, "claimed", claimed.payloadDigest, { outcome: "processed" })).toBe(false);
      expect(db.failNerJobWithLease(id, claimed.leaseToken, claimed.payloadDigest, "FIXED_ERROR")).toBe(false);
      db.rawDb.prepare("DELETE FROM jobs").run();
    }
  });

  test("a forged in-row digest cannot replace the worker's frozen claim digest", () => {
    addRecord("records/item", "hash-a");
    const id = db.submitJob("ner-backfill", {
      slug: "records/item",
      kind: "ner",
      pageContentHash: "hash-a",
      sourceFingerprint: "page:hash-a",
    });
    const claimed = db.claimNerJobByIdWithLease(id)!;
    const changed = JSON.parse(db.getJob(id)!.data!);
    changed.pageContentHash = "hash-b";
    const { attemptLease, ...payload } = changed;
    attemptLease.payloadDigest = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
    db.rawDb.prepare("UPDATE jobs SET data=? WHERE id=?").run(JSON.stringify({ ...payload, attemptLease }), id);

    expect(db.validateNerJobLease(id, claimed.leaseToken, "claimed", claimed.payloadDigest)).toBe(false);
    expect(db.moveNerLeaseToCommitting(id, claimed.leaseToken, claimed.payloadDigest)).toBe(false);
    expect(db.completeNerJobWithLease(id, claimed.leaseToken, "claimed", claimed.payloadDigest, { outcome: "processed" })).toBe(false);
    expect(db.failNerJobWithLease(id, claimed.leaseToken, claimed.payloadDigest, "FIXED_ERROR")).toBe(false);
    expect(db.getJob(id)!.status).toBe("running");
  });

  test("each incomplete commit-unknown independently freezes unrelated direct claims", () => {
    for (const malformed of [
      { slug: "records/bad", kind: "ner" },
      { slug: "records/bad", kind: "ner", sourceFingerprint: "page:a" },
    ]) {
      const unknown = db.submitJob("ner-backfill", malformed);
      db.rawDb.prepare("UPDATE jobs SET status='done', result=?, finished_at=datetime('now') WHERE id=?")
        .run(JSON.stringify({ outcome: "commit_unknown", kind: "ner" }), unknown);
      const pending = db.submitJob("ner-backfill", {
        slug: "records/good", kind: "ner", pageContentHash: "b", sourceFingerprint: "page:b",
      });
      const frozen = buildNerAttemptIdentity(JSON.parse(db.getJob(pending)!.data!))!;
      const before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());

      expect(db.claimNerJobByIdWithLease(pending, frozen)).toBeNull();
      expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
      db.rawDb.prepare("DELETE FROM jobs").run();
    }
  });

  test("orphan repair commit-unknown validates its schema and freezes direct claims", () => {
    const repair = {
      name: "zero-link-rich-records",
      version: 1,
      contentFingerprint: "page:a",
      sourceKind: "vault_hash",
      batchId: "11111111-1111-4111-8111-111111111111",
    };
    const insertUnknown = (result: Record<string, unknown>) => {
      const id = db.submitJob("ner-backfill", { slug: "records/repair", kind: "ner", contentHash: "a", repair });
      db.rawDb.prepare("UPDATE jobs SET status='done', result=?, finished_at=datetime('now') WHERE id=?")
        .run(JSON.stringify(result), id);
    };
    const claim = (slug: string) => {
      addRecord(slug, "b");
      const id = db.submitJob("ner-backfill", { slug, kind: "ner", pageContentHash: "b", sourceFingerprint: "page:b" });
      return db.claimNerJobByIdWithLease(id, buildNerAttemptIdentity(JSON.parse(db.getJob(id)!.data!))!);
    };

    insertUnknown({ outcome: "commit_unknown", kind: "ner", repair });
    expect(claim("records/unrelated")).toBeNull();
    db.rawDb.prepare("DELETE FROM jobs").run();

    insertUnknown({ outcome: "commit_unknown", kind: "ner", repair });
    const sameId = db.submitJob("ner-backfill", {
      slug: "records/repair", kind: "ner", pageContentHash: "b", sourceFingerprint: "page:b",
    });
    const sameBefore = JSON.stringify(db.getJob(sameId));
    expect(db.claimNerJobByIdWithLease(sameId, buildNerAttemptIdentity(JSON.parse(db.getJob(sameId)!.data!))!)).toBeNull();
    expect(JSON.stringify(db.getJob(sameId))).toBe(sameBefore);
    db.rawDb.prepare("DELETE FROM jobs").run();

    for (const result of [
      { outcome: "commit_unknown", kind: "ner" },
      { outcome: "commit_unknown", kind: "ner", repair: { ...repair, batchId: "22222222-2222-4222-8222-222222222222" } },
      { outcome: "commit_unknown", kind: "ner", repair, extra: true },
    ]) {
      insertUnknown(result);
      expect(claim("records/unrelated")).toBeNull();
      db.rawDb.prepare("DELETE FROM jobs").run();
    }

    const ordinary = db.submitJob("ner-backfill", {
      slug: "records/ordinary", kind: "ner", pageContentHash: "a", sourceFingerprint: "page:a",
    });
    db.rawDb.prepare("UPDATE jobs SET status='done', result=?, finished_at=datetime('now') WHERE id=?")
      .run(JSON.stringify({ outcome: "commit_unknown", kind: "ner" }), ordinary);
    expect(claim("records/unrelated")).not.toBeNull();
  });
});

describe("ordinary commit-unknown audit resolution (#342)", () => {
  function seedUnknown(hash = "hash-a", slug = "records/item") {
    db.upsertPage({ slug, type: "record", title: slug, filePath: `${slug}.md`, contentHash: hash });
    db.insertChunk(slug, 0, "first");
    db.insertChunk(slug, 1, "second");
    const id = db.submitJob("ner-backfill", {
      slug,
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

  test("invalid commit-unknown fingerprints never enter the auditable set", () => {
    const id = seedUnknown();
    const data = JSON.parse(db.getJob(id)!.data!);
    data.sourceFingerprint = "invalid";
    db.rawDb.prepare("UPDATE jobs SET data=? WHERE id=?").run(JSON.stringify(data), id);

    expect(listOrdinaryCommitUnknown(db)).toEqual({ count: 0, jobIds: [], integrityConflicts: 1 });
    expect(() => resolveOrdinaryCommitUnknown(db, id, "accept")).toThrow("COMMIT_UNKNOWN_INTEGRITY_CONFLICT");
  });

  test("release-successor rejects an incomplete current identity without mutation", () => {
    const id = seedUnknown();
    db.updatePageHash("records/item", "hash-b");
    const successor = db.submitJob("ner-backfill", {
      slug: "records/item", kind: "ner", pageContentHash: "wrong-hash", sourceFingerprint: "page:hash-b",
    });
    const before = JSON.stringify(db.listJobs());

    expect(() => resolveOrdinaryCommitUnknown(db, id, "release-successor")).toThrow("COMMIT_UNKNOWN_INTEGRITY_CONFLICT");
    expect(JSON.stringify(db.listJobs())).toBe(before);
    expect(db.claimNerJobByIdWithLease(successor)).toBeNull();
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

  test("all commit-unknown decisions fail closed on an unrelated global state conflict", () => {
    const ids = [
      seedUnknown("hash-a", "records/unknown-a"),
      seedUnknown("hash-b", "records/unknown-b"),
      seedUnknown("hash-c", "records/unknown-c"),
    ];
    db.upsertPage({ slug: "records/conflict", type: "record", title: "记录D", filePath: "records/conflict.md", contentHash: "hash-d" });
    db.insertChunk("records/conflict", 0, "first");
    db.insertChunk("records/conflict", 1, "second");
    for (let i = 0; i < 2; i++) {
      db.submitJob("ner-backfill", {
        slug: "records/conflict", kind: "ner", pageContentHash: "hash-d", sourceFingerprint: "page:hash-d",
      });
    }
    const before = JSON.stringify(db.listJobs());

    for (const [index, decision] of (["accept", "retry", "release-successor"] as const).entries()) {
      expect(() => resolveOrdinaryCommitUnknown(db, ids[index], decision)).toThrow("COMMIT_UNKNOWN_INTEGRITY_CONFLICT");
    }
    expect(JSON.stringify(db.listJobs())).toBe(before);
  });

  test("raw-derived nullable commit-unknown supports accept, retry, and successor release", () => {
    const seed = (slug: string) => {
      db.upsertPage({ slug, type: "record", title: slug, filePath: `${slug}.md` });
      db.rawDb.prepare("UPDATE pages SET content_hash=NULL WHERE slug=?").run(slug);
      db.insertChunk(slug, 0, "first");
      const fingerprint = deriveZeroLinkSource(db, slug).contentFingerprint!;
      const id = db.submitJob("ner-backfill", {
        slug, kind: "ner", pageContentHash: null, sourceFingerprint: fingerprint,
      });
      db.rawDb.prepare("UPDATE jobs SET status='done', result=?, finished_at=datetime('now') WHERE id=?")
        .run(JSON.stringify({ outcome: "commit_unknown", kind: "ner" }), id);
      return { id, fingerprint };
    };
    const accepted = seed("records/raw-accept");
    const retried = seed("records/raw-retry");
    const released = seed("records/raw-release");
    db.insertChunk("records/raw-release", 1, "second");
    const successorFingerprint = deriveZeroLinkSource(db, "records/raw-release").contentFingerprint!;
    const successor = db.submitJob("ner-backfill", {
      slug: "records/raw-release", kind: "ner", pageContentHash: null, sourceFingerprint: successorFingerprint,
    });

    expect(listOrdinaryCommitUnknown(db).jobIds).toEqual([accepted.id, retried.id, released.id]);
    expect(resolveOrdinaryCommitUnknown(db, accepted.id, "accept").success).toBe(true);
    expect(resolveOrdinaryCommitUnknown(db, retried.id, "retry").success).toBe(true);
    expect(resolveOrdinaryCommitUnknown(db, released.id, "release-successor")).toMatchObject({ success: true, successorCount: 1 });
    expect(db.getJob(successor)!.status).toBe("pending");
  });

  test("source deletion keeps frozen commit-unknown acceptable but not retryable or releasable", () => {
    const pageUnknown = seedUnknown("hash-page", "records/deleted-page-accept");
    const pageRetry = seedUnknown("hash-retry", "records/deleted-page-retry");

    db.upsertPage({ slug: "records/deleted-raw-accept", type: "record", title: "Raw Accept", filePath: "records/deleted-raw-accept.md" });
    db.rawDb.prepare("UPDATE pages SET content_hash=NULL WHERE slug='records/deleted-raw-accept'").run();
    db.insertChunk("records/deleted-raw-accept", 0, "raw");
    const rawFingerprint = deriveZeroLinkSource(db, "records/deleted-raw-accept").contentFingerprint!;
    const rawUnknown = db.submitJob("ner-backfill", {
      slug: "records/deleted-raw-accept", kind: "ner", pageContentHash: null, sourceFingerprint: rawFingerprint,
    });
    db.rawDb.prepare("UPDATE jobs SET status='done', result=?, finished_at=datetime('now') WHERE id=?")
      .run(JSON.stringify({ outcome: "commit_unknown", kind: "ner" }), rawUnknown);

    db.upsertPage({ slug: "records/deleted-raw-release", type: "record", title: "Raw Release", filePath: "records/deleted-raw-release.md" });
    db.rawDb.prepare("UPDATE pages SET content_hash=NULL WHERE slug='records/deleted-raw-release'").run();
    db.insertChunk("records/deleted-raw-release", 0, "raw");
    const releaseFingerprint = deriveZeroLinkSource(db, "records/deleted-raw-release").contentFingerprint!;
    const rawRelease = db.submitJob("ner-backfill", {
      slug: "records/deleted-raw-release", kind: "ner", pageContentHash: null, sourceFingerprint: releaseFingerprint,
    });
    db.rawDb.prepare("UPDATE jobs SET status='done', result=?, finished_at=datetime('now') WHERE id=?")
      .run(JSON.stringify({ outcome: "commit_unknown", kind: "ner" }), rawRelease);

    for (const slug of ["records/deleted-page-accept", "records/deleted-page-retry", "records/deleted-raw-accept", "records/deleted-raw-release"]) {
      db.rawDb.prepare("DELETE FROM chunks WHERE page_slug=?").run(slug);
      db.rawDb.prepare("DELETE FROM pages WHERE slug=?").run(slug);
    }
    expect(listOrdinaryCommitUnknown(db)).toMatchObject({ count: 4, integrityConflicts: 0 });
    expect(resolveOrdinaryCommitUnknown(db, pageUnknown, "accept").success).toBe(true);
    expect(resolveOrdinaryCommitUnknown(db, rawUnknown, "accept").success).toBe(true);

    const retryBefore = JSON.stringify(db.getJob(pageRetry));
    const releaseBefore = JSON.stringify(db.getJob(rawRelease));
    expect(() => resolveOrdinaryCommitUnknown(db, pageRetry, "retry")).toThrow("COMMIT_UNKNOWN_STATE_MISMATCH");
    expect(() => resolveOrdinaryCommitUnknown(db, rawRelease, "release-successor")).toThrow("COMMIT_UNKNOWN_STATE_MISMATCH");
    expect(JSON.stringify(db.getJob(pageRetry))).toBe(retryBefore);
    expect(JSON.stringify(db.getJob(rawRelease))).toBe(releaseBefore);
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
  test("empty batch id never falls back to the unfiltered snapshot", async () => {
    db.submitJob("ner-backfill", { slug: "records/item", kind: "ner" });
    const before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());
    let calls = 0;
    const pipeline = { processNer: async () => { calls++; } } as unknown as ContentPipeline;

    await expect(runNerBackfillStage(db, pipeline, new PageManager(db, testDir), {
      maxItems: 1,
      batchId: "",
    })).rejects.toThrow("BATCH_NOT_FOUND");
    expect(calls).toBe(0);
    expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
  });

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

  test("ordinary deferred NER leaves new stub indexing to the watcher", async () => {
    let repairing = false;
    let stubLanceAdds = 0;
    const lance = {
      ...createMockLanceDB(),
      addChunks: async () => {
        if (repairing) stubLanceAdds++;
      },
    };
    const embedding = createMockEmbeddingProvider();
    const seedIngest = new IngestManager(db, embedding, lance as never, testDir);
    const source = await seedIngest.ingest({
      content: "匿名普通延迟正文包含足够信息并提到匿名实体卯",
      type: "text",
      title: "匿名普通延迟记录",
      skipNer: true,
    });
    expect(new JobQueueNerSubmitter(db).submitDeferredNer({ slug: source.slug }).disposition).toBe("inserted");
    repairing = true;
    const llm: LLMProvider = {
      name: "mock",
      chat: async () => JSON.stringify({
        entities: [{ name: "匿名实体卯", type: "person", relevance: "high", context: "匿名上下文" }],
        relations: [],
        events: [],
      }),
    };
    const pages = new PageManager(db, testDir);
    const pipeline = new ContentPipeline(db, embedding, lance as never, {
      pages,
      nerEngine: new NerEngine(llm),
    });

    const counts = await runNerBackfillStage(db, pipeline, pages, { maxItems: 1 });

    const stub = db.rawDb.prepare("SELECT slug FROM pages WHERE title = ?").get("匿名实体卯") as { slug: string };
    expect(counts.processed).toBe(1);
    expect(stubLanceAdds).toBe(0);
    expect(db.getChunksByPage(stub.slug, { summaryLevel: 0 })).toHaveLength(0);
  });

  test("governed repair indexes newly created NER stubs before finalizing", async () => {
    const embedding = createMockEmbeddingProvider();
    const indexedInLance: Array<{ pageSlug: string; chunkIndex: number; content: string }> = [];
    const lance = {
      ...createMockLanceDB(),
      addChunks: async (chunks: Array<{ pageSlug: string; chunkIndex: number; content: string }>) => {
        indexedInLance.push(...chunks);
      },
    };
    const seedIngest = new IngestManager(db, embedding, lance as never, testDir);
    const page = await seedIngest.ingest({
      content: "匿名修复正文包含足够信息并提到匿名实体丁",
      type: "text",
      title: "匿名修复记录",
      skipNer: true,
    });
    db.insertChunk(page.slug, 99, "第二个匿名片段");
    const receipt = enqueueZeroLinkBackfill(db, 1);

    const llm: LLMProvider = {
      name: "mock",
      chat: async () => JSON.stringify({
        entities: [{ name: "匿名实体丁", type: "person", relevance: "high", context: "匿名上下文" }],
        relations: [],
        events: [],
      }),
    };
    const pages = new PageManager(db, testDir);
    indexedInLance.length = 0;
    const pipeline = new ContentPipeline(db, embedding, lance as never, {
      pages,
      nerEngine: new NerEngine(llm),
    });
    const counts = await runNerBackfillStage(db, pipeline, pages, {
      maxItems: 1,
      batchId: receipt.batchId!,
    });

    expect(counts.processed).toBe(1);
    const stub = db.rawDb.prepare("SELECT slug FROM pages WHERE title = ?").get("匿名实体丁") as { slug: string } | undefined;
    expect(stub).toBeDefined();
    expect(db.getChunksByPage(stub!.slug, { summaryLevel: 0 }).length).toBeGreaterThan(0);
    expect(db.rawDb.prepare("SELECT 1 FROM chunks_fts WHERE page_slug = ? LIMIT 1").get(stub!.slug)).toBeTruthy();
    expect(indexedInLance.some(chunk => chunk.pageSlug === stub!.slug && chunk.content.length > 0)).toBe(true);
    expect(summarizeRepairBatch(db, receipt.batchId!)).toMatchObject({
      finalized: true,
      outcomes: { resolved: 1, commitUnknown: 0 },
    });
  });

  test("governed repair uses the moved slug after NER type correction", async () => {
    const embedding = createMockEmbeddingProvider();
    const lance = createMockLanceDB();
    const seedIngest = new IngestManager(db, embedding, lance as never, testDir);
    const source = await seedIngest.ingest({
      content: "匿名修复正文包含足够信息并描述两个匿名实体之间的关系",
      type: "text",
      title: "匿名类型修复记录",
      skipNer: true,
    });
    db.insertChunk(source.slug, 99, "第二个匿名片段");
    const pages = new PageManager(db, testDir);
    const oldPage = pages.create({
      title: "匿名实体甲",
      type: "concept/concept",
      body: "匿名概念正文",
    });
    const target = pages.create({
      title: "匿名实体乙",
      type: "entity/person",
      body: "匿名人物正文",
    });
    const receipt = enqueueZeroLinkBackfill(db, 1);
    const llm: LLMProvider = {
      name: "mock",
      chat: async () => JSON.stringify({
        entities: [
          { name: "匿名实体甲", type: "person", relevance: "high", context: "匿名上下文" },
          { name: "匿名实体乙", type: "person", relevance: "high", context: "匿名上下文" },
        ],
        relations: [{ from: "匿名实体甲", to: "匿名实体乙", relation: "合作", context: "匿名证据" }],
        events: [],
        facts: [{
          entity: "匿名实体甲",
          field: "birthday",
          value: "2000-01-01",
          confidence: 0.9,
          evidence: "匿名证据",
        }],
      }),
    };
    const pipeline = new ContentPipeline(db, embedding, lance as never, {
      pages,
      nerEngine: new NerEngine(llm),
    });

    const counts = await runNerBackfillStage(db, pipeline, pages, {
      maxItems: 1,
      batchId: receipt.batchId!,
    });

    const movedSlug = db.getEntitySlugByTitle("匿名实体甲");
    expect(counts).toMatchObject({ processed: 1, failed: 0 });
    expect(movedSlug).toBeTruthy();
    expect(movedSlug).not.toBe(oldPage.slug);
    expect(db.getPage(oldPage.slug)).toBeNull();
    expect(db.getOutgoingLinks(movedSlug!).some(link =>
      link.to_slug === target.slug && link.relation === "合作"
    )).toBe(true);
    expect(pages.getBySlug(movedSlug!)?.frontmatter.birthday).toBe("2000-01-01");
    expect(summarizeRepairBatch(db, receipt.batchId!)).toMatchObject({
      finalized: true,
      outcomes: { resolved: 1, commitUnknown: 0 },
    });
  });

  test("governed repair remaps a later shared resolution after a type move", async () => {
    const embedding = createMockEmbeddingProvider();
    const lance = createMockLanceDB();
    const seedIngest = new IngestManager(db, embedding, lance as never, testDir);
    const source = await seedIngest.ingest({
      content: "匿名修复正文包含足够信息并重复提到同一个匿名实体",
      type: "text",
      title: "匿名同文档去重记录",
      skipNer: true,
    });
    db.insertChunk(source.slug, 99, "第二个匿名片段");
    const pages = new PageManager(db, testDir);
    const oldPage = pages.create({
      title: "匿名实体甲",
      type: "concept/concept",
      body: "匿名概念正文",
    });
    const receipt = enqueueZeroLinkBackfill(db, 1);
    const llm: LLMProvider = {
      name: "mock",
      chat: async () => JSON.stringify({
        entities: [
          { name: "匿名实体甲", type: "person", relevance: "high", context: "匿名上下文" },
          { name: "匿名实体甲。", type: "person", relevance: "high", context: "匿名上下文" },
        ],
        relations: [],
        events: [],
      }),
    };
    const pipeline = new ContentPipeline(db, embedding, lance as never, {
      pages,
      nerEngine: new NerEngine(llm),
    });

    const counts = await runNerBackfillStage(db, pipeline, pages, {
      maxItems: 1,
      batchId: receipt.batchId!,
    });

    const movedSlug = db.getEntitySlugByTitle("匿名实体甲");
    expect(counts).toMatchObject({ processed: 1, failed: 0 });
    expect(movedSlug).toBeTruthy();
    expect(movedSlug).not.toBe(oldPage.slug);
    expect(db.getPage(oldPage.slug)).toBeNull();
    expect(db.getOutgoingLinks(source.slug).some(link => link.to_slug === movedSlug)).toBe(true);
    expect(summarizeRepairBatch(db, receipt.batchId!)).toMatchObject({
      finalized: true,
      outcomes: { resolved: 1, commitUnknown: 0 },
    });
  });

  test("governed repair remaps a later duplicate candidate after a type move", async () => {
    const embedding = createMockEmbeddingProvider();
    const lance = createMockLanceDB();
    const seedIngest = new IngestManager(db, embedding, lance as never, testDir);
    const source = await seedIngest.ingest({
      content: "匿名修复正文包含足够信息并提到同一实体的匿名别名",
      type: "text",
      title: "匿名重复候选记录",
      skipNer: true,
    });
    db.insertChunk(source.slug, 99, "第二个匿名片段");
    const pages = new PageManager(db, testDir);
    const oldPage = pages.create({
      title: "匿名实体甲",
      type: "concept/concept",
      body: "匿名概念正文",
    });
    db.addAliasWithSource(oldPage.slug, "匿名别名", "manual");
    const receipt = enqueueZeroLinkBackfill(db, 1);
    const llm: LLMProvider = {
      name: "mock",
      chat: async () => JSON.stringify({
        entities: [
          { name: "匿名实体甲", type: "person", relevance: "high", context: "匿名上下文" },
          { name: "匿名别名", type: "drug", relevance: "high", context: "匿名上下文" },
        ],
        relations: [],
        events: [],
      }),
    };
    const pipeline = new ContentPipeline(db, embedding, lance as never, {
      pages,
      nerEngine: new NerEngine(llm),
    });

    const counts = await runNerBackfillStage(db, pipeline, pages, {
      maxItems: 1,
      batchId: receipt.batchId!,
    });

    const movedSlug = db.getEntitySlugByTitle("匿名实体甲");
    expect(counts).toMatchObject({ processed: 1, failed: 0 });
    expect(movedSlug).toBeTruthy();
    expect(movedSlug).not.toBe(oldPage.slug);
    expect(db.getPage(oldPage.slug)).toBeNull();
    expect(db.getOutgoingLinks(source.slug).some(link => link.to_slug === movedSlug)).toBe(true);
    expect(summarizeRepairBatch(db, receipt.batchId!)).toMatchObject({
      finalized: true,
      outcomes: { resolved: 1, commitUnknown: 0 },
    });
  });

  test("governed repair migrates raw and L1 Lance rows with a corrected page slug", async () => {
    const embedding = new DeterministicEmbeddingProvider();
    const lance = new LanceDBManager();
    await lance.connect(join(testDir, "lancedb"));
    try {
      const seedIngest = new IngestManager(db, embedding, lance, testDir);
      const source = await seedIngest.ingest({
        content: "匿名修复正文包含足够信息并提到需要纠正类型的匿名实体",
        type: "text",
        title: "匿名向量迁移记录",
        skipNer: true,
      });
      db.insertChunk(source.slug, 99, "第二个匿名片段");
      const pages = new PageManager(db, testDir);
      const oldPage = pages.create({
        title: "匿名实体甲",
        type: "concept/concept",
        body: "匿名概念正文",
      });
      const rawContent = "匿名原始向量正文";
      const l1Content = "匿名一级摘要";
      const [rawEmbedding, l1Embedding] = await embedding.embedBatch([rawContent, l1Content]);
      db.insertChunk(oldPage.slug, 0, rawContent);
      db.insertChunkWithLevel(oldPage.slug, -1, l1Content, 1, "anonymous-hash");
      await lance.addChunks([
        { pageSlug: oldPage.slug, chunkIndex: 0, content: rawContent, vector: new Float32Array(rawEmbedding.embedding) },
        { pageSlug: oldPage.slug, chunkIndex: -1, content: l1Content, vector: new Float32Array(l1Embedding.embedding) },
      ]);
      const receipt = enqueueZeroLinkBackfill(db, 1);
      const llm: LLMProvider = {
        name: "mock",
        chat: async () => JSON.stringify({
          entities: [{ name: "匿名实体甲", type: "person", relevance: "high", context: "匿名上下文" }],
          relations: [],
          events: [],
        }),
      };
      const pipeline = new ContentPipeline(db, embedding, lance, {
        pages,
        nerEngine: new NerEngine(llm),
      });

      const counts = await runNerBackfillStage(db, pipeline, pages, {
        maxItems: 1,
        batchId: receipt.batchId!,
      });

      const movedSlug = db.getEntitySlugByTitle("匿名实体甲")!;
      expect(counts).toMatchObject({ processed: 1, failed: 0 });
      expect(movedSlug).not.toBe(oldPage.slug);
      expect(await lance.readRawVectorRows(oldPage.slug)).toHaveLength(0);
      expect(await lance.readL1VectorRows(oldPage.slug)).toHaveLength(0);
      expect(await lance.readRawVectorRows(movedSlug)).toMatchObject([
        { pageSlug: movedSlug, chunkIndex: 0, content: rawContent },
      ]);
      expect(await lance.readL1VectorRows(movedSlug)).toMatchObject([
        { pageSlug: movedSlug, chunkIndex: -1, content: l1Content },
      ]);
      expect(summarizeRepairBatch(db, receipt.batchId!)).toMatchObject({
        finalized: true,
        outcomes: { resolved: 1, commitUnknown: 0 },
      });
    } finally {
      await lance.close();
    }
  });

  test("governed repair leaves the batch commit-unknown when a type-move Lance write fails", async () => {
    const embedding = new DeterministicEmbeddingProvider();
    const lance = new LanceDBManager();
    await lance.connect(join(testDir, "lancedb"));
    try {
      const seedIngest = new IngestManager(db, embedding, lance, testDir);
      const source = await seedIngest.ingest({
        content: "匿名修复正文包含足够信息并触发向量迁移失败保护",
        type: "text",
        title: "匿名迁移失败记录",
        skipNer: true,
      });
      db.insertChunk(source.slug, 99, "第二个匿名片段");
      const pages = new PageManager(db, testDir);
      const oldPage = pages.create({
        title: "匿名实体甲",
        type: "concept/concept",
        body: "匿名概念正文",
      });
      const rawContent = "匿名原始向量正文";
      const embedded = await embedding.embed(rawContent);
      db.insertChunk(oldPage.slug, 0, rawContent);
      await lance.addChunks([{
        pageSlug: oldPage.slug,
        chunkIndex: 0,
        content: rawContent,
        vector: new Float32Array(embedded.embedding),
      }]);
      const originalAddChunks = lance.addChunks.bind(lance);
      let failTypeMove = false;
      lance.addChunks = async (chunks) => {
        if (failTypeMove) throw new Error("synthetic type-move vector failure");
        return originalAddChunks(chunks);
      };
      const receipt = enqueueZeroLinkBackfill(db, 1);
      const llm: LLMProvider = {
        name: "mock",
        chat: async () => JSON.stringify({
          entities: [{ name: "匿名实体甲", type: "person", relevance: "high", context: "匿名上下文" }],
          relations: [],
          events: [],
        }),
      };
      const pipeline = new ContentPipeline(db, embedding, lance, {
        pages,
        nerEngine: new NerEngine(llm),
      });
      failTypeMove = true;

      const counts = await runNerBackfillStage(db, pipeline, pages, {
        maxItems: 1,
        batchId: receipt.batchId!,
      });

      expect(counts).toMatchObject({ processed: 0, failed: 1 });
      expect(summarizeRepairBatch(db, receipt.batchId!)).toMatchObject({
        finalized: false,
        outcomes: { resolved: 0, commitUnknown: 1 },
      });
    } finally {
      await lance.close();
    }
  });

  test("governed repair preserves old vectors when a type-move Lance write silently short-writes", async () => {
    const embedding = new DeterministicEmbeddingProvider();
    const lance = new LanceDBManager();
    await lance.connect(join(testDir, "lancedb"));
    try {
      const seedIngest = new IngestManager(db, embedding, lance, testDir);
      const source = await seedIngest.ingest({
        content: "匿名修复正文包含足够信息并触发向量短写保护",
        type: "text",
        title: "匿名短写保护记录",
        skipNer: true,
      });
      db.insertChunk(source.slug, 99, "第二个匿名片段");
      const pages = new PageManager(db, testDir);
      const oldPage = pages.create({
        title: "匿名实体甲",
        type: "concept/concept",
        body: "匿名概念正文",
      });
      const rawContent = "匿名原始向量正文";
      const l1Content = "匿名一级摘要";
      const [rawEmbedding, l1Embedding] = await embedding.embedBatch([rawContent, l1Content]);
      db.insertChunk(oldPage.slug, 0, rawContent);
      db.insertChunkWithLevel(oldPage.slug, -1, l1Content, 1, "anonymous-hash");
      await lance.addChunks([
        { pageSlug: oldPage.slug, chunkIndex: 0, content: rawContent, vector: new Float32Array(rawEmbedding.embedding) },
        { pageSlug: oldPage.slug, chunkIndex: -1, content: l1Content, vector: new Float32Array(l1Embedding.embedding) },
      ]);
      const originalAddChunks = lance.addChunks.bind(lance);
      let shortWriteTypeMove = false;
      lance.addChunks = async (chunks) => {
        if (shortWriteTypeMove) {
          await originalAddChunks(chunks.filter(chunk => chunk.chunkIndex >= 0));
          return;
        }
        await originalAddChunks(chunks);
      };
      const receipt = enqueueZeroLinkBackfill(db, 1);
      const llm: LLMProvider = {
        name: "mock",
        chat: async () => JSON.stringify({
          entities: [{ name: "匿名实体甲", type: "person", relevance: "high", context: "匿名上下文" }],
          relations: [],
          events: [],
        }),
      };
      const pipeline = new ContentPipeline(db, embedding, lance, {
        pages,
        nerEngine: new NerEngine(llm),
      });
      shortWriteTypeMove = true;

      const counts = await runNerBackfillStage(db, pipeline, pages, {
        maxItems: 1,
        batchId: receipt.batchId!,
      });

      expect(counts).toMatchObject({ processed: 0, failed: 1 });
      expect(await lance.readRawVectorRows(oldPage.slug)).toMatchObject([{
        pageSlug: oldPage.slug,
        chunkIndex: 0,
        content: rawContent,
      }]);
      expect(await lance.readL1VectorRows(oldPage.slug)).toMatchObject([{
        pageSlug: oldPage.slug,
        chunkIndex: -1,
        content: l1Content,
      }]);
      expect(summarizeRepairBatch(db, receipt.batchId!)).toMatchObject({
        finalized: false,
        outcomes: { resolved: 0, commitUnknown: 1 },
      });
    } finally {
      await lance.close();
    }
  });

  test("governed repair never overwrites orphan target vectors during a type move", async () => {
    const embedding = new DeterministicEmbeddingProvider();
    const lance = new LanceDBManager();
    await lance.connect(join(testDir, "lancedb"));
    try {
      const seedIngest = new IngestManager(db, embedding, lance, testDir);
      const source = await seedIngest.ingest({
        content: "匿名修复正文包含足够信息并触发目标向量冲突保护",
        type: "text",
        title: "匿名目标冲突记录",
        skipNer: true,
      });
      db.insertChunk(source.slug, 99, "第二个匿名片段");
      const pages = new PageManager(db, testDir);
      const oldPage = pages.create({
        title: "匿名实体甲",
        type: "concept/concept",
        body: "匿名概念正文",
      });
      const targetSlug = canonicalSlug(oldPage.slug, "entity/person");
      const [oldEmbedding, orphanEmbedding] = await embedding.embedBatch([
        "匿名旧向量",
        "匿名目标孤儿向量",
      ]);
      db.insertChunk(oldPage.slug, 0, "匿名旧向量");
      await lance.addChunks([
        {
          pageSlug: oldPage.slug,
          chunkIndex: 0,
          content: "匿名旧向量",
          vector: new Float32Array(oldEmbedding.embedding),
        },
        {
          pageSlug: targetSlug,
          chunkIndex: 0,
          content: "匿名目标孤儿向量",
          vector: new Float32Array(orphanEmbedding.embedding),
        },
      ]);
      const receipt = enqueueZeroLinkBackfill(db, 1);
      const llm: LLMProvider = {
        name: "mock",
        chat: async () => JSON.stringify({
          entities: [{ name: "匿名实体甲", type: "person", relevance: "high", context: "匿名上下文" }],
          relations: [],
          events: [],
        }),
      };
      const pipeline = new ContentPipeline(db, embedding, lance, {
        pages,
        nerEngine: new NerEngine(llm),
      });

      const counts = await runNerBackfillStage(db, pipeline, pages, {
        maxItems: 1,
        batchId: receipt.batchId!,
      });

      expect(counts).toMatchObject({ processed: 0, failed: 1 });
      expect(await lance.readRawVectorRows(targetSlug)).toMatchObject([{
        pageSlug: targetSlug,
        chunkIndex: 0,
        content: "匿名目标孤儿向量",
      }]);
      expect(summarizeRepairBatch(db, receipt.batchId!)).toMatchObject({
        finalized: false,
        outcomes: { resolved: 0, commitUnknown: 1 },
      });
    } finally {
      await lance.close();
    }
  });

  test("ordinary NER keeps wikilink mention skips after a type-move slug change", async () => {
    const pages = new PageManager(db, testDir);
    const source = pages.create({
      title: "匿名普通记录",
      type: "record",
      body: "匿名正文",
    });
    const oldPage = pages.create({
      title: "匿名实体甲",
      type: "concept/concept",
      body: "匿名概念正文",
    });
    const llm: LLMProvider = {
      name: "mock",
      chat: async () => JSON.stringify({
        entities: [
          { name: "匿名实体甲", type: "person", relevance: "high", context: "匿名上下文" },
          { name: "匿名实体甲。", type: "person", relevance: "high", context: "匿名上下文" },
        ],
        relations: [],
        events: [],
      }),
    };
    const pipeline = new ContentPipeline(
      db,
      createMockEmbeddingProvider(),
      createMockLanceDB() as never,
      { pages, nerEngine: new NerEngine(llm) },
    );

    await pipeline.processNer(
      source.slug,
      "匿名正文重复提到同一个实体",
      "record",
      false,
      undefined,
      new Set([oldPage.slug]),
    );

    const movedSlug = db.getEntitySlugByTitle("匿名实体甲")!;
    expect(movedSlug).not.toBe(oldPage.slug);
    expect(db.getPage(oldPage.slug)).toBeNull();
    expect(db.getPageTierAndMentions(movedSlug)?.mention_count).toBe(0);
  });

  test("stub index failure leaves the governed batch commit-unknown and unfinalized", async () => {
    let failStubIndex = false;
    const lance = {
      ...createMockLanceDB(),
      addChunks: async () => {
        if (failStubIndex) throw new Error("synthetic index failure");
      },
    };
    const embedding = createMockEmbeddingProvider();
    const seedIngest = new IngestManager(db, embedding, lance as never, testDir);
    const page = await seedIngest.ingest({
      content: "匿名失败正文包含足够信息并提到匿名实体戊",
      type: "text",
      title: "匿名失败记录",
      skipNer: true,
    });
    db.insertChunk(page.slug, 99, "第二个匿名片段");
    const receipt = enqueueZeroLinkBackfill(db, 1);
    failStubIndex = true;

    const llm: LLMProvider = {
      name: "mock",
      chat: async () => JSON.stringify({
        entities: [{ name: "匿名实体戊", type: "person", relevance: "high", context: "匿名上下文" }],
        relations: [],
        events: [],
      }),
    };
    const pages = new PageManager(db, testDir);
    const pipeline = new ContentPipeline(db, embedding, lance as never, {
      pages,
      nerEngine: new NerEngine(llm),
    });

    const counts = await runNerBackfillStage(db, pipeline, pages, {
      maxItems: 1,
      batchId: receipt.batchId!,
    });

    expect(counts).toMatchObject({ processed: 0, failed: 1 });
    expect(summarizeRepairBatch(db, receipt.batchId!)).toMatchObject({
      finalized: false,
      outcomes: { commitUnknown: 1 },
    });
  });

  test("governed repair batches all new stub embeddings into one provider call", async () => {
    const baseEmbedding = createMockEmbeddingProvider();
    let embedBatchCalls = 0;
    const embedding: EmbeddingProvider = {
      ...baseEmbedding,
      embedBatch: async (texts) => {
        embedBatchCalls++;
        return baseEmbedding.embedBatch(texts);
      },
    };
    const lanceRows: Array<{ pageSlug: string; content: string }> = [];
    const lance = {
      ...createMockLanceDB(),
      addChunks: async (chunks: Array<{ pageSlug: string; content: string }>) => {
        lanceRows.push(...chunks);
      },
    };
    const seedIngest = new IngestManager(db, embedding, lance as never, testDir);
    const page = await seedIngest.ingest({
      content: "匿名批量正文包含足够信息并提到两个匿名实体",
      type: "text",
      title: "匿名批量记录",
      skipNer: true,
    });
    db.insertChunk(page.slug, 99, "第二个匿名片段");
    const receipt = enqueueZeroLinkBackfill(db, 1);
    embedBatchCalls = 0;
    lanceRows.length = 0;

    const llm: LLMProvider = {
      name: "mock",
      chat: async () => JSON.stringify({
        entities: [
          { name: "匿名实体己", type: "person", relevance: "high", context: "匿名上下文" },
          { name: "匿名实体庚", type: "company", relevance: "high", context: "匿名上下文" },
        ],
        relations: [
          { from: "匿名实体己", to: "匿名实体庚", relation: "works_at", context: "匿名关系上下文" },
        ],
        events: [],
      }),
    };
    const pages = new PageManager(db, testDir);
    const pipeline = new ContentPipeline(db, embedding, lance as never, {
      pages,
      nerEngine: new NerEngine(llm),
    });

    const counts = await runNerBackfillStage(db, pipeline, pages, {
      maxItems: 1,
      batchId: receipt.batchId!,
    });

    expect(counts.processed).toBe(1);
    expect(embedBatchCalls).toBe(1);
    for (const title of ["匿名实体己", "匿名实体庚"]) {
      const stub = db.rawDb.prepare("SELECT slug FROM pages WHERE title = ?").get(title) as { slug: string };
      const finalBody = pages.getBySlug(stub.slug)!.body;
      const sqliteContent = db.getChunksByPage(stub.slug, { summaryLevel: 0 }).map(chunk => chunk.content).join("\n");
      const lanceContent = lanceRows.filter(row => row.pageSlug === stub.slug).map(row => row.content).join("\n");
      expect(finalBody).toContain("Known Relations");
      expect(sqliteContent).toBe(finalBody);
      expect(db.getFtsContentsByPage(stub.slug)).toContain(finalBody);
      expect(lanceContent).toBe(finalBody);
    }
  });

  for (const mutation of ["extra", "missing"] as const) {
    test(`governed repair rejects ${mutation} stub embedding results before any index write`, async () => {
      const baseEmbedding = createMockEmbeddingProvider();
      const embedding: EmbeddingProvider = {
        ...baseEmbedding,
        embedBatch: async (texts) => {
          const results = await baseEmbedding.embedBatch(texts);
          if (!texts.every(text => text.includes("Auto-extracted"))) return results;
          return mutation === "extra"
            ? [...results, results[0]!]
            : results.slice(0, -1);
        },
      };
      const lance = createMockLanceDB();
      const seedIngest = new IngestManager(db, embedding, lance as never, testDir);
      const source = await seedIngest.ingest({
        content: "匿名向量数量正文包含足够信息并提到两个匿名实体",
        type: "text",
        title: "匿名向量数量记录",
        skipNer: true,
      });
      db.insertChunk(source.slug, 99, "第二个匿名片段");
      const receipt = enqueueZeroLinkBackfill(db, 1);
      const llm: LLMProvider = {
        name: "mock",
        chat: async () => JSON.stringify({
          entities: [
            { name: "匿名实体辛", type: "person", relevance: "high", context: "匿名上下文" },
            { name: "匿名实体壬", type: "company", relevance: "high", context: "匿名上下文" },
          ],
          relations: [],
          events: [],
        }),
      };
      const pages = new PageManager(db, testDir);
      const pipeline = new ContentPipeline(db, embedding, lance as never, {
        pages,
        nerEngine: new NerEngine(llm),
      });

      const counts = await runNerBackfillStage(db, pipeline, pages, {
        maxItems: 1,
        batchId: receipt.batchId!,
      });

      expect(counts).toMatchObject({ processed: 0, failed: 1 });
      const stubs = db.rawDb.prepare(
        "SELECT slug FROM pages WHERE title IN (?, ?) ORDER BY title",
      ).all("匿名实体辛", "匿名实体壬") as Array<{ slug: string }>;
      expect(stubs).toHaveLength(2);
      expect(stubs.every(stub => db.getChunksByPage(stub.slug, { summaryLevel: 0 }).length === 0)).toBe(true);
      expect(summarizeRepairBatch(db, receipt.batchId!)).toMatchObject({
        finalized: false,
        outcomes: { commitUnknown: 1 },
      });
    });
  }

  for (const pageState of ["missing", "empty"] as const) {
    test(`governed repair rejects a ${pageState} created stub before finalizing`, async () => {
      const embedding = createMockEmbeddingProvider();
      const lance = createMockLanceDB();
      const seedIngest = new IngestManager(db, embedding, lance as never, testDir);
      const source = await seedIngest.ingest({
        content: "匿名缺页正文包含足够信息并提到匿名实体癸",
        type: "text",
        title: "匿名缺页记录",
        skipNer: true,
      });
      db.insertChunk(source.slug, 99, "第二个匿名片段");
      const receipt = enqueueZeroLinkBackfill(db, 1);
      const llm: LLMProvider = {
        name: "mock",
        chat: async () => JSON.stringify({
          entities: [{ name: "匿名实体癸", type: "person", relevance: "high", context: "匿名上下文" }],
          relations: [],
          events: [],
        }),
      };
      const pages = new PageManager(db, testDir);
      const getBySlug = pages.getBySlug.bind(pages);
      let stubReads = 0;
      pages.getBySlug = ((slug: string) => {
        const page = getBySlug(slug);
        if (slug === source.slug || !page) return page;
        stubReads++;
        if (stubReads === 1) return page; // PageManager.create must finish normally.
        return pageState === "missing" ? null : { ...page, body: "" };
      }) as typeof pages.getBySlug;
      const pipeline = new ContentPipeline(db, embedding, lance as never, {
        pages,
        nerEngine: new NerEngine(llm),
      });

      const counts = await runNerBackfillStage(db, pipeline, pages, {
        maxItems: 1,
        batchId: receipt.batchId!,
      });

      expect(counts).toMatchObject({ processed: 0, failed: 1 });
      expect(summarizeRepairBatch(db, receipt.batchId!)).toMatchObject({
        finalized: false,
        outcomes: { commitUnknown: 1 },
      });
    });
  }

  test("a second stub Lance failure leaves the governed batch commit-unknown", async () => {
    let stubAdds = 0;
    let repairing = false;
    const indexedSlugs: string[] = [];
    const lance = {
      ...createMockLanceDB(),
      addChunks: async (chunks: Array<{ pageSlug: string }>) => {
        if (!repairing) return;
        stubAdds++;
        if (stubAdds === 2) throw new Error("synthetic second stub Lance failure");
        indexedSlugs.push(...chunks.map(chunk => chunk.pageSlug));
      },
    };
    const embedding = createMockEmbeddingProvider();
    const seedIngest = new IngestManager(db, embedding, lance as never, testDir);
    const source = await seedIngest.ingest({
      content: "匿名部分索引正文包含足够信息并提到两个匿名实体",
      type: "text",
      title: "匿名部分索引记录",
      skipNer: true,
    });
    db.insertChunk(source.slug, 99, "第二个匿名片段");
    const receipt = enqueueZeroLinkBackfill(db, 1);
    repairing = true;
    const llm: LLMProvider = {
      name: "mock",
      chat: async () => JSON.stringify({
        entities: [
          { name: "匿名实体子", type: "person", relevance: "high", context: "匿名上下文" },
          { name: "匿名实体丑", type: "company", relevance: "high", context: "匿名上下文" },
        ],
        relations: [],
        events: [],
      }),
    };
    const pages = new PageManager(db, testDir);
    const pipeline = new ContentPipeline(db, embedding, lance as never, {
      pages,
      nerEngine: new NerEngine(llm),
    });

    const counts = await runNerBackfillStage(db, pipeline, pages, {
      maxItems: 1,
      batchId: receipt.batchId!,
    });

    expect(stubAdds).toBe(2);
    expect(counts).toMatchObject({ processed: 0, failed: 1 });
    const firstStub = db.rawDb.prepare("SELECT slug FROM pages WHERE title = ?").get("匿名实体子") as { slug: string };
    const secondStub = db.rawDb.prepare("SELECT slug FROM pages WHERE title = ?").get("匿名实体丑") as { slug: string };
    expect(db.getChunksByPage(firstStub.slug, { summaryLevel: 0 }).length).toBeGreaterThan(0);
    expect(db.getChunksByPage(secondStub.slug, { summaryLevel: 0 })).toHaveLength(0);
    expect(indexedSlugs).toContain(firstStub.slug);
    expect(indexedSlugs).not.toContain(secondStub.slug);
    expect(summarizeRepairBatch(db, receipt.batchId!)).toMatchObject({
      finalized: false,
      outcomes: { commitUnknown: 1 },
    });
  });

  for (const fault of ["SQLite chunk", "FTS"] as const) {
    test(`a stub ${fault} failure leaves the governed batch commit-unknown`, async () => {
      const embedding = createMockEmbeddingProvider();
      const lance = createMockLanceDB();
      const seedIngest = new IngestManager(db, embedding, lance as never, testDir);
      const source = await seedIngest.ingest({
        content: "匿名索引故障正文包含足够信息并提到匿名实体寅",
        type: "text",
        title: "匿名索引故障记录",
        skipNer: true,
      });
      db.insertChunk(source.slug, 99, "第二个匿名片段");
      const receipt = enqueueZeroLinkBackfill(db, 1);
      if (fault === "SQLite chunk") {
        const insertChunk = db.insertChunk.bind(db);
        db.insertChunk = ((pageSlug: string, index: number, content: string) => {
          if (pageSlug !== source.slug) throw new Error("synthetic SQLite chunk failure");
          return insertChunk(pageSlug, index, content);
        }) as typeof db.insertChunk;
      } else {
        const ftsInsert = db.ftsInsert.bind(db);
        db.ftsInsert = ((pageSlug: string, content: string) => {
          if (pageSlug !== source.slug) throw new Error("synthetic FTS failure");
          return ftsInsert(pageSlug, content);
        }) as typeof db.ftsInsert;
      }
      const llm: LLMProvider = {
        name: "mock",
        chat: async () => JSON.stringify({
          entities: [{ name: "匿名实体寅", type: "person", relevance: "high", context: "匿名上下文" }],
          relations: [],
          events: [],
        }),
      };
      const pages = new PageManager(db, testDir);
      const pipeline = new ContentPipeline(db, embedding, lance as never, {
        pages,
        nerEngine: new NerEngine(llm),
      });

      const counts = await runNerBackfillStage(db, pipeline, pages, {
        maxItems: 1,
        batchId: receipt.batchId!,
      });

      const stub = db.rawDb.prepare("SELECT slug FROM pages WHERE title = ?").get("匿名实体寅") as { slug: string };
      expect(counts).toMatchObject({ processed: 0, failed: 1 });
      expect(db.getChunksByPage(stub.slug, { summaryLevel: 0 })).toHaveLength(0);
      expect(summarizeRepairBatch(db, receipt.batchId!)).toMatchObject({
        finalized: false,
        outcomes: { commitUnknown: 1 },
      });
    });
  }

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

  test("provider timeout is persisted as NER_TIMEOUT rather than provider failure", async () => {
    const embedding = createMockEmbeddingProvider();
    const seedIngest = new IngestManager(db, embedding, createMockLanceDB() as never, testDir);
    const res = await seedIngest.ingest({ content: "匿名超时正文", type: "text", title: "provider-timeout", skipNer: true });
    const id = db.submitJob("ner-backfill", { slug: res.slug });
    const providerTimeout = Object.assign(new Error("private provider detail"), {
      code: "LLM_TIMEOUT",
      isLLMTimeout: true,
      timeoutMs: 30_000,
    });
    const llm: LLMProvider = {
      name: "slow-provider",
      chat: async () => { throw providerTimeout; },
    };

    const counts = await runNerBackfillStage(db, pipelineWith(llm), new PageManager(db, testDir));

    expect(counts).toMatchObject({ failed: 0, timed_out: 1 });
    expect(db.getJob(id)).toMatchObject({ status: "pending", error: "NER_TIMEOUT" });
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

  test("malformed commit-unknown freezes planning, stage, and direct successor claim", async () => {
    db.upsertPage({ slug: "records/current", type: "record", title: "Current", filePath: "records/current.md", contentHash: "hash-a" });
    db.insertChunk("records/current", 0, "first");
    db.rawDb.prepare(
      "INSERT INTO jobs (name,status,data,result,finished_at) VALUES ('ner-backfill','done','{',?,datetime('now'))",
    ).run(JSON.stringify({ outcome: "commit_unknown", kind: "ner" }));
    const successor = db.submitJob("ner-backfill", {
      slug: "records/current", kind: "ner", pageContentHash: "hash-a", sourceFingerprint: "page:hash-a",
    });
    const frozen = buildNerAttemptIdentity(JSON.parse(db.getJob(successor)!.data!))!;
    const before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());
    let calls = 0;

    expect(planZeroLinkBackfill(db)).toMatchObject({ status: "blocked", queueIntegrityConflicts: 1 });
    await expect(runNerBackfillStage(
      db,
      { processNer: async () => { calls++; } } as unknown as ContentPipeline,
      new PageManager(db, testDir),
      { maxItems: 1 },
    )).rejects.toThrow("QUEUE_INTEGRITY_CONFLICT");
    expect(db.claimNerJobByIdWithLease(successor, frozen)).toBeNull();
    expect(calls).toBe(0);
    expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
  });

  test("non-candidate duplicate live NER rows fail global preflight with zero mutation", async () => {
    db.upsertPage({ slug: "records/linked", type: "record", title: "Linked", filePath: "records/linked.md", contentHash: "hash-a" });
    db.insertChunk("records/linked", 0, "first");
    db.insertChunk("records/linked", 1, "second");
    db.upsertPage({ slug: "entity/target", type: "entity/person", title: "Target", filePath: "entity/target.md", contentHash: "hash-b" });
    db.rawDb.prepare("INSERT INTO links (from_slug,to_slug,relation,trust_state) VALUES (?,?,?,?)")
      .run("records/linked", "entity/target", "mentions", "trusted");
    db.submitJob("ner-backfill", { slug: "records/linked", kind: "ner", pageContentHash: "hash-a", sourceFingerprint: "page:hash-a" });
    db.submitJob("ner-backfill", { slug: "records/linked", kind: "ner", pageContentHash: "hash-a", sourceFingerprint: "page:hash-a" });
    const before = JSON.stringify(db.listJobs());

    await expect(runNerBackfillStage(db, {} as ContentPipeline, new PageManager(db, testDir), { maxItems: 1 }))
      .rejects.toThrow("QUEUE_INTEGRITY_CONFLICT");
    expect(JSON.stringify(db.listJobs())).toBe(before);
  });

  test("a current ordinary row with a wrong page snapshot hash blocks before LLM", async () => {
    db.upsertPage({ slug: "records/linked", type: "record", title: "Linked", filePath: "records/linked.md", contentHash: "hash-a" });
    db.insertChunk("records/linked", 0, "first");
    const id = db.submitJob("ner-backfill", {
      slug: "records/linked",
      kind: "ner",
      pageContentHash: "wrong-hash",
      sourceFingerprint: "page:hash-a",
    });
    const before = JSON.stringify(db.getJob(id));
    let calls = 0;
    const guardedPipeline = { processNer: async () => { calls++; } } as unknown as ContentPipeline;

    await expect(runNerBackfillStage(db, guardedPipeline, new PageManager(db, testDir), { maxItems: 1 }))
      .rejects.toThrow("QUEUE_INTEGRITY_CONFLICT");
    expect(calls).toBe(0);
    expect(JSON.stringify(db.getJob(id))).toBe(before);
  });

  test("a source-kind mismatch blocks NER execution before LLM", async () => {
    db.upsertPage({ slug: "records/linked", type: "record", title: "Linked", filePath: "records/linked.md", contentHash: "hash-a" });
    db.insertChunk("records/linked", 0, "first");
    const id = db.submitJob("ner-backfill", {
      slug: "records/linked",
      kind: "ner",
      pageContentHash: "hash-a",
      sourceFingerprint: "page:hash-a",
      sourceKind: "raw_chunks",
    });
    const before = JSON.stringify(db.getJob(id));
    let calls = 0;
    const guardedPipeline = { processNer: async () => { calls++; } } as unknown as ContentPipeline;

    await expect(runNerBackfillStage(db, guardedPipeline, new PageManager(db, testDir), { maxItems: 1 }))
      .rejects.toThrow("QUEUE_INTEGRITY_CONFLICT");
    expect(calls).toBe(0);
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

  test("stale entity_facts is recovered without receiving a NER lease", async () => {
    const seed = new IngestManager(
      db, createMockEmbeddingProvider(), createMockLanceDB() as never, testDir,
      undefined, undefined, { nerMode: "off" },
    );
    const page = await seed.ingest({ type: "markdown", content: "---\ntitle: 实体A\ntype: entity/company\n---\n匿名正文。" });
    const id = db.submitJob("ner-backfill", { slug: page.slug, kind: "entity_facts" });
    db.claimJobById(id);
    db.rawDb.prepare("UPDATE jobs SET started_at=datetime('now','-31 minutes') WHERE id=?").run(id);
    const llm: LLMProvider = { name: "mock", chat: async () => JSON.stringify({ facts: [] }) };

    const counts = await runNerBackfillStage(db, pipelineWith(llm), new PageManager(db, testDir), { entityFactsLlm: llm });

    expect(counts.processed).toBe(1);
    expect(db.getJob(id)!.status).toBe("done");
    expect(JSON.parse(db.getJob(id)!.data!)).not.toHaveProperty("attemptLease");
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

  test("UUID-filtered repair rejects child replacement between snapshot and atomic claim", async () => {
    const ingest = new IngestManager(db, createMockEmbeddingProvider(), createMockLanceDB() as never, testDir);
    const page = await ingest.ingest({ content: "匿名修复页正文", type: "text", title: "修复页", skipNer: true });
    db.insertChunk(page.slug, 99, "第二片段");
    const receipt = enqueueZeroLinkBackfill(db, 1);
    const child = db.rawDb.prepare("SELECT id FROM jobs WHERE name='ner-backfill'").get() as { id: number };
    const originalGetJob = db.getJob.bind(db);
    let injected = false;
    (db as unknown as { getJob: typeof db.getJob }).getJob = ((id: number) => {
      const row = originalGetJob(id);
      if (id === child.id && !injected) {
        injected = true;
        db.rawDb.prepare("UPDATE jobs SET data=? WHERE id=?").run(JSON.stringify({
          slug: page.slug,
          kind: "ner",
          sourceFingerprint: "page:replacement",
          pageContentHash: "replacement",
        }), id);
      }
      return row;
    }) as typeof db.getJob;
    let calls = 0;
    const pipeline = { processNer: async () => { calls++; } } as unknown as ContentPipeline;

    await expect(runNerBackfillStage(db, pipeline, new PageManager(db, testDir), {
      maxItems: 1,
      batchId: receipt.batchId,
    })).rejects.toThrow("BATCH_INTEGRITY_CONFLICT");
    expect(calls).toBe(0);
    expect(db.getJob(child.id)!.status).toBe("pending");
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

  test("a finalized zero-LLM source drift does not permanently own the restored epoch", async () => {
    const ingest = new IngestManager(db, createMockEmbeddingProvider(), createMockLanceDB() as never, testDir);
    const page = await ingest.ingest({ content: "匿名恢复页正文", type: "text", title: "恢复页", skipNer: true });
    db.insertChunk(page.slug, 99, "第二片段");
    const originalPath = join(testDir, db.getPage(page.slug)!.file_path);
    const originalBytes = readFileSync(originalPath);
    const receipt = enqueueZeroLinkBackfill(db, 1);
    writeFileSync(originalPath, "changed bytes", "utf8");
    const counts = await runNerBackfillStage(
      db,
      { processNer: async () => { throw new Error("LLM must not run"); } } as unknown as ContentPipeline,
      new PageManager(db, testDir),
      { maxItems: 1, batchId: receipt.batchId },
    );
    expect(counts.skipped).toBe(1);
    expect(summarizeRepairBatch(db, receipt.batchId!)).toMatchObject({ finalized: true, outcomes: { sourceChanged: 1 } });

    writeFileSync(originalPath, originalBytes);
    expect(planZeroLinkBackfill(db, 1)).toMatchObject({ actionable: 1, selected: 1, sourceChanged: 0 });
    expect(new JobQueueNerSubmitter(db).submitDeferredNer({ slug: page.slug }).disposition).toBe("inserted");
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
