import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import {
  HybridSearch,
  rrfScore,
  mergeRankedResults,
  type SearchResult,
} from "../../src/core/retrieval/search.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

function createMockEmbeddingProvider(): EmbeddingProvider {
  const fakeVec = (text: string) => {
    const vec = new Array(128).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % 128] += text.charCodeAt(i) / 65536;
    }
    return vec;
  };

  return {
    dimensions: 128,
    embed: async (text: string) => ({
      embedding: fakeVec(text),
      tokenCount: text.length,
    }),
    embedBatch: async (texts: string[]) =>
      texts.map((t) => ({ embedding: fakeVec(t), tokenCount: t.length })),
  };
}

interface LanceChunk {
  pageSlug: string;
  chunkIndex: number;
  content: string;
  vector: number[];
}

function createMockLanceDB() {
  let stored: LanceChunk[] = [];

  return {
    connect: async () => {},
    addChunks: async (chunks: LanceChunk[]) => {
      stored.push(...chunks);
    },
    search: async (queryVector: number[] | Float32Array, limit: number) => {
      const qArr = Array.from(queryVector);
      const scored = stored.map((chunk) => {
        let dot = 0;
        for (let i = 0; i < qArr.length; i++) {
          dot += qArr[i] * (chunk.vector[i] || 0);
        }
        return { pageSlug: chunk.pageSlug, chunkIndex: chunk.chunkIndex, content: chunk.content, _distance: 1 - dot };
      });
      scored.sort((a, b) => (a._distance ?? 0) - (b._distance ?? 0));
      return scored.slice(0, limit);
    },
    fullTextSearch: async (query: string, limit: number) => {
      const results: LanceChunk[] = [];
      for (const chunk of stored) {
        if (chunk.content.toLowerCase().includes(query.toLowerCase())) {
          results.push(chunk);
          if (results.length >= limit) break;
        }
      }
      return results.map((r) => ({ pageSlug: r.pageSlug, chunkIndex: r.chunkIndex, content: r.content, _distance: undefined as number | undefined }));
    },
    deleteByPageSlug: async (pageSlug: string) => {
      stored = stored.filter((c) => c.pageSlug !== pageSlug);
    },
    deleteRawChunksByPageSlug: async () => {},
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

describe("HybridSearch", () => {
  const testDir = "/tmp/cbrain-test-search";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let search: HybridSearch;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    const embedding = createMockEmbeddingProvider();
    const lance = createMockLanceDB();
    search = new HybridSearch(db, embedding, lance as any, { rrf_k: 60 });
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  describe("rrfScore", () => {
    test("single list: score = 1/(k + rank)", () => {
      const score = rrfScore([1], 60);
      expect(score).toBeCloseTo(1 / 61);
    });

    test("multiple lists: score is sum across lists", () => {
      const score = rrfScore([1, 3], 60);
      expect(score).toBeCloseTo(1 / 61 + 1 / 63);
    });

    test("empty ranks array returns 0", () => {
      expect(rrfScore([], 60)).toBe(0);
    });

    test("custom k value", () => {
      const score = rrfScore([1], 10);
      expect(score).toBeCloseTo(1 / 11);
    });
  });

  describe("mergeRankedResults", () => {
    test("merges two ranked lists with RRF", () => {
      const listA: SearchResult[] = [
        { slug: "a", score: 0.9, snippet: "", source: "vector" },
        { slug: "b", score: 0.7, snippet: "", source: "vector" },
        { slug: "c", score: 0.5, snippet: "", source: "vector" },
      ];
      const listB: SearchResult[] = [
        { slug: "b", score: 0.95, snippet: "", source: "fts" },
        { slug: "a", score: 0.8, snippet: "", source: "fts" },
        { slug: "d", score: 0.3, snippet: "", source: "fts" },
      ];

      const merged = mergeRankedResults([listA, listB], 60, 10);

      const aResult = merged.find((r) => r.slug === "a")!;
      const bResult = merged.find((r) => r.slug === "b")!;
      expect(aResult.score).toBeCloseTo(bResult.score);

      const cResult = merged.find((r) => r.slug === "c")!;
      const dResult = merged.find((r) => r.slug === "d")!;
      expect(cResult.score).toBeCloseTo(dResult.score);

      expect(merged.length).toBe(4);
      expect(aResult.source).toBe("hybrid");
      expect(bResult.source).toBe("hybrid");
    });

    test("respects limit parameter", () => {
      const list: SearchResult[] = Array.from({ length: 20 }, (_, i) => ({
        slug: `item-${i}`,
        score: 1 - i * 0.05,
        snippet: "",
        source: "vector" as const,
      }));

      const merged = mergeRankedResults([list], 60, 5);
      expect(merged.length).toBe(5);
    });

    test("empty input lists returns empty", () => {
      const merged = mergeRankedResults([], 60, 10);
      expect(merged).toEqual([]);
    });

    test("deduplicates across lists", () => {
      const listA: SearchResult[] = [
        { slug: "x", score: 0.9, snippet: "s1", source: "vector" },
      ];
      const listB: SearchResult[] = [
        { slug: "x", score: 0.8, snippet: "s2", source: "fts" },
      ];

      const merged = mergeRankedResults([listA, listB], 60, 10);
      expect(merged.length).toBe(1);
      expect(merged[0].snippet).toBe("s1");
    });
  });

  describe("graph search (BFS link traversal)", () => {
    test("finds linked pages via BFS depth 2", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/a", "entity", "A", "a.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/b", "entity", "B", "b.md", "h2");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/c", "entity", "C", "c.md", "h3");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/d", "entity", "D", "d.md", "h4");

      db.rawDb.prepare(
        `INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)`
      ).run("entities/a", "entities/b", "mentions");
      db.rawDb.prepare(
        `INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)`
      ).run("entities/a", "entities/c", "mentions");
      db.rawDb.prepare(
        `INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)`
      ).run("entities/b", "entities/d", "mentions");

      const results = await search.graphSearch("entities/a", 10);

      const slugs = results.map((r) => r.slug);
      expect(slugs).toContain("entities/b");
      expect(slugs).toContain("entities/c");
      expect(slugs).toContain("entities/d");
      expect(results.every((r) => r.source === "graph")).toBe(true);
    });

    test("excludes seed slug from results", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/a", "entity", "A", "a.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/b", "entity", "B", "b.md", "h2");

      db.rawDb.prepare(
        `INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)`
      ).run("entities/a", "entities/b", "mentions");
      db.rawDb.prepare(
        `INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)`
      ).run("entities/b", "entities/a", "mentions");

      const results = await search.graphSearch("entities/a", 10);
      const slugs = results.map((r) => r.slug);
      expect(slugs).not.toContain("entities/a");
      expect(slugs).toContain("entities/b");
    });

    test("returns empty for isolated page", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/solo", "entity", "Solo", "solo.md", "h1");

      const results = await search.graphSearch("entities/solo", 10);
      expect(results).toEqual([]);
    });

    test("respects limit", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/seed", "entity", "Seed", "seed.md", "hs");

      for (let i = 0; i < 5; i++) {
        db.rawDb.prepare(
          `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
        ).run(`entities/n${i}`, "entity", `N${i}`, `n${i}.md`, `h${i}`);
        db.rawDb.prepare(
          `INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)`
        ).run("entities/seed", `entities/n${i}`, "mentions");
      }

      const results = await search.graphSearch("entities/seed", 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });
  });

  // ─── #248: graphSearch delegates to batched GraphManager.traverse ───
  // Decision A: dangling neighbors (link target with no page row) are excluded
  // from recall candidates — they are data-debt handled by health/repair, not
  // surfaced as search hits. Existing behavior coverage (depth 2, seed-excluded,
  // isolated, limit, smart/all fusion) lives in the "graph search" describe above
  // and the "full hybrid search" describe below; all those fixtures insert page
  // rows for every link endpoint, so decision A does not perturb them.
  describe("#248 graphSearch batched traversal", () => {
    function seedPage(slug: string, title: string): void {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run(slug, "entity", title, `${slug}.md`, `h-${slug}`);
    }
    function seedLink(from: string, to: string): void {
      db.rawDb.prepare(
        `INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)`
      ).run(from, to, "mentions");
    }

    test("golden: exact ordered projection (slug/score/snippet/source) is stable", async () => {
      // Covers outgoing + incoming edges, depth 1/2 nodes, a cycle (B->seed),
      // and dual-reachability (seed->B direct AND A->B) so the direct path wins.
      // Ordering contract: BFS frontier order, per slug out-then-in, in link
      // rowid-insertion order (getOutgoingSlugs and getLinksForSlugs share the
      // same query shape with no ORDER BY, so both return rowid order). If a
      // future query adds an ORDER BY, this golden breaks on purpose — that is
      // the signal to re-baseline.
      seedPage("entities/seed", "Seed");
      seedPage("entities/a", "A");
      seedPage("entities/b", "B");
      seedPage("entities/c", "C");
      seedPage("entities/d", "D");
      seedLink("entities/seed", "entities/a"); // depth 1, outgoing
      seedLink("entities/seed", "entities/b"); // depth 1, outgoing (also reachable via A)
      seedLink("entities/a", "entities/b");    // B already visited at depth 1
      seedLink("entities/a", "entities/c");    // depth 2
      seedLink("entities/b", "entities/seed"); // cycle back to seed
      seedLink("entities/d", "entities/seed"); // depth 1, incoming to seed

      const results = await search.graphSearch("entities/seed", 10);

      // Direct path wins for dual-reach: B keeps depth 1 / score 1.0. Both the
      // old graphSearch and the batched traverse use visited-on-first-encounter
      // BFS, so this baseline must hold before AND after the refactor.
      expect(results.map((r) => ({ slug: r.slug, score: r.score, snippet: r.snippet, source: r.source }))).toEqual([
        { slug: "entities/a", score: 1.0, snippet: "A", source: "graph" },
        { slug: "entities/b", score: 1.0, snippet: "B", source: "graph" },
        { slug: "entities/d", score: 1.0, snippet: "D", source: "graph" },
        { slug: "entities/c", score: 0.5, snippet: "C", source: "graph" },
      ]);
    });

    test("dangling graph neighbors are excluded from recall candidates", async () => {
      seedPage("entities/seed", "Seed");
      // The links FK (to_slug -> pages.slug, ON DELETE CASCADE) makes a true
      // dangling link schema-impossible under PRAGMA foreign_keys = ON, so this
      // is a defensive contract: construct the impossible state deliberately
      // (FK off) and assert graphSearch never surfaces a link target that lacks
      // a page row as a recall candidate.
      db.rawDb.exec("PRAGMA foreign_keys = OFF");
      seedLink("entities/seed", "entities/ghost"); // ghost has no page row
      db.rawDb.exec("PRAGMA foreign_keys = ON");
      const results = await search.graphSearch("entities/seed", 10);
      expect(results.map((r) => r.slug)).not.toContain("entities/ghost");
      expect(results).toEqual([]);
    });

    test("N+1 regression: uses batched traversal, not per-node lookups (fallback GraphManager)", async () => {
      seedPage("entities/seed", "Seed");
      seedPage("entities/a", "A");
      seedLink("entities/seed", "entities/a");

      const outSpy = spyOn(db, "getOutgoingSlugs");
      const inSpy = spyOn(db, "getIncomingSlugs");
      const titleSpy = spyOn(db, "getPageTitle");
      const batchLinksSpy = spyOn(db, "batchGetLinksForSlugs");
      const batchTitlesSpy = spyOn(db, "getPageTitlesAndTypes");

      // No config.graph -> fallback `new GraphManager(this.db)` must wrap THIS
      // spied db instance, so traverse's batch calls are observable.
      const hs = new HybridSearch(db, createMockEmbeddingProvider(), createMockLanceDB() as never);
      await hs.graphSearch("entities/seed", 10);

      expect(outSpy).not.toHaveBeenCalled();
      expect(inSpy).not.toHaveBeenCalled();
      expect(titleSpy).not.toHaveBeenCalled();
      expect(batchLinksSpy).toHaveBeenCalled();
      expect(batchTitlesSpy).toHaveBeenCalled();
    });
  });

  describe("full hybrid search", () => {
    test("combines vector + fts + graph results", async () => {
      const provider = createMockEmbeddingProvider();
      const lance = createMockLanceDB();

      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/alpha", "entity", "Alpha", "alpha.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/beta", "entity", "Beta", "beta.md", "h2");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/gamma", "entity", "Gamma", "gamma.md", "h3");

      db.rawDb.prepare(
        `INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)`
      ).run("entities/alpha", "entities/beta", "mentions");

      const embedResults = await provider.embedBatch([
        "Alpha is a machine learning model",
        "Beta is related to deep learning",
      ]);
      await lance.addChunks([
        { pageSlug: "entities/alpha", chunkIndex: 0, content: "Alpha is a machine learning model", vector: embedResults[0].embedding },
        { pageSlug: "entities/beta", chunkIndex: 0, content: "Beta is related to deep learning", vector: embedResults[1].embedding },
      ]);

      const hs = new HybridSearch(db, provider, lance as any, { rrf_k: 60 });
      const results = await hs.search("machine learning", { limit: 10 });
      expect(results.length).toBeGreaterThan(0);

      const slugs = results.map((r) => r.slug);
      expect(slugs).toContain("entities/alpha");
    });

    test("strategy=vector returns only vector results", async () => {
      const provider = createMockEmbeddingProvider();
      const lance = createMockLanceDB();

      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/v1", "entity", "V1", "v1.md", "h1");

      const { embedding } = await provider.embed("vector content here");
      await lance.addChunks([
        { pageSlug: "entities/v1", chunkIndex: 0, content: "vector content here", vector: embedding },
      ]);

      const hs = new HybridSearch(db, provider, lance as any, { rrf_k: 60 });
      const results = await hs.search("vector content", { strategy: "vector", limit: 10 });

      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.source === "vector")).toBe(true);
    });

    test("strategy=fts returns only fts results", async () => {
      const provider = createMockEmbeddingProvider();
      const lance = createMockLanceDB();

      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/f1", "entity", "F1", "f1.md", "h1");

      // Insert into SQLite FTS table (trigram tokenizer requires 3+ char queries)
      db.ftsInsert("entities/f1", "full text search example document");

      const hs = new HybridSearch(db, provider, lance as any, { rrf_k: 60 });
      const results = await hs.search("full text search", { strategy: "fts", limit: 10 });

      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.source === "fts")).toBe(true);
    });

    test("strategy=graph returns only graph results", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/g1", "entity", "G1", "g1.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/g2", "entity", "G2", "g2.md", "h2");
      db.rawDb.prepare(
        `INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)`
      ).run("entities/g1", "entities/g2", "mentions");

      const hs = new HybridSearch(db, createMockEmbeddingProvider(), createMockLanceDB() as any, { rrf_k: 60 });
      const results = await hs.search("entities/g1", { strategy: "graph", limit: 10 });

      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.source === "graph")).toBe(true);
    });

    test("empty query returns empty results", async () => {
      const hs = new HybridSearch(db, createMockEmbeddingProvider(), createMockLanceDB() as any, { rrf_k: 60 });
      const results = await hs.search("");
      expect(results).toEqual([]);
    });

    test("no results for query with no data", async () => {
      const hs = new HybridSearch(db, createMockEmbeddingProvider(), createMockLanceDB() as any, { rrf_k: 60 });
      const results = await hs.search("nonexistent stuff");
      expect(results).toEqual([]);
    });
  });

  describe("short query fast path", () => {
    function setupSearch(): HybridSearch {
      return new HybridSearch(db, createMockEmbeddingProvider(), createMockLanceDB() as any, { rrf_k: 60 });
    }

    test("exact title match returns immediately with source=exact", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/luodan", "entity", "罗丹", "luodan.md", "h1");

      const hs = setupSearch();
      const results = await hs.search("罗丹");
      expect(results.length).toBe(1);
      expect(results[0].slug).toBe("entities/luodan");
      expect(results[0].source).toBe("exact");
      expect(results[0].score).toBe(1.0);
    });

    test("no exact match falls back to FTS", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/luodan", "entity", "罗丹", "luodan.md", "h1");
      db.ftsInsert("entities/luodan", "罗丹是法国著名雕塑家，创作了思想者等作品");

      const hs = setupSearch();
      const results = await hs.search("思想者");
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.source === "fts" || r.source === "hybrid")).toBe(true);
    });

    test("3-char query still uses short path", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/xukai", "entity", "徐凯文", "xukai.md", "h1");

      const hs = setupSearch();
      const results = await hs.search("徐凯文");
      expect(results.length).toBe(1);
      expect(results[0].slug).toBe("entities/xukai");
      expect(results[0].source).toBe("exact");
    });

    test("4+ char query with exact title match returns exact", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/p1", "entity", "机器学习入门", "p1.md", "h1");

      const hs = setupSearch();
      const results = await hs.search("机器学习入门");
      // Exact title match is now a fast path for all queries regardless of length
      expect(results.length).toBe(1);
      expect(results[0].slug).toBe("entities/p1");
      expect(results[0].source).toBe("exact");
    });

    test("short query with no results returns empty", async () => {
      const hs = setupSearch();
      const results = await hs.search("无名");
      expect(results).toEqual([]);
    });
  });
});
