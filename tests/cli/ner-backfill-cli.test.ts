import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { PageManager } from "../../src/core/page.js";
import { handleNerBackfill } from "../../src/cli/commands/maintenance.js";
import type { LockProbe } from "../../src/cli/commands/reindex.js";
import type { ContentPipeline } from "../../src/core/ingestion/pipeline.js";
import { enqueueZeroLinkBackfill } from "../../src/core/maintenance/zero-link-backfill.js";

const SRC = readFileSync(join(import.meta.dir, "../../src/cli/commands/maintenance.ts"), "utf-8");

const blocking: LockProbe = { blockingOwner: () => ({ kind: "serve", pid: 4242 }) };
const open: LockProbe = { blockingOwner: () => null };

function withTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeDeps(dir: string) {
  const vault = join(dir, "vault");
  mkdirSync(vault, { recursive: true });
  const db = new CBrainDB(join(dir, "brain.sqlite"));
  const pages = new PageManager(db, vault);
  let processCalls = 0;
  const pipeline = {
    processNer: async () => {
      processCalls += 1;
      throw new Error("processNer should not be called");
    },
  } as unknown as ContentPipeline;
  return { db, pages, pipeline, get processCalls() { return processCalls; } };
}

describe("cbrain ner-backfill CLI (#runtime)", () => {
  test("command is registered with bounded/json options", () => {
    expect(SRC).toContain('.command("ner-backfill")');
    expect(SRC).toContain("--limit <n>");
    expect(SRC).toContain("--retry-failed");
    expect(SRC).toContain("--repair-batch <uuid>");
    expect(SRC).toContain("--list-commit-unknown");
    expect(SRC).toContain("--resolve-commit-unknown <job-id>");
    expect(SRC).toContain("--json");
  });

  test("repair batch rejects retry-failed combination before mutation", async () => {
    const dir = withTempDir("cbrain-ner-backfill-batch-conflict-");
    try {
      const deps = makeDeps(dir);
      const logs: string[] = [];
      const exit = await handleNerBackfill(
        { db: deps.db, pages: deps.pages, pipeline: deps.pipeline, lockProbe: open },
        { limit: 1, repairBatch: "11111111-1111-4111-8111-111111111111", retryFailed: true, json: true },
        (m) => logs.push(m),
      );
      expect(exit).toBe(1);
      expect(JSON.parse(logs.join("\n"))).toMatchObject({ code: "BATCH_RETRY_CONFLICT" });
      expect(deps.db.listJobs()).toHaveLength(0);
      deps.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("repair batch limit mismatch returns a fixed private-safe error", async () => {
    const dir = withTempDir("cbrain-ner-backfill-batch-limit-");
    try {
      const deps = makeDeps(dir);
      const page = deps.pages.create({ title: "匿名记录", type: "record", body: "匿名正文", slug: "records/item" });
      deps.db.insertChunk(page.slug, 0, "first");
      deps.db.insertChunk(page.slug, 1, "second");
      const receipt = enqueueZeroLinkBackfill(deps.db, 1);
      const logs: string[] = [];
      const exit = await handleNerBackfill(
        { db: deps.db, pages: deps.pages, pipeline: deps.pipeline, lockProbe: open },
        { limit: 2, repairBatch: receipt.batchId, json: true },
        (m) => logs.push(m),
      );
      expect(exit).toBe(1);
      const payload = JSON.parse(logs.join("\n"));
      expect(payload).toEqual({ ok: false, status: "error", code: "BATCH_LIMIT_MISMATCH", error: "NER backfill preflight failed" });
      expect(JSON.stringify(payload)).not.toContain("records/item");
      expect(deps.processCalls).toBe(0);
      deps.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("commit-unknown list and accept expose only ids and scalars", async () => {
    const dir = withTempDir("cbrain-ner-backfill-unknown-");
    try {
      const deps = makeDeps(dir);
      deps.db.upsertPage({ slug: "records/private-unknown", type: "record", title: "匿名记录", filePath: "records/private-unknown.md", contentHash: "hash-a" });
      deps.db.insertChunk("records/private-unknown", 0, "first");
      deps.db.insertChunk("records/private-unknown", 1, "second");
      const id = deps.db.submitJob("ner-backfill", {
        slug: "records/private-unknown", kind: "ner", pageContentHash: "hash-a", sourceFingerprint: "page:hash-a",
      });
      deps.db.rawDb.prepare("UPDATE jobs SET status='done', result=? WHERE id=?")
        .run(JSON.stringify({ outcome: "commit_unknown", kind: "ner" }), id);
      const listLogs: string[] = [];
      expect(await handleNerBackfill(
        { db: deps.db, pages: deps.pages, pipeline: deps.pipeline, lockProbe: open },
        { limit: 0, listCommitUnknown: true, json: true },
        (m) => listLogs.push(m),
      )).toBe(0);
      const listed = JSON.parse(listLogs.join("\n"));
      expect(listed).toEqual({ ok: true, count: 1, jobIds: [id], integrityConflicts: 0 });
      expect(JSON.stringify(listed)).not.toContain("private-unknown");

      const resolveLogs: string[] = [];
      expect(await handleNerBackfill(
        { db: deps.db, pages: deps.pages, pipeline: deps.pipeline, lockProbe: open },
        { limit: 0, resolveCommitUnknown: id, decision: "accept", json: true },
        (m) => resolveLogs.push(m),
      )).toBe(0);
      expect(JSON.parse(resolveLogs.join("\n"))).toEqual({
        ok: true, jobId: id, decision: "accept", success: true, successorCount: 0,
      });
      expect(deps.processCalls).toBe(0);
      deps.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses when a live writer is active and never processes jobs", async () => {
    const dir = withTempDir("cbrain-ner-backfill-blocked-");
    try {
      const deps = makeDeps(dir);
      deps.db.submitJob("ner-backfill", { slug: "records/private-a" });
      const logs: string[] = [];
      const errs: string[] = [];

      const exit = await handleNerBackfill(
        { db: deps.db, pages: deps.pages, pipeline: deps.pipeline, lockProbe: blocking },
        { limit: 50, json: true },
        (m) => logs.push(m),
        (m) => errs.push(m),
      );

      expect(exit).toBe(1);
      expect(deps.processCalls).toBe(0);
      expect(errs.join("\n")).toBe("");
      const payload = JSON.parse(logs.join("\n"));
      expect(payload).toMatchObject({ ok: false, blocked: true });
      expect(JSON.stringify(payload)).not.toContain("records/private-a");
      expect(deps.db.listJobs("pending").filter((j) => j.name === "ner-backfill")).toHaveLength(1);
      deps.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--limit 0 --json is a safe no-op and does not leak pending slugs", async () => {
    const dir = withTempDir("cbrain-ner-backfill-limit-zero-");
    try {
      const deps = makeDeps(dir);
      deps.db.submitJob("ner-backfill", { slug: "records/private-b" });
      const logs: string[] = [];
      const errs: string[] = [];

      const exit = await handleNerBackfill(
        { db: deps.db, pages: deps.pages, pipeline: deps.pipeline, lockProbe: open },
        { limit: 0, json: true },
        (m) => logs.push(m),
        (m) => errs.push(m),
      );

      expect(exit).toBe(0);
      expect(deps.processCalls).toBe(0);
      expect(errs).toHaveLength(0);
      const payload = JSON.parse(logs.join("\n"));
      expect(payload).toEqual({
        ok: true,
        counts: { processed: 0, failed: 0, timed_out: 0, skipped: 0 },
      });
      expect(JSON.stringify(payload)).not.toContain("records/private-b");
      expect(deps.db.listJobs("pending").filter((j) => j.name === "ner-backfill")).toHaveLength(1);
      deps.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--retry-failed refuses under a live writer and leaves failed jobs untouched", async () => {
    const dir = withTempDir("cbrain-ner-backfill-retry-blocked-");
    try {
      const deps = makeDeps(dir);
      const id = deps.db.submitJob("ner-backfill", { slug: "records/private-c" });
      deps.db.claimJobById(id);
      deps.db.failJob(id, "timeout-1");
      deps.db.claimJobById(id);
      deps.db.failJob(id, "timeout-2");
      deps.db.claimJobById(id);
      deps.db.failJob(id, "timeout-3");
      const logs: string[] = [];
      const errs: string[] = [];

      const exit = await handleNerBackfill(
        { db: deps.db, pages: deps.pages, pipeline: deps.pipeline, lockProbe: blocking },
        { limit: 0, retryFailed: true, json: true },
        (m) => logs.push(m),
        (m) => errs.push(m),
      );

      expect(exit).toBe(1);
      expect(deps.processCalls).toBe(0);
      expect(JSON.stringify(JSON.parse(logs.join("\n")))).not.toContain("records/private-c");
      expect(deps.db.getJob(id)?.status).toBe("failed");
      deps.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--retry-failed resets only failed ner-backfill jobs without leaking slugs", async () => {
    const dir = withTempDir("cbrain-ner-backfill-retry-");
    try {
      const deps = makeDeps(dir);
      const failedNer = deps.db.submitJob("ner-backfill", { slug: "records/private-d" });
      const failedOther = deps.db.submitJob("other-job", { slug: "records/private-e" });
      deps.db.claimJobById(failedNer);
      deps.db.failJob(failedNer, "timeout-1");
      deps.db.claimJobById(failedNer);
      deps.db.failJob(failedNer, "timeout-2");
      deps.db.claimJobById(failedNer);
      deps.db.failJob(failedNer, "timeout-3");
      deps.db.claimJobById(failedOther);
      deps.db.failJob(failedOther, "other-failure");
      deps.db.claimJobById(failedOther);
      deps.db.failJob(failedOther, "other-failure");
      deps.db.claimJobById(failedOther);
      deps.db.failJob(failedOther, "other-failure");
      const logs: string[] = [];
      const errs: string[] = [];

      const exit = await handleNerBackfill(
        { db: deps.db, pages: deps.pages, pipeline: deps.pipeline, lockProbe: open },
        { limit: 0, retryFailed: true, json: true },
        (m) => logs.push(m),
        (m) => errs.push(m),
      );

      expect(exit).toBe(0);
      expect(deps.processCalls).toBe(0);
      expect(errs).toHaveLength(0);
      const payload = JSON.parse(logs.join("\n"));
      expect(payload).toEqual({
        ok: true,
        retried_failed: 1,
        counts: { processed: 0, failed: 0, timed_out: 0, skipped: 0 },
      });
      expect(JSON.stringify(payload)).not.toContain("records/private-d");
      expect(deps.db.getJob(failedNer)?.status).toBe("pending");
      expect(deps.db.getJob(failedNer)?.attempts).toBe(0);
      expect(deps.db.getJob(failedOther)?.status).toBe("failed");
      deps.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
