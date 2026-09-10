import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync, rmSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { PageManager } from "../../src/core/page.js";
import { ContentPipeline } from "../../src/core/ingestion/pipeline.js";
import { DialogueIngest } from "../../src/core/ingestion/dialogue.js";
import { WritebackManager } from "../../src/core/safety/writeback.js";
import { GraphManager } from "../../src/core/graph/graph.js";
import { Logger } from "../../src/core/logger.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import { addKnowledge, type KnowledgeWriteDeps } from "../../src/core/graph/knowledge-write.js";
import { insertSemanticLink, RELATION_LABEL_CONFLICT } from "../../src/core/shared.js";
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

function seedPage(db: CBrainDB, vault: string, slug: string, title: string, type: string) {
  const filePath = `${slug}.md`;
  const absolute = join(vault, filePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `---\ntitle: ${title}\ntype: ${type}\nslug: ${slug}\n---\nbody`);
  db.rawDb
    .prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash, tier) VALUES (?, ?, ?, ?, ?, 3)",
    )
    .run(slug, type, title, filePath, `hash-${slug}`);
}

// bun:sqlite returns untyped rows; slug is the pages TEXT primary key.
function slugOf(db: CBrainDB, title: string): string {
  const row = db.rawDb.prepare("SELECT slug FROM pages WHERE title = ?").get(title) as { slug: string } | undefined;
  if (!row) throw new Error(`page not found: ${title}`);
  return row.slug;
}

// bun:sqlite returns untyped rows; whole-row shape for byte-level comparison.
interface LinkRow {
  from_slug: string;
  to_slug: string;
  relation: string;
  context: string | null;
  source_type: string | null;
  trust_state: string | null;
  evidence: string | null;
}

// bun:sqlite returns untyped rows; links rows keyed for whole-row comparison.
function linkRows(db: CBrainDB, from: string, to: string, relation?: string): LinkRow[] {
  const sql = relation
    ? "SELECT from_slug, to_slug, relation, context, source_type, trust_state, evidence FROM links WHERE from_slug = ? AND to_slug = ? AND relation = ?"
    : "SELECT from_slug, to_slug, relation, context, source_type, trust_state, evidence FROM links WHERE from_slug = ? AND to_slug = ?";
  const args = relation ? [from, to, relation] : [from, to];
  return db.rawDb.prepare(sql).all(...args) as LinkRow[];
}

// bun:sqlite returns untyped rows; the query selects one INTEGER column.
function mentionCount(db: CBrainDB, slug: string): number {
  const row = db.rawDb.prepare("SELECT mention_count FROM pages WHERE slug = ?").get(slug) as { mention_count: number } | undefined;
  return row?.mention_count ?? 0;
}

/** Fails any insertLink call to prove storage errors are never swallowed. */
class ExplodingInsertLinkDB extends CBrainDB {
  insertLink(): never {
    throw new Error("simulated storage failure");
  }
}

const PERSON_A = "brain/entities/person/entity-a";
const PERSON_B = "brain/entities/person/entity-b";
const COMPANY_C = "brain/entities/company/org-c";

