import { describe, test, expect, mock } from "bun:test";
import { NerEngine } from "../../src/core/ingestion/ner.js";
import type { LLMProvider, ChatMessage } from "../../src/llm/provider.js";

function createMockLLM(responses: string[]): LLMProvider & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  let idx = 0;
  return {
    name: "mock",
    calls,
    chat: mock(async (messages: ChatMessage[]) => {
      calls.push(messages);
      const resp = responses[idx++] ?? '{"entities":[],"events":[]}';
      return resp;
    }),
  };
}

describe("NerEngine parallelization", () => {
  test("empty text returns empty result", async () => {
    const llm = createMockLLM([]);
    const ner = new NerEngine(llm);
    const result = await ner.extract("");
    expect(result.entities).toEqual([]);
    expect(result.relations).toEqual([]);
    expect(result.events).toEqual([]);
    expect(llm.calls.length).toBe(0);
  });

  test("whitespace-only text returns empty result", async () => {
    const llm = createMockLLM([]);
    const ner = new NerEngine(llm);
    const result = await ner.extract("   \n\t  ");
    expect(result.entities).toEqual([]);
    expect(llm.calls.length).toBe(0);
  });

  test("short text uses single LLM call (no Promise.all)", async () => {
    const llm = createMockLLM([
      '{"entities":[{"name":"马斯克","type":"person","relevance":"high","context":"马斯克是特斯拉CEO"}],"events":[]}',
      '{"relations":[]}',
    ]);
    const ner = new NerEngine(llm);

    // Text under 2500 chars — single chunk path
    const shortText = "马斯克是特斯拉CEO，他创办了SpaceX。";
    const result = await ner.extract(shortText);

    // Stage 1: 1 entity call, Stage 2: 1 relation call = 2 total
    expect(llm.calls.length).toBe(2);
    expect(result.entities.length).toBe(1);
    expect(result.entities[0].name).toBe("马斯克");
  });

  test("long text uses multiple parallel calls", async () => {
    // Create text > 2500 chars to force multi-chunk
    const sentence = "特斯拉是一家电动汽车公司，由马斯克于2003年创立。该公司生产Model S和Model 3等车型。";
    // Each sentence ~40 chars, splitting at 。 gives ~2 segments per repeat
    // 100 repeats * ~80 chars = ~8000 chars → multiple chunks
    const longText = sentence.repeat(100);

    const entityResponse = '{"entities":[{"name":"特斯拉","type":"company","relevance":"high","context":"特斯拉是电动汽车公司"}],"events":[]}';
    const relationResponse = '{"relations":[]}';

    // Estimate chunks: ~8000 chars / 2500 per chunk = ~4 chunks, + 1 relation call
    const llm = createMockLLM([
      entityResponse, entityResponse, entityResponse, entityResponse, entityResponse,
      relationResponse,
    ]);
    const ner = new NerEngine(llm);

    await ner.extract(longText);

    // Should have multiple stage-1 calls (one per chunk) + 1 stage-2 call
    expect(llm.calls.length).toBeGreaterThanOrEqual(3);
    // First N calls should have ENTITY_GUIDELINE as system prompt
    const entityCalls = llm.calls.filter(c => c[0]?.content?.includes("precision entity extractor"));
    expect(entityCalls.length).toBeGreaterThanOrEqual(2);
    // Last call should be relation extraction
    const relationCalls = llm.calls.filter(c => c[0]?.content?.includes("relation extractor"));
    expect(relationCalls.length).toBe(1);
  });

  test("filtered entities are passed to relation extraction", async () => {
    const llm = createMockLLM([
      '{"entities":[{"name":"马斯克","type":"person","relevance":"high","context":"马斯克是CEO"},{"name":"特斯拉","type":"company","relevance":"high","context":"特斯拉是公司"}],"events":[]}',
      '{"relations":[{"from":"马斯克","to":"特斯拉","relation":"任职","context":"马斯克是特斯拉CEO"}]}',
    ]);
    const ner = new NerEngine(llm);

    const result = await ner.extract("马斯克是特斯拉CEO");

    expect(result.entities.length).toBe(2);
    expect(result.relations.length).toBe(1);
    expect(result.relations[0].from).toBe("马斯克");
    expect(result.relations[0].to).toBe("特斯拉");
    expect(result.relations[0].relation).toBe("任职");
  });

  test("generic terms are filtered out", async () => {
    const llm = createMockLLM([
      '{"entities":[{"name":"人工智能","type":"concept","relevance":"high","context":"人工智能"},{"name":"公司","type":"company","relevance":"medium","context":"公司"},{"name":"创新","type":"concept","relevance":"low","context":"创新"}],"events":[]}',
      '{"relations":[]}',
    ]);
    const ner = new NerEngine(llm);

    const result = await ner.extract("人工智能相关的内容");

    // "人工智能", "公司", "创新" should all be filtered by classifyEntity
    expect(result.entities.length).toBe(0);
  });

  test("relation with invalid entity name is dropped", async () => {
    const llm = createMockLLM([
      '{"entities":[{"name":"马斯克","type":"person","relevance":"high","context":"马斯克"}],"events":[]}',
      '{"relations":[{"from":"马斯克","to":"不存在的实体","relation":"认识","context":"xxx"}]}',
    ]);
    const ner = new NerEngine(llm);

    const result = await ner.extract("马斯克的故事");

    expect(result.relations.length).toBe(0);
  });

  test("malformed JSON returns empty result gracefully", async () => {
    const llm = createMockLLM([
      'not valid json at all',
      '{"relations":[]}',
    ]);
    const ner = new NerEngine(llm);

    const result = await ner.extract("一些文本内容");
    expect(result.entities).toEqual([]);
    expect(result.relations).toEqual([]);
  });
});

