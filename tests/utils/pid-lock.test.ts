import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PidLock } from "../../src/utils/pid-lock.js";

const TEST_DIR = "/tmp/cbrain-test-pid-lock";

/** PidLock writes to `<dataDir>/cbrain-<transport>.pid` (no lockId suffix here). */
function pidFile(dataDir: string, transport: "http" | "stdio"): string {
  return join(dataDir, `cbrain-${transport}.pid`);
}

describe("PidLock.activeOwnerPid", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("null when no pid file exists", () => {
    const lock = new PidLock(TEST_DIR, "http");
    expect(lock.activeOwnerPid()).toBeNull();
  });

  test("null when pid file holds a dead pid", () => {
    writeFileSync(pidFile(TEST_DIR, "http"), "999999");
    const lock = new PidLock(TEST_DIR, "http");
    expect(lock.activeOwnerPid()).toBeNull();
  });

  test("null when pid file holds the current process (self)", () => {
    writeFileSync(pidFile(TEST_DIR, "http"), String(process.pid));
    const lock = new PidLock(TEST_DIR, "http");
    expect(lock.activeOwnerPid()).toBeNull();
  });

  test("returns pid when pid file holds a live, non-self process", () => {
    // Spawn a real sleeping child so process.kill(pid,0) reports alive.
    const child = Bun.spawn({ cmd: ["sleep", "30"], stdout: "ignore", stderr: "ignore" });
    try {
      writeFileSync(pidFile(TEST_DIR, "http"), String(child.pid));
      const lock = new PidLock(TEST_DIR, "http");
      expect(lock.activeOwnerPid()).toBe(child.pid);
    } finally {
      try { process.kill(child.pid, "SIGKILL"); } catch { /* */ }
    }
  });

  test("checks the correct transport file (http vs stdio are separate)", () => {
    writeFileSync(pidFile(TEST_DIR, "http"), "999999"); // dead http owner
    // stdio file absent → stdio probe null even though http file has a (dead) pid
    expect(new PidLock(TEST_DIR, "stdio").activeOwnerPid()).toBeNull();
    expect(new PidLock(TEST_DIR, "http").activeOwnerPid()).toBeNull();
  });
});

describe("PidLock.scanActiveOwnerPids (lock-id-suffixed serve)", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("returns [] when dir is empty or missing", () => {
    expect(PidLock.scanActiveOwnerPids(TEST_DIR, "http")).toEqual([]);
    expect(PidLock.scanActiveOwnerPids("/nonexistent-cbrain-dir-xyz", "stdio")).toEqual([]);
  });

  test("detects a lock-id-suffixed serve pid (CBRAIN_LOCK_ID path)", () => {
    const child = Bun.spawn({ cmd: ["sleep", "30"], stdout: "ignore", stderr: "ignore" });
    try {
      // serve with CBRAIN_LOCK_ID=prod writes cbrain-http-prod.pid — the
      // unsuffixed activeOwnerPid() check alone misses this.
      writeFileSync(join(TEST_DIR, "cbrain-http-prod.pid"), String(child.pid));
      expect(PidLock.scanActiveOwnerPids(TEST_DIR, "http")).toEqual([child.pid]);
    } finally {
      try { process.kill(child.pid, "SIGKILL"); } catch { /* */ }
    }
  });

  test("detects both plain and suffixed serve pid files together", () => {
    const a = Bun.spawn({ cmd: ["sleep", "30"], stdout: "ignore", stderr: "ignore" });
    const b = Bun.spawn({ cmd: ["sleep", "30"], stdout: "ignore", stderr: "ignore" });
    try {
      writeFileSync(join(TEST_DIR, "cbrain-http.pid"), String(a.pid));
      writeFileSync(join(TEST_DIR, "cbrain-http-staging.pid"), String(b.pid));
      expect(PidLock.scanActiveOwnerPids(TEST_DIR, "http").sort()).toEqual([a.pid, b.pid].sort());
    } finally {
      try { process.kill(a.pid, "SIGKILL"); } catch { /* */ }
      try { process.kill(b.pid, "SIGKILL"); } catch { /* */ }
    }
  });

  test("ignores dead pid files (plain + suffixed)", () => {
    writeFileSync(join(TEST_DIR, "cbrain-http.pid"), "999999");
    writeFileSync(join(TEST_DIR, "cbrain-http-prod.pid"), "999998");
    writeFileSync(join(TEST_DIR, "cbrain-stdio-staging.pid"), "999997");
    expect(PidLock.scanActiveOwnerPids(TEST_DIR, "http")).toEqual([]);
    expect(PidLock.scanActiveOwnerPids(TEST_DIR, "stdio")).toEqual([]);
  });

  test("transport-scoped: http suffixed file invisible to stdio scan", () => {
    const child = Bun.spawn({ cmd: ["sleep", "30"], stdout: "ignore", stderr: "ignore" });
    try {
      writeFileSync(join(TEST_DIR, "cbrain-http-prod.pid"), String(child.pid));
      expect(PidLock.scanActiveOwnerPids(TEST_DIR, "stdio")).toEqual([]);
      expect(PidLock.scanActiveOwnerPids(TEST_DIR, "http")).toEqual([child.pid]);
    } finally {
      try { process.kill(child.pid, "SIGKILL"); } catch { /* */ }
    }
  });

  test("excludes self and dedupes the same pid across files", () => {
    writeFileSync(join(TEST_DIR, "cbrain-http.pid"), String(process.pid)); // self → excluded
    expect(PidLock.scanActiveOwnerPids(TEST_DIR, "http")).toEqual([]);
    const child = Bun.spawn({ cmd: ["sleep", "30"], stdout: "ignore", stderr: "ignore" });
    try {
      writeFileSync(join(TEST_DIR, "cbrain-http-a.pid"), String(child.pid));
      writeFileSync(join(TEST_DIR, "cbrain-http-b.pid"), String(child.pid));
      expect(PidLock.scanActiveOwnerPids(TEST_DIR, "http")).toEqual([child.pid]); // deduped
    } finally {
      try { process.kill(child.pid, "SIGKILL"); } catch { /* */ }
    }
  });

  test("does not match unrelated lookalike files", () => {
    writeFileSync(join(TEST_DIR, "cbrain-https.pid"), "999999");      // wrong transport
    writeFileSync(join(TEST_DIR, "cbrain-http.pid.bak"), "999999");   // wrong suffix
    writeFileSync(join(TEST_DIR, "cbrain-http-log.pid.txt"), "999999"); // wrong ext
    expect(PidLock.scanActiveOwnerPids(TEST_DIR, "http")).toEqual([]);
  });
});
