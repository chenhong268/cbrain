/**
 * CBrain 2.0 UX Contract — Release Gate Tests
 *
 * Each test maps to a contract in docs/product/cbrain-2.0-ux-contract.md.
 * Breaking any of these = blocking release.
 *
 * These are structural invariant checks — they verify constants, defaults,
 * and shapes without spinning up a full MCP server.
 */
import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { formatIngestResult, formatDialogueResult, formatRecallEnvelope, formatGroundedRecallEnvelope, formatQueryEnvelope, formatGetPageEnvelope, formatSummarizeEnvelope, formatEpisodeEnvelope, formatOrgTreeEnvelope, formatDiscoveriesEnvelope, formatGetPagesEnvelope } from "../../src/mcp/tools/format-result.js";
import type { IngestResult } from "../../src/core/ingestion/ingest.js";
import type { DialogueIngestResult } from "../../src/core/ingestion/dialogue.js";

// ─── C1: CaptureEnvelope 三层输出 ────────────────────────────

describe("C1: CaptureEnvelope structure", () => {
  const stubIngest: IngestResult = {
    slug: "brain/records/test",
    created: true,
    linksExtracted: 0,
    outcome: "created",
  };

  const stubDialogue: DialogueIngestResult = {
    decision: "recorded",
    newEntities: 2,
    newRelations: 1,
    newEvents: 0,
    skipped: 0,
    filtered: [],
  };

  test("formatIngestResult returns display + summary + raw", () => {
    const result = formatIngestResult(stubIngest, "Test");
    expect(result).toHaveProperty("display");
    expect(result).toHaveProperty("summary");
    expect(result).toHaveProperty("raw");
    expect(typeof result.display).toBe("string");
    expect(result.display.length).toBeGreaterThan(0);
    expect(result.summary).toHaveProperty("status");
    expect(result.summary).toHaveProperty("title");
    expect(result.summary).toHaveProperty("message");
  });

  test("formatDialogueResult returns display + summary + raw", () => {
    const result = formatDialogueResult(stubDialogue);
    expect(result).toHaveProperty("display");
    expect(result).toHaveProperty("summary");
    expect(result).toHaveProperty("raw");
    expect(typeof result.display).toBe("string");
    expect(result.display.length).toBeGreaterThan(0);
    expect(result.summary).toHaveProperty("status");
  });

  test("summary.status is one of the allowed values", () => {
    const ingestResult = formatIngestResult(stubIngest, "Test");
    expect(["recorded", "skipped", "needs_review"]).toContain(ingestResult.summary.status);

    const dialogueResult = formatDialogueResult(stubDialogue);
    expect(["recorded", "skipped", "needs_review"]).toContain(dialogueResult.summary.status);
  });

  test("display does not contain internal identifiers", () => {
    const BANNED = ["slug", "chunk", "source_id", "ner_candidates", "stubsCreated"];
    const result = formatIngestResult(stubIngest, "Test");
    for (const term of BANNED) {
      expect(result.display.toLowerCase()).not.toContain(term.toLowerCase());
    }
  });

  test("high-frequency tools produce display + summary + raw envelope", () => {
    // All 8 format functions return { display, summary, raw }
    const formatters = [
      () => formatRecallEnvelope({ query: "test", entities: [] }),
      () => formatGroundedRecallEnvelope({ query: "test", grounded_answer: { facts: [], candidates: [], gaps: [], conflicts: [] } }),
      () => formatQueryEnvelope({ results: [] }),
      () => formatGetPageEnvelope({ title: "Test", body_length: 100, has_more: false }),
      () => formatSummarizeEnvelope({ topic: "test", entities: [] }),
      () => formatEpisodeEnvelope({
        query: "test", summary: "none", candidates: [],
        search_meta: { time_parsed: null, tokens_used: [], total_scanned: 0, hints_applied: [] },
        diagnostics: { clues_checked: [] },
      } as any),
      () => formatOrgTreeEnvelope({
        seed: { slug: "a", title: "A", type: "entity" },
        upward: [], downward: [], warnings: [],
      }),
      () => formatDiscoveriesEnvelope({ cards: [] }),
      () => formatGetPagesEnvelope({ slugs: ["a", "b"], detail: "brief", found: 2, missing: 0 }),
    ];

    for (const fn of formatters) {
      const result = fn();
      expect(result).toHaveProperty("display");
      expect(result).toHaveProperty("summary");
      expect(result).toHaveProperty("raw");
      expect(typeof result.display).toBe("string");
      expect(result.display.length).toBeGreaterThan(0);
      expect(result.summary).toHaveProperty("status");
      expect(result.summary).toHaveProperty("count");
      expect(result.summary).toHaveProperty("truncated");
      expect(result.summary).toHaveProperty("message");
      expect(result.raw).toBeDefined();
    }
  });
});

