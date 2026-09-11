import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { GraphManager } from "../../src/core/graph/graph.js";
import { registerFrontdoorTools } from "../../src/mcp/tools/frontdoor.js";

for (const mode of ["legacy", "structured"] as const) describe(`explicit relationship ${mode} (#482)`, () => {
  let db: CBrainDB;
  let calls: { model: number; search: number };
  let recall: (args: { query: string; include_raw: boolean }) => Promise<any>;
  beforeEach(() => {
    db = new CBrainDB(":memory:");
    calls = { model: 0, search: 0 };
    for (const [slug, title] of [["entities/a", "实体A"], ["entities/b", "实体B"], ["entities/c", "实体C"]]) {
      db.upsertPage({ slug: slug!, title: title!, type: "entity/person", filePath: `${slug}.md`, contentHash: "anonymous" });
    }
    registerFrontdoorTools({ registerTool(_name: string, _schema: unknown, handler: typeof recall) { recall = handler; } } as never, {
      db, outputMode: mode, graph: new GraphManager(db), pages: { getBySlug: () => null },
      search: { search: async () => { calls.search++; return []; } },
      llm: { chat: async () => { calls.model++; return "{}"; } },
    } as never);
  });
  afterEach(() => db.close());
  function link(from: string, to: string, trust = "trusted") {
    db.rawDb.prepare("INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, evidence, source_page_slug) VALUES (?, ?, 'knows', 'manual', ?, '匿名来源摘录', 'entities/c')").run(from, to, trust);
  }
  async function ask(query: string) {
    const response = await recall({ query, include_raw: true });
    const value = mode === "legacy" ? JSON.parse(response.content[0].text) : response.structuredContent;
    return { value, answer: mode === "legacy" ? value.display : value.data.answer, raw: mode === "legacy" ? value.raw : value.audit?.raw };
  }
  for (const query of ["实体A和实体B是什么关系？", "实体A与实体B有什么联系", "what is the relationship between entities/a and entities/b?", "how are entities/a and entities/b related?", "how is entities/a connected to entities/b?"]) {
    test(`local path: ${query}`, async () => {
      link("entities/b", "entities/a");
      const { value, answer, raw } = await ask(query);
      const result = mode === "legacy" ? raw.result : value.data.details.result;
      expect(result.answer_context[mode === "legacy" ? "topClaims" : "top_claims"][0]).toContain("实体A");
      expect(answer).toContain("实体A");
      expect(answer).toContain("←");
      expect(calls).toEqual({ model: 0, search: 0 });
      if (mode === "legacy") {
        expect(raw.routing.next_tool).toBe("graph_query");
        expect(raw.path.edges[0].evidence).toBe("匿名来源摘录");
      }
    });
  }
  test("exact alias and same entity", async () => {
    db.addAlias("entities/a", "别名甲");
    expect((await ask("别名甲和实体A是什么关系")).answer).toContain("同一条目");
    expect(calls).toEqual({ model: 0, search: 0 });
  });
  test("candidate remains pending", async () => {
    link("entities/a", "entities/b", "candidate");
    expect((await ask("实体A和实体B是什么关系")).answer).toContain("待确认");
    expect(calls).toEqual({ model: 0, search: 0 });
  });
  for (const trust of ["rejected", "superseded", "absent"]) test(`${trust} is not a connection`, async () => {
    if (trust !== "absent") link("entities/a", "entities/b", trust);
    const { value, answer } = await ask("实体A和实体B是什么关系");
    expect(value.summary.status).toBe("empty");
    expect(answer).toContain("4 跳范围");
    expect(calls).toEqual({ model: 0, search: 0 });
  });
  test("missing and ambiguous names do not select fuzzy or first alias", async () => {
    db.addAlias("entities/a", "同名");
    db.addAlias("entities/c", "同名");
    for (const name of ["实体", "不存在", "同名"]) {
      expect((await ask(`${name}和实体B是什么关系`)).value.summary.status).not.toBe("ok");
    }
    expect(calls).toEqual({ model: 0, search: 0 });
  });
  test("path depth stays bounded", async () => {
    let previous = "entities/a";
    for (let i = 0; i < 4; i++) {
      const slug = `entities/intermediate-${i}`;
      db.upsertPage({ slug, title: `中间实体${i}`, type: "entity/person", filePath: `${slug}.md`, contentHash: "anonymous" });
      link(previous, slug); previous = slug;
    }
    link(previous, "entities/b");
    expect((await ask("实体A和实体B是什么关系")).value.summary.status).toBe("empty");
    expect(calls).toEqual({ model: 0, search: 0 });
  });
  for (const query of ["分析实体A和实体B是什么关系，以及关系变化的原因", "what is the relationship between entities/a and entities/b, and how has it changed?", "how are entities/a and entities/b related, and why are they connected?", "实体A和实体B和实体C是什么关系？"]) test(`complex analysis retains research: ${query}`, async () => {
    await ask(query);
    expect(calls.model).toBe(1);
  });
});
