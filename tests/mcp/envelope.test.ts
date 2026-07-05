/**
 * MCP Response Envelope Tests — #137
 *
 * Structural invariant tests for the display/summary/raw envelope
 * on 8 high-frequency tools. Each formatter must return:
 *   display: string (no internal identifiers)
 *   summary: ToolSummary (status, count, truncated, message)
 *   raw: original complete payload
 */
import { describe, test, expect } from "bun:test";
import {
  formatRecallEnvelope,
  formatGroundedRecallEnvelope,
  formatQueryEnvelope,
  formatGetPageEnvelope,
  formatSummarizeEnvelope,
  formatEpisodeEnvelope,
  formatOrgTreeEnvelope,
  formatDiscoveriesEnvelope,
  formatGetPagesEnvelope,
  toolEnvelope,
  sanitizeDisplay,
  DISPLAY_BANNED_TERMS,
  DISPLAY_BANNED_TERM_RULES,
  type ToolSummary,
} from "../../src/mcp/tools/format-result.js";
import type { EpisodicRecallResult } from "../../src/core/retrieval/episodic-recall.js";
import type { OrgTreeResult } from "../../src/core/graph/hierarchy.js";

// ─── Shared ────────────────────────────────────────────────────

// Test-only extras (structural internals not expected in display text)
const TEST_ONLY_BANNED = ["slug", "chunk", "source", "tier", "fts", "diagnostics", "节点", "lancedb", "candidate"];
const BANNED_INTERNAL = [...DISPLAY_BANNED_TERMS, ...TEST_ONLY_BANNED];

function assertNoInternalTerms(text: string): void {
  const lower = text.toLowerCase();
  for (const term of BANNED_INTERNAL) {
    expect(
      lower.includes(term.toLowerCase()),
      `display contains banned internal term "${term}"`,
    ).toBe(false);
  }
}

function assertValidSummary(summary: ToolSummary): void {
  expect(["ok", "empty", "degraded", "error"]).toContain(summary.status);
  expect(typeof summary.count).toBe("number");
  expect(typeof summary.truncated).toBe("boolean");
  expect(typeof summary.message).toBe("string");
  expect(summary.message.length).toBeGreaterThan(0);
  // summary.message is user-facing — no internal terms
  assertNoInternalTerms(summary.message);
  if (summary.degraded_reason != null) {
    expect(typeof summary.degraded_reason).toBe("string");
  }
  if (summary.next_steps != null) {
    expect(Array.isArray(summary.next_steps)).toBe(true);
  }
}

function assertHasRaw(result: { raw: unknown }, payload: object): void {
  expect(result).toHaveProperty("raw");
  expect(result.raw).toBeDefined();
  // raw preserves all original payload fields
  for (const key of Object.keys(payload)) {
    expect(result.raw).toHaveProperty(key);
  }
}

describe("toolEnvelope helper (#284)", () => {
  test("builds display/summary/raw envelope and preserves raw object identity", () => {
    const raw = { marker: "匿名原始数据", extra: { nested: true } };
    const summary: ToolSummary = {
      status: "degraded",
      count: 2,
      truncated: false,
      message: "匿名摘要",
      degraded_reason: "匿名原因",
      next_steps: ["匿名下一步"],
    };

    const envelope = toolEnvelope(raw, "匿名展示", summary);

    expect(envelope.display).toBe("匿名展示");
    expect(envelope.summary).toEqual(summary);
    expect(envelope.raw).toBe(raw);
  });
});

// ─── deep_recall ─────────────────────────────────────────────

