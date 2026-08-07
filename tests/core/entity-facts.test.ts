import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EntityFactsTimeoutError, extractEntityFacts } from "../../src/core/ingestion/entity-facts.js";
import { PageManager } from "../../src/core/page.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import { CBrainDB } from "../../src/storage/sqlite.js";

const ROOT = "/tmp/cbrain-entity-facts-test";

describe("extractEntityFacts (#321)", () => {
  let db: CBrainDB;
  let pages: PageManager;

  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
    db = new CBrainDB(join(ROOT, "brain.sqlite"));
    pages = new PageManager(db, ROOT);
  });

  afterEach(() => {
    db.close();
    if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  });

  test("a trusted field written during the LLM wait is never overwritten", async () => {
    const page = pages.create({
      slug: "brain/entities/company/entity-a",
      title: "实体A",
      type: "entity/company",
      body: "匿名正文",
      tags: [],
    });
    let resolveChat!: (value: string) => void;
    const llm: LLMProvider = {
      name: "mock",
      chat: () => new Promise<string>((resolve) => { resolveChat = resolve; }),
    };

    const pending = extractEntityFacts({
      pages,
      llm,
      slug: page.slug,
      title: page.title,
      type: page.type,
      body: page.body,
      timeoutMs: 1_000,
    });
    pages.update(page.slug, { extra: { industry: "人工值" } });
    resolveChat(JSON.stringify({ facts: [
      { field: "industry", value: "模型值", confidence: 0.9, evidence: "明确证据" },
    ] }));
    await pending;

    expect(pages.getBySlug(page.slug)?.frontmatter.industry).toBe("人工值");
  });

  test("timeout happens before any frontmatter write", async () => {
    const page = pages.create({
      slug: "brain/entities/company/entity-a",
      title: "实体A",
      type: "entity/company",
      body: "匿名正文",
      tags: [],
    });
    const llm: LLMProvider = { name: "slow", chat: () => new Promise<string>(() => {}) };

    await expect(extractEntityFacts({
      pages,
      llm,
      slug: page.slug,
      title: page.title,
      type: page.type,
      body: page.body,
      timeoutMs: 5,
    })).rejects.toBeInstanceOf(EntityFactsTimeoutError);
    expect(pages.getBySlug(page.slug)?.frontmatter.industry).toBeUndefined();
  });

  test("marks an extracted organization as ner provenance", async () => {
    const page = pages.create({
      slug: "brain/entities/person/entity-a",
      title: "实体A",
      type: "entity/person",
      body: "匿名正文",
      tags: [],
    });
    const llm: LLMProvider = {
      name: "mock",
      chat: async () => JSON.stringify({ facts: [
        { field: "organization", value: "组织C", confidence: 0.9, evidence: "实体A在组织C任职" },
      ] }),
    };

    await extractEntityFacts({ pages, llm, slug: page.slug, title: page.title, type: page.type, body: page.body });

    expect(pages.getBySlug(page.slug)?.frontmatter.organization).toBe("组织C");
    expect(pages.getBySlug(page.slug)?.frontmatter.organization_source).toBe("ner");
  });

  test("does not downgrade a stronger organization source", async () => {
    const page = pages.create({
      slug: "brain/entities/person/entity-a",
      title: "实体A",
      type: "entity/person",
      body: "匿名正文",
      tags: [],
      extra: { organization_source: "manual" },
    });
    const llm: LLMProvider = {
      name: "mock",
      chat: async () => JSON.stringify({ facts: [
        { field: "organization", value: "组织C", confidence: 0.9, evidence: "实体A在组织C任职" },
      ] }),
    };

    await extractEntityFacts({ pages, llm, slug: page.slug, title: page.title, type: page.type, body: page.body });

    expect(pages.getBySlug(page.slug)?.frontmatter.organization).toBe("组织C");
    expect(pages.getBySlug(page.slug)?.frontmatter.organization_source).toBe("manual");
  });
});
