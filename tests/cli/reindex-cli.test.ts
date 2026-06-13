import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import {
  resolveSyncMode,
  handleReindexSlug,
  handleReindexQuarantined,
  createLiveLockProbe,
  type LockProbe,
} from "../../src/cli/commands/reindex.js";

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

const TEST_DIR = "/tmp/cbrain-test-reindex-cli";

function seedPage(db: CBrainDB, slug: string, rawChunks: string[]): void {
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
}

function setQuarantine(
  db: CBrainDB,
  entries: Record<string, { failCount: number; lastError: string; quarantinedAt: string }>,
): void {
  db.setConfig("watcher.quarantine", JSON.stringify(entries));
}

function readQuarantine(db: CBrainDB): Record<string, unknown> | null {
  const raw = db.getConfig("watcher.quarantine");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

// ── Scenario 9: option resolution ───────────────────────────────────────

describe("resolveSyncMode (option conflicts)", () => {
  test("--reindex without --slug → error", () => {
    const r = resolveSyncMode({ reindex: true });
    expect(r.ok).toBe(false);
  });

  test("--slug + --reindex-vectors → error", () => {
    const r = resolveSyncMode({ slug: "entities/a", reindexVectors: true });
    expect(r.ok).toBe(false);
  });

  test("--reindex + --reindex-vectors → error", () => {
    const r = resolveSyncMode({ slug: "entities/a", reindex: true, reindexVectors: true });
    expect(r.ok).toBe(false);
  });

  test("--reindex-quarantined + --slug → error", () => {
    const r = resolveSyncMode({ slug: "entities/a", reindexQuarantined: true });
    expect(r.ok).toBe(false);
  });

  test("--reindex-quarantined + --reindex → error", () => {
    const r = resolveSyncMode({ reindex: true, reindexQuarantined: true });
    expect(r.ok).toBe(false);
  });

  test("valid combos resolve to the right mode", () => {
    expect(resolveSyncMode({ slug: "entities/a", reindex: true })).toEqual({ ok: true, mode: "reindex-slug" });
    expect(resolveSyncMode({ reindexQuarantined: true })).toEqual({ ok: true, mode: "reindex-quarantined" });
    expect(resolveSyncMode({ reindexVectors: true })).toEqual({ ok: true, mode: "reindex-vectors" });
    expect(resolveSyncMode({ slug: "entities/a" })).toEqual({ ok: true, mode: "sync-slug" });
    expect(resolveSyncMode({})).toEqual({ ok: true, mode: "sync-all" });
  });
});

// ── Scenario 10: lock refusal ───────────────────────────────────────────

describe("handleReindexSlug — lock gate", () => {
  const dbPath = join(TEST_DIR, "lock.sqlite");
  const lancePath = join(TEST_DIR, "lance");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = new CBrainDB(dbPath);
  });
  afterEach(() => {
    try { db.close(); } catch { /* */ }
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("refuses when a live serve/watcher is active; never touches lance", async () => {
    const blocking: LockProbe = { blockingOwner: () => ({ kind: "serve", pid: 4242 }) };
    // A lance stub whose connect throws — proves the handler never reached it.
    const boomLance = {
      connect: async () => { throw new Error("MUST NOT CONNECT"); },
      close: async () => {},
    };
    const logs: string[] = [];
    const errs: string[] = [];
    const exit = await handleReindexSlug(
      { db, lance: boomLance as unknown as LanceDBManager, embedding: fakeEmbeddingProvider(), pageSlug: "entities/a", lancePath, lockProbe: blocking },
      (m) => logs.push(m),
      (m) => errs.push(m),
    );
    expect(exit).toBe(1);
    expect(errs.some((e) => e.includes("已拒绝") && e.includes("4242"))).toBe(true);
    expect(logs).toHaveLength(0);
  });

  test("createLiveLockProbe returns null when profile dir has no locks", () => {
    const probe = createLiveLockProbe(TEST_DIR);
    expect(probe.blockingOwner()).toBeNull();
  });

  test("closes DB and Lance even on lock refusal (never connects)", async () => {
    const dbClose = mock(() => {});
    const lanceClose = mock(async () => {});
    const blocking: LockProbe = { blockingOwner: () => ({ kind: "serve", pid: 4242 }) };
    const lanceBoom = {
      connect: mock(async () => { throw new Error("MUST NOT CONNECT"); }),
      close: lanceClose,
    } as unknown as LanceDBManager;
    const exit = await handleReindexSlug(
      { db: { close: dbClose } as unknown as CBrainDB, lance: lanceBoom, embedding: fakeEmbeddingProvider(), pageSlug: "entities/a", lancePath, lockProbe: blocking },
      () => {},
      () => {},
    );
    expect(exit).toBe(1);
    expect(dbClose).toHaveBeenCalledTimes(1);
    expect(lanceClose).toHaveBeenCalledTimes(1);
    expect(lanceBoom.connect).not.toHaveBeenCalled();
  });
});

// ── Scenarios 11,12,13: --reindex-quarantined ──────────────────────────

describe("handleReindexQuarantined", () => {
  const dbPath = join(TEST_DIR, "q.sqlite");
  const lancePath = join(TEST_DIR, "lance");
  let db: CBrainDB;
  const embedding = fakeEmbeddingProvider();
  const open: LockProbe = { blockingOwner: () => null };

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = new CBrainDB(dbPath);
  });
  afterEach(() => {
    try { db.close(); } catch { /* */ }
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  // Scenario 11: mixed set — vector fault rebuilt+released; non-vector kept; non-zero exit
  test("mixed quarantine: vector fault rebuilt+released, non-vector kept, exit non-zero", async () => {
    // Vector-fault slug: seed SQLite page + raw chunk + a live row to replace
    seedPage(db, "entities/V", ["v-new-0"]);
    const live = new LanceDBManager();
    await live.connect(lancePath);
    await live.addChunks([{ pageSlug: "entities/V", chunkIndex: 0, content: "v-old-0", vector: new Float32Array(2048).fill(0.5) }]);
    await live.close();

    setQuarantine(db, {
      "entities/V": { failCount: 3, lastError: "embedding service timed out (500)", quarantinedAt: "2026-01-01T00:00:00.000Z" },
      "entities/T": { failCount: 3, lastError: "TitleCollisionError: duplicate title", quarantinedAt: "2026-01-01T00:00:00.000Z" },
      "entities/P": { failCount: 3, lastError: "frontmatter parse error: bad yaml", quarantinedAt: "2026-01-01T00:00:00.000Z" },
    });

    const logs: string[] = [];
    const errs: string[] = [];
    const exit = await handleReindexQuarantined(
      { db: new CBrainDB(dbPath), lance: new LanceDBManager(), embedding, lancePath, lockProbe: open },
      (m) => logs.push(m),
      (m) => errs.push(m),
    );

    expect(exit).toBe(1); // not all rebuilt (2 of 3 skipped)

    // Re-open to inspect final config state (handler closed its db)
    const after = new CBrainDB(dbPath);
    const q = readQuarantine(after);
    after.close();
    expect(q).not.toBeNull();
    expect(Object.keys(q!)).toHaveLength(2);
    expect(q!["entities/V"]).toBeUndefined(); // released
    expect(q!["entities/T"]).toBeDefined(); // kept
    expect(q!["entities/P"]).toBeDefined(); // kept

    // Vector-fault slug now rebuilt in live
    const v = new LanceDBManager();
    await v.connect(lancePath);
    const raw = await v.readRawVectorRows("entities/V");
    expect(raw.map((r) => r.content)).toEqual(["v-new-0"]);
    await v.close();
  });

  // Scenario 12: corrupt JSON → fail, config byte-for-byte unchanged
  test("corrupt quarantine JSON → fail, config unchanged", async () => {
    const corrupt = "{ this is :: not json";
    db.setConfig("watcher.quarantine", corrupt);

    const errs: string[] = [];
    const exit = await handleReindexQuarantined(
      { db: new CBrainDB(dbPath), lance: new LanceDBManager(), embedding, lancePath, lockProbe: open },
      () => {},
      (m) => errs.push(m),
    );
    expect(exit).toBe(1);
    expect(errs.some((e) => e.includes("JSON 损坏"))).toBe(true);

    const after = new CBrainDB(dbPath);
    const raw = after.getConfig("watcher.quarantine");
    after.close();
    expect(raw).toBe(corrupt); // unchanged
  });

  // Scenario 13: output privacy — no real slug / abs path / content / stack
  test("output is anonymized: no real slug, path, content, or stack", async () => {
    seedPage(db, "entities/SECRET", ["SECRET-content-line"]);
    const live = new LanceDBManager();
    await live.connect(lancePath);
    await live.addChunks([{ pageSlug: "entities/SECRET", chunkIndex: 0, content: "SECRET-old", vector: new Float32Array(2048).fill(0.5) }]);
    await live.close();

    setQuarantine(db, {
      "entities/SECRET": { failCount: 3, lastError: "vector dimension mismatch", quarantinedAt: "2026-01-01T00:00:00.000Z" },
    });

    const logs: string[] = [];
    const errs: string[] = [];
    await handleReindexQuarantined(
      { db: new CBrainDB(dbPath), lance: new LanceDBManager(), embedding, lancePath, lockProbe: open },
      (m) => logs.push(m),
      (m) => errs.push(m),
    );

    const all = [...logs, ...errs].join("\n");
    expect(all).not.toContain("entities/SECRET");
    expect(all).not.toContain("SECRET-content-line");
    expect(all).not.toContain("SECRET-old");
    expect(all).not.toContain(TEST_DIR);
    expect(all).not.toMatch(/\bat \w+/); // no stack frame
    // Anonymized id present
    expect(all).toMatch(/page:[0-9a-f]{8}/);
  });

  // P1-2: a malformed entry must not abort the batch; recoverable items still rebuilt.
  test("malformed entries quarantined without aborting batch; recoverable item rebuilt", async () => {
    seedPage(db, "entities/V", ["v-new-0"]);
    const live = new LanceDBManager();
    await live.connect(lancePath);
    await live.addChunks([{ pageSlug: "entities/V", chunkIndex: 0, content: "v-old-0", vector: new Float32Array(2048).fill(0.5) }]);
    await live.close();

    // Hand-built JSON so we can plant malformed entries the typed helper rejects.
    db.setConfig("watcher.quarantine", JSON.stringify({
      "entities/BAD_NULL": null,
      "entities/BAD_STR": "not-an-object",
      "entities/BAD_MISSING": { failCount: 3, quarantinedAt: "2026-01-01T00:00:00.000Z" },
      "entities/V": { failCount: 3, lastError: "embedding timed out (500)", quarantinedAt: "2026-01-01T00:00:00.000Z" },
    }));

    const errs: string[] = [];
    const exit = await handleReindexQuarantined(
      { db: new CBrainDB(dbPath), lance: new LanceDBManager(), embedding, lancePath, lockProbe: open },
      () => {},
      (m) => errs.push(m),
    );

    expect(exit).toBe(1); // 4 items, only V rebuilt
    const after = new CBrainDB(dbPath);
    const q = readQuarantine(after);
    after.close();
    expect(q!["entities/V"]).toBeUndefined();      // rebuilt → released
    expect(q!["entities/BAD_NULL"]).toBeDefined();  // kept
    expect(q!["entities/BAD_STR"]).toBeDefined();
    expect(q!["entities/BAD_MISSING"]).toBeDefined();
    // malformed entries reported as format-damaged (not faked as a non-vector skip)
    expect(errs.some((e) => e.includes("格式损坏"))).toBe(true);
    // no real slug leaked in error output
    expect(errs.some((e) => e.includes("entities/BAD"))).toBe(false);

    const v = new LanceDBManager();
    await v.connect(lancePath);
    expect((await v.readRawVectorRows("entities/V")).map((r) => r.content)).toEqual(["v-new-0"]);
    await v.close();
  });

  // P1-4: corrupt-JSON early-return still closes DB and Lance.
  test("closes DB and Lance even on corrupt quarantine JSON", async () => {
    const dbClose = mock(() => {});
    const lanceClose = mock(async () => {});
    const fakeDb = { getConfig: mock(() => "{ this is :: not json"), close: dbClose } as unknown as CBrainDB;
    const fakeLance = { connect: mock(async () => {}), close: lanceClose } as unknown as LanceDBManager;
    const exit = await handleReindexQuarantined(
      { db: fakeDb, lance: fakeLance, embedding, lancePath, lockProbe: open },
      () => {},
      () => {},
    );
    expect(exit).toBe(1);
    expect(dbClose).toHaveBeenCalledTimes(1);
    expect(lanceClose).toHaveBeenCalledTimes(1);
    expect(fakeLance.connect).not.toHaveBeenCalled(); // returned before connect
  });
});
