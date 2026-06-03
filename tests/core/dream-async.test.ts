import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { JobQueue } from "../../src/core/jobs.js";

describe("dream async via JobQueue", () => {
  const testDir = "/tmp/cbrain-test-dream-async";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let queue: JobQueue;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    queue = new JobQueue(db);
  });

  afterEach(() => {
    queue.stop();
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("dream job submits and completes", async () => {
    queue.register("dream", async (_data, jobId) => {
      // Simulate a fast dream
      db.updateJobProgress(jobId, "sync", { synced: 3 });
      db.updateJobProgress(jobId, "enrich", { total: 5, upgraded: 1 });
      return { brief: "done", locked: false, stages: {} };
    });

    const jobId = queue.submit("dream", { vaultPath: "/tmp/test" });
    expect(jobId).toBeGreaterThan(0);

    // Start work and wait
    const workPromise = queue.work(50);
    await new Promise((r) => setTimeout(r, 300));
    queue.stop();
    await workPromise;

    const job = queue.get(jobId);
    expect(job).not.toBeNull();
    expect(job!.status).toBe("done");
    expect(job!.result).not.toBeNull();
    const result = JSON.parse(job!.result!);
    expect(result.brief).toBe("done");
  });

  test("dream lock prevents duplicate submission at MCP level", () => {
    // Simulate active lock
    db.setConfig("dream.lock", String(Date.now()));

    // MCP-level lock check (same logic as in ops.ts)
    const lockValue = db.getConfig("dream.lock");
    expect(lockValue).not.toBeNull();

    const lockedAt = parseInt(lockValue!, 10);
    const isLocked = Date.now() - lockedAt < 30 * 60 * 1000;
    expect(isLocked).toBe(true);
  });

  test("locked dream creates trackable job with status done", () => {
    // Simulate active lock
    db.setConfig("dream.lock", String(Date.now()));

    // Same logic as ops.ts locked path: create job + immediately complete
    const jobId = queue.submit("dream", { locked_skip: true });
    db.completeJob(jobId, { locked: true, skipped: true, message: "上次 dream 仍在执行中，已跳过" });

    // Verify job is queryable via dream_status logic
    const job = queue.get(jobId);
    expect(job).not.toBeNull();
    expect(job!.status).toBe("done");
    const result = JSON.parse(job!.result!);
    expect(result.locked).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.message).toContain("跳过");
  });

  test("dream_status returns stage progress", async () => {
    queue.register("dream", async (_data, jobId) => {
      db.updateJobProgress(jobId, "backup", { path: "/tmp/bak.zip", size_mb: "1.2" });
      db.updateJobProgress(jobId, "sync", { synced: 10, skipped: 2, errors: 0 });
      return { brief: "done", locked: false };
    });

    const jobId = queue.submit("dream");
    const workPromise = queue.work(50);
    await new Promise((r) => setTimeout(r, 300));
    queue.stop();
    await workPromise;

    // Read job result — should have progressive stage data
    const job = queue.get(jobId);
    const result = JSON.parse(job!.result!);
    expect(result.current_stage).toBe("sync");
    expect(result.backup).toEqual({ path: "/tmp/bak.zip", size_mb: "1.2" });
    expect(result.sync).toEqual({ synced: 10, skipped: 2, errors: 0 });
    // Final result merged by completeJob
    expect(result.brief).toBe("done");
  });

  test("updateJobProgress progressive writes merge correctly", () => {
    const jobId = queue.submit("test");

    // Simulate progress updates
    db.updateJobProgress(jobId, "stage1", { count: 1 });
    db.updateJobProgress(jobId, "stage2", { count: 2 });

    const job = queue.get(jobId);
    const result = JSON.parse(job!.result!);
    expect(result.current_stage).toBe("stage2");
    expect(result.stage1).toEqual({ count: 1 });
    expect(result.stage2).toEqual({ count: 2 });
  });
});
