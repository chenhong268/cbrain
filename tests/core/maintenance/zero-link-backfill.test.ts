import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  authorizeNerJobClaim,
  countCurrentGraphLinks,
  deriveZeroLinkSource,
  enqueueZeroLinkBackfill,
  finalizeRepairBatch,
  getNerJobProtection,
  getRepairBatchAttemptIdentity,
  loadZeroLinkSourceSnapshot,
  planZeroLinkBackfill,
  prepareRepairBatchJobIds,
  scanRichRecords,
  scanZeroLinkCandidates,
  snapshotRepairBatchJobIds,
  summarizeRepairBatch,
  toPublicZeroLinkCandidate,
  ZERO_LINK_BATCH_MANIFEST_JOB,
  ZERO_LINK_REPAIR_NAME,
} from "../../../src/core/maintenance/zero-link-backfill";
import { buildNerAttemptIdentity, CBrainDB } from "../../../src/storage/sqlite";

const testDir = "/tmp/cbrain-test-zero-link-backfill";
const dbPath = join(testDir, "brain.sqlite");
let db: CBrainDB;

function claimNerJob(id: number, expectedIdentity?: Exclude<ReturnType<typeof buildNerAttemptIdentity>, null>) {
  return db.claimNerJobByIdWithLease(id, expectedIdentity, authorizeNerJobClaim);
}

function addPage(slug: string, opts: { type?: string; hash?: string | null; chunks?: string[]; tags?: string[] } = {}): void {
  db.upsertPage({
    slug,
    type: opts.type ?? "record",
    title: slug,
    filePath: `${slug}.md`,
    ...(opts.hash === null ? {} : { contentHash: opts.hash ?? `hash-${slug}` }),
  });
  if (opts.hash === null) db.rawDb.prepare("UPDATE pages SET content_hash = NULL WHERE slug = ?").run(slug);
  for (const [index, content] of (opts.chunks ?? []).entries()) db.insertChunk(slug, index, content);
  db.addTags(slug, opts.tags ?? []);
}

function addLink(from: string, to: string, relation: string, trustState: string): void {
  db.rawDb.prepare(
    `INSERT INTO links (from_slug, to_slug, relation, trust_state)
     VALUES (?, ?, ?, ?)`,
  ).run(from, to, relation, trustState);
}

beforeEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  mkdirSync(testDir, { recursive: true });
  db = new CBrainDB(dbPath);
});

