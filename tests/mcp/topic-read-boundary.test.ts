import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import { DeterministicEmbeddingProvider } from "../../src/embedding/deterministic.js";
import { buildContext, type ToolContext } from "../../src/mcp/context.js";
import { registerPageTools } from "../../src/mcp/tools/pages.js";
import { registerSearchTools } from "../../src/mcp/tools/search.js";
import { registerRecallTools } from "../../src/mcp/tools/recall.js";
import { registerFrontdoorTools } from "../../src/mcp/tools/frontdoor.js";
import { TopicManager } from "../../src/core/topics/manager.js";
import { HybridSearch } from "../../src/core/retrieval/search.js";
import { collectEvidenceForSlugs, buildEvidenceFromBatched } from "../../src/core/retrieval/evidence.js";
import { assembleEvidencePack } from "../../src/core/retrieval/evidence-completion.js";
import { AgenticResearchExecutor } from "../../src/core/agentic/executor.js";
import { createTopicReadAdmission } from "../../src/core/topics/read.js";
import { isTopicRow } from "../../src/core/shared.js";

/**
 * #511 Task 3 — read boundaries for generated topic pages through the real
 * MCP handler surfaces. Ordinary overview/content recall may present a
 * validated CURRENT topic as a derived reading page; raw-detail, temporal,
 * grounded evidence and direct reads never leak a stale topic's body,
 * snippet, L1 or chunks. Original records always survive.
 */
