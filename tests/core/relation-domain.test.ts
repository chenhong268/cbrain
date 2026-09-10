import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { PageManager } from "../../src/core/page.js";
import { ContentPipeline } from "../../src/core/ingestion/pipeline.js";
import { DialogueIngest } from "../../src/core/ingestion/dialogue.js";
import { WritebackManager } from "../../src/core/safety/writeback.js";
import { GraphManager } from "../../src/core/graph/graph.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import { addKnowledge, type KnowledgeWriteDeps } from "../../src/core/graph/knowledge-write.js";
import { OntologyLoader, getOntology } from "../../src/ontology/loader.js";
import { relationEndpointsAllowed } from "../../src/core/shared.js";
import { NerEngine } from "../../src/core/ingestion/ner.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import type { ExtractionResult } from "../../src/core/ingestion/ner.js";

// Anonymous fixtures only (privacy: no real names in tests).

const stubEmbedding: EmbeddingProvider = {
  embed: async () => ({ embedding: [], tokenCount: 0 }),
  embedBatch: async () => [],
  dimensions: 0,
};

// Structurally-compatible stand-in for the LanceDBManager surface DialogueIngest touches.
const stubLance = {
  connect: async () => {},
  addChunks: async () => {},
  search: async () => [],
  fullTextSearch: async () => {},
  deleteByPageSlug: async () => {},
  deleteRawChunksByPageSlug: async () => {},
  close: async () => {},
  createFTSIndex: async () => {},
} as unknown as LanceDBManager;

function createMockLLM(responses: string[]): LLMProvider {
  let callIndex = 0;
  return {
    name: "mock",
    chat: async () => responses[callIndex++] ?? '{"entities":[],"relations":[],"events":[],"facts":[]}',
  };
}

function seedPage(db: CBrainDB, slug: string, title: string, type: string) {
  db.rawDb
    .prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash, tier) VALUES (?, ?, ?, ?, ?, 3)",
    )
    .run(slug, type, title, `${slug}.md`, `hash-${slug}`);
}

// bun:sqlite returns untyped rows; slug is the pages TEXT primary key.
function slugOf(db: CBrainDB, title: string): string {
  const row = db.rawDb.prepare("SELECT slug FROM pages WHERE title = ?").get(title) as { slug: string } | undefined;
  if (!row) throw new Error(`page not found: ${title}`);
  return row.slug;
}

// bun:sqlite returns untyped rows; the query selects one TEXT column.
function outgoingRelations(db: CBrainDB, slug: string): string[] {
  const rows = db.rawDb.prepare("SELECT relation FROM links WHERE from_slug = ?").all(slug) as Array<{ relation: string }>;
  return rows.map((r) => r.relation);
}

// bun:sqlite returns untyped rows; the query selects one INTEGER count column.
function linkCount(db: CBrainDB, fromSlug: string, toSlug: string): number {
  const row = db.rawDb
    .prepare("SELECT COUNT(*) AS c FROM links WHERE from_slug = ? AND to_slug = ?")
    .get(fromSlug, toSlug) as { c: number };
  return row.c;
}

/** Fails any insertLink call to prove storage/integrity errors are never
 * swallowed by the relation-domain skip path. */
class ExplodingInsertLinkDB extends CBrainDB {
  insertLink(): never {
    throw new Error("simulated storage failure");
  }
}

/** Records every syncLinksToMarkdown target to observe affected-slug scope. */
class SyncSpyPages extends PageManager {
  readonly synced: string[] = [];
  override syncLinksToMarkdown(slug: string): void {
    this.synced.push(slug);
    super.syncLinksToMarkdown(slug);
  }
}

// Minimal local ontology exercising a REAL parent constraint: domain declares
// the parent, valid endpoints are its declared children.
const FIXTURE_ONTOLOGY = `version: 1
entity_types:
  test/root:
    label: 测试根
    abstract: true
    structured_fields: []
  test/parent:
    label: 测试父
    parent: test/root
    structured_fields: []
  test/parent/child:
    label: 测试子
    parent: test/parent
    structured_fields: []
relation_types:
  测试关系:
    label: 测试关系
    domain: [test/parent]
    range: [test/parent/child]
    symmetric: false
    transitive: false
    strength: medium
    weight: 0.5
`;

