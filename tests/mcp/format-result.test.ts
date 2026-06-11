import { describe, test, expect } from "bun:test";
import {
  formatIngestResult,
  formatDialogueResult,
} from "../../src/mcp/tools/format-result.js";
import type { IngestResult } from "../../src/core/ingest.js";
import type { DialogueIngestResult } from "../../src/core/dialogue.js";

// ─── Helpers ────────────────────────────────────────────────

const BANNED_INTERNAL = [
  "slug", "stubsCreated", "filtered", "chunk", "source_id",
  "JSON", "ner_candidates", "entity_slugs", "stubs",
  "LLM", "llm", "parse", "error", "解析",
];

function assertNoInternalTerms(text: string): void {
  for (const term of BANNED_INTERNAL) {
    expect(
      text.includes(term),
      `display/message contains banned internal term "${term}"`,
    ).toBe(false);
  }
}

function mockIngestResult(overrides: Partial<IngestResult> = {}): IngestResult {
  return {
    slug: "records/test-page",
    created: true,
    linksExtracted: 0,
    ner: null,
    outcome: "created",
    ...overrides,
  };
}

function mockDialogueResult(
  overrides: Partial<DialogueIngestResult> = {},
): DialogueIngestResult {
  return {
    decision: "recorded",
    newEntities: 0,
    newRelations: 0,
    newEvents: 0,
    skipped: 0,
    filtered: [],
    ...overrides,
  };
}

// ─── formatIngestResult ─────────────────────────────────────

describe("formatIngestResult", () => {
  test("new page with NER results", () => {
    const result = mockIngestResult({
      created: true,
      ner: {
        entities: 3,
        relations: 2,
        events: 1,
        factsWritten: 1,
        stubsCreated: ["entities/person-a"],
        lowRelevanceSkipped: 0,
        filtered: [],
        resolvedSlugs: [],
        relationSlugs: [],
        details: { entities: [], relations: [], events: [] },
      },
    });
    const envelope = formatIngestResult(result, "测试页面");
    expect(envelope.summary.status).toBe("recorded");
    expect(envelope.summary.title).toBe("测试页面");
    expect(envelope.summary.captured).toEqual({ entities: 3, relations: 2, events: 1 });
    expect(envelope.display).toContain("已记住：测试页面");
    expect(envelope.display).toContain("3 个实体");
    expect(envelope.display).toContain("2 条关系");
    expect(envelope.display).toContain("1 个事件");
    assertNoInternalTerms(envelope.display);
    assertNoInternalTerms(envelope.summary.message);
  });

  test("updated page without NER", () => {
    const result = mockIngestResult({ created: false, ner: null });
    const envelope = formatIngestResult(result, "旧页面");
    expect(envelope.display).toContain("已更新：旧页面");
    expect(envelope.summary.status).toBe("recorded");
    expect(envelope.summary.captured).toBeNull();
    assertNoInternalTerms(envelope.display);
  });

  test("new page with NER returning zero extractions", () => {
    const result = mockIngestResult({
      created: true,
      ner: {
        entities: 0,
        relations: 0,
        events: 0,
        factsWritten: 0,
        stubsCreated: [],
        lowRelevanceSkipped: 0,
        filtered: [],
        resolvedSlugs: [],
        relationSlugs: [],
        details: { entities: [], relations: [], events: [] },
      },
    });
    const envelope = formatIngestResult(result, "空页面");
    expect(envelope.display).toBe("已记住：空页面。");
    expect(envelope.summary.captured).toEqual({ entities: 0, relations: 0, events: 0 });
    assertNoInternalTerms(envelope.display);
  });

  test("no NER with links extracted mentions count", () => {
    const result = mockIngestResult({ created: true, linksExtracted: 5, ner: null });
    const envelope = formatIngestResult(result, "链接页");
    expect(envelope.display).toContain("5 个链接");
    expect(envelope.summary.captured).toBeNull();
    assertNoInternalTerms(envelope.display);
  });

  test("raw field preserves the original result object", () => {
    const result = mockIngestResult({
      slug: "records/test-raw",
      created: true,
      linksExtracted: 3,
      ner: {
        entities: 1,
        relations: 0,
        events: 0,
        factsWritten: 0,
        stubsCreated: ["entities/person-x"],
        lowRelevanceSkipped: 0,
        filtered: [{ name: "人物X", reason: "generic" }],
        resolvedSlugs: [],
        relationSlugs: [],
        details: { entities: [], relations: [], events: [] },
      },
    });
    const envelope = formatIngestResult(result, "原始数据");
    expect(envelope.raw).toEqual(result);
    expect(envelope.raw.slug).toBe("records/test-raw");
    expect(envelope.raw.created).toBe(true);
    expect(envelope.raw.linksExtracted).toBe(3);
    expect(envelope.raw.ner).toBe(result.ner);
  });

  test("display omits zero-count NER items", () => {
    const result = mockIngestResult({
      ner: {
        entities: 0,
        relations: 5,
        events: 0,
        factsWritten: 0,
        stubsCreated: [],
        lowRelevanceSkipped: 0,
        filtered: [],
        resolvedSlugs: [],
        relationSlugs: [],
        details: { entities: [], relations: [], events: [] },
      },
    });
    const envelope = formatIngestResult(result, "部分数据");
    expect(envelope.display).not.toContain("0 个实体");
    expect(envelope.display).not.toContain("0 个事件");
    expect(envelope.display).toContain("5 条关系");
  });

  test("ner undefined (LLM unavailable) is treated as no NER", () => {
    const result = mockIngestResult({ created: true, ner: undefined });
    const envelope = formatIngestResult(result, "无LLM");
    expect(envelope.display).toContain("已记住：无LLM");
    expect(envelope.summary.captured).toBeNull();
  });

  test("duplicate: natural language display, status=skipped, title=existing page title", () => {
    const result = mockIngestResult({
      created: false,
      outcome: "duplicate",
      duplicateOf: { slug: "records/yi-you-zai-mian-ye", title: "已存在的页面" },
    });
    const envelope = formatIngestResult(result, "被拒绝的新标题");

    // Display: natural language referencing existing page title
    expect(envelope.display).toContain("已经存在于《已存在的页面》");
    expect(envelope.display).toContain("未重复存入");
    expect(envelope.summary.status).toBe("skipped");
    // Title should be the EXISTING page title, not the rejected new title
    expect(envelope.summary.title).toBe("已存在的页面");
    expect(envelope.summary.captured).toBeNull();
    // No slug or hash exposed in display
    expect(envelope.display).not.toContain("records/");
    expect(envelope.display).not.toContain("slug");
    assertNoInternalTerms(envelope.display);
    assertNoInternalTerms(envelope.summary.message);
  });
});

