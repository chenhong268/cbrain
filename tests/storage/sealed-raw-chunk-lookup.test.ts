import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";

describe("sealed raw-chunk bounded OR-LIKE lookup", () => {
  const testDir = "/tmp/cbrain-test-sealed-lookup";
  const dbPath = join(testDir, "test.sqlite");
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

  function insertPage(slug: string) {
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(slug, "entity/project", slug, `${slug}.md`, `h-${slug}`, 0);
  }

  test("isSealedPage true only when an L1 summary chunk exists", () => {
    insertPage("p/sealed");
    insertPage("p/raw");
    db.insertChunkWithLevel("p/sealed", 0, "raw body with token ALPHA-123", 0, null);
    db.insertChunkWithLevel("p/sealed", -1, "sealed L1 summary", 1, "hash");
    db.insertChunkWithLevel("p/raw", 0, "raw body only", 0, null);

    expect(db.isSealedPage("p/sealed")).toBe(true);
    expect(db.isSealedPage("p/raw")).toBe(false);
    expect(db.isSealedPage("p/missing")).toBe(false);
  });

  test("multi-term OR-LIKE: any term hit returns the raw chunk; summary_level=1 excluded", () => {
    insertPage("p/sealed");
    db.insertChunkWithLevel("p/sealed", 0, "预算审批单编号 ALPHA-123 金额一百万元", 0, null);
    db.insertChunkWithLevel("p/sealed", 1, "另一段原始记录含 BETA-456 编号", 0, null);
    db.insertChunkWithLevel("p/sealed", -1, "L1 摘要提及 GAMMA-789 但应被排除", 1, "hash");

    // 编号 token hit on chunk_index 0.
    const alphaHits = db.getRawChunkHitsForPage("p/sealed", ["ALPHA-123"], 3);
    expect(alphaHits.length).toBe(1);
    expect(alphaHits[0].content).toContain("ALPHA-123");
    expect(alphaHits[0].chunk_index).toBe(0);

    // Multiple terms OR'd — second term hits chunk_index 1.
    const multi = db.getRawChunkHitsForPage("p/sealed", ["ALPHA-123", "BETA-456"], 5);
    const indices = multi.map((h) => h.chunk_index).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1]);

    // Summary-level chunk (level 1) is excluded even if it matched the term.
    expect(db.getRawChunkHitsForPage("p/sealed", ["GAMMA-789"], 3)).toEqual([]);

    // No matching terms → empty.
    expect(db.getRawChunkHitsForPage("p/sealed", ["不存在的词ZZZ"], 3)).toEqual([]);
    // Empty / too-short terms → empty, no scan.
    expect(db.getRawChunkHitsForPage("p/sealed", [], 3)).toEqual([]);
    expect(db.getRawChunkHitsForPage("p/sealed", ["", "x"], 3)).toEqual([]);
  });

  test("bound is respected (LIMIT maxChunks)", () => {
    insertPage("p/sealed");
    db.insertChunkWithLevel("p/sealed", 0, "命中 ALPHA-123 第一段", 0, null);
    db.insertChunkWithLevel("p/sealed", 1, "命中 ALPHA-123 第二段", 0, null);
    db.insertChunkWithLevel("p/sealed", 2, "命中 ALPHA-123 第三段", 0, null);
    db.insertChunkWithLevel("p/sealed", 3, "命中 ALPHA-123 第四段", 0, null);
    expect(db.getRawChunkHitsForPage("p/sealed", ["ALPHA-123"], 2).length).toBe(2);
  });

  test("LIKE wildcards in terms are escaped, not interpreted as wildcards", () => {
    insertPage("p/s");
    db.insertChunkWithLevel("p/s", 0, "费率 50% 折扣 _特殊_", 0, null);
    db.insertChunkWithLevel("p/s", 1, "订单 50X 编号无百分号", 0, null);
    // Escaped literal % matches ONLY the chunk with %, not the 50X chunk.
    // (If % were an unescaped wildcard, "50%" would match both 50% and 50X.)
    const pctHits = db.getRawChunkHitsForPage("p/s", ["50%"], 3);
    expect(pctHits.length).toBe(1);
    expect(pctHits[0].content).toContain("50%");
    // Escaped literal _ in _特殊_ matches the chunk containing it.
    expect(db.getRawChunkHitsForPage("p/s", ["_特殊_"], 3).length).toBe(1);
    // Bare single-char wildcards carry no signal → filtered out, no match.
    expect(db.getRawChunkHitsForPage("p/s", ["%"], 3)).toEqual([]);
    expect(db.getRawChunkHitsForPage("p/s", ["_"], 3)).toEqual([]);
  });
});
