import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { SyncManager } from "../../src/core/maintenance/sync.js";
import { snapshotIndexState, restoreIndexState, SyncRollbackError, sanitizeForLog, SyncSnapshotError } from "../../src/core/safety/sync-index-safety.js";

const TEST_DIR = "/tmp/cbrain-test-sync-rollback";

function newDb(): CBrainDB { return new CBrainDB(join(TEST_DIR, "test.sqlite")); }

function fakeEmbeddingProvider() {
  return {
    dimensions: 128,
    embed: async (text: string) => {
      const vec = new Array(128).fill(0);
      for (let i = 0; i < text.length; i++) vec[i % 128] += text.charCodeAt(i) / 65536;
      return { embedding: vec, tokenCount: text.length };
    },
    embedBatch: async (texts: string[]) =>
      texts.map((t) => {
        const vec = new Array(128).fill(0);
        for (let i = 0; i < t.length; i++) vec[i % 128] += t.charCodeAt(i) / 65536;
        return { embedding: vec, tokenCount: t.length };
      }),
  };
}

function writeMd(vaultPath: string, rel: string, fm: Record<string, unknown>, body: string) {
  const matter = ["---", ...Object.entries(fm).map(([k, v]) => Array.isArray(v) ? `${k}:\n${v.map(i => `  - ${i}`).join("\n")}` : `${k}: ${v}`), "---", "", body].join("\n");
  const full = join(vaultPath, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, matter, "utf-8");
}

describe("LanceDBManager.readL1VectorRows", () => {
  beforeEach(() => { if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true }); mkdirSync(TEST_DIR, { recursive: true }); });
  afterEach(() => { if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true }); });

  test("returns L1 rows (chunkIndex=-1) WITH vectors", async () => {
    const lance = new LanceDBManager();
    await lance.connect(join(TEST_DIR, "lance"));
    const vec = new Float32Array(2048).fill(0.7);
    // Seed an L1 row directly via the chunks table (chunkIndex = -1).
    await lance.addChunks([{ pageSlug: "p/l1", chunkIndex: -1, content: "L1 summary", vector: vec }]);
    await lance.addChunks([{ pageSlug: "p/l1", chunkIndex: 0, content: "raw chunk", vector: new Float32Array(2048).fill(0.1) }]);

    const rows = await lance.readL1VectorRows("p/l1");
    expect(rows.length).toBe(1);
    expect(rows[0].chunkIndex).toBe(-1);
    expect(rows[0].content).toBe("L1 summary");
    expect(rows[0].vector.length).toBe(2048);
    expect(rows[0].vector[0]).toBeCloseTo(0.7, 5);
  });
});

