import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import type { SyncManager } from "../../src/core/sync.js";
import { performGracefulShutdown, type ShutdownHandles } from "../../src/cli/commands/server.js";

const PROJECT_ROOT = process.cwd();

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        s.close(() => resolve(port));
      } else {
        s.close(() => reject(new Error("Failed to get port")));
      }
    });
    s.on("error", reject);
  });
}

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
    const port = await getAvailablePort();

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
    const watcher = new FileWatcher(noOpSync as unknown as SyncManager, vaultPath, { db });
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
    await watcher.stop();
  });

  test("watcher picks up DB-side release_all on next scan", async () => {
    seedQuarantine({ "fail1": {}, "fail2": {} });

    const watcher = new FileWatcher(noOpSync as unknown as SyncManager, vaultPath, { db });
    expect(watcher.getQuarantineSize()).toBe(2);

    // Context 2: Agent's MCP releases all via DB
    db.deleteConfig("watcher.quarantine");
    expect(db.getConfig("watcher.quarantine")).toBeNull();

    // Context 1: next scan picks up the change
    await watcher.scanOnce();

    expect(watcher.getQuarantineSize()).toBe(0);
    await watcher.stop();
  });

  test("watcher re-syncs partial DB release", async () => {
    seedQuarantine({ "fail-a": {}, "fail-b": {} });

    const watcher = new FileWatcher(noOpSync as unknown as SyncManager, vaultPath, { db });
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
    await watcher.stop();
  });
});

// ─── performGracefulShutdown ordering (issue #186) ─────
//
// Proves the shutdown ordering contract deterministically with fakes:
// ownership locks are released strictly AFTER the watcher drain (stop) resolves,
// HTTP/MCP/jobs are stopped before drain begins, and a sync error during stop
// never skips lock release. No real subprocess needed.

