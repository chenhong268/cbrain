import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PidLock, evaluateWriterGate } from "../../src/utils/pid-lock.js";

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

describe("PidLock.scanWriters (profile-wide: all transports + lock ids)", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("empty or missing dir → no active, no stale", () => {
    expect(PidLock.scanWriters(TEST_DIR)).toEqual({ active: [], stale: [] });
    expect(PidLock.scanWriters("/nonexistent-cbrain-dir-xyz-abc")).toEqual({ active: [], stale: [] });
  });

  test("http + stdio live writers both detected (cross-transport, acceptance #1)", () => {
    const a = Bun.spawn({ cmd: ["sleep", "30"], stdout: "ignore", stderr: "ignore" });
    const b = Bun.spawn({ cmd: ["sleep", "30"], stdout: "ignore", stderr: "ignore" });
    try {
      writeFileSync(join(TEST_DIR, "cbrain-http.pid"), String(a.pid));
      writeFileSync(join(TEST_DIR, "cbrain-stdio.pid"), String(b.pid));
      const r = PidLock.scanWriters(TEST_DIR);
      expect(r.stale).toEqual([]);
      expect(r.active.map((o) => o.pid).sort()).toEqual([a.pid, b.pid].sort());
      expect(r.active.map((o) => o.transport).sort()).toEqual(["http", "stdio"]);
    } finally {
      try { process.kill(a.pid, "SIGKILL"); } catch { /* */ }
      try { process.kill(b.pid, "SIGKILL"); } catch { /* */ }
    }
  });

  test("two stdio lock ids both detected — no bypass (acceptance #2)", () => {
    const a = Bun.spawn({ cmd: ["sleep", "30"], stdout: "ignore", stderr: "ignore" });
    const b = Bun.spawn({ cmd: ["sleep", "30"], stdout: "ignore", stderr: "ignore" });
    try {
      writeFileSync(join(TEST_DIR, "cbrain-stdio-xiaoai.pid"), String(a.pid));
      writeFileSync(join(TEST_DIR, "cbrain-stdio-xiaoma.pid"), String(b.pid));
      const r = PidLock.scanWriters(TEST_DIR);
      expect(r.stale).toEqual([]);
      expect(r.active.map((o) => o.pid).sort()).toEqual([a.pid, b.pid].sort());
      expect(r.active.every((o) => o.transport === "stdio")).toBe(true);
      expect(r.active.map((o) => o.lockId).sort()).toEqual(["xiaoai", "xiaoma"]);
    } finally {
      try { process.kill(a.pid, "SIGKILL"); } catch { /* */ }
      try { process.kill(b.pid, "SIGKILL"); } catch { /* */ }
    }
  });

  test("dead pid files → stale (not active); acceptance #3", () => {
    writeFileSync(join(TEST_DIR, "cbrain-http.pid"), "999999");
    writeFileSync(join(TEST_DIR, "cbrain-stdio-old.pid"), "999998");
    const r = PidLock.scanWriters(TEST_DIR);
    expect(r.active).toEqual([]);
    expect(r.stale.sort()).toEqual([
      join(TEST_DIR, "cbrain-http.pid"),
      join(TEST_DIR, "cbrain-stdio-old.pid"),
    ].sort());
  });

  test("excludes the current process (self)", () => {
    writeFileSync(join(TEST_DIR, "cbrain-http.pid"), String(process.pid));
    const r = PidLock.scanWriters(TEST_DIR);
    expect(r.active).toEqual([]);
    expect(r.stale).toEqual([]);
  });

  test("ignores unrelated lookalike files", () => {
    writeFileSync(join(TEST_DIR, "cbrain-https.pid"), "999999");
    writeFileSync(join(TEST_DIR, "cbrain-http.pid.bak"), "999999");
    writeFileSync(join(TEST_DIR, "cbrain-stdio-log.pid.txt"), "999999");
    writeFileSync(join(TEST_DIR, "watcher.lock"), "999999");
    expect(PidLock.scanWriters(TEST_DIR)).toEqual({ active: [], stale: [] });
  });

  test("parses lockId + records startedAt from pid file mtime", () => {
    const child = Bun.spawn({ cmd: ["sleep", "30"], stdout: "ignore", stderr: "ignore" });
    try {
      const f = join(TEST_DIR, "cbrain-stdio-prod.pid");
      writeFileSync(f, String(child.pid));
      const r = PidLock.scanWriters(TEST_DIR);
      expect(r.active).toHaveLength(1);
      expect(r.active[0].pid).toBe(child.pid);
      expect(r.active[0].transport).toBe("stdio");
      expect(r.active[0].lockId).toBe("prod");
      expect(r.active[0].pidFile).toBe(f);
      expect(r.active[0].startedAt).toBeInstanceOf(Date);
    } finally {
      try { process.kill(child.pid, "SIGKILL"); } catch { /* */ }
    }
  });
});

