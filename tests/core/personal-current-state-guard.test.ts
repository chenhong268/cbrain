import { describe, test, expect } from "bun:test";
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

function makeLink(
  from: string,
  to: string,
  trustState: string | null,
): LinkRow {
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
    source_page_slug: from,
    trust_state: trustState,
  };
}

interface MockDbOpts {
  outgoing?: LinkRow[];
  incoming?: LinkRow[];
  timeline?: Array<{
    event_date: string | null;
    summary: string;
    trust_state?: string;
  }>;
}

function makeMockDb(opts: MockDbOpts = {}): CBrainDB {
  return {
    getOutgoingLinks: (_slug: string) => opts.outgoing ?? [],
    getIncomingLinks: (_slug: string) => opts.incoming ?? [],
    getTimeline: (_slug: string) => opts.timeline ?? [],
  } as unknown as CBrainDB;
}

function makeMockPages(
  identityPage?: { type: string; title?: string } | null,
): GuardPageLookup {
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
    // "我们" is excluded by the lookahead; only standalone 我 triggers.
    expect(isFirstPersonQuery("我们公司的项目")).toBe(false);
  });
});

describe("isPersonalCurrentStateQuery (#385)", () => {
  test.each([
    "我最近该去复查了吗",
    "我的体检到期了吗",
    "我该吃药了吗",
    "我上次检查结果怎么样",
    "我还需要预约吗",
    "should I go for a checkup",
    "is my medication due",
  ])("activates for personal current-state: %s", (q) => {
    expect(isPersonalCurrentStateQuery(q)).toBe(true);
  });

  test.each([
    "实体A是什么",
    "主题D上次的变化", // temporal but not first-person
    "我 liked the movie", // first-person but not action/health intent
  ])("does not activate for: %s", (q) => {
    expect(isPersonalCurrentStateQuery(q)).toBe(false);
  });
});

// ── Guard logic — regression matrix ───────────────────────

