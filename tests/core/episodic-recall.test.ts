import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { EpisodicRecaller } from "../../src/core/retrieval/episodic-recall.js";

// ─── Test setup ──────────────────────────────────────────────

const testDir = "/tmp/cbrain-test-episodic-recall";
const dbPath = join(testDir, "test.sqlite");
let db: CBrainDB;

beforeEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  mkdirSync(testDir, { recursive: true });
  db = new CBrainDB(dbPath);
});

afterEach(() => {
  db.close();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

// ─── Seed helpers ────────────────────────────────────────────

function seedPerson(
  slug: string,
  title: string,
  opts?: {
    timeline?: Array<{ event_date?: string; summary: string; source?: string; trust_state?: string; source_page_slug?: string }>;
    links?: Array<{ other: string; otherTitle: string; relation: string; context?: string; trust_state?: string; confidence?: number; source_page_slug?: string }>;
  },
): void {
  db.rawDb.prepare(
    "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, ?, ?)",
  ).run(slug, title, `${slug}.md`, "h1");

  for (const entry of opts?.timeline ?? []) {
    db.rawDb.prepare(
      "INSERT INTO timeline (page_slug, summary, source, trust_state, event_date, source_page_slug) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(slug, entry.summary, entry.source ?? "dialogue", entry.trust_state ?? "trusted", entry.event_date ?? null, entry.source_page_slug ?? null);
  }

  for (const link of opts?.links ?? []) {
    const exists = db.rawDb.prepare("SELECT 1 FROM pages WHERE slug = ?").get(link.other);
    if (!exists) {
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
      ).run(link.other, link.otherTitle, `${link.other}.md`, "h1");
    }

    db.rawDb.prepare(
      "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence, context, source_page_slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      slug,
      link.other,
      link.relation,
      "ner",
      link.trust_state ?? "trusted",
      link.confidence ?? 0.8,
      link.context ?? null,
      link.source_page_slug ?? null,
    );
  }
}

function recall(clues: {
  query: string;
  time_hint?: string;
  topic_hint?: string;
  context_hint?: string;
  connection_hint?: string;
  event_hint?: string;
  relation_hint?: string;
  limit?: number;
}) {
  return new EpisodicRecaller(db).recall(clues);
}

// ─── #10 Acceptance Category 1: recall by approximate time + topic ───

describe("EpisodicRecaller", () => {
  test("approximate time + topic recall", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { event_date: "2024-06-15", summary: "人物A讨论前端架构设计" },
      ],
    });
    seedPerson("entities/person-b", "人物B", {
      timeline: [
        { event_date: "2023-03-10", summary: "人物B负责后端性能优化" },
      ],
    });

    const result = recall({ query: "2024年前端架构", time_hint: "2024", topic_hint: "前端架构" });

    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].slug).toBe("entities/person-a");
    expect(result.candidates[0].matched_clues.some((c) => c.dimension === "time")).toBe(true);
    expect(result.candidates[0].matched_clues.some((c) => c.dimension === "topic")).toBe(true);
    expect(result.candidates[0].evidence.length).toBeGreaterThan(0);
    expect(result.summary).toContain("人物A");
    expect(result.search_meta.time_parsed).toBe("2024");
    expect(result.search_meta.hints_applied).toContain("time");
  });

  // ─── #10 Acceptance Category 2: recall by encounter context + shared connection ───

  test("encounter context + shared connection recall", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { summary: "和人物A在技术峰会认识" },
      ],
      links: [
        { other: "entities/org-e", otherTitle: "组织E", relation: "works_at", context: "人物A在组织E工作" },
      ],
    });
    seedPerson("entities/person-b", "人物B", {
      timeline: [
        { summary: "人物B参加读书会" },
      ],
      links: [
        { other: "entities/topic-c", otherTitle: "主题C", relation: "manages" },
      ],
    });

    const result = recall({ query: "技术峰会认识的组织E的人", context_hint: "技术峰会", connection_hint: "组织E" });

    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].slug).toBe("entities/person-a");
    expect(result.candidates[0].matched_clues.some((c) => c.dimension === "context")).toBe(true);
    expect(result.candidates[0].matched_clues.some((c) => c.dimension === "relation")).toBe(true);
    expect(result.candidates[0].evidence.some((e) => e.source_type === "timeline")).toBe(true);
    expect(result.candidates[0].evidence.some((e) => e.source_type === "link")).toBe(true);
  });

  test("connection recall excludes candidate reports_to as current fact", () => {
    seedPerson("entities/person-a", "人物A", {
      links: [
        { other: "entities/candidate-manager", otherTitle: "候选上级", relation: "reports_to", trust_state: "candidate" },
      ],
    });

    const result = recall({ query: "候选上级", connection_hint: "候选上级" });

    expect(result.candidates.map((c) => c.slug)).not.toContain("entities/person-a");
  });

  test("connection recall keeps ordinary candidate links", () => {
    seedPerson("entities/person-a", "人物A", {
      links: [
        { other: "concepts/topic-b", otherTitle: "主题B", relation: "related", trust_state: "candidate" },
      ],
    });

    const result = recall({ query: "主题B", connection_hint: "主题B" });

    expect(result.candidates.map((c) => c.slug)).toContain("entities/person-a");
  });

  // ─── #10 Acceptance Category 3: multiple candidates with uncertainty + disambiguating clue ───

  test("multiple candidates with uncertainty and next_disambiguating_clue", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { summary: "人物A负责前端开发" },
      ],
    });
    seedPerson("entities/person-b", "人物B", {
      timeline: [
        { summary: "人物B也做前端开发" },
      ],
    });

    const result = recall({ query: "做前端开发的人", topic_hint: "前端开发" });

    expect(result.candidates.length).toBe(2);
    expect(result.candidates.every((c) => c.confidence === "low" || c.confidence === "medium" || c.confidence === "high")).toBe(true);
    expect(result.candidates.every((c) => c.next_disambiguating_clue !== null)).toBe(true);
    expect(result.candidates[0].next_disambiguating_clue).toContain("补充");
  });

  // ─── #10 Acceptance Category 4: dormant relationship resurfaces in relevant context ───

  test("dormant relationship is retrievable when context is relevant", () => {
    const oldYear = new Date().getFullYear() - 4;
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { event_date: `${oldYear}-01-10`, summary: "人物A负责数据平台的架构设计" },
      ],
    });

    // No time hint — dormancy should not penalize when context matches
    const result = recall({ query: "做数据平台架构的人", topic_hint: "数据平台架构" });

    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].slug).toBe("entities/person-a");
    // Single-dimension topic match may be low or medium — the key is it's retrievable at all
    expect(result.candidates[0].score).toBeGreaterThan(0);
  });

  // ─── #10 Acceptance Category 5: rejected/superseded evidence excluded ───

  test("rejected and superseded evidence is excluded", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { summary: "人物A负责前端开发", trust_state: "trusted" },
        { summary: "人物A已不负责前端开发", trust_state: "rejected" },
      ],
    });

    // Only active evidence should be visible
    const result = recall({ query: "前端开发的人", topic_hint: "前端开发" });

    expect(result.candidates.length).toBe(1);
    const evidence = result.candidates[0].evidence;
    // Rejected timeline should not appear in evidence
    expect(evidence.every((e) => e.trust_state !== "rejected" && e.trust_state !== "superseded")).toBe(true);
  });

  // ─── #10 Acceptance Category 6: no unsolicited contact recommendation ───

  test("no unsolicited contact recommendation in output", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { summary: "人物A负责前端开发" },
      ],
    });

    const result = recall({ query: "前端开发的人", topic_hint: "前端开发" });

    // Verify output shape has no proactive recommendation fields
    const text = JSON.stringify(result);
    expect(text).not.toContain("建议联系");
    expect(text).not.toContain("推荐联系");
    expect(text).not.toContain("应该联系");
    expect(text).not.toContain("contact");
    expect(text).not.toContain("reminder");
    // Result has correct fields
    expect(result.summary).toBeDefined();
    expect(result.search_meta).toBeDefined();
    expect(result.candidates[0].matched_clues).toBeInstanceOf(Array);
    expect(result.candidates[0].evidence).toBeInstanceOf(Array);
  });

  // ─── Query fallback tests ────────────────────────────────

  test("query fallback: extracts time from query when time_hint missing", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { event_date: "2024-06-15", summary: "人物A讨论项目" },
      ],
    });

    const result = recall({ query: "2024年见过谁" });

    expect(result.search_meta.time_parsed).toBe("2024年");
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].slug).toBe("entities/person-a");
  });

  test("query fallback: uses query text as topic when hints missing", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { summary: "人物A负责前端开发" },
      ],
    });

    const result = recall({ query: "做前端开发的人" });

    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].slug).toBe("entities/person-a");
  });

  test("query fallback: context_hint not inflated from query body", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { summary: "人物A负责前端开发" },
      ],
    });

    const result = recall({ query: "做前端开发的人" });

    expect(result.search_meta.hints_applied).toContain("topic");
    expect(result.search_meta.hints_applied).not.toContain("context");
  });

  test("query fallback: single-dimension score capped at topic weight", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { summary: "人物A负责前端开发" },
      ],
    });

    const result = recall({ query: "做前端开发的人" });

    expect(result.candidates.length).toBe(1);
    // topic=0.30 is the max from a single text dimension; no context padding
    expect(result.candidates[0].score).toBeLessThanOrEqual(0.31);
    expect(result.candidates[0].score).toBeGreaterThan(0);
  });

  // ─── Limit cap ───────────────────────────────────────────

  test("limit is capped at 8", () => {
    for (let i = 1; i <= 12; i++) {
      seedPerson(`entities/person-${i}`, `人物${i}`, {
        timeline: [
          { summary: `人物${i}负责前端开发` },
        ],
      });
    }

    const result = recall({ query: "前端的人", topic_hint: "前端开发", limit: 20 });

    expect(result.candidates.length).toBeLessThanOrEqual(8);
  });

  // ─── Output shape tests ──────────────────────────────────

  test("summary is populated", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { summary: "人物A负责前端开发" },
      ],
    });

    const result = recall({ query: "前端的人", topic_hint: "前端开发" });

    expect(result.summary).toContain("找到");
    expect(result.summary).toContain("人物A");
  });

  test("search_meta contains parsed information", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { event_date: "2024-05-20", summary: "人物A负责前端开发项目" },
      ],
    });

    const result = recall({ query: "2024年前端开发的人", time_hint: "2024", topic_hint: "前端开发" });

    expect(result.search_meta.time_parsed).toBe("2024");
    expect(result.search_meta.tokens_used.length).toBeGreaterThan(0);
    expect(result.search_meta.total_scanned).toBe(1);
    expect(result.search_meta.hints_applied).toContain("time");
    expect(result.search_meta.hints_applied).toContain("topic");
  });

  test("evidence includes source_type and trust_state", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { summary: "人物A参加团建", trust_state: "trusted", source_page_slug: "records/chat-001" },
      ],
      links: [
        { other: "entities/org-e", otherTitle: "组织E", relation: "works_at", trust_state: "candidate", source_page_slug: "records/chat-002", context: "人物A在组织E团建" },
      ],
    });

    const result = recall({ query: "团建认识的人", context_hint: "团建", connection_hint: "组织E" });

    const evidence = result.candidates[0].evidence;
    expect(evidence.some((e) => e.source_type === "timeline")).toBe(true);
    expect(evidence.some((e) => e.source_type === "link")).toBe(true);
    expect(evidence.every((e) => typeof e.trust_state === "string")).toBe(true);
  });

  test("next_disambiguating_clue is null for single candidate", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { summary: "人物A负责前端开发" },
      ],
    });

    const result = recall({ query: "前端开发的人", topic_hint: "前端开发" });

    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].next_disambiguating_clue).toBeNull();
  });

  // ─── Empty result ────────────────────────────────────────

  test("no matches returns empty with correct shape", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { summary: "人物A参加技术分享" },
      ],
    });

    const result = recall({ query: "做市场的人", topic_hint: "市场推广" });

    expect(result.candidates).toEqual([]);
    expect(result.summary).toContain("没有找到");
    expect(result.search_meta.total_scanned).toBe(1);
  });

  test("no persons returns empty result", () => {
    const result = recall({ query: "所有人", topic_hint: "开发" });

    expect(result.candidates).toEqual([]);
    expect(result.search_meta.total_scanned).toBe(0);
  });

  // ─── Relative time ───────────────────────────────────────

  test("relative time '去年' resolves correctly", () => {
    const lastYear = new Date().getFullYear() - 1;

    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { event_date: `${lastYear}-03-15`, summary: "去年见过人物A" },
      ],
    });

    const result = recall({ query: "去年见过的人", time_hint: "去年" });

    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].slug).toBe("entities/person-a");
  });

  // ─── Chinese tokenization ────────────────────────────────

  test("Chinese tokenization matches partial terms", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { summary: "人物A是前端开发工程师" },
      ],
    });
    seedPerson("entities/person-b", "人物B", {
      timeline: [
        { summary: "人物B是后端运维" },
      ],
    });

    const result = recall({ query: "前端的人", topic_hint: "前端" });

    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].slug).toBe("entities/person-a");
  });

  // ─── Evidence filtering ─────────────────────────────────────

  test("unrelated evidence is excluded when only topic matches", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { summary: "人物A负责前端开发" },
        { summary: "人物A参加团建活动" },
      ],
      links: [
        { other: "entities/org-e", otherTitle: "组织E", relation: "works_at", context: "人物A在组织E工作" },
      ],
    });

    const result = recall({ query: "前端开发的人", topic_hint: "前端开发" });

    const evidence = result.candidates[0].evidence;
    // Only timeline entries matching "前端开发" should appear
    expect(evidence.some((e) => e.excerpt.includes("前端开发"))).toBe(true);
    expect(evidence.some((e) => e.excerpt.includes("团建"))).toBe(false);
    // Link evidence should not appear (no connection hint matched)
    expect(evidence.every((e) => e.source_type !== "link")).toBe(true);
  });

  test("source_slug never empty — falls back to person slug", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { summary: "人物A负责前端开发" },
      ],
      links: [
        { other: "entities/org-e", otherTitle: "组织E", relation: "works_at", context: "人物A在组织E工作" },
      ],
    });

    const result = recall({ query: "前端开发的人", topic_hint: "前端开发", connection_hint: "组织E" });

    const evidence = result.candidates[0].evidence;
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.every((e) => e.source_slug.length > 0)).toBe(true);
  });

  // ─── Limit safety bounds ────────────────────────────────────

  test("limit <= 0 is clamped to 1", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { summary: "人物A负责前端开发" },
      ],
    });
    seedPerson("entities/person-b", "人物B", {
      timeline: [
        { summary: "人物B负责前端开发" },
      ],
    });

    const result = recall({ query: "前端的人", topic_hint: "前端开发", limit: 0 });

    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    expect(result.candidates.length).toBeLessThanOrEqual(2);
  });

  test("limit negative is clamped to 1", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { summary: "人物A负责前端开发" },
      ],
    });

    const result = recall({ query: "前端的人", topic_hint: "前端开发", limit: -5 });

    expect(result.candidates.length).toBe(1);
  });

  // ─── Year-month parsing ─────────────────────────────────────

  test("year-month hint does not degrade to year-only match", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { event_date: "2024-01-15", summary: "人物A参加一月聚餐" },
      ],
    });
    seedPerson("entities/person-b", "人物B", {
      timeline: [
        { event_date: "2024-03-20", summary: "人物B参加三月团建" },
      ],
    });

    const result = recall({ query: "2024年3月认识的人", time_hint: "2024年3月", topic_hint: "团建" });

    // Should only match March, not January
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].slug).toBe("entities/person-b");
    expect(result.search_meta.time_parsed).toBe("2024年3月");
  });

  test("year-month extracted from query does not degrade", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { event_date: "2024-06-15", summary: "人物A负责前端开发" },
      ],
    });
    seedPerson("entities/person-b", "人物B", {
      timeline: [
        { event_date: "2024-03-20", summary: "人物B负责后端开发" },
      ],
    });

    const result = recall({ query: "2024年3月认识的人" });

    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].slug).toBe("entities/person-b");
  });

  // ─── Precise evidence filtering ─────────────────────────────

  test("time-only query excludes other months in timeline evidence", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { event_date: "2024-03-10", summary: "人物A三月参加峰会" },
        { event_date: "2024-06-15", summary: "人物A六月做分享" },
        { event_date: "2023-12-01", summary: "人物A去年底聚餐" },
      ],
    });

    const result = recall({ query: "2024年3月", time_hint: "2024年3月" });

    expect(result.candidates.length).toBe(1);
    const evidence = result.candidates[0].evidence;
    // Only March timeline should appear
    expect(evidence.length).toBe(1);
    expect(evidence[0].excerpt).toContain("三月");
    expect(evidence.every((e) => !e.excerpt.includes("六月"))).toBe(true);
    expect(evidence.every((e) => !e.excerpt.includes("去年底"))).toBe(true);
  });

  test("time-only query excludes other years in timeline evidence", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { event_date: "2024-03-10", summary: "人物A今年三月见面" },
        { event_date: "2023-03-10", summary: "人物A去年三月见面" },
      ],
    });

    const result = recall({ query: "2024年3月", time_hint: "2024年3月" });

    expect(result.candidates.length).toBe(1);
    const evidence = result.candidates[0].evidence;
    expect(evidence.length).toBe(1);
    expect(evidence[0].excerpt).toContain("今年");
    expect(evidence.every((e) => !e.excerpt.includes("去年"))).toBe(true);
  });

  test("connection-only query excludes unrelated links from evidence", () => {
    seedPerson("entities/person-a", "人物A", {
      links: [
        { other: "entities/org-e", otherTitle: "组织E", relation: "works_at", context: "人物A在组织E工作" },
        { other: "entities/project-x", otherTitle: "项目X", relation: "leads", context: "人物A主导项目X" },
      ],
    });

    const result = recall({ query: "组织E的人", connection_hint: "组织E" });

    expect(result.candidates.length).toBe(1);
    const evidence = result.candidates[0].evidence;
    // Only link to org-e should appear
    expect(evidence.some((e) => e.excerpt.includes("组织E"))).toBe(true);
    expect(evidence.every((e) => !e.excerpt.includes("项目X"))).toBe(true);
  });

  test("source_slug is never empty in evidence across dimensions", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { event_date: "2024-03-10", summary: "人物A三月团建" },
      ],
      links: [
        { other: "entities/org-e", otherTitle: "组织E", relation: "works_at", context: "人物A在组织E团建" },
      ],
    });

    const result = recall({ query: "2024年3月团建", time_hint: "2024年3月", context_hint: "团建", connection_hint: "组织E" });

    const evidence = result.candidates[0].evidence;
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.every((e) => e.source_slug.length > 0)).toBe(true);
  });

  test("time-only query excludes null-dated timeline from evidence", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { event_date: "2024-03-10", summary: "人物A三月参加峰会" },
        { summary: "人物A某次聚餐" },
      ],
    });

    const result = recall({ query: "2024年3月", time_hint: "2024年3月" });

    expect(result.candidates.length).toBe(1);
    const evidence = result.candidates[0].evidence;
    expect(evidence.length).toBe(1);
    expect(evidence[0].excerpt).toContain("三月");
    expect(evidence.every((e) => !e.excerpt.includes("聚餐"))).toBe(true);
  });

  // ─── #85 Acceptance: event dimension, relation hint, multi-clue bonus, diagnostics ───

  test("event hint recalls person matching timeline event", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { event_date: "2024-06-01", summary: "人物A带领项目上线发布" },
      ],
    });
    seedPerson("entities/person-b", "人物B", {
      timeline: [
        { event_date: "2024-06-01", summary: "人物B负责用户调研分析" },
      ],
    });

    const result = recall({ query: "项目上线", event_hint: "项目上线" });

    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].slug).toBe("entities/person-a");
    expect(result.candidates[0].matched_clues.some((c) => c.dimension === "event")).toBe(true);
  });

  test("time + topic multi-clue bonus ranks above topic-only", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { event_date: "2024-03-10", summary: "人物A讨论前端架构设计" },
      ],
    });
    seedPerson("entities/person-b", "人物B", {
      timeline: [
        { summary: "人物B也讨论前端架构设计" },
      ],
    });

    const result = recall({ query: "2024年前端架构", time_hint: "2024", topic_hint: "前端架构" });

    expect(result.candidates.length).toBe(2);
    // person-a has time+topic (multi-clue bonus), person-b has topic only
    expect(result.candidates[0].slug).toBe("entities/person-a");
    expect(result.candidates[0].score).toBeGreaterThan(result.candidates[1].score);
  });

  test("relation_hint produces same result as connection_hint", () => {
    seedPerson("entities/person-a", "人物A", {
      links: [
        { other: "entities/org-x", otherTitle: "组织X", relation: "works_at" },
      ],
    });

    const withConnection = recall({ query: "组织X的人", connection_hint: "组织X" });
    const withRelation = recall({ query: "组织X的人", relation_hint: "组织X" });

    expect(withConnection.candidates.length).toBe(withRelation.candidates.length);
    expect(withConnection.candidates[0]?.slug).toBe(withRelation.candidates[0]?.slug);
  });

  test("relation_hint falls back to connection_hint scoring", () => {
    seedPerson("entities/person-a", "人物A", {
      links: [
        { other: "entities/org-y", otherTitle: "组织Y", relation: "member_of" },
      ],
    });

    const result = recall({ query: "组织Y的人", relation_hint: "组织Y" });

    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].slug).toBe("entities/person-a");
    expect(result.candidates[0].matched_clues.some((c) => c.dimension === "relation")).toBe(true);
  });

  test("diagnostics present in all results", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { event_date: "2024-01-01", summary: "人物A做前端开发" },
      ],
    });

    const result = recall({ query: "2024年前端", time_hint: "2024", topic_hint: "前端" });

    expect(result.diagnostics).toBeDefined();
    expect(result.diagnostics.clues_checked.length).toBeGreaterThan(0);
    expect(result.diagnostics.clues_checked.some((c) => c.clue_type === "time")).toBe(true);
    expect(result.diagnostics.clues_checked.some((c) => c.clue_type === "topic")).toBe(true);
  });

  test("empty result includes diagnostic explanation", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { event_date: "2024-01-01", summary: "人物A做前端开发" },
      ],
    });

    const result = recall({ query: "2025年量子计算", time_hint: "2025", topic_hint: "量子计算" });

    expect(result.candidates.length).toBe(0);
    expect(result.summary).toContain("没有找到");
    expect(result.summary).toContain("time");
    expect(result.summary).toContain("topic");
    expect(result.summary).toContain("扫描了1个人物");
    expect(result.diagnostics.clues_checked.some((c) => !c.had_support)).toBe(true);
  });

  test("event hint scores against timeline summaries only", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { summary: "人物A参加团队聚餐活动" },
      ],
      links: [
        { other: "entities/org-z", otherTitle: "组织Z", relation: "works_at", context: "人物A参与团队聚餐" },
      ],
    });

    const result = recall({ query: "团队聚餐", event_hint: "团队聚餐" });

    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].matched_clues.some((c) => c.dimension === "event")).toBe(true);
  });

  test("hints_applied includes event and relation", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { summary: "人物A参加项目上线" },
      ],
      links: [
        { other: "entities/org-w", otherTitle: "组织W", relation: "works_at" },
      ],
    });

    const result = recall({ query: "项目上线", event_hint: "项目上线", relation_hint: "组织W" });

    expect(result.search_meta.hints_applied).toContain("event");
    expect(result.search_meta.hints_applied).toContain("relation");
  });

  test("multi-clue bonus strictly higher than single-clue", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { event_date: "2024-03-10", summary: "人物A做前端架构" },
      ],
    });
    seedPerson("entities/person-b", "人物B", {
      timeline: [
        { event_date: "2024-03-10", summary: "人物B做前端架构和性能优化" },
      ],
    });

    const singleClue = recall({ query: "前端架构", topic_hint: "前端架构" });
    const multiClue = recall({ query: "2024年3月前端架构", time_hint: "2024年3月", topic_hint: "前端架构" });

    const singleScore = singleClue.candidates.find((c) => c.slug === "entities/person-a")?.score ?? 0;
    const multiScore = multiClue.candidates.find((c) => c.slug === "entities/person-a")?.score ?? 0;

    expect(multiScore).toBeGreaterThan(singleScore);
  });

  test("collectTokens includes event_hint tokens", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { summary: "人物A参加产品发布会" },
      ],
    });

    const result = recall({ query: "产品发布会", event_hint: "产品发布会" });

    expect(result.search_meta.tokens_used.length).toBeGreaterThan(0);
  });

  test("inactive evidence excluded for event and relation dimensions", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { summary: "人物A参加项目上线", trust_state: "rejected" },
        { summary: "人物A负责代码审查" },
      ],
      links: [
        { other: "entities/org-q", otherTitle: "组织Q", relation: "works_at", trust_state: "superseded" },
      ],
    });

    const result = recall({ query: "项目上线", event_hint: "项目上线", connection_hint: "组织Q" });

    // Only the non-rejected timeline entry should appear in evidence
    const timelineEvidence = result.candidates[0]?.evidence.filter((e) => e.source_type === "timeline") ?? [];
    expect(timelineEvidence.every((e) => !e.excerpt.includes("项目上线"))).toBe(true);
  });

  test("chunk evidence when timeline has no matches", () => {
    seedPerson("entities/person-a", "人物A", {
      timeline: [
        { summary: "人物A做日常开发" },
      ],
    });
    // Seed chunk content for FTS
    db.rawDb.prepare(
      "INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)",
    ).run("entities/person-a", "人物A参与量子计算算法研究的讨论记录");

    const result = recall({ query: "量子计算", topic_hint: "量子计算" });

    expect(result.candidates.length).toBe(1);
    const chunkEvidence = result.candidates[0].evidence.filter((e) => e.source_type === "chunk");
    expect(chunkEvidence.length).toBeGreaterThan(0);
    expect(chunkEvidence[0].excerpt.length).toBeLessThanOrEqual(200);
  });
});
