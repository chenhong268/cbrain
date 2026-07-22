import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { attachRetrievalSupport } from "../../src/core/retrieval/retrieval-support.js";
import type { SearchResult, SearchOptions } from "../../src/core/retrieval/search.js";
import { registerFrontdoorTools } from "../../src/mcp/tools/frontdoor.js";
import type { LinkRow } from "../../src/storage/sqlite.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";



// ── Anonymized fixtures ──
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

// ── Mock harness (for non-DB tests) ──

interface MockHarness {
  call: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
  searchCalls: Array<{ query: string; options?: SearchOptions }>;
  guardDbCalls: string[];
}

function trustedLink(from: string, to: string): LinkRow {
  return {
    id: 1,
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
    trust_state: "trusted",
  };
}

function makeMockHarness(
  results: SearchResult[],
  opts: {
    identityPersonSlug?: string;
    trustedLinks?: LinkRow[];
    timelineBySlug?: Record<string, Array<{ page_slug: string; event_date: string; summary: string; trust_state?: string }>>;
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
    getBoundedTrustedLinks(slug: string, _limit: number) {
      guardDbCalls.push(`trustedLinks:${slug}`);
      return opts.trustedLinks ?? [];
    },
    getBoundedTrustedTimelineForSlugs(slugs: string[], _limit: number) {
      guardDbCalls.push(`timeline:${slugs.join(",")}`);
      const out: Array<{ page_slug: string; event_date: string; summary: string; trust_state?: string }> = [];
      for (const s of slugs) out.push(...(opts.timelineBySlug?.[s] ?? []));
      return out;
    },
    batchGetTimelineForSlugs(slugs: string[]) {
      return new Map(slugs.map((s) => [s, [{ summary: "匿名时间线", event_date: "2026-01-01", trust_state: "trusted" }]]));
    },
    batchGetLinksForSlugs(slugs: string[]) {
      return new Map(slugs.map((s) => [s, { outgoing: [{ from_slug: s, to_slug: "匿名目标", relation: "关联", trust_state: "trusted" }], incoming: [] }]));
    },
    getPageTitlesAndTypes(slugs: string[]) {
      return new Map(slugs.map((s) => [s, { title: `标题-${s}`, type: "note" }]));
    },
    getRawChunkHitsForPage() { return []; },
    getChunksByPage() { return []; },
    isSealedPage() { return false; },
    getL1Summary() { return null; },
  };

  const ctx = {
    outputMode: "legacy" as const,
    search: {
      async search(query: string, options?: SearchOptions) {
        searchCalls.push({ query, options });
        return results;
      },
    },
    pages: {
      getBySlug(slug: string) {
        if (slug === IDENTITY_SLUG && opts.identityPersonSlug) {
          return { type: "entity/person", title: "主体A", body: "" };
        }
        return { title: `标题-${slug}`, body: `正文-${slug}` };
      },
    },
    db,
    identityPersonSlug: opts.identityPersonSlug,
    logger: { info() {}, warn() {}, error() {} },
  };

  registerFrontdoorTools(server as never, ctx as never);
  if (!handler) throw new Error("frontdoor handler not registered");
  return { call: (args) => handler!(args), searchCalls, guardDbCalls };
}

interface Envelope {
  summary: { status: string; degraded_reason?: string };
  raw: { entities: unknown[] };
  display: string;
}

function parsed(output: { content: Array<{ type: string; text: string }> }): Envelope {
  return JSON.parse(output.content[0]!.text) as Envelope;
}

// ── Mock-based integration tests ──

describe("frontdoor personal current-state guard (#385) — mock", () => {
  test("personal query without identity → degraded", async () => {
    const h = makeMockHarness([supportedResult(OLD_REMINDER_SLUG)]);
    const env = parsed(await h.call({ query: "我最近该去复查了吗", detail: "normal" }));
    expect(env.summary.status).toBe("degraded");
    expect(env.raw.entities).toEqual([]);
  });

  test("old reminder + no trusted chain → degraded", async () => {
    const h = makeMockHarness([supportedResult(OLD_REMINDER_SLUG)], { identityPersonSlug: IDENTITY_SLUG });
    const env = parsed(await h.call({ query: "我最近该去复查了吗", detail: "normal" }));
    expect(env.summary.status).toBe("degraded");
    expect(JSON.stringify(env)).not.toContain(OLD_REMINDER_SLUG);
  });

  test("trusted chain + candidate with own evidence → ok", async () => {
    const h = makeMockHarness([supportedResult(TOPIC_SLUG)], {
      identityPersonSlug: IDENTITY_SLUG,
      trustedLinks: [trustedLink(IDENTITY_SLUG, TOPIC_SLUG)],
      timelineBySlug: { [TOPIC_SLUG]: [{ page_slug: TOPIC_SLUG, event_date: "2026-06-01", summary: "已完成相关检查", trust_state: "trusted" }] },
    });
    const env = parsed(await h.call({ query: "我最近该去复查了吗", detail: "normal" }));
    expect(env.summary.status).toBe("ok");
    expect(env.raw.entities.length).toBeGreaterThan(0);
  });

  // P1#1 r3: cross-neighbor leak — neighbor has evidence, candidate does not
  test("cross-neighbor timeline leak → candidate without own evidence degraded", async () => {
    const h = makeMockHarness([supportedResult(OLD_REMINDER_SLUG)], {
      identityPersonSlug: IDENTITY_SLUG,
      trustedLinks: [trustedLink(IDENTITY_SLUG, OLD_REMINDER_SLUG), trustedLink(IDENTITY_SLUG, NEIGHBOR_B)],
      timelineBySlug: {
        [NEIGHBOR_B]: [{ page_slug: NEIGHBOR_B, event_date: "2026-06-01", summary: "已完成相关检查", trust_state: "trusted" }],
        [OLD_REMINDER_SLUG]: [],
      },
    });
    const env = parsed(await h.call({ query: "我最近该去复查了吗", detail: "normal" }));
    expect(env.summary.status).toBe("degraded");
    expect(env.raw.entities).toEqual([]);
  });

  // P1#3 r3: bare nouns do NOT trigger guard
  test.each([
    "我的代码检查结果是什么",
    "我最近用运动相机拍了什么",
    "我最近从保险箱取了什么",
    "我最近看了哪部院线电影",
    "我最近有哪些研究报告",
    "我上次提交了哪段代码",
    "我最近看了什么书",
  ])("bare-noun query does not trigger guard: %s", async (q) => {
    const h = makeMockHarness([supportedResult(TOPIC_SLUG)], { identityPersonSlug: IDENTITY_SLUG });
    const env = parsed(await h.call({ query: q, detail: "normal" }));
    expect(h.guardDbCalls).toEqual([]);
    expect(env.summary.status).toBe("ok");
  });

  // Non-personal: zero guard DB calls
  test("non-personal query → zero guard calls", async () => {
    const h = makeMockHarness([supportedResult(TOPIC_SLUG)], { identityPersonSlug: IDENTITY_SLUG });
    const env = parsed(await h.call({ query: "主题D是什么", detail: "normal" }));
    expect(h.guardDbCalls).toEqual([]);
    expect(env.summary.status).toBe("ok");
  });
});