afterEach(() => {
  db.close();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("rich zero-link scanner (#342)", () => {
  test("uses the threshold union and only returns records", () => {
    addPage("records/by-chunks", { chunks: ["a", "b"] });
    addPage("records/by-chars", { chunks: ["x".repeat(1000)] });
    addPage("records/by-tags", { chunks: ["a"], tags: ["a", "b", "c"] });
    addPage("records/too-small", { chunks: ["a"], tags: ["a", "b"] });
    addPage("insights/not-a-record", { type: "insight", chunks: ["a", "b"] });

    expect(scanRichRecords(db).map((candidate) => candidate.slug)).toEqual([
      "records/by-chars",
      "records/by-chunks",
      "records/by-tags",
    ]);
  });

  test("excludes L1 summaries from richness and seals source selection", () => {
    addPage("records/sealed-small", { chunks: ["raw"] });
    db.insertChunkWithLevel("records/sealed-small", 0, "s".repeat(2000), 1, "summary-hash");
    expect(scanRichRecords(db)).toEqual([]);

    addPage("records/sealed-rich", { hash: "page-hash", chunks: ["first", "second"] });
    db.insertChunkWithLevel("records/sealed-rich", 0, "summary", 1, "summary-hash");
    const candidate = scanRichRecords(db)[0];
    expect(candidate.sourceKind).toBe("raw_chunks");
    expect(candidate.contentFingerprint).toMatch(/^derived:[0-9a-f]{64}$/);
    expect(candidate.contentFingerprint).not.toContain("page-hash");
  });

  test("uses current-fact non-self link semantics", () => {
    const cases = [
      ["rejected", "mentions", "rejected", true],
      ["superseded", "mentions", "superseded", true],
      ["candidate-hierarchy", "reports_to", "candidate", true],
      ["candidate-mention", "mentions", "candidate", false],
      ["trusted-hierarchy", "reports_to", "trusted", false],
    ] as const;
    addPage("entity/target", { type: "entity/person" });
    for (const [suffix, relation, trustState, remainsCandidate] of cases) {
      const slug = `records/${suffix}`;
      addPage(slug, { chunks: ["a", "b"] });
      addLink(slug, "entity/target", relation, trustState);
      expect(countCurrentGraphLinks(db, slug)).toBe(remainsCandidate ? 0 : 1);
    }
    addPage("records/self", { chunks: ["a", "b"] });
    addLink("records/self", "records/self", "mentions", "trusted");
    expect(countCurrentGraphLinks(db, "records/self")).toBe(0);

    expect(scanZeroLinkCandidates(db).map((candidate) => candidate.slug).sort()).toEqual([
      "records/candidate-hierarchy",
      "records/rejected",
      "records/self",
      "records/superseded",
    ]);
  });

  test("pre-aggregates dimensions and applies a deterministic post-order limit", () => {
    addPage("records/z", { chunks: ["1".repeat(600), "2".repeat(600)], tags: ["a", "b", "c"] });
    addPage("records/a", { chunks: ["1".repeat(600), "2".repeat(600)], tags: ["a", "b", "c"] });
    addPage("records/larger", { chunks: ["x".repeat(1300)] });

    const all = scanRichRecords(db);
    expect(all.map((candidate) => candidate.slug)).toEqual(["records/larger", "records/a", "records/z"]);
    expect(all.find((candidate) => candidate.slug === "records/a")).toMatchObject({
      rawChunkCount: 2,
      rawCharCount: 1200,
      tagCount: 3,
    });
    expect(scanZeroLinkCandidates(db, 2).map((candidate) => candidate.slug)).toEqual(["records/larger", "records/a"]);
  });
});

describe("source fingerprints (#342)", () => {
  test("uses a non-empty page hash for an unsealed page", () => {
    addPage("records/page", { hash: "abc123", chunks: ["one", "two"] });
    expect(deriveZeroLinkSource(db, "records/page")).toEqual({
      contentFingerprint: "page:abc123",
      sourceKind: "vault_hash",
    });
  });

  test("hashes canonical ordered raw chunks and sorted tags for sealed pages", () => {
    addPage("records/sealed", { hash: "ignored", chunks: ["line\nvalue", "x|y"] , tags: ["z", "a"] });
    db.insertChunkWithLevel("records/sealed", 0, "summary", 1, "summary-hash");
    const rows = db.rawDb.prepare(
      "SELECT id, chunk_index, content FROM chunks WHERE page_slug = ? AND summary_level = 0 ORDER BY chunk_index, id",
    ).all("records/sealed") as Array<{ id: number; chunk_index: number; content: string }>;
    const canonical = {
      version: 1,
      type: "record",
      chunks: rows.map((row) => ({ index: row.chunk_index, id: row.id, content: row.content })),
      tags: ["a", "z"],
    };
    const digest = createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
    expect(deriveZeroLinkSource(db, "records/sealed")).toEqual({
      contentFingerprint: `derived:${digest}`,
      sourceKind: "raw_chunks",
    });
  });

  test("returns no source when the selected source is unavailable", () => {
    addPage("records/no-source", { hash: null, tags: ["a", "b", "c"] });
    expect(deriveZeroLinkSource(db, "records/no-source")).toEqual({
      contentFingerprint: null,
      sourceKind: null,
    });
  });

  test("falls back to one raw-chunk snapshot when an unsealed page hash is absent", () => {
    addPage("records/raw-fallback", { hash: null, chunks: ["first", "second"], tags: ["tag-a"] });

    const snapshot = loadZeroLinkSourceSnapshot(db, "records/raw-fallback");

    expect(snapshot).toMatchObject({
      sourceKind: "raw_chunks",
      body: "first\n\nsecond",
      pageType: "record",
    });
    expect(snapshot.contentFingerprint).toMatch(/^derived:[0-9a-f]{64}$/);
    expect(deriveZeroLinkSource(db, "records/raw-fallback").contentFingerprint).toBe(snapshot.contentFingerprint);
  });

  test("public projection is scalar-only", () => {
    addPage("records/private-sentinel", { chunks: ["private-body", "second"] });
    const projected = toPublicZeroLinkCandidate(scanRichRecords(db)[0]);
    const json = JSON.stringify(projected);
    expect(projected).toEqual({ rawChunkCount: 2, rawCharCount: 18, tagCount: 0 });
    expect(json).not.toContain("private-sentinel");
    expect(json).not.toContain("private-body");
    expect(json).not.toContain("page:");
  });
});

describe("repair planning and atomic enqueue (#342)", () => {
  function addRich(slug = "records/item", hash = "fingerprint-a"): void {
    addPage(slug, { hash, chunks: ["first", "second"] });
  }

  test("plans and enqueues a bounded manifest-owned batch", () => {
    addRich("records/a");
    addRich("records/b");
    const dryRun = planZeroLinkBackfill(db, 1);
    expect(dryRun).toMatchObject({
      version: 1,
      mode: "dry_run",
      status: "ok",
      total: 2,
      actionable: 2,
      selected: 1,
      newJobs: 1,
      requeuedJobs: 0,
      queueIntegrityConflicts: 0,
      stateConflicts: 0,
    });
    expect(dryRun).not.toHaveProperty("batchId");

    const receipt = enqueueZeroLinkBackfill(db, 1);
    expect(receipt.mode).toBe("enqueue");
    expect(receipt.batchId).toMatch(/^[0-9a-f-]{36}$/);
    const jobs = db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all() as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(2);
    expect(jobs[0].name).toBe("ner-backfill");
    expect(jobs[0].status).toBe("pending");
    expect(jobs[0].max_attempts).toBe(1);
    const child = JSON.parse(String(jobs[0].data));
    expect(child).toMatchObject({
      slug: "records/a",
      kind: "ner",
      repair: { name: ZERO_LINK_REPAIR_NAME, version: 1, batchId: receipt.batchId },
    });
    expect(jobs[1].name).toBe(ZERO_LINK_BATCH_MANIFEST_JOB);
    expect(jobs[1].status).toBe("done");
    const manifest = JSON.parse(String(jobs[1].data));
    expect(manifest.ownership).toEqual([{
      jobId: jobs[0].id,
      slug: "records/a",
      contentFingerprint: "page:fingerprint-a",
    }]);
    expect(JSON.parse(String(jobs[1].result))).toEqual({ finalized: false });
  });

  test("repeat planning is idempotent while the batch is active", () => {
    addRich();
    enqueueZeroLinkBackfill(db, 1);
    expect(planZeroLinkBackfill(db, 1)).toMatchObject({
      status: "ok",
      actionable: 0,
      selected: 0,
      active: 1,
    });
    const before = Number((db.rawDb.prepare("SELECT COUNT(*) count FROM jobs").get() as { count: number }).count);
    expect(enqueueZeroLinkBackfill(db, 1)).toMatchObject({ selected: 0, active: 1 });
    const after = Number((db.rawDb.prepare("SELECT COUNT(*) count FROM jobs").get() as { count: number }).count);
    expect(after).toBe(before);
  });

  test("malformed live NER state blocks globally with zero writes", () => {
    addRich();
    db.rawDb.prepare("INSERT INTO jobs (name, status, data) VALUES ('ner-backfill','pending','{')").run();
    const before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());
    expect(planZeroLinkBackfill(db, 1)).toMatchObject({ status: "blocked", queueIntegrityConflicts: 1 });
    expect(enqueueZeroLinkBackfill(db, 1)).toMatchObject({ status: "blocked", queueIntegrityConflicts: 1 });
    expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
  });

  test("a marked row without its manifest is an integrity conflict", () => {
    addRich();
    db.submitJob("ner-backfill", {
      slug: "records/item",
      kind: "ner",
      contentHash: "fingerprint-a",
      repair: {
        name: ZERO_LINK_REPAIR_NAME,
        version: 1,
        contentFingerprint: "page:fingerprint-a",
        sourceKind: "vault_hash",
        batchId: "11111111-1111-4111-8111-111111111111",
      },
    });
    expect(planZeroLinkBackfill(db)).toMatchObject({ status: "blocked", queueIntegrityConflicts: 1 });
  });

  test("a legacy terminal row is requeued in-place and included in ownership", () => {
    addRich();
    const jobId = db.submitJob("ner-backfill", { slug: "records/item" });
    db.rawDb.prepare("UPDATE jobs SET status='done', result='{}', finished_at=datetime('now') WHERE id=?").run(jobId);
    expect(planZeroLinkBackfill(db, 1)).toMatchObject({ actionable: 1, requeuedJobs: 1, newJobs: 0 });
    const receipt = enqueueZeroLinkBackfill(db, 1);
    const row = db.getJob(jobId)!;
    expect(row).toMatchObject({ status: "pending", attempts: 0, max_attempts: 1, result: null, error: null });
    expect(JSON.parse(row.data!).repair.batchId).toBe(receipt.batchId);
  });

  test("an unverifiable candidate is visible but not actionable", () => {
    addPage("records/no-source", { hash: null, tags: ["a", "b", "c"] });
    expect(planZeroLinkBackfill(db, 10)).toMatchObject({
      total: 1,
      actionable: 0,
      selected: 0,
      unverifiableFingerprint: 1,
    });
  });

  test("recognizes the sanctioned old-running/current-pending transition pair", () => {
    addRich();
    const predecessor = db.submitJob("ner-backfill", {
      slug: "records/item",
      kind: "ner",
      contentHash: "fingerprint-old",
      sourceFingerprint: "page:fingerprint-old",
    });
    claimNerJob(predecessor);
    const successor = db.submitJob("ner-backfill", {
      slug: "records/item",
      kind: "ner",
      contentHash: "fingerprint-a",
      sourceFingerprint: "page:fingerprint-a",
    });
    expect(planZeroLinkBackfill(db)).toMatchObject({ active: 1, staleRunning: 0, stateConflicts: 0, actionable: 0 });
    let before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());
    expect(claimNerJob(successor)).toBeNull();
    expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
    db.rawDb.prepare("UPDATE jobs SET started_at=datetime('now','-31 minutes') WHERE id=?").run(predecessor);
    expect(planZeroLinkBackfill(db)).toMatchObject({ active: 1, staleRunning: 1, stateConflicts: 0, actionable: 0 });
    before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());
    expect(claimNerJob(successor)).toBeNull();
    expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
  });

  test("a committing predecessor also keeps its sanctioned successor frozen", () => {
    addRich();
    const predecessor = db.submitJob("ner-backfill", {
      slug: "records/item", kind: "ner", contentHash: "fingerprint-old", sourceFingerprint: "page:fingerprint-old",
    });
    const claimed = claimNerJob(predecessor)!;
    expect(db.moveNerLeaseToCommitting(predecessor, claimed.leaseToken, claimed.payloadDigest)).toBe(true);
    const successor = db.submitJob("ner-backfill", {
      slug: "records/item", kind: "ner", contentHash: "fingerprint-a", sourceFingerprint: "page:fingerprint-a",
    });
    const before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());

    expect(planZeroLinkBackfill(db)).toMatchObject({ status: "ok", active: 1, stateConflicts: 0 });
    expect(claimNerJob(successor)).toBeNull();
    expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
  });

  test("same-slug entity-facts work does not impersonate a NER predecessor", () => {
    addRich();
    db.submitJob("ner-backfill", { slug: "records/item", kind: "entity_facts" });
    const nerId = db.submitJob("ner-backfill", {
      slug: "records/item", kind: "ner", contentHash: "fingerprint-a", sourceFingerprint: "page:fingerprint-a",
    });

    expect(planZeroLinkBackfill(db)).toMatchObject({ status: "ok", active: 1, stateConflicts: 0 });
    expect(claimNerJob(nerId)).not.toBeNull();
  });

  test("legacy live rows with only historical caller contentHash remain compatible", () => {
    addRich();
    const jobId = db.submitJob("ner-backfill", {
      slug: "records/item",
      kind: "ner",
      contentHash: "legacy-caller-hash",
    });

    expect(planZeroLinkBackfill(db)).toMatchObject({
      status: "ok",
      active: 1,
      actionable: 0,
      stateConflicts: 0,
      queueIntegrityConflicts: 0,
    });
    expect(claimNerJob(jobId)).not.toBeNull();
  });

  test("governed live rows with missing or mismatched hashes block plan and direct claim", () => {
    const cases = [
      {
        slug: "records/missing-hash",
        data: { slug: "records/missing-hash", kind: "ner", sourceFingerprint: "page:fingerprint-missing" },
      },
      {
        slug: "records/wrong-hash",
        data: {
          slug: "records/wrong-hash",
          kind: "ner",
          pageContentHash: "wrong",
          sourceFingerprint: "page:fingerprint-wrong",
        },
      },
    ];
    const ids: number[] = [];
    for (const item of cases) {
      addRich(item.slug, item.slug.endsWith("missing-hash") ? "fingerprint-missing" : "fingerprint-wrong");
      ids.push(db.submitJob("ner-backfill", item.data));
    }
    const before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());

    expect(planZeroLinkBackfill(db)).toMatchObject({ status: "blocked", stateConflicts: 2, selected: 0 });
    for (const id of ids) expect(claimNerJob(id)).toBeNull();
    expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
  });

  test("own invalid identity fields never fall back to legacy claim semantics", () => {
    const cases = [
      { slug: "records/page-only", pageContentHash: "fingerprint-page-only" },
      { slug: "records/null-source", contentHash: "legacy", sourceFingerprint: null },
      { slug: "records/number-source", contentHash: "legacy", sourceFingerprint: 7 },
      { slug: "records/object-source", contentHash: "legacy", sourceFingerprint: { value: "page:x" } },
      { slug: "records/mismatched-source-kind", contentHash: "legacy", sourceFingerprint: "page:hash-a", sourceKind: "raw_chunks" },
    ];
    const ids: number[] = [];
    for (const item of cases) {
      addRich(item.slug, item.slug.slice("records/".length));
      ids.push(db.submitJob("ner-backfill", { kind: "ner", ...item }));
    }
    const before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());

    expect(planZeroLinkBackfill(db)).toMatchObject({ status: "blocked", stateConflicts: 5, selected: 0 });
    for (const id of ids) expect(claimNerJob(id)).toBeNull();
    expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
  });

  test("pending rows with valid or malformed residual leases cannot be reclaimed", () => {
    addRich();
    for (const malformed of [false, true]) {
      const id = db.submitJob("ner-backfill", {
        slug: "records/item", kind: "ner", contentHash: "fingerprint-a", sourceFingerprint: "page:fingerprint-a",
        ...(malformed ? { attemptLease: {} } : {}),
      });
      if (!malformed) {
        expect(claimNerJob(id)).not.toBeNull();
        db.rawDb.prepare("UPDATE jobs SET status='pending' WHERE id=?").run(id);
      }
      const before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());

      expect(planZeroLinkBackfill(db)).toMatchObject({ status: "blocked", selected: 0 });
      expect(claimNerJob(id)).toBeNull();
      expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
      db.rawDb.prepare("DELETE FROM jobs").run();
    }
  });

  test("canonical manifest audit blocks every malformed or orphan claim shape", () => {
    addRich();
    const batchId = "55555555-5555-4555-8555-555555555555";
    const ownership = [{ jobId: 999, slug: "records/item", contentFingerprint: "page:fingerprint-a" }];
    const validManifest = { version: 1, repairName: ZERO_LINK_REPAIR_NAME, batchId, ownership };
    const malformedManifestCases = [
      () => db.submitJob("other-job", validManifest),
      () => db.submitJob(ZERO_LINK_BATCH_MANIFEST_JOB, validManifest),
      () => db.rawDb.prepare(
        `INSERT INTO jobs (name,status,data,result,finished_at) VALUES (?, 'done', ?, ?, datetime('now'))`,
      ).run(ZERO_LINK_BATCH_MANIFEST_JOB, JSON.stringify({ ownership: [] }), JSON.stringify({ finalized: false })),
    ];
    for (const insertMalformed of malformedManifestCases) {
      insertMalformed();
      const target = db.submitJob("ner-backfill", {
        slug: "records/item", kind: "ner", contentHash: "fingerprint-a", sourceFingerprint: "page:fingerprint-a",
      });
      const before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());

      expect(planZeroLinkBackfill(db)).toMatchObject({ status: "blocked", selected: 0 });
      expect(claimNerJob(target)).toBeNull();
      expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
      db.rawDb.prepare("DELETE FROM jobs").run();
    }

    const orphan = db.submitJob("ner-backfill", {
      slug: "records/item",
      kind: "ner",
      contentHash: "fingerprint-a",
      repair: {
        name: ZERO_LINK_REPAIR_NAME,
        version: 1,
        contentFingerprint: "page:fingerprint-a",
        sourceKind: "vault_hash",
        batchId,
      },
    });
    const before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());
    expect(planZeroLinkBackfill(db)).toMatchObject({ status: "blocked", queueIntegrityConflicts: 1, selected: 0 });
    expect(claimNerJob(orphan)).toBeNull();
    expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
  });

  test("duplicate batch tokens fail closed for exact and case-variant UUID text", () => {
    addRich("records/first", "first");
    addRich("records/second", "second");
    addRich("records/target", "target");
    const canonicalBatchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    for (const secondBatchId of [canonicalBatchId, canonicalBatchId.toUpperCase()]) {
      for (const [slug, fingerprint, batchId] of [
        ["records/first", "page:first", canonicalBatchId],
        ["records/second", "page:second", secondBatchId],
      ] as const) {
        const repair = {
          name: ZERO_LINK_REPAIR_NAME, version: 1, contentFingerprint: fingerprint, sourceKind: "vault_hash", batchId,
        };
        const childId = db.submitJob("ner-backfill", {
          slug, kind: "ner", contentHash: fingerprint.slice(5), repair,
        }, 1);
        db.rawDb.prepare(
          `INSERT INTO jobs (name,status,priority,data,result,attempts,max_attempts,finished_at)
           VALUES (?, 'done', 0, ?, ?, 0, 1, datetime('now'))`,
        ).run(
          ZERO_LINK_BATCH_MANIFEST_JOB,
          JSON.stringify({
            version: 1,
            repairName: ZERO_LINK_REPAIR_NAME,
            batchId,
            ownership: [{ jobId: childId, slug, contentFingerprint: fingerprint }],
          }),
          JSON.stringify({ finalized: false }),
        );
      }
      const target = db.submitJob("ner-backfill", {
        slug: "records/target", kind: "ner", contentHash: "target", sourceFingerprint: "page:target",
      });
      const before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());

      expect(planZeroLinkBackfill(db)).toMatchObject({ status: "blocked", selected: 0 });
      expect(claimNerJob(target)).toBeNull();
      expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
      db.rawDb.prepare("DELETE FROM jobs").run();
    }
  });

  test("a new legacy live row after finalized repair is a conflict and cannot be claimed", () => {
    addRich();
    const receipt = enqueueZeroLinkBackfill(db, 1);
    const child = db.rawDb.prepare("SELECT id,data FROM jobs WHERE name='ner-backfill'").get() as { id: number; data: string };
    const repair = JSON.parse(child.data).repair;
    db.rawDb.prepare("UPDATE jobs SET status='done', result=?, finished_at=datetime('now') WHERE id=?")
      .run(JSON.stringify({ outcome: "processed", kind: "ner", repair, graphOutcome: "terminal_no_graph_links", activeLinkCount: 0 }), child.id);
    expect(finalizeRepairBatch(db, receipt.batchId!)).toMatchObject({ finalized: true });
    const legacyId = db.submitJob("ner-backfill", { slug: "records/item", kind: "ner", contentHash: "caller-historical" });
    const before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());

    expect(planZeroLinkBackfill(db)).toMatchObject({ status: "blocked", stateConflicts: 1, selected: 0 });
    expect(enqueueZeroLinkBackfill(db, 1)).toMatchObject({ status: "blocked", selected: 0 });
    expect(claimNerJob(legacyId)).toBeNull();
    expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
  });

  test("a finalized repair child changed to commit-unknown freezes an unrelated direct claim", () => {
    addRich("records/repaired", "fingerprint-repaired");
    const receipt = enqueueZeroLinkBackfill(db, 1);
    const child = db.rawDb.prepare("SELECT id,data FROM jobs WHERE name='ner-backfill'").get() as { id: number; data: string };
    const repair = JSON.parse(child.data).repair;
    db.rawDb.prepare("UPDATE jobs SET status='done', result=?, finished_at=datetime('now') WHERE id=?")
      .run(JSON.stringify({ outcome: "processed", kind: "ner", repair, graphOutcome: "terminal_no_graph_links", activeLinkCount: 0 }), child.id);
    expect(finalizeRepairBatch(db, receipt.batchId!)).toMatchObject({ finalized: true });
    db.rawDb.prepare("UPDATE jobs SET result=? WHERE id=?")
      .run(JSON.stringify({ outcome: "commit_unknown", kind: "ner", repair }), child.id);

    addRich("records/unrelated", "fingerprint-unrelated");
    const target = db.submitJob("ner-backfill", {
      slug: "records/unrelated",
      kind: "ner",
      contentHash: "fingerprint-unrelated",
      sourceFingerprint: "page:fingerprint-unrelated",
    });
    const before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());

    expect(planZeroLinkBackfill(db)).toMatchObject({ status: "blocked", queueIntegrityConflicts: 1, selected: 0 });
    expect(claimNerJob(target)).toBeNull();
    expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
  });

  test("a finalized done ledger cannot encode a null graph outcome", () => {
    addRich("records/repaired", "fingerprint-repaired");
    const receipt = enqueueZeroLinkBackfill(db, 1);
    const child = db.rawDb.prepare("SELECT id,data FROM jobs WHERE name='ner-backfill'").get() as { id: number; data: string };
    const repair = JSON.parse(child.data).repair;
    db.rawDb.prepare("UPDATE jobs SET status='done', result=?, finished_at=datetime('now') WHERE id=?")
      .run(JSON.stringify({ outcome: "processed", kind: "ner", repair, graphOutcome: "terminal_no_graph_links", activeLinkCount: 0 }), child.id);
    finalizeRepairBatch(db, receipt.batchId!);
    const manifest = db.rawDb.prepare("SELECT id,data,result FROM jobs WHERE name=?").get(ZERO_LINK_BATCH_MANIFEST_JOB) as {
      id: number; data: string; result: string;
    };
    const manifestData = JSON.parse(manifest.data);
    manifestData.finalizedEntries[0].graphOutcome = null;
    manifestData.ledgerDigest = createHash("sha256").update(JSON.stringify({
      version: 1,
      batchId: receipt.batchId,
      entries: manifestData.finalizedEntries,
    }), "utf8").digest("hex");
    const manifestResult = JSON.parse(manifest.result);
    manifestResult.outcomes.terminalNoGraphLinks = 0;
    db.rawDb.prepare("UPDATE jobs SET data=?,result=? WHERE id=?")
      .run(JSON.stringify(manifestData), JSON.stringify(manifestResult), manifest.id);

    addRich("records/unrelated", "fingerprint-unrelated");
    const target = db.submitJob("ner-backfill", {
      slug: "records/unrelated", kind: "ner", contentHash: "fingerprint-unrelated", sourceFingerprint: "page:fingerprint-unrelated",
    });
    const before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());

    expect(planZeroLinkBackfill(db)).toMatchObject({ status: "blocked", selected: 0 });
    expect(claimNerJob(target)).toBeNull();
    expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
  });

  test("a finalized manifest cannot own the same slug through two child ids", () => {
    addRich("records/repaired", "fingerprint-repaired");
    addRich("records/unrelated", "fingerprint-unrelated");
    for (const [batchId, secondFingerprint] of [
      ["66666666-6666-4666-8666-666666666666", "page:fingerprint-repaired"],
      ["77777777-7777-4777-8777-777777777777", "page:different-fingerprint"],
    ] as const) {
      const fingerprints = ["page:fingerprint-repaired", secondFingerprint];
      const children = fingerprints.map((contentFingerprint) => {
        const repair = {
          name: ZERO_LINK_REPAIR_NAME, version: 1, contentFingerprint, sourceKind: "vault_hash", batchId,
        };
        const id = db.submitJob("ner-backfill", {
          slug: "records/repaired", kind: "ner", contentHash: contentFingerprint.slice(5), repair,
        }, 1);
        db.rawDb.prepare("UPDATE jobs SET status='done', result=?, finished_at=datetime('now') WHERE id=?")
          .run(JSON.stringify({ outcome: "processed", kind: "ner", repair, graphOutcome: "terminal_no_graph_links", activeLinkCount: 0 }), id);
        return { id, contentFingerprint };
      });
      const ownership = children.map(({ id: jobId, contentFingerprint }) => ({
        jobId, slug: "records/repaired", contentFingerprint,
      }));
      const finalizedEntries = ownership.map((owner) => ({
        ...owner, terminalStatus: "done", graphOutcome: "terminal_no_graph_links",
      }));
      const ledgerDigest = createHash("sha256").update(JSON.stringify({
        version: 1, batchId, entries: finalizedEntries,
      }), "utf8").digest("hex");
      db.rawDb.prepare(
        `INSERT INTO jobs (name,status,priority,data,result,attempts,max_attempts,finished_at)
         VALUES (?, 'done', 0, ?, ?, 0, 1, datetime('now'))`,
      ).run(
        ZERO_LINK_BATCH_MANIFEST_JOB,
        JSON.stringify({ version: 1, repairName: ZERO_LINK_REPAIR_NAME, batchId, ownership, finalizedEntries, ledgerDigest }),
        JSON.stringify({
          finalized: true,
          version: 1,
          statusCounts: { done: 2, failed: 0, cancelled: 0 },
          outcomes: { resolved: 0, terminalNoGraphLinks: 2, blockedSourceUnavailable: 0, sourceChanged: 0, invalidTerminal: 0, commitUnknown: 0 },
          completedAt: new Date().toISOString(),
        }),
      );
      const target = db.submitJob("ner-backfill", {
        slug: "records/unrelated", kind: "ner", contentHash: "fingerprint-unrelated", sourceFingerprint: "page:fingerprint-unrelated",
      });
      const before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());

      expect(planZeroLinkBackfill(db)).toMatchObject({ status: "blocked", selected: 0 });
      expect(claimNerJob(target)).toBeNull();
      expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
      db.rawDb.prepare("DELETE FROM jobs").run();
    }
  });

  test("a pre-manifest legacy shadow remains protected and unclaimable", () => {
    addRich();
    const shadowId = db.submitJob("ner-backfill", {
      slug: "records/item",
      kind: "ner",
      contentHash: "caller-historical",
    });
    const batchId = "44444444-4444-4444-8444-444444444444";
    const repair = {
      name: ZERO_LINK_REPAIR_NAME,
      version: 1,
      contentFingerprint: "page:fingerprint-a",
      sourceKind: "vault_hash",
      batchId,
    };
    const childId = db.submitJob("ner-backfill", {
      slug: "records/item",
      kind: "ner",
      contentHash: "fingerprint-a",
      repair,
    }, 1);
    db.rawDb.prepare("UPDATE jobs SET status='done', result=?, finished_at=datetime('now') WHERE id=?")
      .run(JSON.stringify({ outcome: "processed", kind: "ner", repair, graphOutcome: "terminal_no_graph_links", activeLinkCount: 0 }), childId);
    db.rawDb.prepare(
      `INSERT INTO jobs (name,status,priority,data,result,attempts,max_attempts,finished_at)
       VALUES (?, 'done', 0, ?, ?, 0, 1, datetime('now'))`,
    ).run(
      ZERO_LINK_BATCH_MANIFEST_JOB,
      JSON.stringify({
        version: 1,
        repairName: ZERO_LINK_REPAIR_NAME,
        batchId,
        ownership: [{ jobId: childId, slug: "records/item", contentFingerprint: "page:fingerprint-a" }],
      }),
      JSON.stringify({ finalized: false }),
    );
    expect(finalizeRepairBatch(db, batchId)).toMatchObject({ finalized: true });
    const before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());

    expect(planZeroLinkBackfill(db)).toMatchObject({ status: "ok", active: 1, stateConflicts: 0 });
    expect(getNerJobProtection(db).protectedJobIds.has(shadowId)).toBe(true);
    expect(claimNerJob(shadowId)).toBeNull();
    expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
  });

  test("blocks residual leases outside running state", () => {
    for (const [slug, status] of [["records/pending-lease", "pending"], ["records/done-lease", "done"]] as const) {
      addRich(slug);
      const id = db.submitJob("ner-backfill", {
        slug,
        kind: "ner",
        contentHash: `fingerprint-${status}`,
        sourceFingerprint: `page:fingerprint-${status}`,
      });
      claimNerJob(id);
      db.rawDb.prepare("UPDATE jobs SET status=?, finished_at=CASE WHEN ?='done' THEN datetime('now') ELSE NULL END WHERE id=?")
        .run(status, status, id);
    }

    expect(planZeroLinkBackfill(db)).toMatchObject({ status: "blocked", stateConflicts: 2, selected: 0 });
  });

  test("zero-LLM audit rows neither own an epoch nor conflict with real processed evidence", () => {
    addRich();
    db.submitJob("ner-backfill", {
      slug: "records/item",
      kind: "ner",
      contentHash: "fingerprint-a",
      sourceFingerprint: "page:fingerprint-a",
    });
    db.rawDb.prepare("UPDATE jobs SET status='done', result=?, finished_at=datetime('now') WHERE id=1")
      .run(JSON.stringify({ outcome: "skipped", kind: "ner", reason: "SOURCE_CHANGED", graphOutcome: "source_changed" }));

    expect(planZeroLinkBackfill(db, 1)).toMatchObject({
      status: "ok",
      actionable: 1,
      selected: 1,
      newJobs: 1,
      invalidTerminal: 0,
      stateConflicts: 0,
    });

    const processed = db.submitJob("ner-backfill", {
      slug: "records/item",
      kind: "ner",
      contentHash: "fingerprint-a",
      sourceFingerprint: "page:fingerprint-a",
    });
    db.rawDb.prepare("UPDATE jobs SET status='done', result=?, finished_at=datetime('now') WHERE id=?")
      .run(JSON.stringify({ outcome: "processed", kind: "ner" }), processed);
    expect(planZeroLinkBackfill(db, 1)).toMatchObject({
      status: "ok",
      terminalNoGraphLinks: 1,
      stateConflicts: 0,
    });
  });

  test("incomplete commit-unknown debt blocks repair and direct claims without mutation", () => {
    const cases = [
      { slug: "records/missing-both", data: { slug: "records/missing-both", kind: "ner" }, result: { outcome: "commit_unknown", kind: "ner" } },
      { slug: "records/missing-hash", data: { slug: "records/missing-hash", kind: "ner", sourceFingerprint: "page:fingerprint-a" }, result: { outcome: "commit_unknown", kind: "ner" } },
      { slug: "records/bad-derived", data: { slug: "records/bad-derived", kind: "ner", pageContentHash: null, sourceFingerprint: "derived:bad" }, result: { outcome: "commit_unknown", kind: "ner" } },
      { slug: "records/missing-kind", data: { slug: "records/missing-kind", kind: "ner", pageContentHash: "fingerprint-a", sourceFingerprint: "page:fingerprint-a" }, result: { outcome: "commit_unknown" } },
      { slug: "records/extra-result", data: { slug: "records/extra-result", kind: "ner", pageContentHash: "fingerprint-a", sourceFingerprint: "page:fingerprint-a" }, result: { outcome: "commit_unknown", kind: "ner", extra: true } },
    ];
    for (const item of cases) {
      addRich(item.slug);
      const id = db.submitJob("ner-backfill", item.data);
      db.rawDb.prepare("UPDATE jobs SET status='done', result=?, finished_at=datetime('now') WHERE id=?")
        .run(JSON.stringify(item.result), id);
    }
    addRich("records/successor");
    const successor = db.submitJob("ner-backfill", {
      slug: "records/successor", kind: "ner", pageContentHash: "fingerprint-a", sourceFingerprint: "page:fingerprint-a",
    });
    const frozen = buildNerAttemptIdentity(JSON.parse(db.getJob(successor)!.data!))!;
    const before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());

    const plan = planZeroLinkBackfill(db, 10);
    expect(plan.status).toBe("blocked");
    expect(plan.queueIntegrityConflicts).toBeGreaterThanOrEqual(5);
    expect(enqueueZeroLinkBackfill(db, 10)).toMatchObject({ status: "blocked", selected: 0 });
    expect(claimNerJob(successor, frozen)).toBeNull();
    expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
  });

  test("ordinary processed evidence with a link does not inflate repair resolved", () => {
    addRich();
    addPage("entity/target", { type: "entity/person" });
    const id = db.submitJob("ner-backfill", {
      slug: "records/item",
      kind: "ner",
      contentHash: "fingerprint-a",
      sourceFingerprint: "page:fingerprint-a",
    });
    db.rawDb.prepare("UPDATE jobs SET status='done', result=?, finished_at=datetime('now') WHERE id=?")
      .run(JSON.stringify({ outcome: "processed", kind: "ner" }), id);
    addLink("records/item", "entity/target", "mentions", "trusted");

    expect(planZeroLinkBackfill(db)).toMatchObject({ total: 0, resolved: 0 });
  });

  test("filtered preparation is zero-write when any unrelated live state conflicts", () => {
    addRich();
    const receipt = enqueueZeroLinkBackfill(db, 1);
    const child = db.rawDb.prepare("SELECT id FROM jobs WHERE name='ner-backfill'").get() as { id: number };
    getRepairBatchAttemptIdentity(db, receipt.batchId!, child.id);
    const childData = JSON.parse(db.getJob(child.id)!.data!);
    claimNerJob(child.id, buildNerAttemptIdentity(childData)!);
    db.rawDb.prepare("UPDATE jobs SET started_at=datetime('now','-31 minutes') WHERE id=?").run(child.id);
    addRich("records/conflict", "fingerprint-conflict");
    for (let i = 0; i < 2; i++) {
      db.submitJob("ner-backfill", {
        slug: "records/conflict",
        kind: "ner",
        contentHash: "fingerprint-conflict",
        sourceFingerprint: "page:fingerprint-conflict",
      });
    }
    const before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());

    expect(() => prepareRepairBatchJobIds(db, receipt.batchId!, 1, 30 * 60 * 1000)).toThrow("BATCH_INTEGRITY_CONFLICT");
    expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
  });

  test("filtered preparation rejects a wrong-hash ordinary successor on a non-rich page", () => {
    addRich();
    const receipt = enqueueZeroLinkBackfill(db, 1);
    const repairChild = db.rawDb.prepare("SELECT id FROM jobs WHERE name='ner-backfill'").get() as { id: number };
    const repairClaim = claimNerJob(
      repairChild.id,
      buildNerAttemptIdentity(JSON.parse(db.getJob(repairChild.id)!.data!))!,
    )!;
    db.rawDb.prepare("UPDATE jobs SET started_at=datetime('now','-31 minutes') WHERE id=?").run(repairChild.id);

    addPage("records/non-rich", { hash: "current-hash", chunks: ["small"] });
    const predecessor = db.submitJob("ner-backfill", {
      slug: "records/non-rich",
      kind: "ner",
      pageContentHash: "old-hash",
      sourceFingerprint: "page:old-hash",
    });
    claimNerJob(predecessor);
    db.submitJob("ner-backfill", {
      slug: "records/non-rich",
      kind: "ner",
      pageContentHash: "wrong-hash",
      sourceFingerprint: "page:current-hash",
    });
    const before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());

    expect(() => prepareRepairBatchJobIds(db, receipt.batchId!, 1, 30 * 60 * 1000)).toThrow("BATCH_INTEGRITY_CONFLICT");
    expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
    expect(db.validateNerJobLease(repairChild.id, repairClaim.leaseToken, "claimed", repairClaim.payloadDigest)).toBe(true);
  });

  test("overlapping unfinalized manifests fail closed without touching their shared child", () => {
    addRich();
    const first = enqueueZeroLinkBackfill(db, 1);
    const child = db.rawDb.prepare("SELECT id FROM jobs WHERE name='ner-backfill'").get() as { id: number };
    const firstManifest = db.rawDb.prepare("SELECT data FROM jobs WHERE name=?").get(ZERO_LINK_BATCH_MANIFEST_JOB) as { data: string };
    const overlapping = JSON.parse(firstManifest.data);
    overlapping.batchId = "22222222-2222-4222-8222-222222222222";
    expect(claimNerJob(child.id, buildNerAttemptIdentity(JSON.parse(db.getJob(child.id)!.data!))!)).not.toBeNull();
    const childData = JSON.parse(db.getJob(child.id)!.data!);
    childData.repair.batchId = overlapping.batchId;
    const { attemptLease, ...payload } = childData;
    attemptLease.batchId = overlapping.batchId;
    attemptLease.payloadDigest = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
    db.rawDb.prepare("UPDATE jobs SET data=?, started_at=datetime('now','-31 minutes') WHERE id=?")
      .run(JSON.stringify({ ...payload, attemptLease }), child.id);
    db.rawDb.prepare(
      `INSERT INTO jobs (name,status,priority,data,result,attempts,max_attempts,finished_at)
       VALUES (?, 'done', 0, ?, ?, 0, 1, datetime('now'))`,
    ).run(ZERO_LINK_BATCH_MANIFEST_JOB, JSON.stringify(overlapping), JSON.stringify({ finalized: false }));
    const before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());

    expect(planZeroLinkBackfill(db)).toMatchObject({ status: "blocked", queueIntegrityConflicts: 2, selected: 0 });
    expect(() => prepareRepairBatchJobIds(db, first.batchId!, 1, 30 * 60 * 1000)).toThrow("BATCH_INTEGRITY_CONFLICT");
    expect(() => getRepairBatchAttemptIdentity(db, first.batchId!, child.id)).toThrow("BATCH_INTEGRITY_CONFLICT");
    expect(() => finalizeRepairBatch(db, first.batchId!)).toThrow("BATCH_INTEGRITY_CONFLICT");
    expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
  });

  test("different children cannot give two unfinalized manifests the same slug", () => {
    addRich();
    const first = enqueueZeroLinkBackfill(db, 1);
    const firstChild = db.rawDb.prepare("SELECT id,data FROM jobs WHERE name='ner-backfill'").get() as { id: number; data: string };
    const secondBatch = "33333333-3333-4333-8333-333333333333";
    const secondData = JSON.parse(firstChild.data);
    secondData.repair.batchId = secondBatch;
    const secondChild = db.submitJob("ner-backfill", secondData, 1);
    const owner = { jobId: secondChild, slug: "records/item", contentFingerprint: "page:fingerprint-a" };
    db.rawDb.prepare(
      `INSERT INTO jobs (name,status,priority,data,result,attempts,max_attempts,finished_at)
       VALUES (?, 'done', 0, ?, ?, 0, 1, datetime('now'))`,
    ).run(
      ZERO_LINK_BATCH_MANIFEST_JOB,
      JSON.stringify({ version: 1, repairName: ZERO_LINK_REPAIR_NAME, batchId: secondBatch, ownership: [owner] }),
      JSON.stringify({ finalized: false }),
    );
    const before = JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());

    expect(planZeroLinkBackfill(db)).toMatchObject({ status: "blocked", queueIntegrityConflicts: 1 });
    expect(() => snapshotRepairBatchJobIds(db, first.batchId!, 1)).toThrow("BATCH_INTEGRITY_CONFLICT");
    expect(() => prepareRepairBatchJobIds(db, first.batchId!, 1, 30 * 60 * 1000)).toThrow("BATCH_INTEGRITY_CONFLICT");
    expect(() => getRepairBatchAttemptIdentity(db, first.batchId!, firstChild.id)).toThrow("BATCH_INTEGRITY_CONFLICT");
    expect(() => finalizeRepairBatch(db, first.batchId!)).toThrow("BATCH_INTEGRITY_CONFLICT");
    expect(() => finalizeRepairBatch(db, secondBatch)).toThrow("BATCH_INTEGRITY_CONFLICT");
    expect(JSON.stringify(db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
  });

  test("counts commit-unknown globally even without a zero-link candidate", () => {
    addPage("records/linked", { chunks: ["a", "b"] });
    addPage("entity/target", { type: "entity/person" });
    addLink("records/linked", "entity/target", "mentions", "trusted");
    const id = db.submitJob("ner-backfill", {
      slug: "records/linked",
      kind: "ner",
      contentHash: "hash-records/linked",
      sourceFingerprint: "page:hash-records/linked",
    });
    db.rawDb.prepare("UPDATE jobs SET status='done', result=? WHERE id=?").run(JSON.stringify({ outcome: "commit_unknown" }), id);
    expect(planZeroLinkBackfill(db)).toMatchObject({ total: 0, commitUnknown: 1 });
  });

  test("counts a finalized current-success page after it gains a graph link", () => {
    addRich();
    addPage("entity/target", { type: "entity/person" });
    const receipt = enqueueZeroLinkBackfill(db, 1);
    const child = db.rawDb.prepare("SELECT id, data FROM jobs WHERE name='ner-backfill'").get() as { id: number; data: string };
    const repair = JSON.parse(child.data).repair;
    db.rawDb.prepare("UPDATE jobs SET status='done', result=?, finished_at=datetime('now') WHERE id=?")
      .run(JSON.stringify({ outcome: "processed", kind: "ner", repair, graphOutcome: "resolved", activeLinkCount: 1 }), child.id);
    addLink("records/item", "entity/target", "mentions", "trusted");
    expect(finalizeRepairBatch(db, receipt.batchId!)).toMatchObject({ finalized: true, outcomes: { resolved: 1 } });

    expect(planZeroLinkBackfill(db)).toMatchObject({ total: 0, resolved: 1 });
  });

  test("keeps resolved and lost-link history distinct across linked and zero-link pages", () => {
    addRich("records/resolved", "fingerprint-resolved");
    addRich("records/lost", "fingerprint-lost");
    addPage("entity/target", { type: "entity/person" });
    const receipt = enqueueZeroLinkBackfill(db, 2);
    const children = db.rawDb.prepare("SELECT id, data FROM jobs WHERE name='ner-backfill' ORDER BY id").all() as Array<{ id: number; data: string }>;
    for (const child of children) {
      const data = JSON.parse(child.data);
      db.rawDb.prepare("UPDATE jobs SET status='done', result=?, finished_at=datetime('now') WHERE id=?")
        .run(JSON.stringify({ outcome: "processed", kind: "ner", repair: data.repair, graphOutcome: "resolved", activeLinkCount: 1 }), child.id);
      addLink(data.slug, "entity/target", "mentions", "trusted");
    }
    finalizeRepairBatch(db, receipt.batchId!);
    db.rawDb.prepare("UPDATE links SET trust_state='rejected' WHERE from_slug='records/lost'").run();

    expect(planZeroLinkBackfill(db)).toMatchObject({ total: 1, resolved: 1, lostLink: 1 });
  });

  test("a corrupt latest finalized child blocks planning and preserves manifest counts", () => {
    addRich();
    const receipt = enqueueZeroLinkBackfill(db, 1);
    const child = db.rawDb.prepare("SELECT id, data FROM jobs WHERE name='ner-backfill'").get() as { id: number; data: string };
    const repair = JSON.parse(child.data).repair;
    db.rawDb.prepare("UPDATE jobs SET status='done', result=?, finished_at=datetime('now') WHERE id=?")
      .run(JSON.stringify({ outcome: "processed", kind: "ner", repair, graphOutcome: "terminal_no_graph_links", activeLinkCount: 0 }), child.id);
    finalizeRepairBatch(db, receipt.batchId!);
    db.rawDb.prepare("UPDATE jobs SET data='{}' WHERE id=?").run(child.id);

    expect(planZeroLinkBackfill(db)).toMatchObject({ status: "blocked", queueIntegrityConflicts: 1, selected: 0 });
    expect(summarizeRepairBatch(db, receipt.batchId!)).toMatchObject({
      finalized: false,
      integrityConflicts: 1,
      selected: 1,
      done: 1,
    });
  });

  test("rolls back a child insert when manifest creation fails", () => {
    addRich();
    db.rawDb.exec(`
      CREATE TRIGGER reject_zero_link_manifest
      BEFORE INSERT ON jobs
      WHEN NEW.name = '${ZERO_LINK_BATCH_MANIFEST_JOB}'
      BEGIN SELECT RAISE(ABORT, 'synthetic manifest failure'); END;
    `);
    expect(() => enqueueZeroLinkBackfill(db, 1)).toThrow();
    expect((db.rawDb.prepare("SELECT COUNT(*) count FROM jobs").get() as { count: number }).count).toBe(0);
  });

  test("self-contained report never exposes private candidate identity", () => {
    addRich("records/private-identity");
    const json = JSON.stringify(planZeroLinkBackfill(db, 1));
    expect(json).not.toContain("private-identity");
    expect(json).not.toContain("fingerprint-a");
  });
});