describe("sanitizeForLog (#185 privacy)", () => {
  test("redacts absolute filesystem paths", () => {
    const out = sanitizeForLog("embed provider read /tmp/secret/vault.sqlite then failed");
    expect(out).not.toContain("/tmp/secret/vault.sqlite");
    expect(out).not.toContain("/tmp/secret");
  });

  test("redacts credential-like tokens (sk- / Bearer / long hex)", () => {
    const out = sanitizeForLog("auth failed with key sk-test-cred-1234567890abcdefXYZ and token deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(out).not.toContain("sk-test-cred-1234567890abcdefXYZ");
    expect(out).not.toContain("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  });

  test("preserves non-sensitive diagnostic words", () => {
    expect(sanitizeForLog("LANCE_ADD_FAILED at chunk 3 for slug records/x")).toContain("LANCE_ADD_FAILED");
  });
});

describe("snapshotIndexState + restoreIndexState", () => {
  let db: CBrainDB; let lance: LanceDBManager;
  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = newDb();
    lance = new LanceDBManager();
    await lance.connect(join(TEST_DIR, "lance"));
  });
  afterEach(() => { db.close(); });

  test("snapshot captures raw rows with vectors + sqlite chunks", async () => {
    db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'record', 'T', ?, 'h')").run("p/x", "p/x.md");
    db.insertChunkWithLevel("p/x", 0, "chunk-zero", 0, null);
    db.insertChunkWithLevel("p/x", 1, "chunk-one", 0, null);
    await lance.addChunks([
      { pageSlug: "p/x", chunkIndex: 0, content: "chunk-zero", vector: new Float32Array(2048).fill(0.3) },
      { pageSlug: "p/x", chunkIndex: 1, content: "chunk-one", vector: new Float32Array(2048).fill(0.4) },
    ]);
    const snap = await snapshotIndexState(db, lance, "p/x", true);
    expect(snap.rawRows.length).toBe(2);
    expect(snap.rawRows[0].vector.length).toBe(2048);
    expect(snap.sqliteRawChunks.length).toBe(2);
    expect(snap.l1Rows).toEqual([]);
  });

  test("restore rebuilds exact raw vectors + sqlite chunks after a destructive write", async () => {
    db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'record', 'T', ?, 'h')").run("p/y", "p/y.md");
    db.insertChunkWithLevel("p/y", 0, "original", 0, null);
    await lance.addChunks([{ pageSlug: "p/y", chunkIndex: 0, content: "original", vector: new Float32Array(2048).fill(0.9) }]);
    const snap = await snapshotIndexState(db, lance, "p/y", true);

    // Simulate a destructive partial write: nuke Lance raw + rewrite SQLite.
    await lance.deleteRawChunksByPageSlug("p/y");
    db.transaction(() => { db.deleteChunksByPage("p/y"); db.insertChunk("p/y", 0, "corrupted"); });

    const result = await restoreIndexState(db, lance, "p/y", snap);
    expect(result.ok).toBe(true);

    const raw = await lance.readRawVectorRows("p/y");
    expect(raw.length).toBe(1);
    expect(raw[0].content).toBe("original");
    expect(raw[0].vector[0]).toBeCloseTo(0.9, 5);   // EXACT vector restored
    expect(db.getChunksByPage("p/y", { summaryLevel: 0 }).map(c => c.content)).toEqual(["original"]);
  });

  test("restore returns ok=false (not throw) when restore fails, collecting errors", async () => {
    db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'record', 'T', ?, 'h')").run("p/z", "p/z.md");
    db.insertChunkWithLevel("p/z", 0, "orig", 0, null);
    await lance.addChunks([{ pageSlug: "p/z", chunkIndex: 0, content: "orig", vector: new Float32Array(2048).fill(0.5) }]);
    const snap = await snapshotIndexState(db, lance, "p/z", true);
    // Force restore itself to fail by making addChunks throw.
    const origAdd = lance.addChunks.bind(lance);
    (lance as any).addChunks = async () => { throw new Error("restore add boom"); };
    const result = await restoreIndexState(db, lance, "p/z", snap);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    (lance as any).addChunks = origAdd;
  });

  test("restore rebuilds L1 summary chunk + L1 vector after empty-body delete (exact)", async () => {
    db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'record', 'T', ?, 'h')").run("p/l1r", "p/l1r.md");
    db.insertChunkWithLevel("p/l1r", 0, "raw0", 0, null);
    db.insertChunkWithLevel("p/l1r", -1, "sealed L1 summary", 1, "l1hash");
    await lance.addChunks([
      { pageSlug: "p/l1r", chunkIndex: 0, content: "raw0", vector: new Float32Array(2048).fill(0.2) },
      { pageSlug: "p/l1r", chunkIndex: -1, content: "sealed L1 summary", vector: new Float32Array(2048).fill(0.8) },
    ]);
    const snap = await snapshotIndexState(db, lance, "p/l1r", true);

    // Simulate empty-body writeIndexes failure: it deletes raw + L1 (Lance) AND L1 summary (SQLite).
    await lance.deleteRawChunksByPageSlug("p/l1r");
    await lance.deleteL1VectorByPageSlug("p/l1r");
    db.transaction(() => { db.deleteChunksByPage("p/l1r"); db.ftsDeleteByPage("p/l1r"); db.deleteL1Summary("p/l1r"); });

    const result = await restoreIndexState(db, lance, "p/l1r", snap);
    expect(result.ok).toBe(true);

    // L1 summary chunk restored to SQLite with its content_hash.
    const l1 = db.getL1Summary("p/l1r");
    expect(l1).not.toBeNull();
    expect(l1!.content).toBe("sealed L1 summary");
    expect(l1!.content_hash).toBe("l1hash");
    // L1 vector restored to Lance exactly.
    const l1Vec = await lance.readL1VectorRows("p/l1r");
    expect(l1Vec.length).toBe(1);
    expect(l1Vec[0].vector[0]).toBeCloseTo(0.8, 5);
    // raw restored too.
    const raw = await lance.readRawVectorRows("p/l1r");
    expect(raw.length).toBe(1);
    expect(raw[0].content).toBe("raw0");
  });

  test("SyncRollbackError carries original + rollback errors, sanitized message, structured code", () => {
    const e = new SyncRollbackError(
      new Error("embed failed at /tmp/secret/v.sqlite key sk-test-cred-1234567890abcdef"),
      [new Error("lance restore boom /tmp/secret/v.sqlite")],
    );
    expect(e.name).toBe("SyncRollbackError");
    expect(e.code).toBe("SYNC_ROLLBACK_INCOMPLETE");
    expect(e.recoveryRequired).toBe(true);
    expect(e.message).toContain("SYNC_ROLLBACK_INCOMPLETE");
    // log-facing message sanitized
    expect(e.message).not.toContain("/tmp/secret/v.sqlite");
    expect(e.message).not.toContain("sk-test-cred-1234567890abcdef");
    // raw retained internally on the error fields
    expect(e.originalError.message).toContain("/tmp/secret/v.sqlite");
    expect(e.rollbackErrors[0].message).toContain("/tmp/secret/v.sqlite");
  });

  // P0#1: existing page snapshot read failure is fail-closed (no empty baseline).
  test("existing page: raw vector read failure throws SyncSnapshotError (fail-closed)", async () => {
    db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'record', 'T', ?, 'h')").run("p/fc", "p/fc.md");
    db.insertChunkWithLevel("p/fc", 0, "real chunk", 0, null);
    await lance.addChunks([{ pageSlug: "p/fc", chunkIndex: 0, content: "real chunk", vector: new Float32Array(2048).fill(0.5) }]);
    const origRead = lance.readRawVectorRows.bind(lance);
    (lance as any).readRawVectorRows = async () => { throw new Error("read boom /tmp/secret/v.sqlite"); };
    await expect(snapshotIndexState(db, lance, "p/fc", true)).rejects.toBeInstanceOf(SyncSnapshotError);
    (lance as any).readRawVectorRows = origRead;
    // existing vectors untouched — the snapshot step must not mutate anything
    const rows = await lance.readRawVectorRows("p/fc");
    expect(rows.length).toBe(1);
    expect(rows[0].content).toBe("real chunk");
  });

  test("existing page: L1 read failure throws SyncSnapshotError (fail-closed)", async () => {
    db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'record', 'T', ?, 'h')").run("p/fc2", "p/fc2.md");
    await lance.addChunks([{ pageSlug: "p/fc2", chunkIndex: 0, content: "c", vector: new Float32Array(2048).fill(0.1) }]);
    const origL1 = lance.readL1VectorRows.bind(lance);
    (lance as any).readL1VectorRows = async () => { throw new Error("l1 boom"); };
    await expect(snapshotIndexState(db, lance, "p/fc2", true)).rejects.toBeInstanceOf(SyncSnapshotError);
    (lance as any).readL1VectorRows = origL1;
  });

  test("new page: read failure yields empty snapshot (allowed, not fail-closed)", async () => {
    (lance as any).readRawVectorRows = async () => { throw new Error("mock missing table"); };
    (lance as any).readL1VectorRows = async () => { throw new Error("mock missing table"); };
    const snap = await snapshotIndexState(db, lance, "brand/new", false);
    expect(snap.rawRows).toEqual([]);
    expect(snap.l1Rows).toEqual([]);
  });

  test("SyncSnapshotError message is sanitized and exposes structured code", async () => {
    db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'record', 'T', ?, 'h')").run("p/san", "p/san.md");
    const origRead = lance.readRawVectorRows.bind(lance);
    (lance as any).readRawVectorRows = async () => { throw new Error("read fail /tmp/secret/v.sqlite with sk-test-cred-1234567890abcdef"); };
    let caught: SyncSnapshotError | null = null;
    try { await snapshotIndexState(db, lance, "p/san", true); } catch (e) { caught = e as SyncSnapshotError; }
    (lance as any).readRawVectorRows = origRead;
    expect(caught).toBeInstanceOf(SyncSnapshotError);
    expect(caught!.code).toBe("SYNC_SNAPSHOT_FAILED");
    expect(caught!.recoveryRequired).toBe(true);
    expect(caught!.message).not.toContain("/tmp/secret/v.sqlite");
    expect(caught!.message).not.toContain("sk-test-cred-1234567890abcdef");
    // raw retained internally
    expect(caught!.readError.message).toContain("/tmp/secret/v.sqlite");
  });

  // P1#4: restore must verify SQLite state (not just Lance vectors).
  test("restore returns ok=false when SQLite chunks were not written (no-op compensation)", async () => {
    db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'record', 'T', ?, 'h')").run("p/noop", "p/noop.md");
    db.insertChunkWithLevel("p/noop", 0, "orig-zero", 0, null);
    db.insertChunkWithLevel("p/noop", 1, "orig-one", 0, null);
    await lance.addChunks([
      { pageSlug: "p/noop", chunkIndex: 0, content: "orig-zero", vector: new Float32Array(2048).fill(0.3) },
      { pageSlug: "p/noop", chunkIndex: 1, content: "orig-one", vector: new Float32Array(2048).fill(0.4) },
    ]);
    const snap = await snapshotIndexState(db, lance, "p/noop", true);
    await lance.deleteRawChunksByPageSlug("p/noop");
    db.transaction(() => { db.deleteChunksByPage("p/noop"); db.ftsDeleteByPage("p/noop"); });
    // inject no-op SQLite chunk write — Lance still restores, SQLite does not
    const origInsert = db.insertChunk.bind(db);
    (db as any).insertChunk = (_s: string, _i: number, _c: string) => { /* no-op */ };
    const result = await restoreIndexState(db, lance, "p/noop", snap);
    (db as any).insertChunk = origInsert;
    expect(result.ok).toBe(false);
  });

  test("restore returns ok=false when FTS retains replacement-only content not in snapshot", async () => {
    db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'record', 'T', ?, 'h')").run("p/fts", "p/fts.md");
    db.insertChunkWithLevel("p/fts", 0, "old content unique words", 0, null);
    await lance.addChunks([{ pageSlug: "p/fts", chunkIndex: 0, content: "old content unique words", vector: new Float32Array(2048).fill(0.2) }]);
    const snap = await snapshotIndexState(db, lance, "p/fts", true);
    await lance.deleteRawChunksByPageSlug("p/fts");
    db.transaction(() => { db.deleteChunksByPage("p/fts"); db.ftsDeleteByPage("p/fts"); });
    // inject a stale replacement-only FTS row that a no-op ftsDelete leaves behind
    const origFtsDelete = db.ftsDeleteByPage.bind(db);
    (db as any).ftsDeleteByPage = (_s: string) => { /* no-op */ };
    db.ftsInsert("p/fts", "REPLACEMENT ONLY CONTENT THAT SHOULD NOT SURVIVE");
    const result = await restoreIndexState(db, lance, "p/fts", snap);
    (db as any).ftsDeleteByPage = origFtsDelete;
    expect(result.ok).toBe(false);
  });

  test("restore returns ok=false when L1 summary content/hash mismatch after restore", async () => {
    db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'record', 'T', ?, 'h')").run("p/l1m", "p/l1m.md");
    db.insertChunkWithLevel("p/l1m", 0, "raw0", 0, null);
    db.insertChunkWithLevel("p/l1m", -1, "sealed L1", 1, "l1hash");
    await lance.addChunks([
      { pageSlug: "p/l1m", chunkIndex: 0, content: "raw0", vector: new Float32Array(2048).fill(0.2) },
      { pageSlug: "p/l1m", chunkIndex: -1, content: "sealed L1", vector: new Float32Array(2048).fill(0.8) },
    ]);
    const snap = await snapshotIndexState(db, lance, "p/l1m", true);
    await lance.deleteRawChunksByPageSlug("p/l1m");
    await lance.deleteL1VectorByPageSlug("p/l1m");
    db.transaction(() => { db.deleteChunksByPage("p/l1m"); db.ftsDeleteByPage("p/l1m"); db.deleteL1Summary("p/l1m"); });
    // inject: L1 summary restored with tampered content/hash
    const origL1 = db.insertChunkWithLevel.bind(db);
    (db as any).insertChunkWithLevel = (s: string, i: number, _c: string, lvl: number, _h: string | null) => {
      if (lvl === 1) { origL1(s, i, "TAMPERED L1 SUMMARY", lvl, "wronghash"); return; }
      origL1(s, i, _c, lvl, _h);
    };
    const result = await restoreIndexState(db, lance, "p/l1m", snap);
    (db as any).insertChunkWithLevel = origL1;
    expect(result.ok).toBe(false);
  });
});

