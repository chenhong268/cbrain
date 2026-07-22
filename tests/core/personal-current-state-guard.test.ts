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

const IDENTITY_SLUG = "brain/entities/subject-a";
const TOPIC_SLUG = "brain/entities/topic-d";
const OLD_REMINDER_SLUG = "records/reminder-old";
const NEIGHBOR_B = "brain/entities/neighbor-b";

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

function makeMockDb(opts: {
  trustedLinks?: LinkRow[];
  timelineBySlug?: Record<string, TimelineEntry[]>;
} = {}): CBrainDB {
  return {
    getBoundedTrustedLinks: (_slug: string, _limit: number) => opts.trustedLinks ?? [],
    getBoundedTrustedTimelineForSlugs: (slugs: string[], _limit: number) => {
      const out: TimelineEntry[] = [];
      for (const s of slugs) out.push(...(opts.timelineBySlug?.[s] ?? []));
      return out;
    },
  } as unknown as CBrainDB;
}

function makeMockPages(identityPage?: { type: string; title?: string } | null): GuardPageLookup {
  const store: Record<string, { type: string; title?: string }> = {};
  if (identityPage) store[IDENTITY_SLUG] = identityPage;
  return { getBySlug: (slug: string) => store[slug] ?? null };
}

const tl = (summary: string, slug = TOPIC_SLUG, date = "2026-06-01"): TimelineEntry => ({
  page_slug: slug, event_date: date, summary, trust_state: "trusted",
});

// ── Intent detection ──

describe("isFirstPersonQuery (#385)", () => {
  test.each([
    "我该去复查了吗",
    "我的体检到期了吗",
    "我该吃药了吗",
    "should I go for a checkup",
  ])("detects first-person in: %s", (q) => expect(isFirstPersonQuery(q)).toBe(true));

  test.each(["实体A是什么", "主题D的信息"])(
    "no first-person in: %s", (q) => expect(isFirstPersonQuery(q)).toBe(false),
  );

  test("collective 我们 does not count", () => {
    expect(isFirstPersonQuery("我们公司的项目")).toBe(false);
  });
});

describe("isPersonalCurrentStateQuery (#385)", () => {
  // Action predicates — trigger on their own
  test.each([
    "我该不该去复查",
    "我的体检到期了吗",
    "我该吃药了吗",
    "我需不需要复查",
    "should I go for a checkup",
    "is it time for my checkup",
    "do I need to see a doctor",
  ])("activates for: %s", (q) => expect(isPersonalCurrentStateQuery(q)).toBe(true));

  // Time marker + domain action compound
  test("time + 复查 activates", () => {
    expect(isPersonalCurrentStateQuery("我上次复查结果怎么样")).toBe(true);
  });

  // P1#3 r4: ALL bare nouns removed — negative regressions
  test.each([
    "我最近看了哪部院线电影",
    "我最近有哪些研究报告",
    "我上次提交了哪段代码",
    "我的代码检查结果是什么",
    "我最近用运动相机拍了什么",
    "我最近从保险箱取了什么",
    "我的工资发放周期是什么",
    "我的发帖频率是多少",
    "What is my medication called",
    "Show my appointment notes",
    "我最近看了什么书",
  ])("does NOT activate for bare noun: %s", (q) => {
    expect(isPersonalCurrentStateQuery(q)).toBe(false);
  });
});

// ── Guard logic ──