describe("ontology relation domain/range (#471)", () => {
  let workDir: string;
  let vaultPath: string;
  let db: CBrainDB;
  let pages: PageManager;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "cbrain-relation-domain-"));
    vaultPath = join(workDir, "vault");
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(join(workDir, "test.sqlite"));
    pages = new PageManager(db, vaultPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(workDir)) rmSync(workDir, { recursive: true });
  });

  describe("validateRelationDomain", () => {
    test("rejects prefix lookalike endpoint types", () => {
      // "entity/person-x" is not a declared type and must not satisfy a
      // domain of entity/person via string prefixing.
      expect(getOntology().validateRelationDomain("任职", "entity/person-x", "entity/company")).toBe(false);
      expect(getOntology().validateRelationDomain("任职", "entity/person", "entity/company-x")).toBe(false);
    });

    test("rejects unknown endpoint types on constrained relations", () => {
      expect(getOntology().validateRelationDomain("任职", "unknown/type", "entity/company")).toBe(false);
    });

    test("accepts declared types on the production ontology", () => {
      expect(getOntology().validateRelationDomain("任职", "entity/person", "entity/company")).toBe(true);
    });

    test("unconstrained relations accept any endpoints", () => {
      expect(getOntology().validateRelationDomain("提及", "record", "entity/company")).toBe(true);
    });

    test("unknown relation names are invalid", () => {
      expect(getOntology().validateRelationDomain("not_a_relation", "entity/person", "entity/company")).toBe(false);
    });

    describe("real ancestry via local fixture ontology", () => {
      let loader: OntologyLoader;

      beforeEach(() => {
        const yamlPath = join(workDir, "fixture-ontology.yaml");
        writeFileSync(yamlPath, FIXTURE_ONTOLOGY, "utf-8");
        loader = new OntologyLoader(yamlPath);
      });

      test("declared child satisfies a parent-type domain constraint via inheritance", () => {
        // domain [test/parent] + declared subtype test/parent/child → allowed
        expect(loader.validateRelationDomain("测试关系", "test/parent/child", "test/parent/child")).toBe(true);
        // exact declared parent type also satisfies its own constraint
        expect(loader.validateRelationDomain("测试关系", "test/parent", "test/parent/child")).toBe(true);
      });

      test("undeclared lookalike names never satisfy the constraint", () => {
        expect(loader.validateRelationDomain("测试关系", "test/parent-evil", "test/parent/child")).toBe(false);
        expect(loader.validateRelationDomain("测试关系", "test/parent/child/evil", "test/parent/child")).toBe(false);
        expect(loader.validateRelationDomain("测试关系", "test/parent/child", "undeclared/child")).toBe(false);
      });

      test("supertype endpoint does not satisfy a child-range constraint", () => {
        expect(loader.validateRelationDomain("测试关系", "test/parent/child", "test/parent")).toBe(false);
        expect(loader.validateRelationDomain("测试关系", "test/parent/child", "test/root")).toBe(false);
      });
    });
  });

  describe("relationEndpointsAllowed (shared preflight)", () => {
    test("unknown canonical relation name is rejected, not fail-open", () => {
      // The six entry points normalize before preflight, so a name with no
      // ontology definition must not pass through as a constraint bypass.
      expect(relationEndpointsAllowed(db, "brain/entities/person/a", "brain/entities/company/b", "绝非声明关系")).toBe(false);
    });

    test("unconstrained relation links arbitrary existing pages", () => {
      seedPage(db, "records/note-1", "记录E", "record");
      seedPage(db, "brain/entities/person/a", "实体A", "entity/person");
      expect(relationEndpointsAllowed(db, "records/note-1", "brain/entities/person/a", "提及")).toBe(true);
    });

    test("constrained relation requires both endpoints to exist", () => {
      seedPage(db, "brain/entities/person/a", "实体A", "entity/person");
      expect(relationEndpointsAllowed(db, "brain/entities/person/a", "brain/entities/company/ghost", "任职")).toBe(false);
      expect(relationEndpointsAllowed(db, "brain/entities/person/ghost", "brain/entities/person/a", "认识")).toBe(false);
    });
  });

  describe("NER pipeline (processNer)", () => {
    function makePipeline(pagesManager: PageManager, database: CBrainDB): ContentPipeline {
      return new ContentPipeline(database, stubEmbedding, new LanceDBManager(), {
        pages: pagesManager,
        nerEngine: new NerEngine(createMockLLM([])),
      });
    }

    const mixedExtraction: ExtractionResult = {
      entities: [
        { name: "实体A", type: "person", relevance: "high", context: "实体A任职于组织C" },
        { name: "组织C", type: "company", relevance: "high", context: "实体A任职于组织C" },
      ],
      relations: [
        // company → person 任职 is range-incompatible
        { from: "组织C", to: "实体A", relation: "works_at", context: "反向误提取" },
        // person → company 任职 is valid
        { from: "实体A", to: "组织C", relation: "works_at", context: "实体A任职于组织C" },
      ],
      events: [],
      facts: [],
      filtered: [],
    };

    test("writes only domain-compatible relations; invalid ones are skipped", async () => {
      seedPage(db, "records/source-doc", "源记录D", "record");
      const pipeline = makePipeline(pages, db);

      const result = await pipeline.processNer("records/source-doc", "实体A任职于组织C", "record", true, mixedExtraction);
      expect(result).not.toBeNull();

      const personSlug = slugOf(db, "实体A");
      const companySlug = slugOf(db, "组织C");

      // person → company edge exists
      expect(
        db.rawDb.prepare("SELECT COUNT(*) AS c FROM links WHERE from_slug = ? AND to_slug = ? AND relation = '任职'")
          .get(personSlug, companySlug),
      ).toEqual({ c: 1 });
      // company → person edge must NOT exist
      expect(linkCount(db, companySlug, personSlug)).toBe(0);

      // details only report the valid relation
      expect(result!.details.relations).toHaveLength(1);
      expect(result!.details.relations[0]).toEqual({ from: "实体A", to: "组织C", relation: "任职" });

      // the success counter reports written relations, not candidates
      expect(result!.relations).toBe(1);
    });

    test("all-invalid extraction reports zero written relations; entity side effects stay intact", async () => {
      seedPage(db, "records/source-doc", "源记录D", "record");
      const pipeline = makePipeline(pages, db);

      const invalidOnly: ExtractionResult = {
        ...mixedExtraction,
        relations: [{ from: "组织C", to: "实体A", relation: "works_at", context: "反向误提取" }],
      };

      const result = await pipeline.processNer("records/source-doc", "实体A任职于组织C", "record", true, invalidOnly);
      expect(result!.relations).toBe(0);
      expect(result!.details.relations).toEqual([]);
      expect(result!.relationSlugs).toEqual([]);

      // independent entity processing is preserved: stubs + source 提及 links
      const personSlug = slugOf(db, "实体A");
      const companySlug = slugOf(db, "组织C");
      expect(linkCount(db, "records/source-doc", personSlug)).toBe(1);
      expect(linkCount(db, "records/source-doc", companySlug)).toBe(1);
      expect(linkCount(db, companySlug, personSlug)).toBe(0);
    });

    test("storage errors on valid relations are not swallowed as skips", async () => {
      const explodingDb = new ExplodingInsertLinkDB(join(workDir, "exploding.sqlite"));
      seedPage(explodingDb, "records/source-doc", "源记录D", "record");
      const explodingPages = new PageManager(explodingDb, vaultPath);
      const pipeline = makePipeline(explodingPages, explodingDb);

      const validOnly: ExtractionResult = {
        ...mixedExtraction,
        relations: [{ from: "实体A", to: "组织C", relation: "works_at", context: "实体A任职于组织C" }],
      };

      await expect(
        pipeline.processNer("records/source-doc", "实体A任职于组织C", "record", true, validOnly),
      ).rejects.toThrow("simulated storage failure");
      explodingDb.close();
    });
  });

  describe("DialogueIngest", () => {
    function makeDialogue(database: CBrainDB, pagesManager: PageManager, llm: LLMProvider): DialogueIngest {
      return new DialogueIngest(database, stubEmbedding, stubLance, vaultPath, llm, undefined, pagesManager);
    }

    test("invalid relation is rejected while valid sibling relation is written", async () => {
      const llm = createMockLLM([
        JSON.stringify({
          entities: [
            { name: "实体A", type: "person", relevance: "high", context: "实体A任职于组织C" },
            { name: "组织C", type: "company", relevance: "high", context: "实体A任职于组织C" },
          ],
          relations: [
            { from: "组织C", to: "实体A", relation: "works_at", context: "反向误提取" },
            { from: "实体A", to: "组织C", relation: "works_at", context: "实体A任职于组织C" },
          ],
          events: [],
          facts: [],
        }),
      ]);

      const result = await makeDialogue(db, pages, llm).ingest("实体A任职于组织C。", "manual");

      expect(result.newRelations).toBe(1);

      const personSlug = slugOf(db, "实体A");
      const companySlug = slugOf(db, "组织C");
      expect(outgoingRelations(db, personSlug)).toEqual(["任职"]);
      expect(outgoingRelations(db, companySlug)).toEqual([]);
    });

    test("all-invalid dialogue keeps entity creation but contributes zero relation side effects", async () => {
      const llm = createMockLLM([
        JSON.stringify({
          entities: [
            { name: "实体A", type: "person", relevance: "high", context: "实体A任职于组织C" },
            { name: "组织C", type: "company", relevance: "high", context: "实体A任职于组织C" },
          ],
          relations: [
            { from: "组织C", to: "实体A", relation: "works_at", context: "反向误提取" },
          ],
          events: [],
          facts: [],
        }),
      ]);

      const result = await makeDialogue(db, pages, llm).ingest("实体A任职于组织C。", "manual");

      // relation contribution is exactly zero
      expect(result.newRelations).toBe(0);
      expect(result.decision).toBe("recorded"); // entity creation is independent

      const personSlug = slugOf(db, "实体A");
      const companySlug = slugOf(db, "组织C");
      expect(linkCount(db, companySlug, personSlug)).toBe(0);
      // relation contribution is zero: no Known Relations wiki-links appear
      // for the failed endpoints (entity Context text stays as created)
      expect(pages.getBySlug(companySlug)!.body).not.toContain("[[");
      expect(pages.getBySlug(personSlug)!.body).not.toContain("[[");
    });

    test("storage errors on valid relations propagate out of ingest", async () => {
      const explodingDb = new ExplodingInsertLinkDB(join(workDir, "exploding.sqlite"));
      const explodingPages = new PageManager(explodingDb, vaultPath);
      const llm = createMockLLM([
        JSON.stringify({
          entities: [
            { name: "实体A", type: "person", relevance: "high", context: "实体A任职于组织C" },
            { name: "组织C", type: "company", relevance: "high", context: "实体A任职于组织C" },
          ],
          relations: [
            { from: "实体A", to: "组织C", relation: "works_at", context: "实体A任职于组织C" },
          ],
          events: [],
          facts: [],
        }),
      ]);

      await expect(
        makeDialogue(explodingDb, explodingPages, llm).ingest("实体A任职于组织C。", "manual"),
      ).rejects.toThrow("simulated storage failure");
      explodingDb.close();
    });
  });

  describe("WritebackManager create_link", () => {
    test("rejects incompatible endpoints without writing", async () => {
      const company = pages.create({ title: "组织C", type: "entity/company", body: "" });
      const person = pages.create({ title: "实体A", type: "entity/person", body: "" });
      const writeback = new WritebackManager(pages, db);

      // company → person works_at violates 任职 range
      const invalid = await writeback.execute({
        action: "create_link",
        content: "",
        fromSlug: company.slug,
        toSlug: person.slug,
        relation: "works_at",
      });
      expect(invalid.success).toBe(false);
      expect(invalid.error).toBeTruthy();
      expect(outgoingRelations(db, company.slug)).toEqual([]);
    });

    test("alias normalization still works for compatible endpoints", async () => {
      const person = pages.create({ title: "实体A", type: "entity/person", body: "" });
      const company = pages.create({ title: "组织C", type: "entity/company", body: "" });
      const writeback = new WritebackManager(pages, db);

      const valid = await writeback.execute({
        action: "create_link",
        content: "",
        fromSlug: person.slug,
        toSlug: company.slug,
        relation: "works_at",
      });
      expect(valid.success).toBe(true);
      expect(outgoingRelations(db, person.slug)).toEqual(["任职"]);
    });
  });

  describe("add_knowledge relations", () => {
    let deps: KnowledgeWriteDeps;

    beforeEach(() => {
      deps = { db, pages, pipeline: new ContentPipeline(db, stubEmbedding, new LanceDBManager()), graph: new GraphManager(db) };
    });

    test("incompatible relation fails in applied results without writing", async () => {
      seedPage(db, "brain/entities/company/org-c", "组织C", "entity/company");
      seedPage(db, "brain/entities/person/entity-a", "实体A", "entity/person");

      const result = await addKnowledge({
        subject: "组织C",
        relations: [{ target: "实体A", relation: "任职", target_type: "person" }],
      }, deps);

      // target_type hint must NOT override the stored entity types
      expect(result.applied[0].success).toBe(false);
      expect(result.summary.succeeded).toBe(0);
      expect(outgoingRelations(db, "brain/entities/company/org-c")).toEqual([]);
    });

    test("misleading hint pair that looks compatible is still rejected by stored types", async () => {
      // subject is a stored company, target a stored person; the caller hints
      // the exact opposite (subject_type person / target_type company).
      seedPage(db, "brain/entities/company/org-c", "组织C", "entity/company");
      seedPage(db, "brain/entities/person/entity-a", "实体A", "entity/person");

      const result = await addKnowledge({
        subject: "组织C",
        subject_type: "person",
        relations: [{ target: "实体A", relation: "任职", target_type: "company" }],
      }, deps);

      expect(result.applied[0].success).toBe(false);
      expect(outgoingRelations(db, "brain/entities/company/org-c")).toEqual([]);
    });

    test("valid relation with alias still succeeds", async () => {
      seedPage(db, "brain/entities/company/org-c", "组织C", "entity/company");
      seedPage(db, "brain/entities/person/entity-a", "实体A", "entity/person");

      const result = await addKnowledge({
        subject: "实体A",
        relations: [{ target: "组织C", relation: "works_at", target_type: "company" }],
      }, deps);

      expect(result.applied[0].success).toBe(true);
      expect(outgoingRelations(db, "brain/entities/person/entity-a")).toEqual(["任职"]);
    });

    test("failed relation between existing entities does not sync either endpoint", async () => {
      const spyPages = new SyncSpyPages(db, vaultPath);
      const spyDeps: KnowledgeWriteDeps = { ...deps, pages: spyPages };
      seedPage(db, "brain/entities/company/org-c", "组织C", "entity/company");
      seedPage(db, "brain/entities/person/entity-a", "实体A", "entity/person");

      await addKnowledge({
        subject: "组织C",
        relations: [{ target: "实体A", relation: "任职" }],
      }, spyDeps);

      expect(spyPages.synced).not.toContain("brain/entities/company/org-c");
      expect(spyPages.synced).not.toContain("brain/entities/person/entity-a");
    });

    test("relation and mention roll back together when mention storage fails", async () => {
      const spyPages = new SyncSpyPages(db, vaultPath);
      const person = spyPages.create({ title: "实体A", type: "entity/person", body: "" });
      const company = spyPages.create({ title: "组织C", type: "entity/company", body: "" });
      db.rawDb.exec("CREATE TRIGGER reject_mention BEFORE UPDATE OF mention_count ON pages BEGIN SELECT RAISE(ABORT, 'mention_storage_failure'); END");

      const result = await addKnowledge({
        subject: person.slug,
        relations: [{ target: company.slug, relation: "works_at" }],
      }, { ...deps, pages: spyPages });

      expect(result.summary).toEqual({ total: 1, succeeded: 0, failed: 1 });
      expect(result.applied[0].error).toContain("mention_storage_failure");
      expect(linkCount(db, person.slug, company.slug)).toBe(0);
      expect(db.getPage(company.slug)?.mention_count).toBe(0);
      expect(spyPages.synced).toEqual([]);
    });

    test("successful relation syncs both endpoints; independently created stubs still sync", async () => {
      const spyPages = new SyncSpyPages(db, vaultPath);
      const spyDeps: KnowledgeWriteDeps = { ...deps, pages: spyPages };
      seedPage(db, "brain/entities/company/org-c", "组织C", "entity/company");

      // 实体A does not exist → stub creation is an independent side effect
      await addKnowledge({
        subject: "实体A",
        relations: [{ target: "组织C", relation: "任职", target_type: "company" }],
      }, spyDeps);

      const stubSlug = slugOf(db, "实体A");
      expect(spyPages.synced).toContain(stubSlug);
      expect(spyPages.synced).toContain("brain/entities/company/org-c");
    });
  });
});