describe("syncPage rollback (#185)", () => {
  let db: CBrainDB; let lance: LanceDBManager; let vault: string;
  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    vault = join(TEST_DIR, "vault"); mkdirSync(vault, { recursive: true });
    db = newDb();
    lance = new LanceDBManager();
    await lance.connect(join(TEST_DIR, "lance"));
  });
  afterEach(() => { db.close(); });

  function mkSync(l: LanceDBManager = lance) {
    return new SyncManager(db, fakeEmbeddingProvider() as any, l as any, { chunkSize: 50 });
  }

  // Scenario 1: embedding failure on an EXISTING page → nothing durable changes.
  test("embedding failure leaves metadata/tags/ingestHash/versionCount/chunks/FTS/vectors unchanged", async () => {
    writeMd(vault, "records/r1.md", { title: "R1", type: "record", slug: "records/r1", tags: ["a"] }, "first body line one two three");
    await mkSync().syncAll(vault);
    const slug = "records/r1";
    // Seed a non-null ingest hash (simulates prior API ingest) so the
    // embedding-failure invariant is NON-VACUOUS (#185 acceptance #1).
    db.updateIngestHash(slug, "seed-ingest-hash-value");
    const before = {
      title: db.getPage(slug)!.title,
      tags: db.getTags(slug),
      ingestHash: db.getPageIngestHash(slug),
      versionCount: db.getVersionCount(slug),
      chunks: db.getChunksByPage(slug, { summaryLevel: 0 }).map(c => c.content),
      rawVec: (await lance.readRawVectorRows(slug)).map(r => r.vector[0]),
      contentHash: db.getPageContentHash(slug),
    };

    writeMd(vault, "records/r1.md", { title: "R1-NEW", type: "record", slug: "records/r1", tags: ["z"] }, "second body different content here");
    const badEmbed = fakeEmbeddingProvider();
    (badEmbed as any).embedBatch = async () => { throw new Error("EMBED_DOWN"); };
    (badEmbed as any).embed = async () => { throw new Error("EMBED_DOWN"); };
    const failSync = new SyncManager(db, badEmbed as any, lance as any, { chunkSize: 50 });
    await expect(failSync.syncPage(slug, vault)).rejects.toThrow("EMBED_DOWN");

    expect(db.getPage(slug)!.title).toBe(before.title);
    expect(db.getTags(slug)).toEqual(before.tags);
    expect(db.getPageIngestHash(slug)).toBe(before.ingestHash);
    expect(db.getVersionCount(slug)).toBe(before.versionCount);
    expect(db.getChunksByPage(slug, { summaryLevel: 0 }).map(c => c.content)).toEqual(before.chunks);
    expect((await lance.readRawVectorRows(slug)).map(r => r.vector[0])).toEqual(before.rawVec);
    expect(db.getPageContentHash(slug)).toBe(before.contentHash);
  });

  // Scenario 2: Lance delete ok, add fails → exact old vectors + SQLite/FTS restored.
  test("Lance add failure restores exact old vectors and SQLite chunks", async () => {
    writeMd(vault, "records/r2.md", { title: "R2", type: "record", slug: "records/r2" }, "seed body alpha beta gamma");
    await mkSync().syncAll(vault);
    const slug = "records/r2";
    const oldVec = await lance.readRawVectorRows(slug);
    expect(oldVec.length).toBeGreaterThan(0);
    const oldChunks = db.getChunksByPage(slug, { summaryLevel: 0 }).map(c => c.content);

    writeMd(vault, "records/r2.md", { title: "R2", type: "record", slug: "records/r2" }, "completely rewritten body delta echo");
    const flaky = new LanceDBManager();
    await flaky.connect(join(TEST_DIR, "lance"));
    const origAdd = flaky.addChunks.bind(flaky);
    (flaky as any).addChunks = async (chunks: any[]) => {
      if (chunks.some((c: any) => c.chunkIndex >= 0 && c.content.includes("rewritten"))) throw new Error("LANCE_ADD_FAILED");
      return origAdd(chunks);
    };
    const failSync = new SyncManager(db, fakeEmbeddingProvider() as any, flaky as any, { chunkSize: 50 });
    await expect(failSync.syncPage(slug, vault)).rejects.toThrow("LANCE_ADD_FAILED");

    const restored = await lance.readRawVectorRows(slug);
    expect(restored.length).toBe(oldVec.length);
    for (let i = 0; i < oldVec.length; i++) {
      expect(restored[i].content).toBe(oldVec[i].content);
      for (let j = 0; j < oldVec[i].vector.length; j++) expect(restored[i].vector[j]).toBe(oldVec[i].vector[j]);
    }
    expect(db.getChunksByPage(slug, { summaryLevel: 0 }).map(c => c.content)).toEqual(oldChunks);
  });

  // Scenario 3: SQLite chunk tx fails after Lance replaced → both stores restored.
  test("SQLite chunk transaction failure restores Lance AND SQLite old state", async () => {
    writeMd(vault, "records/r3.md", { title: "R3", type: "record", slug: "records/r3" }, "original chunk content for r3");
    await mkSync().syncAll(vault);
    const slug = "records/r3";
    const oldVec = (await lance.readRawVectorRows(slug)).map(r => ({ c: r.content, v: [...r.vector] }));
    const oldChunks = db.getChunksByPage(slug, { summaryLevel: 0 }).map(c => c.content);

    writeMd(vault, "records/r3.md", { title: "R3", type: "record", slug: "records/r3" }, "new content that should not persist at all");
    const origInsert = db.insertChunk.bind(db);
    (db as any).insertChunk = (s: string, idx: number, _content: string) => {
      if (s === "records/r3" && _content.includes("should not persist")) throw new Error("SQLTX_FAILED");
      return origInsert(s, idx, _content);
    };
    const failSync = new SyncManager(db, fakeEmbeddingProvider() as any, lance as any, { chunkSize: 50 });
    await expect(failSync.syncPage(slug, vault)).rejects.toThrow();
    (db as any).insertChunk = origInsert;

    const restored = await lance.readRawVectorRows(slug);
    expect(restored.map(r => r.content)).toEqual(oldVec.map(o => o.c));
    expect(db.getChunksByPage(slug, { summaryLevel: 0 }).map(c => c.content)).toEqual(oldChunks);
  });

  // Scenario 5: injected rollback failure → structured recovery-required result.
  test("rollback failure surfaces SyncRollbackError and stays visible", async () => {
    writeMd(vault, "records/r5.md", { title: "R5", type: "record", slug: "records/r5" }, "seed content r5");
    await mkSync().syncAll(vault);
    const slug = "records/r5";
    writeMd(vault, "records/r5.md", { title: "R5", type: "record", slug: "records/r5" }, "new content r5 rewrite");

    const flaky = new LanceDBManager();
    await flaky.connect(join(TEST_DIR, "lance"));
    (flaky as any).addChunks = async () => { throw new Error("LANCE_ADD_FAILED"); };
    const failSync = new SyncManager(db, fakeEmbeddingProvider() as any, flaky as any, { chunkSize: 50 });
    await expect(failSync.syncPage(slug, vault)).rejects.toBeInstanceOf(SyncRollbackError);
  });

  // P0#1 fault injection: snapshot read failure on an existing page aborts with
  // zero durable index/metadata changes (no empty-baseline mutation).
  test("existing page snapshot read failure aborts sync with zero durable changes", async () => {
    writeMd(vault, "records/snap.md", { title: "Snap", type: "record", slug: "records/snap", tags: ["t"] }, "seed body alpha beta gamma delta");
    await mkSync().syncAll(vault);
    const slug = "records/snap";
    const before = {
      title: db.getPage(slug)!.title,
      tags: db.getTags(slug),
      chunks: db.getChunksByPage(slug, { summaryLevel: 0 }).map(c => c.content),
      rawContents: (await lance.readRawVectorRows(slug)).map(r => r.content),
      contentHash: db.getPageContentHash(slug),
    };
    writeMd(vault, "records/snap.md", { title: "Snap-NEW", type: "record", slug: "records/snap", tags: ["z"] }, "completely different body echo foxtrot golf");
    const origRead = lance.readRawVectorRows.bind(lance);
    (lance as any).readRawVectorRows = async () => { throw new Error("LANCE_READ_BOOM /tmp/secret"); };
    const failSync = mkSync(lance);
    await expect(failSync.syncPage(slug, vault)).rejects.toBeInstanceOf(SyncSnapshotError);
    (lance as any).readRawVectorRows = origRead;
    expect(db.getPage(slug)!.title).toBe(before.title);
    expect(db.getTags(slug)).toEqual(before.tags);
    expect(db.getChunksByPage(slug, { summaryLevel: 0 }).map(c => c.content)).toEqual(before.chunks);
    expect((await lance.readRawVectorRows(slug)).map(r => r.content)).toEqual(before.rawContents);
    expect(db.getPageContentHash(slug)).toBe(before.contentHash);
  });

  // P0#2: a real page row with content_hash=NULL (retry/migration state) must be
  // treated as EXISTING — index failure compensates instead of deleting the page.
  test("existing page with NULL content_hash is not deleted on syncPage failure", async () => {
    writeMd(vault, "records/null1.md", { title: "Null1", type: "record", slug: "records/null1" }, "original body one two three four five");
    await mkSync().syncAll(vault);
    const slug = "records/null1";
    db.rawDb.prepare("UPDATE pages SET content_hash = NULL WHERE slug = ?").run(slug);
    expect(db.getPageContentHash(slug)).toBeNull();
    expect(db.getPage(slug)).not.toBeNull();
    const beforeChunks = db.getChunksByPage(slug, { summaryLevel: 0 }).map(c => c.content);
    const beforeRaw = (await lance.readRawVectorRows(slug)).length;

    writeMd(vault, "records/null1.md", { title: "Null1", type: "record", slug: "records/null1" }, "rewritten body should not wipe this existing page");
    const flaky = new LanceDBManager();
    await flaky.connect(join(TEST_DIR, "lance"));
    const realAdd = lance.addChunks.bind(lance);
    (flaky as any).addChunks = async (chunks: any[]) => {
      if (chunks.some((c: any) => c.content.includes("rewritten"))) throw new Error("LANCE_ADD_FAILED");
      return realAdd(chunks);
    };
    const failSync = new SyncManager(db, fakeEmbeddingProvider() as any, flaky as any, { chunkSize: 50 });
    await expect(failSync.syncPage(slug, vault)).rejects.toThrow("LANCE_ADD_FAILED");

    expect(db.getPage(slug)).not.toBeNull();
    expect(db.getChunksByPage(slug, { summaryLevel: 0 }).map(c => c.content)).toEqual(beforeChunks);
    expect((await lance.readRawVectorRows(slug)).length).toBe(beforeRaw);
  });

  // P1#5: new-page rollback failure must persist a recovery-required audit.
  test("new-page rollback failure persists a recovery-required audit", async () => {
    writeMd(vault, "records/newfail.md", { title: "NewFail", type: "record", slug: "records/newfail" }, "brand new body content for newfail page here");
    const flaky = new LanceDBManager();
    await flaky.connect(join(TEST_DIR, "lance"));
    (flaky as any).addChunks = async () => { throw new Error("LANCE_ADD_FAILED"); };
    (flaky as any).deleteByPageSlug = async () => { throw new Error("LANCE_DELETE_BOOM"); };
    const failSync = new SyncManager(db, fakeEmbeddingProvider() as any, flaky as any, { chunkSize: 50 });
    await expect(failSync.syncPage("records/newfail", vault)).rejects.toBeInstanceOf(SyncRollbackError);
    const logs = db.rawDb.prepare("SELECT details FROM ingest_log WHERE page_slug = ?").all("records/newfail") as Array<{ details: string }>;
    const recoveryLog = logs.find((l) => l.details.includes("reindexRequired"));
    expect(recoveryLog).toBeTruthy();
  });

  // P1#5: compensation messages (SyncRollbackError + audit) must be sanitized.
  test("compensation surfaces sanitized messages (no path/credential leak)", async () => {
    writeMd(vault, "records/priv.md", { title: "Priv", type: "record", slug: "records/priv" }, "seed body for privacy test page here words");
    await mkSync().syncAll(vault);
    const slug = "records/priv";
    writeMd(vault, "records/priv.md", { title: "Priv", type: "record", slug: "records/priv" }, "rewritten body privacy test content words here");
    const flaky = new LanceDBManager();
    await flaky.connect(join(TEST_DIR, "lance"));
    (flaky as any).addChunks = async () => { throw new Error("boom at /tmp/secret/priv.sqlite key sk-test-cred-1234567890abcdef"); };
    const failSync = new SyncManager(db, fakeEmbeddingProvider() as any, flaky as any, { chunkSize: 50 });
    let caught: SyncRollbackError | null = null;
    try { await failSync.syncPage(slug, vault); } catch (e) { caught = e as SyncRollbackError; }
    expect(caught).toBeInstanceOf(SyncRollbackError);
    expect(caught!.message).not.toContain("/tmp/secret/priv.sqlite");
    expect(caught!.message).not.toContain("sk-test-cred-1234567890abcdef");
    const logs = db.rawDb.prepare("SELECT details FROM ingest_log WHERE page_slug = ?").all(slug) as Array<{ details: string }>;
    const allDetails = logs.map((l) => l.details).join(" ");
    expect(allDetails).not.toContain("/tmp/secret/priv.sqlite");
    expect(allDetails).not.toContain("sk-test-cred-1234567890abcdef");
  });

  // #6: true integration fault for the empty-body path — proves syncPage() invokes
  // compensation after writeIndexes deletes raw + L1 (not a helper-only simulation).
  test("empty-body syncPage with writeIndexes failure restores raw + L1 + L1 summary", async () => {
    writeMd(vault, "records/empty.md", { title: "Empty", type: "record", slug: "records/empty" }, "seed body long enough to chunk into multiple pieces and seal an l1 summary here words");
    await mkSync().syncAll(vault);
    const slug = "records/empty";
    // ensure an L1 summary + L1 vector exist (the empty-body writeIndexes path deletes them)
    db.insertChunkWithLevel(slug, -1, "MANUAL SEALED L1 SUMMARY TEXT", 1, "l1hash-manual");
    await lance.addChunks([{ pageSlug: slug, chunkIndex: -1, content: "MANUAL SEALED L1 SUMMARY TEXT", vector: new Float32Array(2048).fill(0.9) }]);
    const before = {
      rawCount: (await lance.readRawVectorRows(slug)).length,
      l1VecCount: (await lance.readL1VectorRows(slug)).length,
      l1Summary: db.getL1Summary(slug)?.content,
      chunks: db.getChunksByPage(slug, { summaryLevel: 0 }).map(c => c.content),
    };
    expect(before.rawCount).toBeGreaterThan(0);
    expect(before.l1VecCount).toBeGreaterThan(0);
    expect(before.l1Summary).toBeTruthy();

    // rewrite to an EMPTY body — writeIndexes takes the empty path (delete raw + L1)
    writeMd(vault, "records/empty.md", { title: "Empty", type: "record", slug: "records/empty" }, "");
    // inject failure in writeIndexes' empty path (1st deleteL1VectorByPageSlug);
    // the 2nd call (compensation restore) must succeed.
    let l1DeleteCalls = 0;
    const origDelL1Vec = lance.deleteL1VectorByPageSlug.bind(lance);
    (lance as any).deleteL1VectorByPageSlug = async (s: string) => {
      l1DeleteCalls++;
      if (l1DeleteCalls === 1) throw new Error("LANCE_L1_DEL_BOOM");
      return origDelL1Vec(s);
    };
    const failSync = mkSync(lance);
    await expect(failSync.syncPage(slug, vault)).rejects.toThrow("LANCE_L1_DEL_BOOM");
    (lance as any).deleteL1VectorByPageSlug = origDelL1Vec;

    expect((await lance.readRawVectorRows(slug)).length).toBe(before.rawCount);
    expect((await lance.readL1VectorRows(slug)).length).toBe(before.l1VecCount);
    expect(db.getL1Summary(slug)?.content).toBe(before.l1Summary);
    expect(db.getChunksByPage(slug, { summaryLevel: 0 }).map(c => c.content)).toEqual(before.chunks);
  });
});

