import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { IngestManager } from "../../src/core/ingestion/ingest.js";
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
    readRawVectorRows: async () => [],
    readL1VectorRows: async () => [],
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

describe("Ingest write-path safety — adversarial (#191)", () => {
  const testDir = "/tmp/cbrain-test-ingest-write-safety";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let ingest: IngestManager;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    ingest = new IngestManager(db, createMockEmbeddingProvider(), createMockLanceDB() as never, vaultPath);
  });
  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function count(table: string): number {
    return (db.rawDb.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
  }
  function recordsPages(): string[] {
    return readdirRecords();
  }
  function readdirRecords(): string[] {
    const dir = join(vaultPath, "records");
    if (!existsSync(dir)) return [];
    const { readdirSync } = require("node:fs");
    return readdirSync(dir) as string[];
  }

  test("existing record markdown re-ingested (frontmatter slug) is a no-op: no dup chunks/links", async () => {
    const md = `---\ntitle: 记录A\ntype: record\nslug: records/jilu-a\n---\n\n记录A 的内容，含 [[主题B]]`;
    await ingest.ingest({ content: md, type: "markdown" });
    const pages = count("pages");
    const chunks = count("chunks");
    const links = count("links");

    const r = await ingest.ingest({ content: md, type: "markdown" });

    expect(r.outcome).toBe("duplicate");
    expect(count("pages")).toBe(pages);
    expect(count("chunks")).toBe(chunks);
    expect(count("links")).toBe(links);
  });

  test("frontmatter slug but weak/missing title -> validation failure, no page created", async () => {
    const pagesBefore = count("pages");
    // title is punctuation-only; no semantic body line to fall back to.
    await expect(
      ingest.ingest({ content: `---\ntitle: "---"\ntype: entity/person\nslug: brain/entities/person/shiti-a\n---\n\n---`, type: "markdown" }),
    ).rejects.toThrow(/VALIDATION_ERROR/i);
    expect(count("pages")).toBe(pagesBefore);
  });

  test("path-like title error is sanitized: no local absolute path echoed", async () => {
    const pathTitle = "/Users/example/vault/note.md";
    const err: unknown = await ingest.ingest({
      content: `---\ntitle: ${pathTitle}\ntype: entity/person\n---\n\nbody`,
      type: "markdown",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/VALIDATION_ERROR|path/i);
    // The error must not echo the raw absolute path back to the caller.
    expect(msg).not.toContain(pathTitle);
    expect(msg).not.toMatch(/\/Users\/example/);
  });

  test("entity markdown re-ingest never creates a junk records/ page", async () => {
    const md = `---\ntitle: 实体A\ntype: entity/person\nslug: brain/entities/person/shiti-a\n---\n\n实体A 简介`;
    await ingest.ingest({ content: md, type: "markdown" });
    await ingest.ingest({ content: md, type: "markdown" }); // mistaken re-ingest

    const records = recordsPages();
    expect(records.some((f) => f.startsWith("untitled-"))).toBe(false);
    expect(records.length).toBe(0); // entity ingest must not drop a records/ file
  });
});
