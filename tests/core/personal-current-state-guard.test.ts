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
  return {
    getBySlug: (slug: string) => store[slug] ?? { type: "entity/person", title: slug.split("/").pop() ?? slug },
  };
}

// ── Intent detection ──

describe("isFirstPersonQuery (#385) — casing matrix", () => {
  test.each([
    "我该吃药了吗",
    "should I go for a checkup",
    "should i go for a checkup",
    "Is My checkup overdue",
    "IS MY CHECKUP OVERDUE",
  ])("detects first-person: %s", (q) => expect(isFirstPersonQuery(q)).toBe(true));

  test.each(["实体A是什么"])("no first-person: %s", (q) => expect(isFirstPersonQuery(q)).toBe(false));
});

describe("isPersonalCurrentStateQuery (#385) — r7 advice-only grammar", () => {
  // Advice predicates — trigger
  test.each([
    "我该不该去复查",
    "我的体检到期了吗",
    "我该吃药了吗",
    "我需不需要复查",
    "should I go for a checkup",
    "should i go for a checkup",
    "is it time for my checkup",
    "do I need to see a doctor",
    "is my checkup overdue",
  ])("activates for advice: %s", (q) => expect(isPersonalCurrentStateQuery(q)).toBe(true));

  test.each([
    "What medication am I currently on?",
    "What medications am I currently taking?",
    "What medication am I taking currently?",
    "What medicine am I currently taking?",
    "What prescriptions am I currently taking?",
    "am I currently on any medication?",
    "do I currently take medication?",
    "我现在在吃什么药？",
    "我现在吃的是什么药？",
    "我目前正在吃什么药？",
    "我现在服用的药物有哪些？",
    "我目前用什么药？",
    "我现在有服药吗？",
    "我目前是否用药？",
    "我有在吃药吗？",
  ])("activates for controlled medication current state: %s", (q) => {
    expect(isPersonalCurrentStateQuery(q)).toBe(true);
  });

  // r10/r11: false positives — ordinary queries about medication as a topic
  test.each([
    "My medication article is on the desk",
    "What did I write on medications?",
    "Show me my notes on medication",
    "What medications are discussed in my paper?",
    "What medicines are available in my country?",
    "What medications am I writing about?",
    "What medicines am I comparing?",
    "What medications are you taking for my report?",
    "我现在研究的药物是什么？",
    "我目前关注的药物有哪些？",
    "我当前文章里的药物是什么？",
    "我用什么方法识别药物？",
    "我吃什么食物会影响药物吸收？",
    "我服装里有哪些药物图案？",
  ])("does NOT activate for medication-as-topic: %s", (q) => {
    expect(isPersonalCurrentStateQuery(q)).toBe(false);
  });

  // P1#3 r7: generic English current-state phrases — must NOT trigger
  test.each([
    "What am I currently reading",
    "What project am I currently on",
    "Am I still taking notes",
    "What is my medication called",
    "Show my appointment notes",
    "我的工资发放周期是什么",
    "我的代码检查结果是什么",
  ])("does NOT activate for non-advice: %s", (q) => {
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

  test("no trusted chain → insufficient with bounded disclaimer", () => {
    const db = makeMockDb({ trustedLinks: [] });
    const r = applyPersonalCurrentStateGuard(db, makeMockPages({ type: "entity/person" }), "我该吃药了吗", [makeResult(OLD_REMINDER_SLUG)], IDENTITY_SLUG);
    expect(r.reason).toContain("bounded inspection");
  });

  // P1#2 r7: timeline reads ALL trusted neighbors, not just connected search results
  test("timeline discovers record on non-search neighbor (old reminder + newer neighbor record)", () => {
    const db = makeMockDb({
      trustedLinks: [
        makeLink(IDENTITY_SLUG, OLD_REMINDER_SLUG, "trusted"),
        makeLink(IDENTITY_SLUG, NEIGHBOR_B, "trusted"),
      ],
      // Old reminder: no timeline. Neighbor B: has newer completed record.
      timelineBySlug: {
        [NEIGHBOR_B]: [{ page_slug: NEIGHBOR_B, event_date: "2026-07-01", summary: "已完成相关检查", trust_state: "trusted" }],
      },
    });
    // Search only found old reminder — neighbor B excluded from top-k
    const r = applyPersonalCurrentStateGuard(db, makeMockPages({ type: "entity/person" }), "我该吃药了吗", [makeResult(OLD_REMINDER_SLUG)], IDENTITY_SLUG);
    expect(r.outcome).toBe("insufficient_current_context");
    expect(r.subjectContextCandidates).toEqual([
      {
        source_page_slug: NEIGHBOR_B,
        source_title: "neighbor-b",
        event_date: "2026-07-01",
        summary: "已完成相关检查",
        provenance: "trusted",
        topic_relevance: "unverified",
      },
    ]);
  });

  // P2#5: unknown trust_state NOT promoted to trusted
  test("entries with missing trust_state are excluded from candidates", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      timelineBySlug: {
        [TOPIC_SLUG]: [
          { page_slug: TOPIC_SLUG, event_date: "2026-06-01", summary: "已完成", trust_state: undefined },
        ],
      },
    });
    const r = applyPersonalCurrentStateGuard(db, makeMockPages({ type: "entity/person" }), "我该吃药了吗", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(r.subjectContextCandidates).toEqual([]);
    expect(r.gap).toBe("structured_state");
  });

  test("user_thought provenance preserved in candidate", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      timelineBySlug: {
        [TOPIC_SLUG]: [
          { page_slug: TOPIC_SLUG, event_date: "2026-06-01", summary: "待复查", trust_state: "user_thought" },
        ],
      },
    });
    const r = applyPersonalCurrentStateGuard(db, makeMockPages({ type: "entity/person" }), "我该吃药了吗", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(r.subjectContextCandidates![0]!.provenance).toBe("user_thought");
  });

  test("identity-page search hit without relation remains subject-relation gap", () => {
    const db = makeMockDb();
    const r = applyPersonalCurrentStateGuard(db, makeMockPages({ type: "entity/person" }), "我该吃药了吗", [makeResult(IDENTITY_SLUG)], IDENTITY_SLUG);
    expect(r.gap).toBe("subject_relation");
    expect(r.subjectContextCandidates).toBeUndefined();
  });

  test("trusted relation without timeline reports structured-state gap", () => {
    const db = makeMockDb({ trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")] });
    const r = applyPersonalCurrentStateGuard(db, makeMockPages({ type: "entity/person" }), "我该吃药了吗", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(r.gap).toBe("structured_state");
    expect(r.subjectContextCandidates).toEqual([]);
  });

  test.each([
    { date: "", summary: "空日期" },
    { date: "已完成", summary: "非法日期" },
    { date: "2026-99-01", summary: "非法月份" },
  ])("invalid semantic date is excluded: $date", ({ date, summary }) => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
      timelineBySlug: {
        [TOPIC_SLUG]: [{ page_slug: TOPIC_SLUG, event_date: date, summary, trust_state: "trusted" }],
      },
    });
    const r = applyPersonalCurrentStateGuard(db, makeMockPages({ type: "entity/person" }), "我该吃药了吗", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(r.subjectContextCandidates).toEqual([]);
  });
});
