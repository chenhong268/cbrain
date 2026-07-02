import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { EntityResolver } from "../../src/core/ingestion/entity-resolver.js";
import type { EntityCandidate } from "../../src/core/ingestion/entity-resolver.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

describe("EntityResolver embedding shortlist (#168 Phase 1)", () => {
  const testDir = "/tmp/cbrain-test-resolver-embed";
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

  function seedEntity(title: string, type: string, slug?: string): string {
    const s = slug ?? `entity/${title.toLowerCase().replace(/\s+/g, "-")}`;
    db.upsertPage({ slug: s, type, title, filePath: `${s}.md`, contentHash: "abc" });
    return s;
  }
  const candidate = (name: string, type: EntityCandidate["type"] = "company"): EntityCandidate =>
    ({ name, type, relevance: "high" });
  function mockLlm(response: string): LLMProvider {
    return { name: "mock", chat: async () => response };
  }
  // Deterministic mock embedding: explicit name→vec map; unknown names → zero vector.
  function mockEmbedding(map: Record<string, number[]>, dims = 8): EmbeddingProvider {
    const zero = () => new Array(dims).fill(0);
    return {
      dimensions: dims,
      embed: async (text: string) => ({ embedding: map[text] ?? zero(), tokenCount: text.length }),
      embedBatch: async (texts: string[]) => texts.map((t) => ({ embedding: map[t] ?? zero(), tokenCount: t.length })),
    };
  }

  test("default constructor (no options) preserves current behavior — no embedding used", async () => {
    seedEntity("Project Alpha", "entity/company", "entity/project-alpha");
    const resolver = new EntityResolver(db, mockLlm('{"matches":[]}'));
    const results = resolver.resolveAll([candidate("PA")]);
    // PA does not string-match → stub_created (same as today).
    expect(results.get("PA")?.action).toBe("stub_created");
    await resolver.semanticResolve(results, [candidate("PA")]);
    expect(results.get("PA")?.action).toBe("stub_created");
  });

  // NOTE: embedding cosine is a SHORTLIST CUTOFF (≥ EMBED_MIN_COSINE to enter the
  // LLM-focus list), NOT a confidence/merge threshold. It never writes aliases.
  test("shortlist includes semantically similar entity when string match fails", async () => {
    // Seed Unrelated Beta FIRST so that without shortlist reordering, it would
    // precede Project Alpha in the prompt — proving the test fails until the
    // embedding shortlist actually prioritizes Project Alpha.
    seedEntity("Unrelated Beta", "entity/company", "entity/unrelated-beta");
    seedEntity("Project Alpha", "entity/company", "entity/project-alpha");
    // PA and Project Alpha share a vector → high cosine; Unrelated Beta is zero vector.
    const vec = [1, 0, 0, 0, 0, 0, 0, 0];
    let capturedPrompt = "";
    const spyingLlm: LLMProvider = {
      name: "mock",
      chat: async (msgs) => {
        capturedPrompt = msgs.find((m) => m.role === "user")?.content ?? "";
        return '{"matches":[]}';
      },
    };
    const resolver = new EntityResolver(
      db,
      spyingLlm,
      { embedding: mockEmbedding({ "PA": vec, "Project Alpha": vec }), embeddingMode: "shadow" },
    );
    const results = resolver.resolveAll([candidate("PA")]);
    expect(results.get("PA")?.action).toBe("stub_created");
    await resolver.semanticResolve(results, [candidate("PA")]);
    // Project Alpha (shortlisted) must appear before Unrelated Beta in the prompt.
    const idxAlpha = capturedPrompt.indexOf("Project Alpha");
    const idxBeta = capturedPrompt.indexOf("Unrelated Beta");
    expect(idxAlpha).toBeGreaterThan(-1);
    expect(idxBeta).toBeGreaterThan(-1);
    expect(idxAlpha).toBeLessThan(idxBeta);
  });

  test("shortlist excludes type-incompatible candidates (non-affine types)", async () => {
    // Seed a CONCEPT FIRST; without type-aware shortlist it would precede
    // Project Alpha (same cosine) — proving the type gate filters it out.
    // entity/company × concept/concept is non-affine (verified via ontology).
    seedEntity("Concept Thing", "concept/concept", "concept/concept-thing");
    seedEntity("Project Alpha", "entity/company", "entity/project-alpha");
    const vec = [1, 0, 0, 0, 0, 0, 0, 0];
    // Candidate type "company"; concept/concept is not affine to company.
    let capturedPrompt = "";
    const spyingLlm: LLMProvider = {
      name: "mock",
      chat: async (msgs) => {
        capturedPrompt = msgs.find((m) => m.role === "user")?.content ?? "";
        return '{"matches":[]}';
      },
    };
    const resolver = new EntityResolver(
      db,
      spyingLlm,
      { embedding: mockEmbedding({ "PA": vec, "Project Alpha": vec, "Concept Thing": vec }), embeddingMode: "shadow" },
    );
    const results = resolver.resolveAll([candidate("PA", "company")]);
    await resolver.semanticResolve(results, [candidate("PA", "company")]);
    // Project Alpha (same type company) shortlisted → precedes Concept Thing (concept, non-affine).
    expect(capturedPrompt.indexOf("Project Alpha")).toBeLessThan(capturedPrompt.indexOf("Concept Thing"));
  });

  test("embedding fanout is bounded (embeds at most EMBED_MAX_EXISTING_TITLES)", async () => {
    for (let i = 0; i < 50; i++) seedEntity(`Filler ${i}`, "entity/company", `entity/filler-${i}`);
    seedEntity("Project Alpha", "entity/company", "entity/project-alpha");
    let batchCalls = 0;
    let maxBatchSize = 0;
    const countingEmbed: EmbeddingProvider = {
      dimensions: 8,
      embed: async (t) => ({ embedding: [1, 0, 0, 0, 0, 0, 0, 0], tokenCount: t.length }),
      embedBatch: async (texts) => {
        batchCalls++;
        maxBatchSize = Math.max(maxBatchSize, texts.length);
        return texts.map((t) => ({ embedding: [1, 0, 0, 0, 0, 0, 0, 0], tokenCount: t.length }));
      },
    };
    const resolver = new EntityResolver(
      db,
      mockLlm('{"matches":[]}'),
      { embedding: countingEmbed, embeddingMode: "shadow" },
    );
    const results = resolver.resolveAll([candidate("PA")]);
    await resolver.semanticResolve(results, [candidate("PA")]);
    expect(maxBatchSize).toBeLessThanOrEqual(500);
    expect(batchCalls).toBeGreaterThan(0);
  });

  // Cosine ≥ EMBED_MIN_COSINE is a SHORTLIST CUTOFF only. Even perfect similarity
  // (cosine 1.0) must NOT upgrade stub_created → alias_added without LLM match.
  test("embedding high similarity alone does NOT upgrade stub_created → alias_added", async () => {
    seedEntity("Project Alpha", "entity/company", "entity/project-alpha");
    const vec = [1, 0, 0, 0, 0, 0, 0, 0];
    // LLM returns no match → no alias write, despite perfect embedding similarity.
    const resolver = new EntityResolver(
      db,
      mockLlm('{"matches":[]}'),
      { embedding: mockEmbedding({ "PA": vec, "Project Alpha": vec }), embeddingMode: "shadow" },
    );
    const results = resolver.resolveAll([candidate("PA")]);
    await resolver.semanticResolve(results, [candidate("PA")]);
    expect(results.get("PA")?.action).toBe("stub_created");
    // No alias written from embedding alone.
    expect(db.getSlugByAlias("PA")).toBeNull();
  });

  test("with LLM confirmation, shortlisted candidate resolves via Layer 3 and writes llm-semantic alias", async () => {
    seedEntity("Project Alpha", "entity/company", "entity/project-alpha");
    const vec = [1, 0, 0, 0, 0, 0, 0, 0];
    const matchJson = JSON.stringify({
      matches: [{ candidate: "PA", entity: "Project Alpha", confidence: 0.9 }],
    });
    const resolver = new EntityResolver(
      db,
      mockLlm(matchJson),
      { embedding: mockEmbedding({ "PA": vec, "Project Alpha": vec }), embeddingMode: "shadow" },
    );
    const results = resolver.resolveAll([candidate("PA")]);
    await resolver.semanticResolve(results, [candidate("PA")]);
    const resolved = results.get("PA");
    expect(resolved?.action).toBe("alias_added");
    expect(resolved?.matchedBy).toBe("llm_semantic");
    expect(resolved?.slug).toBe("entity/project-alpha");
    // Alias source is llm-semantic (not embedding-only) — verify alias exists.
    expect(db.getSlugByAlias("PA")).toBe("entity/project-alpha");
  });

  test("embedding failure falls back to current full-title semantic resolution", async () => {
    seedEntity("Project Alpha", "entity/company", "entity/project-alpha");
    const failingEmbed: EmbeddingProvider = {
      dimensions: 8,
      embed: async () => { throw new Error("embed unavailable"); },
      embedBatch: async () => { throw new Error("embed unavailable"); },
    };
    const matchJson = JSON.stringify({
      matches: [{ candidate: "PA", entity: "Project Alpha", confidence: 0.9 }],
    });
    const resolver = new EntityResolver(
      db,
      mockLlm(matchJson),
      { embedding: failingEmbed, embeddingMode: "shadow" },
    );
    const results = resolver.resolveAll([candidate("PA")]);
    await resolver.semanticResolve(results, [candidate("PA")]);
    // Fallback: LLM still resolves via full title list → alias added, no error thrown.
    expect(results.get("PA")?.action).toBe("alias_added");
    expect(results.get("PA")?.matchedBy).toBe("llm_semantic");
  });

  test("embedding surfaces an entity beyond the 200-prompt cap (201-500 pool)", async () => {
    // 220 fillers push Project Alpha past MAX_ENTITIES_IN_PROMPT (200) but within
    // the 500 embedding pool. getAllEntityTitles returns insertion order, so
    // Project Alpha lands at index 220. Without pool/cap separation it is never
    // shortlisted and never reaches the prompt — defeating Phase 1's purpose.
    for (let i = 0; i < 220; i++) seedEntity(`Filler ${i}`, "entity/company", `entity/filler-${i}`);
    seedEntity("Project Alpha", "entity/company", "entity/project-alpha");
    const vec = [1, 0, 0, 0, 0, 0, 0, 0];
    let capturedPrompt = "";
    const spyingLlm: LLMProvider = {
      name: "mock",
      chat: async (msgs) => {
        capturedPrompt = msgs.find((m) => m.role === "user")?.content ?? "";
        return '{"matches":[]}';
      },
    };
    const resolver = new EntityResolver(
      db,
      spyingLlm,
      { embedding: mockEmbedding({ "PA": vec, "Project Alpha": vec }), embeddingMode: "shadow" },
    );
    const results = resolver.resolveAll([candidate("PA")]);
    await resolver.semanticResolve(results, [candidate("PA")]);
    // Project Alpha (beyond the 200 cap) must enter the prompt and precede fillers.
    expect(capturedPrompt).toContain("Project Alpha");
    expect(capturedPrompt.indexOf("Project Alpha")).toBeLessThan(capturedPrompt.indexOf("Filler 0"));
  });
});
