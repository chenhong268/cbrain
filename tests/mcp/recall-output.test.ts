import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  DEEP_RECALL_OUTPUT_SCHEMA,
  FRONTDOOR_DATA_KEYS,
  QUERY_DATA_KEYS,
  RECALL_DATA_KEYS,
  projectFrontdoorData,
  projectGroundedRecallData,
  projectQueryData,
  projectRecallData,
  structuredSummary,
} from "../../src/mcp/tools/recall-output.js";
import { redactAudit } from "../../src/mcp/tools/audit-redact.js";
import { buildToolResult, sanitizeUntrustedData } from "../../src/mcp/tools/result-builder.js";

describe("caller-specific structured data policy (#331)", () => {
  test("default graph/timeline policy stays unchanged while a query policy admits query fields", () => {
    const value = { results: [{ snippet: "片段A", score: 0.9 }], result_count: 1 };
    expect(sanitizeUntrustedData(value)).toEqual({});
    expect(sanitizeUntrustedData(value, QUERY_DATA_KEYS)).toEqual({
      results: [{ snippet: "片段A" }],
      result_count: 1,
    });
  });

  test("query projection keeps useful snippets and removes locator internals", () => {
    const data = projectQueryData({
      results: [{ slug: "entities/a", score: 0.8, source: "vector", snippet: "片段A" }],
      proactive_hints: [{ rule: "r1", text: "提示A", score: 0.7, why: "原因A", target_slug: "entities/a" }],
      search_meta: { reason_codes: ["low_score"], latency_ms: 99 },
    });
    expect(data).toEqual({
      result_count: 1,
      results: [{ snippet: "片段A" }],
      proactive_hints: [{ text: "提示A", why: "原因A" }],
    });
    expect(JSON.stringify(data)).not.toMatch(/entities\/|score|source|latency|reason_codes|rule/);
  });

  test("normal recall projection keeps #231 first-turn semantics and removes slug/relevance/search meta", () => {
    const data = projectRecallData({
      display: "旧展示",
      summary: { status: "ok", count: 1, truncated: false, message: "有 1 条" },
      result_summary: "有 1 条相关记忆",
      query: "主题D",
      entities: [{ slug: "entities/a", title: "实体A", relevance: 0.91, type: "entity/person", snippet: "片段A", quality: "high", tier: 1, tags: ["主题D"] }],
      search_meta: { latency_ms: 18, degraded: false },
      proactive_hints: [{ rule: "r1", text: "提示A", score: 1, why: "原因A", target_slug: "entities/a" }],
      related_context: "同知识域还涉及：实体B",
    });
    expect(data).toEqual({
      result_summary: "有 1 条相关记忆",
      query: "主题D",
      entities: [{ title: "实体A", type: "entity/person", snippet: "片段A", quality: "high", tier: 1, tags: ["主题D"] }],
      proactive_hints: [{ text: "提示A", why: "原因A" }],
      related_context: "同知识域还涉及:实体B",
    });
    expect(JSON.stringify(data)).not.toMatch(/entities\/|relevance|latency_ms|search_meta|target_slug|score/);
  });

  test("grounded projection removes source slugs but preserves evidence classes", () => {
    const data = projectGroundedRecallData({
      query: "主题D",
      answer: "根据记录：事实A。",
      confidence: "high",
      facts: ["事实A"],
      user_thoughts: ["想法B"],
      candidates: ["候选C"],
      conflicts: [],
      gaps: [],
      sources: [{ slug: "entities/a", evidence_count: 1 }],
      must_not_claim: ["候选C"],
    });
    expect(data).toEqual({
      answer: "根据记录:事实A。",
      confidence: "high",
      facts: ["事实A"],
      user_thoughts: ["想法B"],
      candidates: ["候选C"],
      conflicts: [],
      gaps: [],
      must_not_claim: ["候选C"],
    });
    expect(JSON.stringify(data)).not.toContain("entities/a");
  });

  test("frontdoor projection keeps route semantics but removes routing and refs", () => {
    const data = projectFrontdoorData("找到 1 条相关记忆。", {
      query: "主题D",
      entities: [{ slug: "entities/a", title: "实体A", snippet: "片段A", score: 0.9 }],
      routing: { chosen_route: "content_recall", latency_ms: 20 },
      search_meta: { reason_codes: ["x"] },
    });
    expect(data).toEqual({
      answer: "找到 1 条相关记忆。",
      details: { query: "主题D", entities: [{ title: "实体A", snippet: "片段A" }] },
    });
    expect(JSON.stringify(data)).not.toMatch(/entities\/|routing|score|reason_codes|latency/);
  });

  test("frontdoor content projection never exposes page body or raw chunk content", () => {
    const data = projectFrontdoorData("已找到相关记忆。", {
      query: "主题A",
      entities: [{ title: "实体A", snippet: "可见摘要", body: "FULL-BODY-SECRET" }],
      evidence_pack: { chunks: [{ content: "RAW-CHUNK-SECRET" }] },
      routing: { chosen_route: "content_recall" },
    });

    expect(data).toEqual({
      answer: "已找到相关记忆。",
      details: { query: "主题A", entities: [{ title: "实体A", snippet: "可见摘要" }] },
    });
    expect(JSON.stringify(data)).not.toContain("FULL-BODY-SECRET");
    expect(JSON.stringify(data)).not.toContain("RAW-CHUNK-SECRET");
  });

  test("frontdoor content projection exposes only bounded proactive hint semantics", () => {
    const data = projectFrontdoorData("已找到相关记忆。", {
      query: "主题A",
      proactive_hints: [{
        rule: "expiry_alert",
        score: 1,
        target_slug: "internal/target",
        text: "提示A",
        why: "原因A",
      }],
      routing: { chosen_route: "content_recall" },
    });

    expect(data).toEqual({
      answer: "已找到相关记忆。",
      details: { query: "主题A", proactive_hints: [{ text: "提示A", why: "原因A" }] },
    });
    expect(JSON.stringify(data)).not.toMatch(/internal\/target|expiry_alert|score/);
  });

  test("frontdoor relationship projection preserves bounded evidence semantics", () => {
    const data = projectFrontdoorData("已完成分析。", {
      result: {
        status: "ok",
        evidence_board: {
          facts: [{ claim: "实体A与实体B存在关联", source_slug: "entity/private" }],
          user_thoughts: [{ claim: "用户曾关注主题C", source_slug: "entity/private" }],
          candidates: [{ claim: "关系D待确认", source_slug: "entity/private" }],
          conflicts: [{ claim: "关系E存在冲突", evidence: [{ source_slug: "entity/private" }] }],
          gaps: ["仍缺少时间证据"],
        },
        answer_context: {
          confidence: "medium",
          topClaims: ["实体A与实体B存在关联"],
          gaps: ["仍缺少时间证据"],
          sourceSlugs: [{ slug: "entity/private", factCount: 1 }],
        },
        trace_summary: { totalMs: 9000 },
      },
      routing: { chosen_route: "relationship" },
    });

    const blob = JSON.stringify(data);
    for (const visible of ["实体A与实体B存在关联", "用户曾关注主题C", "关系D待确认", "关系E存在冲突", "仍缺少时间证据"]) {
      expect(blob).toContain(visible);
    }
    for (const hidden of ["entity/private", "source_slug", "sourceSlugs", "trace_summary", "totalMs"]) {
      expect(blob).not.toContain(hidden);
    }
  });

  test("frontdoor episodic projection drops raw excerpts and enforces a total budget", () => {
    const data = projectFrontdoorData("已完成情境回忆。", {
      candidates: Array.from({ length: 8 }, (_, index) => ({
        title: `实体${index}`,
        confidence: "medium",
        matched_clues: [{ dimension: "topic", hint_used: "线索".repeat(2_000) }],
        evidence: [{ excerpt: "RAW-CHUNK-SECRET".repeat(20_000), date: "2026-01-01" }],
      })),
      routing: { chosen_route: "episodic_recall" },
    });
    const blob = JSON.stringify(data);

    expect(blob).not.toContain("RAW-CHUNK-SECRET");
    expect(blob.length).toBeLessThanOrEqual(12_000);
    expect(blob).toContain("2026-01-01");
  });

  test("frontdoor agentic projection enforces a total budget without losing every evidence class", () => {
    const hugeClaim = "证据内容".repeat(50_000);
    const data = projectFrontdoorData("已完成分析。", {
      result: {
        status: "ok",
        evidence_board: {
          facts: Array.from({ length: 20 }, () => ({ claim: hugeClaim })),
          user_thoughts: Array.from({ length: 20 }, () => ({ claim: hugeClaim })),
          candidates: Array.from({ length: 20 }, () => ({ claim: hugeClaim })),
          conflicts: Array.from({ length: 20 }, () => ({ claim: hugeClaim })),
          gaps: Array.from({ length: 20 }, () => hugeClaim),
        },
        answer_context: { confidence: "medium", topClaims: [hugeClaim], gaps: [hugeClaim] },
      },
      routing: { chosen_route: "reasoning" },
    });
    const blob = JSON.stringify(data);

    expect(blob.length).toBeLessThanOrEqual(12_000);
    expect(blob).toContain("evidence_board");
  });

  test("audit redaction normalizes unicode and recursively handles keys, Map, and Set", () => {
    const redacted = redactAudit({
      "／Users／private／secret.md": "safe",
      credential: "ｓｋ－abcd1234efgh5678",
      zero_width_credential: "s\u200Bk-abcd1234efgh5678",
      zero_width_path: "/Users\u200B/private/hidden.md",
      map: new Map([["path", "/Users/private/map.md"]]),
      set: new Set(["/Users/private/set.md", "normal"]),
    });
    const blob = JSON.stringify(redacted);

    for (const leaked of [
      "/Users/private", "／Users／private", "sk-abcd1234efgh5678", "ｓｋ－abcd1234efgh5678",
      "s\u200Bk-abcd1234efgh5678", "/Users\u200B/private",
    ]) {
      expect(blob).not.toContain(leaked);
    }
    expect(blob).toContain("normal");
    expect(blob).toContain("[redacted]");
  });

  test("structured builder serializes redacted Map and Set audit identically in both channels", () => {
    const summary = { status: "ok" as const, count: 1, truncated: false, message: "固定摘要" };
    const result = buildToolResult({
      mode: "structured",
      display: "旧展示",
      displayStructured: "已完成记忆检索。",
      summary,
      summaryStructured: summary,
      data: {},
      raw: {
        map: new Map([["path", "/Users/private/map.md"]]),
        set: new Set(["normal", "ｓｋ－abcd1234efgh5678"]),
      },
      includeRaw: true,
    });
    const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;

    expect(parsed.audit).toEqual(result.structuredContent?.audit);
    const blob = JSON.stringify(parsed.audit);
    expect(blob).toContain("normal");
    expect(blob).not.toContain("/Users/private");
    expect(blob).not.toContain("sk-abcd1234efgh5678");
    expect(blob).not.toContain("ｓｋ－abcd1234efgh5678");
  });

  test("structured audit rejects toJSON/accessors/prototype keys and canonicalizes channel shape", () => {
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "toJSON", {
      enumerable: true,
      value: () => ({ leak: "/Users/private/secret.md", token: "sk-abcd1234efgh5678" }),
    });
    Object.defineProperty(hostile, "getter", {
      enumerable: true,
      get: () => "/Users/private/getter.md",
    });
    Object.defineProperty(hostile, "__proto__", {
      enumerable: true,
      value: "/Users/private/prototype.md",
    });
    hostile.optional = undefined;
    hostile.normal = "正常审计内容";
    const summary = { status: "ok" as const, count: 1, truncated: false, message: "固定摘要" };
    const result = buildToolResult({
      mode: "structured",
      display: "旧展示",
      displayStructured: "已完成记忆检索。",
      summary,
      summaryStructured: summary,
      data: {},
      raw: hostile,
      includeRaw: true,
    });
    const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
    const audit = parsed.audit as { raw: Record<string, unknown> };

    expect(parsed.audit).toEqual(result.structuredContent?.audit);
    expect(audit.raw.normal).toBe("正常审计内容");
    expect(audit.raw.optional).toBeUndefined();
    expect(Object.hasOwn(audit.raw, "__proto__")).toBe(false);
    const blob = JSON.stringify(parsed.audit);
    expect(blob).not.toContain("/Users/private");
    expect(blob).not.toContain("sk-abcd1234efgh5678");
  });

  test("structured audit omits invalid Date payloads instead of invoking attacker serialization", () => {
    const invalid = new Date(Number.NaN);
    Object.defineProperty(invalid, "toISOString", {
      value: () => "/Users/private/DATE-SECRET.md",
    });
    const summary = { status: "ok" as const, count: 0, truncated: false, message: "固定摘要" };
    const result = buildToolResult({
      mode: "structured",
      display: "旧展示",
      displayStructured: "已完成记忆检索。",
      summary,
      summaryStructured: summary,
      data: {},
      raw: { invalid },
      includeRaw: true,
    });

    expect(result.structuredContent?.audit).toBeUndefined();
    expect(result.content[0].text).not.toContain("DATE-SECRET");
  });

  test("deep recall projectors cap producer arrays to the exact output schema", () => {
    const tags = Array.from({ length: 101 }, (_, index) => `标签${index}`);
    const claims = Array.from({ length: 101 }, (_, index) => `事实${index}`);
    const normalData = projectRecallData({ entities: [{ title: "实体A", tags }] });
    const groundedData = projectGroundedRecallData({
      answer: "回答",
      confidence: "high",
      facts: claims,
      user_thoughts: [],
      candidates: [],
      conflicts: [],
      gaps: [],
      must_not_claim: [],
    });
    const summary = { status: "ok", count: 1, truncated: false, message: "已完成记忆检索。" };
    const schema = z.object(DEEP_RECALL_OUTPUT_SCHEMA);

    expect((normalData.entities as Array<{ tags: string[] }>)[0].tags).toHaveLength(100);
    expect(groundedData.facts).toHaveLength(100);
    expect(schema.safeParse({ schema_version: 1, summary, data: normalData }).success).toBe(true);
    expect(schema.safeParse({ schema_version: 1, summary, data: groundedData }).success).toBe(true);
  });

  test("structured summary does not reuse a vault-derived legacy message", () => {
    expect(structuredSummary({ status: "ok", count: 1, truncated: false, message: "最接近实体A" }, "recall"))
      .toEqual({ status: "ok", count: 1, truncated: false, message: "已完成记忆检索。" });
  });

  test("all new policies are structural allowlists", () => {
    expect(RECALL_DATA_KEYS.has("slug")).toBe(false);
    expect(QUERY_DATA_KEYS.has("score")).toBe(false);
    expect(FRONTDOOR_DATA_KEYS.has("routing")).toBe(false);
  });

  test("structured builder fails closed when untrusted data traversal throws", () => {
    const hostile = new Proxy({}, {
      ownKeys() {
        throw new Error("hostile traversal");
      },
    });
    const summary = { status: "ok" as const, count: 1, truncated: false, message: "固定摘要" };

    const result = buildToolResult({
      mode: "structured",
      display: "旧展示",
      displayStructured: "已完成记忆检索。",
      summary,
      summaryStructured: summary,
      data: hostile,
      dataKeys: RECALL_DATA_KEYS,
      raw: {},
      includeRaw: false,
    });

    expect(result.structuredContent?.data).toEqual({});
    expect(JSON.parse(result.content[0].text).data).toEqual({});
  });

  test("structured builder omits audit when redaction traversal throws", () => {
    const hostileRaw = new Proxy({}, {
      ownKeys() {
        throw new Error("hostile audit traversal");
      },
    });
    const summary = { status: "ok" as const, count: 0, truncated: false, message: "固定摘要" };

    const result = buildToolResult({
      mode: "structured",
      display: "旧展示",
      displayStructured: "已完成记忆检索。",
      summary,
      summaryStructured: summary,
      data: {},
      dataKeys: RECALL_DATA_KEYS,
      raw: hostileRaw,
      includeRaw: true,
    });

    expect(result.structuredContent?.audit).toBeUndefined();
    expect(JSON.parse(result.content[0].text).audit).toBeUndefined();
  });
});
