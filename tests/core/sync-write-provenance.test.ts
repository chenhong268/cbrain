import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { SyncManager } from "../../src/core/maintenance/sync.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

function createMockEmbeddingProvider(): EmbeddingProvider {
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

function createMockLanceDB() {
  return {
    connect: async () => {},
    addChunks: async () => {},
    search: async () => [],
    fullTextSearch: async () => [],
    deleteByPageSlug: async () => {},
    deleteRawChunksByPageSlug: async () => {},
    deleteL1VectorByPageSlug: async () => {},
    getIndexedPageSlugs: async () => [],
    close: async () => {},
    createFTSIndex: async () => {},
    readRawVectorRows: async () => [],
    readL1VectorRows: async () => [],
    openChunksStrict: async () => { throw new Error("mock: no table"); },
  };
}

function writeMdFile(
  vaultPath: string,
  filePath: string,
  frontmatter: Record<string, unknown>,
  body: string,
): void {
  const matter = [
    "---",
    ...Object.entries(frontmatter).map(([k, v]) => {
      if (Array.isArray(v)) return `${k}:\n${v.map((i) => `  - ${i}`).join("\n")}`;
      return `${k}: ${v}`;
    }),
    "---",
    "",
    body,
  ].join("\n");
  const fullPath = join(vaultPath, filePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, matter, "utf-8");
}

describe("sync attributes vault-discovered record pages to unknown_writer (#386)", () => {
  const testDir = "/tmp/cbrain-test-sync-prov";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let sync: SyncManager;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    sync = new SyncManager(db, createMockEmbeddingProvider(), createMockLanceDB() as never, { chunkSize: 500 });
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("first discovery of a record file writes unknown_writer provenance", async () => {
    writeMdFile(
      vaultPath,
      "records/sync-note.md",
      { title: "Sync Note", type: "record", slug: "records/sync-note" },
      "外部写入的记录内容。",
    );

    const report = await sync.syncAll(vaultPath);
    expect(report.synced).toBe(1);

    const row = db.getPageWriteProvenance("records/sync-note")!;
    expect(row).not.toBeNull();
    expect(row.actor_class).toBe("unknown_writer");
    expect(row.write_mode).toBe("external_direct_write");
    expect(row.creation_reason).toBe("vault_file_discovered");
    expect(row.origin_kind).toBeNull();
  });

  test("re-syncing an existing record page (content update) does NOT overwrite provenance", async () => {
    writeMdFile(
      vaultPath,
      "records/sync-update.md",
      { title: "Sync Update", type: "record", slug: "records/sync-update" },
      "第一版内容。",
    );
    await sync.syncAll(vaultPath);
    const firstRow = db.getPageWriteProvenance("records/sync-update")!;
    expect(firstRow.actor_class).toBe("unknown_writer");

    // Mutate content + re-sync — provenance must be unchanged (append-only).
    writeMdFile(
      vaultPath,
      "records/sync-update.md",
      { title: "Sync Update", type: "record", slug: "records/sync-update" },
      "第二版内容，变了。",
    );
    await sync.syncAll(vaultPath);

    const rowAfter = db.getPageWriteProvenance("records/sync-update")!;
    expect(rowAfter.actor_class).toBe("unknown_writer");
    expect(rowAfter.created_at).toBe(firstRow.created_at);
  });

  test("synced entity page gets NO provenance (v1 scope = record only)", async () => {
    writeMdFile(
      vaultPath,
      "entities/sync-person.md",
      { title: "Sync Person", type: "entity/person", slug: "entities/sync-person" },
      "某人物的资料。",
    );
    await sync.syncAll(vaultPath);

    expect(db.getPageWriteProvenance("entities/sync-person")).toBeNull();
  });
});
