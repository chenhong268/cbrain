import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { WatcherLock } from "../../src/utils/watcher-lock.js";

const TEST_DIR = "/tmp/cbrain-test-watcher-lock";

describe("WatcherLock", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("acquires lock and creates lock file", () => {
    const lock = new WatcherLock(TEST_DIR);
    const result = lock.tryAcquire();
    expect(result.acquired).toBe(true);
    expect(existsSync(lock.lockFile)).toBe(true);
    lock.release();
  });

  test("lock file contains owner info", () => {
    const lock = new WatcherLock(TEST_DIR);
    lock.tryAcquire();
    const content = JSON.parse(readFileSync(lock.lockFile, "utf-8"));
    expect(content.pid).toBe(process.pid);
    expect(content.startedAt).toBeDefined();
    expect(content.transport).toBe("http");
    lock.release();
  });

  test("release deletes lock file", () => {
    const lock = new WatcherLock(TEST_DIR);
    lock.tryAcquire();
    expect(existsSync(lock.lockFile)).toBe(true);
    lock.release();
    expect(existsSync(lock.lockFile)).toBe(false);
  });

  test("second acquire on same lock file fails", () => {
    const lock1 = new WatcherLock(TEST_DIR);
    const lock2 = new WatcherLock(TEST_DIR);
    const r1 = lock1.tryAcquire();
    expect(r1.acquired).toBe(true);

    const r2 = lock2.tryAcquire();
    expect(r2.acquired).toBe(false);

    lock1.release();
  });

  test("steals stale lock from dead process", () => {
    const lock = new WatcherLock(TEST_DIR);
    // Write a stale lock file with a dead PID
    writeFileSync(lock.lockFile, JSON.stringify({
      pid: 99999999,
      startedAt: new Date().toISOString(),
      transport: "http",
    }));

    const result = lock.tryAcquire();
    expect(result.acquired).toBe(true);
    lock.release();
  });

  test("readOwner returns null when no lock file", () => {
    const lock = new WatcherLock(TEST_DIR);
    expect(lock.readOwner()).toBeNull();
  });

  test("readOwner returns owner info after acquire", () => {
    const lock = new WatcherLock(TEST_DIR);
    lock.tryAcquire();
    const owner = lock.readOwner();
    expect(owner).not.toBeNull();
    expect(owner!.pid).toBe(process.pid);
    lock.release();
  });

  test("isLocked returns false when no lock", () => {
    const lock = new WatcherLock(TEST_DIR);
    expect(lock.isLocked()).toBe(false);
  });

  test("isLocked returns true when lock held by live process", () => {
    const lock = new WatcherLock(TEST_DIR);
    lock.tryAcquire();
    expect(lock.isLocked()).toBe(true);
    lock.release();
  });

  test("isLocked returns false when lock held by dead process", () => {
    const lock = new WatcherLock(TEST_DIR);
    writeFileSync(lock.lockFile, JSON.stringify({
      pid: 99999999,
      startedAt: new Date().toISOString(),
      transport: "http",
    }));
    expect(lock.isLocked()).toBe(false);
  });

  test("concurrent acquire: only one wins", () => {
    const locks = Array.from({ length: 10 }, () => new WatcherLock(TEST_DIR));
    const results = locks.map(l => l.tryAcquire());
    const acquired = results.filter(r => r.acquired);
    expect(acquired.length).toBe(1);

    // Clean up
    locks.forEach(l => { try { l.release(); } catch { /* */ } });
  });

  test("transport is stored in lock file", () => {
    const lock = new WatcherLock(TEST_DIR, "stdio");
    lock.tryAcquire();
    const content = JSON.parse(readFileSync(lock.lockFile, "utf-8"));
    expect(content.transport).toBe("stdio");
    lock.release();
  });

  test("release is idempotent", () => {
    const lock = new WatcherLock(TEST_DIR);
    lock.tryAcquire();
    lock.release();
    lock.release(); // should not throw
    expect(existsSync(lock.lockFile)).toBe(false);
  });

  // ─── Lock release on simulated process exit ────────────────

  test("lock file cleaned up when release called (simulating SIGTERM handler)", () => {
    const lock = new WatcherLock(TEST_DIR);
    const result = lock.tryAcquire();
    expect(result.acquired).toBe(true);

    // Simulate what the SIGTERM handler does
    const cleanup = () => lock.release();

    // Before cleanup: lock exists, isLocked = true
    expect(existsSync(lock.lockFile)).toBe(true);
    expect(new WatcherLock(TEST_DIR).isLocked()).toBe(true);

    // After cleanup: lock gone, another process can acquire
    cleanup();
    expect(existsSync(lock.lockFile)).toBe(false);
    expect(new WatcherLock(TEST_DIR).isLocked()).toBe(false);

    // New lock can be acquired
    const lock2 = new WatcherLock(TEST_DIR);
    const r2 = lock2.tryAcquire();
    expect(r2.acquired).toBe(true);
    lock2.release();
  });

  test("stale lock from crashed process can be stolen by new watcher", () => {
    // Simulate: process acquired lock, then crashed without cleanup
    const lock1 = new WatcherLock(TEST_DIR);
    lock1.tryAcquire();

    // Overwrite lock file with a dead PID to simulate crash
    writeFileSync(lock1.lockFile, JSON.stringify({
      pid: 99999999,
      startedAt: new Date().toISOString(),
      transport: "http",
    }));

    // New watcher process should be able to steal
    const lock2 = new WatcherLock(TEST_DIR);
    const r2 = lock2.tryAcquire();
    expect(r2.acquired).toBe(true);

    // Verify the lock now has the new process PID
    const owner = lock2.readOwner();
    expect(owner!.pid).toBe(process.pid);
    lock2.release();
  });
});