describe("topic read boundaries (#511 Task 3)", () => {
  let root: string;
  let db: CBrainDB;
  let lance: LanceDBManager;
  let ctx: ToolContext;
  let manager: TopicManager;
  let topic: string;
  let sources: string[];
  let sourcePaths: string[];
  let handlers: Record<string, (args: unknown) => Promise<unknown>>;
  const marker = "DERIVED_STALE_SENTINEL";
  const markerB = "DERIVED_REFRESHED_SENTINEL";
  let topicText = marker;
  const correction = "用户更正：上述安排已经取消。";
  const lateDetail = "补充事项：深水航行需要双岗值守。";

  const json = async (tool: string, args: unknown): Promise<Record<string, unknown>> => {
    const result = (await handlers[tool](args)) as { content: Array<{ text: string }> };
    return JSON.parse(result.content[0].text);
  };

  beforeEach(async () => {
    root = mkdtempSync("/tmp/cbrain-test-topic-read-mcp-");
    const vaultPath = join(root, "vault");
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(join(root, "brain.sqlite"));
    lance = new LanceDBManager();
    await lance.connect(join(root, "lance"));
    topicText = marker;
    const bodies = [
      `原始材料0：主题D需要定期回顾行动进度。\n${lateDetail}`,
      "原始材料1：主题D需要定期回顾行动进度。",
      "原始材料2：主题D需要定期回顾行动进度。",
    ];
    const llm = {
      name: "anonymous-topic-fixture",
      chat: async () =>
        JSON.stringify({
          overview: [{ text: topicText, kind: "observation", sourceSlug: sources[0], quote: "主题D需要定期回顾行动进度。" }],
          observations: [{ text: topicText, kind: "observation", sourceSlug: sources[1], quote: "主题D需要定期回顾行动进度。" }],
          details: [],
          open_questions: [],
        }),
    };
    ctx = buildContext({
      db,
      lance,
      embedding: new DeterministicEmbeddingProvider(),
      vaultPath,
      runtimePath: join(root, "runtime"),
      llm,
    });
    sources = [];
    for (let i = 0; i < 3; i++) {
      const page = ctx.pages.create({ title: `材料${i}`, type: "record", body: bodies[i] });
      sources.push(page.slug);
      const prepared = await ctx.pipeline.embed(bodies[i]);
      await ctx.pipeline.writeIndexes(page.slug, prepared.chunks, prepared.embedResults);
    }
    sourcePaths = sources.map((s) => join(vaultPath, db.getPageFilePath(s)!));
    manager = new TopicManager({ db, lance, pages: ctx.pages, pipeline: ctx.pipeline, versions: ctx.versions, llm });
    const result = await manager.compile({ title: "主题D", sourceSlugs: sources });
    expect(result.status).toBe("created");
    topic = manager.resolveTopicSlug("主题D");
    handlers = {};
    const server = { registerTool: (name: string, _schema: unknown, handler: (args: unknown) => Promise<unknown>) => { handlers[name] = handler; } } as never;
    registerPageTools(server, ctx);
    registerSearchTools(server, ctx);
    registerRecallTools(server, ctx);
    registerFrontdoorTools(server, ctx);
  });

  afterEach(async () => {
    ctx.jobs.stop();
    await lance.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** Prime the ordinary page cache, then correct one source on disk only. */
  const invalidateViaDiskEdit = () => {
    ctx.pages.getBySlug(topic); // deliberately prime the cache first
    writeFileSync(sourcePaths[0], readFileSync(sourcePaths[0], "utf-8") + `\n${correction}`);
    expect(manager.inspectFreshness(topic)?.state).toBe("stale");
  };

  // ── Current topic is a visible, clearly-derived reading page ──────────

  test("daily overview presents the current topic as derived material with source refs", async () => {
    const data = await json("cbrain_recall", { query: "主题D 全面了解", detail: "normal" });
    const entities = (data.raw as { entities?: Array<Record<string, unknown>> }).entities ?? [];
    const topicEntity = entities.find((e) => e.slug === topic || e.type === "topic");
    expect(topicEntity).toBeDefined();
    expect(JSON.stringify(topicEntity)).toContain(marker);
    expect(topicEntity!.derived).toBe(true);
    expect(topicEntity!.sources).toEqual(sources);
    // The originals are still part of the overview, and the summary states
    // the derived page instead of counting it as an ordinary memory.
    expect(entities.length).toBeGreaterThan(1);
    expect(JSON.stringify(data)).toContain("派生");
  });

  test("content recall body for a current topic comes from the verified snapshot, not the cache", async () => {
    // Prime the cache with generation A, then force a real refresh (unchanged
    // no-op would skip the model) to generation B.
    ctx.pages.getBySlug(topic);
    writeFileSync(sourcePaths[1], readFileSync(sourcePaths[1], "utf-8") + "\n补充：材料一更新备注。");
    topicText = markerB;
    const refreshed = await manager.compile({ title: "主题D", sourceSlugs: sources });
    expect(refreshed.status).toBe("refreshed");
    const data = await json("cbrain_recall", { query: "主题D", detail: "normal", include_raw: true });
    const text = JSON.stringify(data);
    expect(text).toContain(markerB);
    expect(text).not.toContain(marker);
    const topicEntity = ((data.raw as { entities?: Array<Record<string, unknown>> }).entities ?? [])
      .find((e) => e.derived === true);
    expect(topicEntity).toBeDefined();
    expect(topicEntity!.sources).toEqual(sources);
  });

  // ── Stale topic never leaks through any actual read surface ───────────

  test("get_page full body hides a stale topic and reports why, same batch record still readable", async () => {
    invalidateViaDiskEdit();
    const page = await json("get_page", { slug: topic, include_full_body: true });
    const text = JSON.stringify(page);
    expect(text).not.toContain(marker);
    expect((page.raw as { body: string | null }).body ?? page.body).toBeNull();
    expect(text).toContain("主题页");
    const batch = await json("get_pages", { slugs: [topic, sources[1]], detail: "normal" });
    const batchText = JSON.stringify(batch);
    expect(batchText).not.toContain(marker);
    const items = (batch.raw as { items?: Array<{ slug: string; excerpt: string }> }).items ?? (batch.items as Array<{ slug: string; excerpt: string }>);
    const topicItem = items.find((i) => i.slug === topic);
    const recordItem = items.find((i) => i.slug === sources[1]);
    expect(topicItem?.excerpt).toBe("");
    expect(recordItem?.excerpt).toContain("原始材料1");
  });

  test("query smart FTS and exact injection exclude the stale topic; correction still findable", async () => {
    invalidateViaDiskEdit();
    const data = await json("query", { query: "主题D", strategy: "smart", include_raw: true });
    const text = JSON.stringify(data);
    expect(text).not.toContain(marker);
    expect(text).not.toContain(topic);
    const corrected = await json("query", { query: "用户更正", strategy: "smart" });
    expect(JSON.stringify(corrected)).toContain(sources[0]);
  });

  test("deep_recall keeps original records only, even for a current topic", async () => {
    const data = await json("deep_recall", { query: "主题D", detail: "normal", include_raw: true });
    const text = JSON.stringify(data);
    expect(text).not.toContain(marker);
    expect(text).not.toContain(topic);
    expect(text).toContain(sources[0]);
    // Same for the FTS-only strategy with a stale topic.
    invalidateViaDiskEdit();
    const fts = await json("deep_recall", { query: "主题D", strategy: "fts", detail: "normal", include_raw: true });
    expect(JSON.stringify(fts)).not.toContain(marker);
  });

  test("daily content recall hides the stale topic and surfaces the corrected original", async () => {
    invalidateViaDiskEdit();
    const data = await json("cbrain_recall", { query: "主题D", detail: "normal", include_raw: true });
    const text = JSON.stringify(data);
    expect(text).not.toContain(marker);
    // Content entities carry titles/snippets: the corrected original record is
    // still surfaced as ordinary memory (the disk correction itself waits for
    // the existing watcher/sync — no read path re-indexes behind its back).
    expect(text).toContain("材料0");
    expect(text).toContain("原始材料0");
  });

  // ── Search internals: exact fast path, squeeze refill, vector ─────────

  test("HybridSearch exact-title fast path skips a stale topic so originals survive", async () => {
    invalidateViaDiskEdit();
    const results = await ctx.search.search("主题D", { strategy: "all", limit: 10 });
    expect(results.map((r) => r.slug)).not.toContain(topic);
    expect(results.length).toBeGreaterThanOrEqual(3);
    expect(results.map((r) => r.slug)).toContain(sources[0]);
  });

  test("FTS candidate squeeze refills beyond excluded topic rows (bounded)", async () => {
    invalidateViaDiskEdit();
    const results = await ctx.search.search("主题D", { strategy: "fts", limit: 2 });
    const slugs = results.map((r) => r.slug);
    expect(slugs).not.toContain(topic);
    // Two ORIGINAL records survive the limit=2 window the stale topic occupied.
    const originalCount = slugs.filter((s) => sources.includes(s)).length;
    expect(originalCount).toBe(2);
  });

  test("vector channel excludes the stale topic and keeps originals", async () => {
    invalidateViaDiskEdit();
    const results = await ctx.search.search("主题D", { strategy: "vector", limit: 10 });
    expect(results.map((r) => r.slug)).not.toContain(topic);
    expect(results.map((r) => r.slug)).toContain(sources[0]);
  });

  // ── Grounded / temporal evidence stays original-only ──────────────────

  test("collectEvidenceForSlugs never promotes topic L1/chunks/provenance as trusted facts", () => {
    // Legacy/attacker-shaped topic-derived material in the DB.
    db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, -1, ?, 1)").run(topic, `主题页L1摘要${marker}`);
    db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 5, ?, 0)").run(topic, `主题页原始片段${marker}`);
    db.rawDb.prepare(
      "INSERT INTO links (from_slug, to_slug, relation, source_type, source_page_slug, trust_state, confidence) VALUES (?, ?, '提及', 'agent', ?, 'trusted', 0.9)",
    ).run(sources[0], sources[1], topic);
    db.rawDb.prepare(
      "INSERT INTO timeline (page_slug, summary, event_date, source, source_page_slug, trust_state) VALUES (?, ?, '2026-01-02', 'agent', ?, 'trusted')",
    ).run(sources[1], `主题页时间线${marker}`, topic);

    const board = collectEvidenceForSlugs(db, [topic, ...sources]);
    const text = JSON.stringify(board);
    expect(text).not.toContain(marker);
    expect(text).not.toContain(`"${topic}"`);
    // The original records' own chunks remain usable facts.
    expect(board.facts.some((f) => f.source_slug === sources[0])).toBe(true);

    // Normal-recall batched evidence board: same exclusion via the predicate.
    const linksMap = db.batchGetLinksForSlugs(sources, true);
    const timelineMap = db.batchGetTimelineForSlugs(sources, true);
    const batched = buildEvidenceFromBatched(linksMap, timelineMap, [topic, ...sources], (slug) => isTopicRow(db.getPage(slug)));
    expect(JSON.stringify(batched)).not.toContain(marker);
  });

  test("temporal evidence pack excludes the topic even when handed its slug directly", () => {
    db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 7, ?, 0)").run(topic, `主题页历史片段${marker}`);
    const pack = assembleEvidencePack(db, [topic, sources[0]], "主题D 之前有什么变化");
    const text = JSON.stringify(pack);
    expect(text).not.toContain(marker);
    expect(pack.chunks.every((c) => c.slug !== topic)).toBe(true);
    expect(pack.chunks.some((c) => c.slug === sources[0])).toBe(true);
  });

  test("grounded recall answers from originals only", async () => {
    const data = await json("cbrain_recall", { query: "主题D 讨论过吗", detail: "normal", include_raw: true });
    const text = JSON.stringify(data);
    expect(text).not.toContain(marker);
    expect(text).toContain("原始材料");
  });

  test("late-body original detail survives an exact topic-title match", async () => {
    invalidateViaDiskEdit();
    const data = await json("deep_recall", { query: "主题D 双岗值守", detail: "normal", include_raw: true });
    const text = JSON.stringify(data);
    expect(text).not.toContain(marker);
    expect(text).toContain("双岗值守");
  });

  // ── Direct page read guards on other invalidation shapes ─────────────

  test("malformed manifest and deleted topic file do not leak old bodies", async () => {
    // Malformed selection (duplicate source) with a consistent content hash.
    const filePath = join(ctx.vaultPath, db.getPageFilePath(topic)!);
    const raw = readFileSync(filePath, "utf-8");
    const dup = raw.replace(`slug: ${sources[2]}`, `slug: ${sources[0]}`);
    expect(dup).not.toBe(raw);
    writeFileSync(filePath, dup);
    const page = await json("get_page", { slug: topic, include_full_body: true });
    expect(JSON.stringify(page)).not.toContain(marker);

    // Deleted file: row + indexes still present, read fails closed.
    writeFileSync(filePath, raw);
    unlinkSync(filePath);
    const gone = await json("get_page", { slug: topic, include_full_body: true });
    const goneText = JSON.stringify(gone);
    expect(goneText).not.toContain(marker);
    expect(goneText).toContain("不可用");
  });

  test("index-pending topic (nulled committed hash) is excluded from search and direct reads", async () => {
    db.updatePageHash(topic, null);
    const results = await ctx.search.search("主题D", { strategy: "all", limit: 10 });
    expect(results.map((r) => r.slug)).not.toContain(topic);
    const page = await json("get_page", { slug: topic, include_full_body: true });
    expect(JSON.stringify(page)).not.toContain(marker);
  });

  // ── Agentic executor refuses topic page/chunks as original evidence ───

  test("agentic page/chunks steps refuse the topic and keep ordinary record reads", async () => {
    const executor = new AgenticResearchExecutor({
      db: ctx.db,
      search: ctx.search,
      graph: ctx.graph,
      pages: ctx.pages,
    });
    const result = await executor.execute({
      intent: "entity_lookup",
      entities: [],
      steps: [
        { kind: "page", input: topic },
        { kind: "chunks", input: topic },
        { kind: "page", input: sources[0] },
      ],
      budget: { max_llm_calls: 1, max_searches: 1, max_ms: 5000 },
    });
    expect(JSON.stringify(result.steps[0])).not.toContain(marker);
    expect((result.steps[0].data as { refused?: string }).refused).toBe("topic_page_not_original_evidence");
    expect((result.steps[1].data as { refused?: string }).refused).toBe("topic_chunks_not_original_evidence");
    const recordPage = result.steps[2].data as { body?: string } | null;
    expect(recordPage?.body).toContain("原始材料0");
  });

  // ── Content-route intent scoping (review #1) ──────────────────────────

  test("raw-detail/temporal/specific-content queries keep the original-only path even for a CURRENT topic", async () => {
    // Real user queries; the topic is fresh/current — only the query intent
    // decides. Plain theme lookup stays covered by the tests above.
    for (const query of ["主题D 原文细节", "主题D 最近变化", "主题D 具体内容"]) {
      const data = await json("cbrain_recall", { query, detail: "normal", include_raw: true });
      expect(JSON.stringify(data)).not.toContain(marker);
    }
    // The original records still answer those queries.
    const detail = await json("cbrain_recall", { query: "主题D 原文细节", detail: "normal", include_raw: true });
    expect(JSON.stringify(detail)).toContain("原始材料");
  });

  // ── Topic-origin relations/timeline never reach display or agentic steps ──

  test("deep_recall entities exclude topic-provenance links/timeline; originals survive", async () => {
    const tid = db.addTimelineEntry(sources[0], "TOPIC_ORIGIN_EVENT_SENTINEL", "2026-01-05", "extracted", { source_page_slug: topic });
    db.rawDb.prepare("UPDATE timeline SET trust_state='trusted' WHERE id=?").run(tid);
    db.addTimelineEntry(sources[0], "原始时间线事件记录", "2026-01-01", "dialogue");
    db.insertLink(sources[0], sources[1], "related", "TOPIC_ORIGIN_LINK_SENTINEL", 1, undefined, "explicit", 1, true, { source_page_slug: topic });
    db.rawDb.prepare("UPDATE links SET trust_state='trusted' WHERE from_slug=? AND to_slug=?").run(sources[0], sources[1]);

    const data = await json("deep_recall", { query: "材料0", strategy: "smart", detail: "normal", include_raw: true });
    const text = JSON.stringify(data);
    expect(text).not.toContain("TOPIC_ORIGIN_EVENT_SENTINEL");
    expect(text).not.toContain("TOPIC_ORIGIN_LINK_SENTINEL");
    // The ordinary original-source relation/timeline still hydrates.
    expect(text).toContain("原始时间线事件记录");
  });

  test("agentic timeline steps (resolve and keyword branches) drop topic-provenance events", async () => {
    const tid = db.addTimelineEntry(sources[0], "TOPIC_ORIGIN_EVENT_SENTINEL", "2026-01-05", "extracted", { source_page_slug: topic });
    db.rawDb.prepare("UPDATE timeline SET trust_state='trusted' WHERE id=?").run(tid);
    db.addTimelineEntry(sources[0], "原始时间线事件记录", "2026-01-01", "dialogue");
    db.addTimelineEntry(topic, "TOPIC_ROOT_EVENT_SENTINEL", "2026-01-02", "extracted");

    const executor = new AgenticResearchExecutor({ db: ctx.db, search: ctx.search, graph: ctx.graph, pages: ctx.pages });
    const resolved = await executor.execute({
      intent: "timeline",
      entities: [sources[0]],
      steps: [
        { kind: "resolve", input: sources[0] },
        { kind: "timeline", input: sources[0] },
        { kind: "timeline", input: "ORIGIN_EVENT" },
        { kind: "resolve", input: topic },
        { kind: "timeline", input: topic },
        { kind: "timeline", input: "ROOT_EVENT" },
      ],
      budget: { max_llm_calls: 1, max_searches: 1, max_ms: 5000 },
    });
    const text = JSON.stringify(resolved);
    expect(text).not.toContain("TOPIC_ORIGIN_EVENT_SENTINEL");
    expect(text).not.toContain("TOPIC_ROOT_EVENT_SENTINEL");
    expect(text).toContain("原始时间线事件记录");
  });

  // ── Stale get_page display stays user-facing (review #3) ──────────────

  test("stale get_page display is fixed short Chinese; reason/source refs stay metadata-only", async () => {
    invalidateViaDiskEdit();
    const data = await json("get_page", { slug: topic, include_full_body: true });
    expect(String(data.display)).not.toMatch(/source_hash_changed|records\/|catalog_/);
    expect(String(data.display)).toContain("主题页");
    // Internal provenance is preserved for audit/structured consumers.
    const derived = (data as { derived_topic?: { reason?: string } }).derived_topic;
    expect(derived?.reason).toContain("source_hash_changed");
  });

  // ── Zero topic work for ordinary no-topic queries ─────────────────────

  test("ordinary recall over a topic-free DB performs zero topic verification work", async () => {
    // Fresh DB with only the three original records (no topic page).
    const root2 = mkdtempSync("/tmp/cbrain-test-topic-read-none-");
    try {
      const vault2 = join(root2, "vault");
      mkdirSync(vault2, { recursive: true });
      const db2 = new CBrainDB(join(root2, "brain.sqlite"));
      const lance2 = new LanceDBManager();
      await lance2.connect(join(root2, "lance"));
      const ctx2 = buildContext({
        db: db2,
        lance: lance2,
        embedding: new DeterministicEmbeddingProvider(),
        vaultPath: vault2,
        runtimePath: join(root2, "runtime"),
      });
      try {
        for (let i = 0; i < 3; i++) {
          const body = `普通记录${i}：关于无关主题的普通记录内容。`;
          const page = ctx2.pages.create({ title: `普通记录${i}`, type: "record", body });
          const prepared = await ctx2.pipeline.embed(body);
          await ctx2.pipeline.writeIndexes(page.slug, prepared.chunks, prepared.embedResults);
        }
        const base = createTopicReadAdmission({ db: db2, vaultPath: vault2 });
        let verifications = 0;
        const counting = {
          inspectTopic: (slug: string) => { verifications++; return base.inspectTopic(slug); },
          isCurrentTopic: (slug: string) => { verifications++; return base.isCurrentTopic(slug); },
          readCurrentTopic: (slug: string) => { verifications++; return base.readCurrentTopic(slug); },
        };
        const search2 = new HybridSearch(db2, ctx2.embedding, lance2, { topicAdmission: counting });
        const results = await search2.search("普通记录", { strategy: "all", limit: 10 });
        expect(results.length).toBeGreaterThan(0);
        // Direct read surfaces on ordinary pages never consult the helper.
        ctx2.topicRead = counting;
        const handlers2: Record<string, (args: unknown) => Promise<unknown>> = {};
        const server2 = { registerTool: (name: string, _s: unknown, handler: (args: unknown) => Promise<unknown>) => { handlers2[name] = handler; } } as never;
        registerPageTools(server2, ctx2);
        const page = await handlers2.get_page({ slug: (db2.listPageSlugs({ type: "record" }))[0], include_full_body: true });
        expect(JSON.stringify(page)).toContain("普通记录");
        expect(verifications).toBe(0);
      } finally {
        ctx2.jobs.stop();
        await lance2.close();
        db2.close();
      }
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  });
});
