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

function makeMockDb(opts: { trustedLinks?: LinkRow[] } = {}): CBrainDB {
  return {
    getBoundedTrustedLinks: (_slug: string, _limit: number) => opts.trustedLinks ?? [],
  } as unknown as CBrainDB;
}

function makeMockPages(identityPage?: { type: string; title?: string } | null): GuardPageLookup {
  const store: Record<string, { type: string; title?: string }> = {};
  if (identityPage) store[IDENTITY_SLUG] = identityPage;
  return { getBySlug: (slug: string) => store[slug] ?? null };
}

// ── Intent detection ──

describe("isFirstPersonQuery (#385) — casing matrix (P1#2)", () => {
  test.each([
    "我该吃药了吗",
    "should I go for a checkup",
    "should i go for a checkup", // lowercase i
    "Is My checkup overdue", // capitalized My
    "IS MY CHECKUP OVERDUE", // all caps
    "is my medication due",
    "my checkup is overdue",
  ])("detects first-person in: %s", (q) => {
    expect(isFirstPersonQuery(q)).toBe(true);
  });

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
    "should i go for a checkup", // P1#2 lowercase
    "is it time for my checkup",
    "is it time for my checkup", // P1#2 mixed case
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

// ── Guard logic — phase-1 always fail-closed ──

describe("applyPersonalCurrentStateGuard (#385) — phase-1 always insufficient", () => {
  test("non-personal query does not activate", () => {
    const r = applyPersonalCurrentStateGuard(makeMockDb(), makeMockPages({ type: "entity/person" }), "实体A是什么", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(r.activated).toBe(false);
    expect(r.outcome).toBe("pass");
  });

  test("no identity → insufficient", () => {
    const r = applyPersonalCurrentStateGuard(makeMockDb(), makeMockPages(), "我该吃药了吗", [makeResult(OLD_REMINDER_SLUG)], undefined);
    expect(r.outcome).toBe("insufficient_current_context");
    expect(r.reason).toBe("no identity mapping configured");
  });

  test("identity page not found → insufficient", () => {
    const r = applyPersonalCurrentStateGuard(makeMockDb(), makeMockPages(null), "我该吃药了吗", [makeResult(OLD_REMINDER_SLUG)], IDENTITY_SLUG);
    expect(r.reason).toBe("identity page not found");
  });

  test("bare entity type → insufficient", () => {
    const r = applyPersonalCurrentStateGuard(makeMockDb(), makeMockPages({ type: "entity" }), "我该吃药了吗", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(r.reason).toBe("identity is not entity/person");
  });

  test("entity/company type → insufficient", () => {
    const r = applyPersonalCurrentStateGuard(makeMockDb(), makeMockPages({ type: "entity/company" }), "我该吃药了吗", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(r.reason).toBe("identity is not entity/person");
  });

  test("no trusted chain → insufficient", () => {
    const db = makeMockDb({ trustedLinks: [] });
    const r = applyPersonalCurrentStateGuard(db, makeMockPages({ type: "entity/person" }), "我该吃药了吗", [makeResult(OLD_REMINDER_SLUG)], IDENTITY_SLUG);
    expect(r.outcome).toBe("insufficient_current_context");
    expect(r.reason).toBe("no trusted subject-to-topic chain");
  });

  // P1#1 r5 CORE: trusted chain exists but phase-1 still cannot prove current state
  test("trusted chain exists → STILL insufficient (phase-1 semantic limit)", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, OLD_REMINDER_SLUG, "trusted")],
    });
    const r = applyPersonalCurrentStateGuard(db, makeMockPages({ type: "entity/person" }), "我该吃药了吗", [makeResult(OLD_REMINDER_SLUG)], IDENTITY_SLUG);
    expect(r.outcome).toBe("insufficient_current_context");
    expect(r.reason).toContain("phase-1 model cannot prove current state");
    expect(r.debugSearchMaterial).toEqual([makeResult(OLD_REMINDER_SLUG)]);
  });

  // P1#1 r5: even with completed/pending evidence, still insufficient
  test("candidate with completed evidence → STILL insufficient", () => {
    const db = makeMockDb({
      trustedLinks: [makeLink(IDENTITY_SLUG, TOPIC_SLUG, "trusted")],
    });
    const r = applyPersonalCurrentStateGuard(db, makeMockPages({ type: "entity/person" }), "我该吃药了吗", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(r.outcome).toBe("insufficient_current_context");
  });
});