describe("semantic relation label preservation (#472)", () => {
  let workDir: string;
  let vaultPath: string;
  let db: CBrainDB;
  let pages: PageManager;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "cbrain-relation-label-"));
    vaultPath = join(workDir, "vault");
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(join(workDir, "test.sqlite"));
    pages = new PageManager(db, vaultPath);
    seedPage(db, vaultPath, PERSON_A, "实体A", "entity/person");
    seedPage(db, vaultPath, PERSON_B, "实体B", "entity/person");
    seedPage(db, vaultPath, COMPANY_C, "组织C", "entity/company");
  });

  afterEach(() => {
    db.close();
    if (existsSync(workDir)) rmSync(workDir, { recursive: true });
  });

  describe("insertSemanticLink helper", () => {
    test("fresh alias write keeps canonical relation and prefixed original label", () => {
      const inserted = insertSemanticLink(db, PERSON_A, COMPANY_C, "曾任", {
        context: "旧的匿名上下文",
        sourceType: "writeback",
        confidence: 0.6,
      });

      expect(inserted).toBe(true);
      const rows = linkRows(db, PERSON_A, COMPANY_C);
      expect(rows).toHaveLength(1);
      expect(rows[0].relation).toBe("任职");
      expect(rows[0].context).toBe('[input_label:"曾任"]旧的匿名上下文');
      expect(rows[0].source_type).toBe("writeback");
      expect(rows[0].trust_state).toBe("candidate");
    });

    test("alias with null context stores only the label prefix", () => {
      insertSemanticLink(db, PERSON_A, COMPANY_C, "works_at", { sourceType: "agent" });
      expect(linkRows(db, PERSON_A, COMPANY_C, "任职")[0].context).toBe('[input_label:"works_at"]');
    });

    test("alias conflicting with an existing active canonical triple fails without mutation", () => {
      insertSemanticLink(db, PERSON_A, COMPANY_C, "曾任", { context: "第一次", sourceType: "writeback" });
      const before = linkRows(db, PERSON_A, COMPANY_C);

      const second = insertSemanticLink(db, PERSON_A, COMPANY_C, "现任总经理", {
        context: "第二次",
        sourceType: "writeback",
      });

      expect(second).toBe(false);
      expect(linkRows(db, PERSON_A, COMPANY_C)).toEqual(before);
    });

    test("conflict lookup includes rejected and superseded tombstone rows", () => {
      for (const trust of ["rejected", "superseded"]) {
        db.rawDb.prepare("DELETE FROM links").run();
        db.rawDb
          .prepare("INSERT INTO links (from_slug, to_slug, relation, context, trust_state) VALUES (?, ?, '任职', ?, ?)")
          .run(PERSON_B, COMPANY_C, `旧的${trust}`, trust);
        const before = linkRows(db, PERSON_B, COMPANY_C);

        expect(
          insertSemanticLink(db, PERSON_B, COMPANY_C, "现任总经理", { context: "新的", sourceType: "agent" }),
        ).toBe(false);
        expect(linkRows(db, PERSON_B, COMPANY_C)).toEqual(before);
      }
    });

    test("alias conflicting with the ontology reverse triple fails without adding a forward edge", () => {
      db.rawDb
        .prepare("INSERT INTO links (from_slug, to_slug, relation, context, trust_state) VALUES (?, ?, '下属', '旧的', 'trusted')")
        .run(PERSON_B, PERSON_A);
      const beforeAll = linkRows(db, PERSON_B, PERSON_A, "下属");

      // alias 汇报给 → 上级 (A reports to B); reverse(上级) = 下属 matches (B,A,下属)
      const inserted = insertSemanticLink(db, PERSON_A, PERSON_B, "汇报给", { context: "新的", sourceType: "agent" });

      expect(inserted).toBe(false);
      expect(linkRows(db, PERSON_A, PERSON_B, "上级")).toHaveLength(0);
      expect(linkRows(db, PERSON_B, PERSON_A, "下属")).toEqual(beforeAll);
    });

    test("reverse storage failure rolls back the new forward edge", () => {
      db.rawDb.exec("CREATE TRIGGER reject_reverse BEFORE INSERT ON links WHEN NEW.relation = '下属' BEGIN SELECT RAISE(ABORT, 'reverse_storage_failure'); END");
      expect(() => insertSemanticLink(db, PERSON_A, PERSON_B, "汇报给", {
        context: "匿名上下文", sourceType: "agent",
      })).toThrow("reverse_storage_failure");
      expect(linkRows(db, PERSON_A, PERSON_B)).toEqual([]);
      expect(linkRows(db, PERSON_B, PERSON_A)).toEqual([]);
    });

    test("canonical input keeps low-level INSERT OR IGNORE semantics", () => {
      const first = insertSemanticLink(db, PERSON_A, COMPANY_C, "任职", { context: "第一次", sourceType: "agent" });
      const second = insertSemanticLink(db, PERSON_A, COMPANY_C, "任职", { context: "第二次", sourceType: "agent" });

      expect(first).toBe(true);
      expect(second).toBe(true);
      const rows = linkRows(db, PERSON_A, COMPANY_C, "任职");
      expect(rows).toHaveLength(1);
      expect(rows[0].context).toBe("第一次");
    });

    test("storage failures propagate, not conflict-returns", () => {
      const exploding = new ExplodingInsertLinkDB(join(workDir, "exploding.sqlite"));
      expect(() =>
        insertSemanticLink(exploding, PERSON_A, COMPANY_C, "曾任", { sourceType: "agent" }),
      ).toThrow("simulated storage failure");
      exploding.close();
    });
  });

  describe("NER pipeline (processNer)", () => {
    function makePipeline(database: CBrainDB, pagesManager: PageManager): ContentPipeline {
      return new ContentPipeline(database, stubEmbedding, new LanceDBManager(), {
        pages: pagesManager,
        nerEngine: new NerEngine(createMockLLM([])),
      });
    }

    test("alias relation keeps original label in context; evidence untouched", async () => {
      seedPage(db, vaultPath, "records/source-doc", "源记录D", "record");
      const extraction: ExtractionResult = {
        entities: [
          { name: "实体A", type: "person", relevance: "high", context: "实体A曾任于组织C" },
          { name: "组织C", type: "company", relevance: "high", context: "实体A曾任于组织C" },
        ],
        relations: [{ from: "实体A", to: "组织C", relation: "曾任", context: "实体A曾任于组织C原文" }],
        events: [],
        facts: [],
        filtered: [],
      };

      const result = await makePipeline(db, pages).processNer("records/source-doc", "正文", "record", true, extraction);

      expect(result!.relations).toBe(1);
      const personSlug = slugOf(db, "实体A");
      const companySlug = slugOf(db, "组织C");
      const rows = linkRows(db, personSlug, companySlug, "任职");
      expect(rows).toHaveLength(1);
      expect(rows[0].context).toBe('[input_label:"曾任"]实体A曾任于组织C原文');
      expect(rows[0].evidence).toBe("实体A曾任于组织C原文");
      expect(rows[0].source_type).toBe("ner");
    });

    test("alias conflicting with existing canonical triple is skipped, not counted, row untouched", async () => {
      seedPage(db, vaultPath, "records/source-doc", "源记录D", "record");
      const personSlug = slugOf(db, "实体A");
      const companySlug = slugOf(db, "组织C");
      db.rawDb
        .prepare("INSERT INTO links (from_slug, to_slug, relation, context, trust_state) VALUES (?, ?, '任职', '旧的', 'trusted')")
        .run(personSlug, companySlug);
      const before = linkRows(db, personSlug, companySlug, "任职");

      const extraction: ExtractionResult = {
        entities: [
          { name: "实体A", type: "person", relevance: "high", context: "x" },
          { name: "实体B", type: "person", relevance: "high", context: "x" },
          { name: "组织C", type: "company", relevance: "high", context: "x" },
        ],
        relations: [
          { from: "实体A", to: "组织C", relation: "现任总经理", context: "新的" },
          { from: "实体A", to: "实体B", relation: "认识", context: "合法兄弟" },
        ],
        events: [],
        facts: [],
        filtered: [],
      };

      const result = await makePipeline(db, pages).processNer("records/source-doc", "正文", "record", true, extraction);

      expect(result!.details.relations).toEqual([{ from: "实体A", to: "实体B", relation: "认识" }]);
      expect(linkRows(db, personSlug, companySlug, "任职")).toEqual(before);
    });
  });

  describe("DialogueIngest", () => {
    function makeDialogue(database: CBrainDB, pagesManager: PageManager, llm: LLMProvider): DialogueIngest {
      return new DialogueIngest(database, stubEmbedding, stubLance, vaultPath, llm, undefined, pagesManager);
    }

    test("alias relation keeps label; canonical duplicate dedup stays silent", async () => {
      const llm = createMockLLM([
        JSON.stringify({
          entities: [
            { name: "实体A", type: "person", relevance: "high", context: "x" },
            { name: "组织C", type: "company", relevance: "high", context: "x" },
          ],
          relations: [{ from: "实体A", to: "组织C", relation: "曾任", context: "对话原文" }],
          events: [],
          facts: [],
        }),
      ]);
      await makeDialogue(db, pages, llm).ingest("正文", "manual");

      const personSlug = slugOf(db, "实体A");
      const companySlug = slugOf(db, "组织C");
      const rows = linkRows(db, personSlug, companySlug, "任职");
      expect(rows).toHaveLength(1);
      expect(rows[0].context).toBe('[input_label:"曾任"]对话原文');
      expect(rows[0].source_type).toBe("dialogue");
    });

    test("alias conflict emits a safe diagnostic and keeps the valid sibling", async () => {
      const personSlug = slugOf(db, "实体A");
      const companySlug = slugOf(db, "组织C");
      db.rawDb
        .prepare("INSERT INTO links (from_slug, to_slug, relation, context, trust_state) VALUES (?, ?, '任职', '旧的', 'trusted')")
        .run(personSlug, companySlug);
      const before = linkRows(db, personSlug, companySlug, "任职");

      const llm = createMockLLM([
        JSON.stringify({
          entities: [
            { name: "实体A", type: "person", relevance: "high", context: "x" },
            { name: "组织C", type: "company", relevance: "high", context: "x" },
          ],
          relations: [
            { from: "实体A", to: "组织C", relation: "现任总经理", context: "新的" },
            { from: "实体A", to: "组织C", relation: "提及", context: "合法兄弟" },
          ],
          events: [],
          facts: [],
        }),
      ]);
      const logger = new Logger(workDir);
      const warnings = spyOn(logger, "warn").mockImplementation(() => {});
      const dialogue = new DialogueIngest(db, stubEmbedding, stubLance, vaultPath, llm, logger, pages);
      const result = await dialogue.ingest("正文", "manual");

      expect(result.newRelations).toBe(1);
      expect(linkRows(db, personSlug, companySlug, "任职")).toEqual(before);
      expect(linkRows(db, personSlug, companySlug, "提及")).toHaveLength(1);
      const conflicts = warnings.mock.calls.filter(([, , details]) => details?.code === "relation_label_conflict");
      expect(conflicts).toHaveLength(1);
      expect(JSON.stringify(conflicts)).not.toContain("实体A");
      expect(JSON.stringify(conflicts)).not.toContain("现任总经理");
    });
  });

  describe("WritebackManager create_link", () => {
    const fromSlug = PERSON_A;
    const toSlug = COMPANY_C;


    test("probe scenario: first alias keeps label, second alias fails, old row unchanged", async () => {
      const writeback = new WritebackManager(pages, db);

      const first = await writeback.execute({
        action: "create_link",
        content: "",
        fromSlug,
        toSlug,
        relation: "曾任",
        source: "旧的匿名上下文",
      });
      expect(first.success).toBe(true);
      const before = linkRows(db, fromSlug, toSlug, "任职");
      expect(before[0].context).toBe('[input_label:"曾任"]旧的匿名上下文');

      const second = await writeback.execute({
        action: "create_link",
        content: "",
        fromSlug,
        toSlug,
        relation: "现任总经理",
        source: "新的匿名上下文",
      });
      expect(second.success).toBe(false);
      expect(second.error).toContain("conflict");
      expect(linkRows(db, fromSlug, toSlug, "任职")).toEqual(before);
      expect(mentionCount(db, toSlug)).toBe(0);
    });

    test("canonical duplicate writeback stays compatible (silent ignore, success)", async () => {
      const writeback = new WritebackManager(pages, db);
      await writeback.execute({
        action: "create_link", content: "", fromSlug, toSlug, relation: "任职", source: "第一次",
      });
      const second = await writeback.execute({
        action: "create_link", content: "", fromSlug, toSlug, relation: "任职", source: "第二次",
      });
      expect(second.success).toBe(true);
      expect(linkRows(db, fromSlug, toSlug, "任职")[0].context).toBe("第一次");
    });
  });

  describe("add_knowledge relations", () => {
    let deps: KnowledgeWriteDeps;

    beforeEach(() => {
      deps = { db, pages, pipeline: new ContentPipeline(db, stubEmbedding, new LanceDBManager()), graph: new GraphManager(db) };
    });

    test("alias relation succeeds with label and mention; evidence untouched", async () => {
      const result = await addKnowledge({
        subject: "实体A",
        relations: [{ target: "组织C", relation: "works_at", target_type: "company" }],
        evidence: "证据原文",
      }, deps);

      expect(result.applied[0].success).toBe(true);
      const rows = linkRows(db, PERSON_A, COMPANY_C, "任职");
      expect(rows[0].context).toBe('[input_label:"works_at"]');
      expect(rows[0].evidence).toBe("证据原文");
      expect(mentionCount(db, COMPANY_C)).toBe(1);
    });

    test("alias conflict fails without mention bump or row mutation", async () => {
      db.rawDb
        .prepare("INSERT INTO links (from_slug, to_slug, relation, context, trust_state) VALUES (?, ?, '任职', '旧的', 'trusted')")
        .run(PERSON_A, COMPANY_C);
      const before = linkRows(db, PERSON_A, COMPANY_C, "任职");

      const result = await addKnowledge({
        subject: "实体A",
        relations: [{ target: "组织C", relation: "现任总经理" }],
      }, deps);

      expect(result.applied[0].success).toBe(false);
      expect(result.applied[0].error).toBe(RELATION_LABEL_CONFLICT);
      expect(linkRows(db, PERSON_A, COMPANY_C, "任职")).toEqual(before);
      expect(mentionCount(db, COMPANY_C)).toBe(0);
    });
  });
});
