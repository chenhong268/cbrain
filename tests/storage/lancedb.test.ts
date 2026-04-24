import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { LanceDBManager, type ChunkData } from "../../src/storage/lancedb.js";

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
    const chunks: ChunkData[] = [
      {
        pageSlug: "entities/fts-test",
        chunkIndex: 0,
        content: "Quantum computing uses qubits for computation",
        vector: makeVector(0),
      },
      {
        pageSlug: "entities/fts-test",
        chunkIndex: 1,
        content: "Classical computers use binary bits",
        vector: makeVector(1),
      },
    ];

    await manager.addChunks(chunks);
    // Create FTS index on content column
    await manager.createFTSIndex();

    const results = await manager.fullTextSearch("quantum", 10);

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain("Quantum");
  });

  test("fullTextSearch with no results returns empty array", async () => {
    const chunks: ChunkData[] = [
      {
        pageSlug: "entities/fts-empty",
        chunkIndex: 0,
        content: "Hello world",
        vector: makeVector(0),
      },
    ];

    await manager.addChunks(chunks);
    await manager.createFTSIndex();

    const results = await manager.fullTextSearch("nonexistent-xyz-abc", 10);
    expect(results).toHaveLength(0);
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
});
