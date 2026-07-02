import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { applyFacts } from "../../src/core/ingestion/structured-facts.js";
import type { StructuredFact } from "../../src/core/ingestion/ner.js";
import { PageManager } from "../../src/core/page.js";
import { Logger } from "../../src/core/logger.js";

// Anonymous sentinel slugs only (#233).
describe("applyFacts reports_to conflict surfacing", () => {
  const testDir = "/tmp/cbrain-test-structured-facts-conflict";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let pages: PageManager;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    const logger = new Logger(vaultPath);
    pages = new PageManager(db, vaultPath, logger, {
      connect: async () => {}, addChunks: async () => {}, search: async () => [],
      fullTextSearch: async () => [], deleteByPageSlug: async () => {}, close: async () => {},
    } as any);
  });
  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("reports_to conflict is flagged volatile, not silently dropped", () => {
    const created = pages.create({ title: "人物甲", type: "entity/person", body: "" });
    // Pre-set a trusted reports_to (deterministic source)
    pages.update(created.slug, { extra: { reports_to: "entities/mgr-existing" } });

    const facts: StructuredFact[] = [
      { entity: "人物甲", field: "reports_to", value: "entities/mgr-proposed", evidence: "ner-extract", confidence: 0.6 },
    ];
    const res = applyFacts(facts, new Map([["人物甲", created.slug]]), pages, db);

    expect(res.written).toBe(0);
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0].volatile).toBe(true);
    expect(res.conflicts[0].proposed).toBe("entities/mgr-proposed");
    // Trusted frontmatter NOT overwritten
    expect(pages.getBySlug(created.slug)!.frontmatter.reports_to).toBe("entities/mgr-existing");
  });

  test("non-volatile field conflict is not flagged volatile", () => {
    const created = pages.create({ title: "公司乙", type: "entity/company", body: "" });
    pages.update(created.slug, { extra: { industry: "existing-industry" } });
    const facts: StructuredFact[] = [
      { entity: "公司乙", field: "industry", value: "proposed-industry", evidence: "ner", confidence: 0.6 },
    ];
    const res = applyFacts(facts, new Map([["公司乙", created.slug]]), pages, db);
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0].volatile).toBe(undefined);
  });

  test("non-conflicting reports_to fact writes normally", () => {
    const created = pages.create({ title: "人物丙", type: "entity/person", body: "" });
    const facts: StructuredFact[] = [
      { entity: "人物丙", field: "reports_to", value: "entities/mgr-new", evidence: "ner", confidence: 0.7 },
    ];
    const res = applyFacts(facts, new Map([["人物丙", created.slug]]), pages, db);
    expect(res.written).toBe(1);
    expect(res.conflicts).toHaveLength(0);
    expect(pages.getBySlug(created.slug)!.frontmatter.reports_to).toBe("entities/mgr-new");
  });
});
