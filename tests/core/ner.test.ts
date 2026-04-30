import { describe, test, expect } from "bun:test";
import { NerEngine } from "../../src/core/ner.js";
import type { LLMProvider } from "../../src/llm/provider.js";

function createMockLLM(responses: string[]): LLMProvider {
  let callIndex = 0;
  return {
    name: "mock",
    chat: async () => responses[callIndex++] ?? '{"entities":[],"relations":[],"events":[]}',
  };
}

describe("NerEngine", () => {
  test("extracts entities from LLM response", async () => {
    const llm = createMockLLM([
      JSON.stringify({
        entities: [
          { name: "张三", type: "person", context: "张三是诺华制药的商务经理" },
          { name: "诺华制药", type: "company", context: "张三是诺华制药的商务经理" },
        ],
        relations: [
          { from: "张三", to: "诺华制药", relation: "works_at", context: "张三是诺华制药的商务经理" },
        ],
        events: [],
      }),
    ]);

    const engine = new NerEngine(llm);
    const result = await engine.extract("张三是诺华制药的商务经理");

    expect(result.entities.length).toBe(2);
    expect(result.entities[0].name).toBe("张三");
    expect(result.entities[0].type).toBe("person");
    expect(result.entities[1].name).toBe("诺华制药");
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
        relations: [
          { from: "张三", to: "ABC科技", relation: "founded", context: "张三创立了ABC科技" },
        ],
        events: [
          { date: "2024-01-01", description: "张三创立了ABC科技", participants: ["张三", "ABC科技"] },
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
    const llm = createMockLLM([]);
    const engine = new NerEngine(llm);

    const result = await engine.extract("");
    expect(result.entities).toEqual([]);
    expect(result.relations).toEqual([]);
    expect(result.events).toEqual([]);
  });

  test("returns empty result for whitespace-only text", async () => {
    const llm = createMockLLM([]);
    const engine = new NerEngine(llm);

    const result = await engine.extract("   \n  \t  ");
    expect(result.entities).toEqual([]);
  });

  test("handles LLM response with markdown fences", async () => {
    const llm = createMockLLM([
      '```json\n{"entities":[{"name":"李四","type":"person","context":"李四是工程师"}],"relations":[],"events":[]}\n```',
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
    ]);

    const engine = new NerEngine(llm);
    const result = await engine.extract("王五是CEO");

    expect(result.entities.length).toBe(1);
    expect(result.relations).toEqual([]);
    expect(result.events).toEqual([]);
  });

  test("truncates long text to ~3000 chars", async () => {
    const longText = "这是一段很长的文本。".repeat(500); // ~4500 chars
    const llm = createMockLLM([
      JSON.stringify({ entities: [], relations: [], events: [] }),
    ]);

    const engine = new NerEngine(llm);
    const result = await engine.extract(longText);

    // Should not throw — just return empty result
    expect(result.entities).toEqual([]);
  });

  // ─── New filter tests ────────────────────────────────────

  test("filters out generic concept names", async () => {
    const llm = createMockLLM([
      JSON.stringify({
        entities: [
          { name: "深度思考", type: "concept", relevance: "high", context: "需要深度思考" },
          { name: "注意力管理", type: "concept", relevance: "medium", context: "注意力管理很重要" },
          { name: "时间管理", type: "concept", relevance: "high", context: "做好时间管理" },
          { name: "奥卡姆剃刀", type: "concept", relevance: "high", context: "奥卡姆剃刀原理" },
        ],
        relations: [],
        events: [],
      }),
    ]);

    const engine = new NerEngine(llm);
    const result = await engine.extract("some text");
    const names = result.entities.map((e) => e.name);

    expect(names).not.toContain("深度思考");
    expect(names).not.toContain("注意力管理");
    expect(names).not.toContain("时间管理");
    expect(names).toContain("奥卡姆剃刀");
  });

  test("filters out daily items and generic nouns", async () => {
    const llm = createMockLLM([
      JSON.stringify({
        entities: [
          { name: "柠檬汁", type: "product", relevance: "medium", context: "喝了一杯柠檬汁" },
          { name: "保险丝", type: "product", relevance: "medium", context: "换了个保险丝" },
          { name: "邮件", type: "concept", relevance: "medium", context: "发了一封邮件" },
          { name: "咖啡", type: "product", relevance: "low", context: "喝咖啡" },
          { name: "张三", type: "person", relevance: "high", context: "张三是工程师" },
        ],
        relations: [],
        events: [],
      }),
    ]);

    const engine = new NerEngine(llm);
    const result = await engine.extract("some text");
    const names = result.entities.map((e) => e.name);

    expect(names).not.toContain("柠檬汁");
    expect(names).not.toContain("保险丝");
    expect(names).not.toContain("邮件");
    expect(names).not.toContain("咖啡");
    expect(names).toContain("张三");
  });

  test("filters out job titles and departments", async () => {
    const llm = createMockLLM([
      JSON.stringify({
        entities: [
          { name: "销售经理", type: "person", relevance: "medium", context: "销售经理说" },
          { name: "品牌团队", type: "concept", relevance: "medium", context: "品牌团队负责" },
          { name: "财务部门", type: "concept", relevance: "low", context: "财务部门审批" },
          { name: "市场营销人员", type: "person", relevance: "low", context: "市场营销人员需要" },
        ],
        relations: [],
        events: [],
      }),
    ]);

    const engine = new NerEngine(llm);
    const result = await engine.extract("some text");

    expect(result.entities.length).toBe(0);
  });

  test("keeps person/company/product types regardless of obscurity", async () => {
    const llm = createMockLLM([
      JSON.stringify({
        entities: [
          { name: "凌娅", type: "person", relevance: "medium", context: "凌娅参与了项目" },
          { name: "南京医药集团", type: "company", relevance: "medium", context: "南京医药集团是分销商" },
          { name: "Cosentyx", type: "product", relevance: "high", context: "Cosentyx是免疫药物" },
        ],
        relations: [],
        events: [],
      }),
    ]);

    const engine = new NerEngine(llm);
    const result = await engine.extract("some text");
    const names = result.entities.map((e) => e.name);

    expect(names).toContain("凌娅");
    expect(names).toContain("南京医药集团");
    expect(names).toContain("Cosentyx");
  });

  test("respects new limits: max 8 entities + 3 concepts", async () => {
    const entities = Array.from({ length: 12 }, (_, i) => ({
      name: `Person${i}`, type: "person" as const, relevance: "high" as const, context: `Person${i} is here`,
    }));
    const concepts = Array.from({ length: 6 }, (_, i) => ({
      name: `Theory${i}`, type: "concept" as const, relevance: "high" as const, context: `Theory${i} is known`,
    }));

    const llm = createMockLLM([
      JSON.stringify({ entities: [...entities, ...concepts], relations: [], events: [] }),
    ]);

    const engine = new NerEngine(llm);
    const result = await engine.extract("some text");

    const entityCount = result.entities.filter((e) => e.type !== "concept").length;
    const conceptCount = result.entities.filter((e) => e.type === "concept").length;
    expect(entityCount).toBeLessThanOrEqual(8);
    expect(conceptCount).toBeLessThanOrEqual(3);
    expect(result.entities.length).toBeLessThanOrEqual(11);
  });
});
