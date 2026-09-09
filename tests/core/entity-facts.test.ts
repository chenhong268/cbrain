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

  // #460: deferred extraction must not write hierarchy claims into frontmatter.
  test("extracted reports_to (plain name) never reaches frontmatter; ordinary facts still apply", async () => {
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
        { field: "reports_to", value: "实体B", confidence: 0.9, evidence: "实体A向实体B汇报" },
        { field: "birthday", value: "1990-01-01", confidence: 0.9, evidence: "实体A生于1990年" },
      ] }),
    };

    const result = await extractEntityFacts({ pages, llm, slug: page.slug, title: page.title, type: page.type, body: page.body });

    expect(pages.getBySlug(page.slug)?.frontmatter.reports_to).toBeUndefined();
    expect(pages.getBySlug(page.slug)?.frontmatter.birthday).toBe("1990-01-01");
    expect(result.appliedCount).toBe(1);
  });

  test("extracted reports_to with a full-slug value is also refused (#460)", async () => {
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
        { field: "reports_to", value: "brain/entities/person/entity-b", confidence: 0.9, evidence: "实体A向实体B汇报" },
      ] }),
    };

    await extractEntityFacts({ pages, llm, slug: page.slug, title: page.title, type: page.type, body: page.body });

    expect(pages.getBySlug(page.slug)?.frontmatter.reports_to).toBeUndefined();
  });

  test("an existing trusted reports_to survives deferred extraction (#460)", async () => {
    const page = pages.create({
      slug: "brain/entities/person/entity-a",
      title: "实体A",
      type: "entity/person",
      body: "匿名正文",
      tags: [],
      extra: { reports_to: "brain/entities/person/entity-b" },
    });
    const llm: LLMProvider = {
      name: "mock",
      chat: async () => JSON.stringify({ facts: [
        { field: "reports_to", value: "实体C", confidence: 0.9, evidence: "实体A向实体C汇报" },
      ] }),
    };

    await extractEntityFacts({ pages, llm, slug: page.slug, title: page.title, type: page.type, body: page.body });

    expect(pages.getBySlug(page.slug)?.frontmatter.reports_to).toBe("brain/entities/person/entity-b");
  });
});