// ─── C3: query 是底层能力 ────────────────────────────────────

describe("C3: query is foundational, not user-facing", () => {
  const TOOLS_DIR = path.resolve(import.meta.dir, "../../src/mcp/tools");
  const SKILLS_DIR = path.resolve(import.meta.dir, "../../skills");

  test("query description brands it as debug/底层 tool", () => {
    const source = fs.readFileSync(path.join(TOOLS_DIR, "search.ts"), "utf-8");
    // Must contain explicit debug/底层 language
    expect(source).toMatch(/底层|调试|debug|仅限/);
  });

  test("query description mentions deep_recall as preferred", () => {
    const source = fs.readFileSync(path.join(TOOLS_DIR, "search.ts"), "utf-8");
    expect(source).toContain("deep_recall");
  });

  test("query description lists routing alternatives", () => {
    const source = fs.readFileSync(path.join(TOOLS_DIR, "search.ts"), "utf-8");
    // Must mention the routing table: 事实回忆 → deep_recall, etc.
    expect(source).toMatch(/summarize/);
    expect(source).toMatch(/recall_episode/);
    expect(source).toMatch(/get_org_tree/);
  });

  test("RESOLVER catch-all routes natural language to deep_recall, not query", () => {
    const resolver = fs.readFileSync(path.join(SKILLS_DIR, "RESOLVER.md"), "utf-8");
    // Natural language catch-all must use [deep_recall] flag, not bare query.md
    expect(resolver).toMatch(/\[deep_recall\]/);
    expect(resolver).toMatch(/\[keyword\]/);
  });

  test("recall-resolver marks query as 底层/调试 tool", () => {
    const rr = fs.readFileSync(path.join(SKILLS_DIR, "recall-resolver.md"), "utf-8");
    expect(rr).toMatch(/底层|调试|debug|仅限.*关键词/);
  });
});

// ─── C4: EvidenceBoard 结构完整性 ────────────────────────────

describe("C4: GroundedRecallResult structure", () => {
  test("grounded-answer.ts exports required fields", async () => {
    const mod = await import("../../src/core/grounded-answer.js");
    expect(mod).toBeDefined();
    // Verify GroundedRecallResult shape by checking the builder exists
    expect(typeof mod.buildGroundedRecall).toBe("function");
  });

  test("evidence.ts exports EvidenceBoard with build method", async () => {
    const mod = await import("../../src/core/evidence.js");
    expect(mod.EvidenceBoard).toBeDefined();
    // EvidenceBoard requires a db parameter — verify class has build()
    const source = fs.readFileSync(
      path.resolve(import.meta.dir, "../../src/core/evidence.ts"),
      "utf-8",
    );
    expect(source).toContain("build()");
  });
});

// ─── C5: proactive 预算上限 ──────────────────────────────────

