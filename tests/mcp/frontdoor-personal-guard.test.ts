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

// ── Mock harness ──

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
    batchGetTimelineForSlugs(slugs: string[]) { return new Map(slugs.map((s) => [s, []])); },
    batchGetLinksForSlugs(slugs: string[]) { return new Map(slugs.map((s) => [s, { outgoing: [], incoming: [] }])); },
    getPageTitlesAndTypes(slugs: string[]) { return new Map(slugs.map((s) => [s, { title: `标题-${s}`, type: "note" }])); },
    getRawChunkHitsForPage() { return []; }, getChunksByPage() { return []; },
    isSealedPage() { return false; }, getL1Summary() { return null; },
  };
  const ctx = {
    outputMode: "legacy" as const,
    search: { async search(query: string, options?: SearchOptions) { searchCalls.push({ query, options }); return results; } },
    pages: {
      getBySlug(slug: string) {
        if (slug === IDENTITY_SLUG && opts.identityPersonSlug) return { type: "entity/person", title: "主体A", body: "" };
        return { title: `标题-${slug}`, body: `正文-${slug}` };
      },
    },
    db, identityPersonSlug: opts.identityPersonSlug,
    logger: { info() {}, warn() {}, error() {} },
  };
  registerFrontdoorTools(server as never, ctx as never);
  if (!handler) throw new Error("handler not registered");
  return { call: (args) => handler!(args), searchCalls, guardDbCalls };
}

interface Envelope { summary: { status: string }; raw: { entities: unknown[] }; display: string; }

function parsed(output: { content: Array<{ type: string; text: string }> }): Envelope {
  return JSON.parse(output.content[0]!.text) as Envelope;
}

describe("frontdoor personal current-state guard (#385) — mock", () => {
  // Phase-1: personal current-state queries ALWAYS degraded
  test("personal query without identity → degraded", async () => {
    const h = makeMockHarness([supportedResult(OLD_REMINDER_SLUG)]);
    const env = parsed(await h.call({ query: "我该吃药了吗", detail: "normal" }));
    expect(env.summary.status).toBe("degraded");
    expect(env.raw.entities).toEqual([]);
  });

  test("personal query with trusted chain → STILL degraded (phase-1)", async () => {
    const h = makeMockHarness([supportedResult(OLD_REMINDER_SLUG)], {
      identityPersonSlug: IDENTITY_SLUG,
      trustedLinks: [trustedLink(IDENTITY_SLUG, OLD_REMINDER_SLUG)],
    });
    const env = parsed(await h.call({ query: "我该吃药了吗", detail: "normal" }));
    expect(env.summary.status).toBe("degraded");
    expect(env.raw.entities).toEqual([]);
  });

  // P1#2: English casing variants all trigger guard
  test.each([
    "should i go for a checkup",
    "Is My checkup overdue",
    "IS MY CHECKUP OVERDUE",
  ])("English casing variant triggers guard: %s", async (q) => {
    const h = makeMockHarness([supportedResult(TOPIC_SLUG)], { identityPersonSlug: IDENTITY_SLUG });
    const env = parsed(await h.call({ query: q, detail: "normal" }));
    expect(env.summary.status).toBe("degraded");
    expect(h.guardDbCalls.length).toBeGreaterThan(0);
  });

  // Bare nouns do NOT trigger
  test.each([
    "我的工资发放周期是什么",
    "What is my medication called",
    "Show my appointment notes",
    "我的代码检查结果是什么",
  ])("bare noun does not trigger guard: %s", async (q) => {
    const h = makeMockHarness([supportedResult(TOPIC_SLUG)], { identityPersonSlug: IDENTITY_SLUG });
    const env = parsed(await h.call({ query: q, detail: "normal" }));
    expect(h.guardDbCalls).toEqual([]);
    expect(env.summary.status).toBe("ok");
  });

  // Non-personal: zero guard calls
  test("non-personal query → zero guard calls", async () => {
    const h = makeMockHarness([supportedResult(TOPIC_SLUG)], { identityPersonSlug: IDENTITY_SLUG });
    const env = parsed(await h.call({ query: "主题D是什么", detail: "normal" }));
    expect(h.guardDbCalls).toEqual([]);
    expect(env.summary.status).toBe("ok");
  });
});

// ── Real SQLite end-to-end ──

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

  // P1#1 r5 CORE: old reminder with "计划中" + newer "已完成" record
  // → guard still fails closed (phase-1 cannot prove current state)
  test("old reminder + newer record → guard fails closed regardless", () => {
    seedPage(db, vaultPath, IDENTITY_SLUG, "主体A", "entity/person");
    seedPage(db, vaultPath, OLD_REMINDER_SLUG, "旧提醒", "record");
    seedPage(db, vaultPath, NEIGHBOR_B, "更新记录", "entity/person");
    seedLink(db, IDENTITY_SLUG, OLD_REMINDER_SLUG, "trusted");
    seedLink(db, IDENTITY_SLUG, NEIGHBOR_B, "trusted");
    // Old reminder: 2018 "计划中"
    seedTimeline(db, OLD_REMINDER_SLUG, "计划中", "2018-01-01", "trusted");
    // Newer record: 2026 "已完成"
    seedTimeline(db, NEIGHBOR_B, "已完成相关检查", "2026-07-01", "trusted");

    const pages = { getBySlug: (slug: string) => slug === IDENTITY_SLUG ? { type: "entity/person", title: "主体A" } : null };
    const result = applyPersonalCurrentStateGuard(db, pages, "我该吃药了吗", [makeResult(OLD_REMINDER_SLUG)], IDENTITY_SLUG);
    expect(result.outcome).toBe("insufficient_current_context");
    expect(result.reason).toContain("phase-1 model cannot prove current state");
  });

  // Even a connected candidate with clear "已完成" evidence → still insufficient
  test("connected candidate with completed evidence → still insufficient", () => {
    seedPage(db, vaultPath, IDENTITY_SLUG, "主体A", "entity/person");
    seedPage(db, vaultPath, TOPIC_SLUG, "主题D", "entity/person");
    seedLink(db, IDENTITY_SLUG, TOPIC_SLUG, "trusted");
    seedTimeline(db, TOPIC_SLUG, "已完成相关检查", "2026-06-01", "trusted");

    const pages = {
      getBySlug: (slug: string) => slug === IDENTITY_SLUG
        ? { type: "entity/person", title: "主体A" }
        : slug === TOPIC_SLUG ? { type: "entity/person", title: "主题D" } : null,
    };
    const result = applyPersonalCurrentStateGuard(db, pages, "我该吃药了吗", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(result.outcome).toBe("insufficient_current_context");
  });

  // Non-personal query: guard does not activate (zero DB calls beyond search)
  test("non-personal query does not activate guard", () => {
    seedPage(db, vaultPath, IDENTITY_SLUG, "主体A", "entity/person");
    const pages = { getBySlug: (slug: string) => slug === IDENTITY_SLUG ? { type: "entity/person", title: "主体A" } : null };
    const result = applyPersonalCurrentStateGuard(db, pages, "实体A是什么", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(result.activated).toBe(false);
    expect(result.outcome).toBe("pass");
  });
});

function makeResult(slug: string): SearchResult {
  return { slug, score: 0.5, snippet: "匿名片段", source: "hybrid" };
}
