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
    getBoundedTrustedLinks(slug: string, _l: number) { guardDbCalls.push(`tl:${slug}`); return opts.trustedLinks ?? []; },
    getBoundedTrustedTimelineForSlugs(slugs: string[], _l: number) {
      guardDbCalls.push(`t:${slugs.join(",")}`);
      const out: Array<{ page_slug: string; event_date: string; summary: string; trust_state?: string }> = [];
      for (const s of slugs) out.push(...(opts.timelineBySlug?.[s] ?? []));
      return out;
    },
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

interface Envelope { summary: { status: string }; raw: { entities: unknown[]; historical_evidence?: unknown[] }; }

function parsed(output: { content: Array<{ type: string; text: string }> }): Envelope {
  return JSON.parse(output.content[0]!.text) as Envelope;
}

describe("frontdoor personal current-state guard (#385) — mock", () => {
  test("personal query without identity → degraded", async () => {
    const h = makeMockHarness([supportedResult(OLD_REMINDER_SLUG)]);
    const env = parsed(await h.call({ query: "我该吃药了吗", detail: "normal" }));
    expect(env.summary.status).toBe("degraded");
    expect(env.raw.entities).toEqual([]);
  });

  // P1#1 r6: trusted chain → degraded but WITH historical evidence
  test("trusted chain → degraded + historical_evidence in response", async () => {
    const h = makeMockHarness([supportedResult(TOPIC_SLUG)], {
      identityPersonSlug: IDENTITY_SLUG,
      trustedLinks: [trustedLink(IDENTITY_SLUG, TOPIC_SLUG)],
      timelineBySlug: { [TOPIC_SLUG]: [{ page_slug: TOPIC_SLUG, event_date: "2026-06-01", summary: "已完成相关检查", trust_state: "trusted" }] },
    });
    const env = parsed(await h.call({ query: "我该吃药了吗", detail: "normal" }));
    expect(env.summary.status).toBe("degraded");
    expect(env.raw.historical_evidence).toBeDefined();
    expect((env.raw.historical_evidence as unknown[]).length).toBe(1);
  });

  // P1#3 r6: English current-state phrases trigger guard
  test.each([
    "What am I currently taking",
    "What medication am I currently on",
  ])("English current-state triggers guard: %s", async (q) => {
    const h = makeMockHarness([supportedResult(TOPIC_SLUG)], { identityPersonSlug: IDENTITY_SLUG });
    const env = parsed(await h.call({ query: q, detail: "normal" }));
    expect(env.summary.status).toBe("degraded");
    expect(h.guardDbCalls.length).toBeGreaterThan(0);
  });

  // P1#2 r6: fact recall with domain nouns does NOT trigger
  test.each([
    "我上次血压是多少",
    "我最近的体检结果怎么样",
    "我最近的睡眠记录是什么",
  ])("fact recall does NOT trigger guard: %s", async (q) => {
    const h = makeMockHarness([supportedResult(TOPIC_SLUG)], { identityPersonSlug: IDENTITY_SLUG });
    await h.call({ query: q, detail: "normal" });
    // Guard must not activate — no guard DB calls (getBoundedTrustedLinks etc.)
    expect(h.guardDbCalls).toEqual([]);
  });

  test("non-personal query → zero guard calls", async () => {
    const h = makeMockHarness([supportedResult(TOPIC_SLUG)], { identityPersonSlug: IDENTITY_SLUG });
    const env = parsed(await h.call({ query: "主题D是什么", detail: "normal" }));
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

  test("trusted chain → guard returns insufficient + historical evidence", () => {
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
    expect(result.reason).toContain("phase-1 model cannot prove current state");
    expect(result.historicalEvidence).toBeDefined();
    expect(result.historicalEvidence!.length).toBe(1);
    expect(result.historicalEvidence![0]!.summary).toBe("已完成相关检查");
    expect(result.historicalEvidence![0]!.trust_state).toBe("trusted");
  });

  test("no trusted chain → insufficient with bounded disclaimer", () => {
    seedPage(db, vaultPath, IDENTITY_SLUG, "主体A", "entity/person");
    const pages = { getBySlug: (slug: string) => slug === IDENTITY_SLUG ? { type: "entity/person", title: "主体A" } : null };
    const result = applyPersonalCurrentStateGuard(db, pages, "我该吃药了吗", [makeResult(TOPIC_SLUG)], IDENTITY_SLUG);
    expect(result.outcome).toBe("insufficient_current_context");
    expect(result.reason).toContain("bounded inspection");
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
