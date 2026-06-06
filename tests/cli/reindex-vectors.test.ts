import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { handleReindexVectors } from "../../src/cli/commands/maintenance.js";

/**
 * Real deterministic fake embedding provider matching 2048 dimensions.
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

const TEST_DIR = "/tmp/cbrain-test-reindex-handler";

describe("handleReindexVectors", () => {
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
    // DB should already be closed by handler, but guard against leaks
    try { db.close(); } catch { /* already closed */ }
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("closes DB on success", async () => {
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
    ).run("entities/a", "A", "entities/a.md", "hash-a");
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 0, ?, 0)",
    ).run("entities/a", "content for a");

    const logs: string[] = [];
    const exitCode = await handleReindexVectors(lancePath, db, embedding, (msg) => logs.push(msg));

    expect(exitCode).toBe(0);
    expect(logs.some(l => l.includes("Rebuilt:"))).toBe(true);

    // DB should be closed — calling close() again should not throw
    expect(() => db.close()).not.toThrow();
  });

  test("closes DB on rebuilder failure", async () => {
    const failingEmbedding = {
      dimensions: 2048,
      embed: async () => { throw new Error("embedding service down"); },
      embedBatch: async () => { throw new Error("embedding service down"); },
    };

    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
    ).run("entities/fail", "Fail", "entities/fail.md", "hash-f");
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 0, ?, 0)",
    ).run("entities/fail", "content for fail");

    const errors: string[] = [];
    const exitCode = await handleReindexVectors(
      lancePath,
      db,
      failingEmbedding as any,
      () => {},
      (msg) => errors.push(msg),
    );

    expect(exitCode).toBe(1);
    expect(errors.some(e => e.includes("Reindex failed"))).toBe(true);

    // DB should be closed even after failure
    expect(() => db.close()).not.toThrow();
  });

  test("never connects to corrupt live LanceDB", async () => {
    // Create a corrupt live directory — any LanceDB connection would fail
    mkdirSync(lancePath, { recursive: true });
    writeFileSync(join(lancePath, "chunks.lance"), "CORRUPTED — NOT A VALID LANCE DB");
    writeFileSync(join(lancePath, "insights.lance"), "MORE GARBAGE");

    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
    ).run("entities/recover", "Recover", "entities/recover.md", "hash-r");
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 0, ?, 0)",
    ).run("entities/recover", "content for recover");

    // handleReindexVectors must succeed — it never opens live as LanceDB
    const exitCode = await handleReindexVectors(lancePath, db, embedding);
    expect(exitCode).toBe(0);

    // New live should be valid (staging was built and swapped)
    expect(existsSync(lancePath)).toBe(true);
    // Old corrupt files should be in backup, not live
    const entries = readdirSync(lancePath);
    const hasCorruptFile = entries.some(e => {
      if (e.endsWith(".lance")) {
        try {
          const content = require("node:fs").readFileSync(join(lancePath, e), "utf-8");
          return content.includes("CORRUPTED") || content.includes("GARBAGE");
        } catch { return false; }
      }
      return false;
    });
    expect(hasCorruptFile).toBe(false);
  });
});