describe("C5: proactive budget limits", () => {
  test("trimHint caps text at ~120 chars (truncation adds ellipsis)", async () => {
    const { trimHint } = await import("../../src/mcp/tools/trim.js");
    const hint = {
      rule: "network_timeline" as const,
      text: "A".repeat(200),
      score: 0.85,
      why: "test why",
    };
    const trimmed = trimHint(hint);
    // truncate(str, 120) produces max 123 chars (120 + "...")
    expect(trimmed.text.length).toBeLessThanOrEqual(123);
    expect(trimmed.text.endsWith("...")).toBe(true);
  });

  test("trimHint rounds score to 2 decimal places", async () => {
    const { trimHint } = await import("../../src/mcp/tools/trim.js");
    const hint = {
      rule: "shared_connection" as const,
      text: "short",
      score: 0.123456,
      why: "test why",
    };
    const trimmed = trimHint(hint);
    // Should be rounded to 0.12
    expect(trimmed.score).toBe(0.12);
  });

  test("MIN_SCORE threshold is 0.5 in proactive engine source", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dir, "../../src/core/proactive.ts"),
      "utf-8",
    );
    expect(source).toContain("MIN_SCORE = 0.5");
  });

  test("truncateText caps at specified length", async () => {
    // Read the source to verify the constant
    const source = fs.readFileSync(
      path.resolve(import.meta.dir, "../../src/core/proactive.ts"),
      "utf-8",
    );
    // All hint texts are truncated to 120 chars
    expect(source).toMatch(/truncateText\(text,\s*120\)/);
  });

  test("proactive errors never propagate — try-catch returns []", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dir, "../../src/core/proactive.ts"),
      "utf-8",
    );
    // Main function has catch { return []; }
    expect(source).toContain("return []");
    expect(source).toContain("Never block the main response");
  });

  test("search.ts must NOT contain forced hint display instructions", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dir, "../../src/mcp/tools/search.ts"),
      "utf-8",
    );
    // These phrases force the agent to show all hints verbatim — banned by C5
    const bannedPhrases = [
      "必须把每一条 hint 原样展示",
      "逐条列出",
      "💡 主动提示",
    ];
    for (const phrase of bannedPhrases) {
      expect(source).not.toContain(phrase);
    }
  });

  test("recall.ts enforces max-1 hint display to user", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dir, "../../src/mcp/tools/recall.ts"),
      "utf-8",
    );
    // recall.ts should have the correct policy: default no display, max 1 if shown
    expect(source).toContain("默认不展示");
    expect(source).toContain("禁止逐条列出");
    expect(source).toContain("禁止使用");
  });

  test("applyProactiveBudget returns at most 1 hint with why", async () => {
    const { applyProactiveBudget } = await import("../../src/mcp/tools/trim.js");
    const hints = [
      { rule: "network_timeline", text: "hint 1", score: 0.9, why: "changes conclusion", target_slug: "a", age_days: 1 },
      { rule: "shared_connection", text: "hint 2", score: 0.8, why: "reveals hidden link", target_slug: "b" },
      { rule: "expiry_alert", text: "hint 3", score: 0.7, why: "data may be stale", target_slug: "c" },
    ];
    const result = applyProactiveBudget(hints, { grounded: false, toolType: "recall" });
    expect(result.length).toBe(1);
    expect(result[0].score).toBe(0.9);
    expect(result[0].why).toBe("changes conclusion");
  });

  test("applyProactiveBudget returns [] for grounded mode", async () => {
    const { applyProactiveBudget } = await import("../../src/mcp/tools/trim.js");
    const hints = [
      { rule: "network_timeline", text: "hint 1", score: 0.9, why: "important" },
      { rule: "expiry_alert", text: "hint 2", score: 1.0, why: "expired" },
    ];
    const result = applyProactiveBudget(hints, { grounded: true, toolType: "recall" });
    expect(result).toEqual([]);
  });

  test("applyProactiveBudget filters below threshold", async () => {
    const { applyProactiveBudget } = await import("../../src/mcp/tools/trim.js");
    const hints = [
      { rule: "network_timeline", text: "hint 1", score: 0.3, why: "something" },
      { rule: "expiry_alert", text: "hint 2", score: 0.2, why: "something else" },
    ];
    const result = applyProactiveBudget(hints, { grounded: false, toolType: "recall", minScore: 0.5 });
    expect(result).toEqual([]);
  });

  test("applyProactiveBudget returns [] for empty input", async () => {
    const { applyProactiveBudget } = await import("../../src/mcp/tools/trim.js");
    expect(applyProactiveBudget([], { grounded: false, toolType: "recall" })).toEqual([]);
  });

  test("applyProactiveBudget filters stale network_timeline hints (>7 days)", async () => {
    const { applyProactiveBudget } = await import("../../src/mcp/tools/trim.js");
    const hints = [
      { rule: "network_timeline", text: "old event", score: 0.9, why: "was relevant", target_slug: "a", age_days: 14 },
    ];
    const result = applyProactiveBudget(hints, { grounded: false, toolType: "recall" });
    expect(result).toEqual([]);
  });

  test("applyProactiveBudget keeps fresh network_timeline hints (<=7 days)", async () => {
    const { applyProactiveBudget } = await import("../../src/mcp/tools/trim.js");
    const hints = [
      { rule: "network_timeline", text: "fresh event", score: 0.9, why: "changes conclusion", target_slug: "a", age_days: 3 },
    ];
    const result = applyProactiveBudget(hints, { grounded: false, toolType: "recall" });
    expect(result.length).toBe(1);
    expect(result[0].why).toBe("changes conclusion");
  });

  test("applyProactiveBudget exempts expiry_alert from stale filter", async () => {
    const { applyProactiveBudget } = await import("../../src/mcp/tools/trim.js");
    const hints = [
      { rule: "expiry_alert", text: "expired page", score: 1.0, why: "data is stale", target_slug: "b", age_days: 90 },
    ];
    const result = applyProactiveBudget(hints, { grounded: false, toolType: "recall" });
    expect(result.length).toBe(1);
  });

  test("applyProactiveBudget filters duplicate rule+target combinations", async () => {
    const { applyProactiveBudget } = await import("../../src/mcp/tools/trim.js");
    const hints = [
      { rule: "network_timeline", text: "event v1", score: 0.9, why: "relevant", target_slug: "same-target", age_days: 1 },
      { rule: "network_timeline", text: "event v2", score: 0.8, why: "also relevant", target_slug: "same-target", age_days: 2 },
    ];
    const result = applyProactiveBudget(hints, { grounded: false, toolType: "recall" });
    // Only 1 survives dedup + max-1 cap
    expect(result.length).toBe(1);
    expect(result[0].score).toBe(0.9);
  });

  test("applyProactiveBudget discards hints without why", async () => {
    const { applyProactiveBudget } = await import("../../src/mcp/tools/trim.js");
    const hints = [
      { rule: "network_timeline", text: "no reason", score: 0.9, target_slug: "a", age_days: 1 },
    ];
    const result = applyProactiveBudget(hints, { grounded: false, toolType: "recall" });
    expect(result).toEqual([]);
  });
});

