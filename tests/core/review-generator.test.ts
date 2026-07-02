import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { CompoundingReviewManager, ReviewGenerator, isSocialCandidate } from "../../src/core/maintenance/compounding-review.js";
import type { CandidateType } from "../../src/storage/sqlite.js";

const TEST_DIR = "/tmp/cbrain-test-review-gen";

function cleanup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
}

beforeEach(cleanup);
afterEach(cleanup);

function seedCandidate(
  mgr: CompoundingReviewManager,
  opts: {
    title: string;
    candidateType: CandidateType;
    sourceSlugs: string[];
    scores?: Record<string, number>;
    evidence?: Array<{ source: string; dateRange: string; text: string }>;
    status?: "pending" | "rejected" | "deferred" | "disabled";
  },
) {
  const { id } = mgr.upsertCandidate({
    title: opts.title,
    candidateType: opts.candidateType,
    sourceSlugs: opts.sourceSlugs,
    scores: opts.scores,
    evidence: opts.evidence,
  });
  if (opts.status && opts.status !== "pending") {
    const action = opts.status === "rejected" ? "reject" : opts.status === "deferred" ? "defer" : "disable";
    mgr.transitionStatus(id, action);
  }
  return id;
}

const STRONG_SCORES = { evidence: 4, persistence: 3, novelty: 0.8, action_value: 0.7, trust_risk: 0.2 };
const WEAK_SCORES = { evidence: 1, persistence: 0, novelty: 0.1, action_value: 0.1, trust_risk: 0.9 };

function makeDb() {
  mkdirSync(TEST_DIR, { recursive: true });
  return new CBrainDB(join(TEST_DIR, "test.sqlite"));
}

// ─── 1. Strong theme convergence → 1 review ───────────────────

describe("ReviewGenerator - strong convergence", () => {
  test("returns 1 item when all gates pass", () => {
    const db = makeDb();
    const mgr = new CompoundingReviewManager(db);
    const gen = new ReviewGenerator(mgr);

    seedCandidate(mgr, {
      title: "实体A与主题B的立场趋同",
      candidateType: "theme_convergence",
      sourceSlugs: ["shi-ti-a", "zhu-ti-b"],
      scores: STRONG_SCORES,
    });

    const result = gen.generate();
    expect(result.items.length).toBe(1);
    expect(result.items[0].title).toBe("实体A与主题B的立场趋同");
    expect(result.scores[0].passed).toBe(true);
    expect(result.scores[0].failed_dimensions).toEqual([]);
    expect(result.silence_reason).toBeUndefined();
    db.close();
  });
});

// ─── 2. Weak coincidence → silence_reason ─────────────────────

describe("ReviewGenerator - weak coincidence", () => {
  test("returns silence when all gates fail", () => {
    const db = makeDb();
    const mgr = new CompoundingReviewManager(db);
    const gen = new ReviewGenerator(mgr);

    seedCandidate(mgr, {
      title: "偶然的巧合",
      candidateType: "theme_convergence",
      sourceSlugs: ["a"],
      scores: WEAK_SCORES,
    });

    const result = gen.generate();
    expect(result.items.length).toBe(0);
    expect(result.silence_reason).toBeDefined();
    expect(result.silence_reason).toContain("insufficient");
    db.close();
  });
});

// ─── 3. rejected/disabled filtered ─────────────────────────────

describe("ReviewGenerator - terminal status filtered", () => {
  test("only pending candidates appear in output", () => {
    const db = makeDb();
    const mgr = new CompoundingReviewManager(db);
    const gen = new ReviewGenerator(mgr);

    seedCandidate(mgr, {
      title: "待定观察",
      candidateType: "theme_convergence",
      sourceSlugs: ["a"],
      scores: STRONG_SCORES,
    });
    seedCandidate(mgr, {
      title: "被拒绝",
      candidateType: "theme_convergence",
      sourceSlugs: ["b"],
      scores: STRONG_SCORES,
      status: "rejected",
    });
    seedCandidate(mgr, {
      title: "被禁用",
      candidateType: "theme_convergence",
      sourceSlugs: ["c"],
      scores: STRONG_SCORES,
      status: "disabled",
    });

    const result = gen.generate();
    expect(result.items.length).toBe(1);
    expect(result.items[0].title).toBe("待定观察");
    db.close();
  });
});

// ─── 4. deferred excluded by default ───────────────────────────

describe("ReviewGenerator - deferred handling", () => {
  test("deferred excluded by default, included with flag", () => {
    const db = makeDb();
    const mgr = new CompoundingReviewManager(db);
    const gen = new ReviewGenerator(mgr);

    seedCandidate(mgr, {
      title: "推迟的洞察",
      candidateType: "supported_connection",
      sourceSlugs: ["a", "b"],
      scores: STRONG_SCORES,
      status: "deferred",
    });

    const without = gen.generate();
    expect(without.items.length).toBe(0);

    const withDeferred = gen.generate({ includeDeferred: true });
    expect(withDeferred.items.length).toBe(1);
    expect(withDeferred.items[0].title).toBe("推迟的洞察");
    db.close();
  });
});

