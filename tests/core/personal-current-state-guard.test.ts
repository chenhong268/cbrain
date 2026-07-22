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

// ── Anonymized fixtures ──
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

/** Timeline store keyed by slug, simulating per-candidate reads. */
function makeMockDb(opts: {
  trustedLinks?: LinkRow[];
  timelineBySlug?: Record<string, TimelineEntry[]>;
} = {}): CBrainDB {
  return {
    getBoundedTrustedLinks: (_slug: string, _limit: number) => opts.trustedLinks ?? [],
    getBoundedTrustedTimelineForSlugs: (slugs: string[], _limit: number) => {
      const out: TimelineEntry[] = [];
      for (const s of slugs) {
        out.push(...(opts.timelineBySlug?.[s] ?? []));
      }
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

  test.each(["实体A是什么", "主题D的信息", "concept C is defined as"])(
    "no first-person in: %s",
    (q) => expect(isFirstPersonQuery(q)).toBe(false),
  );

  test("collective 我们 does not count", () => {
    expect(isFirstPersonQuery("我们公司的项目")).toBe(false);
  });
});

describe("isPersonalCurrentStateQuery (#385)", () => {
  // Direct action predicates — trigger on their own
  test.each([
    "我最近该去复查了吗",
    "我的体检到期了吗",
    "我该吃药了吗",
    "我还需要预约挂号吗",
    "should I go for a checkup",
    "is my medication due",
  ])("activates for: %s", (q) => {
    expect(isPersonalCurrentStateQuery(q)).toBe(true);
  });

  // P1#3: time marker + domain compound activates
  test("time marker + 复查 activates", () => {
    expect(isPersonalCurrentStateQuery("我上次复查结果怎么样")).toBe(true);
  });
  test("time marker + 治疗 activates", () => {
    expect(isPersonalCurrentStateQuery("我最近的治疗进展怎么样")).toBe(true);
  });

  // P1#3 r3 regression: bare nouns must NOT trigger
  test.each([
    "我最近看了哪部院线电影",
    "我最近有哪些研究报告",
    "我上次提交了哪段代码",
    "我最近看了什么书",
    "我的代码检查结果是什么", // bare 检查, not 复查
    "我最近用运动相机拍了什么", // 运动 removed from DOMAIN
    "我最近从保险箱取了什么", // 保险 removed from DOMAIN
    "我 liked the movie",
  ])("does NOT activate for: %s", (q) => {
    expect(isPersonalCurrentStateQuery(q)).toBe(false);
  });
});

// ── Guard logic — regression matrix ───────────────────────

describe("applyPersonalCurrentStateGuard (#385)", () => {
  // #7: non-personal → not activated
  test("non-personal query does not activate guard", () => {
    const db = makeMockDb();
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const r = applyPersonalCurrentStateGuard(db, pages, "实体A是什么", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(r.activated).toBe(false);
  });

  // #3: missing identity → insufficient
  test("personal query without identity → insufficient", () => {
    const r = applyPersonalCurrentStateGuard(makeMockDb(), makeMockPages(), "我最近该去复查了吗", [makeResult(OLD_REMINDER_SLUG)], undefined);
    expect(r.outcome).toBe("insufficient_current_context");
    expect(r.reason).toBe("no identity mapping configured");
  });

  test("identity page not found → insufficient", () => {
    const r = applyPersonalCurrentStateGuard(makeMockDb(), makeMockPages(null), "我最近该去复查了吗", [makeResult(OLD_REMINDER_SLUG)], IDENTITY_SLUG);
    expect(r.outcome).toBe("insufficient_current_context");
    expect(r.reason).toBe("identity page not found");
  });

  // P1#4: bare entity rejected
  test("bare entity type → insufficient", () => {
    const r = applyPersonalCurrentStateGuard(makeMockDb(), makeMockPages({ type: "entity" }), "我最近该去复查了吗", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(r.reason).toBe("identity is not entity/person");
  });

  // #1: no trusted chain → insufficient
  test("no trusted chain → insufficient", () => {
    const db = makeMockDb({ trustedLinks: [] });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const r = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", [makeResult(OLD_REMINDER_SLUG)], IDENTITY_SLUG);
    expect(r.reason).toBe("no trusted subject-to-topic chain");
  });

  // P1#1 r3: candidate with NO own timeline → insufficient (cross-neighbor leak fix)
  test("candidate connected but no own timeline → insufficient", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, OLD_REMINDER_SLUG, "trusted")],
      timelineBySlug: { [OLD_REMINDER_SLUG]: [] }, // candidate has no own evidence
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const r = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", [makeResult(OLD_REMINDER_SLUG)], IDENTITY_SLUG);
    expect(r.outcome).toBe("insufficient_current_context");
    expect(r.reason).toBe("no candidate with trusted dated current-state evidence");
  });

  // P1#1 r3 CORE: unrelated neighbor's timeline does NOT vouch for candidate
  test("cross-neighbor timeline leak: neighbor B has evidence but candidate A does not → insufficient", () => {
    const db = makeMockDb({
      // Both OLD_REMINDER and NEIGHBOR_B are trusted neighbors
      trustedLinks: [
        makeLink(IDENTITY_SLUG, OLD_REMINDER_SLUG, "trusted"),
        makeLink(IDENTITY_SLUG, NEIGHBOR_B, "trusted"),
      ],
      // Only NEIGHBOR_B has timeline; OLD_REMINDER (the search result) has none
      timelineBySlug: {
        [NEIGHBOR_B]: [tl("已完成相关检查", NEIGHBOR_B)],
        [OLD_REMINDER_SLUG]: [],
      },
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const r = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", [makeResult(OLD_REMINDER_SLUG)], IDENTITY_SLUG);
    expect(r.outcome).toBe("insufficient_current_context");
    expect(r.reason).toBe("no candidate with trusted dated current-state evidence");
  });

  // #4: candidate with own trusted dated evidence → pass
  test("candidate with own trusted dated evidence → pass", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      timelineBySlug: { [TOPIC_SLUG]: [tl("已完成相关检查")] },
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const r = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(r.outcome).toBe("pass");
    expect(r.filteredResults?.length).toBe(1);
    expect(r.filteredResults?.[0]?.slug).toBe(TOPIC_SLUG);
  });

  // P1#1: per-candidate filtering — stale reminder without evidence dropped
  test("mix: connected topic with evidence + old reminder without → only topic passes", () => {
    const db = makeMockDb({
      trustedLinks: [
        makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted"),
        makeLink(IDENTITY_SLUG, OLD_REMINDER_SLUG, "trusted"),
      ],
      timelineBySlug: {
        [TOPIC_SLUG]: [tl("已完成相关检查")],
        [OLD_REMINDER_SLUG]: [],
      },
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const r = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", [makeResult(OLD_REMINDER_SLUG), makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(r.outcome).toBe("pass");
    expect(r.filteredResults?.length).toBe(1);
    expect(r.filteredResults?.[0]?.slug).toBe(TOPIC_SLUG);
  });

  // #5: conflicting evidence on same candidate → skip that candidate
  test("conflicting completed+pending on same candidate → skipped", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      timelineBySlug: {
        [TOPIC_SLUG]: [
          tl("已完成相关检查", TOPIC_SLUG, "2026-06-01"),
          tl("待复查", TOPIC_SLUG, "2026-07-01"),
        ],
      },
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const r = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(r.outcome).toBe("insufficient_current_context");
    expect(r.reason).toBe("no candidate with trusted dated current-state evidence");
  });

  // P2#3: 未完成 is NOT matched as 完成 (互斥)
  test("未完成 is pending only, not completed (互斥)", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      timelineBySlug: {
        [TOPIC_SLUG]: [tl("未完成相关检查")],
      },
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const r = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    // Should pass — "未完成" is pending-only, no conflict with completed
    expect(r.outcome).toBe("pass");
  });

  test("已完成 is completed (no pending marker)", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      timelineBySlug: {
        [TOPIC_SLUG]: [tl("已完成相关检查")],
      },
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const r = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(r.outcome).toBe("pass");
  });

  test("subject itself in results with own timeline → pass", () => {
    const db = makeMockDb({
      timelineBySlug: { [IDENTITY_SLUG]: [tl("已完成", IDENTITY_SLUG)] },
    });
    const pages = makeMockPages({ type: "entity/person", title: "主体A" });
    const r = applyPersonalCurrentStateGuard(db, pages, "我最近该去复查了吗", [makeResult(IDENTITY_SLUG)], IDENTITY_SLUG);
    expect(r.outcome).toBe("pass");
  });
});