describe("classifyEntity suffix filtering", () => {
  test("blocks XX化 suffix entities", async () => {
    const llm = createMockLLM([
      '{"entities":[{"name":"数字化转型","type":"concept","relevance":"high","context":"讨论了数字化转型"},{"name":"特斯拉","type":"company","relevance":"high","context":"特斯拉是电动车公司"}],"events":[]}',
      '{"relations":[]}',
    ]);
    const ner = new NerEngine(llm);
    const result = await ner.extract("讨论了数字化转型，特斯拉是电动车公司。");
    expect(result.entities.map(e => e.name)).not.toContain("数字化转型");
    expect(result.entities.map(e => e.name)).toContain("特斯拉");
  });

  test("blocks XX模式 suffix", async () => {
    const llm = createMockLLM([
      '{"entities":[{"name":"商业模式","type":"concept","relevance":"medium","context":"讨论商业模式"},{"name":"马斯克","type":"person","relevance":"high","context":"马斯克发言"}],"events":[]}',
      '{"relations":[]}',
    ]);
    const ner = new NerEngine(llm);
    const result = await ner.extract("讨论商业模式，马斯克发言。");
    expect(result.entities.map(e => e.name)).not.toContain("商业模式");
    expect(result.entities.map(e => e.name)).toContain("马斯克");
  });

  test("preserves company even if name ends with bank suffix", async () => {
    const llm = createMockLLM([
      '{"entities":[{"name":"招商银行","type":"company","relevance":"high","context":"招商银行是股份制银行"}],"events":[]}',
      '{"relations":[]}',
    ]);
    const ner = new NerEngine(llm);
    const result = await ner.extract("招商银行是股份制银行。");
    expect(result.entities.map(e => e.name)).toContain("招商银行");
  });

  test("blocks AI generic terms", async () => {
    const llm = createMockLLM([
      '{"entities":[{"name":"AI","type":"concept","relevance":"medium","context":"讨论AI技术"},{"name":"AI工具","type":"product","relevance":"low","context":"使用AI工具"},{"name":"Claude","type":"product","relevance":"high","context":"Claude是AI助手"}],"events":[]}',
      '{"relations":[]}',
    ]);
    const ner = new NerEngine(llm);
    const result = await ner.extract("讨论AI技术，使用AI工具，Claude是AI助手。");
    expect(result.entities.map(e => e.name)).not.toContain("AI");
    expect(result.entities.map(e => e.name)).not.toContain("AI工具");
    expect(result.entities.map(e => e.name)).toContain("Claude");
  });
});

describe("filterEntities FilterResult", () => {
  test("extraction result includes filtered entities with reasons", async () => {
    const llm = createMockLLM([
      '{"entities":[{"name":"AI","type":"concept","relevance":"medium","context":"讨论AI"},{"name":"马斯克","type":"person","relevance":"high","context":"马斯克是CEO"},{"name":"数字化转型","type":"concept","relevance":"medium","context":"数字化转型很重要"}],"events":[]}',
      '{"relations":[]}',
    ]);
    const ner = new NerEngine(llm);
    const result = await ner.extract("讨论AI，马斯克是CEO，数字化转型很重要。");
    expect(result.entities.map(e => e.name)).toEqual(["马斯克"]);
    expect(result.filtered.length).toBe(2);
    const filteredNames = result.filtered.map(f => f.name);
    expect(filteredNames).toContain("AI");
    expect(filteredNames).toContain("数字化转型");
  });
});