// ─── Subprocess SIGTERM integration ─────────────────────

describe("WatcherLock subprocess SIGTERM", () => {
  const SIGTERM_DIR = "/tmp/cbrain-test-watcher-lock-sigterm";

  beforeEach(() => {
    if (existsSync(SIGTERM_DIR)) rmSync(SIGTERM_DIR, { recursive: true });
    mkdirSync(SIGTERM_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(SIGTERM_DIR)) rmSync(SIGTERM_DIR, { recursive: true });
  });

  test("child process exits on SIGTERM, lock file cleaned up", async () => {
    // Spawn a child that acquires the lock and holds it
    const child = spawn("bun", ["-e", `
      import { WatcherLock } from "${process.cwd()}/src/utils/watcher-lock.js";
      const lock = new WatcherLock("${SIGTERM_DIR}");
      const r = lock.tryAcquire();
      if (!r.acquired) { process.exit(1); }
      // Register SIGTERM handler to release lock and exit cleanly
      process.on("SIGTERM", () => { lock.release(); process.exit(0); });
      // Keep alive
      setInterval(() => {}, 60000);
    `], { stdio: "pipe" });

    // Wait for child to acquire lock
    await new Promise((r) => setTimeout(r, 500));

    const lock = new WatcherLock(SIGTERM_DIR);
    const ownerBefore = lock.readOwner();
    expect(ownerBefore).not.toBeNull();
    expect(ownerBefore!.pid).toBe(child.pid!);

    // Another process should NOT be able to acquire
    const stealResult = lock.tryAcquire();
    expect(stealResult.acquired).toBe(false);

    // Send SIGTERM
    child.kill("SIGTERM");
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });

    // Child exited cleanly
    expect(exitCode).toBe(0);

    // Lock file should be gone
    expect(existsSync(lock.lockFile)).toBe(false);

    // Now we can acquire
    const result = lock.tryAcquire();
    expect(result.acquired).toBe(true);
    lock.release();
  });

  test("child killed without handler leaves stale lock, new process steals it", async () => {
    // Spawn a child that acquires lock but has NO SIGTERM handler
    const child = spawn("bun", ["-e", `
      import { WatcherLock } from "${process.cwd()}/src/utils/watcher-lock.js";
      const lock = new WatcherLock("${SIGTERM_DIR}");
      const r = lock.tryAcquire();
      if (!r.acquired) { process.exit(1); }
      // No signal handler — just hold lock
      setInterval(() => {}, 60000);
    `], { stdio: "pipe" });

    await new Promise((r) => setTimeout(r, 500));

    const lock = new WatcherLock(SIGTERM_DIR);
    expect(lock.readOwner()).not.toBeNull();

    // SIGKILL — no chance to clean up
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => { child.on("exit", () => resolve()); });

    // Lock file still exists but PID is dead
    expect(existsSync(lock.lockFile)).toBe(true);
    expect(lock.isLocked()).toBe(false);

    // New process can steal
    const result = lock.tryAcquire();
    expect(result.acquired).toBe(true);
    lock.release();
  });
});