// ─── C6: 渐进披露常量 ────────────────────────────────────────

describe("C6: progressive disclosure constants", () => {
  test("summarize TOP_N = 3", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dir, "../../src/mcp/tools/summarize.ts"),
      "utf-8",
    );
    expect(source).toMatch(/TOP_N\s*=\s*3/);
  });

  test("deep_recall detail default is 'brief'", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dir, "../../src/mcp/tools/recall.ts"),
      "utf-8",
    );
    // Zod default should be "brief"
    expect(source).toMatch(/detail.*default.*"brief"/);
  });

  test("get_page body truncation at 1500 chars", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dir, "../../src/mcp/tools/trim.ts"),
      "utf-8",
    );
    // trimPageBody defaults to 1500
    expect(source).toMatch(/trimPageBody.*1500|maxChars.*1500/);
  });

  test("agentic_research has 3 budget tiers", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dir, "../../src/mcp/tools/agentic-research.ts"),
      "utf-8",
    );
    expect(source).toContain("brief");
    expect(source).toContain("normal");
    expect(source).toContain("full");
    expect(source).toMatch(/DETAIL_BUDGET/);
  });

  test("_stub flag exists for stub entities", async () => {
    const { stubEntity } = await import("../../src/mcp/tools/trim.js");
    const result = stubEntity({ slug: "test", score: 0.5, snippet: "test", source: "vector" }, null);
    expect(result._stub).toBe(true);
  });
});

// ─── C7: 失败降级结构 ────────────────────────────────────────

