import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { PageManager } from "../../src/core/page.js";
import { handleNerBackfill, isCanonicalRepairBatchId, parseCanonicalCliInteger, validateNerBackfillMode } from "../../src/cli/commands/maintenance.js";
import type { LockProbe } from "../../src/cli/commands/reindex.js";
import type { ContentPipeline } from "../../src/core/ingestion/pipeline.js";
import { enqueueZeroLinkBackfill } from "../../src/core/maintenance/zero-link-backfill.js";

const SRC = readFileSync(join(import.meta.dir, "../../src/cli/commands/maintenance.ts"), "utf-8");
const CLI = join(import.meta.dir, "../../src/cli/index.ts");

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

  test("repair batch UUID is canonical lowercase and rejected before config/dependency setup", () => {
    const canonical = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const invalid = [
      "",
      canonical.toUpperCase(),
      `a${canonical.slice(1, 8).toUpperCase()}${canonical.slice(8)}`,
      ` ${canonical} `,
      `{${canonical}}`,
      canonical.replaceAll("-", ""),
      `\u0430${canonical.slice(1)}`,
    ];
    expect(isCanonicalRepairBatchId(canonical)).toBe(true);
    const invalidArgs = [
      ...invalid.map((value) => ["--repair-batch", value]),
      ["--repair-batch="],
    ];
    for (const args of invalidArgs) {
      const value = args.length === 2 ? args[1] : "";
      expect(isCanonicalRepairBatchId(value)).toBe(false);
      const missingConfig = join(tmpdir(), `cbrain-invalid-batch-${crypto.randomUUID()}.json`);
      const result = spawnSync("bun", ["run", CLI, "ner-backfill", ...args, "--json"], {
        encoding: "utf-8",
        env: { ...process.env, CBRAIN_CONFIG: missingConfig },
      });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, status: "error", code: "INVALID_BATCH_ID" });
      expect(result.stderr).not.toContain("CBRAIN_CONFIG=");
    }

    const missingConfig = join(tmpdir(), `cbrain-valid-batch-${crypto.randomUUID()}.json`);
    const accepted = spawnSync("bun", ["run", CLI, "ner-backfill", "--repair-batch", canonical, "--json"], {
      encoding: "utf-8",
      env: { ...process.env, CBRAIN_CONFIG: missingConfig },
    });
    expect(accepted.status).toBe(1);
    expect(accepted.stderr).toContain("CBRAIN_CONFIG=");
    expect(accepted.stdout).not.toContain("INVALID_BATCH_ID");
  });

  test("empty repair batch never falls back to unfiltered NER", async () => {
    const dir = withTempDir("cbrain-ner-backfill-empty-batch-");
    try {
      const deps = makeDeps(dir);
      deps.db.upsertPage({ slug: "records/item", type: "record", title: "匿名记录", filePath: "records/item.md", contentHash: "a" });
      deps.db.insertChunk("records/item", 0, "first");
      deps.db.insertChunk("records/item", 1, "second");
      deps.db.submitJob("ner-backfill", {
        slug: "records/item", kind: "ner", pageContentHash: "a", sourceFingerprint: "page:a",
      });
      const before = JSON.stringify(deps.db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());
      const logs: string[] = [];

      expect(await handleNerBackfill(
        { db: deps.db, pages: deps.pages, pipeline: deps.pipeline, lockProbe: open },
        { limit: 1, repairBatch: "", json: true },
        (message) => logs.push(message),
      )).toBe(1);
      expect(JSON.parse(logs.join("\n"))).toMatchObject({ code: "INVALID_BATCH_ID" });
      expect(JSON.stringify(deps.db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
      expect(deps.processCalls).toBe(0);
      deps.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("conflicting modes fail before lock, config, DB mutation, or unfiltered execution", async () => {
    const dir = withTempDir("cbrain-ner-backfill-mode-conflict-");
    try {
      const deps = makeDeps(dir);
      deps.db.upsertPage({ slug: "records/item", type: "record", title: "匿名记录", filePath: "records/item.md", contentHash: "a" });
      deps.db.insertChunk("records/item", 0, "first");
      deps.db.insertChunk("records/item", 1, "second");
      deps.db.submitJob("ner-backfill", {
        slug: "records/item", kind: "ner", pageContentHash: "a", sourceFingerprint: "page:a",
      });
      const unknownId = deps.db.submitJob("ner-backfill", {
        slug: "records/unknown", kind: "ner", pageContentHash: "b", sourceFingerprint: "page:b",
      });
      deps.db.rawDb.prepare("UPDATE jobs SET status='done', result=?, finished_at=datetime('now') WHERE id=?")
        .run(JSON.stringify({ outcome: "commit_unknown", kind: "ner" }), unknownId);
      const batchId = "11111111-1111-4111-8111-111111111111";
      const cases: Array<Partial<Parameters<typeof handleNerBackfill>[1]>> = [
        { repairBatch: batchId, retryFailed: true },
        { repairBatch: batchId, listCommitUnknown: true },
        { repairBatch: batchId, resolveCommitUnknown: unknownId, decision: "accept" },
        { repairBatch: batchId, decision: "accept" },
        { listCommitUnknown: true, resolveCommitUnknown: unknownId, decision: "accept" },
        { listCommitUnknown: true, decision: "accept" },
        { listCommitUnknown: true, retryFailed: true },
        { resolveCommitUnknown: unknownId, decision: "accept", retryFailed: true },
        { resolveCommitUnknown: unknownId },
        { decision: "accept" },
        { decision: "" as never },
        { decision: false as never },
        { decision: null as never },
        { listCommitUnknown: null as never },
        { listCommitUnknown: "" as never },
        { listCommitUnknown: 0 as never },
        { listCommitUnknown: "false" as never },
        { listCommitUnknown: {} as never },
        { retryFailed: null as never },
        { retryFailed: "" as never },
        { retryFailed: 0 as never },
        { retryFailed: "false" as never },
        { retryFailed: {} as never },
      ];
      let lockCalls = 0;
      const lockProbe: LockProbe = { blockingOwner: () => { lockCalls++; return null; } };
      const before = JSON.stringify(deps.db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());

      for (const item of cases) {
        expect(validateNerBackfillMode(item)).toMatchObject({ ok: false });
        const logs: string[] = [];
        expect(await handleNerBackfill(
          { db: deps.db, pages: deps.pages, pipeline: deps.pipeline, lockProbe },
          { limit: 1, json: true, ...item },
          (message) => logs.push(message),
        )).toBe(1);
        expect(JSON.parse(logs.join("\n"))).toMatchObject({ ok: false, status: "error" });
        expect(JSON.stringify(deps.db.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
      }
      expect(lockCalls).toBe(0);
      expect(deps.processCalls).toBe(0);
      for (const valid of [
        {},
        { retryFailed: false },
        { listCommitUnknown: false },
        { retryFailed: true },
        { repairBatch: batchId },
        { listCommitUnknown: true },
        { resolveCommitUnknown: unknownId, decision: "accept" as const },
      ]) expect(validateNerBackfillMode(valid)).toEqual({ ok: true });

      const cliCases = [
        ["--repair-batch", batchId, "--retry-failed"],
        ["--repair-batch", batchId, "--list-commit-unknown"],
        ["--repair-batch", batchId, "--resolve-commit-unknown", "1", "--decision", "accept"],
        ["--repair-batch", batchId, "--decision", "accept"],
        ["--list-commit-unknown", "--resolve-commit-unknown", "1", "--decision", "accept"],
        ["--list-commit-unknown", "--decision", "accept"],
        ["--list-commit-unknown", "--retry-failed"],
        ["--resolve-commit-unknown", "1", "--decision", "accept", "--retry-failed"],
        ["--resolve-commit-unknown", "1"],
        ["--decision", "accept"],
        ["--decision", ""],
        ["--decision="],
        ["--decision", "accept", "--decision", ""],
      ];
      for (const args of cliCases) {
        const missingConfig = join(tmpdir(), `cbrain-mode-conflict-${crypto.randomUUID()}.json`);
        const result = spawnSync("bun", ["run", CLI, "ner-backfill", ...args, "--json"], {
          encoding: "utf-8",
          env: { ...process.env, CBRAIN_CONFIG: missingConfig },
        });
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, status: "error" });
        expect(result.stderr).not.toContain("CBRAIN_CONFIG=");
      }
      deps.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("job ids and limits reject numeric prefixes before touching a real DB", () => {
    const dir = withTempDir("cbrain-ner-backfill-canonical-number-");
    try {
      const vaultPath = join(dir, "vault");
      const dbPath = join(dir, "brain.sqlite");
      const configPath = join(dir, "cbrain.json");
      mkdirSync(vaultPath, { recursive: true });
      const seeded = new CBrainDB(dbPath);
      const unknownId = seeded.submitJob("ner-backfill", {
        slug: "records/item", kind: "ner", pageContentHash: "a", sourceFingerprint: "page:a",
      });
      seeded.rawDb.prepare("UPDATE jobs SET status='done', result=?, finished_at=datetime('now') WHERE id=?")
        .run(JSON.stringify({ outcome: "commit_unknown", kind: "ner" }), unknownId);
      const before = JSON.stringify(seeded.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all());
      seeded.close();
      writeFileSync(configPath, JSON.stringify({
        vaultPath,
        dbPath,
        lancePath: join(dir, "lancedb"),
        embedding: { provider: "deterministic" },
      }));

      const invalid = ["1junk", "1.5", "1e3", "+1", "-1", "-0", " 1 ", "01", "１", "9007199254740992"];
      expect(parseCanonicalCliInteger("1", false)).toBe(1);
      expect(parseCanonicalCliInteger("0", true)).toBe(0);
      for (const value of invalid) {
        expect(parseCanonicalCliInteger(value, false)).toBeNull();
        expect(parseCanonicalCliInteger(value, true)).toBeNull();
        const result = spawnSync("bun", [
          "run", CLI, "ner-backfill", "--resolve-commit-unknown", value, "--decision", "accept", "--json",
        ], { encoding: "utf-8", env: { ...process.env, CBRAIN_CONFIG: configPath } });
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({ code: "COMMIT_UNKNOWN_STATE_MISMATCH" });
        const checked = new CBrainDB(dbPath);
        expect(JSON.stringify(checked.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
        checked.close();
      }

      const repeated = spawnSync("bun", [
        "run", CLI, "ner-backfill", "--resolve-commit-unknown", String(unknownId),
        "--resolve-commit-unknown", "1junk", "--decision", "accept", "--json",
      ], { encoding: "utf-8", env: { ...process.env, CBRAIN_CONFIG: configPath } });
      expect(repeated.status).toBe(1);
      expect(JSON.parse(repeated.stdout)).toMatchObject({ code: "COMMIT_UNKNOWN_STATE_MISMATCH" });
      const afterRepeated = new CBrainDB(dbPath);
      expect(JSON.stringify(afterRepeated.rawDb.prepare("SELECT * FROM jobs ORDER BY id").all())).toBe(before);
      afterRepeated.close();

      for (const value of invalid) {
        const missingConfig = join(dir, `missing-${crypto.randomUUID()}.json`);
        const result = spawnSync("bun", ["run", CLI, "ner-backfill", "--limit", value, "--json"], {
          encoding: "utf-8",
          env: { ...process.env, CBRAIN_CONFIG: missingConfig },
        });
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
        expect(result.stderr).not.toContain("CBRAIN_CONFIG=");
      }
      const repeatedLimit = spawnSync("bun", ["run", CLI, "ner-backfill", "--limit", "1", "--limit", "1junk", "--json"], {
        encoding: "utf-8",
        env: { ...process.env, CBRAIN_CONFIG: join(dir, "missing-repeat.json") },
      });
      expect(repeatedLimit.status).toBe(1);
      expect(JSON.parse(repeatedLimit.stdout)).toMatchObject({ ok: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("direct handler rejects negative zero before lock or mutation", async () => {
    const dir = withTempDir("cbrain-ner-backfill-negative-zero-");
    try {
      const deps = makeDeps(dir);
      const id = deps.db.submitJob("ner-backfill", { slug: "records/item", kind: "ner" });
      const before = JSON.stringify(deps.db.getJob(id));
      let lockCalls = 0;
      const logs: string[] = [];

      expect(await handleNerBackfill(
        { db: deps.db, pages: deps.pages, pipeline: deps.pipeline, lockProbe: { blockingOwner: () => { lockCalls++; return null; } } },
        { limit: -0, json: true },
        (message) => logs.push(message),
      )).toBe(1);
      expect(JSON.parse(logs.join("\n"))).toMatchObject({ code: "INVALID_LIMIT" });
      expect(JSON.stringify(deps.db.getJob(id))).toBe(before);
      expect(lockCalls).toBe(0);
      expect(deps.processCalls).toBe(0);
      deps.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      const page = deps.pages.create({ title: "匿名记录", type: "record", body: "匿名正文", slug: "records/private-d" });
      const current = deps.db.getPage(page.slug)!;
      const failedNer = deps.db.submitJob("ner-backfill", {
        slug: page.slug,
        kind: "ner",
        pageContentHash: current.content_hash,
        sourceFingerprint: `page:${current.content_hash}`,
      });
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

  test("--retry-failed rolls back when global preflight finds a later conflict", async () => {
    const dir = withTempDir("cbrain-ner-backfill-retry-conflict-");
    try {
      const deps = makeDeps(dir);
      const failed = deps.db.submitJob("ner-backfill", {
        slug: "records/record-a", kind: "ner", pageContentHash: "hash-a", sourceFingerprint: "page:hash-a",
      });
      deps.db.rawDb.prepare("UPDATE jobs SET status='failed', attempts=3, error='fixed' WHERE id=?").run(failed);
      deps.db.submitJob("ner-backfill", { slug: "records/record-b", kind: "ner", sourceFingerprint: "page:b" });
      deps.db.submitJob("ner-backfill", { slug: "records/record-b", kind: "ner", sourceFingerprint: "page:b" });
      const before = JSON.stringify(deps.db.listJobs());
      const logs: string[] = [];

      const exit = await handleNerBackfill(
        { db: deps.db, pages: deps.pages, pipeline: deps.pipeline, lockProbe: open },
        { limit: 0, retryFailed: true, json: true },
        (message) => logs.push(message),
      );

      expect(exit).toBe(1);
      expect(JSON.parse(logs.join("\n"))).toMatchObject({ code: "QUEUE_INTEGRITY_CONFLICT" });
      expect(JSON.stringify(deps.db.listJobs())).toBe(before);
      deps.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--retry-failed leaves malformed failed rows byte-for-byte unchanged", async () => {
    const dir = withTempDir("cbrain-ner-backfill-retry-malformed-");
    try {
      const deps = makeDeps(dir);
      const id = deps.db.submitJob("ner-backfill", { unexpected: true });
      deps.db.rawDb.prepare("UPDATE jobs SET status='failed', attempts=3, error='fixed' WHERE id=?").run(id);
      const before = JSON.stringify(deps.db.listJobs());
      const logs: string[] = [];

      expect(await handleNerBackfill(
        { db: deps.db, pages: deps.pages, pipeline: deps.pipeline, lockProbe: open },
        { limit: 0, retryFailed: true, json: true },
        (message) => logs.push(message),
      )).toBe(0);
      expect(JSON.parse(logs.join("\n"))).toMatchObject({ retried_failed: 0 });
      expect(JSON.stringify(deps.db.listJobs())).toBe(before);
      deps.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--retry-failed retries only the current complete ordinary epoch", async () => {
    const dir = withTempDir("cbrain-ner-backfill-retry-epoch-");
    try {
      const deps = makeDeps(dir);
      const page = deps.pages.create({ title: "匿名记录", type: "record", body: "当前正文", slug: "records/item" });
      const current = deps.db.getPage(page.slug)!;
      const currentId = deps.db.submitJob("ner-backfill", {
        slug: page.slug,
        kind: "ner",
        pageContentHash: current.content_hash,
        sourceFingerprint: `page:${current.content_hash}`,
      });
      const staleId = deps.db.submitJob("ner-backfill", {
        slug: page.slug,
        kind: "ner",
        pageContentHash: "old-hash",
        sourceFingerprint: "page:old-hash",
      });
      dbFailed(deps.db, currentId);
      dbFailed(deps.db, staleId);
      const staleBefore = JSON.stringify(deps.db.getJob(staleId));
      const logs: string[] = [];

      expect(await handleNerBackfill(
        { db: deps.db, pages: deps.pages, pipeline: deps.pipeline, lockProbe: open },
        { limit: 0, retryFailed: true, json: true },
        (message) => logs.push(message),
      )).toBe(0);
      expect(JSON.parse(logs.join("\n"))).toMatchObject({ retried_failed: 1 });
      expect(deps.db.getJob(currentId)!.status).toBe("pending");
      expect(JSON.stringify(deps.db.getJob(staleId))).toBe(staleBefore);
      deps.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function dbFailed(db: CBrainDB, id: number): void {
  db.rawDb.prepare("UPDATE jobs SET status='failed', attempts=3, error='fixed', finished_at=datetime('now') WHERE id=?").run(id);
}
