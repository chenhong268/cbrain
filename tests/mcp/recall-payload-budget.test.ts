import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import {
  buildCompactRecallResponse,
  MAX_DEFAULT_RECALL_RESPONSE_CHARS,
  COMPACT_SNIPPET_CAP,
} from "../../src/mcp/tools/recall-compact.js";

// ─── Integration harness (mirrors recall-quality.test.ts) ────────────────────

function createMockEmbedding(): EmbeddingProvider {
  return {
    dimensions: 128,
    embed: async (text: string) => ({
      embedding: new Array(128).fill(0).map((_, i) => (text.charCodeAt(i % text.length) ?? 0) / 65536),
      tokenCount: text.length,
    }),
    embedBatch: async (texts: string[]) =>
      texts.map((t) => ({
        embedding: new Array(128).fill(0).map((_, i) => (t.charCodeAt(i % t.length) ?? 0) / 65536),
        tokenCount: t.length,
      })),
  };
}

function createMockLanceDB() {
  return {
    connect: async () => {},
    addChunks: async () => {},
    search: async () => [],
    fullTextSearch: async () => [],
    deleteByPageSlug: async () => {},
    deleteRawChunksByPageSlug: async () => {},
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

function getTools(server: unknown) {
  return (server as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<unknown> }> })._registeredTools;
}

// ─── Unit: buildCompactRecallResponse helper ────────────────────

const BASE_SUMMARY = { status: "ok" as const, count: 1, truncated: false, message: "有 1 条相关记忆" };

function fullEntity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: "entity/a",
    title: "实体A",
    type: "entity/person",
    relevance: 0.9,
    quality: "high",
    tier: 1,
    snippet: "实体A的简短摘要。",
    body: "实体A的完整正文，很长很长很长。".repeat(50),
    frontmatter: { tier: 1, type: "entity/person" },
    links: { outgoing: [{ to_slug: "entity/b", relation: "认识" }], incoming: [] },
    timeline: [{ summary: "事件一", event_date: "2026-01-01" }],
    dossier: "档案内容",
    memory_skeleton: { key_points: ["要点一"] },
    related: [{ slug: "entity/b", title: "实体B", type: "entity/person" }],
    subordinates: [],
    peers: [],
    tags: ["标签甲"],
    expiry_warning: undefined,
    birthday: undefined,
    ...overrides,
  };
}