describe("formatRecallEnvelope", () => {
  test("empty results returns raw with original payload", () => {
    const payload = { query: "测试", entities: [], summary: "未找到相关实体" };
    const result = formatRecallEnvelope(payload);
    assertHasRaw(result, payload);
    expect(result.raw.summary).toBe("未找到相关实体");
    assertNoInternalTerms(result.display);
    assertValidSummary(result.summary);
    expect(result.summary.status).toBe("empty");
    expect(result.summary.count).toBe(0);
  });

  test("normal results with entity titles", () => {
    const payload = {
      query: "人物A",
      entities: [
        { title: "人物A" },
        { title: "人物B", _stub: true },
      ],
      summary: "找到 2 个实体",
      search_meta: { degraded: false },
    };
    const result = formatRecallEnvelope(payload);
    expect(result.display).toContain("2 条相关记忆");
    expect(result.display).toContain("人物A");
    assertNoInternalTerms(result.display);
    assertValidSummary(result.summary);
    assertHasRaw(result, payload);
    expect(result.summary.status).toBe("ok");
    expect(result.summary.count).toBe(2);
    expect(result.summary.truncated).toBe(true);
    expect(result.raw.entities).toEqual(payload.entities);
  });

  test("degraded results", () => {
    const payload = {
      query: "复杂查询",
      entities: [{ title: "实体A" }],
      search_meta: { degraded: true },
    };
    const result = formatRecallEnvelope(payload);
    expect(result.display).toContain("先返回");
    assertNoInternalTerms(result.display);
    assertValidSummary(result.summary);
    assertHasRaw(result, payload);
    expect(result.summary.status).toBe("degraded");
    expect(result.summary.degraded_reason).toBeDefined();
  });
});

// ─── grounded recall ─────────────────────────────────────────

describe("formatGroundedRecallEnvelope", () => {
  test("empty evidence board — status is empty", () => {
    const payload = {
      query: "测试",
      grounded_answer: { facts: [], candidates: [], gaps: [], conflicts: [] },
      search_meta: { latency_ms: 100 },
    };
    const result = formatGroundedRecallEnvelope(payload);
    expect(result.display).toContain("关于");
    assertNoInternalTerms(result.display);
    assertValidSummary(result.summary);
    assertHasRaw(result, payload);
    expect(result.summary.status).toBe("empty");
  });

  test("with facts and candidates — status is ok, NOT empty", () => {
    const payload = {
      query: "设计方案",
      grounded_answer: {
        facts: [{ claim: "fact1" }, { claim: "fact2" }],
        candidates: [{ claim: "cand1" }],
        gaps: [],
        conflicts: [],
      },
      search_meta: { latency_ms: 200 },
    };
    const result = formatGroundedRecallEnvelope(payload);
    expect(result.display).toContain("2 条依据");
    expect(result.display).toContain("1 条线索");
    assertNoInternalTerms(result.display);
    assertValidSummary(result.summary);
    assertHasRaw(result, payload);
    // KEY: grounded with facts must NOT be status "empty"
    expect(result.summary.status).toBe("ok");
    expect(result.summary.count).toBe(3); // 2 facts + 1 candidate
  });

  test("conflict-only — status is ok, NOT empty", () => {
    const payload = {
      query: "设计矛盾",
      grounded_answer: {
        facts: [],
        candidates: [],
        gaps: [],
        conflicts: [{ claim: "方案A与方案B矛盾" }],
      },
      search_meta: {},
    };
    const result = formatGroundedRecallEnvelope(payload);
    expect(result.display).toContain("说法不一致");
    assertValidSummary(result.summary);
    assertHasRaw(result, payload);
    // KEY: conflict-only must be "ok", not "empty"
    expect(result.summary.status).toBe("ok");
    expect(result.summary.count).toBeGreaterThanOrEqual(1);
  });

  test("gap-only — status is ok, NOT empty", () => {
    const payload = {
      query: "有没有遗漏",
      grounded_answer: {
        facts: [],
        candidates: [],
        gaps: [{ description: "缺少技术细节" }],
        conflicts: [],
      },
      search_meta: {},
    };
    const result = formatGroundedRecallEnvelope(payload);
    expect(result.display).toContain("还缺信息");
    assertValidSummary(result.summary);
    assertHasRaw(result, payload);
    // KEY: gap-only must be "ok", not "empty"
    expect(result.summary.status).toBe("ok");
    expect(result.summary.count).toBeGreaterThanOrEqual(1);
  });

  test("with gaps and conflicts — status is ok", () => {
    const payload = {
      query: "技术选型",
      grounded_answer: {
        facts: [],
        candidates: [],
        gaps: [{ description: "gap1" }],
        conflicts: [{ claim: "conflict1" }],
      },
      search_meta: {},
    };
    const result = formatGroundedRecallEnvelope(payload);
    expect(result.display).toContain("说法不一致");
    expect(result.display).toContain("还缺信息");
    assertValidSummary(result.summary);
    assertHasRaw(result, payload);
    expect(result.summary.status).toBe("ok");
    expect(result.summary.count).toBe(2);
  });

  test("truly empty board — status is empty", () => {
    const payload = {
      query: "完全不相关的内容",
      grounded_answer: { facts: [], candidates: [], gaps: [], conflicts: [] },
      search_meta: {},
    };
    const result = formatGroundedRecallEnvelope(payload);
    assertValidSummary(result.summary);
    assertHasRaw(result, payload);
    expect(result.summary.status).toBe("empty");
    expect(result.summary.count).toBe(0);
  });
});

