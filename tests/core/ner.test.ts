import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { NerEngine, NerTimeoutError, isNerTimeoutError } from "../../src/core/ingestion/ner.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import { ContentPipeline } from "../../src/core/ingestion/pipeline.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function createMockLLM(responses: string[]): LLMProvider {
  let callIndex = 0;
  return {
    name: "mock",
    chat: async () => responses[callIndex++] ?? '{"entities":[],"relations":[],"events":[]}',
  };
}

describe("NerEngine", () => {
  // ─── Core pipeline ───────────────────────────────

  test("extracts entities from LLM response", async () => {
    const llm = createMockLLM([
      JSON.stringify({
        entities: [
          { name: "张三", type: "person", context: "张三是星辰科技的商务经理" },
          { name: "星辰科技", type: "company", context: "张三是星辰科技的商务经理" },
        ],
        events: [],
      }),
      JSON.stringify({
        relations: [
          { from: "张三", to: "星辰科技", relation: "works_at", context: "张三是星辰科技的商务经理" },
        ],
      }),
    ]);

    const engine = new NerEngine(llm);
    const result = await engine.extract("张三是星辰科技的商务经理");

    expect(result.entities.length).toBe(2);
    expect(result.entities[0].name).toBe("张三");
    expect(result.entities[0].type).toBe("person");
    expect(result.entities[1].name).toBe("星辰科技");
    expect(result.entities[1].type).toBe("company");
    expect(result.relations.length).toBe(1);
    expect(result.relations[0].relation).toBe("works_at");
  });

  test("extracts events with dates", async () => {
    const llm = createMockLLM([
      JSON.stringify({
        entities: [
          { name: "张三", type: "person", context: "2024年张三创立了ABC科技" },
          { name: "ABC科技", type: "company", context: "2024年张三创立了ABC科技" },
        ],
        events: [
          { date: "2024-01-01", description: "张三创立了ABC科技", participants: ["张三", "ABC科技"] },
        ],
      }),
      JSON.stringify({
        relations: [
          { from: "张三", to: "ABC科技", relation: "founded", context: "张三创立了ABC科技" },
        ],
      }),
    ]);

    const engine = new NerEngine(llm);
    const result = await engine.extract("2024年张三创立了ABC科技");

    expect(result.events.length).toBe(1);
    expect(result.events[0].date).toBe("2024-01-01");
    expect(result.events[0].participants).toContain("张三");
  });

  test("returns empty result for empty text", async () => {
    const engine = new NerEngine(createMockLLM([]));
    const result = await engine.extract("");
    expect(result.entities).toEqual([]);
    expect(result.relations).toEqual([]);
    expect(result.events).toEqual([]);
  });

  test("returns empty result for whitespace-only text", async () => {
    const engine = new NerEngine(createMockLLM([]));
    const result = await engine.extract("   \n  \t  ");
    expect(result.entities).toEqual([]);
  });

  test("handles LLM response with markdown fences", async () => {
    const llm = createMockLLM([
      '```json\n{"entities":[{"name":"李四","type":"person","context":"李四是工程师"}],"events":[]}\n```',
      JSON.stringify({ relations: [] }),
    ]);
    const engine = new NerEngine(llm);
    const result = await engine.extract("李四是工程师");
    expect(result.entities.length).toBe(1);
    expect(result.entities[0].name).toBe("李四");
  });

  test("handles malformed LLM response gracefully", async () => {
    const llm = createMockLLM(["This is not JSON at all"]);
    const engine = new NerEngine(llm);
    const result = await engine.extract("一些文本内容");
    expect(result.entities).toEqual([]);
    expect(result.relations).toEqual([]);
    expect(result.events).toEqual([]);
  });

  test("handles partial LLM response with missing fields", async () => {
    const llm = createMockLLM([
      JSON.stringify({ entities: [{ name: "王五", type: "person" }] }),
      JSON.stringify({ relations: [] }),
    ]);
    const engine = new NerEngine(llm);
    const result = await engine.extract("王五是CEO");
    expect(result.entities.length).toBe(1);
    expect(result.relations).toEqual([]);
    expect(result.events).toEqual([]);
  });

  // ─── Text chunking ───────────────────────────────

  test("chunks long text and merges entities from all chunks", async () => {
    const longText = "第一段介绍张三。第二段提到李四。".repeat(200);
    const llm = createMockLLM([
      JSON.stringify({
        entities: [{ name: "张三", type: "person", relevance: "high", context: "第一段介绍张三" }],
        events: [],
      }),
      JSON.stringify({
        entities: [{ name: "李四", type: "person", relevance: "high", context: "第二段提到李四" }],
        events: [],
      }),
      JSON.stringify({
        relations: [{ from: "张三", to: "李四", relation: "认识", context: "张三认识李四" }],
      }),
    ]);

    const engine = new NerEngine(llm);
    const result = await engine.extract(longText);

    const names = result.entities.map(e => e.name);
    expect(names).toContain("张三");
    expect(names).toContain("李四");
    expect(result.relations.length).toBe(1);
  });

  test("deduplicates identical entities from multiple chunks", async () => {
    const longText = "张三在A公司工作。张三负责研发。".repeat(200);
    const llm = createMockLLM([
      JSON.stringify({
        entities: [{ name: "张三", type: "person", relevance: "high", context: "张三在A公司工作" }],
        events: [],
      }),
      JSON.stringify({
        entities: [{ name: "张三", type: "person", relevance: "high", context: "张三负责研发" }],
        events: [],
      }),
      JSON.stringify({ relations: [] }),
    ]);

    const engine = new NerEngine(llm);
    const result = await engine.extract(longText);

    expect(result.entities.length).toBe(1);
    expect(result.entities[0].name).toBe("张三");
  });

  test("deduplicates identical events from multiple chunks", async () => {
    const longText = "2024年张三创立了A公司。".repeat(200);
    const llm = createMockLLM([
      JSON.stringify({
        entities: [],
        events: [{ date: "2024-01-01", description: "张三创立了A公司", participants: ["张三"] }],
      }),
      JSON.stringify({
        entities: [],
        events: [{ date: "2024-01-01", description: "张三创立了A公司", participants: ["张三"] }],
      }),
    ]);

    const engine = new NerEngine(llm);
    const result = await engine.extract(longText);

    expect(result.events.length).toBe(1);
    expect(result.events[0].description).toBe("张三创立了A公司");
  });

  test("short text single chunk — no extra LLM calls", async () => {
    const llm = createMockLLM([
      JSON.stringify({
        entities: [{ name: "特斯拉", type: "company", relevance: "high", context: "特斯拉发布FSD" }],
        events: [],
      }),
      JSON.stringify({
        relations: [{ from: "特斯拉", to: "FSD", relation: "制造", context: "特斯拉发布FSD" }],
      }),
    ]);

    const engine = new NerEngine(llm);
    const result = await engine.extract("特斯拉发布了FSD");

    expect(result.entities.length).toBe(1);
    expect(result.entities[0].name).toBe("特斯拉");
  });

  // ─── Safety net (rules layer) ────────────────────

  test("safety net catches job titles via regex", async () => {
    const llm = createMockLLM([
      JSON.stringify({
        entities: [
          { name: "销售经理", type: "person", relevance: "medium", context: "销售经理说" },
          { name: "技术总监", type: "person", relevance: "medium", context: "技术总监负责" },
          { name: "张三", type: "person", relevance: "high", context: "张三是工程师" },
        ],
        events: [],
      }),
      JSON.stringify({ relations: [] }),
    ]);

    const engine = new NerEngine(llm);
    const result = await engine.extract("some text");
    const names = result.entities.map(e => e.name);

    expect(names).not.toContain("销售经理");
    expect(names).not.toContain("技术总监");
    expect(names).toContain("张三");
  });

  test("safety net keeps organizational keywords as entity", async () => {
    const llm = createMockLLM([
      JSON.stringify({
        entities: [
          { name: "星辰科技集团", type: "concept", relevance: "high", context: "星辰科技" },
          { name: "北京大学", type: "concept", relevance: "medium", context: "北京大学研究" },
        ],
        events: [],
      }),
      JSON.stringify({ relations: [] }),
    ]);

    const engine = new NerEngine(llm);
    const result = await engine.extract("some text");

    // Even though LLM said "concept", company/university suffix overrides class to entity
    expect(result.entities.every(e => (e as any).class === "entity")).toBe(true);
    expect(result.entities.map(e => e.name)).toContain("星辰科技集团");
    expect(result.entities.map(e => e.name)).toContain("北京大学");
  });

  // ─── LLM trust path ──────────────────────────────

  test("passes through valid 2-3 char Chinese entities", async () => {
    const llm = createMockLLM([
      JSON.stringify({
        entities: [
          { name: "特斯拉", type: "company", relevance: "high", context: "特斯拉发布FSD" },
          { name: "比亚迪", type: "company", relevance: "high", context: "比亚迪推出刀片电池" },
          { name: "王传福", type: "person", relevance: "high", context: "王传福是创始人" },
        ],
        events: [],
      }),
      JSON.stringify({
        relations: [{ from: "王传福", to: "比亚迪", relation: "founder", context: "王传福是创始人" }],
      }),
    ]);

    const engine = new NerEngine(llm);
    const result = await engine.extract("some text");
    const names = result.entities.map(e => e.name);

    expect(names).toContain("特斯拉");
    expect(names).toContain("比亚迪");
    expect(names).toContain("王传福");
    expect(result.relations.length).toBe(1);
  });

  test("keeps person/company/product types from LLM", async () => {
    const llm = createMockLLM([
      JSON.stringify({
        entities: [
          { name: "凌娅", type: "person", relevance: "medium", context: "凌娅参与了项目" },
          { name: "南京医药集团", type: "company", relevance: "medium", context: "南京医药集团是分销商" },
          { name: "Cosentyx", type: "product", relevance: "high", context: "Cosentyx是免疫药物" },
        ],
        events: [],
      }),
      JSON.stringify({ relations: [] }),
    ]);

    const engine = new NerEngine(llm);
    const result = await engine.extract("some text");
    const names = result.entities.map(e => e.name);

    expect(names).toContain("凌娅");
    expect(names).toContain("南京医药集团");
    expect(names).toContain("Cosentyx");
  });

  // ─── Limits ──────────────────────────────────────

  test("respects limits: max 8 entities + 3 concepts", async () => {
    const entities = Array.from({ length: 12 }, (_, i) => ({
      name: `Person${i}`, type: "person" as const, relevance: "high" as const, context: `Person${i} is here`,
    }));
    const concepts = Array.from({ length: 6 }, (_, i) => ({
      name: `Theory${i}`, type: "concept" as const, relevance: "high" as const, context: `Theory${i} is known`,
    }));

    const llm = createMockLLM([
      JSON.stringify({ entities: [...entities, ...concepts], events: [] }),
      JSON.stringify({ relations: [] }),
    ]);

    const engine = new NerEngine(llm);
    const result = await engine.extract("some text");

    const entityCount = result.entities.filter((e) => e.type !== "concept").length;
    const conceptCount = result.entities.filter((e) => e.type === "concept").length;
    expect(entityCount).toBeLessThanOrEqual(10);
    expect(conceptCount).toBeLessThanOrEqual(8);
    expect(result.entities.length).toBeLessThanOrEqual(18);
  });

  // ─── Structured Facts ───────────────────────────

  test("extracts structured facts from LLM response", async () => {
    const llm = createMockLLM([
      JSON.stringify({
        entities: [
          { name: "张三", type: "person", relevance: "high", context: "张三是上海人，1985年出生" },
        ],
        events: [],
        facts: [
          { entity: "张三", field: "birthplace", value: "上海", confidence: 0.9, evidence: "张三是上海人" },
          { entity: "张三", field: "birthday", value: "1985", confidence: 0.8, evidence: "1985年出生" },
        ],
      }),
      JSON.stringify({ relations: [] }),
    ]);

    const engine = new NerEngine(llm);
    const result = await engine.extract("张三是上海人，1985年出生");

    expect(result.facts).toHaveLength(2);
    expect(result.facts[0].field).toBe("birthplace");
    expect(result.facts[0].value).toBe("上海");
    expect(result.facts[1].field).toBe("birthday");
  });

  test("filters facts missing required fields", async () => {
    const llm = createMockLLM([
      JSON.stringify({
        entities: [{ name: "张三", type: "person", relevance: "high", context: "张三" }],
        events: [],
        facts: [
          { entity: "张三", field: "birthday", value: "1985", confidence: 0.9 },
          { entity: "张三", field: "birthplace", value: "", confidence: 0.8, evidence: "上海人" },
        ],
      }),
      JSON.stringify({ relations: [] }),
    ]);

    const engine = new NerEngine(llm);
    const result = await engine.extract("张三");

    expect(result.facts).toHaveLength(0);
  });

  test("returns empty facts array for empty text", async () => {
    const engine = new NerEngine(createMockLLM([]));
    const result = await engine.extract("");
    expect(result.facts).toEqual([]);
  });

  test("deduplicates facts across chunks keeping highest confidence", async () => {
    const longText = "张三是上海人。张三来自上海。".repeat(200);
    const llm = createMockLLM([
      JSON.stringify({
        entities: [{ name: "张三", type: "person", relevance: "high", context: "张三" }],
        events: [],
        facts: [
          { entity: "张三", field: "birthplace", value: "上海", confidence: 0.7, evidence: "张三是上海人" },
        ],
      }),
      JSON.stringify({
        entities: [{ name: "张三", type: "person", relevance: "high", context: "张三" }],
        events: [],
        facts: [
          { entity: "张三", field: "birthplace", value: "上海", confidence: 0.9, evidence: "张三来自上海" },
        ],
      }),
      JSON.stringify({ relations: [] }),
    ]);

    const engine = new NerEngine(llm);
    const result = await engine.extract(longText);

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].confidence).toBe(0.9);
  });
});

