import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { attachRetrievalSupport } from "../../src/core/retrieval/retrieval-support.js";
import type { SearchResult, SearchOptions } from "../../src/core/retrieval/search.js";
import { registerFrontdoorTools } from "../../src/mcp/tools/frontdoor.js";
import type { LinkRow } from "../../src/storage/sqlite.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { applyPersonalCurrentStateGuard } from "../../src/core/retrieval/personal-current-state-guard.js";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const IDENTITY_SLUG = "brain/entities/subject-a";
const TOPIC_SLUG = "brain/entities/topic-d";
const OLD_REMINDER_SLUG = "records/reminder-old";
const NEIGHBOR_B = "brain/entities/neighbor-b";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

function supportedResult(slug: string, snippet = "匿名片段"): SearchResult {
  return attachRetrievalSupport(
    { slug, score: 0.5, snippet, source: "hybrid" },
    { exact: { original: { rankScore: 1 } } },
  );
}

function trustedLink(from: string, to: string): LinkRow {
  return {
    id: 1, from_slug: from, to_slug: to, relation: "关联", weight: 0.5,
    strength: "medium", context: null, source_type: "wikilink", confidence: 0.8,
    created_at: "2026-01-01T00:00:00Z", last_validated_at: null, effective_weight: 0.4,
    source_page_slug: from, trust_state: "trusted",
  };
}

interface MockHarness {
  call: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
  searchCalls: Array<{ query: string; options?: SearchOptions }>;
  guardDbCalls: string[];
}

function makeMockHarness(
  results: SearchResult[],
  opts: {
    identityPersonSlug?: string;
    trustedLinks?: LinkRow[];
    timelineBySlug?: Record<string, Array<{ page_slug: string; event_date: string; summary: string; trust_state?: string }>>;
    outputMode?: "legacy" | "structured";
  } = {},
): MockHarness {
  let handler: Handler | undefined;
  const searchCalls: Array<{ query: string; options?: SearchOptions }> = [];
  const guardDbCalls: string[] = [];
  const server = {
    registerTool(name: string, _def: unknown, registered: Handler) {
      if (name === "cbrain_recall") handler = registered;
    },
  };
  const db = {
    getBoundedTrustedLinks(slug: string, _l: number) { guardDbCalls.push(`tl:${slug}`); return opts.trustedLinks ?? []; },
    getBoundedTrustedTimelineForSlugs(slugs: string[], _l: number) {
      guardDbCalls.push(`t:${slugs.length}`);
      const out: Array<{ page_slug: string; event_date: string; summary: string; trust_state?: string }> = [];
      for (const s of slugs) out.push(...(opts.timelineBySlug?.[s] ?? []));
      return out;
    },
    batchGetTimelineForSlugs(slugs: string[]) { return new Map(slugs.map((s) => [s, []])); },
    batchGetLinksForSlugs(slugs: string[]) { return new Map(slugs.map((s) => [s, { outgoing: [], incoming: [] }])); },
    getPageTitlesAndTypes(slugs: string[]) { return new Map(slugs.map((s) => [s, { title: "匿名来源", type: "note" }])); },
    getRawChunkHitsForPage() { return []; }, getChunksByPage() { return []; },
    isSealedPage() { return false; }, getL1Summary() { return null; },
  };
  const ctx = {
    outputMode: opts.outputMode ?? "legacy" as const,
    search: { async search(query: string, options?: SearchOptions) { searchCalls.push({ query, options }); return results; } },
    pages: {
      getBySlug(slug: string) {
        if (slug === IDENTITY_SLUG && opts.identityPersonSlug) return { type: "entity/person", title: "主体A", body: "" };
        return { title: "匿名来源", body: "匿名正文" };
      },
    },
    db, identityPersonSlug: opts.identityPersonSlug,
    logger: { info() {}, warn() {}, error() {} },
  };
  registerFrontdoorTools(server as never, ctx as never);
  if (!handler) throw new Error("handler not registered");
  return { call: (args) => handler!(args), searchCalls, guardDbCalls };
}

interface LegacyEnvelope {
  display: string;
  summary: { status: string };
  raw: { entities: unknown[]; subject_context_candidates?: unknown[] };
}
function parsedLegacy(output: { content: Array<{ type: string; text: string }> }): LegacyEnvelope {
  return JSON.parse(output.content[0]!.text) as LegacyEnvelope;
}

