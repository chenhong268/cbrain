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

function makeResult(slug: string): SearchResult {
  return { slug, score: 0.5, snippet: "匿名片段", source: "hybrid" };
}

function makeLink(from: string, to: string, trustState: string): LinkRow {
  return {
    id: 1, from_slug: from, to_slug: to, relation: "关联", weight: 0.5,
    strength: "medium", context: null, source_type: "wikilink", confidence: 0.8,
    created_at: "2026-01-01T00:00:00Z", last_validated_at: null, effective_weight: 0.4,
    source_page_slug: from, trust_state: trustState,
  };
}

interface TimelineEntry { page_slug: string; event_date: string; summary: string; trust_state?: string; }

function makeMockDb(opts: {
  trustedLinks?: LinkRow[];
  timelineBySlug?: Record<string, TimelineEntry[]>;
} = {}): CBrainDB {
  return {
    getBoundedTrustedLinks: (_s: string, _l: number) => opts.trustedLinks ?? [],
    getBoundedTrustedTimelineForSlugs: (slugs: string[], _l: number) => {
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

// ── Intent detection ──

describe("isFirstPersonQuery (#385) — casing matrix", () => {
  test.each([
    "我该吃药了吗",
    "should I go for a checkup",
    "should i go for a checkup",
    "Is My checkup overdue",
    "IS MY CHECKUP OVERDUE",
    "What am I currently taking",
    "what medication am i currently on",
  ])("detects first-person: %s", (q) => expect(isFirstPersonQuery(q)).toBe(true));

  test.each(["实体A是什么", "主题D的信息"])(
    "no first-person: %s", (q) => expect(isFirstPersonQuery(q)).toBe(false),
  );
});

describe("isPersonalCurrentStateQuery (#385)", () => {
  // Current-advice predicates — trigger
  test.each([
    "我该不该去复查",
    "我的体检到期了吗",
    "我该吃药了吗",
    "我需不需要复查",
    "should I go for a checkup",
    "should i go for a checkup",
    "is it time for my checkup",
    // P1#3 r6: English current-state phrases
    "What am I currently taking",
    "What medication am I currently on",
    "am I currently on any medication",
  ])("activates for: %s", (q) => expect(isPersonalCurrentStateQuery(q)).toBe(true));

  // Time + domain ACTION verb (复查/看病/吃药)
  test("time + 复查 activates", () => {
    expect(isPersonalCurrentStateQuery("我上次复查结果怎么样")).toBe(true);
  });

  // P1#2 r6: fact-recall with domain NOUNS must NOT trigger
  test.each([
    "我上次血压是多少",
    "我最近的体检结果怎么样",
    "我最近的睡眠记录是什么",
    "我最近的血糖是多少",
    "我的心率记录",
  ])("does NOT activate for fact recall: %s", (q) => {
    expect(isPersonalCurrentStateQuery(q)).toBe(false);
  });

  // Bare nouns — still excluded
  test.each([
    "我的工资发放周期是什么",
    "What is my medication called",
    "Show my appointment notes",
    "我的代码检查结果是什么",
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
    const r = applyPersonalCurrentStateGuard(makeMockDb(), makeMockPages(), "我该吃药了吗", [makeResult(OLD_REMINDER_SLUG)], undefined);
    expect(r.reason).toBe("no identity mapping configured");
  });

  test("bare entity → insufficient", () => {
    const r = applyPersonalCurrentStateGuard(makeMockDb(), makeMockPages({ type: "entity" }), "我该吃药了吗", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(r.reason).toBe("identity is not entity/person");
  });

  // P2#4: bounded inspection disclaimer
  test("no trusted chain → insufficient with bounded disclaimer", () => {
    const db = makeMockDb({ trustedLinks: [] });
    const r = applyPersonalCurrentStateGuard(db, makeMockPages({ type: "entity/person" }), "我该吃药了吗", [makeResult(OLD_REMINDER_SLUG)], IDENTITY_SLUG);
    expect(r.outcome).toBe("insufficient_current_context");
    expect(r.reason).toContain("bounded inspection");
  });

  // P1#1 r6: trusted chain → insufficient but WITH historical evidence
  test("trusted chain → insufficient + historical evidence returned", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      timelineBySlug: {
        [TOPIC_SLUG]: [
          { page_slug: TOPIC_SLUG, event_date: "2026-06-01", summary: "已完成相关检查", trust_state: "trusted" },
        ],
      },
    });
    const r = applyPersonalCurrentStateGuard(db, makeMockPages({ type: "entity/person" }), "我该吃药了吗", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(r.outcome).toBe("insufficient_current_context");
    expect(r.reason).toContain("phase-1 model cannot prove current state");
    expect(r.historicalEvidence).toBeDefined();
    expect(r.historicalEvidence!.length).toBe(1);
    expect(r.historicalEvidence![0]!.trust_state).toBe("trusted");
  });

  // P1#3: user_thought preserved in evidence
  test("user_thought trust_state preserved in historical evidence", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      timelineBySlug: {
        [TOPIC_SLUG]: [
          { page_slug: TOPIC_SLUG, event_date: "2026-06-01", summary: "待复查", trust_state: "user_thought" },
        ],
      },
    });
    const r = applyPersonalCurrentStateGuard(db, makeMockPages({ type: "entity/person" }), "我该吃药了吗", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(r.historicalEvidence![0]!.trust_state).toBe("user_thought");
  });

  // Trusted chain but empty timeline → insufficient, no evidence
  test("trusted chain + empty timeline → insufficient, no evidence", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      timelineBySlug: {},
    });
    const r = applyPersonalCurrentStateGuard(db, makeMockPages({ type: "entity/person" }), "我该吃药了吗", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(r.outcome).toBe("insufficient_current_context");
    expect(r.historicalEvidence).toEqual([]);
  });
});