// ─── query ────────────────────────────────────────────────────

describe("formatQueryEnvelope", () => {
  test("exact migrated outputs for empty, degraded, and ok branches (#284)", () => {
    const emptyPayload = { results: [] };
    expect(formatQueryEnvelope(emptyPayload)).toEqual({
      display: "没有找到相关内容。",
      summary: {
        status: "empty",
        count: 0,
        truncated: false,
        message: "没有找到相关内容",
        next_steps: ["尝试换关键词", "用 deep_recall 代替 query"],
      },
      raw: emptyPayload,
    });

    const degradedPayload = { results: [{ snippet: "a" }], degraded: true, vector_skipped: "timeout", latency_ms: 3000 };
    expect(formatQueryEnvelope(degradedPayload)).toEqual({
      display: "搜索超时了，先返回了 1 条相关内容。",
      summary: {
        status: "degraded",
        count: 1,
        truncated: false,
        message: "搜索降级，先返回 1 条结果",
        degraded_reason: "搜索超时",
      },
      raw: degradedPayload,
    });

    const okPayload = { results: [{ snippet: "a" }, { snippet: "b" }] };
    expect(formatQueryEnvelope(okPayload)).toEqual({
      display: "找到 2 条相关内容。",
      summary: {
        status: "ok",
        count: 2,
        truncated: false,
        message: "找到 2 条结果",
      },
      raw: okPayload,
    });
  });

  test("empty results preserves raw", () => {
    const payload = { results: [] };
    const result = formatQueryEnvelope(payload);
    assertHasRaw(result, payload);
    assertNoInternalTerms(result.display);
    assertValidSummary(result.summary);
    expect(result.summary.status).toBe("empty");
    expect(result.summary.next_steps).toBeDefined();
  });

  test("normal results", () => {
    const payload = { results: [{ snippet: "a" }, { snippet: "b" }] };
    const result = formatQueryEnvelope(payload);
    expect(result.display).toContain("2 条相关内容");
    assertNoInternalTerms(result.display);
    assertValidSummary(result.summary);
    assertHasRaw(result, payload);
    expect(result.summary.status).toBe("ok");
  });

  test("degraded with vector timeout", () => {
    const payload = { results: [{ snippet: "a" }], degraded: true, vector_skipped: "timeout", latency_ms: 3000 };
    const result = formatQueryEnvelope(payload);
    expect(result.display).toContain("超时");
    assertNoInternalTerms(result.display);
    assertValidSummary(result.summary);
    assertHasRaw(result, payload);
    expect(result.summary.status).toBe("degraded");
    expect(result.raw.vector_skipped).toBe("timeout");
  });
});