describe("C7: failure degradation structure", () => {
  test("PipelineStatus union type is correct", async () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dir, "../../src/core/agentic/pipeline.ts"),
      "utf-8",
    );
    // Verify the status type is defined with all 4 values
    expect(source).toMatch(/PipelineStatus.*=.*"ok".*"partial".*"degraded".*"insufficient"/);
    // Verify fallback planner exists (not exported, but must be in source)
    expect(source).toContain("buildMinimalFallback");
  });

  test("SearchTrace has degraded_reason field", async () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dir, "../../src/core/search.ts"),
      "utf-8",
    );
    expect(source).toContain("degraded_reason");
    expect(source).toContain("vector_timeout");
  });

  test("degraded search returns structured metadata, not raw error", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dir, "../../src/mcp/tools/search.ts"),
      "utf-8",
    );
    // Must include degraded: true in response
    expect(source).toContain("degraded: true");
    expect(source).toContain("vector_skipped");
    expect(source).toContain("latency_ms");
  });
});

// ─── C8: 隐私扫描 — 无真实人名 ──────────────────────────────

describe("C8: no real names in docs/tests", () => {
  const ROOT = path.resolve(import.meta.dir, "../..");

  test("product docs don't leak private vault paths or real identifiers", () => {
    const docsDir = path.join(ROOT, "docs/product");
    if (!fs.existsSync(docsDir)) return;

    const files = walkDir(docsDir, [".md"]);
    for (const file of files) {
      const content = fs.readFileSync(file, "utf-8");
      // No real iCloud paths
      expect(content).not.toContain("iCloud~md~obsidian");
      // No real home directory paths
      expect(content).not.toMatch(/\/Users\/[^/]+\/(?!Projects)/);
      // No real SQLite paths
      expect(content).not.toContain("brain.sqlite");
    }
  });

  test("routing eval files don't contain blacklisted real-world identifiers", () => {
    const evalDir = path.join(ROOT, "skills");
    if (!fs.existsSync(evalDir)) return;

    // Only REAL identifiers are banned. Generic placeholders are OK:
    // PersonA, EntityA, OrgA, TopicA, VP-Engineering etc.
    const REAL_WORLD_BLACKLIST = [
      // No real phone numbers
      /1[3-9]\d{9}/,
    ];

    const evalFiles = walkDir(evalDir, [".jsonl"]);
    for (const file of evalFiles) {
      const content = fs.readFileSync(file, "utf-8");
      for (const pattern of REAL_WORLD_BLACKLIST) {
        expect(content).not.toMatch(pattern);
      }
    }
  });

  test("test fixtures use generic placeholder names", () => {
    const testFiles = walkDir(path.join(ROOT, "tests"), [".ts"]);
    let checkedCount = 0;
    for (const file of testFiles) {
      const content = fs.readFileSync(file, "utf-8");
      // No real email addresses
      expect(content).not.toMatch(/[a-z]+@[a-z]+\.(com|cn|org)/);
      checkedCount++;
    }
    expect(checkedCount).toBeGreaterThan(0);
  });

  test("utility tests (tests/utils/**) use anonymous placeholders, not real identifiers (#202)", () => {
    // #202: tests/utils/** example fixtures get copied into docs, issues, and
    // release reports. They must use anonymous placeholders (实体A / 组织B /
    // 主题C / 产品D / TopicA / TermA / OrgA), never real person names, product
    // names, model names, or company names. Grey-area concept/book names
    // (第一性原理 / 反脆弱) are anonymized in fixtures but NOT banned here.
    const utilsDir = path.join(ROOT, "tests/utils");
    if (!fs.existsSync(utilsDir)) return;

    const files = walkDir(utilsDir, [".ts"]);
    const IDENTIFIABLE = [
      // 真实常见人名（中文 + 拼音形式）
      /张三|李四|王五|赵六/,
      /zhang[-_]?san|li[-_]?si|wang[-_]?wu/,
      // 真实公司 / 产品 / 模型名
      /\bOpenAI\b|\bChatGPT\b|\bGPT[-_]?\d/i,
      /\bClaude\b|\bAnthropic\b|\bDeepSeek\b/i,
      /智谱|ChatGLM|\bGLM[-_]?\d/i,
    ];

    let checkedCount = 0;
    for (const file of files) {
      const content = fs.readFileSync(file, "utf-8");
      for (const pattern of IDENTIFIABLE) {
        expect(content).not.toMatch(pattern);
      }
      checkedCount++;
    }
    expect(checkedCount).toBeGreaterThan(0);
  });
});

// ─── C9: 渐进披露路由规则 ─────────────────────────────────────

