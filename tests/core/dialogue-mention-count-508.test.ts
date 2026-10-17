/**
 * #508 S1 regression: within one DialogueIngest.ingest call, the same final
 * slug must gain mention_count at most once (per-call local slug set).
 *
 * Behavior under test (anonymous fixtures only: 实体A/实体B/组织C/主题D):
 *  1. Two surface forms of 实体A (title + alias) resolving to one existing
 *     slug in the SAME ingest call count exactly once.
 *  2. Distinct slugs (实体A vs 实体B) still count separately.
 *  3. Two ingest calls on the SAME instance each count once (no cross-call
 *     dedup) — same text, same sessionId, total +2.
 *  4a. Fresh-page creation path still counts +1 (newEntities===1).
 *  4b. Exact-title reuse path (non-entity occupier → duplicate_candidate)
 *      still counts +1 on the occupier slug.
 *  4c. Real cross-branch same-slug case: alias_added branch and
 *      duplicate_candidate reuse branch both land on the same slug within
 *      one call — shared protection must cap at +1.
 *  5. Duplicate surface forms must NOT skip entity processing: relation
 *      extraction still sees both names via entitySlugMap.
 *
 * Real DialogueIngest.ingest, real temp SQLite + vault. Mock LLM/embedding/
 * Lance only; no provider access, no production paths.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { DialogueIngest } from "../../src/core/ingestion/dialogue.js";
import { generateSlug } from "../../src/utils/slug.js";
import { mapEntityType } from "../../src/core/shared.js";
import type { ChatOptions, LLMProvider } from "../../src/llm/provider.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

function createMockLLM(responses: string[]): LLMProvider {
  let callIndex = 0;
  return {
    name: "mock",
    chat: async (_messages: unknown[], _options?: ChatOptions) =>
      responses[callIndex++] ?? '{"entities":[],"relations":[],"events":[],"facts":[]}',
  };
}

function createMockEmbeddingProvider(): EmbeddingProvider {
  return {
    dimensions: 128,
    embed: async (text: string) => {
      const vec = new Array(128).fill(0);
      for (let i = 0; i < text.length; i++) {
        vec[i % 128] += text.charCodeAt(i) / 65536;
      }
      return { embedding: vec, tokenCount: text.length };
    },
    embedBatch: async (texts: string[]) =>
      texts.map((t) => {
        const vec = new Array(128).fill(0);
        for (let i = 0; i < t.length; i++) {
          vec[i % 128] += t.charCodeAt(i) / 65536;
        }
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
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

function extractionJSON(entities: unknown[], relations: unknown[] = []): string {
  return JSON.stringify({ entities, relations, events: [], facts: [] });
}

describe("#508 S1 dialogue mention_count per-call dedup", () => {
  let testDir: string;
  let dbPath: string;
  let vaultPath: string;
  let db: CBrainDB;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cbrain-508-s1-"));
    dbPath = join(testDir, "test.sqlite");
    vaultPath = join(testDir, "vault");
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  function seedPage(slug: string, type: string, title: string): void {
    db.upsertPage({ slug, type, title, filePath: `${slug}.md` });
  }

  function mentionCount(slug: string): number {
    return db.getPageTierAndMentions(slug)?.mention_count ?? 0;
  }

  function buildIngest(llmResponses: string[]): DialogueIngest {
    const llm = createMockLLM(llmResponses);
    return new DialogueIngest(db, createMockEmbeddingProvider(), createMockLanceDB() as never, vaultPath, llm);
  }

  test("1. two surface forms of 实体A in one call resolve to one existing slug → +1 only", async () => {
    seedPage("entities/person/slug-a", "entity/person", "实体A");
    db.addAliasWithSource("entities/person/slug-a", "实体A别称", "test-fixture");

    const dialogue = buildIngest([
      extractionJSON([
        { name: "实体A", type: "person", relevance: "high", context: "实体A到场" },
        { name: "实体A别称", type: "person", relevance: "high", context: "实体A别称发言" },
      ]),
    ]);
    const result = await dialogue.ingest("实体A到场，实体A别称发言。");

    expect(mentionCount("entities/person/slug-a")).toBe(1);
    expect(result.decision).toBe("skipped"); // no new entities/relations/events
  });

  test("2. distinct slugs 实体A and 实体B count separately (+1 each)", async () => {
    seedPage("entities/person/slug-a", "entity/person", "实体A");
    seedPage("entities/person/slug-b", "entity/person", "实体B");

    const dialogue = buildIngest([
      extractionJSON([
        { name: "实体A", type: "person", relevance: "high", context: "实体A到场" },
        { name: "实体B", type: "person", relevance: "high", context: "实体B到场" },
      ]),
    ]);
    await dialogue.ingest("实体A与实体B同场。");

    expect(mentionCount("entities/person/slug-a")).toBe(1);
    expect(mentionCount("entities/person/slug-b")).toBe(1);
  });

  test("3. same instance, two ingest calls, same text/sessionId → +2 total (no cross-call dedup)", async () => {
    seedPage("entities/person/slug-a", "entity/person", "实体A");

    const text = "实体A到场。";
    const dialogue = buildIngest([
      extractionJSON([{ name: "实体A", type: "person", relevance: "high", context: "实体A到场" }]),
      extractionJSON([{ name: "实体A", type: "person", relevance: "high", context: "实体A到场" }]),
    ]);
    await dialogue.ingest(text, "manual", "session/fixed-id");
    expect(mentionCount("entities/person/slug-a")).toBe(1);
    await dialogue.ingest(text, "manual", "session/fixed-id");
    expect(mentionCount("entities/person/slug-a")).toBe(2);
  });

  test("4a. fresh-page creation path still counts +1", async () => {
    const dialogue = buildIngest([
      extractionJSON([
        { name: "主题D", type: "concept", relevance: "high", context: "讨论主题D" },
      ]),
    ]);
    const result = await dialogue.ingest("今天讨论主题D。");

    expect(result.newEntities).toBe(1);
    expect(result.decision).toBe("recorded");
    // R2 (#508 supplement 1): assert on the actually generated page — confirm
    // it exists first, then its mention_count is exactly 1.
    const newSlug = generateSlug("主题D", mapEntityType("concept"));
    expect(db.getPage(newSlug)).not.toBeNull();
    expect(mentionCount(newSlug)).toBe(1);
  });

  test("4b. exact-title occupier (non-entity record page) reuse path counts +1", async () => {
    seedPage("records/record-c", "record", "组织C");

    const dialogue = buildIngest([
      extractionJSON([
        { name: "组织C", type: "person", relevance: "high", context: "组织C被提及" },
      ]),
    ]);
    const result = await dialogue.ingest("会上提到组织C。");

    expect(mentionCount("records/record-c")).toBe(1);
    expect(result.newEntities).toBe(0); // reuse, no page written
  });

  test("4c. real cross-branch same-slug: alias branch + reuse branch share one count cap", async () => {
    // 实体A (entity/person, slug S) has alias 实体A别称.
    // - "实体A别称" (person) → alias_added → slug S
    // - "实体A" (place) → exact-title type gate blocks (person vs place are
    //   non-affine) → duplicate_candidate; getPageByTitle("实体A").slug === S,
    //   so the reuse branch fires on the SAME slug S.
    // Pre-fix this counted +2 on S; post-fix it must count +1.
    seedPage("entities/person/slug-a", "entity/person", "实体A");
    db.addAliasWithSource("entities/person/slug-a", "实体A别称", "test-fixture");

    const dialogue = buildIngest([
      extractionJSON([
        { name: "实体A别称", type: "person", relevance: "high", context: "实体A别称到场" },
        { name: "实体A", type: "place", relevance: "high", context: "实体A作为地点" },
      ]),
    ]);
    const result = await dialogue.ingest("实体A别称到场，实体A作为地点被提及。");

    expect(mentionCount("entities/person/slug-a")).toBe(1);
    expect(result.newEntities).toBe(0);
  });

  test("5. duplicate surface forms do not skip processing: relation still written via entitySlugMap", async () => {
    seedPage("entities/person/slug-a", "entity/person", "实体A");
    db.addAliasWithSource("entities/person/slug-a", "实体A别称", "test-fixture");
    seedPage("entities/company/slug-c", "entity/company", "组织C");

    const dialogue = buildIngest([
      extractionJSON(
        [
          { name: "实体A", type: "person", relevance: "high", context: "实体A任职" },
          { name: "实体A别称", type: "person", relevance: "high", context: "实体A别称任职" },
          { name: "组织C", type: "company", relevance: "high", context: "组织C相关" },
        ],
        [{ from: "实体A别称", to: "组织C", relation: "works_at", context: "实体A别称任职于组织C" }],
      ),
    ]);
    const result = await dialogue.ingest("实体A（即实体A别称）任职于组织C。");

    // Count protection caps 实体A's slug at +1 (two surface forms), 组织C +1.
    expect(mentionCount("entities/person/slug-a")).toBe(1);
    expect(mentionCount("entities/company/slug-c")).toBe(1);
    // Entity processing was NOT skipped: the second surface form 实体A别称
    // still resolved via entitySlugMap and carried the relation to 组织C.
    expect(result.newRelations).toBe(1);
    // "works_at" is an ontology alias; the canonical edge stores the
    // normalized relation name (任职).
    expect(db.linkExists("entities/person/slug-a", "entities/company/slug-c", "任职")).toBe(true);
  });
});