describe("syncAll rollback (#185)", () => {
  let db: CBrainDB; let lance: LanceDBManager; let vault: string;
  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    vault = join(TEST_DIR, "vault"); mkdirSync(vault, { recursive: true });
    db = newDb();
    lance = new LanceDBManager();
    await lance.connect(join(TEST_DIR, "lance"));
  });
  afterEach(() => { db.close(); });

  // Scenario 4: new page + downstream failure → no DB/FTS/chunk/vector residue; vault file kept.
  test("new page index failure leaves no durable residue and keeps vault file", async () => {
    writeMd(vault, "records/new1.md", { title: "New1", type: "record", slug: "records/new1" }, "brand new content for new1 page");
    const flaky = new LanceDBManager();
    await flaky.connect(join(TEST_DIR, "lance"));
    (flaky as any).addChunks = async () => { throw new Error("LANCE_ADD_FAILED"); };
    const failSync = new SyncManager(db, fakeEmbeddingProvider(), flaky as any, { chunkSize: 50 });
    const report = await failSync.syncAll(vault);
    expect(report.errors).toBe(1);

    expect(db.getPage("records/new1")).toBeNull();
    expect(db.getChunksByPage("records/new1", { summaryLevel: 0 })).toEqual([]);
    expect((await lance.readRawVectorRows("records/new1"))).toEqual([]);
    // Vault file preserved (user-owned).
    expect(existsSync(join(vault, "records/new1.md"))).toBe(true);
  });

  // Scenario 6: successful sync behavior unchanged; retry semantics intact.
  test("successful sync persists hash; failed-then-retry recovers", async () => {
    writeMd(vault, "records/ok1.md", { title: "Ok1", type: "record", slug: "records/ok1" }, "good content ok1");
    const r1 = await new SyncManager(db, fakeEmbeddingProvider(), lance as any, { chunkSize: 50 }).syncAll(vault);
    expect(r1.synced).toBe(1);
    expect(r1.errors).toBe(0);
    expect(db.getPageContentHash("records/ok1")).not.toBeNull();
    expect((await lance.readRawVectorRows("records/ok1")).length).toBeGreaterThan(0);

    // Re-sync unchanged → skipped, no new vectors.
    const before = (await lance.readRawVectorRows("records/ok1")).length;
    const r2 = await new SyncManager(db, fakeEmbeddingProvider(), lance as any, { chunkSize: 50 }).syncAll(vault);
    expect(r2.synced).toBe(0);
    expect((await lance.readRawVectorRows("records/ok1")).length).toBe(before);
  });

  // P0#2: syncAll must also treat a NULL-hash existing page as existing.
  test("existing page with NULL content_hash is not deleted on syncAll index failure", async () => {
    writeMd(vault, "records/nulla.md", { title: "NullA", type: "record", slug: "records/nulla" }, "first body for nulla page content words here");
    await new SyncManager(db, fakeEmbeddingProvider(), lance as any, { chunkSize: 50 }).syncAll(vault);
    const slug = "records/nulla";
    db.rawDb.prepare("UPDATE pages SET content_hash = NULL WHERE slug = ?").run(slug);
    const beforeChunks = db.getChunksByPage(slug, { summaryLevel: 0 }).map(c => c.content);

    writeMd(vault, "records/nulla.md", { title: "NullA", type: "record", slug: "records/nulla" }, "rewritten nulla body brand new content words");
    const flaky = new LanceDBManager();
    await flaky.connect(join(TEST_DIR, "lance"));
    const realAdd = lance.addChunks.bind(lance);
    (flaky as any).addChunks = async (chunks: any[]) => {
      if (chunks.some((c: any) => c.content.includes("rewritten"))) throw new Error("LANCE_ADD_FAILED");
      return realAdd(chunks);
    };
    const report = await new SyncManager(db, fakeEmbeddingProvider() as any, flaky as any, { chunkSize: 50 }).syncAll(vault);
    expect(report.errors).toBe(1);
    expect(db.getPage(slug)).not.toBeNull();
    expect(db.getChunksByPage(slug, { summaryLevel: 0 }).map(c => c.content)).toEqual(beforeChunks);
  });

  // #6: existing-page rollback coverage for syncAll (not only syncPage) — proves
  // syncAll() compensates an existing page's index back to its exact pre-sync state.
  test("existing page rollback on syncAll failure restores chunks + raw + L1", async () => {
    writeMd(vault, "records/exist1.md", { title: "Exist1", type: "record", slug: "records/exist1" }, "original body long enough to chunk and seal an l1 summary here words content");
    await new SyncManager(db, fakeEmbeddingProvider() as any, lance as any, { chunkSize: 50 }).syncAll(vault);
    const slug = "records/exist1";
    // ensure an L1 summary + L1 vector exist so restore covers them.
    db.insertChunkWithLevel(slug, -1, "MANUAL SEALED L1 SUMMARY EXIST1", 1, "l1hash-exist1");
    await lance.addChunks([{ pageSlug: slug, chunkIndex: -1, content: "MANUAL SEALED L1 SUMMARY EXIST1", vector: new Float32Array(2048).fill(0.7) }]);
    const before = {
      chunks: db.getChunksByPage(slug, { summaryLevel: 0 }).map(c => c.content),
      rawCount: (await lance.readRawVectorRows(slug)).length,
      l1VecCount: (await lance.readL1VectorRows(slug)).length,
      l1Summary: db.getL1Summary(slug)?.content,
    };
    expect(before.rawCount).toBeGreaterThan(0);
    expect(before.l1VecCount).toBeGreaterThan(0);

    writeMd(vault, "records/exist1.md", { title: "Exist1", type: "record", slug: "records/exist1" }, "rewritten body that should not be persisted on syncAll index failure words");
    const flaky = new LanceDBManager();
    await flaky.connect(join(TEST_DIR, "lance"));
    const realAdd = lance.addChunks.bind(lance);
    (flaky as any).addChunks = async (chunks: any[]) => {
      if (chunks.some((c: any) => c.content.includes("rewritten"))) throw new Error("LANCE_ADD_FAILED");
      return realAdd(chunks);
    };
    const report = await new SyncManager(db, fakeEmbeddingProvider() as any, flaky as any, { chunkSize: 50 }).syncAll(vault);
    expect(report.errors).toBe(1);

    expect(db.getPage(slug)).not.toBeNull();
    expect(db.getChunksByPage(slug, { summaryLevel: 0 }).map(c => c.content)).toEqual(before.chunks);
    expect((await lance.readRawVectorRows(slug)).length).toBe(before.rawCount);
    expect((await lance.readL1VectorRows(slug)).length).toBe(before.l1VecCount);
    expect(db.getL1Summary(slug)?.content).toBe(before.l1Summary);
  });
});
