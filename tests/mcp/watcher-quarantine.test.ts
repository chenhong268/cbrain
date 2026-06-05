import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import type { SyncManager } from "../../src/core/sync.js";

function runtimeDir(dbPath: string) {
  return join(dirname(dbPath), "runtime");
}

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
      runtimePath: runtimeDir(dbPath),
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

  test("list includes titleCollisionJson metadata", async () => {
    db.setConfig("watcher.quarantine", JSON.stringify({
      "records/renwu-a-note": {
        failCount: 3,
        lastError: 'Title collision: "人物A"',
        quarantinedAt: "2026-06-01T10:00:00Z",
        titleCollisionJson: {
          title: "人物A",
          incoming: { slug: "records/renwu-a-note", type: "record", filePath: "records/renwu-a-note.md" },
          existing: { slug: "brain/entities/person/renwu-a", type: "entity/person", filePath: "brain/entities/person/renwu-a.md" },
        },
      },
    }));

    const result = await callTool(server, "watcher_quarantine", { action: "list" });
    expect(result.count).toBe(1);
    const entry = result.entries[0];
    expect(entry.slug).toBe("records/renwu-a-note");
    expect(entry.titleCollisionJson).toBeDefined();
    expect(entry.titleCollisionJson.title).toBe("人物A");
    expect(entry.titleCollisionJson.incoming.slug).toBe("records/renwu-a-note");
    expect(entry.titleCollisionJson.incoming.filePath).toBe("records/renwu-a-note.md");
    expect(entry.titleCollisionJson.existing.slug).toBe("brain/entities/person/renwu-a");
    expect(entry.titleCollisionJson.existing.filePath).toBe("brain/entities/person/renwu-a.md");
  });

  test("status includes titleCollisionJson in quarantine entries", async () => {
    db.setConfig("watcher.quarantine", JSON.stringify({
      "records/renwu-a-note": {
        failCount: 3,
        lastError: 'Title collision: "人物A"',
        quarantinedAt: "2026-06-01T10:00:00Z",
        titleCollisionJson: {
          title: "人物A",
          incoming: { slug: "records/renwu-a-note", type: "record", filePath: "records/renwu-a-note.md" },
          existing: { slug: "brain/entities/person/renwu-a", type: "entity/person", filePath: "brain/entities/person/renwu-a.md" },
        },
      },
    }));

    const result = await callTool(server, "status");
    expect(result.quarantineCount).toBe(1);
    expect(result.quarantine[0].titleCollisionJson).toBeDefined();
    expect(result.quarantine[0].titleCollisionJson.title).toBe("人物A");
    expect(result.quarantine[0].titleCollisionJson.incoming.filePath).toBe("records/renwu-a-note.md");
    expect(result.quarantine[0].titleCollisionJson.existing.filePath).toBe("brain/entities/person/renwu-a.md");
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
      runtimePath: runtimeDir(dbPath),
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
      runtimePath: runtimeDir(dbPath),
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
      runtimePath: runtimeDir(dbPath),
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
      runtimePath: runtimeDir(dbPath),
      watcher,
    };
    server = createServer(deps);

    const result = await callTool(server, "watcher_quarantine", { action: "list" });
    expect(result.count).toBe(2);
    const slugs = result.entries.map((e: any) => e.slug).sort();
    expect(slugs).toEqual(["another-stuck", "stuck-file"]);
  });
});

// ── Bulk-change backpressure MCP tools ─────────────────────────────────