// ─── get_page ─────────────────────────────────────────────────

describe("formatGetPageEnvelope", () => {
  test("exact migrated outputs for missing, full, and truncated branches (#284)", () => {
    const missingPayload = { error: "Page not found" };
    expect(formatGetPageEnvelope(missingPayload)).toEqual({
      display: "页面不存在。",
      summary: {
        status: "empty",
        count: 0,
        truncated: false,
        message: "页面不存在",
      },
      raw: missingPayload,
    });

    const fullPayload = { title: "页面A", body_length: 200, has_more: false };
    expect(formatGetPageEnvelope(fullPayload)).toEqual({
      display: "《页面A》，200 字，内容完整。",
      summary: {
        status: "ok",
        count: 1,
        truncated: false,
        message: "《页面A》，200 字",
      },
      raw: fullPayload,
    });

    const truncatedPayload = { title: "页面B", body_length: 5000, has_more: true };
    expect(formatGetPageEnvelope(truncatedPayload)).toEqual({
      display: "《页面B》，5000 字，只显示了前面一部分。",
      summary: {
        status: "ok",
        count: 1,
        truncated: true,
        message: "《页面B》，5000 字",
      },
      raw: truncatedPayload,
    });
  });

  test("page not found — display uses natural language, raw has original error", () => {
    const payload = { error: "Page not found" };
    const result = formatGetPageEnvelope(payload);
    expect(result.display).toContain("不存在");
    assertNoInternalTerms(result.display);
    assertValidSummary(result.summary);
    // summary.message must NOT contain raw English error
    expect(result.summary.message).not.toContain("Page not found");
    // raw.error preserves the original
    assertHasRaw(result, payload);
    expect(result.raw.error).toBe("Page not found");
  });

  test("full page", () => {
    const payload = { title: "测试页面", body_length: 2000, has_more: false };
    const result = formatGetPageEnvelope(payload);
    expect(result.display).toContain("测试页面");
    assertNoInternalTerms(result.display);
    assertValidSummary(result.summary);
    assertHasRaw(result, payload);
    expect(result.summary.truncated).toBe(false);
  });

  test("truncated page", () => {
    const payload = { title: "长页面", body_length: 5000, has_more: true };
    const result = formatGetPageEnvelope(payload);
    expect(result.display).toContain("前面一部分");
    assertValidSummary(result.summary);
    assertHasRaw(result, payload);
    expect(result.summary.truncated).toBe(true);
  });
});

// ─── summarize ────────────────────────────────────────────────

describe("formatSummarizeEnvelope", () => {
  test("empty topic preserves raw", () => {
    const payload = { topic: "不存在的主题", entities: [], summary: "未找到相关内容" };
    const result = formatSummarizeEnvelope(payload);
    assertHasRaw(result, payload);
    // raw.summary preserves the old string
    expect(result.raw.summary).toBe("未找到相关内容");
    assertNoInternalTerms(result.display);
    assertValidSummary(result.summary);
    expect(result.summary.status).toBe("empty");
  });

  test("normal with stats", () => {
    const payload = {
      topic: "投资",
      entities: [{ title: "实体A" }, { title: "实体B", _stub: true }],
      stats: { totalEntities: 2, detailEntities: 1, stubEntities: 1, totalLinks: 5, totalEvents: 3 },
    };
    const result = formatSummarizeEnvelope(payload);
    expect(result.display).toContain("投资");
    assertNoInternalTerms(result.display);
    assertValidSummary(result.summary);
    assertHasRaw(result, payload);
    expect(result.summary.count).toBe(2);
    expect(result.summary.truncated).toBe(true);
  });
});

// ─── recall_episode ───────────────────────────────────────────