describe("evaluateWriterGate (profile-wide decision)", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("allows when no writers present", () => {
    const g = evaluateWriterGate(TEST_DIR);
    expect(g.allow).toBe(true);
    expect(g.owners).toEqual([]);
    expect(g.cleanedStale).toEqual([]);
    expect(g.bypassed).toBe(false);
  });

  test("denies when a live writer exists", () => {
    const child = Bun.spawn({ cmd: ["sleep", "30"], stdout: "ignore", stderr: "ignore" });
    try {
      writeFileSync(join(TEST_DIR, "cbrain-http.pid"), String(child.pid));
      const g = evaluateWriterGate(TEST_DIR);
      expect(g.allow).toBe(false);
      expect(g.owners).toHaveLength(1);
      expect(g.bypassed).toBe(false);
    } finally {
      try { process.kill(child.pid, "SIGKILL"); } catch { /* */ }
    }
  });

  test("bypass when unsafeBypass=true AND a live writer exists", () => {
    const child = Bun.spawn({ cmd: ["sleep", "30"], stdout: "ignore", stderr: "ignore" });
    try {
      writeFileSync(join(TEST_DIR, "cbrain-stdio-x.pid"), String(child.pid));
      const g = evaluateWriterGate(TEST_DIR, { unsafeBypass: true });
      expect(g.allow).toBe(true);
      expect(g.bypassed).toBe(true);
      expect(g.owners).toHaveLength(1);
    } finally {
      try { process.kill(child.pid, "SIGKILL"); } catch { /* */ }
    }
  });

  test("bypass flag is inert when no live writer exists", () => {
    const g = evaluateWriterGate(TEST_DIR, { unsafeBypass: true });
    expect(g.allow).toBe(true);
    expect(g.bypassed).toBe(false);
  });

  test("removes stale pid files and reports them (acceptance #3)", () => {
    const stale1 = join(TEST_DIR, "cbrain-http.pid");
    const stale2 = join(TEST_DIR, "cbrain-stdio-old.pid");
    writeFileSync(stale1, "999999");
    writeFileSync(stale2, "999998");
    const g = evaluateWriterGate(TEST_DIR);
    expect(g.allow).toBe(true);
    expect(g.cleanedStale.sort()).toEqual([stale1, stale2].sort());
    expect(existsSync(stale1)).toBe(false);
    expect(existsSync(stale2)).toBe(false);
  });
});

describe("PidLock constructor rejects unsafe CBRAIN_LOCK_ID chars", () => {
  test("accepts legal lockId charset [a-zA-Z0-9_-]", () => {
    expect(() => new PidLock(TEST_DIR, "stdio", "xiaoai")).not.toThrow();
    expect(() => new PidLock(TEST_DIR, "http", "prod-2_a")).not.toThrow();
  });

  test("undefined lockId is allowed (plain pid file)", () => {
    expect(() => new PidLock(TEST_DIR, "stdio")).not.toThrow();
  });

  test("rejects lockId chars outside [a-zA-Z0-9_-] (would hide pid file from writer gate)", () => {
    // A '.' in the lockId would write cbrain-stdio-foo.bar.pid, which scanWriters'
    // regex [a-zA-Z0-9_-]+ cannot match → the writer gate would miss it (issue #208).
    expect(() => new PidLock(TEST_DIR, "stdio", "foo.bar")).toThrow(/CBRAIN_LOCK_ID/);
    expect(() => new PidLock(TEST_DIR, "http", "a/b")).toThrow(/CBRAIN_LOCK_ID/);
    expect(() => new PidLock(TEST_DIR, "stdio", "a b")).toThrow(/CBRAIN_LOCK_ID/);
  });
});