describe("NerEngine extract timeout (#229)", () => {
  // never-resolving chat stands in for a hung/slow LLM without holding a timer
  const neverResolveLlm: LLMProvider = {
    name: "slow",
    chat: async () => new Promise<string>(() => { /* never resolves */ }),
  };
  const emptyJsonLlm: LLMProvider = {
    name: "empty",
    chat: async () => '{"entities":[],"relations":[],"events":[],"facts":[]}',
  };

  test("slow chat is rejected with NerTimeoutError", async () => {
    const engine = new NerEngine(neverResolveLlm);
    await expect(engine.extract("一段需要 NER 的中文正文", 100)).rejects.toBeInstanceOf(NerTimeoutError);
  });

  test("isNerTimeoutError identifies timeout vs normal error", async () => {
    const engine = new NerEngine(neverResolveLlm);
    let caught: unknown;
    try {
      await engine.extract("中文正文", 100);
    } catch (e) {
      caught = e;
    }
    expect(isNerTimeoutError(caught)).toBe(true);
    expect(isNerTimeoutError(new Error("ordinary"))).toBe(false);
  });

  test("fast NER returns normally within timeout (behavior unchanged)", async () => {
    const engine = new NerEngine(emptyJsonLlm);
    const result = await engine.extract("中文正文", 60_000);
    expect(result.entities).toEqual([]);
    expect(result.relations).toEqual([]);
  });

  test("empty text short-circuits before timeout", async () => {
    const engine = new NerEngine(neverResolveLlm);
    const result = await engine.extract("   ", 100);
    expect(result.entities).toEqual([]);
  });
});