function seedPage(db: CBrainDB, vaultPath: string, slug: string, title: string, type: string): void {
  db.upsertPage({ slug, type, title, filePath: `${slug}.md`, contentHash: `h-${slug}` });
  const dir = join(vaultPath, ...slug.split("/").slice(0, -1));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(vaultPath, `${slug}.md`), `---\ntitle: "${title}"\ntype: ${type}\nslug: ${slug}\n---\n`);
}

function seedLink(db: CBrainDB, from: string, to: string, trustState: string): void {
  db.rawDb
    .prepare(
      "INSERT INTO links (from_slug, to_slug, relation, weight, strength, source_type, confidence, source_page_slug, trust_state) VALUES (?, ?, '关联', 0.5, 'medium', 'wikilink', 0.8, ?, ?)",
    )
    .run(from, to, from, trustState);
}

function seedTimeline(db: CBrainDB, slug: string, summary: string, date: string, trustState: string): void {
  db.rawDb
    .prepare("INSERT INTO timeline (page_slug, summary, event_date, source, source_page_slug, trust_state) VALUES (?, ?, ?, ?, ?, ?)")
    .run(slug, summary, date, "manual", slug, trustState);
}

describe("frontdoor personal current-state guard (#385) — real SQLite", () => {
  const testDir = "/tmp/cbrain-test-385-sqlite";
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

  test("P1#1 core: candidate A connected but no evidence, neighbor B has evidence → A is NOT surfaced", () => {
    // Seed: identity person
    seedPage(db, vaultPath, IDENTITY_SLUG, "主体A", "entity/person");
    // Seed: old reminder (search result) — connected to subject but no own timeline
    seedPage(db, vaultPath, OLD_REMINDER_SLUG, "旧提醒", "record");
    // Seed: neighbor B — has trusted timeline but is NOT a search result
    seedPage(db, vaultPath, NEIGHBOR_B, "邻居B", "entity/person");
    // Links: both old reminder and neighbor B are trusted-connected to subject
    seedLink(db, IDENTITY_SLUG, OLD_REMINDER_SLUG, "trusted");
    seedLink(db, IDENTITY_SLUG, NEIGHBOR_B, "trusted");
    // Timeline: only neighbor B has evidence; old reminder has NONE
    seedTimeline(db, NEIGHBOR_B, "已完成相关检查", "2026-06-01", "trusted");
    // OLD_REMINDER has no timeline entry

    // Verify the guard sees the issue: query timeline for OLD_REMINDER → empty
    const candidateTimeline = db.getBoundedTrustedTimelineForSlugs([OLD_REMINDER_SLUG], 5);
    expect(candidateTimeline).toHaveLength(0);

    // And neighbor B's timeline should NOT be readable for OLD_REMINDER
    const neighborTimeline = db.getBoundedTrustedTimelineForSlugs([NEIGHBOR_B], 5);
    expect(neighborTimeline).toHaveLength(1);
  });

  test("P2#3: 未完成 is pending-only, not matched as completed", () => {
    seedPage(db, vaultPath, IDENTITY_SLUG, "主体A", "entity/person");
    seedPage(db, vaultPath, TOPIC_SLUG, "主题D", "entity/person");
    seedLink(db, IDENTITY_SLUG, TOPIC_SLUG, "trusted");
    seedTimeline(db, TOPIC_SLUG, "未完成相关检查", "2026-06-01", "trusted");

    const timeline = db.getBoundedTrustedTimelineForSlugs([TOPIC_SLUG], 5);
    expect(timeline).toHaveLength(1);
    // The summary "未完成相关检查" should be pending, NOT completed
    expect(/待办|未完成|计划中|待复查|需复查|pending|scheduled|upcoming|todo|待完成|需完成/i.test(timeline[0]!.summary)).toBe(true);
    // COMPLETED_MARKER with negative lookahead must NOT match "未完成"
    expect(/(?:^|[^未待需])完成|已完成|done|completed|finished|已结束|结案|已做/i.test(timeline[0]!.summary)).toBe(false);
  });
});
