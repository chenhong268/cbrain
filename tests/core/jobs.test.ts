import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { JobQueue } from "../../src/core/jobs.js";

describe("JobQueue", () => {
  const testDir = "/tmp/cbrain-test-jobs";
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
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("submit returns job id", () => {
    const id = queue.submit("sync", { path: "/tmp" });
    expect(id).toBeGreaterThan(0);
  });

  test("list returns submitted jobs", () => {
    queue.submit("sync");
    queue.submit("embed");
    const list = queue.list();
    expect(list.length).toBe(2);
    expect(list[0].name).toBe("embed");
    expect(list[1].name).toBe("sync");
  });

  test("list filters by status", () => {
    queue.submit("sync");
    const pending = queue.list("pending");
    expect(pending.length).toBe(1);
    const done = queue.list("done");
    expect(done.length).toBe(0);
  });

  test("get returns job details", () => {
    const id = queue.submit("ner", { text: "hello" });
    const job = queue.get(id);
    expect(job).toBeDefined();
    expect(job!.name).toBe("ner");
    expect(job!.status).toBe("pending");
  });

  test("get returns null for missing job", () => {
    expect(queue.get(9999)).toBeNull();
  });

  test("cancel pending job", () => {
    const id = queue.submit("sync");
    const ok = queue.cancel(id);
    expect(ok).toBe(true);
    expect(queue.get(id)!.status).toBe("cancelled");
  });

  test("cancel returns false for done job", () => {
    const id = queue.submit("sync");
    // Claim + complete to make it done
    db.claimJob();
    db.completeJob(id);
    expect(queue.cancel(id)).toBe(false);
  });

  test("retry failed job", () => {
    const id = queue.submit("sync");
    // Exhaust all 3 attempts
    for (let i = 0; i < 3; i++) {
      db.claimJob();
      db.failJob(id, `boom ${i}`);
    }
    expect(queue.get(id)!.status).toBe("failed");

    const ok = queue.retry(id);
    expect(ok).toBe(true);
    expect(queue.get(id)!.status).toBe("pending");
    expect(queue.get(id)!.attempts).toBe(0);
  });

  test("work processes jobs", async () => {
    queue.register("echo", async (data, _jobId) => ({ echoed: data }));

    queue.submit("echo", { msg: "hello" });
    queue.submit("echo", { msg: "world" });

    // Run work loop briefly
    const workPromise = queue.work(50);
    await new Promise((r) => setTimeout(r, 300));
    queue.stop();
    await workPromise;

    const list = queue.list("done");
    expect(list.length).toBe(2);
  });

  test("work handles handler errors", async () => {
    queue.register("fail", async () => { throw new Error("kaboom"); });

    queue.submit("fail");

    const workPromise = queue.work(50);
    await new Promise((r) => setTimeout(r, 300));
    queue.stop();
    await workPromise;

    // After 3 attempts, job should be failed
    const job = queue.get(1);
    expect(job!.status).toBe("failed");
    expect(job!.error).toContain("kaboom");
  });

  test("work skips unknown job name", async () => {
    queue.submit("unknown_job");

    const workPromise = queue.work(50);
    await new Promise((r) => setTimeout(r, 200));
    queue.stop();
    await workPromise;

    const job = queue.get(1);
    expect(job!.status).toBe("failed");
    expect(job!.error).toContain("No handler");
  });
});

// Cancellation must remain terminal even when an in-flight handler finishes late.
describe("running job cancellation (#494)", () => {
  test.each([false, true])("late completion cannot replace cancellation (throws=%s)", async throws => {
    const db = new CBrainDB(":memory:");
    const queue = new JobQueue(db);
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>(r => { release = r; });
    const started = new Promise<void>(r => { entered = r; });
    let signal: AbortSignal | undefined;
    queue.register("probe", async (_data, _id, execution) => {
      signal = execution?.signal;
      entered();
      await pending;
      if (throws) throw new Error("late failure");
      return { completed: true };
    });
    const id = queue.submit("probe");
    const worker = queue.work(1);
    try {
      await started;
      expect(queue.cancel(id)).toBe(true);
      queue.stop();
      release();
      await worker;
      expect(queue.get(id)?.status).toBe("cancelled");
      expect(signal?.aborted).toBe(true);
    } finally { queue.stop(); release(); await worker; db.close(); }
  });

  test("cancel rejects retry and a fresh submission cannot consume the old result", async () => {
    const db = new CBrainDB(":memory:");
    const queue = new JobQueue(db);
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>(r => { release = r; });
    const started = new Promise<void>(r => { entered = r; });
    let attempts = 0;
    queue.register("probe", async () => {
      const attempt = ++attempts;
      if (attempt === 1) { entered(); await pending; }
      else queue.stop();
      return { attempt };
    });
    const id = queue.submit("probe");
    const worker = queue.work(1);
    try {
      await started;
      expect(queue.cancel(id)).toBe(true);
      expect(queue.retry(id)).toBe(false);
      const nextId = queue.submit("probe");
      release();
      await worker;
      expect(queue.get(id)?.status).toBe("cancelled");
      expect(attempts).toBe(2);
      expect(JSON.parse(queue.get(nextId)!.result!)).toEqual({ attempt: 2 });
    } finally { queue.stop(); release(); await worker; db.close(); }
  });

  test("another connection's cancellation is observed before the next action", async () => {
    const dir = `/tmp/cbrain-job-cancel-${crypto.randomUUID()}`;
    mkdirSync(dir);
    const db = new CBrainDB(join(dir, "test.sqlite"));
    const other = new CBrainDB(join(dir, "test.sqlite"));
    const queue = new JobQueue(db);
    let laterAction = false;
    queue.register("probe", async (_data, id, execution) => {
      other.cancelJob(id);
      queue.stop();
      execution?.checkCancelled();
      laterAction = true;
    });
    const id = queue.submit("probe");
    try {
      await queue.work(1);
      expect(laterAction).toBe(false);
      expect(db.getJob(id)?.status).toBe("cancelled");
    } finally { other.close(); db.close(); rmSync(dir, { recursive: true }); }
  });
  test.each([false, true])("concurrent write during finalization does not retry work or kill the worker (throws=%s)", async throws => {
    const dir = `/tmp/cbrain-job-finalize-${crypto.randomUUID()}`;
    mkdirSync(dir);
    const db = new CBrainDB(join(dir, "test.sqlite"));
    const other = new CBrainDB(join(dir, "test.sqlite"));
    const queue = new JobQueue(db);
    const complete = db.completeJob.bind(db);
    const fail = db.failJob.bind(db);
    db.completeJob = (id, result) => { other.setConfig("probe.concurrent", "yes"); complete(id, result); };
    db.failJob = (id, error) => { other.cancelJob(id); fail(id, error); };
    queue.register("probe", async () => {
      queue.stop();
      db.setConfig("probe.applied", "yes");
      if (throws) throw new Error("probe failure");
      return { completed: true };
    });
    const id = queue.submit("probe");
    try {
      await queue.work(1);
      expect(db.getJob(id)?.status).toBe(throws ? "cancelled" : "done");
      expect(db.getJob(id)?.attempts).toBe(1);
      expect(db.getConfig("probe.applied")).toBe("yes");
      if (!throws) expect(JSON.parse(db.getJob(id)!.result!)).toEqual({ completed: true });
    } finally { other.close(); db.close(); rmSync(dir, { recursive: true }); }
  });

});
