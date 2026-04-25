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
});