describe("formatEpisodeEnvelope", () => {
  const stubMeta = { time_parsed: null, tokens_used: [], total_scanned: 0, hints_applied: [] };
  const stubDiag = { clues_checked: [] };

  test("empty candidates preserves raw with original summary string", () => {
    const result_obj: EpisodicRecallResult = {
      query: "去年团建的人",
      summary: "没有找到匹配的人物",
      candidates: [],
      search_meta: stubMeta,
      diagnostics: stubDiag,
    };
    const result = formatEpisodeEnvelope(result_obj);
    assertHasRaw(result, result_obj);
    // raw.summary is the original string
    expect(result.raw.summary).toBe("没有找到匹配的人物");
    assertNoInternalTerms(result.display);
    assertValidSummary(result.summary);
    expect(result.summary.status).toBe("empty");
  });

  test("with candidates", () => {
    const result_obj: EpisodicRecallResult = {
      query: "做前端的人",
      summary: "找到 1 个候选人",
      candidates: [
        { slug: "entities/person-a", title: "人物A", score: 0.8, confidence: "high", matched_clues: [], evidence: [], next_disambiguating_clue: null },
      ],
      search_meta: stubMeta,
      diagnostics: stubDiag,
    };
    const result = formatEpisodeEnvelope(result_obj);
    expect(result.display).toContain("匹配到 1 位");
    assertNoInternalTerms(result.display);
    assertValidSummary(result.summary);
    assertHasRaw(result, result_obj);
    expect(result.summary.status).toBe("ok");
    expect(result.raw.candidates.length).toBe(1);
  });
});

// ─── get_org_tree ─────────────────────────────────────────────

describe("formatOrgTreeEnvelope", () => {
  test("normal tree preserves raw", () => {
    const result_obj: OrgTreeResult = {
      seed: { slug: "entities/person-a", title: "人物A", type: "entity/person" },
      upward: [{ slug: "entities/boss", title: "Boss", type: "entity/person", depth: 1, parent_slug: "entities/person-a" }],
      downward: [
        { slug: "entities/sub1", title: "下属1", type: "entity/person", depth: 1, parent_slug: "entities/person-a" },
        { slug: "entities/sub2", title: "下属2", type: "entity/person", depth: 1, parent_slug: "entities/person-a" },
      ],
      warnings: [],
    };
    const result = formatOrgTreeEnvelope(result_obj);
    expect(result.display).toContain("人物A");
    assertNoInternalTerms(result.display);
    assertValidSummary(result.summary);
    assertHasRaw(result, result_obj);
    expect(result.summary.count).toBe(4);
    expect(result.raw.seed.title).toBe("人物A");
    expect(result.raw.upward.length).toBe(1);
  });

  test("leaf node", () => {
    const result_obj: OrgTreeResult = {
      seed: { slug: "entities/person-b", title: "人物B", type: "entity/person" },
      upward: [],
      downward: [],
      warnings: [],
    };
    const result = formatOrgTreeEnvelope(result_obj);
    assertHasRaw(result, result_obj);
    expect(result.summary.count).toBe(1);
  });
});

// ─── discoveries ──────────────────────────────────────────────

describe("formatDiscoveriesEnvelope", () => {
  test("empty discoveries preserves raw", () => {
    const payload = { cards: [], summary: "暂无新发现" };
    const result = formatDiscoveriesEnvelope(payload);
    assertHasRaw(result, payload);
    assertNoInternalTerms(result.display);
    assertValidSummary(result.summary);
    expect(result.summary.status).toBe("empty");
    expect(result.raw.summary).toBe("暂无新发现");
  });

  test("with cards reuses existing display", () => {
    const payload = {
      display: "### 发现A\n一些内容\n---\n### 发现B\n其他内容",
      cards: [{ title: "发现A" }, { title: "发现B" }],
      summary: "今天有 2 条发现。",
    };
    const result = formatDiscoveriesEnvelope(payload);
    expect(result.display).toContain("发现A");
    assertNoInternalTerms(result.display);
    assertValidSummary(result.summary);
    assertHasRaw(result, payload);
    expect(result.summary.status).toBe("ok");
    expect(result.raw.cards!.length).toBe(2);
  });
});

