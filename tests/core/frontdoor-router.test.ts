import { describe, expect, test } from "bun:test";
import { classifyFrontdoorQuery } from "../../src/core/retrieval/frontdoor-router.js";

describe("classifyFrontdoorQuery", () => {
  const cases = [
    ["主题A之前讨论过吗", "grounded_recall", "deep_recall"],
    ["之前项目E当时怎么设计的，为什么选这个方向", "content_recall", "deep_recall"],
    ["想不起名字了，去年活动上见过的那个人是谁", "episodic_recall", "recall_episode"],
    ["实体A的下属和汇报线是什么", "hierarchy", "get_org_tree"],
    ["帮我总结一下主题D的全貌", "overview", "summarize"],
    ["实体A和实体B是什么关系", "relationship", "agentic_research"],
    ["帮我判断这个方案有没有盲区", "reasoning", "agentic_research"],
    ["debug 一下关键词主题C在哪些页面出现", "debug_search", "query"],
  ] as const;

  for (const [query, route, tool] of cases) {
    test(`${query} -> ${route}`, () => {
      const decision = classifyFrontdoorQuery(query);
      expect(decision.chosen_route).toBe(route);
      expect(decision.next_tool).toBe(tool);
      expect(decision.confidence).toBeGreaterThan(0);
      expect(decision.matched_signals.length).toBeGreaterThan(0);
      expect(decision.rejected_routes).not.toContain(route);
    });
  }

  test("ordinary natural-language recall does not route to query", () => {
    const decision = classifyFrontdoorQuery("搜一下有没有关于主题C的记录");
    expect(decision.chosen_route).toBe("content_recall");
    expect(decision.next_tool).toBe("deep_recall");
  });

  // ── #255 over-routing: bare 比较 (adverb) must NOT escalate ──
  test("比较 + adjective (adverb) does NOT route to reasoning/comparison", () => {
    for (const q of ["比较重要的主题A", "实体A和实体B都比较重要", "比较类似的主题"]) {
      const decision = classifyFrontdoorQuery(q);
      expect(decision.chosen_route, `${q} must not be reasoning`).not.toBe("reasoning");
    }
  });

  // ── #255 bilingual positive signals ──
  test("English relationship → relationship route", () => {
    const d = classifyFrontdoorQuery("how is 实体A connected to 实体B");
    expect(d.chosen_route).toBe("relationship");
  });
  test("English hierarchy → hierarchy route", () => {
    for (const q of ["实体A reports to 实体B", "org chart for 实体A"]) {
      const d = classifyFrontdoorQuery(q);
      expect(d.chosen_route, `${q}`).toBe("hierarchy");
    }
  });
  test("English overview → overview route", () => {
    for (const q of ["walk me through 实体A", "overview of 实体A"]) {
      const d = classifyFrontdoorQuery(q);
      expect(d.chosen_route, `${q}`).toBe("overview");
    }
  });
  test("English comparison strong → reasoning route", () => {
    const d = classifyFrontdoorQuery("compare 实体A and 实体B, what's the difference");
    expect(d.chosen_route).toBe("reasoning");
  });

  // ── #255 frontdoor: X vs Y → reasoning (any entities, not literal A/B) ──
  test("实体A vs 实体B → reasoning route", () => {
    const d = classifyFrontdoorQuery("实体A vs 实体B");
    expect(d.chosen_route).toBe("reasoning");
  });

  // ── #255 frontdoor: explicit debug/search terms → debug_search ──
  test("raw search / keyword search → debug_search route", () => {
    for (const q of ["raw search 实体A", "keyword search 实体A"]) {
      const d = classifyFrontdoorQuery(q);
      expect(d.chosen_route, `${q}`).toBe("debug_search");
    }
  });
});