describe("applyPersonalCurrentStateGuard (#385)", () => {
  test("non-personal query does not activate", () => {
    const r = applyPersonalCurrentStateGuard(makeMockDb(), makeMockPages({ type: "entity/person" }), "实体A是什么", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(r.activated).toBe(false);
  });

  test("no identity → insufficient", () => {
    const r = applyPersonalCurrentStateGuard(makeMockDb(), makeMockPages(), "我该不该去复查", [makeResult(OLD_REMINDER_SLUG)], undefined);
    expect(r.reason).toBe("no identity mapping configured");
  });

  test("bare entity type → insufficient", () => {
    const r = applyPersonalCurrentStateGuard(makeMockDb(), makeMockPages({ type: "entity" }), "我该不该去复查", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(r.reason).toBe("identity is not entity/person");
  });

  test("no trusted chain → insufficient", () => {
    const db = makeMockDb({ trustedLinks: [] });
    const r = applyPersonalCurrentStateGuard(db, makeMockPages({ type: "entity/person" }), "我该不该去复查", [makeResult(OLD_REMINDER_SLUG)], IDENTITY_SLUG);
    expect(r.reason).toBe("no trusted subject-to-topic chain");
  });

  // P1#1 r4: generic historical event does NOT qualify as current-state evidence
  test("candidate with only generic history event → insufficient", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, OLD_REMINDER_SLUG, "trusted")],
      timelineBySlug: { [OLD_REMINDER_SLUG]: [tl("首次创建提醒", OLD_REMINDER_SLUG, "2018-01-01")] },
    });
    const r = applyPersonalCurrentStateGuard(db, makeMockPages({ type: "entity/person" }), "我该吃药了吗", [makeResult(OLD_REMINDER_SLUG)], IDENTITY_SLUG);
    expect(r.outcome).toBe("insufficient_current_context");
    expect(r.reason).toBe("no candidate with trusted current-state evidence");
  });

  // P1#1: candidate with current-state evidence (completed) → pass
  test("candidate with completed evidence → pass", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      timelineBySlug: { [TOPIC_SLUG]: [tl("已完成相关检查")] },
    });
    const r = applyPersonalCurrentStateGuard(db, makeMockPages({ type: "entity/person" }), "我该吃药了吗", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(r.outcome).toBe("pass");
    expect(r.filteredResults?.length).toBe(1);
    expect(r.verifiedTimeline?.length).toBeGreaterThan(0);
  });

  // Cross-neighbor leak still blocked
  test("cross-neighbor leak: neighbor B has evidence, candidate A does not → insufficient", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, OLD_REMINDER_SLUG, "trusted"), makeLink(IDENTITY_SLUG, NEIGHBOR_B, "trusted")],
      timelineBySlug: {
        [NEIGHBOR_B]: [tl("已完成相关检查", NEIGHBOR_B)],
        [OLD_REMINDER_SLUG]: [],
      },
    });
    const r = applyPersonalCurrentStateGuard(db, makeMockPages({ type: "entity/person" }), "我该吃药了吗", [makeResult(OLD_REMINDER_SLUG)], IDENTITY_SLUG);
    expect(r.outcome).toBe("insufficient_current_context");
  });

  // P2#4: negation normalization
  test("未完成 is pending only (not completed)", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      timelineBySlug: { [TOPIC_SLUG]: [tl("未完成相关检查")] },
    });
    const r = applyPersonalCurrentStateGuard(db, makeMockPages({ type: "entity/person" }), "我该吃药了吗", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(r.outcome).toBe("pass"); // pending-only, no conflict
  });

  test("还没完成 is pending only", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      timelineBySlug: { [TOPIC_SLUG]: [tl("还没完成相关检查")] },
    });
    const r = applyPersonalCurrentStateGuard(db, makeMockPages({ type: "entity/person" }), "我该吃药了吗", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(r.outcome).toBe("pass");
  });

  test("not completed is pending only", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      timelineBySlug: { [TOPIC_SLUG]: [tl("not completed the checkup")] },
    });
    const r = applyPersonalCurrentStateGuard(db, makeMockPages({ type: "entity/person" }), "我该吃药了吗", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(r.outcome).toBe("pass");
  });

  // Conflict: completed + pending on same candidate → skip
  test("conflicting completed+pending on same candidate → insufficient", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      timelineBySlug: {
        [TOPIC_SLUG]: [
          tl("已完成相关检查", TOPIC_SLUG, "2026-06-01"),
          tl("待复查", TOPIC_SLUG, "2026-07-01"),
        ],
      },
    });
    const r = applyPersonalCurrentStateGuard(db, makeMockPages({ type: "entity/person" }), "我该吃药了吗", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(r.outcome).toBe("insufficient_current_context");
  });
});