describe("frontdoor personal current-state guard (#385) — mock", () => {
  test("personal query without identity → degraded", async () => {
    const h = makeMockHarness([supportedResult(OLD_REMINDER_SLUG)]);
    const env = parsedLegacy(await h.call({ query: "我该吃药了吗", detail: "normal" }));
    expect(env.summary.status).toBe("degraded");
    expect(env.raw.entities).toEqual([]);
    expect(env.display).toContain("没有可用的个人身份映射");
  });

  test("trusted chain → degraded + same-subject candidates in legacy response", async () => {
    const h = makeMockHarness([supportedResult(TOPIC_SLUG)], {
      identityPersonSlug: IDENTITY_SLUG,
      trustedLinks: [trustedLink(IDENTITY_SLUG, TOPIC_SLUG)],
      timelineBySlug: { [TOPIC_SLUG]: [{ page_slug: TOPIC_SLUG, event_date: "2026-06-01", summary: "已完成相关检查", trust_state: "trusted" }] },
    });
    const env = parsedLegacy(await h.call({ query: "我该吃药了吗", detail: "normal" }));
    expect(env.summary.status).toBe("degraded");
    expect(env.raw.subject_context_candidates).toBeDefined();
    expect((env.raw.subject_context_candidates as unknown[]).length).toBe(1);
  });

  // P1#2 r8: final structured sanitization preserves safe source + provenance
  test("structured mode preserves safe source and provenance", async () => {
    const h = makeMockHarness([supportedResult(TOPIC_SLUG)], {
      identityPersonSlug: IDENTITY_SLUG,
      trustedLinks: [trustedLink(IDENTITY_SLUG, TOPIC_SLUG)],
      timelineBySlug: { [TOPIC_SLUG]: [{ page_slug: TOPIC_SLUG, event_date: "2026-06-01", summary: "已完成相关检查", trust_state: "user_thought" }] },
      outputMode: "structured",
    });
    const output = await h.call({ query: "我该吃药了吗", detail: "normal" });
    const parsed = JSON.parse(output.content[0]!.text) as {
      data: { details?: { subject_context_candidates?: Array<Record<string, unknown>> } };
    };
    const candidate = parsed.data.details?.subject_context_candidates?.[0];
    expect(candidate).toEqual({
      source_title: "匿名来源",
      event_date: "2026-06-01",
      summary: "已完成相关检查",
      provenance: "user_thought",
      topic_relevance: "unverified",
    });
    expect(candidate).not.toHaveProperty("slug");
    expect(candidate).not.toHaveProperty("trust");
  });

  test("trusted chain with candidates → next_steps about structured status", async () => {
    const h = makeMockHarness([supportedResult(TOPIC_SLUG)], {
      identityPersonSlug: IDENTITY_SLUG,
      trustedLinks: [trustedLink(IDENTITY_SLUG, TOPIC_SLUG)],
      timelineBySlug: { [TOPIC_SLUG]: [{ page_slug: TOPIC_SLUG, event_date: "2026-06-01", summary: "已完成", trust_state: "trusted" }] },
    });
    const env = parsedLegacy(await h.call({ query: "我该吃药了吗", detail: "normal" }));
    const text = JSON.stringify(env);
    expect(text).toContain("结构化状态");
    expect(text).not.toContain("补充主体与主题的关联");
    expect(text).toContain("同主体候选上下文");
  });

  test("trusted chain without timeline → structured-state next_steps, not relation", async () => {
    const h = makeMockHarness([supportedResult(TOPIC_SLUG)], {
      identityPersonSlug: IDENTITY_SLUG,
      trustedLinks: [trustedLink(IDENTITY_SLUG, TOPIC_SLUG)],
    });
    const env = parsedLegacy(await h.call({ query: "我该吃药了吗", detail: "normal" }));
    const text = JSON.stringify(env);
    expect(text).toContain("结构化状态");
    expect(text).not.toContain("补充主体与主题的关联");
  });

  // P1#3 r7: historical fact queries do NOT trigger guard
  test.each([
    "我上次复查结果怎么样",
    "我最近看病花了多少钱",
    "我最近的用药记录是什么",
    "What am I currently reading",
    "Am I still taking notes",
  ])("non-advice query does not trigger guard: %s", async (q) => {
    const h = makeMockHarness([supportedResult(TOPIC_SLUG)], { identityPersonSlug: IDENTITY_SLUG });
    await h.call({ query: q, detail: "normal" });
    expect(h.guardDbCalls).toEqual([]);
  });

  test("non-personal query → zero guard calls", async () => {
    const h = makeMockHarness([supportedResult(TOPIC_SLUG)], { identityPersonSlug: IDENTITY_SLUG });
    const env = parsedLegacy(await h.call({ query: "主题D是什么", detail: "normal" }));
    expect(h.guardDbCalls).toEqual([]);
    expect(env.summary.status).toBe("ok");
  });
});

// ── Real SQLite e2e ──

