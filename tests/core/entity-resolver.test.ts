import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { EntityResolver } from "../../src/core/entity-resolver.js";
import type { EntityCandidate } from "../../src/core/entity-resolver.js";

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
    seedEntity("张三", "entity", "entity/zhangsan");

    const result = resolver.resolveSingle(candidate("张三"));
    expect(result.action).toBe("resolved_to_existing");
    expect(result.score).toBe(1.0);
    expect(result.matchedBy).toBe("exact");
    expect(result.slug).toBe("entity/zhangsan");
  });

  // ─── Layer 1b: Exact alias match ────────────────────────

  test("alias match → alias_added, score=0.95", () => {
    seedEntity("张三", "entity", "entity/zhangsan");
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
    seedEntity("AI Workshop", "entity", "entity/ai-workshop");

    const result = resolver.resolveSingle(candidate("AI workshop"));
    expect(result.action).toBe("alias_added");
    expect(result.score).toBe(0.9);
    expect(result.matchedBy).toBe("normalized");
    expect(result.slug).toBe("entity/ai-workshop");
  });

  // ─── Layer 2b: Parenthetical stripping ──────────────────

  test("parenthetical stripping → alias_added, score=0.8", () => {
    seedEntity("张三", "entity", "entity/zhangsan");

    const result = resolver.resolveSingle(candidate("张三（销售）"));
    expect(result.action).toBe("alias_added");
    expect(result.score).toBe(0.8);
    expect(result.matchedBy).toBe("parenthetical");
    expect(result.slug).toBe("entity/zhangsan");
  });

  // ─── Type gate ──────────────────────────────────────────

  test("type mismatch → duplicate_candidate, score=0.75", () => {
    seedEntity("AI Workshop", "concept", "concept/ai-workshop");

    const result = resolver.resolveSingle(candidate("AI Workshop", "company"));
    expect(result.action).toBe("duplicate_candidate");
    expect(result.score).toBe(0.75);
    expect(result.matchedBy).toBe("type-gate");
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
    seedEntity("AI Workshop", "entity", "entity/ai-workshop");

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
    seedEntity("张三", "entity", "entity/zhangsan");

    const result = resolver.resolveSingle("张三", "person");
    expect(result.action).toBe("resolved_to_existing");
    expect(result.slug).toBe("entity/zhangsan");
  });

  // ─── Concept type gate ──────────────────────────────────

  test("concept entity resolves to concept type", () => {
    seedEntity("区块链", "concept", "concept/blockchain");

    const result = resolver.resolveSingle(candidate("区块链", "concept"));
    expect(result.action).toBe("resolved_to_existing");
    expect(result.slug).toBe("concept/blockchain");
  });

  // ─── Full-width parenthetical ───────────────────────────

  test("full-width parenthetical stripping works", () => {
    seedEntity("李四", "entity", "entity/lisi");

    const result = resolver.resolveSingle(candidate("李四（投资总监）"));
    expect(result.action).toBe("alias_added");
    expect(result.matchedBy).toBe("parenthetical");
    expect(result.slug).toBe("entity/lisi");
  });

  // ─── Normalized stripped + parenthetical ────────────────

  test("normalized stripped match after parenthetical removal", () => {
    seedEntity("Wang Wu", "entity", "entity/wang-wu");

    const result = resolver.resolveSingle(candidate("Wang Wu（CTO）"));
    expect(result.action).toBe("alias_added");
    expect(result.matchedBy).toBe("parenthetical");
  });

  // ─── Alias on alias creates new alias ───────────────────

  test("resolving via alias adds new alias", () => {
    seedEntity("张三", "entity", "entity/zhangsan");
    seedAlias("entity/zhangsan", "老张");

    const result = resolver.resolveSingle(candidate("老张"));
    expect(result.action).toBe("alias_added");

    // Check DB has the new alias
    const slug = db.getSlugByAlias("老张");
    expect(slug).toBe("entity/zhangsan");
  });
});
