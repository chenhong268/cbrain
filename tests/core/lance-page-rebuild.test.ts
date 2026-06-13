import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { LanceDBManager, LanceTableMissingError } from "../../src/storage/lancedb.js";
import {
  rebuildPageVectors,
  classifyQuarantineFault,
} from "../../src/core/lance-page-rebuild.js";

/**
 * Deterministic fake embedding provider matching 2048 dimensions.
 * Vector is content-derived so tests can assert round-trips.
 */
function fakeEmbeddingProvider() {
  return {
    dimensions: 2048 as const,
    embed: async (text: string) => {
      const vec = new Array(2048).fill(0);
      for (let i = 0; i < text.length; i++) vec[i % 2048] += text.charCodeAt(i) / 65536;
      return { embedding: vec, tokenCount: text.length };
    },
    embedBatch: async (texts: string[]) =>
      texts.map((t) => {
        const vec = new Array(2048).fill(0);
        for (let i = 0; i < t.length; i++) vec[i % 2048] += t.charCodeAt(i) / 65536;
        return { embedding: vec, tokenCount: t.length };
      }),
  };
}

const TEST_DIR = "/tmp/cbrain-test-lance-page-rebuild";

function seedPage(db: CBrainDB, slug: string, rawChunks: string[], l1Summary?: string): void {
  db.rawDb
    .prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
    )
    .run(slug, slug.replace(/.*\//, ""), `${slug}.md`, `hash-${slug}`);
  for (let i = 0; i < rawChunks.length; i++) {
    db.rawDb
      .prepare(
        "INSERT OR IGNORE INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, ?, ?, 0)",
      )
      .run(slug, i, rawChunks[i]);
  }
  if (l1Summary) {
    db.rawDb
      .prepare(
        "INSERT OR IGNORE INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, -1, ?, 1)",
      )
      .run(slug, l1Summary);
  }
}

describe("LanceDBManager recovery API", () => {
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

  test("openChunksStrict throws LanceTableMissingError when table absent (never creates)", async () => {
    const lance = new LanceDBManager();
    await lance.connect(lancePath);
    await expect(lance.openChunksStrict()).rejects.toBeInstanceOf(LanceTableMissingError);
    await lance.close();
    // No chunks table created — a fresh manager still cannot strict-open it.
    const probe = new LanceDBManager();
    await probe.connect(lancePath);
    await expect(probe.openChunksStrict()).rejects.toBeInstanceOf(LanceTableMissingError);
    await probe.close();
  });

  test("readRawVectorRows returns raw rows with vector; readL1Rows returns L1 rows", async () => {
    // Build a live index with raw + L1 rows for one page + another page (must be untouched)
    const oldVec = new Float32Array(2048).fill(0.25);
    const l1Vec = new Float32Array(2048).fill(0.9);
    const lance = new LanceDBManager();
    await lance.connect(lancePath);
    await lance.addChunks([
      { pageSlug: "entities/A", chunkIndex: 0, content: "raw-0", vector: oldVec },
      { pageSlug: "entities/A", chunkIndex: 1, content: "raw-1", vector: oldVec },
      { pageSlug: "entities/A", chunkIndex: -1, content: "L1-summary", vector: l1Vec },
      { pageSlug: "entities/B", chunkIndex: 0, content: "other", vector: new Float32Array(2048) },
    ]);
    await lance.close();

    const lance2 = new LanceDBManager();
    await lance2.connect(lancePath);
    const raw = await lance2.readRawVectorRows("entities/A");
    expect(raw).toHaveLength(2);
    // Ordered by chunkIndex
    expect(raw[0].chunkIndex).toBe(0);
    expect(raw[1].chunkIndex).toBe(1);
    expect(raw.every((r) => r.content.startsWith("raw-"))).toBe(true);
    // Vector round-trips into a Float32Array of correct dim/values
    expect(raw[0].vector).toBeInstanceOf(Float32Array);
    expect(raw[0].vector.length).toBe(2048);
    expect(raw[0].vector[0]).toBeCloseTo(0.25, 5);

    const l1 = await lance2.readL1Rows("entities/A");
    expect(l1).toHaveLength(1);
    expect(l1[0].chunkIndex).toBe(-1);
    expect(l1[0].content).toBe("L1-summary");

    // entities/B must not leak into entities/A reads
    const rawB = await lance2.readRawVectorRows("entities/B");
    expect(rawB).toHaveLength(1);
    await lance2.close();
  });
});

describe("rebuildPageVectors — core state machine", () => {
  const dbPath = join(TEST_DIR, "test.sqlite");
  const lancePath = join(TEST_DIR, "lance");
  let db: CBrainDB;
  const embedding = fakeEmbeddingProvider();

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = new CBrainDB(dbPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  /** Open a live index and seed rows. Returns a connected manager (caller closes). */
  async function seedLive(rows: Array<{ pageSlug: string; chunkIndex: number; content: string; vector?: Float32Array }>): Promise<LanceDBManager> {
    const lance = new LanceDBManager();
    await lance.connect(lancePath);
    await lance.addChunks(rows.map((r) => ({ ...r, vector: r.vector ?? new Float32Array(2048).fill(0.1) })));
    return lance;
  }

  // Scenario 8: page absent / no raw chunks → skipped, no live mutation
  test("skipped when page has no raw chunks (live untouched)", async () => {
    const live = await seedLive([
      { pageSlug: "entities/A", chunkIndex: 0, content: "keep-me" },
    ]);
    await live.close();

    // No SQLite page at all
    const r1 = await rebuildPageVectors({ db, lance: new LanceDBManager(), embedding, pageSlug: "entities/missing", lancePath });
    expect(r1.status).toBe("skipped");

    // Page exists in SQLite but has no raw chunks (only L1)
    seedPage(db, "entities/l1only", [], "summary only");
    const lance2 = new LanceDBManager();
    await lance2.connect(lancePath);
    const r2 = await rebuildPageVectors({ db, lance: lance2, embedding, pageSlug: "entities/l1only", lancePath });
    expect(r2.status).toBe("skipped");
    await lance2.close();

    // entities/A live row preserved
    const v = new LanceDBManager();
    await v.connect(lancePath);
    const raw = await v.readRawVectorRows("entities/A");
    expect(raw).toHaveLength(1);
    expect(raw[0].content).toBe("keep-me");
    await v.close();
  });

  // Scenario 1: embedding throws → live rows unmodified
  test("embedding failure leaves live raw rows unmodified", async () => {
    seedPage(db, "entities/A", ["new-0", "new-1"]);
    const live = await seedLive([
      { pageSlug: "entities/A", chunkIndex: 0, content: "old-0", vector: new Float32Array(2048).fill(0.5) },
      { pageSlug: "entities/A", chunkIndex: 1, content: "old-1", vector: new Float32Array(2048).fill(0.5) },
    ]);
    await live.close();

    const failing = {
      dimensions: 2048,
      embed: async () => { throw new Error("embedding service down"); },
      embedBatch: async () => { throw new Error("embedding service down"); },
    };

    const lance = new LanceDBManager();
    await lance.connect(lancePath);
    const r = await rebuildPageVectors({ db, lance, embedding: failing as any, pageSlug: "entities/A", lancePath });
    // Embedding failed BEFORE any live mutation → aborted_unchanged, NOT a rollback.
    expect(r.status).toBe("aborted_unchanged");
    await lance.close();

    // Old rows intact (content + vectors)
    const v = new LanceDBManager();
    await v.connect(lancePath);
    const raw = await v.readRawVectorRows("entities/A");
    expect(raw).toHaveLength(2);
    expect(raw.map((x) => x.content).sort()).toEqual(["old-0", "old-1"]);
    expect(raw[0].vector[0]).toBeCloseTo(0.5, 5);
    await v.close();
  });

  // Scenario 2: embedding count/dim anomaly → live unmodified
  test("embedding dimension mismatch leaves live raw rows unmodified", async () => {
    seedPage(db, "entities/A", ["new-0"]);
    const live = await seedLive([
      { pageSlug: "entities/A", chunkIndex: 0, content: "old-0", vector: new Float32Array(2048).fill(0.7) },
    ]);
    await live.close();

    const wrongDim = {
      dimensions: 2048,
      embed: async (t: string) => ({ embedding: new Array(512).fill(0), tokenCount: t.length }),
      embedBatch: async (ts: string[]) => ts.map((t) => ({ embedding: new Array(512).fill(0), tokenCount: t.length })),
    };

    const lance = new LanceDBManager();
    await lance.connect(lancePath);
    const r = await rebuildPageVectors({ db, lance, embedding: wrongDim as any, pageSlug: "entities/A", lancePath });
    // Dimension anomaly caught preflight (before any live mutation) → aborted_unchanged.
    expect(r.status).toBe("aborted_unchanged");
    await lance.close();

    const v = new LanceDBManager();
    await v.connect(lancePath);
    const raw = await v.readRawVectorRows("entities/A");
    expect(raw).toHaveLength(1);
    expect(raw[0].content).toBe("old-0");
    await v.close();
  });

  // Scenario 3: normal rebuild → only target raw rows change; other page + L1 unchanged
  test("normal rebuild replaces only target raw rows; L1 + other pages untouched", async () => {
    seedPage(db, "entities/A", ["new-0", "new-1"], "L1-A");
    seedPage(db, "entities/B", ["B-0"]);
    const live = await seedLive([
      { pageSlug: "entities/A", chunkIndex: 0, content: "old-A-0", vector: new Float32Array(2048).fill(0.3) },
      { pageSlug: "entities/A", chunkIndex: -1, content: "L1-A", vector: new Float32Array(2048).fill(0.8) },
      { pageSlug: "entities/B", chunkIndex: 0, content: "B-0-old", vector: new Float32Array(2048).fill(0.4) },
    ]);
    await live.close();

    const lance = new LanceDBManager();
    await lance.connect(lancePath);
    const r = await rebuildPageVectors({ db, lance, embedding, pageSlug: "entities/A", lancePath });
    expect(r.status).toBe("rebuilt");
    expect(r.chunkCount).toBe(2);
    await lance.close();

    const v = new LanceDBManager();
    await v.connect(lancePath);
    const rawA = await v.readRawVectorRows("entities/A");
    expect(rawA.map((x) => x.content).sort()).toEqual(["new-0", "new-1"]);
    // L1 unchanged
    const l1 = await v.readL1Rows("entities/A");
    expect(l1).toHaveLength(1);
    expect(l1[0].content).toBe("L1-A");
    // Other page untouched
    const rawB = await v.readRawVectorRows("entities/B");
    expect(rawB).toHaveLength(1);
    expect(rawB[0].content).toBe("B-0-old");
    await v.close();
  });

  // Scenario 4: add failure → old raw rows restored
  test("add failure restores old raw rows", async () => {
    seedPage(db, "entities/A", ["new-0"]);
    const live = await seedLive([
      { pageSlug: "entities/A", chunkIndex: 0, content: "old-0", vector: new Float32Array(2048).fill(0.6) },
    ]);
    await live.close();

    // LanceDBManager subclass that fails addChunks after delete
    const flaky = new LanceDBManager();
    await flaky.connect(lancePath);
    const origAdd = (flaky as any).addChunks.bind(flaky);
    (flaky as any).addChunks = async (chunks: any[]) => {
      // Only fail the restore-add (1 chunk = new rows) vs snapshot restore — distinguish by content
      if (chunks.some((c) => c.content === "new-0")) throw new Error("LANCE_ADD_FAILED");
      return origAdd(chunks);
    };

    const r = await rebuildPageVectors({ db, lance: flaky, embedding, pageSlug: "entities/A", lancePath });
    expect(r.status).toBe("failed_rolled_back");
    await flaky.close();

    const v = new LanceDBManager();
    await v.connect(lancePath);
    const raw = await v.readRawVectorRows("entities/A");
    expect(raw).toHaveLength(1);
    expect(raw[0].content).toBe("old-0");
    await v.close();
  });

  // Scenario 7: chunks table missing → fallback_required, no table created, no data loss
  test("fallback_required when chunks table missing (no table created, no data loss)", async () => {
    seedPage(db, "entities/A", ["new-0"]);
    const lance = new LanceDBManager();
    await lance.connect(lancePath);
    const r = await rebuildPageVectors({ db, lance, embedding, pageSlug: "entities/A", lancePath });
    expect(r.status).toBe("fallback_required");
    await lance.close();

    // No chunks table was created — re-opening and strict-open still throws
    const probe = new LanceDBManager();
    await probe.connect(lancePath);
    await expect(probe.openChunksStrict()).rejects.toBeInstanceOf(LanceTableMissingError);
    await probe.close();
  });

  // Scenario 6: rollback itself fails → rollback_failed
  test("rollback_failed when restore add also fails", async () => {
    seedPage(db, "entities/A", ["new-0"]);
    const live = await seedLive([
      { pageSlug: "entities/A", chunkIndex: 0, content: "old-0", vector: new Float32Array(2048).fill(0.6) },
    ]);
    await live.close();

    const doomed = new LanceDBManager();
    await doomed.connect(lancePath);
    // Every addChunks fails
    (doomed as any).addChunks = async () => { throw new Error("LANCE_ADD_FAILED"); };

    const r = await rebuildPageVectors({ db, lance: doomed, embedding, pageSlug: "entities/A", lancePath });
    expect(r.status).toBe("rollback_failed");
    await doomed.close();
  });

  // Scenario 5: write succeeds but post-write verify mismatches → rollback;
  // old key/content/vector must be restored (the gap the original tests missed).
  test("write-then-verify mismatch triggers rollback; old vectors restored", async () => {
    seedPage(db, "entities/A", ["new-0"]);
    const live = await seedLive([
      { pageSlug: "entities/A", chunkIndex: 0, content: "old-0", vector: new Float32Array(2048).fill(0.6) },
    ]);
    await live.close();

    const tampered = new LanceDBManager();
    await tampered.connect(lancePath);
    const origAdd = (tampered as any).addChunks.bind(tampered);
    (tampered as any).addChunks = async (chunks: any[]) => {
      // Corrupt NEW rows' content so post-write verify fails; restore path
      // (content includes "old-") still writes the real snapshot.
      if (chunks.some((c) => String(c.content).includes("new"))) {
        return origAdd(chunks.map((c) => ({ ...c, content: `TAMPERED-${c.content}` })));
      }
      return origAdd(chunks);
    };

    const r = await rebuildPageVectors({ db, lance: tampered, embedding, pageSlug: "entities/A", lancePath });
    expect(r.status).toBe("failed_rolled_back");
    await tampered.close();

    const v = new LanceDBManager();
    await v.connect(lancePath);
    const raw = await v.readRawVectorRows("entities/A");
    expect(raw).toHaveLength(1);
    expect(raw[0].chunkIndex).toBe(0);
    expect(raw[0].content).toBe("old-0");
    expect(raw[0].vector[0]).toBeCloseTo(0.6, 5);
    await v.close();
  });

  // tryRestore must verify vectors, not just count/content: a restore that lands
  // wrong vectors must surface as rollback_failed (not a lying failed_rolled_back).
  test("rollback_failed when restored vectors mismatch the snapshot", async () => {
    seedPage(db, "entities/A", ["new-0"]);
    const live = await seedLive([
      { pageSlug: "entities/A", chunkIndex: 0, content: "old-0", vector: new Float32Array(2048).fill(0.6) },
    ]);
    await live.close();

    const flawed = new LanceDBManager();
    await flawed.connect(lancePath);
    const origAdd = (flawed as any).addChunks.bind(flawed);
    (flawed as any).addChunks = async (chunks: any[]) => {
      // New-row add throws → forces rollback. Restore path writes ZEROED vectors,
      // so the restored vector won't match the 0.6 snapshot.
      if (chunks.some((c) => String(c.content).includes("new"))) {
        throw new Error("LANCE_ADD_FAILED");
      }
      return origAdd(chunks.map((c) => ({ ...c, vector: new Float32Array(2048) })));
    };

    const r = await rebuildPageVectors({ db, lance: flawed, embedding, pageSlug: "entities/A", lancePath });
    expect(r.status).toBe("rollback_failed");
    await flawed.close();

    const v = new LanceDBManager();
    await v.connect(lancePath);
    const raw = await v.readRawVectorRows("entities/A");
    expect(raw).toHaveLength(1);
    expect(raw[0].content).toBe("old-0");
    expect(raw[0].vector[0]).toBe(0); // wrong vector landed → rollback was not faithful
    await v.close();
  });

  // L1 rollback integrity: a raw replace should never touch L1, but verifyResult
  // guards against it. If the failed write DID damage L1, restoring raw rows
  // alone is not a complete rollback — the result must be rollback_failed (not a
  // lying failed_rolled_back), even though raw restores cleanly.
  test("rollback_failed when post-write L1 mismatch even though raw restores", async () => {
    seedPage(db, "entities/A", ["new-0"], "L1-A");
    const live = await seedLive([
      { pageSlug: "entities/A", chunkIndex: 0, content: "old-0", vector: new Float32Array(2048).fill(0.6) },
      { pageSlug: "entities/A", chunkIndex: -1, content: "L1-A", vector: new Float32Array(2048).fill(0.8) },
    ]);
    await live.close();

    const l1Breaker = new LanceDBManager();
    await l1Breaker.connect(lancePath);
    const origAdd = l1Breaker.addChunks.bind(l1Breaker);
    (l1Breaker as any).addChunks = async (chunks: any[]) => {
      const r = await origAdd.call(l1Breaker, chunks);
      // After writing the NEW rows, damage L1 — simulating a write that corrupts
      // L1. The restore path (content includes "old-") must NOT re-touch L1.
      if (chunks.some((c) => String(c.content).includes("new"))) {
        await l1Breaker.deleteL1VectorByPageSlug("entities/A");
      }
      return r;
    };

    const r = await rebuildPageVectors({ db, lance: l1Breaker, embedding, pageSlug: "entities/A", lancePath });
    expect(r.status).toBe("rollback_failed");
    await l1Breaker.close();

    // Raw was faithfully restored, but L1 stays damaged → high-risk state surfaced.
    const v = new LanceDBManager();
    await v.connect(lancePath);
    expect((await v.readRawVectorRows("entities/A")).map((x) => x.content)).toEqual(["old-0"]);
    expect(await v.readL1Rows("entities/A")).toHaveLength(0); // L1 still missing — the damage we must report
    await v.close();
  });
});

describe("classifyQuarantineFault", () => {
  test("vector/embedding/lance/index faults classify as vector", () => {
    expect(classifyQuarantineFault("embedding service timed out")).toBe(true);
    expect(classifyQuarantineFault("LanceDB write failed")).toBe(true);
    expect(classifyQuarantineFault("vector dimension mismatch 2048 != 512")).toBe(true);
    expect(classifyQuarantineFault("failed to add index rows")).toBe(true);
    expect(classifyQuarantineFault("embed request 500")).toBe(true);
  });

  test("title collision / parse / file errors classify as non-vector", () => {
    expect(classifyQuarantineFault("TitleCollisionError: duplicate title A")).toBe(false);
    expect(classifyQuarantineFault("frontmatter parse error: bad yaml")).toBe(false);
    expect(classifyQuarantineFault("markdown could not be parsed")).toBe(false);
    expect(classifyQuarantineFault("ENOENT: file not found")).toBe(false);
    expect(classifyQuarantineFault("duplicate title in vault")).toBe(false);
  });
});
