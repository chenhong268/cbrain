import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";

const testDir = "/tmp/cbrain-test-fts-trigram";
const dbPath = join(testDir, "test.sqlite");

/** Insert a chunk into both `chunks` and `chunks_fts` for testing. */
function seedChunk(
  db: CBrainDB,
  pageSlug: string,
  content: string,
): void {
  const raw = (db as any).rawDb;
  raw.prepare(
    "INSERT OR IGNORE INTO pages (slug, type, title, file_path) VALUES (?, 'note', ?, 'test.md')",
  ).run(pageSlug, pageSlug);
  raw.prepare("INSERT INTO chunks (page_slug, content, chunk_index) VALUES (?, ?, 0)").run(pageSlug, content);
  raw.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)").run(pageSlug, content);
}

describe("FTS5 trigram query safety (#181)", () => {
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  // ─── 1. Core recall parity ──────────────────────────────────

  test("hyphenated query and space-separated query recall the same page", () => {
    seedChunk(db, "test/page-a", "trace failure test searchable content");

    const hyphenated = db.ftsSearch("trace-failure-test", 10);
    const spaced = db.ftsSearch("trace failure test", 10);

    expect(hyphenated.length).toBeGreaterThan(0);
    expect(spaced.length).toBeGreaterThan(0);
    expect(hyphenated.map((r) => r.page_slug)).toContain("test/page-a");
    expect(spaced.map((r) => r.page_slug)).toContain("test/page-a");
  });

  // ─── 2. CJK recall ──────────────────────────────────────────

  test("Chinese trigram query recalls indexed content", () => {
    seedChunk(db, "test/cjk-1", "人物A负责项目管理相关工作");

    const results = db.ftsSearch("人物A负责什么项目", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].page_slug).toBe("test/cjk-1");
  });

  test("mixed Chinese-English query recalls content", () => {
    seedChunk(db, "test/mix-1", "组织A发布了 Framework-X 模型");

    const results = db.ftsSearch("组织A Framework-X", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].page_slug).toBe("test/mix-1");
  });

  // ─── 3. Punctuation & reserved words matrix ─────────────────

  test("query with hyphens does not throw", () => {
    seedChunk(db, "test/punct-1", "self-driving car autonomous vehicle");
    expect(() => db.ftsSearch("self-driving", 10)).not.toThrow();
    expect(db.ftsSearch("self-driving", 10).length).toBeGreaterThan(0);
  });

  test("query with slashes does not throw", () => {
    seedChunk(db, "test/punct-2", "read the docs at api/v2 endpoint");
    expect(() => db.ftsSearch("api/v2", 10)).not.toThrow();
  });

  test("query with parentheses does not throw", () => {
    seedChunk(db, "test/punct-3", "function call with args(param) returns value");
    expect(() => db.ftsSearch("args(param)", 10)).not.toThrow();
  });

  test("query with double quotes does not throw", () => {
    seedChunk(db, "test/punct-4", 'she said "hello world" loudly');
    expect(() => db.ftsSearch('"hello world"', 10)).not.toThrow();
  });

  test("query with AND reserved word does not throw", () => {
    seedChunk(db, "test/punct-5", "cats AND dogs live together");
    expect(() => db.ftsSearch("cats AND dogs", 10)).not.toThrow();
    expect(db.ftsSearch("cats AND dogs", 10).length).toBeGreaterThan(0);
  });

  test("query with OR reserved word does not throw", () => {
    seedChunk(db, "test/punct-6", "true OR false boolean logic");
    expect(() => db.ftsSearch("true OR false", 10)).not.toThrow();
  });

  test("query with NOT reserved word does not throw", () => {
    seedChunk(db, "test/punct-7", "included NOT excluded items");
    expect(() => db.ftsSearch("included NOT excluded", 10)).not.toThrow();
  });

  // ─── 4. Short-query LIKE path ───────────────────────────────

  test("queries < 3 chars use LIKE fallback", () => {
    seedChunk(db, "test/short-1", "AI is the future of technology");

    const results = db.ftsSearch("AI", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].page_slug).toBe("test/short-1");
  });

  test("2-character query uses LIKE path", () => {
    seedChunk(db, "test/short-2", "OK this is fine");

    const results = db.ftsSearch("OK", 10);
    expect(results.length).toBeGreaterThan(0);
  });

  // ─── 5. Fallback + diagnostics ─────────────────────────────

  test("fts_fallback meta is set when MATCH fails", () => {
    seedChunk(db, "test/fallback-1", "some indexed content for fallback test");

    const meta: { fts_fallback?: boolean } = {};

    // Force a MATCH failure by injecting an invalid FTS5 expression.
    // We reach into the private method to construct a deliberately broken query.
    const brokenQuery = ') OR AND NOT ('; // guaranteed syntax error
    const raw = (db as any).rawDb;
    expect(() => {
      raw.prepare(
        "SELECT page_slug FROM chunks_fts WHERE chunks_fts MATCH ?",
      ).get(brokenQuery);
    }).toThrow(); // confirm it actually breaks

    // Now test through the public ftsSearch API with the broken query.
    // Since buildTrigramQuery quotes trigrams, we need to bypass it.
    // Instead, use a very long query that will produce trigrams — these should
    // all be safe now. Test the fallback path by triggering it directly.
    //
    // We'll monkey-patch buildTrigramQuery to return an intentionally broken expression.
    const original = (db as any).buildTrigramQuery.bind(db);
    (db as any).buildTrigramQuery = () => ') OR AND NOT (';

    const results = db.ftsSearch("some indexed content", 10, meta);
    expect(meta.fts_fallback).toBe(true);
    expect(results.length).toBeGreaterThan(0); // fallback returns LIKE results

    // Restore
    (db as any).buildTrigramQuery = original;
  });

  test("normal zero-match does NOT trigger fallback", () => {
    seedChunk(db, "test/nomatch-1", "some content here");

    const meta: { fts_fallback?: boolean } = {};
    // Carefully chosen: no overlapping trigrams with "some content here".
    const results = db.ftsSearch("zyxwvutsrqponmlkjihgfedcba", 10, meta);

    expect(meta.fts_fallback).toBeUndefined();
    expect(results).toEqual([]);
  });

  // ─── 6. Dedup trigrams ──────────────────────────────────────

  test("repeated characters produce deduped trigrams without error", () => {
    seedChunk(db, "test/dedup-1", "aaaaaa repeated chars");
    // "aaaaaa" produces 4 identical trigrams — deduped to 1 quoted trigram.
    // Must not throw, and should match the content containing "aaaaaa".
    expect(() => db.ftsSearch("aaaaaa", 10)).not.toThrow();
    const results = db.ftsSearch("aaaaaa", 10);
    expect(results.length).toBeGreaterThan(0);
  });
});
