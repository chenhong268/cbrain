import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  countCurrentGraphLinks,
  deriveZeroLinkSource,
  enqueueZeroLinkBackfill,
  planZeroLinkBackfill,
  scanRichRecords,
  scanZeroLinkCandidates,
  toPublicZeroLinkCandidate,
  ZERO_LINK_BATCH_MANIFEST_JOB,
  ZERO_LINK_REPAIR_NAME,
} from "../../../src/core/maintenance/zero-link-backfill";
import { CBrainDB } from "../../../src/storage/sqlite";

const testDir = "/tmp/cbrain-test-zero-link-backfill";
const dbPath = join(testDir, "brain.sqlite");
let db: CBrainDB;

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
      attemptLease: { version: 1, token: "lease-a", phase: "claimed" },
    });
    db.rawDb.prepare("UPDATE jobs SET status='running', started_at=datetime('now') WHERE id=?").run(predecessor);
    db.submitJob("ner-backfill", {
      slug: "records/item",
      kind: "ner",
      contentHash: "fingerprint-a",
      sourceFingerprint: "page:fingerprint-a",
    });
    expect(planZeroLinkBackfill(db)).toMatchObject({ active: 1, staleRunning: 0, stateConflicts: 0, actionable: 0 });
    db.rawDb.prepare("UPDATE jobs SET started_at=datetime('now','-31 minutes') WHERE id=?").run(predecessor);
    expect(planZeroLinkBackfill(db)).toMatchObject({ active: 1, staleRunning: 1, stateConflicts: 0, actionable: 0 });
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
