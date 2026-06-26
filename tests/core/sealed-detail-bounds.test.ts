import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HybridSearch } from "../../src/core/search.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

function embProvider(): EmbeddingProvider {
  const fakeVec = (text: string) => {
    const vec = new Array(128).fill(0);
    for (let i = 0; i < text.length; i++) vec[i % 128] += text.charCodeAt(i) / 65536;
    return vec;
  };
  return {
    dimensions: 128,
    embed: async (text: string) => ({ embedding: fakeVec(text), tokenCount: text.length }),
    embedBatch: async (texts: string[]) =>
      texts.map((t) => ({ embedding: fakeVec(t), tokenCount: t.length })),
  };
}

// Vector path recalls ALL provided sealed pages at high score.
function mockLanceAll(sealedSlugs: string[], summary: string) {
  return {
    connect: async () => {},
    addChunks: async () => {},
    search: async () =>
      sealedSlugs.map((slug) => ({
        pageSlug: slug,
        chunkIndex: -1,
        content: summary,
        _distance: 0.05,
      })),
    fullTextSearch: async () => [],
    deleteByPageSlug: async () => {},
    deleteRawChunksByPageSlug: async () => {},
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

function insertPage(db: CBrainDB, slug: string) {
  db.rawDb.prepare(
    "INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(slug, "entity/project", slug, `${slug}.md`, `h-${slug}`, 0);
}

function seedSealed(db: CBrainDB, slug: string, raw: string, summary: string) {
  insertPage(db, slug);
  db.insertChunkWithLevel(slug, 0, raw, 0, null);
  db.ftsInsert(slug, raw);
  db.insertChunkWithLevel(slug, -1, summary, 1, `h-${slug}`);
  db.ftsInsert(slug, summary);
}

/** Spy harness: records how many times each slug is probed via getRawChunkHitsForPage. */
function spyProbes(db: CBrainDB): Map<string, number> {
  const counts = new Map<string, number>();
  const real = db.getRawChunkHitsForPage.bind(db);
  (db as unknown as { getRawChunkHitsForPage: unknown }).getRawChunkHitsForPage = (
    slug: string,
    ...rest: unknown[]
  ) => {
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
    return real(slug, ...(rest as [string[], number]));
  };
  return counts;
}

describe("sealed detail enrichment bounds (#169)", () => {
  const testDir = "/tmp/cbrain-test-sealed-bounds";
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

  test("does NOT scan all recalled sealed pages (probe count < sealed page count)", async () => {
    // More sealed pages than any reasonable cap.
    const DETAIL = "ALPHA-123";
    const slugs: string[] = [];
    for (let i = 0; i < 8; i++) {
      const slug = `p/sealed-${i}`;
      slugs.push(slug);
      seedSealed(db, slug, `第${i}段含编号 ${DETAIL}`, `概要${i}`);
    }
    const counts = spyProbes(db);

    const search = new HybridSearch(
      db,
      embProvider(),
      mockLanceAll(slugs, "概要统一召回") as any,
      { rrf_k: 60 }
    );
    await search.search(DETAIL, { limit: 10 });

    const probedSlugs = [...counts.keys()].filter((s) => (counts.get(s) ?? 0) > 0);
    // Behavioral: fewer pages probed than were recalled — not a full scan.
    expect(probedSlugs.length).toBeGreaterThan(0);
    expect(probedSlugs.length).toBeLessThan(slugs.length);
  });

  test("multiStep: each sealed slug is probed exactly once (recursive probes skipped)", async () => {
    const DETAIL = "DELTA-000";
    seedSealed(db, "p/sealed-ms", `multiStep 细节编号 ${DETAIL}。`, "multiStep 概要用于召回。");
    const counts = spyProbes(db);

    // Force ResearchManager to issue a follow-up query (round 1 insufficient),
    // then settle (round 2 sufficient). This makes research call search() twice
    // internally — so probe==1 is only possible if _skipDetailEnrich is threaded
    // into those recursive calls (otherwise initial + follow-up each enrich).
    const responses = [
      JSON.stringify({ sufficient: false, follow_up_queries: [{ query: "细节编号", intent: "retry" }] }),
      JSON.stringify({ sufficient: true, reasoning: "ok" }),
    ];
    let callIdx = 0;
    const llm = {
      name: "mock",
      chat: async () => responses[callIdx++] ?? responses[responses.length - 1],
    };
    const search = new HybridSearch(
      db,
      embProvider(),
      mockLanceAll(["p/sealed-ms"], "multiStep 概要用于召回。") as any,
      { rrf_k: 60, llm, multiQuery: false }
    );

    const results = await search.search(DETAIL, { limit: 5, multiStep: true });
    expect(results.find((r) => r.slug === "p/sealed-ms")?.detail?.snippet).toContain(DETAIL);
    // Strict: probed exactly once (outer exit only). Without _skipDetailEnrich
    // in research.ts, the initial + follow-up search() calls each enrich → ≥2.
    expect(counts.get("p/sealed-ms") ?? 0).toBe(1);
  });
});