describe("processNer propagates extract timeout, no DB writes (#229)", () => {
  const testDir = "/tmp/cbrain-test-ner-timeout-pipe";
  const dbPath = join(testDir, "t.sqlite");
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

  class FastTimeoutNer extends NerEngine {
    async extract(text: string) {
      return super.extract(text, 100);
    }
  }
  const neverResolveLlm: LLMProvider = {
    name: "slow",
    chat: async () => new Promise<string>(() => { /* never resolves */ }),
  };
  const stubEmbedding = {
    embedBatch: async (t: string[]) => t.map(() => ({ embedding: [0, 0], tokenCount: 1 })),
    embedQuery: async () => ({ embedding: [0, 0], tokenCount: 1 }),
  } as any;
  const stubLance = {
    deleteRawChunksByPageSlug: async () => {},
    deleteL1VectorByPageSlug: async () => {},
    addChunks: async () => {},
  } as any;

  test("processNer rejects with NerTimeoutError and writes no NER rows", async () => {
    const pipeline = new ContentPipeline(db, stubEmbedding, stubLance, {
      nerEngine: new FastTimeoutNer(neverResolveLlm),
    });

    await expect(
      pipeline.processNer("records/x", "中文正文用于触发NER", "record", true, undefined, new Set()),
    ).rejects.toBeInstanceOf(NerTimeoutError);

    // applyExtraction never ran → no ner-source links, no auto-extracted stubs
    const nerLinks = (db.rawDb.prepare("SELECT COUNT(*) as c FROM links WHERE source_type = 'ner'").get() as { c: number }).c;
    const autoStubs = db.getAutoExtractedPages().length;
    expect(nerLinks).toBe(0);
    expect(autoStubs).toBe(0);
  });
});