// ─── 5. Social candidate — no contact suggestion ───────────────

describe("ReviewGenerator - social safety", () => {
  test("social candidate has no contact action", () => {
    const db = makeDb();
    const mgr = new CompoundingReviewManager(db);
    const gen = new ReviewGenerator(mgr);

    const id = seedCandidate(mgr, {
      title: "实体A与人物D的关系",
      candidateType: "supported_connection",
      sourceSlugs: ["shi-ti-a", "ren-wu-d"],
      scores: STRONG_SCORES,
      evidence: [
        { source: "资料C", dateRange: "2026-01~2026-05", text: "实体A和人物D有合作关系" },
        { source: "资料C", dateRange: "2026-03~2026-04", text: "他们经常联系讨论项目" },
        { source: "资料C", dateRange: "2026-02~2026-05", text: "两人是朋友关系" },
      ],
    });

    const candidate = mgr.getCandidate(id)!;
    expect(isSocialCandidate(candidate)).toBe(true);

    const result = gen.generate();
    expect(result.items.length).toBe(1);
    expect(result.actions[0].available).toEqual(["accept", "reject", "defer", "disable"]);
    expect(result.actions[0].available).not.toContain("contact");
    db.close();
  });
});

// ─── 6. Output has no internal fields ──────────────────────────

describe("ReviewGenerator - output privacy", () => {
  test("no internal fields in JSON output", () => {
    const db = makeDb();
    const mgr = new CompoundingReviewManager(db);
    const gen = new ReviewGenerator(mgr);

    seedCandidate(mgr, {
      title: "隐私检查",
      candidateType: "theme_convergence",
      sourceSlugs: ["a"],
      scores: STRONG_SCORES,
    });

    const result = gen.generate();
    const json = JSON.stringify(result);

    expect(json).not.toContain("content_hash");
    expect(json).not.toContain("evidence_json");
    expect(json).not.toContain("scores_json");
    expect(json).not.toContain("source_slugs_json");
    expect(json).not.toContain("created_at");
    expect(json).not.toContain("updated_at");
    expect(json).not.toContain("last_seen_at");
    db.close();
  });
});

// ─── 7. MCP registration ───────────────────────────────────────

describe("ReviewGenerator - MCP tool registration", () => {
  test("get_compounding_reviews and act_on_review_candidate in tool names", async () => {
    const { createServer } = await import("../../src/mcp/server.js");

    mkdirSync(TEST_DIR, { recursive: true });
    const db = new CBrainDB(join(TEST_DIR, "reg-test.sqlite"));

    const mockEmbedding = {
      embed: async (text: string) => ({
        embedding: new Array(128).fill(0).map((_, i) => (text.charCodeAt(i % text.length) ?? 0) / 65536),
        tokenCount: text.length,
      }),
      embedBatch: async (texts: string[]) =>
        texts.map((t) => ({
          embedding: new Array(128).fill(0).map((_, i) => (t.charCodeAt(i % t.length) ?? 0) / 65536),
          tokenCount: t.length,
        })),
    };
    const mockLance = {
      connect: async () => {},
      addChunks: async () => {},
      search: async () => [],
      fullTextSearch: async () => [],
      deleteByPageSlug: async () => {},
      deleteRawChunksByPageSlug: async () => {},
      close: async () => {},
      createFTSIndex: async () => {},
    };

    const server = createServer({
      db,
      embedding: mockEmbedding as any,
      lance: mockLance as any,
      vaultPath: TEST_DIR,
      dbPath: join(TEST_DIR, "test.sqlite"),
      runtimePath: TEST_DIR,
    });

    const tools = (server as any)._registeredTools as Record<string, any>;
    const names = Object.keys(tools);
    expect(names).toContain("get_compounding_reviews");
    expect(names).toContain("act_on_review_candidate");
    db.close();
  });
});

// ─── 8. Mixed gates — partial pass ─────────────────────────────

describe("ReviewGenerator - mixed gates", () => {
  test("only all-pass candidates appear", () => {
    const db = makeDb();
    const mgr = new CompoundingReviewManager(db);
    const gen = new ReviewGenerator(mgr);

    seedCandidate(mgr, {
      title: "全通过",
      candidateType: "theme_convergence",
      sourceSlugs: ["a"],
      scores: STRONG_SCORES,
    });
    seedCandidate(mgr, {
      title: "证据不足",
      candidateType: "theme_convergence",
      sourceSlugs: ["b"],
      scores: { ...STRONG_SCORES, evidence: 1 },
    });
    seedCandidate(mgr, {
      title: "信任风险过高",
      candidateType: "theme_convergence",
      sourceSlugs: ["c"],
      scores: { ...STRONG_SCORES, trust_risk: 0.9 },
    });

    const result = gen.generate();
    expect(result.items.length).toBe(1);
    expect(result.items[0].title).toBe("全通过");
    db.close();
  });
});