function seedPage(db: CBrainDB, vaultPath: string, slug: string, title: string, type: string): void {
  db.upsertPage({ slug, type, title, filePath: `${slug}.md`, contentHash: `h-${slug}` });
  const dir = join(vaultPath, ...slug.split("/").slice(0, -1));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(vaultPath, `${slug}.md`), `---\ntitle: "${title}"\ntype: ${type}\nslug: ${slug}\n---\n`);
}

function seedLink(db: CBrainDB, from: string, to: string, trustState: string): void {
  db.rawDb
    .prepare("INSERT INTO links (from_slug, to_slug, relation, weight, strength, source_type, confidence, source_page_slug, trust_state) VALUES (?, ?, '关联', 0.5, 'medium', 'wikilink', 0.8, ?, ?)")
    .run(from, to, from, trustState);
}

function seedTimeline(db: CBrainDB, slug: string, summary: string, date: string, trustState: string): void {
  db.rawDb
    .prepare("INSERT INTO timeline (page_slug, summary, event_date, source, source_page_slug, trust_state) VALUES (?, ?, ?, ?, ?, ?)")
    .run(slug, summary, date, "manual", slug, trustState);
}

describe("frontdoor personal current-state guard (#385) — real SQLite e2e", () => {
  const testDir = "/tmp/cbrain-test-385-e2e";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  // P1#2 r7 CORE: search finds old reminder, newer record on neighbor excluded from top-k
  // → guard discovers neighbor's record via trusted neighborhood timeline
  test("guard discovers newer record on neighbor excluded from search top-k", () => {
    seedPage(db, vaultPath, IDENTITY_SLUG, "主体A", "entity/person");
    seedPage(db, vaultPath, OLD_REMINDER_SLUG, "旧提醒", "record");
    seedPage(db, vaultPath, NEIGHBOR_B, "更新记录", "entity/person");
    seedLink(db, IDENTITY_SLUG, OLD_REMINDER_SLUG, "trusted");
    seedLink(db, IDENTITY_SLUG, NEIGHBOR_B, "trusted");
    seedTimeline(db, NEIGHBOR_B, "已完成相关检查", "2026-07-01", "trusted");

    const pages = { getBySlug: (slug: string) => slug === IDENTITY_SLUG ? { type: "entity/person", title: "主体A" } : slug === NEIGHBOR_B ? { type: "entity/person", title: "更新记录" } : null };
    const result = applyPersonalCurrentStateGuard(db, pages, "我该吃药了吗", [makeResult(OLD_REMINDER_SLUG)], IDENTITY_SLUG);
    expect(result.outcome).toBe("insufficient_current_context");
    expect(result.subjectContextCandidates).toBeDefined();
    expect(result.subjectContextCandidates!.length).toBe(1);
    expect(result.subjectContextCandidates![0]!.source_page_slug).toBe(NEIGHBOR_B);
    expect(result.subjectContextCandidates![0]!.source_title).toBe("更新记录");
    expect(result.subjectContextCandidates![0]!.summary).toBe("已完成相关检查");
  });
  test("bounded guard query rejects malformed semantic dates", () => {
    seedPage(db, vaultPath, NEIGHBOR_B, "更新记录", "entity/person");
    // Legacy rows with invalid dates — global writers store them as-is.
    // Only the #385 bounded guard query filters them.
    db.rawDb.prepare("INSERT INTO timeline (page_slug, summary, event_date, trust_state) VALUES (?, ?, ?, ?)").run(NEIGHBOR_B, "遗留非法日期", "2026-99-01", "trusted");
    db.rawDb.prepare("INSERT INTO timeline (page_slug, summary, event_date, trust_state) VALUES (?, ?, ?, ?)").run(NEIGHBOR_B, "空日期", "", "trusted");
    db.rawDb.prepare("INSERT INTO timeline (page_slug, summary, event_date, trust_state) VALUES (?, ?, ?, ?)").run(NEIGHBOR_B, "有效日期", "2026-01-01", "trusted");
    const rows = db.getBoundedTrustedTimelineForSlugs([NEIGHBOR_B], 5);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toBe("有效日期");
  });

  test("non-personal query does not activate", () => {
    seedPage(db, vaultPath, IDENTITY_SLUG, "主体A", "entity/person");
    const pages = { getBySlug: (slug: string) => slug === IDENTITY_SLUG ? { type: "entity/person", title: "主体A" } : null };
    const result = applyPersonalCurrentStateGuard(db, pages, "实体A是什么", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(result.activated).toBe(false);
  });
});

function makeResult(slug: string): SearchResult {
  return { slug, score: 0.5, snippet: "匿名片段", source: "hybrid" };
}