describe("buildCompactRecallResponse (unit)", () => {
  test("projects entities to first-turn field subset — drops heavy fields", () => {
    const res = buildCompactRecallResponse({
      display: "CBrain 里有 1 条相关记忆，最接近的是实体A。",
      summary: BASE_SUMMARY,
      resultSummary: "有 1 条相关记忆",
      query: "实体A",
      entities: [fullEntity()],
      searchMeta: { strategy: "smart-hybrid", latency_ms: 12, candidate_count: 1, reason_codes: ["x"], quality_gate: { filtered: 1 } },
    });

    const e = res.entities[0];
    // Kept
    expect(e.slug).toBe("entity/a");
    expect(e.title).toBe("实体A");
    expect(e.type).toBe("entity/person");
    expect(e.relevance).toBe(0.9);
    expect(e.quality).toBe("high");
    expect(e.tier).toBe(1);
    expect(e.snippet).toBe("实体A的简短摘要。");
    expect(e.tags).toEqual(["标签甲"]);
    // Dropped
    for (const key of ["body", "frontmatter", "links", "timeline", "dossier", "memory_skeleton", "related", "subordinates", "peers"]) {
      expect(e[key], `${key} should be dropped`).toBeUndefined();
    }
  });

  test("drops raw entirely — response has no `raw` key", () => {
    const res = buildCompactRecallResponse({
      display: "d",
      summary: BASE_SUMMARY,
      resultSummary: "s",
      query: "q",
      entities: [fullEntity()],
      searchMeta: { latency_ms: 5, candidate_count: 1 },
    });
    expect((res as unknown as Record<string, unknown>).raw).toBeUndefined();
  });

  test("search_meta keeps only safe keys — strips strategy/reason_codes/quality_gate", () => {
    const res = buildCompactRecallResponse({
      display: "d",
      summary: BASE_SUMMARY,
      resultSummary: "s",
      query: "q",
      entities: [fullEntity()],
      searchMeta: { strategy: "smart-hybrid", latency_ms: 12, candidate_count: 7, reason_codes: ["x"], quality_gate: { filtered: 1 }, truncated: true, has_more: true },
    });
    expect(res.search_meta.latency_ms).toBe(12);
    expect(res.search_meta.candidate_count).toBe(7);
    expect(res.search_meta.has_more).toBe(true);
    expect((res.search_meta as Record<string, unknown>).strategy).toBeUndefined();
    expect((res.search_meta as Record<string, unknown>).reason_codes).toBeUndefined();
    expect((res.search_meta as Record<string, unknown>).quality_gate).toBeUndefined();
    expect((res.search_meta as Record<string, unknown>).truncated).toBeUndefined();
  });

  test(`caps snippet at ${COMPACT_SNIPPET_CAP} chars`, () => {
    const longSnippet = "字".repeat(COMPACT_SNIPPET_CAP + 200);
    const res = buildCompactRecallResponse({
      display: "d",
      summary: BASE_SUMMARY,
      resultSummary: "s",
      query: "q",
      entities: [fullEntity({ snippet: longSnippet })],
      searchMeta: { latency_ms: 1, candidate_count: 1 },
    });
    expect((res.entities[0].snippet as string).length).toBeLessThanOrEqual(COMPACT_SNIPPET_CAP);
  });

  test("moderate budget drops tail entities and sets has_more, keeps at least one", () => {
    const entities = Array.from({ length: 6 }, (_, i) => fullEntity({ slug: `entity/${i}`, title: `实体${i}`, snippet: "片段".repeat(10) }));
    // Budget fits several but not all → tail dropped, has_more set, ≥1 kept.
    const res = buildCompactRecallResponse({
      display: "d",
      summary: BASE_SUMMARY,
      resultSummary: "s",
      query: "q",
      entities,
      searchMeta: { latency_ms: 1, candidate_count: 6 },
    }, 600);

    expect(res.entities.length).toBeLessThan(6);
    expect(res.entities.length).toBeGreaterThanOrEqual(1);
    expect(res.search_meta.has_more).toBe(true);
  });

  test(`stays under default budget of ${MAX_DEFAULT_RECALL_RESPONSE_CHARS}`, () => {
    const entities = Array.from({ length: 5 }, (_, i) => fullEntity({ slug: `entity/${i}`, snippet: "字".repeat(COMPACT_SNIPPET_CAP) }));
    const res = buildCompactRecallResponse({
      display: "d".repeat(500),
      summary: BASE_SUMMARY,
      resultSummary: "s".repeat(200),
      query: "q",
      entities,
      searchMeta: { latency_ms: 1, candidate_count: 5 },
    });
    expect(JSON.stringify(res).length).toBeLessThanOrEqual(MAX_DEFAULT_RECALL_RESPONSE_CHARS);
  });

  test("hard ceiling: final length ≤ maxChars even when has_more adds chars (#231 amend)", () => {
    // Baseline length with candidateHasMore=false; then request the SAME budget
    // with has_more=true. The flag adds chars, so the helper must still keep the
    // final response ≤ maxChars by trimming snippets / dropping tail entities.
    const base = {
      display: "d",
      summary: BASE_SUMMARY,
      resultSummary: "s",
      query: "q",
      entities: [fullEntity({ slug: "entity/only", snippet: "x" })],
    };
    const no = buildCompactRecallResponse(
      { ...base, searchMeta: { latency_ms: 1, candidate_count: 2 } },
      10000,
    );
    const noLen = JSON.stringify(no).length;
    const yes = buildCompactRecallResponse(
      { ...base, searchMeta: { latency_ms: 1, candidate_count: 2, has_more: true } },
      noLen,
    );
    expect(JSON.stringify(yes).length).toBeLessThanOrEqual(noLen);
    expect(yes.search_meta.has_more).toBe(true);
  });

  test("has_more false when pool fits and no budget cut", () => {
    const res = buildCompactRecallResponse({
      display: "d",
      summary: BASE_SUMMARY,
      resultSummary: "s",
      query: "q",
      entities: [fullEntity()],
      searchMeta: { latency_ms: 1, candidate_count: 1 },
    });
    expect(res.search_meta.has_more).toBeUndefined();
  });
});

// ─── Integration: deep_recall handler payload budget (#231) ──────────────────

