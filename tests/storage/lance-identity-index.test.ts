import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import { rebuildLanceIndex, type FsOps } from "../../src/storage/lance-rebuild.js";
import { rebuildPageVectors } from "../../src/storage/lance-page-rebuild.js";
import {
  DOCUMENT_ENCODING_VERSION,
  LEGACY_VECTOR_DIMENSIONS,
  identityFilePath,
  readIndexIdentity,
  vectorSchemas,
  writeIndexIdentity,
} from "../../src/storage/lance-identity.js";
import type { VectorIndexIdentity } from "../../src/storage/lance-identity.js";
import { resolveVectorIdentity } from "../../src/cli/context.js";
import type { CBrainConfig } from "../../src/cli/context.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

/**
 * Real LanceDB index behaviour for #545. Nothing here mocks the vector store:
 * every assertion reads back a real table, a real file, or a real thrown error.
 */

const TEST_DIR = "/tmp/cbrain-test-lance-identity-index";

const LOCAL: VectorIndexIdentity = {
  provider: "ollama",
  model: "qwen3-embedding:0.6b",
  dimensions: 1024,
  documentEncoding: DOCUMENT_ENCODING_VERSION,
};

const CLOUD: VectorIndexIdentity = {
  provider: "zhipu",
  model: "embedding-3",
  dimensions: LEGACY_VECTOR_DIMENSIONS,
  documentEncoding: DOCUMENT_ENCODING_VERSION,
};

const DETERMINISTIC: VectorIndexIdentity = {
  provider: "deterministic",
  model: "deterministic-fixed-v1",
  dimensions: LEGACY_VECTOR_DIMENSIONS,
  documentEncoding: DOCUMENT_ENCODING_VERSION,
};

/** Vector content is derived from the text so a round-trip is observable. */
function vectorFor(text: string, dimensions: number): number[] {
  const vec = new Array(dimensions).fill(0);
  for (let i = 0; i < text.length; i++) vec[i % dimensions] += text.charCodeAt(i) / 65536;
  if (vec.every((v) => v === 0)) vec[0] = 1;
  return vec;
}

function provider(dimensions: number, reported?: number) {
  return {
    dimensions,
    embed: async (text: string) => ({ embedding: vectorFor(text, reported ?? dimensions), tokenCount: text.length }),
    embedBatch: async (texts: string[]) =>
      texts.map((text) => ({ embedding: vectorFor(text, reported ?? dimensions), tokenCount: text.length })),
  } as unknown as EmbeddingProvider;
}

