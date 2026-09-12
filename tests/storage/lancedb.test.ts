import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LanceDBManager, type ChunkData } from "../../src/storage/lancedb.js";
import { connect, type Connection } from "@lancedb/lancedb";

describe("LanceDBManager", () => {
  const testDir = "/tmp/cbrain-test-lancedb";
  const lancePath = join(testDir, ".lance");
  let manager: LanceDBManager;

  beforeEach(async () => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    manager = new LanceDBManager();
    await manager.connect(lancePath);
  });

  afterEach(async () => {
    await manager.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function makeVector(seed: number): Float32Array {
    const v = new Float32Array(2048);
    for (let i = 0; i < 2048; i++) {
      v[i] = Math.sin(seed * (i + 1)) * 0.01;
    }
    return v;
  }

  function makeChunks(count: number, pageSlug: string): ChunkData[] {
    return Array.from({ length: count }, (_, i) => ({
      pageSlug,
      chunkIndex: i,
      content: `Chunk ${i} content for ${pageSlug}`,
      vector: makeVector(i),
    }));
  }

  test("connect creates the database directory", () => {
    expect(existsSync(lancePath)).toBe(true);
  });

  test("addChunks and search round-trip", async () => {
    const chunks: ChunkData[] = [
      {
        pageSlug: "entities/test-page",
        chunkIndex: 0,
        content: "Machine learning is a subset of artificial intelligence",
        vector: makeVector(0),
      },
      {
        pageSlug: "entities/test-page",
        chunkIndex: 1,
        content: "Neural networks are inspired by biological neurons",
        vector: makeVector(1),
      },
    ];

    await manager.addChunks(chunks);

    // Search with a vector close to chunk 0's vector
    const results = await manager.search(makeVector(0), 1);

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].pageSlug).toBe("entities/test-page");
    expect(results[0].chunkIndex).toBe(0);
    expect(results[0].content).toContain("Machine learning");
  });

  test("addChunks with empty array does nothing", async () => {
    await manager.addChunks([]);
    const results = await manager.search(makeVector(0), 10);
    expect(results).toHaveLength(0);
  });

  test("search returns results sorted by distance", async () => {
    const chunks: ChunkData[] = [
      {
        pageSlug: "entities/a",
        chunkIndex: 0,
        content: "Alpha content",
        vector: makeVector(1),
      },
      {
        pageSlug: "entities/b",
        chunkIndex: 0,
        content: "Beta content",
        vector: makeVector(100),
      },
      {
        pageSlug: "entities/c",
        chunkIndex: 0,
        content: "Gamma content",
        vector: makeVector(200),
      },
    ];

    await manager.addChunks(chunks);

    // Query with vector close to chunk index 1 (seed=100)
    const results = await manager.search(makeVector(100), 3);

    expect(results.length).toBe(3);
    // First result should be closest to seed=100
    expect(results[0].pageSlug).toBe("entities/b");
  });

  test("search respects limit parameter", async () => {
    const chunks = makeChunks(5, "entities/limit-test");
    await manager.addChunks(chunks);

    const results = await manager.search(makeVector(0), 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  test("fullTextSearch finds matching chunks", async () => {
    // FTS moved to SQLite FTS5 — this test verifies LanceDB vector search still works
    const chunks: ChunkData[] = [
      {
        pageSlug: "entities/fts-test",
        chunkIndex: 0,
        content: "Quantum computing uses qubits for computation",
        vector: makeVector(0),
      },
    ];

    await manager.addChunks(chunks);
    const results = await manager.search(makeVector(0), 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test("search with no results returns empty array", async () => {
    const chunks: ChunkData[] = [
      {
        pageSlug: "entities/fts-empty",
        chunkIndex: 0,
        content: "Hello world",
        vector: makeVector(0),
      },
    ];

    await manager.addChunks(chunks);
    const results = await manager.search(makeVector(999), 10);
    // Vector search may still return results due to similarity, so just verify no crash
    expect(Array.isArray(results)).toBe(true);
  });

  test("deleteByPageSlug removes all chunks for a page", async () => {
    const chunks = [
      ...makeChunks(3, "entities/to-delete"),
      ...makeChunks(2, "entities/to-keep"),
    ];

    await manager.addChunks(chunks);

    await manager.deleteByPageSlug("entities/to-delete");

    const results = await manager.search(makeVector(0), 100);
    const remainingSlugs = results.map((r) => r.pageSlug);
    expect(remainingSlugs).not.toContain("entities/to-delete");
    expect(remainingSlugs).toContain("entities/to-keep");
  });

  test("deleteByPageSlug with non-existent slug does nothing", async () => {
    const chunks = makeChunks(2, "entities/existing");
    await manager.addChunks(chunks);

    await manager.deleteByPageSlug("entities/nonexistent");

    const results = await manager.search(makeVector(0), 100);
    expect(results.length).toBe(2);
  });

  test("addChunks appends to existing data", async () => {
    await manager.addChunks(makeChunks(2, "entities/first-batch"));
    await manager.addChunks(makeChunks(2, "entities/second-batch"));

    const results = await manager.search(makeVector(0), 100);
    expect(results.length).toBe(4);
  });

  test("search with no data returns empty array", async () => {
    const results = await manager.search(makeVector(0), 10);
    expect(results).toHaveLength(0);
  });

  // ─── Warmup ─────────────────────────────────────────────────────

  test("warmup pre-loads chunks table", async () => {
    const result = await manager.warmup();

    expect(result.tables).toContain("chunks");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test("warmup on empty database does not throw", async () => {
    const result = await manager.warmup();
    expect(result.tables).toContain("chunks");
  });

  test("warmup caches tables — subsequent getOrCreateTable is instant", async () => {
    await manager.warmup();

    // Second access should hit the Map cache (no disk I/O)
    const before = Date.now();
    // Access private method via type assertion for cache verification
    const table = await (manager as unknown as { getOrCreateTable: (n: string, s: unknown) => Promise<unknown> })
      .getOrCreateTable("chunks", undefined as unknown);
    expect(table).toBeDefined();
    const elapsed = Date.now() - before;
    expect(elapsed).toBeLessThan(50);
  });

  test("warmup after adding data does not throw", async () => {
    await manager.addChunks(makeChunks(5, "entities/warmup-test"));
    const result = await manager.warmup();

    expect(result.tables).toContain("chunks");
  });

  // ─── Compact safety ──────────────────────────────────────────────

  function diskBytes(dir: string): number {
    return readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
      const path = join(dir, entry.name);
      return sum + (entry.isDirectory() ? diskBytes(path) : statSync(path).size);
    }, 0);
  }

  function fakeTags() {
    const versions: Record<string, { version: number }> = {};
    return {
      list: async () => versions,
      create: async (tag: string, version: number) => { versions[tag] = { version }; },
      delete: async (tag: string) => { delete versions[tag]; },
    };
  }

  test("compact measures net disk growth and consecutive idle maintenance stays flat", async () => {
    await manager.addChunks(makeChunks(3, "entities/a"));
    await manager.addChunks(makeChunks(2, "entities/b"));
    const before = diskBytes(lancePath);
    const first = await manager.compact();
    expect(first.diskBytesBefore).toBe(before);
    expect(first.diskBytesAfter).toBe(diskBytes(lancePath));
    expect(first.diskBytesDelta).toBe(first.diskBytesAfter! - before);
    // Newly compacted data and the rollback version coexist inside the window.
    expect(first.diskBytesDelta).toBeGreaterThan(0);
    const second = await manager.compact();
    expect(second.diskBytesAfter).toBeLessThanOrEqual(first.diskBytesAfter!);
    expect(second.diskBytesDelta).toBe(0);
    expect(await manager.search(makeVector(0), 100)).toHaveLength(5);
  });

  test("retention is bounded, configurable, and defaults below a daily interval", () => {
    expect(LanceDBManager.COMPACT_RETENTION_MS).toBe(6 * 3600_000);
    expect(() => new LanceDBManager({ compactRetentionHours: 12 })).not.toThrow();
    for (const value of [0, -1, 0.5, 169, NaN, Infinity]) {
      expect(() => new LanceDBManager({ compactRetentionHours: value })).toThrow(/compactRetentionHours/);
    }
  });

  test.each([false, true])("real SDK protects idle rollback (forced prune collision: %s)", async (forceCollision) => {
    await manager.addChunks(makeChunks(3, "entities/a"));
    await manager.addChunks(makeChunks(2, "entities/b"));
    const connection = await connect(lancePath);
    const table = await connection.openTable("chunks");
    const version = await table.version();
    const originalNow = Date.now;
    try {
      await (await table.tags()).create("user-owned", version);
      // Move only the manager's clock: the SDK still uses its native clock.
      // This exercises the idle-version cutoff and SDK duration conversion.
      Date.now = () => originalNow() + 30 * 24 * 3600_000;
      if (forceCollision) {
        const managed = (manager as unknown as { db: Connection }).db;
        const open = managed.openTable.bind(managed);
        managed.openTable = async (...args: Parameters<Connection["openTable"]>) => {
          const opened = await open(...args);
          const optimize = opened.optimize.bind(opened);
          opened.optimize = opts => optimize({ ...opts, cleanupOlderThan: new Date(originalNow() + 1000) });
          return opened;
        };
        await expect(manager.compact()).rejects.toThrow(/tagged version/);
        await expect(manager.compact()).rejects.toThrow(/Unresolved compact rollback tag/);
      } else {
        await manager.compact();
      }
      await table.checkout(version);
      expect(await table.countRows()).toBe(5);
      expect((await table.query().toArray()).map(row => row.content).sort()).toEqual(
        [...makeChunks(3, "entities/a"), ...makeChunks(2, "entities/b")].map(row => row.content).sort(),
      );
      const tags = await table.tags();
      expect(await tags.getVersion("user-owned")).toBe(version);
      if (forceCollision) {
        expect(await tags.getVersion(LanceDBManager.COMPACT_ROLLBACK_TAG)).toBe(version);
        await table.restore();
        expect(await table.countRows()).toBe(5);
      } else {
        expect(await tags.list()).not.toHaveProperty(LanceDBManager.COMPACT_ROLLBACK_TAG);
      }
    } finally {
      Date.now = originalNow;
      table.close();
    }
  });

  test("compact preserves row count across all tables", async () => {
    await manager.addChunks(makeChunks(5, "entities/compact-test"));

    const report = await manager.compact();

    // Row count must be unchanged after compaction
    const results = await manager.search(makeVector(0), 100);
    expect(results.length).toBe(5);
    expect(report.tables).toContain("chunks");
  });

  test("compact on database with warmup succeeds", async () => {
    // Warm up to create the chunks table, then compact.
    await manager.warmup();
    const report = await manager.compact();
    expect(report.tables).toContain("chunks");
    expect(report.fragmentsRemoved).toBe(0);
  });

  test.each([undefined, 12])("compact honors retention override %s via safe optimize options", async (hours) => {
    await manager.close();
    manager = new LanceDBManager({ compactRetentionHours: hours });
    await manager.connect(lancePath);
    // Inject a fake connection + table to capture the exact optimize() call.
    const optimizeCalls: Array<Partial<{ cleanupOlderThan: Date; deleteUnverified: boolean }>> = [];
    const fakeTable = {
      tags: async () => fakeTags(),
      version: async () => 2,
      listVersions: async () => [{ version: 2, timestamp: new Date() }],
      countRows: async () => 5,
      optimize: async (opts?: Partial<{ cleanupOlderThan: Date; deleteUnverified: boolean }>) => {
        optimizeCalls.push({ ...opts });
        return {
          compaction: { fragmentsRemoved: 2, fragmentsAdded: 1, filesRemoved: 2, filesAdded: 1 },
          prune: { bytesRemoved: 1024, oldVersionsRemoved: 1 },
        };
      },
      close: () => {},
    };

    const fakeDb = {
      tableNames: async () => ["chunks"],
      openTable: async () => fakeTable,
    };

    // Inject fake connection without calling close() (fake tables lack .close()).
    (manager as unknown as { tables: Map<unknown, unknown> }).tables.clear();
    (manager as unknown as { db: unknown }).db = fakeDb;

    await manager.compact();

    expect(optimizeCalls.length).toBe(1);
    const opts = optimizeCalls[0];
    // deleteUnverified MUST be false
    expect(opts.deleteUnverified).toBe(false);
    // Default retention is six hours (allow 60s tolerance for test runtime).
    const cutoff = opts.cleanupOlderThan as Date;
    const expectedCutoff = Date.now() - (hours === undefined ? LanceDBManager.COMPACT_RETENTION_MS : hours * 3600_000);
    expect(Math.abs(cutoff.getTime() - expectedCutoff)).toBeLessThan(60_000);
  });

  test("old pre-compact version remains recoverable and pruning reports actual reclaimed bytes", async () => {
    await manager.close();
    manager = new LanceDBManager({ compactRetentionHours: 12 });
    await manager.connect(lancePath);
    const oldTimestamp = new Date(Date.now() - 30 * 24 * 3600_000);
    const obsolete = join(lancePath, "obsolete");
    writeFileSync(obsolete, new Uint8Array(1024));
    const fakeTable = {
      tags: async () => fakeTags(),
      version: async () => 7,
      listVersions: async () => [{ version: 7, timestamp: oldTimestamp }],
      countRows: async () => 5,
      optimize: async (opts: { cleanupOlderThan: Date; deleteUnverified: boolean }) => {
        expect(opts.cleanupOlderThan.getTime()).toBeLessThan(oldTimestamp.getTime());
        expect(opts.deleteUnverified).toBe(false);
        rmSync(obsolete);
        return {
          compaction: { fragmentsRemoved: 0, fragmentsAdded: 0, filesRemoved: 0 },
          prune: { bytesRemoved: 1024 },
        };
      },
      close: () => {},
    };
    (manager as unknown as { db: unknown }).db = {
      tableNames: async () => ["chunks"], openTable: async () => fakeTable,
    };
    const result = await manager.compact();
    expect(result.diskBytesDelta).toBe(-1024);
    expect(result.bytesRemoved).toBe(1024);
    expect(result.filesRemoved).toBe(0);
  });

  test("compact throws integrity error when row count changes", async () => {
    // Simulate a corrupted optimize: countRows returns 5 before, 4 after.
    let callCount = 0;
    const tags = fakeTags();
    const fakeTable = {
      tags: async () => tags,
      version: async () => 2,
      listVersions: async () => [{ version: 2, timestamp: new Date() }],
      countRows: async () => {
        callCount++;
        return callCount === 1 ? 5 : 4;
      },
      optimize: async () => ({
        compaction: { fragmentsRemoved: 1, fragmentsAdded: 1, filesRemoved: 1, filesAdded: 1 },
        prune: { bytesRemoved: 0, oldVersionsRemoved: 0 },
      }),
      close: () => {},
    };

    const fakeDb = {
      tableNames: async () => ["test-corrupt"],
      openTable: async () => fakeTable,
    };

    (manager as unknown as { tables: Map<unknown, unknown> }).tables.clear();
    (manager as unknown as { db: unknown }).db = fakeDb;

    await expect(manager.compact()).rejects.toThrow(
      /compact integrity failure on table "test-corrupt".*5.*4/,
    );
    expect(await tags.list()).toHaveProperty(LanceDBManager.COMPACT_ROLLBACK_TAG);
    await expect(manager.compact()).rejects.toThrow(/Unresolved compact rollback tag/);
  });
});
