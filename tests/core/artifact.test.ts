import { describe, expect, it } from "bun:test";
import { escapeHtml, renderArtifact, Anonymizer, BLOCKED_FIELD_PATTERNS } from "../../src/core/retrieval/artifact.js";
import type { PipelineResult } from "../../src/core/agentic/pipeline.js";
import type { GroundedRecallResult } from "../../src/core/retrieval/grounded-answer.js";
import type { ArtifactInput, RenderOptions } from "../../src/core/retrieval/artifact.js";

// ─── Fixtures ─────────────────────────────────────────────────

function makeAgenticResult(overrides?: Partial<PipelineResult>): PipelineResult {
  return {
    query: "实体A和方案B的差异",
    intent: "comparison",
    status: "ok",
    plan: { intent: "comparison", entities: [], steps: [], budget: { max_llm_calls: 3, max_searches: 8, max_ms: 8000 } },
    execution: {
      status: "ok",
      steps: [],
      gaps: [],
      skipped: [],
      resolvedSlugs: new Map(),
      evidenceBoard: { facts: [], user_thoughts: [], candidates: [], gaps: [], conflicts: [] },
      trace: [],
      totalMs: 100,
      budgetUsed: { llmCalls: 1, searches: 2, ms: 100 },
    },
    critic: { sufficient: true, confidence: "high", missing: [], follow_up_steps: [], reasons: [] },
    evidence_board: {
      facts: [
        { claim: "方案A采用三层架构", evidence_type: "fact", source_type: "page", source_slug: "entities/aaa", source_category: "explicit_input", trust_state: "trusted" },
        { claim: "方案B使用微服务", evidence_type: "fact", source_type: "page", source_slug: "entities/bbb", source_category: "dialogue_extraction", trust_state: "trusted" },
      ],
      user_thoughts: [
        { claim: "我觉得方案A更稳", evidence_type: "user_thought", source_type: "page", source_slug: "entities/ccc", source_category: "dialogue_extraction", trust_state: "user_thought" },
      ],
      candidates: [
        { claim: "方案B可能有性能优势", evidence_type: "candidate", source_type: "page", source_slug: "entities/bbb", source_category: "agent_inference", trust_state: "candidate" },
      ],
      gaps: ["缺少方案B的成本数据"],
      conflicts: [
        { claim: "架构选型", evidence: [
          { claim: "单体足够", evidence_type: "fact", source_type: "page", source_slug: "entities/aaa", source_category: "explicit_input", trust_state: "trusted" },
          { claim: "需要拆分", evidence_type: "candidate", source_type: "page", source_slug: "entities/bbb", source_category: "agent_inference", trust_state: "candidate" },
        ] },
      ],
    },
    trace_summary: { totalMs: 100, totalSteps: 3, passCount: 1, errors: [], budgetUsed: { llmCalls: 1, searches: 2, ms: 100 } },
    answer_context: {
      query: "实体A和方案B的差异",
      intent: "comparison",
      confidence: "high",
      sourceSlugs: [{ slug: "entities/aaa", factCount: 2 }, { slug: "entities/bbb", factCount: 1 }],
      topClaims: ["方案A采用三层架构，方案B使用微服务"],
      gaps: ["缺少方案B的成本数据"],
      followUpPerformed: false,
    },
    ...overrides,
  } as PipelineResult;
}

function makeGroundedResult(): GroundedRecallResult {
  return {
    query: "当时怎么设计的",
    answer: "采用了三层架构方案",
    confidence: "high",
    facts: ["采用了三层架构", "角色分工明确"],
    user_thoughts: ["我觉得需要失败恢复机制"],
    candidates: ["可能有预算约束"],
    conflicts: ["架构选型有分歧"],
    gaps: ["缺失败恢复设计"],
    sources: [{ slug: "entities/xxx", evidence_count: 2 }],
    must_not_claim: [],
  };
}

const defaultOptions: RenderOptions = { title: "测试报告", anonymize: false, includeSocialContext: false };

// ─── Tests ────────────────────────────────────────────────────