function seedPage(db: CBrainDB, slug: string, rawChunks: string[], l1Summary?: string): void {
  db.rawDb
    .prepare("INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)")
    .run(slug, slug.replace(/.*\//, ""), `${slug}.md`, `hash-${slug}`);
  for (let i = 0; i < rawChunks.length; i++) {
    db.rawDb
      .prepare("INSERT OR IGNORE INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, ?, ?, 0)")
      .run(slug, i, rawChunks[i]);
    // Mirrors the real chunk write path: the trigram FTS table is maintained
    // alongside `chunks`, so a rejected vector write must leave both untouched.
    db.rawDb.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)").run(slug, rawChunks[i]);
  }
  if (l1Summary) {
    db.rawDb
      .prepare("INSERT OR IGNORE INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, -1, ?, 1)")
      .run(slug, l1Summary);
  }
}

/** Everything a vector rebuild must not change: facts, FTS rows, and MATCH hits. */
function semanticState(db: CBrainDB) {
  return {
    pages: db.rawDb.prepare("SELECT slug, content_hash FROM pages ORDER BY slug").all(),
    chunks: db.rawDb
      .prepare("SELECT page_slug, chunk_index, content, summary_level FROM chunks ORDER BY page_slug, chunk_index")
      .all(),
    fts: db.rawDb.prepare("SELECT page_slug, content FROM chunks_fts ORDER BY page_slug, content").all(),
    match: db.rawDb
      .prepare("SELECT page_slug, content FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY page_slug")
      .all("chunk"),
  };
}

describe("1024d local index on a real LanceDB directory", () => {
  const dbPath = join(TEST_DIR, "test.sqlite");
  const lancePath = join(TEST_DIR, "lance");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = new CBrainDB(dbPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("creates, queries and warms up at 1024d, and records the local model identity", async () => {
    const lance = new LanceDBManager({ identity: LOCAL });
    await lance.connect(lancePath);

    const warm = await lance.warmup();
    expect(warm.tables).toContain("chunks");
    expect(lance.vectorDimensions).toBe(1024);

    await lance.addChunks([{ pageSlug: "entities/a", chunkIndex: 0, content: "alpha", vector: new Float32Array(vectorFor("alpha", 1024)) }]);
    const hits = await lance.search(new Float32Array(vectorFor("alpha", 1024)), 5);
    expect(hits.length).toBe(1);
    expect(hits[0].pageSlug).toBe("entities/a");

    const stored = readIndexIdentity(lancePath);
    expect(stored).toEqual(LOCAL);
    await lance.close();
  });

  test("fills a row without a vector with the configured width, not the legacy default", async () => {
    const lance = new LanceDBManager({ identity: LOCAL });
    await lance.connect(lancePath);
    await lance.addChunks([{ pageSlug: "entities/zero", chunkIndex: 0, content: "no vector" }]);

    const rows = await lance.readRawVectorRows("entities/zero");
    expect(rows.length).toBe(1);
    expect(rows[0].vector?.length).toBe(1024);
    await lance.close();
  });

  test("rejects a 1024d index when the configuration expects the cloud 2048d model", async () => {
    const writer = new LanceDBManager({ identity: LOCAL });
    await writer.connect(lancePath);
    await writer.addChunks([{ pageSlug: "entities/a", chunkIndex: 0, content: "alpha" }]);
    await writer.close();

    await expect(new LanceDBManager({ identity: CLOUD }).connect(lancePath)).rejects.toThrow(/LANCE_IDENTITY_MISMATCH/);
  });

  test("rejects the same width built by a different model", async () => {
    const writer = new LanceDBManager({ identity: DETERMINISTIC });
    await writer.connect(lancePath);
    await writer.addChunks([{ pageSlug: "entities/a", chunkIndex: 0, content: "alpha" }]);
    await writer.close();
    expect(readIndexIdentity(lancePath)).toEqual(DETERMINISTIC);

    await expect(new LanceDBManager({ identity: CLOUD }).connect(lancePath)).rejects.toThrow(/model deterministic-fixed-v1 != embedding-3/);
  });

  test("accepts a legacy unlabelled 2048d index and never backfills an identity on a read", async () => {
    // A bare manager is the pre-#545 world: 2048d, no identity file.
    const legacy = new LanceDBManager();
    await legacy.connect(lancePath);
    await legacy.addChunks([{ pageSlug: "entities/legacy", chunkIndex: 0, content: "alpha" }]);
    await legacy.close();
    expect(readIndexIdentity(lancePath)).toBeNull();

    const reader = new LanceDBManager({ identity: CLOUD });
    await reader.connect(lancePath);
    expect((await reader.search(new Float32Array(vectorFor("alpha", 2048)), 5)).length).toBe(1);
    expect(readIndexIdentity(lancePath)).toBeNull();
    await reader.close();
  });

  test("refuses an unlabelled index when the configuration expects the local model", async () => {
    const legacy = new LanceDBManager();
    await legacy.connect(lancePath);
    await legacy.addChunks([{ pageSlug: "entities/legacy", chunkIndex: 0, content: "alpha" }]);
    await legacy.close();

    await expect(new LanceDBManager({ identity: LOCAL }).connect(lancePath)).rejects.toThrow(/LANCE_IDENTITY_MISSING/);
  });

  test("refuses digest drift for the same provider and model", async () => {
    const writer = new LanceDBManager({ identity: { ...LOCAL, modelDigest: "sha256:old" } });
    await writer.connect(lancePath);
    await writer.addChunks([{ pageSlug: "entities/a", chunkIndex: 0, content: "alpha" }]);
    await writer.close();

    await expect(new LanceDBManager({ identity: { ...LOCAL, modelDigest: "sha256:new" } }).connect(lancePath))
      .rejects.toThrow(/model digest/);
    // #545 F2: an unresolved stored digest is not a wildcard — a confirmed model
    // must not adopt an index whose model it cannot check.
    await expect(new LanceDBManager({ identity: { ...LOCAL, modelDigest: "sha256:old" } }).connect(lancePath))
      .resolves.toBeUndefined();
    await expect(new LanceDBManager({ identity: LOCAL }).connect(lancePath))
      .rejects.toThrow(/model digest/);
  });

  test("refuses a damaged identity file", async () => {
    const writer = new LanceDBManager({ identity: LOCAL });
    await writer.connect(lancePath);
    await writer.addChunks([{ pageSlug: "entities/a", chunkIndex: 0, content: "alpha" }]);
    await writer.close();

    writeFileSync(identityFilePath(lancePath), "{ corrupted", "utf8");
    await expect(new LanceDBManager({ identity: LOCAL }).connect(lancePath)).rejects.toThrow(/LANCE_IDENTITY_CORRUPT/);
  });

  test("refuses an identity that contradicts the table schema", async () => {
    const writer = new LanceDBManager();
    await writer.connect(lancePath);
    await writer.addChunks([{ pageSlug: "entities/a", chunkIndex: 0, content: "alpha" }]);
    await writer.close();

    writeIndexIdentity(lancePath, LOCAL);
    await expect(new LanceDBManager().connect(lancePath)).rejects.toThrow(/LANCE_IDENTITY_SCHEMA_MISMATCH/);
  });

  test("refuses an index that mixes table widths", async () => {
    const writer = new LanceDBManager();
    await writer.connect(lancePath);
    await writer.addChunks([{ pageSlug: "entities/a", chunkIndex: 0, content: "alpha" }]);
    await writer.close();

    const conn = await lancedb.connect(lancePath);
    await conn.createTable(
      "insights",
      [{ id: 1, content: "insight", vector: new Float32Array(vectorFor("insight", 1024)) }],
      { schema: vectorSchemas(1024).insights, mode: "create" },
    );
    conn.close();

    await expect(new LanceDBManager().connect(lancePath)).rejects.toThrow(/LANCE_IDENTITY_MIXED_SCHEMA/);
  });

  test("refuses an identity file with no tables behind it", async () => {
    mkdirSync(lancePath, { recursive: true });
    writeIndexIdentity(lancePath, LOCAL);
    await expect(new LanceDBManager({ identity: LOCAL }).connect(lancePath)).rejects.toThrow(/LANCE_IDENTITY_ORPHANED/);
  });

  test("single-page recovery writes 1024d vectors into a 1024d index", async () => {
    seedPage(db, "entities/local", ["chunk one", "chunk two"], "summary of local");
    const lance = new LanceDBManager({ identity: LOCAL });
    await lance.connect(lancePath);
    await lance.warmup();

    await rebuildPageVectors({ db, lance, embedding: provider(1024), pageSlug: "entities/local", lancePath });

    const rows = await lance.readRawVectorRows("entities/local");
    expect(rows.length).toBe(2);
    expect(rows[0].vector?.length).toBe(1024);
    await lance.close();
  });
});

describe("full rebuild commits the identity with the verified directory", () => {
  const dbPath = join(TEST_DIR, "test.sqlite");
  const lancePath = join(TEST_DIR, "lance");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = new CBrainDB(dbPath);
    seedPage(db, "entities/rb", ["chunk one"], "summary one");
    db.rawDb
      .prepare("INSERT INTO insights (id, content, type, source_type, status) VALUES (1, 'insight one', 'synthesis', 'manual', 'active')")
      .run();
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("writes the 1024d identity into the swapped-in index, and it is readable", async () => {
    const result = await rebuildLanceIndex(lancePath, db, provider(1024), undefined, { identity: LOCAL });
    expect(result.noOp).toBe(false);
    expect(result.errors).toBe(0);
    expect(readIndexIdentity(lancePath)).toEqual(LOCAL);

    const lance = new LanceDBManager({ identity: LOCAL });
    await lance.connect(lancePath);
    expect((await lance.search(new Float32Array(vectorFor("chunk one", 1024)), 5)).length).toBeGreaterThan(0) ;
    expect((await lance.readRawVectorRows("entities/rb"))[0].vector?.length).toBe(1024);
    expect((await lance.searchInsights(new Float32Array(vectorFor("insight one", 1024)), 5)).length).toBe(1);
    await lance.close();
  });

  test("leaves the index unlabelled when the caller supplies no identity", async () => {
    const result = await rebuildLanceIndex(lancePath, db, provider(1024));
    expect(result.noOp).toBe(false);
    expect(readIndexIdentity(lancePath)).toBeNull();
  });

  test("refuses a provider that returns the wrong width, and touches nothing", async () => {
    await expect(rebuildLanceIndex(lancePath, db, provider(1024, 2048), undefined, { identity: LOCAL }))
      .rejects.toThrow(/VECTOR_DIMENSION_MISMATCH/);
    expect(existsSync(lancePath)).toBe(false);
    expect(readdirSync(TEST_DIR).filter((entry) => entry.includes(".rebuild-"))).toEqual([]);
  });

  test("keeps the previous index and its identity when the directory swap fails", async () => {
    const live = new LanceDBManager({ identity: { ...LOCAL, modelDigest: "sha256:live" } });
    await live.connect(lancePath);
    await live.addChunks([{ pageSlug: "entities/rb", chunkIndex: 0, content: "old vector", vector: new Float32Array(vectorFor("old vector", 1024)) }]);
    await live.close();
    const identityBefore = readFileSync(identityFilePath(lancePath), "utf8");

    // rename #1 = live → backup (succeeds), rename #2 = staging → live (fails).
    let renameCallCount = 0;
    const injectedFs: FsOps = {
      existsSync,
      mkdirSync,
      renameSync(from: string, to: string) {
        renameCallCount++;
        if (renameCallCount === 2) throw new Error("EIO: cannot rename staging to live");
        renameSync(from, to);
      },
      rmSync,
    };

    await expect(rebuildLanceIndex(lancePath, db, provider(1024), injectedFs, { identity: { ...LOCAL, modelDigest: "sha256:rebuilt" } }))
      .rejects.toThrow("SWAP_FAILED_ROLLED_BACK");

    // Live index and its identity survived unchanged; no staging directory leaked.
    expect(readFileSync(identityFilePath(lancePath), "utf8")).toBe(identityBefore);
    expect(readdirSync(TEST_DIR).filter((entry) => entry.includes(".rebuild-"))).toEqual([]);

    const reader = new LanceDBManager({ identity: { ...LOCAL, modelDigest: "sha256:live" } });
    await reader.connect(lancePath);
    const rows = await reader.readRawVectorRows("entities/rb");
    expect(rows.length).toBe(1);
    expect(rows[0].content).toBe("old vector");
    // The identity is authoritative: a rebuild that never completed did not relabel the index.
    await expect(new LanceDBManager({ identity: { ...LOCAL, modelDigest: "sha256:rebuilt" } }).connect(lancePath))
      .rejects.toThrow(/model digest/);
    await reader.close();
  });

  test("a no-op rebuild keeps the live index and its identity, and reports noOp", async () => {
    const live = new LanceDBManager({ identity: LOCAL });
    await live.connect(lancePath);
    await live.addChunks([{ pageSlug: "entities/rb", chunkIndex: 0, content: "old vector", vector: new Float32Array(vectorFor("old vector", 1024)) }]);
    await live.close();
    const identityBefore = readFileSync(identityFilePath(lancePath), "utf8");

    const emptyDb = new CBrainDB(join(TEST_DIR, "empty.sqlite"));
    const result = await rebuildLanceIndex(lancePath, emptyDb, provider(1024), undefined, { identity: CLOUD });
    emptyDb.close();

    expect(result.noOp).toBe(true);
    expect(result.chunksRebuilt).toBe(0);
    expect(result.backupPath).toBeNull();
    // Not a migration: the cloud identity was NOT written over the live local one.
    expect(readFileSync(identityFilePath(lancePath), "utf8")).toBe(identityBefore);
    const reader = new LanceDBManager({ identity: LOCAL });
    await reader.connect(lancePath);
    expect((await reader.readRawVectorRows("entities/rb")).length).toBe(1);
    await reader.close();
  });
});

describe("resolveVectorIdentity: config to identity wiring", () => {
  const base = { vaultPath: "/tmp/v", dbPath: "/tmp/d", lancePath: "/tmp/l" } as unknown as CBrainConfig;

  test("maps every provider to its own model id and its provider-declared width", () => {
    expect(resolveVectorIdentity({ ...base, embedding: { provider: "ollama", model: "qwen3-embedding:0.6b" } }, provider(1024)))
      .toEqual({ provider: "ollama", model: "qwen3-embedding:0.6b", dimensions: 1024, documentEncoding: DOCUMENT_ENCODING_VERSION });
    expect(resolveVectorIdentity({ ...base, embedding: { provider: "ollama" } }, provider(1024))?.model)
      .toBe("qwen3-embedding:0.6b");
    expect(resolveVectorIdentity({ ...base, embedding: { provider: "zhipu" } }, provider(2048)))
      .toEqual({ provider: "zhipu", model: "embedding-3", dimensions: 2048, documentEncoding: DOCUMENT_ENCODING_VERSION });
    expect(resolveVectorIdentity({ ...base, embedding: { provider: "deterministic" } }, provider(2048))?.model)
      .toBe("deterministic-fixed-v1");
  });

  test("returns no identity when there is no provider instance", () => {
    expect(resolveVectorIdentity({ ...base, embedding: { provider: "zhipu" } }, undefined)).toBeUndefined();
  });
});

describe("second round: write validation, refused-handle state, identity provenance", () => {
  const dbPath = join(TEST_DIR, "test.sqlite");
  const lancePath = join(TEST_DIR, "lance");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = new CBrainDB(dbPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  async function tableNames(): Promise<string[]> {
    const conn = await lancedb.connect(lancePath);
    const names = await conn.tableNames();
    conn.close();
    return names;
  }

  /** A provider that returns whatever `break_` leaves behind — NaN, Infinity, overflow. */
  function brokenProvider(break_: (vec: number[]) => number[]) {
    const make = (text: string) => ({ embedding: break_(vectorFor(text, 1024)), tokenCount: text.length });
    return {
      dimensions: 1024,
      embed: async (text: string) => make(text),
      embedBatch: async (texts: string[]) => texts.map(make),
    } as unknown as EmbeddingProvider;
  }

  test("refuses a wrong-width chunk vector and writes nothing", async () => {
    const lance = new LanceDBManager({ identity: LOCAL });
    await lance.connect(lancePath);

    await expect(lance.addChunks([
      { pageSlug: "entities/a", chunkIndex: 0, content: "alpha", vector: new Float32Array(vectorFor("alpha", 1024)) },
      { pageSlug: "entities/b", chunkIndex: 0, content: "beta", vector: new Float32Array(vectorFor("beta", 128)) },
    ])).rejects.toThrow(/VECTOR_DIMENSION_MISMATCH/);

    // The whole batch is validated first: the good row was not written either.
    expect(await tableNames()).toEqual([]);
    expect(readIndexIdentity(lancePath)).toBeNull();
    await lance.close();
  });

  test("refuses a wrong-width insight vector", async () => {
    const lance = new LanceDBManager({ identity: LOCAL });
    await lance.connect(lancePath);
    await lance.addChunks([{ pageSlug: "entities/a", chunkIndex: 0, content: "alpha", vector: new Float32Array(vectorFor("alpha", 1024)) }]);

    await expect(lance.addInsightVector({ id: 1, content: "insight", vector: new Float32Array(vectorFor("insight", 128)) }))
      .rejects.toThrow(/VECTOR_DIMENSION_MISMATCH/);
    expect(await tableNames()).not.toContain("insights");
    await lance.close();
  });

  test("refuses NaN and Infinity at the write boundary and writes nothing", async () => {
    const lance = new LanceDBManager({ identity: LOCAL });
    await lance.connect(lancePath);

    const nan = new Float32Array(vectorFor("alpha", 1024));
    nan[5] = Number.NaN;
    await expect(lance.addChunks([{ pageSlug: "entities/a", chunkIndex: 0, content: "alpha", vector: nan }]))
      .rejects.toThrow(/VECTOR_VALUE_INVALID/);

    const infinite = new Float32Array(vectorFor("alpha", 1024));
    infinite[7] = Number.POSITIVE_INFINITY;
    await expect(lance.addChunks([{ pageSlug: "entities/a", chunkIndex: 0, content: "alpha", vector: infinite }]))
      .rejects.toThrow(/VECTOR_VALUE_INVALID/);

    const badInsight = new Float32Array(vectorFor("insight", 1024));
    badInsight[9] = Number.NaN;
    await expect(lance.addInsightVector({ id: 1, content: "insight", vector: badInsight }))
      .rejects.toThrow(/VECTOR_VALUE_INVALID/);

    expect(await tableNames()).toEqual([]);
    await lance.close();
  });

  test("a full rebuild refuses a broken provider vector and leaves the live index and identity alone", async () => {
    const live = new LanceDBManager({ identity: { ...LOCAL, modelDigest: "sha256:live" } });
    await live.connect(lancePath);
    await live.addChunks([{ pageSlug: "entities/rb", chunkIndex: 0, content: "old vector", vector: new Float32Array(vectorFor("old vector", 1024)) }]);
    await live.close();
    const identityBefore = readFileSync(identityFilePath(lancePath), "utf8");
    seedPage(db, "entities/rb", ["chunk one"]);

    await expect(rebuildLanceIndex(lancePath, db, brokenProvider((vec) => { vec[3] = Number.NaN; return vec; }), undefined, {
      identity: { ...LOCAL, modelDigest: "sha256:rebuilt" },
    })).rejects.toThrow(/VECTOR_VALUE_INVALID/);

    // A value that a provider may return as a JS number but the store cannot hold.
    await expect(rebuildLanceIndex(lancePath, db, brokenProvider((vec) => { vec[4] = 1e39; return vec; }), undefined, {
      identity: { ...LOCAL, modelDigest: "sha256:rebuilt" },
    })).rejects.toThrow(/VECTOR_VALUE_INVALID/);

    expect(readFileSync(identityFilePath(lancePath), "utf8")).toBe(identityBefore);
    expect(readdirSync(TEST_DIR).filter((entry) => entry.includes(".rebuild-"))).toEqual([]);
    const reader = new LanceDBManager({ identity: { ...LOCAL, modelDigest: "sha256:live" } });
    await reader.connect(lancePath);
    const rows = await reader.readRawVectorRows("entities/rb");
    expect(rows.length).toBe(1);
    expect(rows[0].content).toBe("old vector");
    await reader.close();
  });

  test("a refused connect leaves no usable handle, and a repaired index reconnects on the same instance", async () => {
    const writer = new LanceDBManager({ identity: LOCAL });
    await writer.connect(lancePath);
    await writer.addChunks([{ pageSlug: "entities/a", chunkIndex: 0, content: "alpha", vector: new Float32Array(vectorFor("alpha", 1024)) }]);
    await writer.close();

    writeFileSync(identityFilePath(lancePath), "{ not json", "utf8");
    const lance = new LanceDBManager({ identity: LOCAL });
    await expect(lance.connect(lancePath)).rejects.toThrow(/LANCE_IDENTITY_CORRUPT/);

    // The refused instance must not read or extend the tables it just refused,
    // and it must not have repaired the damaged file on its own.
    const query = new Float32Array(vectorFor("alpha", 1024));
    await expect(lance.search(query, 5)).rejects.toThrow(/not connected/);
    await expect(lance.addChunks([{ pageSlug: "entities/b", chunkIndex: 0, content: "beta", vector: query }])).rejects.toThrow(/not connected/);
    await expect(lance.warmup()).rejects.toThrow(/not connected/);
    await expect(lance.openChunksStrict()).rejects.toThrow(/not connected/);
    expect(readFileSync(identityFilePath(lancePath), "utf8")).toBe("{ not json");

    // Once the index itself is sound again, the same instance works normally.
    writeIndexIdentity(lancePath, LOCAL);
    await lance.connect(lancePath);
    expect(await lance.getIndexedPageSlugs()).toEqual(["entities/a"]);
    expect((await lance.search(query, 5)).length).toBe(1);
    await lance.close();
  });

  test("the single-page recovery path refuses a wrong-width provider vector without losing the page", async () => {
    seedPage(db, "entities/local", ["chunk one", "chunk two"]);
    const lance = new LanceDBManager({ identity: LOCAL });
    await lance.connect(lancePath);
    await lance.addChunks([{ pageSlug: "entities/local", chunkIndex: 0, content: "chunk one", vector: new Float32Array(vectorFor("chunk one", 1024)) }]);

    const result = await rebuildPageVectors({ db, lance, embedding: provider(1024, 128), pageSlug: "entities/local", lancePath });
    // The page path refuses the width before its destructive step, so the live
    // rows were never touched (status aborted_unchanged, not rolled back).
    expect(result.status).toBe("aborted_unchanged");
    expect(result.reason).toMatch(/VECTOR_DIMENSION_MISMATCH/);
    const rows = await lance.readRawVectorRows("entities/local");
    expect(rows.length).toBe(1);
    expect(rows[0].content).toBe("chunk one");
    await lance.close();
  });

  test("the single-page recovery path refuses a non-finite provider vector without touching the page", async () => {
    seedPage(db, "entities/local", ["chunk one", "chunk two"]);
    const lance = new LanceDBManager({ identity: LOCAL });
    await lance.connect(lancePath);
    await lance.addChunks([{ pageSlug: "entities/local", chunkIndex: 0, content: "chunk one", vector: new Float32Array(vectorFor("chunk one", 1024)) }]);

    const result = await rebuildPageVectors({
      db,
      lance,
      embedding: brokenProvider((vec) => { vec[2] = Number.NaN; return vec; }),
      pageSlug: "entities/local",
      lancePath,
    });
    // #545 F1: the refusal now happens while the page is still intact, so this is
    // an abort — not a rollback.
    expect(result.status).toBe("aborted_unchanged");
    expect(result.reason).toMatch(/VECTOR_VALUE_INVALID/);
    const rows = await lance.readRawVectorRows("entities/local");
    expect(rows.map((row) => row.content)).toEqual(["chunk one"]);
    await lance.close();
  });

  test("a rejected page rebuild performs no delete and leaves SQLite, FTS, the rows and the identity alone", async () => {
    seedPage(db, "entities/local", ["chunk one", "chunk two"]);
    const lance = new LanceDBManager({ identity: LOCAL });
    await lance.connect(lancePath);
    await lance.addChunks([{
      pageSlug: "entities/local",
      chunkIndex: 0,
      content: "chunk one",
      vector: new Float32Array(vectorFor("chunk one", 1024)),
    }]);

    const before = semanticState(db);
    const rowsBefore = await lance.readRawVectorRows("entities/local");
    const identityBefore = readFileSync(identityFilePath(lancePath));
    // #545 F1: count the destructive call itself, not just its visible effect.
    let deletes = 0;
    const realDelete = lance.deleteRawChunksByPageSlug.bind(lance);
    lance.deleteRawChunksByPageSlug = (async (slug: string) => {
      deletes += 1;
      return realDelete(slug);
    }) as typeof lance.deleteRawChunksByPageSlug;

    const wrongWidth = await rebuildPageVectors({
      db, lance, embedding: provider(1024, 128), pageSlug: "entities/local", lancePath,
    });
    const nonFinite = await rebuildPageVectors({
      db, lance, embedding: brokenProvider((vec) => { vec[2] = Number.NaN; return vec; }),
      pageSlug: "entities/local", lancePath,
    });

    expect(wrongWidth.status).toBe("aborted_unchanged");
    expect(nonFinite.status).toBe("aborted_unchanged");
    expect(deletes).toBe(0);
    expect(semanticState(db)).toEqual(before);
    expect(await lance.readRawVectorRows("entities/local")).toEqual(rowsBefore);
    expect(readFileSync(identityFilePath(lancePath)).equals(identityBefore)).toBe(true);
    await lance.close();
  });

  test("a width mismatch refuses connect and leaves no usable handle either", async () => {
    const writer = new LanceDBManager({ identity: LOCAL });
    await writer.connect(lancePath);
    await writer.addChunks([{ pageSlug: "entities/a", chunkIndex: 0, content: "alpha", vector: new Float32Array(vectorFor("alpha", 1024)) }]);
    await writer.close();

    // The tables are sound, but the identity on disk claims another width.
    const lance = new LanceDBManager({ identity: CLOUD });
    await expect(lance.connect(lancePath)).rejects.toThrow(/LANCE_IDENTITY_MISMATCH/);
    await expect(lance.search(new Float32Array(vectorFor("alpha", 2048)), 5)).rejects.toThrow(/not connected/);
    await expect(lance.addChunks([{ pageSlug: "entities/b", chunkIndex: 0, content: "beta", vector: new Float32Array(vectorFor("beta", 2048)) }]))
      .rejects.toThrow(/not connected/);

    // The index and its identity are untouched by the refused open.
    expect(readIndexIdentity(lancePath)).toEqual(LOCAL);
    const reader = new LanceDBManager({ identity: LOCAL });
    await reader.connect(lancePath);
    expect((await reader.search(new Float32Array(vectorFor("alpha", 1024)), 5)).length).toBe(1);
    await reader.close();
  });

  test("a legacy unlabelled index stays unlabelled through warmup, reads, sibling tables and new rows", async () => {
    // 2048d chunks-only index, no identity file: the pre-#545 shape.
    const legacy = new LanceDBManager({});
    await legacy.connect(lancePath);
    await legacy.addChunks([{ pageSlug: "entities/legacy", chunkIndex: 0, content: "legacy", vector: new Float32Array(vectorFor("legacy", 2048)) }]);
    await legacy.close();
    expect(readIndexIdentity(lancePath)).toBeNull();
    expect(await tableNames()).toEqual(["chunks"]);

    const lance = new LanceDBManager({ identity: CLOUD });
    await lance.connect(lancePath);
    const warm = await lance.warmup();
    expect(warm.tables).toContain("insights");
    await lance.addChunks([{ pageSlug: "entities/new", chunkIndex: 0, content: "new", vector: new Float32Array(vectorFor("new", 2048)) }]);
    expect((await lance.search(new Float32Array(vectorFor("legacy", 2048)), 5)).length).toBeGreaterThan(0);
    expect((await lance.readRawVectorRows("entities/legacy"))[0].vector?.length).toBe(2048);
    await lance.close();

    // Whatever the current configuration says, the old vectors keep no origin.
    expect(readIndexIdentity(lancePath)).toBeNull();
    expect(existsSync(identityFilePath(lancePath))).toBe(false);

    // Only an explicit full rebuild may confirm the identity of that data.
    seedPage(db, "entities/rb", ["chunk one"]);
    const result = await rebuildLanceIndex(lancePath, db, provider(2048), undefined, { identity: CLOUD });
    expect(result.noOp).toBe(false);
    expect(readIndexIdentity(lancePath)).toEqual(CLOUD);
  });
});