describe("C9: progressive disclosure routing", () => {
  const TOOLS_DIR = path.resolve(import.meta.dir, "../../src/mcp/tools");
  const SKILLS_DIR = path.resolve(import.meta.dir, "../../skills");

  test("recall.ts source contains first-round hard gate text", () => {
    const source = fs.readFileSync(path.join(TOOLS_DIR, "recall.ts"), "utf-8");
    // Must explicitly forbid get_page/expand_entity in first round
    expect(source).toContain("禁止");
    expect(source).toMatch(/get_page/);
    expect(source).toMatch(/expand_entity/);
  });

  test("recall.ts description states condition for second-round expansion", () => {
    const source = fs.readFileSync(path.join(TOOLS_DIR, "recall.ts"), "utf-8");
    // Must state the trigger words for allowing second-round tools
    expect(source).toMatch(/展开|原文|详细/);
  });

  test("recall-resolver.md mentions first-round/second-round pattern", () => {
    const rr = fs.readFileSync(path.join(SKILLS_DIR, "recall-resolver.md"), "utf-8");
    // Must describe the two-round discipline
    expect(rr).toMatch(/首轮|第一轮/);
    // Must describe the trigger for second round
    expect(rr).toMatch(/展开|原文|详细|继续/);
  });

  test("hermes-cbrain-brief.md mentions first-round constraint", () => {
    const brief = fs.readFileSync(path.join(SKILLS_DIR, "hermes-cbrain-brief.md"), "utf-8");
    expect(brief).toMatch(/首轮.*禁止|禁止.*首轮/);
  });

  test("hermes-cbrain-brief.md stays within 3000 bytes", () => {
    const brief = fs.readFileSync(path.join(SKILLS_DIR, "hermes-cbrain-brief.md"), "utf-8");
    expect(Buffer.byteLength(brief, "utf-8")).toBeLessThanOrEqual(3000);
  });
});

// ─── C10: degraded reason codes display safety ──────────────

describe("C10: degraded reason codes display safety", () => {
  test("DISPLAY_BANNED_TERMS includes reason_codes", async () => {
    const { DISPLAY_BANNED_TERMS } = await import("../../src/mcp/tools/format-result.js");
    expect(DISPLAY_BANNED_TERMS).toContain("reason_codes");
  });

  test("query envelope display/summary never contain reason_codes", () => {
    const payload = {
      results: [{ snippet: "test" }],
      degraded: true,
      vector_skipped: "timeout" as const,
      latency_ms: 3000,
      search_meta: { strategy: "smart", latency_ms: 3000, degraded: true, reason_codes: ["vector_timeout", "fts_empty"] },
    };
    const { display, summary } = formatQueryEnvelope(payload);
    expect(display).not.toContain("reason_codes");
    expect(JSON.stringify(summary)).not.toContain("reason_codes");
    expect(display).not.toContain("vector_timeout");
    expect(display).not.toContain("fts_empty");
  });

  test("query envelope non-vector degraded shows generic message, not '向量搜索异常'", () => {
    const payload = {
      results: [{ snippet: "test" }],
      degraded: true,
      search_meta: { strategy: "smart", latency_ms: 3000, degraded: true, reason_codes: ["low_score"] },
    };
    const { display } = formatQueryEnvelope(payload);
    expect(display).not.toContain("向量搜索异常");
    expect(display).not.toContain("向量搜索超时");
    expect(display).toContain("搜索未达最佳效果");
  });

  test("recall envelope display/summary never contain reason_codes", () => {
    const payload = {
      query: "test",
      entities: [{ title: "A" }, { title: "B" }],
      search_meta: { strategy: "smart", latency_ms: 100, degraded: true, reason_codes: ["fts_empty", "low_score"] },
      summary: "找到 2 个实体",
    };
    const { display, summary } = formatRecallEnvelope(payload);
    expect(display).not.toContain("reason_codes");
    expect(JSON.stringify(summary)).not.toContain("reason_codes");
  });

  test("grounded recall envelope display/summary never contain reason_codes", () => {
    const payload = {
      query: "test",
      grounded_answer: { facts: [], candidates: [], gaps: [], conflicts: [], confidence: "low" },
      search_meta: { strategy: "smart", latency_ms: 100, reason_codes: ["budget_exhausted"] },
    };
    const { display, summary } = formatGroundedRecallEnvelope(payload);
    expect(display).not.toContain("reason_codes");
    expect(JSON.stringify(summary)).not.toContain("reason_codes");
    expect(display).not.toContain("budget_exhausted");
  });

  test("envelope raw retains reason_codes in search_meta", () => {
    const payload = {
      results: [{ snippet: "test" }],
      search_meta: { strategy: "smart", latency_ms: 100, reason_codes: ["low_score"] },
    };
    const { raw } = formatQueryEnvelope(payload);
    const meta = (raw as { search_meta?: { reason_codes?: string[] } }).search_meta;
    expect(meta?.reason_codes).toEqual(["low_score"]);
  });
});

