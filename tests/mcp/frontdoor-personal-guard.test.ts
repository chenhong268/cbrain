import { describe, expect, test } from "bun:test";
import {
  attachRetrievalSupport,
} from "../../src/core/retrieval/retrieval-support.js";
import type { SearchResult, SearchOptions } from "../../src/core/retrieval/search.js";
import { registerFrontdoorTools } from "../../src/mcp/tools/frontdoor.js";
import type { LinkRow } from "../../src/storage/sqlite.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

interface Harness {
  call: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
  searchCalls: Array<{ query: string; options?: SearchOptions }>;
  guardDbCalls: string[];
}

// ── Anonymized fixtures ──
const IDENTITY_SLUG = "brain/entities/subject-a";
const TOPIC_SLUG = "brain/entities/topic-d";
const OLD_REMINDER_SLUG = "records/reminder-old";

function supportedResult(slug: string, snippet = "匿名片段"): SearchResult {
  return attachRetrievalSupport(
    { slug, score: 0.5, snippet, source: "hybrid" },
    { exact: { original: { rankScore: 1 } } },
  );
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

function makeHarness(
  results: SearchResult[],
  opts: {
    identityPersonSlug?: string;
    trustedLinks?: LinkRow[];
    networkTimeline?: Array<{ slug: string; title: string; event_date: string | null; summary: string }>;
  } = {},
): Harness {
  let handler: Handler | undefined;
  const searchCalls: Array<{ query: string; options?: SearchOptions }> = [];
  const guardDbCalls: string[] = [];

  const server = {
    registerTool(name: string, _def: unknown, registered: Handler) {
      if (name === "cbrain_recall") handler = registered;
    },
  };

  const db = {
    // Guard methods (#385)
    getBoundedTrustedLinks(slug: string, _limit: number) {
      guardDbCalls.push(`trustedLinks:${slug}`);
      return opts.trustedLinks ?? [];
    },
    getRecentEventsInNetwork(slugs: string[], _days: number, _limit: number) {
      guardDbCalls.push(`networkTimeline:${slugs.length}`);
      return opts.networkTimeline ?? [];
    },
    // Evidence completion methods
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
  return {
    call: (args) => handler!(args),
    searchCalls,
    guardDbCalls,
  };
}

interface Envelope {
  summary: { status: string; degraded_reason?: string };
  raw: { entities: unknown[] };
  display: string;
}

function parsed(output: { content: Array<{ type: string; text: string }> }): Envelope {
  return JSON.parse(output.content[0]!.text) as Envelope;
}

describe("frontdoor personal current-state guard integration (#385)", () => {
  // #3: Missing first-person identity mapping → insufficient, no guessed subject.
  test("personal query without identity → degraded, entities empty", async () => {
    const harness = makeHarness([supportedResult(OLD_REMINDER_SLUG)]);
    const env = parsed(await harness.call({ query: "我最近该去复查了吗", detail: "normal" }));

    expect(env.summary.status).toBe("degraded");
    expect(env.raw.entities).toEqual([]);
    expect(env.summary.degraded_reason).toContain("个人当前状态上下文不足");
  });

  // #1: Old adjacent reminder + missing subject-to-topic chain → insufficient.
  test("personal query + old reminder + no trusted chain → degraded", async () => {
    const harness = makeHarness([supportedResult(OLD_REMINDER_SLUG)], {
      identityPersonSlug: IDENTITY_SLUG,
    });
    const env = parsed(await harness.call({ query: "我最近该去复查了吗", detail: "normal" }));

    expect(env.summary.status).toBe("degraded");
    expect(env.raw.entities).toEqual([]);
    expect(JSON.stringify(env)).not.toContain(OLD_REMINDER_SLUG);
  });

  // #2: Only candidate links → insufficient.
  test("personal query + only candidate links → degraded", async () => {
    const harness = makeHarness([supportedResult(TOPIC_SLUG)], {
      identityPersonSlug: IDENTITY_SLUG,
      // getBoundedTrustedLinks returns empty (candidate links filtered by SQL)
      trustedLinks: [],
    });
    const env = parsed(await harness.call({ query: "我最近该去复查了吗", detail: "normal" }));

    expect(env.summary.status).toBe("degraded");
    expect(env.raw.entities).toEqual([]);
  });

  // #4: Trusted subject-to-topic chain → evidence included.
  test("personal query + trusted chain → ok, entities returned", async () => {
    const harness = makeHarness([supportedResult(TOPIC_SLUG)], {
      identityPersonSlug: IDENTITY_SLUG,
      trustedLinks: [trustedLink(IDENTITY_SLUG, TOPIC_SLUG)],
    });
    const env = parsed(await harness.call({ query: "我最近该去复查了吗", detail: "normal" }));

    expect(env.summary.status).toBe("ok");
    expect(env.raw.entities.length).toBeGreaterThan(0);
  });

  // P1#1: Per-candidate filtering — stale reminder filtered from output.
  test("trusted chain + stale reminder → only connected result returned", async () => {
    const harness = makeHarness(
      [supportedResult(OLD_REMINDER_SLUG), supportedResult(TOPIC_SLUG)],
      {
        identityPersonSlug: IDENTITY_SLUG,
        trustedLinks: [trustedLink(IDENTITY_SLUG, TOPIC_SLUG)],
      },
    );
    const env = parsed(await harness.call({ query: "我最近该去复查了吗", detail: "normal" }));

    expect(env.summary.status).toBe("ok");
    expect(env.raw.entities.length).toBe(1);
    // Old reminder slug must not appear
    expect(JSON.stringify(env)).not.toContain(OLD_REMINDER_SLUG);
  });

  // #7: Plain non-temporal lookup → zero guard DB calls.
  test("non-personal query → no guard DB calls, entities returned", async () => {
    const harness = makeHarness([supportedResult(TOPIC_SLUG)], {
      identityPersonSlug: IDENTITY_SLUG,
    });
    const env = parsed(await harness.call({ query: "主题D是什么", detail: "normal" }));

    expect(env.summary.status).toBe("ok");
    expect(harness.guardDbCalls).toEqual([]);
  });

  // #6: Non-personal temporal query → existing behavior, no guard DB calls.
  test("non-personal temporal query → no guard activation", async () => {
    const harness = makeHarness([supportedResult(TOPIC_SLUG)], {
      identityPersonSlug: IDENTITY_SLUG,
    });
    await harness.call({ query: "主题D上次的变化", detail: "normal" });

    expect(harness.guardDbCalls).toEqual([]);
    expect(harness.searchCalls).toHaveLength(1);
    expect(harness.searchCalls[0]!.options).toMatchObject({ limit: 5, _captureSupport: true });
  });

  // P1#3: Pure personal recall without domain context does not trigger guard.
  test("personal recall without health/action domain → no guard activation", async () => {
    const harness = makeHarness([supportedResult(TOPIC_SLUG)], {
      identityPersonSlug: IDENTITY_SLUG,
    });
    const env = parsed(await harness.call({ query: "我最近看了什么书", detail: "normal" }));

    expect(harness.guardDbCalls).toEqual([]);
    expect(env.summary.status).toBe("ok");
  });

  // #5: Conflicting dated evidence → degraded, never confident.
  test("conflicting timeline evidence → degraded", async () => {
    const harness = makeHarness([supportedResult(TOPIC_SLUG)], {
      identityPersonSlug: IDENTITY_SLUG,
      trustedLinks: [trustedLink(IDENTITY_SLUG, TOPIC_SLUG)],
      networkTimeline: [
        { slug: TOPIC_SLUG, title: "主题D", event_date: "2026-06-01", summary: "已完成相关检查" },
        { slug: TOPIC_SLUG, title: "主题D", event_date: "2026-07-01", summary: "待复查" },
      ],
    });
    const env = parsed(await harness.call({ query: "我最近该去复查了吗", detail: "normal" }));

    expect(env.summary.status).toBe("degraded");
    expect(env.raw.entities).toEqual([]);
  });

  // Search call count unchanged for non-personal queries.
  test("non-personal query searches exactly once", async () => {
    const harness = makeHarness([supportedResult(TOPIC_SLUG)], {
      identityPersonSlug: IDENTITY_SLUG,
    });
    await harness.call({ query: "主题D是什么", detail: "normal" });
    expect(harness.searchCalls).toHaveLength(1);
  });
});