describe("MCP watcher bulk_status and bulk_resume", () => {
  const testDir = "/tmp/cbrain-test-mcp-bulk";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let deps: CBrainDeps;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    deps = {
      db,
      embedding: createMockEmbedding(),
      lance: createMockLanceDB() as any,
      vaultPath,
      runtimePath: runtimeDir(dbPath),
    };
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("bulk_status returns not paused when no bulk state", async () => {
    const server = createServer(deps);
    const result = await callTool(server, "watcher_quarantine", { action: "bulk_status" });

    expect(result.bulkPaused).toBe(false);
    expect(result.pendingCount).toBe(0);
    expect(result.threshold).toBe(50);
  });

  test("bulk_status reports paused state from DB", async () => {
    const pendingFiles = Array.from({ length: 60 }, (_, i) => ({
      slug: `bulk${i}`,
      fullPath: `/vault/bulk${i}.md`,
      hash: `hash${i}`,
      mtime: { mtime: Date.now(), size: 100 },
    }));

    db.setConfig("watcher.bulk_pending", JSON.stringify({
      paused: true,
      pendingFiles,
      threshold: 50,
      pausedAt: new Date().toISOString(),
    }));

    const server = createServer(deps);
    const result = await callTool(server, "watcher_quarantine", { action: "bulk_status" });

    expect(result.bulkPaused).toBe(true);
    expect(result.pendingCount).toBe(60);
    expect(result.threshold).toBe(50);
  });

  test("bulk_resume writes resume request when no live watcher", async () => {
    db.setConfig("watcher.bulk_pending", JSON.stringify({
      paused: true,
      pendingFiles: [{ slug: "test", fullPath: "/vault/test.md", hash: "h1", mtime: { mtime: 1, size: 1 } }],
      threshold: 50,
      pausedAt: new Date().toISOString(),
    }));

    const server = createServer(deps);
    const result = await callTool(server, "watcher_quarantine", { action: "bulk_resume" });

    expect(result.success).toBe(true);
    expect(result.pendingResume).toBe(true);
    expect(result.releasedCount).toBe(0);
    expect(result.fullyResumed).toBe(false);
    expect(result.remainingCount).toBe(1);

    // Verify resume request was written (not bulk_pending deleted)
    const req = db.getConfig("watcher.bulk_resume_request");
    expect(req).not.toBeNull();

    // bulk_pending still intact
    const raw = db.getConfig("watcher.bulk_pending");
    expect(raw).not.toBeNull();
  });

  test("bulk_resume with no pending state returns fullyResumed", async () => {
    const server = createServer(deps);
    const result = await callTool(server, "watcher_quarantine", { action: "bulk_resume" });

    expect(result.success).toBe(true);
    expect(result.fullyResumed).toBe(true);
    expect(result.releasedCount).toBe(0);
  });

  test("bulk_resume returns incremental release info with live watcher", async () => {
    const pendingFiles = Array.from({ length: 25 }, (_, i) => ({
      slug: `bulk${i}`,
      fullPath: join(vaultPath, `bulk${i}.md`),
      hash: `hash${i}`,
      mtime: { mtime: 1, size: 1 },
    }));

    db.setConfig("watcher.bulk_pending", JSON.stringify({
      paused: true,
      pendingFiles,
      threshold: 50,
      pausedAt: new Date().toISOString(),
    }));

    const { FileWatcher } = await import("../../src/core/watcher.js");
    const mockSync = {
      syncPage: mock(async () => ({ success: true })),
      removePage: mock(async () => {}),
    } as unknown as SyncManager;

    const reloaded = new FileWatcher(mockSync, vaultPath, { db });
    expect(reloaded.isBulkPaused()).toBe(true);
    expect(reloaded.getBulkStatus().pendingCount).toBe(25);

    const server = createServer({
      ...deps,
      watcher: reloaded,
    });

    // First resume: release 10, 15 remaining
    let result = await callTool(server, "watcher_quarantine", { action: "bulk_resume" });
    expect(result.success).toBe(true);
    expect(result.releasedCount).toBe(10);
    expect(result.remainingCount).toBe(15);
    expect(result.fullyResumed).toBe(false);
    expect(reloaded.isBulkPaused()).toBe(true);

    // Second resume: release 10, 5 remaining
    result = await callTool(server, "watcher_quarantine", { action: "bulk_resume" });
    expect(result.releasedCount).toBe(10);
    expect(result.remainingCount).toBe(5);
    expect(reloaded.isBulkPaused()).toBe(true);

    // Third resume: release 5, fully done
    result = await callTool(server, "watcher_quarantine", { action: "bulk_resume" });
    expect(result.releasedCount).toBe(5);
    expect(result.remainingCount).toBe(0);
    expect(result.fullyResumed).toBe(true);
    expect(reloaded.isBulkPaused()).toBe(false);
  });

  test("status tool includes bulk-pending info", async () => {
    db.setConfig("watcher.bulk_pending", JSON.stringify({
      paused: true,
      pendingFiles: Array.from({ length: 75 }, (_, i) => ({
        slug: `f${i}`, fullPath: `/v/f${i}.md`, hash: `h${i}`, mtime: { mtime: 1, size: 1 },
      })),
      threshold: 50,
      pausedAt: new Date().toISOString(),
    }));

    const server = createServer(deps);
    const result = await callTool(server, "status", {});

    expect(result.bulkPending).toBeDefined();
    expect(result.bulkPending.paused).toBe(true);
    expect(result.bulkPending.pendingCount).toBe(75);
    expect(result.bulkPending.threshold).toBe(50);
  });
});