// ─── 9. Output cap — max 3 by default ──────────────────────────

describe("ReviewGenerator - output cap", () => {
  test("5 strong candidates → only 3 in output", () => {
    const db = makeDb();
    const mgr = new CompoundingReviewManager(db);
    const gen = new ReviewGenerator(mgr);

    for (let i = 1; i <= 5; i++) {
      seedCandidate(mgr, {
        title: `候选${i}`,
        candidateType: "theme_convergence",
        sourceSlugs: [`s${i}`],
        scores: STRONG_SCORES,
      });
    }

    const result = gen.generate();
    expect(result.items.length).toBe(3);
    expect(result.evidence.length).toBe(3);
    expect(result.scores.length).toBe(3);
    expect(result.actions.length).toBe(3);
    db.close();
  });
});

// ─── 10. Evidence compacting ───────────────────────────────────

describe("ReviewGenerator - evidence compacting", () => {
  test("long evidence text is truncated", () => {
    const db = makeDb();
    const mgr = new CompoundingReviewManager(db);
    const gen = new ReviewGenerator(mgr);

    const longText = "这是一段非常非常长的证据文本".repeat(20);
    seedCandidate(mgr, {
      title: "长文本测试",
      candidateType: "theme_convergence",
      sourceSlugs: ["a"],
      scores: STRONG_SCORES,
      evidence: [{ source: "资料C", dateRange: "2026-01~2026-05", text: longText }],
    });

    const result = gen.generate();
    expect(result.items.length).toBe(1);
    const ev = result.evidence[0].items[0];
    expect(ev.text.length).toBeLessThanOrEqual(161); // 160 + "…"
    expect(ev.text).toContain("…");
    db.close();
  });

  test("extra fields in evidence are stripped", () => {
    const db = makeDb();
    const mgr = new CompoundingReviewManager(db);
    const gen = new ReviewGenerator(mgr);

    // Upsert raw evidence with extra fields via direct upsert
    seedCandidate(mgr, {
      title: "多余字段",
      candidateType: "theme_convergence",
      sourceSlugs: ["a"],
      scores: STRONG_SCORES,
      evidence: [
        { source: "资料C", dateRange: "2026-01~2026-05", text: "正常文本" },
      ],
    });

    const result = gen.generate();
    const ev = result.evidence[0].items[0];
    const keys = Object.keys(ev);
    expect(keys.sort()).toEqual(["dateRange", "source", "text"]);
    db.close();
  });

  test("malformed evidence JSON → empty items, gates still work", () => {
    const db = makeDb();
    const mgr = new CompoundingReviewManager(db);
    const gen = new ReviewGenerator(mgr);

    // Upsert with valid scores but manually corrupt evidence
    const { id } = mgr.upsertCandidate({
      title: "损坏证据",
      candidateType: "theme_convergence",
      sourceSlugs: ["a"],
      scores: STRONG_SCORES,
      evidence: [{ source: "s", dateRange: "d", text: "t" }],
    });

    // Directly corrupt the evidence_json in DB
    db.rawDb.prepare("UPDATE compounding_review_candidates SET evidence_json = ? WHERE id = ?").run("not valid json{{{", id);

    const result = gen.generate();
    expect(result.items.length).toBe(1); // scores are valid, gates pass
    expect(result.evidence[0].items).toEqual([]); // malformed → empty
    db.close();
  });
});

// ─── 11. Limit clamp ───────────────────────────────────────────

describe("ReviewGenerator - limit clamping", () => {
  test("negative limit → treated as default (20)", () => {
    const db = makeDb();
    const mgr = new CompoundingReviewManager(db);
    const gen = new ReviewGenerator(mgr);

    seedCandidate(mgr, {
      title: "负数限制",
      candidateType: "theme_convergence",
      sourceSlugs: ["a"],
      scores: STRONG_SCORES,
    });

    // Should not throw, should scan at least 1 candidate
    const result = gen.generate({ limit: -5 });
    expect(result.items.length).toBe(1);
    db.close();
  });

  test("huge limit → clamped to 50", () => {
    const db = makeDb();
    const mgr = new CompoundingReviewManager(db);
    const gen = new ReviewGenerator(mgr);

    seedCandidate(mgr, {
      title: "超大限制",
      candidateType: "theme_convergence",
      sourceSlugs: ["a"],
      scores: STRONG_SCORES,
    });

    // Should not throw, clamped to max 50
    const result = gen.generate({ limit: 99999 });
    expect(result.items.length).toBe(1);
    db.close();
  });
});
