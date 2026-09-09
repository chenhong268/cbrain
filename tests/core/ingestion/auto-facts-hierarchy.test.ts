import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../../src/storage/sqlite.js";
import { PageManager } from "../../../src/core/page.js";
import { GraphManager } from "../../../src/core/graph/graph.js";
import { setHierarchy } from "../../../src/core/graph/hierarchy.js";
import { probeHierarchy } from "../../../src/core/fsck/hierarchy-probe.js";
import { extractEntityFacts } from "../../../src/core/ingestion/entity-facts.js";
import { applyFacts } from "../../../src/core/ingestion/structured-facts.js";
import type { StructuredFact } from "../../../src/core/ingestion/ner.js";
import type { LLMProvider } from "../../../src/llm/provider.js";

// #460 regression: both automatic fact writers (deferred extractEntityFacts and
// synchronous applyFacts) must leave authoritative hierarchy frontmatter alone —
// real temporary pages through the storage gate stay at zero hierarchy findings,
// trusted hierarchy survives, and explicit confirmation flows (setHierarchy)
// keep writing hierarchy as before.
describe("auto facts vs hierarchy storage gate (#460)", () => {
  const testDir = "/tmp/cbrain-test-auto-facts-hierarchy";
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let pages: PageManager;
  let graph: GraphManager;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(join(testDir, "test.sqlite"));
    pages = new PageManager(db, vaultPath);
    graph = new GraphManager(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  const seedPerson = (title: string) =>
    pages.create({ title, type: "entity/person", body: "匿名正文", tags: [] });

  test("both auto fact paths keep the gate clean; setHierarchy still writes and passes it", async () => {
    const a = seedPerson("实体甲");
    const b = seedPerson("实体乙");

    // Deferred path: the model emits a plain-name hierarchy claim.
    const llm: LLMProvider = {
      name: "mock",
      chat: async () => JSON.stringify({ facts: [
        { field: "reports_to", value: "实体乙", confidence: 0.9, evidence: "实体甲向实体乙汇报" },
        { field: "birthday", value: "1990-01-01", confidence: 0.9, evidence: "实体甲生于1990年" },
      ] }),
    };
    await extractEntityFacts({ pages, llm, slug: a.slug, title: a.title, type: a.type, body: a.body });

    // Synchronous path: even a full-slug hierarchy claim is refused.
    const facts: StructuredFact[] = [
      { entity: "实体甲", field: "reports_to", value: b.slug, evidence: "ner", confidence: 0.8 },
    ];
    applyFacts(facts, new Map([["实体甲", a.slug]]), pages, db);

    // Ordinary facts still landed.
    expect(pages.getBySlug(a.slug)?.frontmatter.birthday).toBe("1990-01-01");
    // No malformed/authoritative hierarchy was written by either path.
    expect(probeHierarchy(vaultPath, db)).toHaveLength(0);

    // The authoritative writer still works and satisfies the gate.
    setHierarchy(a.slug, b.slug, { pages, graph });
    expect(pages.getBySlug(a.slug)?.frontmatter.reports_to).toBe(b.slug);
    expect(probeHierarchy(vaultPath, db)).toHaveLength(0);
  });

  test("an existing trusted hierarchy survives both auto fact paths and the gate stays clean", async () => {
    const a = seedPerson("实体甲");
    const b = seedPerson("实体乙");
    const c = seedPerson("实体丙");
    setHierarchy(a.slug, c.slug, { pages, graph });

    const llm: LLMProvider = {
      name: "mock",
      chat: async () => JSON.stringify({ facts: [
        { field: "reports_to", value: "实体乙", confidence: 0.9, evidence: "实体甲向实体乙汇报" },
      ] }),
    };
    await extractEntityFacts({ pages, llm, slug: a.slug, title: a.title, type: a.type, body: a.body });
    const facts: StructuredFact[] = [
      { entity: "实体甲", field: "reports_to", value: b.slug, evidence: "ner", confidence: 0.8 },
    ];
    applyFacts(facts, new Map([["实体甲", a.slug]]), pages, db);

    expect(pages.getBySlug(a.slug)?.frontmatter.reports_to).toBe(c.slug);
    expect(probeHierarchy(vaultPath, db)).toHaveLength(0);
  });

  test("candidate relation edges are unchanged and alone do not trip the gate", () => {
    const a = seedPerson("实体甲");
    const b = seedPerson("实体乙");

    // The NER relation path still records hierarchy claims as candidate evidence.
    db.insertLink(a.slug, b.slug, "reports_to", "实体甲向实体乙汇报", 0.5, "weak", "ner", 0.5, undefined, { source_page_slug: a.slug });

    const links = db.getOutgoingLinks(a.slug, true).filter((l) => l.relation === "reports_to");
    expect(links).toHaveLength(1);
    expect(links[0].trust_state).toBe("candidate");
    expect(links[0].source_type).toBe("ner");
    expect(probeHierarchy(vaultPath, db)).toHaveLength(0);
  });
});