// ─── formatDialogueResult ───────────────────────────────────

describe("formatDialogueResult", () => {
  test("recorded with entities, relations, and events", () => {
    const result = mockDialogueResult({
      decision: "recorded",
      newEntities: 2,
      newRelations: 1,
      newEvents: 3,
    });
    const envelope = formatDialogueResult(result);
    expect(envelope.summary.status).toBe("recorded");
    expect(envelope.summary.title).toBeNull();
    expect(envelope.summary.captured).toEqual({ entities: 2, relations: 1, events: 3 });
    expect(envelope.display).toContain("已记住对话中的信息");
    expect(envelope.display).toContain("2 个新实体");
    expect(envelope.display).toContain("1 条新关系");
    expect(envelope.display).toContain("3 个新事件");
    assertNoInternalTerms(envelope.display);
  });

  test("recorded with all zeros", () => {
    const result = mockDialogueResult({ decision: "recorded" });
    const envelope = formatDialogueResult(result);
    expect(envelope.display).toBe("已记住对话中的信息。");
    expect(envelope.summary.captured).toEqual({ entities: 0, relations: 0, events: 0 });
    assertNoInternalTerms(envelope.display);
  });

  test("skipped: empty input", () => {
    const result = mockDialogueResult({ decision: "skipped", reason: "empty input" });
    const envelope = formatDialogueResult(result);
    expect(envelope.summary.status).toBe("skipped");
    expect(envelope.display).toContain("输入为空");
    assertNoInternalTerms(envelope.display);
  });

  test("skipped: llm error", () => {
    const result = mockDialogueResult({ decision: "skipped", reason: "llm error" });
    const envelope = formatDialogueResult(result);
    expect(envelope.summary.status).toBe("skipped");
    expect(envelope.display).toContain("暂时没能完成记录");
    assertNoInternalTerms(envelope.display);
    // Technical reason stays in raw only
    expect(envelope.raw.reason).toBe("llm error");
  });

  test("skipped: parse failed", () => {
    const result = mockDialogueResult({ decision: "skipped", reason: "parse failed" });
    const envelope = formatDialogueResult(result);
    expect(envelope.summary.status).toBe("skipped");
    expect(envelope.display).toContain("暂时没能完成记录");
    assertNoInternalTerms(envelope.display);
    // Technical reason stays in raw only
    expect(envelope.raw.reason).toBe("parse failed");
  });

  test("skipped: no actionable facts", () => {
    const result = mockDialogueResult({ decision: "skipped", reason: "no actionable facts" });
    const envelope = formatDialogueResult(result);
    expect(envelope.summary.status).toBe("skipped");
    expect(envelope.display).toContain("没有需要长期记住的新事实");
    assertNoInternalTerms(envelope.display);
  });

  test("skipped: unknown reason", () => {
    const result = mockDialogueResult({ decision: "skipped", reason: "something weird" });
    const envelope = formatDialogueResult(result);
    expect(envelope.summary.status).toBe("skipped");
    expect(envelope.display).toContain("内容已跳过");
    assertNoInternalTerms(envelope.display);
  });

  test("needs_review", () => {
    const result = mockDialogueResult({ decision: "needs_review" });
    const envelope = formatDialogueResult(result);
    expect(envelope.summary.status).toBe("needs_review");
    expect(envelope.display).toContain("需要进一步确认");
    assertNoInternalTerms(envelope.display);
  });

  test("raw field preserves original dialogue result", () => {
    const result = mockDialogueResult({
      decision: "skipped",
      reason: "llm error",
      newEntities: 0,
      newRelations: 0,
      newEvents: 0,
      skipped: 5,
      filtered: [{ name: "人物A", type: "person", relevance: "low", reason: "too generic" }],
    });
    const envelope = formatDialogueResult(result);
    expect(envelope.raw).toEqual(result);
    expect(envelope.raw.decision).toBe("skipped");
    expect(envelope.raw.filtered.length).toBe(1);
  });

  test("title is always null for dialogue results", () => {
    for (const decision of ["recorded", "skipped", "needs_review"] as const) {
      const result = mockDialogueResult({ decision });
      const envelope = formatDialogueResult(result);
      expect(envelope.summary.title).toBeNull();
    }
  });
});
