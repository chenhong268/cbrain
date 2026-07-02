import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { EntityResolver } from "../../src/core/ingestion/entity-resolver.js";
import type { EntityCandidate } from "../../src/core/ingestion/entity-resolver.js";
import type { LLMProvider } from "../../src/llm/provider.js";

describe("EntityResolver", () => {
  const testDir = "/tmp/cbrain-test-resolver";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let resolver: EntityResolver;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    resolver = new EntityResolver(db);
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

  function seedAlias(pageSlug: string, alias: string): void {
    db.addAliasWithSource(pageSlug, alias, "manual");
  }

  const candidate = (name: string, type: EntityCandidate["type"] = "person"): EntityCandidate =>
    ({ name, type, relevance: "high" });

  // ─── Layer 1a: Exact title match ────────────────────────

  test("exact title match → resolved_to_existing, score=1.0", () => {
    seedEntity("张三", "entity/person", "entity/zhangsan");

    const result = resolver.resolveSingle(candidate("张三"));
    expect(result.action).toBe("resolved_to_existing");
    expect(result.score).toBe(1.0);
    expect(result.matchedBy).toBe("exact");
    expect(result.slug).toBe("entity/zhangsan");
  });

  // ─── Layer 1b: Exact alias match ────────────────────────

  test("alias match → alias_added, score=0.95", () => {
    seedEntity("张三", "entity/person", "entity/zhangsan");
    seedAlias("entity/zhangsan", "老张");

    const result = resolver.resolveSingle(candidate("老张"));
    expect(result.action).toBe("alias_added");
    expect(result.score).toBe(0.95);
    expect(result.matchedBy).toBe("alias");
    expect(result.slug).toBe("entity/zhangsan");
    expect(result.aliasAdded).toBe("老张");
  });

  // ─── Layer 2a: Case-normalized match ────────────────────

  test("case-insensitive match → alias_added, score=0.9", () => {
    seedEntity("AI Workshop", "entity/person", "entity/ai-workshop");

    const result = resolver.resolveSingle(candidate("AI workshop"));
    expect(result.action).toBe("alias_added");
    expect(result.score).toBe(0.9);
    expect(result.matchedBy).toBe("normalized");
    expect(result.slug).toBe("entity/ai-workshop");
  });

  // ─── Layer 2b: Parenthetical stripping ──────────────────

  test("parenthetical stripping → alias_added, score=0.8", () => {
    seedEntity("张三", "entity/person", "entity/zhangsan");

    const result = resolver.resolveSingle(candidate("张三（销售）"));
    expect(result.action).toBe("alias_added");
    expect(result.score).toBe(0.8);
    expect(result.matchedBy).toBe("parenthetical");
    expect(result.slug).toBe("entity/zhangsan");
  });

  // ─── Type gate ──────────────────────────────────────────

  test("type mismatch → duplicate_candidate, score=0.75", () => {
    seedEntity("AI Workshop", "concept/concept", "concept/ai-workshop");

    const result = resolver.resolveSingle(candidate("AI Workshop", "company"));
    expect(result.action).toBe("duplicate_candidate");
    expect(result.score).toBe(0.75);
    expect(result.matchedBy).toBe("type-gate");
  });

  // ─── Type affinity expansion (issue #47) ──────────────────

  test("person ↔ company affinity: NER says person, DB has company → resolved_to_existing", () => {
    seedEntity("南京医药", "entity/company", "entity/nanjing-pharma");

    const result = resolver.resolveSingle(candidate("南京医药", "person"));
    expect(result.action).toBe("resolved_to_existing");
    expect(result.slug).toBe("entity/nanjing-pharma");
  });

  test("person ↔ organization affinity: NER says person, DB has org → resolved_to_existing", () => {
    seedEntity("红会", "entity/organization", "entity/red-cross");

    const result = resolver.resolveSingle(candidate("红会", "person"));
    expect(result.action).toBe("resolved_to_existing");
    expect(result.slug).toBe("entity/red-cross");
  });

  test("organization ↔ concept affinity: NER says organization, DB has concept → resolved_to_existing", () => {
    seedEntity("数字化转型", "concept/concept", "concept/digital-transformation");

    const result = resolver.resolveSingle(candidate("数字化转型", "organization"));
    expect(result.action).toBe("resolved_to_existing");
    expect(result.slug).toBe("concept/digital-transformation");
  });

  test("person ↔ concept affinity: NER says person, DB has concept → resolved_to_existing", () => {
    seedEntity("内观", "concept/concept", "concept/vipassana");

    const result = resolver.resolveSingle(candidate("内观", "person"));
    expect(result.action).toBe("resolved_to_existing");
    expect(result.slug).toBe("concept/vipassana");
  });

  // ─── New entity ─────────────────────────────────────────

  test("no match → stub_created, score=0", () => {
    const result = resolver.resolveSingle(candidate("全新实体"));
    expect(result.action).toBe("stub_created");
    expect(result.score).toBe(0);
    expect(result.matchedBy).toBe("new");
    expect(result.slug).toBe("");
  });

  // ─── Intra-document dedup ───────────────────────────────

  test("resolveAll deduplicates within document", () => {
    const results = resolver.resolveAll([
      candidate("AI Workshop"),
      candidate("AI workshop"),
      candidate("ai workshop"),
    ]);

    // All three should resolve to the same slug (stub_created for the first)
    const slugs = [...results.values()].map(r => r.slug);
    expect(new Set(slugs).size).toBe(1);

    // Members inherit canonical's action but have matchedBy="intra-doc"
    const matchedBy = [...results.values()].map(r => r.matchedBy);
    expect(matchedBy.filter(m => m === "intra-doc").length).toBe(2);
  });

  test("resolveAll with existing entity deduplicates to it", () => {
    seedEntity("AI Workshop", "entity/person", "entity/ai-workshop");

    const results = resolver.resolveAll([
      candidate("AI Workshop"),
      candidate("AI workshop"),
    ]);

    for (const result of results.values()) {
      expect(result.slug).toBe("entity/ai-workshop");
    }
    // First is exact, second is intra-doc
    const matchedBy = [...results.values()].map(r => r.matchedBy);
    expect(matchedBy).toContain("exact");
    expect(matchedBy).toContain("intra-doc");
  });

  // ─── Empty input ────────────────────────────────────────

  test("resolveAll with empty candidates returns empty map", () => {
    const results = resolver.resolveAll([]);
    expect(results.size).toBe(0);
  });

  // ─── resolveSingle string overload ──────────────────────

  test("resolveSingle string overload works", () => {
    seedEntity("张三", "entity/person", "entity/zhangsan");

    const result = resolver.resolveSingle("张三", "person");
    expect(result.action).toBe("resolved_to_existing");
    expect(result.slug).toBe("entity/zhangsan");
  });

  // ─── Concept type gate ──────────────────────────────────

  test("concept entity resolves to concept type", () => {
    seedEntity("区块链", "concept/concept", "concept/blockchain");

    const result = resolver.resolveSingle(candidate("区块链", "concept"));
    expect(result.action).toBe("resolved_to_existing");
    expect(result.slug).toBe("concept/blockchain");
  });

  // ─── Full-width parenthetical ───────────────────────────

  test("full-width parenthetical stripping works", () => {
    seedEntity("李四", "entity/person", "entity/lisi");

    const result = resolver.resolveSingle(candidate("李四（投资总监）"));
    expect(result.action).toBe("alias_added");
    expect(result.matchedBy).toBe("parenthetical");
    expect(result.slug).toBe("entity/lisi");
  });

  // ─── Normalized stripped + parenthetical ────────────────

  test("normalized stripped match after parenthetical removal", () => {
    seedEntity("Wang Wu", "entity/person", "entity/wang-wu");

    const result = resolver.resolveSingle(candidate("Wang Wu（CTO）"));
    expect(result.action).toBe("alias_added");
    expect(result.matchedBy).toBe("parenthetical");
  });

  // ─── Alias on alias creates new alias ───────────────────

  test("resolving via alias adds new alias", () => {
    seedEntity("张三", "entity/person", "entity/zhangsan");
    seedAlias("entity/zhangsan", "老张");

    const result = resolver.resolveSingle(candidate("老张"));
    expect(result.action).toBe("alias_added");

    // Check DB has the new alias
    const slug = db.getSlugByAlias("老张");
    expect(slug).toBe("entity/zhangsan");
  });

  // ─── getAllEntityTitles ────────────────────────────────────

  test("getAllEntityTitles returns entity and concept titles only", () => {
    seedEntity("张三", "entity/person", "entity/zhangsan");
    seedEntity("AI Agents", "concept/concept", "concept/ai-agents");
    db.upsertPage({ slug: "record/note1", type: "record", title: "Some Note", filePath: "record/note1.md", contentHash: "abc" });

    const titles = db.getAllEntityTitles();
    expect(titles).toContain("张三");
    expect(titles).toContain("AI Agents");
    expect(titles).not.toContain("Some Note");
  });

  // ─── Layer 2c: Substring dedup ────────────────────────────

  describe("substring dedup", () => {
    test("new entity is substring of existing → resolved_to_existing", () => {
      seedEntity("AI Agents", "entity/product", "entity/ai-agents");

      const result = resolver.resolveSingle(candidate("AI", "product"));
      expect(result.action).toBe("resolved_to_existing");
      expect(result.matchedBy).toBe("substring_dedup");
      expect(result.slug).toBe("entity/ai-agents");
      expect(result.score).toBe(0.7);
    });

    test("existing entity is substring of new entity → resolved_to_existing", () => {
      seedEntity("Claude", "entity/person", "entity/claude");

      const result = resolver.resolveSingle(candidate("Claude Code"));
      expect(result.action).toBe("resolved_to_existing");
      expect(result.matchedBy).toBe("substring_dedup");
      expect(result.slug).toBe("entity/claude");
    });

    test("length diff < 2 → no substring match", () => {
      seedEntity("市场营销", "entity/person", "entity/marketing");

      const result = resolver.resolveSingle(candidate("市场策略"));
      expect(result.action).toBe("stub_created");
    });

    test("substring length ≤ 1 → no match", () => {
      seedEntity("C++", "entity/person", "entity/cpp");

      const result = resolver.resolveSingle(candidate("C"));
      expect(result.action).toBe("stub_created");
    });

    test("exact substring: 数字化 → 数字化转型", () => {
      seedEntity("数字化转型", "entity/person", "entity/digital-transformation");

      const result = resolver.resolveSingle(candidate("数字化"));
      expect(result.action).toBe("resolved_to_existing");
      expect(result.matchedBy).toBe("substring_dedup");
      expect(result.slug).toBe("entity/digital-transformation");
    });

    test("no match: 京东 → 京东集团 (too short relative to target)", () => {
      seedEntity("京东集团", "entity/company", "entity/jd-group");

      const result = resolver.resolveSingle(candidate("京东", "company"));
      expect(result.action).toBe("stub_created");
    });
  });

  // ─── Mock LLM ──────────────────────────────────────────────

  function createMockLlm(response: string): LLMProvider {
    return {
      name: "mock",
      chat: async () => response,
    };
  }

  // ─── Layer 3: LLM semantic resolution ────────────────────

  describe("semantic resolution", () => {
    test("abbreviation match: 南药 → 南京医药集团股份有限公司", async () => {
      seedEntity("南京医药集团股份有限公司", "entity/company", "entity/nanjing-pharma");

      const mockLlm = createMockLlm(
        JSON.stringify({
          matches: [
            { candidate: "南药", entity: "南京医药集团股份有限公司", confidence: 0.9 },
          ],
        })
      );

      const resolver = new EntityResolver(db, mockLlm);
      const results = resolver.resolveAll([candidate("南药", "company")]);
      expect(results.get("南药")?.action).toBe("stub_created");

      await resolver.semanticResolve(results, [candidate("南药", "company")]);

      const resolved = results.get("南药")!;
      expect(resolved.action).toBe("alias_added");
      expect(resolved.slug).toBe("entity/nanjing-pharma");
      expect(resolved.matchedBy).toBe("llm_semantic");
      expect(resolved.aliasAdded).toBe("南药");

      // Verify alias persisted in DB
      expect(db.getSlugByAlias("南药")).toBe("entity/nanjing-pharma");
    });

    test("no match → stays stub_created", async () => {
      seedEntity("南京医药集团股份有限公司", "entity/person", "entity/nanjing-pharma");

      const mockLlm = createMockLlm(JSON.stringify({ matches: [] }));

      const resolver = new EntityResolver(db, mockLlm);
      const results = resolver.resolveAll([candidate("全新公司", "company")]);

      await resolver.semanticResolve(results, [candidate("全新公司", "company")]);

      expect(results.get("全新公司")?.action).toBe("stub_created");
    });

    test("no LLM → semantic resolve is no-op", async () => {
      const resolver = new EntityResolver(db);
      const results = resolver.resolveAll([candidate("南药", "company")]);

      await resolver.semanticResolve(results, [candidate("南药", "company")]);

      expect(results.get("南药")?.action).toBe("stub_created");
    });

    test("already resolved entities are not sent to LLM", async () => {
      seedEntity("张三", "entity/person", "entity/zhangsan");

      let capturedPrompt = "";
      const mockLlm: LLMProvider = {
        name: "mock",
        chat: async (msgs) => {
          capturedPrompt = msgs[1].content;
          return JSON.stringify({ matches: [] });
        },
      };

      const resolver = new EntityResolver(db, mockLlm);
      const results = resolver.resolveAll([
        candidate("张三"),     // exact match, should NOT go to LLM
        candidate("南药", "company"),  // stub, should go to LLM
      ]);

      await resolver.semanticResolve(results, [
        candidate("张三"),
        candidate("南药", "company"),
      ]);

      // Only 南药 should appear in the prompt, not 张三
      expect(capturedPrompt).toContain("南药");
      expect(capturedPrompt).not.toContain("张三");
    });

    test("LLM returns invalid JSON → graceful fallback to stub_created", async () => {
      seedEntity("南京医药集团股份有限公司", "entity/person", "entity/nanjing-pharma");

      const mockLlm = createMockLlm("not valid json {{{");

      const resolver = new EntityResolver(db, mockLlm);
      const results = resolver.resolveAll([candidate("南药", "company")]);

      await resolver.semanticResolve(results, [candidate("南药", "company")]);

      expect(results.get("南药")?.action).toBe("stub_created");
    });
  });

  // ─── Layer 0b: prefix-based intra-document dedup (#116) ────
  describe("Layer 0b: prefix-based dedup", () => {
    test("full name vs abbreviation (Chinese) merges into one group", () => {
      const results = resolver.resolveAll([
        candidate("人物A全名", "person"),
        candidate("人物A全", "person"),
      ]);

      const r1 = results.get("人物A全名")!;
      const r2 = results.get("人物A全")!;

      // One is the canonical (matchedBy "new"), the other is intra-doc
      const intraDocs = [r1, r2].filter(r => r.matchedBy === "intra-doc");
      expect(intraDocs.length).toBe(1);

      // Both point to the same slug (empty for new stubs, but identical)
      expect(r1.slug).toBe(r2.slug);
    });

    test("full name vs abbreviation (English) merges into one group", () => {
      const results = resolver.resolveAll([
        candidate("FirstName Fullname", "person"),
        candidate("FirstName F", "person"),
      ]);

      const r1 = results.get("FirstName Fullname")!;
      const r2 = results.get("FirstName F")!;

      const intraDocs = [r1, r2].filter(r => r.matchedBy === "intra-doc");
      expect(intraDocs.length).toBe(1);

      expect(r1.slug).toBe(r2.slug);
    });

    test("no prefix relationship → separate groups", () => {
      const results = resolver.resolveAll([
        candidate("人物A", "person"),
        candidate("人物B", "person"),
      ]);

      // No intra-doc — both are independent
      expect(results.get("人物A")!.matchedBy).toBe("new");
      expect(results.get("人物B")!.matchedBy).toBe("new");
    });

    test("type affinity mismatch → no merge", () => {
      // person (entity/person) and technology (concept/technology) are NOT affine
      const results = resolver.resolveAll([
        candidate("张三丰", "person"),
        candidate("张三", "technology"),
      ]);

      // Both independent — no intra-doc
      expect(results.get("张三丰")!.matchedBy).toBe("new");
      expect(results.get("张三")!.matchedBy).toBe("new");
    });

    test("single char too short → no merge", () => {
      const results = resolver.resolveAll([
        candidate("A", "person"),
        candidate("AB Corp", "company"),
      ]);

      // Both independent — "a" is too short for prefix merge
      expect(results.get("A")!.matchedBy).toBe("new");
      expect(results.get("AB Corp")!.matchedBy).toBe("new");
    });

    test("3-level prefix chain merges all into one group", () => {
      const results = resolver.resolveAll([
        candidate("人物A全名长", "person"),
        candidate("人物A全名", "person"),
        candidate("人物A全", "person"),
      ]);

      // All three should share the same slug
      const slug1 = results.get("人物A全名长")!.slug;
      const slug2 = results.get("人物A全名")!.slug;
      const slug3 = results.get("人物A全")!.slug;
      expect(slug1).toBe(slug2);
      expect(slug2).toBe(slug3);

      // Two should be intra-doc, one is the canonical
      const intraDocs = [results.get("人物A全名长")!, results.get("人物A全名")!, results.get("人物A全")!]
        .filter(r => r.matchedBy === "intra-doc");
      expect(intraDocs.length).toBe(2);
    });

    test("length ratio < 50% → no merge (false positive guard)", () => {
      // "CityA" (5) vs "CityADistrict" (13) → 5/13 ≈ 38% < 50%
      const results = resolver.resolveAll([
        candidate("CityA", "person"),
        candidate("CityADistrict", "person"),
      ]);

      // Should NOT merge — too different in length
      expect(results.get("CityA")!.matchedBy).toBe("new");
      expect(results.get("CityADistrict")!.matchedBy).toBe("new");
    });

    test("prefix merge resolves to existing entity when one matches DB", () => {
      seedEntity("人物A全名", "entity/person", "entity/renwu-a");

      const results = resolver.resolveAll([
        candidate("人物A全名", "person"),
        candidate("人物A全", "person"),
      ]);

      // Both should resolve to the existing entity
      expect(results.get("人物A全名")!.action).toBe("resolved_to_existing");
      expect(results.get("人物A全名")!.slug).toBe("entity/renwu-a");
      expect(results.get("人物A全")!.slug).toBe("entity/renwu-a");
    });
  });
});
