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

interface MockDbOpts {
  trustedLinks?: LinkRow[];
  networkTimeline?: Array<{ slug: string; title: string; event_date: string | null; summary: string }>;
}

function makeMockDb(opts: MockDbOpts = {}): CBrainDB {
  return {
    getBoundedTrustedLinks: (_slug: string, _limit: number) => opts.trustedLinks ?? [],
    getRecentEventsInNetwork: (_slugs: string[], _days: number, _limit: number) => opts.networkTimeline ?? [],
  } as unknown as CBrainDB;
}

function makeMockPages(identityPage?: { type: string; title?: string } | null): GuardPageLookup {
  const store: Record<string, { type: string; title?: string }> = {};
  if (identityPage) store[IDENTITY_SLUG] = identityPage;
  return {
    getBySlug: (slug: string) => store[slug] ?? null,
  };
}

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

  // P1#3: time markers require a domain word to co-occur
  test("time marker + domain word activates (我上次复查结果)", () => {
    expect(isPersonalCurrentStateQuery("我上次复查结果怎么样")).toBe(true);
  });

  test("time marker + domain word activates (我最近的治疗进展)", () => {
    expect(isPersonalCurrentStateQuery("我最近的治疗进展怎么样")).toBe(true);
  });

  // P1#3: bare time markers WITHOUT domain words must NOT trigger
  test.each([
    "我最近看了什么书", // temporal but pure recall, no health/management domain
    "我上次去了哪里", // temporal but no domain
    "我最近读了什么文章", // temporal + guardrail domain (文章) → must NOT trigger
    "我 liked the movie", // first-person but no action/health intent
  ])("does NOT activate for pure recall: %s", (q) => {
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

  // #3: Ambiguous or missing first-person identity mapping → insufficient.
  test("personal query without identity → insufficient", () => {
    const db = makeMockDb({});
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(OLD_REMINDER_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", results, undefined);
    expect(guardResult.activated).toBe(true);
    expect(guardResult.outcome).toBe("insufficient_current_context");
    expect(guardResult.reason).toBe("no identity mapping configured");
    expect(guardResult.debugSearchMaterial).toEqual(results);
  });

  test("identity page not found → insufficient", () => {
    const db = makeMockDb({});
    const pages = makeMockPages(null);
    const results = [makeResult(OLD_REMINDER_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", results, IDENTITY_SLUG);
    expect(guardResult.activated).toBe(true);
    expect(guardResult.outcome).toBe("insufficient_current_context");
    expect(guardResult.reason).toBe("identity page not found");
  });

  test("identity is not entity/person → insufficient", () => {
    const db = makeMockDb({});
    const pages = makeMockPages({ type: "concept", title: "概念X" });
    const results = [makeResult(OLD_REMINDER_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", results, IDENTITY_SLUG);
    expect(guardResult.activated).toBe(true);
    expect(guardResult.outcome).toBe("insufficient_current_context");
    expect(guardResult.reason).toBe("identity is not entity/person");
  });

  // #1: Missing subject-to-topic chain → insufficient; old reminder not surfaced.
  test("personal query + old reminder + missing trusted chain → insufficient", () => {
    const db = makeMockDb({ trustedLinks: [] });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(OLD_REMINDER_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", results, IDENTITY_SLUG);
    expect(guardResult.activated).toBe(true);
    expect(guardResult.outcome).toBe("insufficient_current_context");
    expect(guardResult.reason).toBe("no trusted subject-to-topic chain");
    expect(guardResult.debugSearchMaterial).toEqual(results);
  });

  // #2: Only candidate links → insufficient (candidate is not authority).
  test("personal query + only candidate links → insufficient", () => {
    const db = makeMockDb({
      trustedLinks: [], // getBoundedTrustedLinks filters for trusted/user_thought only
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(TOPIC_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", results, IDENTITY_SLUG);
    expect(guardResult.outcome).toBe("insufficient_current_context");
    expect(guardResult.reason).toBe("no trusted subject-to-topic chain");
  });

  // #4: Trusted subject-to-topic chain → pass with FILTERED results.
  test("trusted subject-to-topic chain → pass, filteredResults contains connected", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(TOPIC_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", results, IDENTITY_SLUG);
    expect(guardResult.outcome).toBe("pass");
    expect(guardResult.subjectSlug).toBe(IDENTITY_SLUG);
    expect(guardResult.filteredResults?.length).toBe(1);
    expect(guardResult.filteredResults?.[0]?.slug).toBe(TOPIC_SLUG);
  });

  // P1#1: Per-candidate filtering — unrelated stale reminders are filtered out.
  test("trusted chain filters out unrelated stale reminder from results", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    // Mix: one connected result + one unrelated stale reminder
    const results = [makeResult(OLD_REMINDER_SLUG), makeResult(TOPIC_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", results, IDENTITY_SLUG);
    expect(guardResult.outcome).toBe("pass");
    // filteredResults should contain ONLY the connected topic, NOT the old reminder
    expect(guardResult.filteredResults?.length).toBe(1);
    expect(guardResult.filteredResults?.[0]?.slug).toBe(TOPIC_SLUG);
    expect(guardResult.filteredResults?.find((r) => r.slug === OLD_REMINDER_SLUG)).toBeUndefined();
  });

  test("trusted incoming link also counts as subject connection", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(TOPIC_SLUG, IDENTITY_SLUG, "user_thought")],
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(TOPIC_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", results, IDENTITY_SLUG);
    expect(guardResult.outcome).toBe("pass");
  });

  test("subject itself in search results → pass (self-connection)", () => {
    const db = makeMockDb({});
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(IDENTITY_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", results, IDENTITY_SLUG);
    expect(guardResult.outcome).toBe("pass");
  });

  // P2#6: NULL trust_state is NOT trusted for personal current-state.
  test("null trust_state link is NOT trusted for current-state", () => {
    // getBoundedTrustedLinks already filters for trusted/user_thought in SQL.
    // This test confirms: when the mock returns empty (null links filtered out
    // by SQL), the guard correctly reports no trusted chain.
    const db = makeMockDb({ trustedLinks: [] });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(TOPIC_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", results, IDENTITY_SLUG);
    expect(guardResult.outcome).toBe("insufficient_current_context");
    expect(guardResult.reason).toBe("no trusted subject-to-topic chain");
  });

  // #5: Conflicting dated evidence → insufficient (now checks neighbor timeline).
  test("conflicting completed + pending evidence in network timeline → insufficient", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      networkTimeline: [
        { slug: TOPIC_SLUG, title: "主题D", event_date: "2026-06-01", summary: "已完成相关检查" },
        { slug: TOPIC_SLUG, title: "主题D", event_date: "2026-07-01", summary: "待复查" },
      ],
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(TOPIC_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", results, IDENTITY_SLUG);
    expect(guardResult.outcome).toBe("insufficient_current_context");
    expect(guardResult.reason).toBe("conflicting dated evidence");
  });

  test("only completed timeline evidence → pass (no conflict)", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      networkTimeline: [
        { slug: TOPIC_SLUG, title: "主题D", event_date: "2026-06-01", summary: "已完成相关检查" },
      ],
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(TOPIC_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", results, IDENTITY_SLUG);
    expect(guardResult.outcome).toBe("pass");
  });
});
