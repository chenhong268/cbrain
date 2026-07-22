import { describe, expect, test } from "bun:test";
import {
  applyPersonalCurrentStateGuard,
  type GuardPageLookup,
} from "../../src/core/retrieval/personal-current-state-guard.js";
import {
  isFirstPersonQuery,
  isPersonalCurrentStateQuery,
} from "../../src/core/retrieval/recall-intent.js";
import type { CBrainDB, LinkRow } from "../../src/storage/sqlite.js";
import type { SearchResult } from "../../src/core/retrieval/search.js";

// ── Anonymized fixtures (no real names, paths, or PII) ──
const IDENTITY_SLUG = "brain/entities/subject-a";
const TOPIC_SLUG = "brain/entities/topic-d";
const OLD_REMINDER_SLUG = "records/reminder-old";

function makeResult(slug: string): SearchResult {
  return { slug, score: 0.5, snippet: "匿名片段", source: "hybrid" };
}

function makeLink(from: string, to: string, trustState: string): LinkRow {
  return {
    id: Math.floor(Math.random() * 1_000_000),
    from_slug: from,
    to_slug: to,
    relation: "关联",
    weight: 0.5,
    strength: "medium",
    context: null,
    source_type: "wikilink",
    confidence: 0.8,
    created_at: "2026-01-01T00:00:00Z",
    last_validated_at: null,
    effective_weight: 0.4,
    source_page_slug: from,
    trust_state: trustState,
  };
}

interface TimelineEntry {
  page_slug: string;
  event_date: string;
  summary: string;
  trust_state?: string;
}

interface MockDbOpts {
  trustedLinks?: LinkRow[];
  timeline?: TimelineEntry[];
}

function makeMockDb(opts: MockDbOpts = {}): CBrainDB {
  return {
    getBoundedTrustedLinks: (_slug: string, _limit: number) => opts.trustedLinks ?? [],
    getBoundedTrustedTimelineForSlugs: (_slugs: string[], _limit: number) => opts.timeline ?? [],
  } as unknown as CBrainDB;
}

function makeMockPages(identityPage?: { type: string; title?: string } | null): GuardPageLookup {
  const store: Record<string, { type: string; title?: string }> = {};
  if (identityPage) store[IDENTITY_SLUG] = identityPage;
  return {
    getBySlug: (slug: string) => store[slug] ?? null,
  };
}

const tl = (summary: string, date = "2026-06-01"): TimelineEntry => ({
  page_slug: TOPIC_SLUG,
  event_date: date,
  summary,
  trust_state: "trusted",
});

// ── Intent detection ──────────────────────────────────────

describe("isFirstPersonQuery (#385)", () => {
  test.each([
    "我最近该去复查了吗",
    "我的体检到期了吗",
    "我该吃药了吗",
    "should I go for a checkup",
    "my medication schedule",
  ])("detects first-person in: %s", (q) => {
    expect(isFirstPersonQuery(q)).toBe(true);
  });

  test.each([
    "实体A是什么",
    "主题D的信息",
    "concept C is defined as",
  ])("no first-person in: %s", (q) => {
    expect(isFirstPersonQuery(q)).toBe(false);
  });

  test("collective 我们 does not count as first-person subject", () => {
    expect(isFirstPersonQuery("我们公司的项目")).toBe(false);
  });
});

describe("isPersonalCurrentStateQuery (#385)", () => {
  // Direct action markers — trigger on their own
  test.each([
    "我最近该去复查了吗",
    "我的体检到期了吗",
    "我该吃药了吗",
    "我还需要预约吗",
    "should I go for a checkup",
    "is my medication due",
  ])("activates for personal current-state: %s", (q) => {
    expect(isPersonalCurrentStateQuery(q)).toBe(true);
  });

  // P1#3 fix: time marker + multi-char domain word activates
  test("time marker + 复查 activates", () => {
    expect(isPersonalCurrentStateQuery("我上次复查结果怎么样")).toBe(true);
  });

  test("time marker + 治疗 activates", () => {
    expect(isPersonalCurrentStateQuery("我最近的治疗进展怎么样")).toBe(true);
  });

  // P1#3 regression: single chars and broad terms must NOT trigger
  test.each([
    "我最近看了哪部院线电影", // 院 alone is not a domain word now
    "我最近有哪些研究报告", // 报告 removed
    "我上次提交了哪段代码", // 提交 removed
    "我最近看了什么书", // pure recall
    "我上次去了哪里", // no domain
    "我最近读了什么文章", // no domain
    "我 liked the movie", // no action/health intent
  ])("does NOT activate for: %s", (q) => {
    expect(isPersonalCurrentStateQuery(q)).toBe(false);
  });
});

// ── Guard logic — regression matrix ───────────────────────