// ─── #206: display 通俗化，禁内部术语/机械状态报告 ────────────

describe("#206: 高频 formatter display 不含内部术语", () => {
  // 这些词不该出现在用户可见的 display / summary.message 里
  const JARGON = ["节点", "Tier", "candidate", "候选", "缺口", "score", "vector", "fts", "lancedb"];

  function assertNoJargon(text: string, label: string): void {
    for (const term of JARGON) {
      expect(text, `${label} 含内部术语 "${term}"`).not.toContain(term);
    }
  }

  test("recall display 通俗化，先结论", () => {
    const r = formatRecallEnvelope({ query: "主题A", entities: [{ title: "实体A" }, { title: "实体B" }] });
    assertNoJargon(r.display, "recall display");
    assertNoJargon(r.summary.message, "recall message");
    expect(r.display).toContain("记忆");
  });

  test("grounded recall display/message 去候选/缺口术语", () => {
    const r = formatGroundedRecallEnvelope({
      query: "主题A",
      grounded_answer: {
        facts: [{ claim: "x" }],
        candidates: [{ claim: "y" }],
        gaps: [{ description: "z" }],
        conflicts: [],
      },
    });
    assertNoJargon(r.display, "grounded display");
    assertNoJargon(r.summary.message, "grounded message");
  });

  test("query display 通俗化", () => {
    const r = formatQueryEnvelope({ results: [{ snippet: "a" }, { snippet: "b" }] });
    assertNoJargon(r.display, "query display");
  });

  test("get_page display 通俗化", () => {
    const r = formatGetPageEnvelope({ title: "页面A", body_length: 1000, has_more: false });
    assertNoJargon(r.display, "get_page display");
  });

  test("summarize display 去实体/链接计数式表述", () => {
    const r = formatSummarizeEnvelope({
      topic: "主题A",
      entities: [{ title: "实体A" }],
      stats: { totalLinks: 2, totalEvents: 1 },
    });
    assertNoJargon(r.display, "summarize display");
    expect(r.display).not.toContain("个实体");
    expect(r.display).not.toContain("个链接");
  });

  test("episode display 去候选术语", () => {
    const r = formatEpisodeEnvelope({
      query: "x", summary: "s",
      candidates: [{ slug: "a", title: "人物A", score: 0.8, confidence: "high", matched_clues: [], evidence: [], next_disambiguating_clue: null }],
      search_meta: { time_parsed: null, tokens_used: [], total_scanned: 0, hints_applied: [] },
      diagnostics: { clues_checked: [] },
    } as never);
    assertNoJargon(r.display, "episode display");
    expect(r.display).not.toContain("候选");
  });

  test("org_tree display 去节点术语", () => {
    const r = formatOrgTreeEnvelope({
      seed: { slug: "a", title: "组织A", type: "entity" },
      upward: [{ slug: "b", title: "上级A", type: "entity", depth: 1, parent_slug: "a" }],
      downward: [{ slug: "c", title: "下属A", type: "entity", depth: 1, parent_slug: "a" }],
      warnings: [],
    } as never);
    assertNoJargon(r.display, "org_tree display");
    expect(r.display).not.toContain("节点");
  });
});

// ─── Helpers ──────────────────────────────────────────────────

function walkDir(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, extensions));
    } else if (extensions.some(ext => entry.name.endsWith(ext))) {
      results.push(fullPath);
    }
  }
  return results;
}
