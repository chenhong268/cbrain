import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import type { SyncManager } from "../../src/core/sync.js";

function createMockEmbedding(): EmbeddingProvider {
  return {
    dimensions: 128,
    embed: async (text: string) => ({
      embedding: new Array(128).fill(0).map((_, i) => (text.charCodeAt(i % text.length) ?? 0) / 65536),
      tokenCount: text.length,
    }),
    embedBatch: async (texts: string[]) =>
      texts.map((t) => ({
        embedding: new Array(128).fill(0).map((_, i) => (t.charCodeAt(i % t.length) ?? 0) / 65536),
        tokenCount: t.length,
      })),
  };
}

function createMockLanceDB() {
  return {
    connect: async () => {},
    addChunks: async () => {},
    search: async () => [],
    fullTextSearch: async () => [],
    deleteByPageSlug: async () => {},
    deleteRawChunksByPageSlug: async () => {},
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

function getTools(server: unknown) {
  return (server as any)._registeredTools as Record<string, any>;
}

async function callTool(server: unknown, name: string, args: Record<string, unknown> = {}) {
  const tools = getTools(server);
  const tool = tools[name];
  if (!tool) throw new Error(`Tool ${name} not found`);
  const result = await tool.handler(args);
  const text = result.content[0].text;
  return JSON.parse(text);
}

describe("MCP watcher_quarantine tool", () => {
  const testDir = "/tmp/cbrain-test-mcp-quarantine";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let server: any;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    const deps: CBrainDeps = {
      db,
      embedding: createMockEmbedding(),
      lance: createMockLanceDB() as any,
      vaultPath,
    };
    server = createServer(deps);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("list returns empty when no quarantine", async () => {
    const result = await callTool(server, "watcher_quarantine", { action: "list" });
    expect(result.count).toBe(0);
    expect(result.entries).toEqual([]);
  });

  test("list returns quarantine entries from DB", async () => {
    db.setConfig("watcher.quarantine", JSON.stringify({
      "broken-file": { failCount: 5, lastError: "NER timeout", quarantinedAt: "2026-05-27T10:00:00Z" },
      "another-bad": { failCount: 3, lastError: "parse error", quarantinedAt: "2026-05-27T11:00:00Z" },
    }));

    const result = await callTool(server, "watcher_quarantine", { action: "list" });
    expect(result.count).toBe(2);
    const slugs = result.entries.map((e: any) => e.slug).sort();
    expect(slugs).toEqual(["another-bad", "broken-file"]);
  });

  test("release removes one entry from quarantine", async () => {
    db.setConfig("watcher.quarantine", JSON.stringify({
      "broken-file": { failCount: 5, lastError: "NER timeout", quarantinedAt: "2026-05-27T10:00:00Z" },
      "another-bad": { failCount: 3, lastError: "parse error", quarantinedAt: "2026-05-27T11:00:00Z" },
    }));

    const result = await callTool(server, "watcher_quarantine", { action: "release", slug: "broken-file" });
    expect(result.success).toBe(true);
    expect(result.released).toBe("broken-file");
    expect(result.remaining).toBe(1);

    // Verify DB state
    const raw = db.getConfig("watcher.quarantine");
    const parsed = JSON.parse(raw!);
    expect("broken-file" in parsed).toBe(false);
    expect("another-bad" in parsed).toBe(true);
  });

  test("release returns error for non-quarantined slug", async () => {
    const result = await callTool(server, "watcher_quarantine", { action: "release", slug: "nonexistent" });
    expect(result.error).toBeDefined();
  });

  test("release_all clears entire quarantine", async () => {
    db.setConfig("watcher.quarantine", JSON.stringify({
      "broken-file": { failCount: 5, lastError: "NER timeout", quarantinedAt: "2026-05-27T10:00:00Z" },
      "another-bad": { failCount: 3, lastError: "parse error", quarantinedAt: "2026-05-27T11:00:00Z" },
    }));

    const result = await callTool(server, "watcher_quarantine", { action: "release_all" });
    expect(result.success).toBe(true);
    expect(result.released).toBe(2);

    // Verify DB state
    expect(db.getConfig("watcher.quarantine")).toBeNull();
  });

  test("status tool includes quarantine details", async () => {
    db.setConfig("watcher.quarantine", JSON.stringify({
      "broken-file": { failCount: 5, lastError: "NER timeout", quarantinedAt: "2026-05-27T10:00:00Z" },
    }));

    const result = await callTool(server, "status");
    expect(result.quarantineCount).toBe(1);
    expect(result.quarantine.length).toBe(1);
    expect(result.quarantine[0].slug).toBe("broken-file");
    expect(result.quarantine[0].lastError).toBe("NER timeout");
  });
});

describe("MCP watcher_quarantine with live FileWatcher", () => {
  const testDir = "/tmp/cbrain-test-mcp-watcher-live";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let server: any;

  function createMockSync(): SyncManager {
    return {
      syncPage: mock(async (_slug: string, _vaultPath: string) => ({ success: true })),
      removePage: mock((_slug: string) => {}),
    } as unknown as SyncManager;
  }

  function createWatcherDeps() {
    db = new CBrainDB(dbPath);
    const sync = createMockSync();
    // FileWatcher needs a real-ish vault dir
    mkdirSync(vaultPath, { recursive: true });
    const { FileWatcher } = require("../../src/core/watcher.js") as typeof import("../../src/core/watcher.js");
    // Manually inject quarantine entries into the DB
    // (simulating files that were quarantined during previous watcher runs)
    const quarantineData: Record<string, { failCount: number; lastError: string; quarantinedAt: string; hash?: string; fullPath?: string }> = {
      "stuck-file": { failCount: 5, lastError: "parse error", quarantinedAt: "2026-05-28T10:00:00Z", hash: "abc123", fullPath: join(vaultPath, "stuck-file.md") },
      "another-stuck": { failCount: 4, lastError: "NER timeout", quarantinedAt: "2026-05-28T11:00:00Z", hash: "def456", fullPath: join(vaultPath, "another-stuck.md") },
    };
    db.setConfig("watcher.quarantine", JSON.stringify(quarantineData));
    // Reload quarantine from DB
    const freshWatcher = new FileWatcher(sync, vaultPath, { db });
    return { db, watcher: freshWatcher };
  }

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
  });

  afterEach(() => {
    db?.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("release via MCP syncs with live watcher memory", async () => {
    const { db: liveDb, watcher } = createWatcherDeps();
    db = liveDb;
    expect(watcher.getQuarantineSize()).toBe(2);

    const deps: CBrainDeps = {
      db: liveDb,
      embedding: createMockEmbedding(),
      lance: createMockLanceDB() as any,
      vaultPath,
      watcher,
    };
    server = createServer(deps);

    const result = await callTool(server, "watcher_quarantine", { action: "release", slug: "stuck-file" });
    expect(result.success).toBe(true);
    expect(result.released).toBe("stuck-file");
    expect(result.remaining).toBe(1);

    // Verify watcher's in-memory state was updated
    expect(watcher.getQuarantineSize()).toBe(1);
    expect(watcher.getQuarantineEntries().map(e => e.slug)).toEqual(["another-stuck"]);

    // Verify DB was also updated (watcher.releaseEntry calls persistQuarantine)
    const raw = liveDb.getConfig("watcher.quarantine");
    const parsed = JSON.parse(raw!);
    expect("stuck-file" in parsed).toBe(false);
    expect("another-stuck" in parsed).toBe(true);
  });

  test("release_all via MCP clears watcher memory entirely", async () => {
    const { db: liveDb, watcher } = createWatcherDeps();
    db = liveDb;

    const deps: CBrainDeps = {
      db: liveDb,
      embedding: createMockEmbedding(),
      lance: createMockLanceDB() as any,
      vaultPath,
      watcher,
    };
    server = createServer(deps);

    const result = await callTool(server, "watcher_quarantine", { action: "release_all" });
    expect(result.success).toBe(true);
    expect(result.released).toBe(2);

    // Both in-memory and DB should be clean
    expect(watcher.getQuarantineSize()).toBe(0);
    expect(liveDb.getConfig("watcher.quarantine")).toBeNull();
  });

  test("release on non-quarantined slug returns error even with live watcher", async () => {
    const { db: liveDb, watcher } = createWatcherDeps();
    db = liveDb;

    const deps: CBrainDeps = {
      db: liveDb,
      embedding: createMockEmbedding(),
      lance: createMockLanceDB() as any,
      vaultPath,
      watcher,
    };
    server = createServer(deps);

    const result = await callTool(server, "watcher_quarantine", { action: "release", slug: "ghost" });
    expect(result.error).toBeDefined();
    expect(watcher.getQuarantineSize()).toBe(2); // unchanged
  });

  test("list shows correct entries from watcher-persisted DB", async () => {
    const { db: liveDb, watcher } = createWatcherDeps();
    db = liveDb;

    const deps: CBrainDeps = {
      db: liveDb,
      embedding: createMockEmbedding(),
      lance: createMockLanceDB() as any,
      vaultPath,
      watcher,
    };
    server = createServer(deps);

    const result = await callTool(server, "watcher_quarantine", { action: "list" });
    expect(result.count).toBe(2);
    const slugs = result.entries.map((e: any) => e.slug).sort();
    expect(slugs).toEqual(["another-stuck", "stuck-file"]);
  });
});