// ─── get_pages (batch) ──────────────────────────────────────

describe("formatGetPagesEnvelope", () => {
  test("exact migrated outputs for all found, partial, and all missing branches (#284)", () => {
    const allFound = { slugs: ["a", "b"], detail: "brief" as const, found: 2, missing: 0 };
    expect(formatGetPagesEnvelope(allFound)).toEqual({
      display: "找到 2 个页面。",
      summary: {
        status: "ok",
        count: 2,
        truncated: false,
        message: "找到 2 个页面",
      },
      raw: allFound,
    });

    const partial = { slugs: ["a", "b"], detail: "brief" as const, found: 1, missing: 1 };
    expect(formatGetPagesEnvelope(partial)).toEqual({
      display: "找到 1 个页面，1 个不存在。",
      summary: {
        status: "degraded",
        count: 1,
        truncated: false,
        message: "找到 1 个页面，1 个不存在",
        degraded_reason: "部分页面不存在",
      },
      raw: partial,
    });

    const missing = { slugs: ["x", "y"], detail: "brief" as const, found: 0, missing: 2 };
    expect(formatGetPagesEnvelope(missing)).toEqual({
      display: "所有 2 个页面均不存在。",
      summary: {
        status: "empty",
        count: 0,
        truncated: false,
        message: "所有 2 个页面均不存在",
        next_steps: ["检查名称是否正确", "用 query 搜索正确名称"],
      },
      raw: missing,
    });
  });

  test("all found — status ok", () => {
    const payload = { slugs: ["a", "b", "c"], detail: "brief" as const, found: 3, missing: 0 };
    const result = formatGetPagesEnvelope(payload);
    expect(result.display).toContain("找到 3 个页面");
    assertNoInternalTerms(result.display);
    assertValidSummary(result.summary);
    assertHasRaw(result, payload);
    expect(result.summary.status).toBe("ok");
    expect(result.summary.count).toBe(3);
    // raw preserves all payload fields
    expect(result.raw.found).toBe(3);
    expect(result.raw.missing).toBe(0);
  });

  test("partial — status degraded with missing reason", () => {
    const payload = { slugs: ["a", "b", "c"], detail: "brief" as const, found: 2, missing: 1 };
    const result = formatGetPagesEnvelope(payload);
    expect(result.display).toContain("找到 2 个页面");
    expect(result.display).toContain("1 个不存在");
    assertValidSummary(result.summary);
    assertHasRaw(result, payload);
    expect(result.summary.status).toBe("degraded");
    expect(result.summary.degraded_reason).toBeDefined();
    // raw preserves full payload
    expect(result.raw.found).toBe(2);
    expect(result.raw.missing).toBe(1);
  });

  test("all missing — status empty", () => {
    const payload = { slugs: ["x", "y"], detail: "brief" as const, found: 0, missing: 2 };
    const result = formatGetPagesEnvelope(payload);
    expect(result.display).toContain("均不存在");
    assertValidSummary(result.summary);
    assertHasRaw(result, payload);
    expect(result.summary.status).toBe("empty");
    expect(result.summary.count).toBe(0);
    expect(result.summary.next_steps).toBeDefined();
    // raw preserves full payload
    expect(result.raw.found).toBe(0);
    expect(result.raw.missing).toBe(2);
  });
});

// ─── sanitizeDisplay ──────────────────────────────────────────

describe("sanitizeDisplay", () => {
  test("strips slug paths from display text", () => {
    expect(sanitizeDisplay("brain/entities/person-a")).toBe("person-a");
    expect(sanitizeDisplay("brain/concepts/some-idea")).toBe("some-idea");
    expect(sanitizeDisplay("brain/records/test-note")).toBe("test-note");
    expect(sanitizeDisplay("brain/insights/cool-insight")).toBe("cool-insight");
  });

  test("leaves plain text untouched", () => {
    expect(sanitizeDisplay("找到 3 个相关实体")).toBe("找到 3 个相关实体");
    expect(sanitizeDisplay("")).toBe("");
  });
});