describe("applyPersonalCurrentStateGuard (#385)", () => {
  // #7: Plain non-temporal lookup → guard does not activate, zero DB work.
  test("non-personal query does not activate guard", () => {
    const db = makeMockDb({});
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const result = applyPersonalCurrentStateGuard(
      db,
      pages,
      "实体A是什么",
      [makeResult(TOPIC_SLUG)],
      IDENTITY_SLUG,
    );
    expect(result.activated).toBe(false);
    expect(result.outcome).toBe("pass");
  });

  // #6: Non-personal temporal query → guard does not activate.
  test("non-personal temporal query does not activate guard", () => {
    const db = makeMockDb({});
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const result = applyPersonalCurrentStateGuard(
      db,
      pages,
      "主题D上次的变化",
      [makeResult(TOPIC_SLUG)],
      IDENTITY_SLUG,
    );
    expect(result.activated).toBe(false);
    expect(result.outcome).toBe("pass");
  });

  // #3: Ambiguous or missing first-person identity mapping → insufficient.
  test("personal query without identity mapping → insufficient", () => {
    const db = makeMockDb({});
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(OLD_REMINDER_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(
      db,
      pages,
      "我最近该去复查了吗",
      results,
      undefined,
    );
    expect(guardResult.activated).toBe(true);
    expect(guardResult.outcome).toBe("insufficient_current_context");
    expect(guardResult.reason).toBe("no identity mapping configured");
    expect(guardResult.debugSearchMaterial).toEqual(results);
  });

  test("identity page not found → insufficient", () => {
    const db = makeMockDb({});
    const pages = makeMockPages(null);
    const results = [makeResult(OLD_REMINDER_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(
      db,
      pages,
      "我最近该去复查了吗",
      results,
      IDENTITY_SLUG,
    );
    expect(guardResult.activated).toBe(true);
    expect(guardResult.outcome).toBe("insufficient_current_context");
    expect(guardResult.reason).toBe("identity page not found");
  });

  test("identity is not entity/person → insufficient", () => {
    const db = makeMockDb({});
    const pages = makeMockPages({ type: "concept", title: "概念X" });
    const results = [makeResult(OLD_REMINDER_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(
      db,
      pages,
      "我最近该去复查了吗",
      results,
      IDENTITY_SLUG,
    );
    expect(guardResult.activated).toBe(true);
    expect(guardResult.outcome).toBe("insufficient_current_context");
    expect(guardResult.reason).toBe("identity is not entity/person");
  });

  // #1: Missing subject-to-topic chain → insufficient; old reminder not surfaced.
  test("personal query + old reminder + missing subject-to-topic chain → insufficient", () => {
    const db = makeMockDb({ outgoing: [], incoming: [] });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(OLD_REMINDER_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(
      db,
      pages,
      "我最近该去复查了吗",
      results,
      IDENTITY_SLUG,
    );
    expect(guardResult.activated).toBe(true);
    expect(guardResult.outcome).toBe("insufficient_current_context");
    expect(guardResult.reason).toBe("no trusted subject-to-topic chain");
    expect(guardResult.debugSearchMaterial).toEqual(results);
  });

  // #2: Only candidate links → insufficient (candidate is not authority).
  test("personal query + only candidate links → insufficient", () => {
    const db = makeMockDb({
      outgoing: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "candidate")],
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(TOPIC_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(
      db,
      pages,
      "我最近该去复查了吗",
      results,
      IDENTITY_SLUG,
    );
    expect(guardResult.outcome).toBe("insufficient_current_context");
    expect(guardResult.reason).toBe("no trusted subject-to-topic chain");
  });

  // #4: Trusted subject-to-topic chain within bounded hop budget → pass.
  test("trusted subject-to-topic chain → pass", () => {
    const db = makeMockDb({
      outgoing: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(TOPIC_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(
      db,
      pages,
      "我最近该去复查了吗",
      results,
      IDENTITY_SLUG,
    );
    expect(guardResult.outcome).toBe("pass");
    expect(guardResult.subjectSlug).toBe(IDENTITY_SLUG);
  });

  test("trusted incoming link also counts as subject connection", () => {
    const db = makeMockDb({
      incoming: [makeLink(TOPIC_SLUG, IDENTITY_SLUG, "user_thought")],
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(TOPIC_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(
      db,
      pages,
      "我最近该去复查了吗",
      results,
      IDENTITY_SLUG,
    );
    expect(guardResult.outcome).toBe("pass");
  });

  test("null trust_state (legacy) link counts as trusted", () => {
    const db = makeMockDb({
      outgoing: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, null)],
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(TOPIC_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(
      db,
      pages,
      "我最近该去复查了吗",
      results,
      IDENTITY_SLUG,
    );
    expect(guardResult.outcome).toBe("pass");
  });

  test("subject itself in search results → pass (self-connection)", () => {
    const db = makeMockDb({});
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(IDENTITY_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(
      db,
      pages,
      "我最近该去复查了吗",
      results,
      IDENTITY_SLUG,
    );
    expect(guardResult.outcome).toBe("pass");
  });

  // #5: Conflicting dated evidence → insufficient.
  test("conflicting completed + pending timeline evidence → insufficient", () => {
    const db = makeMockDb({
      outgoing: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      timeline: [
        {
          event_date: "2026-06-01",
          summary: "已完成相关检查",
          trust_state: "trusted",
        },
        { event_date: "2026-07-01", summary: "待复查", trust_state: "trusted" },
      ],
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(TOPIC_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(
      db,
      pages,
      "我最近该去复查了吗",
      results,
      IDENTITY_SLUG,
    );
    expect(guardResult.outcome).toBe("insufficient_current_context");
    expect(guardResult.reason).toBe("conflicting dated evidence");
  });

  test("only completed timeline evidence → pass (no conflict)", () => {
    const db = makeMockDb({
      outgoing: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      timeline: [
        {
          event_date: "2026-06-01",
          summary: "已完成相关检查",
          trust_state: "trusted",
        },
      ],
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(TOPIC_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(
      db,
      pages,
      "我最近该去复查了吗",
      results,
      IDENTITY_SLUG,
    );
    expect(guardResult.outcome).toBe("pass");
  });

  test("candidate timeline evidence is ignored for conflict detection", () => {
    const db = makeMockDb({
      outgoing: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      timeline: [
        {
          event_date: "2026-06-01",
          summary: "已完成相关检查",
          trust_state: "trusted",
        },
        {
          event_date: "2026-07-01",
          summary: "待复查",
          trust_state: "candidate",
        },
      ],
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(TOPIC_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(
      db,
      pages,
      "我最近该去复查了吗",
      results,
      IDENTITY_SLUG,
    );
    // Candidate evidence does not trigger conflict — only trusted does.
    expect(guardResult.outcome).toBe("pass");
  });

  // Bounded budget: timeline beyond MAX_TIMELINE_BUDGET (5) is not inspected.
  test("timeline budget is bounded to 5 entries", () => {
    const timeline = Array.from({ length: 10 }, (_, i) => ({
      event_date: `2026-0${(i % 9) + 1}-01`,
      summary: i < 5 ? "已完成检查" : "待复查",
      trust_state: "trusted" as const,
    }));
    const db = makeMockDb({
      outgoing: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      timeline,
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const results = [makeResult(TOPIC_SLUG)];
    const guardResult = applyPersonalCurrentStateGuard(
      db,
      pages,
      "我最近该去复查了吗",
      results,
      IDENTITY_SLUG,
    );
    // First 5 are all "已完成" — no conflict detected.
    expect(guardResult.outcome).toBe("pass");
  });
});