describe("escapeHtml", () => {
  it("escapes all HTML special characters", () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
    );
  });

  it("escapes ampersands", () => {
    expect(escapeHtml("A & B")).toBe("A &amp; B");
  });

  it("escapes single quotes", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("leaves plain text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

describe("Anonymizer", () => {
  it("produces consistent labels for same slug", () => {
    const anon = new Anonymizer();
    expect(anon.label("entities/aaa")).toBe("来源A");
    expect(anon.label("entities/aaa")).toBe("来源A");
  });

  it("produces different labels for different slugs", () => {
    const anon = new Anonymizer();
    expect(anon.label("entities/aaa")).toBe("来源A");
    expect(anon.label("entities/bbb")).toBe("来源B");
  });

  it("treats non-slash strings as entities", () => {
    const anon = new Anonymizer();
    expect(anon.label("zhangsan")).toBe("实体A");
  });
});

describe("renderArtifact — agentic", () => {
  it("renders valid HTML with correct sections", () => {
    const input: ArtifactInput = { kind: "agentic", data: makeAgenticResult() };
    const html = renderArtifact(input, defaultOptions);

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("核心结论");
    expect(html).toContain("已验证证据");
    expect(html).toContain("矛盾点");
    expect(html).toContain("尚未覆盖的角度");
    expect(html).toContain("Generated by CBrain");
  });

  it("excludes all blocked internal fields", () => {
    const input: ArtifactInput = { kind: "agentic", data: makeAgenticResult() };
    const html = renderArtifact(input, defaultOptions);

    for (const field of BLOCKED_FIELD_PATTERNS) {
      expect(html).not.toContain(field);
    }
  });

  it("does not contain raw slugs when not anonymized", () => {
    const input: ArtifactInput = { kind: "agentic", data: makeAgenticResult() };
    const html = renderArtifact(input, defaultOptions);

    // Source labels should use display name (last segment), not full slug
    expect(html).not.toContain("entities/aaa");
  });

  it("shows candidates with 可能/待确认 tag", () => {
    const input: ArtifactInput = { kind: "agentic", data: makeAgenticResult() };
    const html = renderArtifact(input, defaultOptions);

    expect(html).toContain("待确认");
    expect(html).toContain("可能/待确认");
  });

  it("omits user_thoughts when includeSocialContext=false", () => {
    const input: ArtifactInput = { kind: "agentic", data: makeAgenticResult() };
    const html = renderArtifact(input, defaultOptions);

    expect(html).not.toContain("你的观点");
    expect(html).not.toContain("我觉得方案A更稳");
  });

  it("includes user_thoughts when includeSocialContext=true", () => {
    const opts: RenderOptions = { ...defaultOptions, includeSocialContext: true };
    const input: ArtifactInput = { kind: "agentic", data: makeAgenticResult() };
    const html = renderArtifact(input, opts);

    expect(html).toContain("你的观点");
    expect(html).toContain("社交情境");
  });

  it("escapes malicious content in claims", () => {
    const malicious = makeAgenticResult({
      answer_context: {
        query: "test",
        intent: "comparison" as const,
        confidence: "high",
        sourceSlugs: [],
        topClaims: ['<script>alert("xss")</script>'],
        gaps: [],
        followUpPerformed: false,
      },
    } as Partial<PipelineResult>);
    const input: ArtifactInput = { kind: "agentic", data: malicious };
    const html = renderArtifact(input, defaultOptions);

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderArtifact — grounded", () => {
  it("renders valid HTML with correct sections", () => {
    const input: ArtifactInput = { kind: "grounded", data: makeGroundedResult() };
    const html = renderArtifact(input, defaultOptions);

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("核心结论");
    expect(html).toContain("已验证证据");
    expect(html).toContain("Generated by CBrain");
  });

  it("excludes all blocked internal fields", () => {
    const input: ArtifactInput = { kind: "grounded", data: makeGroundedResult() };
    const html = renderArtifact(input, defaultOptions);

    for (const field of BLOCKED_FIELD_PATTERNS) {
      expect(html).not.toContain(field);
    }
  });
});

describe("renderArtifact — content caps", () => {
  it("limits claims to 10", () => {
    const claims = Array.from({ length: 15 }, (_, i) => `Claim ${i + 1}`);
    const result = makeAgenticResult({
      answer_context: {
        query: "test",
        intent: "comparison" as const,
        confidence: "high",
        sourceSlugs: [],
        topClaims: claims,
        gaps: [],
        followUpPerformed: false,
      },
    } as Partial<PipelineResult>);

    const input: ArtifactInput = { kind: "agentic", data: result };
    const html = renderArtifact(input, defaultOptions);

    // First 10 should be present
    expect(html).toContain("Claim 10");
    // 11th should not
    expect(html).not.toContain("Claim 11");
  });
});

describe("renderArtifact — anonymize", () => {
  it("replaces slug patterns with labels", () => {
    const input: ArtifactInput = { kind: "grounded", data: makeGroundedResult() };
    const opts: RenderOptions = { ...defaultOptions, anonymize: true };
    const html = renderArtifact(input, opts);

    expect(html).not.toContain("entities/xxx");
    expect(html).toContain("来源");
  });

  it("includes privacy warning when anonymize=true", () => {
    const input: ArtifactInput = { kind: "grounded", data: makeGroundedResult() };
    const opts: RenderOptions = { ...defaultOptions, anonymize: true };
    const html = renderArtifact(input, opts);

    expect(html).toContain("仅来源标识已匿名");
    expect(html).toContain("正文内容可能包含可识别信息");
  });

  it("no privacy warning when anonymize=false", () => {
    const input: ArtifactInput = { kind: "grounded", data: makeGroundedResult() };
    const html = renderArtifact(input, defaultOptions);

    expect(html).not.toContain("仅来源标识已匿名");
  });

  it("claim text with private names is NOT anonymized", () => {
    const result: GroundedRecallResult = {
      query: "人物A的项目",
      answer: "人物A负责后端架构",
      confidence: "high",
      facts: ["人物A主导了数据库迁移"],
      user_thoughts: [],
      candidates: [],
      conflicts: [],
      gaps: [],
      sources: [{ slug: "entities/zhangsan", evidence_count: 1 }],
      must_not_claim: [],
    };
    const input: ArtifactInput = { kind: "grounded", data: result };
    const opts: RenderOptions = { ...defaultOptions, anonymize: true };
    const html = renderArtifact(input, opts);

    expect(html).not.toContain("entities/zhangsan");
    expect(html).toContain("人物A主导了数据库迁移");
  });
});

describe("renderArtifact — empty result", () => {
  it("renders valid HTML even with all arrays empty", () => {
    const emptyGrounded: GroundedRecallResult = {
      query: "",
      answer: "",
      confidence: "low",
      facts: [],
      user_thoughts: [],
      candidates: [],
      conflicts: [],
      gaps: [],
      sources: [],
      must_not_claim: [],
    };
    const input: ArtifactInput = { kind: "grounded", data: emptyGrounded };
    const html = renderArtifact(input, defaultOptions);

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Generated by CBrain");
  });
});