describe("applyPersonalCurrentStateGuard (#385)", () => {
  // #7: Plain non-temporal lookup → guard does not activate, zero DB work.
  test("non-personal query does not activate guard", () => {
    const db = makeMockDb({});
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const result = applyPersonalCurrentStateGuard(db, pages, "实体A是什么", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(result.activated).toBe(false);
    expect(result.outcome).toBe("pass");
  });

  // #6: Non-personal temporal query → guard does not activate.
  test("non-personal temporal query does not activate guard", () => {
    const db = makeMockDb({});
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const result = applyPersonalCurrentStateGuard(db, pages, "主题D上次的变化", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(result.activated).toBe(false);
    expect(result.outcome).toBe("pass");
  });

  // #3: Missing identity mapping → insufficient.
  test("personal query without identity → insufficient", () => {
    const db = makeMockDb({});
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(OLD_REMINDER_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", results, undefined);
    expect(guardResult.outcome).toBe("insufficient_current_context");
    expect(guardResult.reason).toBe("no identity mapping configured");
    expect(guardResult.debugSearchMaterial).toEqual(results);
  });

  test("identity page not found → insufficient", () => {
    const db = makeMockDb({});
    const pages = makeMockPages(null);
    const guardResult = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", [makeResult(OLD_REMINDER_SLUG)], IDENTITY_SLUG);
    expect(guardResult.outcome).toBe("insufficient_current_context");
    expect(guardResult.reason).toBe("identity page not found");
  });

  // P1#4: bare entity type is NOT accepted — only entity/person.
  test("bare entity type → insufficient (must be entity/person)", () => {
    const db = makeMockDb({});
    const pages = makeMockPages({ type: "entity", title: "主体A" });
    const guardResult = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(guardResult.outcome).toBe("insufficient_current_context");
    expect(guardResult.reason).toBe("identity is not entity/person");
  });

  test("entity/company type → insufficient", () => {
    const db = makeMockDb({});
    const pages = makeMockPages({ type: "entity/company", title: "公司X" });
    const guardResult = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(guardResult.outcome).toBe("insufficient_current_context");
    expect(guardResult.reason).toBe("identity is not entity/person");
  });

  // #1: Missing subject-to-topic chain → insufficient.
  test("personal query + no trusted chain → insufficient", () => {
    const db = makeMockDb({ trustedLinks: [] });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const guardResult = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", [makeResult(OLD_REMINDER_SLUG)], IDENTITY_SLUG);
    expect(guardResult.outcome).toBe("insufficient_current_context");
    expect(guardResult.reason).toBe("no trusted subject-to-topic chain");
  });

  // P1#2: trusted chain but EMPTY timeline → insufficient (no dated evidence).
  test("trusted chain + empty timeline → insufficient (no current-state evidence)", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      timeline: [],
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(TOPIC_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", results, IDENTITY_SLUG);
    expect(guardResult.outcome).toBe("insufficient_current_context");
    expect(guardResult.reason).toBe("no trusted dated current-state evidence");
  });

  // #4: Trusted chain + dated evidence → pass with filtered results.
  test("trusted chain + dated evidence → pass, filteredResults connected only", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      timeline: [tl("已完成相关检查")],
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(TOPIC_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", results, IDENTITY_SLUG);
    expect(guardResult.outcome).toBe("pass");
    expect(guardResult.subjectSlug).toBe(IDENTITY_SLUG);
    expect(guardResult.filteredResults?.length).toBe(1);
    expect(guardResult.filteredResults?.[0]?.slug).toBe(TOPIC_SLUG);
  });

  // P1#1: Per-candidate filtering — unrelated stale reminders filtered.
  test("trusted chain filters out unrelated stale reminder", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      timeline: [tl("已完成相关检查")],
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(OLD_REMINDER_SLUG), makeResult(TOPIC_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", results, IDENTITY_SLUG);
    expect(guardResult.outcome).toBe("pass");
    expect(guardResult.filteredResults?.length).toBe(1);
    expect(guardResult.filteredResults?.[0]?.slug).toBe(TOPIC_SLUG);
  });

  test("subject itself in results → pass (self-connection)", () => {
    const db = makeMockDb({
      timeline: [tl("已完成", "2026-06-01")],
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(IDENTITY_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", results, IDENTITY_SLUG);
    expect(guardResult.outcome).toBe("pass");
  });

  // #5: Conflicting completed + pending → insufficient.
  test("conflicting completed + pending → insufficient", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      timeline: [
        tl("已完成相关检查", "2026-06-01"),
        tl("待复查", "2026-07-01"),
      ],
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(TOPIC_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", results, IDENTITY_SLUG);
    expect(guardResult.outcome).toBe("insufficient_current_context");
    expect(guardResult.reason).toBe("conflicting dated evidence");
  });

  test("only completed → pass (no conflict)", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      timeline: [tl("已完成相关检查")],
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(TOPIC_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", results, IDENTITY_SLUG);
    expect(guardResult.outcome).toBe("pass");
  });

  // P1#1 timeline reads DIRECTLY for subject + neighbors (no graph expansion).
  // If timeline is on the subject itself (not a neighbor), it should be found.
  test("timeline on subject page itself is read", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      timeline: [{ page_slug: IDENTITY_SLUG, event_date: "2026-06-01", summary: "已完成", trust_state: "trusted" }],
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(TOPIC_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", results, IDENTITY_SLUG);
    expect(guardResult.outcome).toBe("pass");
  });
});
