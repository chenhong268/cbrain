import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const PROJECT_ROOT = process.cwd();

async function waitForHealth(port: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/health`);
      if (resp.ok) return true;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<number | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(-1);
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

describe("serve --http subprocess shutdown", () => {
  const testDir = "/tmp/cbrain-test-serve-shutdown";
  const vaultPath = join(testDir, "vault");
  const dbPath = join(testDir, "brain.sqlite");
  const lancePath = join(testDir, "lancedb");
  const port = 19876;
  const configPath = join(testDir, "cbrain.json");
  const pidFile = join(testDir, "cbrain-http.pid");
  const watcherLockFile = join(testDir, ".watcher.lock");

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    mkdirSync(lancePath, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      vaultPath,
      dbPath,
      lancePath,
      embedding: { provider: "zhipu", apiKey: "fake-key-for-test" },
      ner: { enabled: false },
    }));
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("SIGTERM stops real serve --http, releases PID lock + watcher lock, frees port", async () => {
    const child = spawn("bun", [
      join(PROJECT_ROOT, "src/cli/index.ts"),
      "serve", "--http", "--port", String(port), "--force",
    ], {
      cwd: testDir,
      stdio: "pipe",
      env: {
        ...process.env,
        CBRAIN_CONFIG: configPath,
        ZHIPU_API_KEY: "fake-key-for-test",
      },
    });

    let stderr = "";
    child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

    // Detect early crash (before /health is ready)
    let earlyExit = false;
    child.on("exit", (code) => { if (code !== null && !child.killed) earlyExit = true; });

    // Wait for /health to respond — proves HTTP server is fully up
    const healthy = await waitForHealth(port);
    if (!healthy) {
      child.kill("SIGKILL");
      await waitForExit(child);
      throw new Error(`Server never became healthy (earlyExit=${earlyExit}). stderr:\n${stderr}`);
    }

    // While running: PID lock and watcher lock should exist
    expect(existsSync(pidFile)).toBe(true);
    expect(existsSync(watcherLockFile)).toBe(true);

    // Send SIGTERM
    child.kill("SIGTERM");
    const exitCode = await waitForExit(child);

    // Process should exit cleanly, not hang
    expect(exitCode).not.toBe(-1);

    // PID lock should be cleaned up
    if (existsSync(pidFile)) {
      const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      expect(pid).not.toBe(child.pid);
    }

    // Watcher lock should be cleaned up
    if (existsSync(watcherLockFile)) {
      const owner = JSON.parse(readFileSync(watcherLockFile, "utf-8"));
      expect(owner.pid).not.toBe(child.pid);
    }

    // Port should be immediately rebindable
    const rebound = await new Promise<boolean>((resolve) => {
      try {
        const s = Bun.serve({
          port,
          hostname: "127.0.0.1",
          fetch() { return new Response("rebound"); },
        });
        s.stop(true);
        resolve(true);
      } catch {
        resolve(false);
      }
    });
    expect(rebound).toBe(true);
  }, 30_000);
});

// ─── Dual-context quarantine release ─────────────────────
//
// Tests verify that when MCP (stdio process) modifies quarantine in DB,
// the watcher (HTTP process) picks up changes on next scan via syncQuarantineFromDb().
//
// Strategy: pre-seed quarantine in DB, create watcher (loads from DB on construction),
// then modify DB and verify watcher syncs on next scanOnce().

describe("Cross-process quarantine release (dual context)", () => {
  const testDir = "/tmp/cbrain-test-cross-quarantine";
  const dbPath = join(testDir, "brain.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: any;

  const { CBrainDB } = require("../../src/storage/sqlite.js") as typeof import("../../src/storage/sqlite.js");
  const { FileWatcher } = require("../../src/core/watcher.js") as typeof import("../../src/core/watcher.js");

  const noOpSync = {
    syncPage: async () => ({ success: true }),
    removePage: () => {},
  };

  function seedQuarantine(entries: Record<string, { failCount?: number; lastError?: string; quarantinedAt?: string; hash?: string; fullPath?: string }>) {
    const obj: Record<string, any> = {};
    for (const [slug, e] of Object.entries(entries)) {
      obj[slug] = {
        failCount: e.failCount ?? 3,
        lastError: e.lastError ?? "test error",
        quarantinedAt: e.quarantinedAt ?? new Date().toISOString(),
        hash: e.hash,
        fullPath: e.fullPath,
      };
    }
    db.setConfig("watcher.quarantine", JSON.stringify(obj));
  }

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("watcher picks up DB-side quarantine release on next scan", async () => {
    // Pre-seed quarantine in DB (simulates previous scan failures that persisted)
    seedQuarantine({ "fail": {} });

    // Context 1: watcher owner process — loads quarantine from DB on construction
    const watcher = new FileWatcher(noOpSync, vaultPath, { db });
    expect(watcher.getQuarantineSize()).toBe(1);

    // Context 2: Agent's stdio MCP process — modifies DB directly (no ctx.watcher)
    // Simulates: MCP tool `watcher_quarantine release` without live watcher reference
    const raw = db.getConfig("watcher.quarantine");
    const parsed = JSON.parse(raw!);
    delete parsed["fail"];
    db.setConfig("watcher.quarantine", JSON.stringify(parsed));
    expect(JSON.parse(db.getConfig("watcher.quarantine")!)).toEqual({});

    // Context 1: next scan cycle — watcher syncs quarantine from DB via syncQuarantineFromDb()
    await watcher.scanOnce();

    expect(watcher.getQuarantineSize()).toBe(0);
    watcher.stop();
  });

  test("watcher picks up DB-side release_all on next scan", async () => {
    seedQuarantine({ "fail1": {}, "fail2": {} });

    const watcher = new FileWatcher(noOpSync, vaultPath, { db });
    expect(watcher.getQuarantineSize()).toBe(2);

    // Context 2: Agent's MCP releases all via DB
    db.deleteConfig("watcher.quarantine");
    expect(db.getConfig("watcher.quarantine")).toBeNull();

    // Context 1: next scan picks up the change
    await watcher.scanOnce();

    expect(watcher.getQuarantineSize()).toBe(0);
    watcher.stop();
  });

  test("watcher re-syncs partial DB release", async () => {
    seedQuarantine({ "fail-a": {}, "fail-b": {} });

    const watcher = new FileWatcher(noOpSync, vaultPath, { db });
    expect(watcher.getQuarantineSize()).toBe(2);

    // Context 2: MCP releases only fail-a via DB
    const raw = db.getConfig("watcher.quarantine");
    const parsed = JSON.parse(raw!);
    delete parsed["fail-a"];
    db.setConfig("watcher.quarantine", JSON.stringify(parsed));

    // Context 1: next scan
    await watcher.scanOnce();

    expect(watcher.getQuarantineSize()).toBe(1);
    const remaining = watcher.getQuarantineEntries();
    expect(remaining[0].slug).toBe("fail-b");
    watcher.stop();
  });
});