describe("deep_recall payload budget (#231)", () => {
  const testDir = "/tmp/cbrain-test-recall-payload-budget";
  const dbPath = join(testDir, "t.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let deps: CBrainDeps;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    deps = {
      db,
      embedding: createMockEmbedding(),
      lance: createMockLanceDB() as never,
      vaultPath,
      runtimePath: join(dirname(dbPath), "runtime"),
    };
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  /** Seed a rich entity (big body, dossier, links, timeline) found via FTS. */
  function seedRichEntity(): void {
    const slug = "entity/rich-a";
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(slug, "entity/person", "实体A", "rich-a.md", "h1", 1, 5);
    const body = "实体A的详细正文。" + "具体设计与职责内容片段。".repeat(60) +
      "\n\n## 核心设计\n- 角色分工：六个虚拟经理各司其职\n- 决策机制：确定性优先于概率性\n- 阶段标记：当前处于试点阶段" +
      "\n\n<!-- cbrain-dossier -->\n这是档案内容，记录角色、职责与关键决策。\n<!-- /cbrain-dossier -->";
    writeFileSync(
      join(vaultPath, "rich-a.md"),
      `---\ntitle: 实体A\ntype: entity/person\ntier: 1\ntags: [主题甲, 领域乙]\n---\n${body}`,
    );
    db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, ?, ?)")
      .run(slug, 0, "实体A的独特fts关键词详细内容");
    db.rawDb.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)")
      .run(slug, "实体A的独特fts关键词详细内容");
    // partner + trusted link
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)",
    ).run("entity/partner-b", "entity/person", "伙伴B", "partner-b.md", "h2");
    db.rawDb.prepare(
      "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence, context) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(slug, "entity/partner-b", "合作", "wikilink", "trusted", 0.9, "实体A与伙伴B长期合作");
    db.rawDb.prepare(
      "INSERT INTO timeline (page_slug, summary, event_date, source, trust_state) VALUES (?, ?, ?, ?, ?)",
    ).run(slug, "实体A的重要里程碑事件", "2026-01-01", "dialogue", "trusted");
  }

  const QUERY = "独特fts关键词";

  test("1. default omits raw and heavy entity fields even with detail=normal", async () => {
    seedRichEntity();
    const server = createServer(deps);
    const result = await getTools(server).deep_recall.handler({ query: QUERY, detail: "normal" }) as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);

    // No raw envelope at all.
    expect(data.raw).toBeUndefined();
    // entities[0] has no heavy fields.
    const e = data.entities[0];
    expect(e).toBeDefined();
    for (const key of ["body", "frontmatter", "links", "timeline", "dossier", "memory_skeleton", "related", "subordinates", "peers"]) {
      expect(e[key], `${key} must be absent in compact`).toBeUndefined();
    }
    // No audit blobs at top level.
    for (const key of ["evidence_summary", "insights", "cross_refs", "proactive_hints"]) {
      expect(data[key], `${key} must be absent in compact`).toBeUndefined();
    }
  });

  test("2. default response JSON stays under the 12000 char budget", async () => {
    seedRichEntity();
    const server = createServer(deps);
    const result = await getTools(server).deep_recall.handler({ query: QUERY, detail: "normal" }) as { content: Array<{ text: string }> };
    expect(result.content[0].text.length).toBeLessThanOrEqual(MAX_DEFAULT_RECALL_RESPONSE_CHARS);
  });

  test("3. default entity keeps the first-turn field subset", async () => {
    seedRichEntity();
    const server = createServer(deps);
    const result = await getTools(server).deep_recall.handler({ query: QUERY, detail: "normal" }) as { content: Array<{ text: string }> };
    const e = JSON.parse(result.content[0].text).entities[0];
    expect(e.slug).toBe("entity/rich-a");
    expect(e.title).toBe("实体A");
    expect(e.type).toBe("entity/person");
    expect(typeof e.relevance).toBe("number");
    expect(e.quality).toBe("high");
    expect(e.tier).toBe(1);
    expect(typeof e.snippet).toBe("string");
    expect(e.tags).toEqual(expect.arrayContaining(["主题甲", "领域乙"]));
  });

  test("4. include_raw=true returns raw with audit fields and full entity body", async () => {
    seedRichEntity();
    const server = createServer(deps);
    const result = await getTools(server).deep_recall.handler({ query: QUERY, detail: "normal", include_raw: true }) as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);

    expect(data.raw).toBeDefined();
    expect(data.raw.search_meta).toBeDefined();
    // Full entity keeps heavy fields.
    const e = data.entities[0];
    expect(e.body).toBeDefined();
    expect(e.dossier).toBeDefined();
    expect(e.memory_skeleton).toBeDefined();
    expect(e.links).toBeDefined();
    expect(e.timeline).toBeDefined();
  });

  test("5. grounded=true default: no raw, grounded_answer present", async () => {
    seedRichEntity();
    const server = createServer(deps);
    const result = await getTools(server).deep_recall.handler({ query: QUERY, grounded: true }) as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);

    expect(data.raw).toBeUndefined();
    expect(data.grounded_answer).toBeDefined();
  });

  test("6. grounded=true + include_raw=true returns raw", async () => {
    seedRichEntity();
    const server = createServer(deps);
    const result = await getTools(server).deep_recall.handler({ query: QUERY, grounded: true, include_raw: true }) as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);

    expect(data.raw).toBeDefined();
    expect(data.raw.search_meta).toBeDefined();
    expect(data.grounded_answer).toBeDefined();
  });

  test("7. display/summary do not leak internal terms", async () => {
    seedRichEntity();
    const server = createServer(deps);
    const result = await getTools(server).deep_recall.handler({ query: QUERY }) as { content: Array<{ text: string }> };
    const data = JSON.parse(result.content[0].text);

    const displayText = String(data.display ?? "");
    const summaryJson = JSON.stringify(data.summary ?? {});
    for (const term of ["score", "reason_codes", "debug", "latency_ms", "quality_gate", "candidate_count"]) {
      expect(displayText, `display leaked ${term}`).not.toContain(term);
      expect(summaryJson, `summary leaked ${term}`).not.toContain(term);
    }
    expect(displayText).not.toContain("entity/");
  });
});
