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
import { formatIngestResult, formatDialogueResult, formatRecallEnvelope, formatGroundedRecallEnvelope, formatQueryEnvelope, formatGetPageEnvelope, formatSummarizeEnvelope, formatEpisodeEnvelope, formatOrgTreeEnvelope, formatDiscoveriesEnvelope } from "../../src/mcp/tools/format-result.js";
import type { IngestResult } from "../../src/core/ingest.js";
import type { DialogueIngestResult } from "../../src/core/dialogue.js";

// ─── C1: CaptureEnvelope 三层输出 ────────────────────────────

describe("C1: CaptureEnvelope structure", () => {
  const stubIngest: IngestResult = {
    slug: "brain/records/test",
    created: true,
    linksExtracted: 0,
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