describe("performGracefulShutdown ordering", () => {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  test("releases ownership locks only after watcher stop resolves", async () => {
    let resolveStop!: () => void;
    const blocker = new Promise<void>((r) => { resolveStop = r; });
    const order: string[] = [];
    const handles = {
      stopJobs: () => { order.push("stopJobs"); },
      stopMcp: () => { order.push("stopMcp"); },
      httpServer: { stop: () => { order.push("httpStop"); } },
      watcher: {
        stop: () => {
          order.push("stopStart");
          return blocker.then(() => {
            order.push("stopEnd");
            return { drained: true, activeCount: 0, pendingCount: 0 };
          });
        },
      },
      watcherLock: { release: () => { order.push("watcherLock"); } },
      pidLock: { release: () => { order.push("pidLock"); } },
    } as unknown as ShutdownHandles;

    const shutdown = performGracefulShutdown(handles);
    await sleep(20);
    // drain started; HTTP/MCP/jobs stopped; locks NOT yet released
    expect(order).toEqual(["stopJobs", "stopMcp", "httpStop", "stopStart"]);

    resolveStop();
    await shutdown;
    expect(order).toEqual([
      "stopJobs", "stopMcp", "httpStop",
      "stopStart", "stopEnd",
      "watcherLock", "pidLock",
    ]);
  });

  test("releases locks even when watcher stop rejects (sync error during shutdown)", async () => {
    const order: string[] = [];
    const handles = {
      stopJobs: () => {},
      stopMcp: () => {},
      httpServer: { stop: () => {} },
      watcher: { stop: async () => { throw new Error("drain boom"); } },
      watcherLock: { release: () => { order.push("watcherLock"); } },
      pidLock: { release: () => { order.push("pidLock"); } },
    } as unknown as ShutdownHandles;

    // Must not throw and must release both locks despite stop() rejection.
    await expect(performGracefulShutdown(handles)).resolves.toBeUndefined();
    expect(order).toEqual(["watcherLock", "pidLock"]);
  });

  test("logs sanitized timeout diagnostic (counts only) when stop returns drained:false", async () => {
    const errorMock = mock((..._args: unknown[]) => undefined);
    const realError = console.error;
    console.error = errorMock;
    try {
      const handles = {
        stopJobs: () => {},
        stopMcp: () => {},
        httpServer: { stop: () => {} },
        watcher: { stop: async () => ({ drained: false, activeCount: 2, pendingCount: 0 }) },
        watcherLock: { release() {} },
        pidLock: { release() {} },
      } as unknown as ShutdownHandles;
      await performGracefulShutdown(handles);
    } finally {
      console.error = realError;
    }

    expect(errorMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    const msg = (errorMock.mock.calls[0] as unknown[]).join(" ");
    expect(msg).toMatch(/timed out/);
    expect(msg).toContain("active=2");
    expect(msg).toContain("pending=0");
    // sanitized: no vault path / file extension / content leaks
    expect(msg).not.toMatch(/\/tmp|\.md|secret/i);
  });
});

// ─── Profile-wide single-writer gate (issue #208 phase 1) ─────
//
// Proves the CLI refuses a second write-capable runtime for the same profile
// BEFORE SQLite/LanceDB is opened (no "LanceDB warmed up" on the refused process),
// auto-cleans stale pid files, and honors the hidden UNSAFE bypass env.

describe("profile-wide single-writer gate (issue #208)", () => {
  const testDir = "/tmp/cbrain-test-writer-gate";
  const vaultPath = join(testDir, "vault");
  const dbPath = join(testDir, "brain.sqlite");
  const lancePath = join(testDir, "lancedb");
  const configPath = join(testDir, "cbrain.json");

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    mkdirSync(lancePath, { recursive: true });
    // deterministic embedding (#204): no API key, no network — clean offline test
    writeFileSync(configPath, JSON.stringify({
      vaultPath,
      dbPath,
      lancePath,
      embedding: { provider: "deterministic" },
      ner: { enabled: false },
    }));
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("second stdio serve is refused while HTTP owner is alive (AC #1, #4)", async () => {
    const port = await getAvailablePort();
    const owner = spawn("bun", [
      join(PROJECT_ROOT, "src/cli/index.ts"),
      "serve", "--http", "--port", String(port),
    ], {
      cwd: testDir,
      stdio: "pipe",
      env: { ...process.env, CBRAIN_CONFIG: configPath },
    });

    try {
      expect(await waitForHealth(port)).toBe(true);

      const challenger = spawn("bun", [
        join(PROJECT_ROOT, "src/cli/index.ts"),
        "serve",
      ], {
        cwd: testDir,
        stdio: "pipe",
        env: { ...process.env, CBRAIN_CONFIG: configPath },
      });
      let chStderr = "";
      challenger.stderr!.on("data", (d: Buffer) => { chStderr += d.toString(); });

      const code = await waitForExit(challenger);
      expect(code).toBe(1);
      expect(chStderr).toMatch(/refused to start/i);
      expect(chStderr).toMatch(/writer/i);
      // Gate ran BEFORE lance.connect() → no warmup line on the refused process
      expect(chStderr).not.toMatch(/LanceDB warmed up/);
    } finally {
      owner.kill("SIGTERM");
      await waitForExit(owner);
    }
  }, 30_000);

  test("auto-cleans a stale pid file so a clean start succeeds (AC #3)", async () => {
    const port = await getAvailablePort();
    // pre-seed a stale (dead) http pid file from a "previous crashed" owner
    writeFileSync(join(testDir, "cbrain-http.pid"), "999999");

    const owner = spawn("bun", [
      join(PROJECT_ROOT, "src/cli/index.ts"),
      "serve", "--http", "--port", String(port),
    ], {
      cwd: testDir,
      stdio: "pipe",
      env: { ...process.env, CBRAIN_CONFIG: configPath },
    });
    let stderr = "";
    owner.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

    try {
      // stale file is removed by the gate; owner still boots
      expect(await waitForHealth(port)).toBe(true);
      expect(stderr).toMatch(/Cleaned 1 stale/i);
    } finally {
      owner.kill("SIGTERM");
      await waitForExit(owner);
    }
  }, 30_000);

  test("CBRAIN_UNSAFE_ALLOW_MULTI_WRITER=1 bypasses gate with UNSAFE banner", async () => {
    const port = await getAvailablePort();
    const owner = spawn("bun", [
      join(PROJECT_ROOT, "src/cli/index.ts"),
      "serve", "--http", "--port", String(port),
    ], {
      cwd: testDir,
      stdio: "pipe",
      env: { ...process.env, CBRAIN_CONFIG: configPath },
    });

    try {
      expect(await waitForHealth(port)).toBe(true);

      const challenger = spawn("bun", [
        join(PROJECT_ROOT, "src/cli/index.ts"),
        "serve",
      ], {
        cwd: testDir,
        stdio: "pipe",
        env: {
          ...process.env,
          CBRAIN_CONFIG: configPath,
          CBRAIN_UNSAFE_ALLOW_MULTI_WRITER: "1",
        },
      });
      let chStderr = "";
      challenger.stderr!.on("data", (d: Buffer) => { chStderr += d.toString(); });

      // bypass → UNSAFE banner printed early (before createDeps), not refused
      await new Promise((r) => setTimeout(r, 2500));
      expect(chStderr).toMatch(/UNSAFE/);
      expect(chStderr).not.toMatch(/refused to start/);
      // gate truly let it through to DB open (not a false pass from an unrelated crash)
      expect(chStderr).toMatch(/LanceDB warmed up/);
      challenger.kill("SIGKILL");
      await waitForExit(challenger);
    } finally {
      owner.kill("SIGTERM");
      await waitForExit(owner);
    }
  }, 30_000);
});

// ─── MCP-over-HTTP endpoint (issue #213) ──────────────────
//
// Proves serve --http exposes /mcp: a real MCP client initializes, lists the same tool
// set as stdio, and calls a read-only tool (status) over HTTP against the single shared
// runtime. Also proves session cleanup (DELETE) so the session map cannot grow unbounded.

describe("MCP-over-HTTP endpoint (issue #213)", () => {
  const testDir = "/tmp/cbrain-test-mcp-http";
  const vaultPath = join(testDir, "vault");
  const dbPath = join(testDir, "brain.sqlite");
  const lancePath = join(testDir, "lancedb");
  const configPath = join(testDir, "cbrain.json");

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    mkdirSync(lancePath, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      vaultPath,
      dbPath,
      lancePath,
      embedding: { provider: "deterministic" },
      ner: { enabled: false },
    }));
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("client initializes, lists tools, calls read-only 'status' over /mcp", async () => {
    const port = await getAvailablePort();
    const child = spawn("bun", [
      join(PROJECT_ROOT, "src/cli/index.ts"),
      "serve", "--http", "--port", String(port),
    ], {
      cwd: testDir,
      stdio: "pipe",
      env: { ...process.env, CBRAIN_CONFIG: configPath },
    });

    try {
      expect(await waitForHealth(port)).toBe(true);

      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
      const client = new Client({ name: "smoke-test", version: "1.0" });
      await client.connect(transport); // initialize handshake

      // Same tool registry as stdio — status must be present
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(20);
      expect(tools.map((t) => t.name)).toContain("status");

      // Read-only tool call over HTTP returns a valid result
      const result = await client.callTool({ name: "status", arguments: {} });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content).toBeInstanceOf(Array);
      expect(content.length).toBeGreaterThan(0);
      const parsed = JSON.parse(content[0].text);
      expect(parsed).toHaveProperty("totalPages");
      expect(parsed).toHaveProperty("vaultPath");

      await client.close();
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child);
    }
  }, 30_000);

  test("two MCP clients get independent sessions on the shared runtime", async () => {
    const port = await getAvailablePort();
    const child = spawn("bun", [
      join(PROJECT_ROOT, "src/cli/index.ts"),
      "serve", "--http", "--port", String(port),
    ], {
      cwd: testDir,
      stdio: "pipe",
      env: { ...process.env, CBRAIN_CONFIG: configPath },
    });

    try {
      expect(await waitForHealth(port)).toBe(true);
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

      const a = new Client({ name: "agent-a", version: "1.0" });
      const b = new Client({ name: "agent-b", version: "1.0" });
      await a.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      await b.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));

      // Both clients operate independently; both see the shared tool set, no extra runtime
      const ta = await a.listTools();
      const tb = await b.listTools();
      expect(ta.tools.length).toBe(tb.tools.length);
      expect(ta.tools.length).toBeGreaterThan(20);

      await a.close();
      await b.close();
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child);
    }
  }, 30_000);

  test("DELETE /mcp removes the session (cleanup — no unbounded growth)", async () => {
    const port = await getAvailablePort();
    const child = spawn("bun", [
      join(PROJECT_ROOT, "src/cli/index.ts"),
      "serve", "--http", "--port", String(port),
    ], {
      cwd: testDir,
      stdio: "pipe",
      env: { ...process.env, CBRAIN_CONFIG: configPath },
    });

    try {
      expect(await waitForHealth(port)).toBe(true);
      const base = `http://127.0.0.1:${port}/mcp`;

      // raw initialize → server returns a session id
      const initResp = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", "accept": "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
        }),
      });
      const sessionId = initResp.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();

      // DELETE tears the session down
      const delResp = await fetch(base, {
        method: "DELETE",
        headers: { "mcp-session-id": sessionId as string },
      });
      expect(delResp.status).toBe(200);

      // the old session id is now rejected (session was cleaned up, not retained)
      const postResp = await fetch(base, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
          "mcp-session-id": sessionId as string,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      expect(postResp.status).toBe(404);
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child);
    }
  }, 30_000);
});