// ─── DISPLAY_BANNED_TERM_RULES structure (#256) ──────────────

describe("DISPLAY_BANNED_TERM_RULES", () => {
  test("every rule has a non-empty term, reason, and explicit scope", () => {
    expect(DISPLAY_BANNED_TERM_RULES.length).toBeGreaterThan(0);
    const validScopes = ["display", "summary", "display_summary", "global"];
    for (const rule of DISPLAY_BANNED_TERM_RULES) {
      expect(rule.term.length).toBeGreaterThan(0);
      expect(rule.reason.trim().length).toBeGreaterThan(0);
      expect(validScopes).toContain(rule.scope);
    }
  });

  test("DISPLAY_BANNED_TERMS compatibility export equals structured rule terms", () => {
    expect(DISPLAY_BANNED_TERMS).toEqual(DISPLAY_BANNED_TERM_RULES.map((r) => r.term));
  });

  test("preserves every legacy banned term (no silent drops)", () => {
    const legacy = [
      "score", "distance", "debug", "trace", "threshold",
      "latency_ms", "vector", "degraded_reason", "_stub",
      "reason_codes", "candidate", "raw", "fts", "lancedb",
    ];
    for (const term of legacy) {
      expect(DISPLAY_BANNED_TERMS).toContain(term);
    }
  });
});

// ─── Evidence Summary Display ─────────────────────────────────

describe("formatRecallEnvelope with evidence_summary", () => {
  test("evidence_summary in raw, NOT in display — summary gets lightweight fields", () => {
    const payload = {
      query: "test",
      entities: [{ title: "A" }, { title: "B" }],
      evidence_summary: {
        confidence: "high" as const,
        top_facts: ["fact 1", "fact 2"],
        gap_count: 0,
        conflict_count: 0,
        total_evidence: 2,
      },
    };
    const { display, summary, raw } = formatRecallEnvelope(payload);

    // display: clean, no internal evidence labels
    expect(display).not.toContain("证据质量");
    expect(display).not.toContain("evidence_summary");
    assertNoInternalTerms(display);

    // summary: lightweight human-safe signal
    expect(summary.evidence_count).toBe(2);
    expect(summary.confidence).toBe("high");

    // raw: full internal structure preserved
    expect((raw as any).evidence_summary).toEqual(payload.evidence_summary);
  });

  test("medium confidence — summary reflects it, display stays natural", () => {
    const payload = {
      query: "test",
      entities: [{ title: "A" }],
      evidence_summary: {
        confidence: "medium" as const,
        top_facts: ["fact 1"],
        gap_count: 2,
        conflict_count: 1,
        total_evidence: 4,
      },
    };
    const { display, summary } = formatRecallEnvelope(payload);
    expect(display).not.toContain("证据质量");
    expect(summary.evidence_count).toBe(4);
    expect(summary.confidence).toBe("medium");
  });

  test("no evidence_summary — summary has no evidence fields (backward compat)", () => {
    const payload = {
      query: "test",
      entities: [{ title: "A" }],
    };
    const { display, summary } = formatRecallEnvelope(payload);
    expect(display).not.toContain("证据质量");
    expect(summary.evidence_count).toBeUndefined();
    expect(summary.confidence).toBeUndefined();
  });

  test("evidence_summary with zero total_evidence — summary shows undefined", () => {
    const payload = {
      query: "test",
      entities: [{ title: "A" }],
      evidence_summary: {
        confidence: "low" as const,
        top_facts: [] as string[],
        gap_count: 0,
        conflict_count: 0,
        total_evidence: 0,
      },
    };
    const { display, summary } = formatRecallEnvelope(payload);
    expect(display).not.toContain("证据质量");
    expect(summary.evidence_count).toBe(0);
    expect(summary.confidence).toBe("low");
  });
});
