import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { PageManager } from "../../src/core/page.js";
import { ContentPipeline } from "../../src/core/ingestion/pipeline.js";
import { VersionManager } from "../../src/core/version.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import { DeterministicEmbeddingProvider } from "../../src/embedding/deterministic.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import type { LLMProvider, ChatMessage } from "../../src/llm/provider.js";
import { getOntology } from "../../src/ontology/loader.js";
import { parseFrontmatter } from "../../src/utils/frontmatter.js";
import { hashContent } from "../../src/core/shared.js";
import { generateSlug } from "../../src/utils/slug.js";
import {
  TopicManager,
  type TopicModelOutput,
} from "../../src/core/topics/index.js";

// ─── Anonymous fixtures only ────────────────────────────────────────

const RECORD_A_BODY = [
  "主题D的项目在第一阶段完成了协议设计。",
  "团队确认了组织C提供的数据接口可以使用。",
  "第一阶段的验收日期是三月底。",
].join("\n");

const RECORD_B_BODY = [
  "与组织C的对接会上确认了联合方案的范围。",
  "主题D的项目第二阶段将扩展到三个城市。",
  "预算上限维持不变。",
].join("\n");

const RECORD_C_BODY = [
  "用户想法：主题D的项目应该优先保证数据一致性。",
  "会议纪要：各方同意在四月初复盘阶段成果。",
  "风险项：人员缺口可能影响第二阶段。",
].join("\n");

/** Build a valid model output citing every source with exact substrings. */
function validModelOutput(sources: Array<{ slug: string; body: string }>): TopicModelOutput {
  return {
    overview: "主题D的项目横跨两个阶段，涉及组织C的数据合作。",
    observations: sources.map((s) => ({
      text: `来自 ${s.slug} 的要点：${s.body.split("\n")[0]}`,
      kind: "observation" as const,
      sourceSlug: s.slug,
      quote: s.body.split("\n")[0],
    })),
    details: sources.slice(0, 2).map((s) => ({
      text: `细节：${s.body.split("\n")[1]}`,
      kind: "observation" as const,
      sourceSlug: s.slug,
      quote: s.body.split("\n")[1],
    })),
    open_questions: [
      {
        text: "人员缺口是否会推迟第二阶段？",
        kind: "candidate" as const,
        sourceSlug: sources[sources.length - 1].slug,
        quote: sources[sources.length - 1].body.split("\n")[2],
      },
    ],
  };
}

interface LlmCall { messages: ChatMessage[] }

function makeFakeLlm(respond: (call: LlmCall, nth: number) => string): LLMProvider & { calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  return {
    name: "fake-topic-llm",
    calls,
    chat: async (messages) => {
      calls.push({ messages });
      return respond({ messages }, calls.length);
    },
  };
}

/** Scripted LLM queue; every response is a model-output object. */
function makeQueuedLlm(outputs: TopicModelOutput[]): LLMProvider & { calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  return {
    name: "fake-topic-llm",
    calls,
    chat: async (messages) => {
      calls.push({ messages });
      const next = outputs[Math.min(calls.length - 1, outputs.length - 1)];
      return JSON.stringify(next);
    },
  };
}

const noLogger = { info: () => {}, warn: () => {}, error: () => {} } as const;

describe("topic wiki — bounded compiler", () => {
  const testDir = "/tmp/cbrain-test-topics";
  const vaultPath = join(testDir, "vault");
  const dbPath = join(testDir, "test.sqlite");

  let db: CBrainDB;
  let pages: PageManager;
  let pipeline: ContentPipeline;
  let versions: VersionManager;
  let lance: LanceDBManager;
  let embedding: EmbeddingProvider;
  let sourceA: { slug: string; body: string };
  let sourceB: { slug: string; body: string };
  let sourceC: { slug: string; body: string };

  beforeEach(async () => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    pages = new PageManager(db, vaultPath, noLogger as never);
    lance = new LanceDBManager();
    await lance.connect(join(testDir, "lancedb"));
    embedding = new DeterministicEmbeddingProvider();
    pipeline = new ContentPipeline(db, embedding, lance, { pages, logger: noLogger as never });
    versions = new VersionManager(db, pages, vaultPath, noLogger as never);
  });

  afterEach(async () => {
    await lance.close();
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  async function seedRecord(title: string, body: string): Promise<{ slug: string; body: string }> {
    const page = pages.create({ title, type: "record", body });
    const { chunks, embedResults } = await pipeline.embed(body);
    await pipeline.writeIndexes(page.slug, chunks, embedResults);
    return { slug: page.slug, body };
  }

  function makeManager(llm: LLMProvider, budgets?: Partial<{ maxTotalMaterialChars: number }>) {
    return new TopicManager({
      db,
      pages,
      pipeline,
      versions,
      lance,
      llm,
      logger: noLogger as never,
      ...(budgets ? { budgets } : {}),
    });
  }

  async function seedSources() {
    sourceA = await seedRecord("记录甲", RECORD_A_BODY);
    sourceB = await seedRecord("记录乙", RECORD_B_BODY);
    sourceC = await seedRecord("记录丙", RECORD_C_BODY);
  }

  function allSources() {
    return [sourceA, sourceB, sourceC];
  }

  // ─── Ontology + canonical path ────────────────────────────────────

  test("ontology declares derived topic type with brain/topics vault dir", () => {
    const ontology = getOntology();
    expect(ontology.getEntityType("topic")).toBeDefined();
    expect(ontology.getVaultDir("topic")).toBe("brain/topics");
    expect(ontology.isDerivedPageType("topic")).toBe(true);
  });

  test("central NER gate skips derived topic pages", async () => {
    await seedSources();
    const nerLlm = makeFakeLlm(() =>
      JSON.stringify({ entities: [{ name: "组织C", type: "company", relevance: "high" }], relations: [], events: [], facts: [] }),
    );
    // A pipeline with a real NerEngine wired must still skip NER for topic pages.
    const { NerEngine } = await import("../../src/core/ingestion/ner.js");
    const nerEngine = new NerEngine(nerLlm);
    const nerPipeline = new ContentPipeline(db, embedding, lance, {
      pages,
      nerEngine,
      logger: noLogger as never,
    });
    const page = pages.create({ title: "主题D", type: "topic", body: "正文提到组织C。" });
    const result = await nerPipeline.processNer(page.slug, page.body, page.type, true);
    expect(result).toBeNull();
    expect(nerLlm.calls.length).toBe(0);
    // No entity stub was created from the topic body.
    expect(db.getEntitySlugByTitle("组织C")).toBeNull();
  });

  // ─── Source catalog ───────────────────────────────────────────────

  test("source catalog lists only actual record sources with disk hashes", async () => {
    await seedSources();
    const entityPage = pages.create({ title: "组织C", type: "entity/organization", body: "stub" });
    const llm = makeQueuedLlm([]);
    const manager = makeManager(llm);
    const catalog = manager.listSourceCatalog();

    const slugs = catalog.map((e) => e.slug);
    expect(slugs).toContain(sourceA.slug);
    expect(slugs).toContain(sourceB.slug);
    expect(slugs).toContain(sourceC.slug);
    expect(slugs).not.toContain(entityPage.slug);

    const entryA = catalog.find((e) => e.slug === sourceA.slug)!;
    const raw = readFileSync(join(vaultPath, `${sourceA.slug}.md`), "utf-8");
    expect(entryA.contentHash).toBe(hashContent(raw));
    expect(entryA.title).toBe("记录甲");
  });

  // ─── Three-source compile ─────────────────────────────────────────

  test("compiles a topic from three distinct record sources with exact citations", async () => {
    await seedSources();
    const sources = allSources();
    const llm = makeQueuedLlm([validModelOutput(sources)]);
    const manager = makeManager(llm);

    const beforeHashes = sources.map((s) => hashContent(readFileSync(join(vaultPath, `${s.slug}.md`), "utf-8")));
    const result = await manager.compile({ title: "主题D", sourceSlugs: sources.map((s) => s.slug) });

    expect(result.status).toBe("created");
    const slug = (result as { slug: string }).slug;
    expect(slug.startsWith("brain/topics/")).toBe(true);

    // Page on disk in the canonical directory with a topic manifest.
    const filePath = join(vaultPath, `${slug}.md`);
    expect(existsSync(filePath)).toBe(true);
    const raw = readFileSync(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter.type).toBe("topic");
    const manifest = frontmatter.topic as Record<string, unknown>;
    expect(manifest.schema_version).toBe(1);
    expect(manifest.generated_at).toBeTruthy();
    expect(typeof manifest.output_hash).toBe("string");
    const manifestSources = manifest.sources as Array<Record<string, unknown>>;
    expect(manifestSources.length).toBe(3);
    for (const s of manifestSources) {
      expect(typeof s.slug).toBe("string");
      expect(typeof s.snapshot_id).toBe("string");
      expect(typeof s.content_hash).toBe("string");
      expect(typeof s.governance_hash).toBe("string");
    }

    // Body: bounded sections, backticked citation slugs (no wikilinks — the
    // generated body must stay byte-stable when a source is later deleted),
    // provenance disclaimer.
    expect(body).toContain("## 概览");
    expect(body).toContain("## 主要观察");
    expect(body).toContain(`（来源：\`${sourceA.slug}\`）`);
    expect(body).not.toContain("[[");
    expect(body).toContain("自动编译");

    // Indexed for retrieval.
    expect(db.getChunksByPage(slug, { limit: 1 }).length).toBeGreaterThan(0);

    // Original records untouched.
    const afterHashes = sources.map((s) => hashContent(readFileSync(join(vaultPath, `${s.slug}.md`), "utf-8")));
    expect(afterHashes).toEqual(beforeHashes);

    expect(llm.calls.length).toBe(1);
  });

  test("rejects new topics below three distinct sources, above 12, or with non-record sources", async () => {
    await seedSources();
    const sources = allSources();
    const llm = makeQueuedLlm([validModelOutput(sources)]);
    const manager = makeManager(llm);

    const two = await manager.compile({ title: "主题E", sourceSlugs: [sourceA.slug, sourceB.slug] });
    expect(two.status).toBe("blocked");
    expect((two as { reason: string }).reason).toBe("too_few_sources");

    const dup = await manager.compile({ title: "主题E", sourceSlugs: [sourceA.slug, sourceA.slug, sourceA.slug] });
    expect(dup.status).toBe("blocked");
    expect((dup as { reason: string }).reason).toBe("too_few_sources");

    const entityPage = pages.create({ title: "组织C", type: "entity/organization", body: "stub" });
    const wrongType = await manager.compile({
      title: "主题E",
      sourceSlugs: [sourceA.slug, sourceB.slug, entityPage.slug],
    });
    expect(wrongType.status).toBe("blocked");
    expect((wrongType as { reason: string }).reason).toBe("source_not_record");

    // Generated pages can never be sources — not even another topic page.
    const topicSource = pages.create({ title: "既有主题", type: "topic", body: "generated" });
    const generatedInput = await manager.compile({
      title: "主题E",
      sourceSlugs: [sourceA.slug, sourceB.slug, topicSource.slug],
    });
    expect(generatedInput.status).toBe("blocked");
    expect((generatedInput as { reason: string }).reason).toBe("source_not_record");

    const missing = await manager.compile({
      title: "主题E",
      sourceSlugs: [sourceA.slug, sourceB.slug, "records/bu-cun-zai"],
    });
    expect(missing.status).toBe("blocked");
    expect((missing as { reason: string }).reason).toBe("source_not_found");

    const many = Array.from({ length: 13 }, (_, i) => `records/duo-${i}`);
    const tooMany = await manager.compile({ title: "主题E", sourceSlugs: many });
    expect(tooMany.status).toBe("blocked");
    expect((tooMany as { reason: string }).reason).toBe("too_many_sources");

    expect(llm.calls.length).toBe(0);
    expect(pages.getBySlug("brain/topics/主题e")).toBeNull();
  });

  test("rejects material over the bounded budget instead of truncating", async () => {
    await seedSources();
    const llm = makeQueuedLlm([]);
    const manager = makeManager(llm, { maxTotalMaterialChars: 50 });
    const result = await manager.compile({
      title: "主题F",
      sourceSlugs: allSources().map((s) => s.slug),
    });
    expect(result.status).toBe("blocked");
    expect((result as { reason: string }).reason).toBe("material_over_budget");
    expect(llm.calls.length).toBe(0);
  });

  test("blocks a topic title that collides with an existing page title", async () => {
    await seedSources();
    pages.create({ title: "主题G", type: "entity/company", body: "existing holder" });
    const llm = makeQueuedLlm([]);
    const manager = makeManager(llm);
    const result = await manager.compile({
      title: "主题G",
      sourceSlugs: allSources().map((s) => s.slug),
    });
    expect(result.status).toBe("blocked");
    expect((result as { reason: string }).reason).toBe("title_conflict");
    expect(llm.calls.length).toBe(0);
  });

  // ─── Model output validation ──────────────────────────────────────

  test("rejects fabricated quotes and unsupported citations without writing", async () => {
    await seedSources();
    const sources = allSources();

    const fabricated = validModelOutput(sources);
    fabricated.observations[0].quote = "这句话不存在于任何原始记录之中";
    let manager = makeManager(makeQueuedLlm([fabricated]));
    let result = await manager.compile({ title: "主题H", sourceSlugs: sources.map((s) => s.slug) });
    expect(result.status).toBe("blocked");
    expect((result as { reason: string }).reason).toBe("output_invalid");
    expect(pages.getBySlug("brain/topics/主题h")).toBeNull();

    const unknownSource = validModelOutput(sources);
    unknownSource.details[0].sourceSlug = "records/wei-xuan-ze";
    manager = makeManager(makeQueuedLlm([unknownSource]));
    result = await manager.compile({ title: "主题H", sourceSlugs: sources.map((s) => s.slug) });
    expect(result.status).toBe("blocked");
    expect((result as { reason: string }).reason).toBe("output_invalid");

    const emptyClaim = validModelOutput(sources);
    emptyClaim.observations[1].text = "  ";
    manager = makeManager(makeQueuedLlm([emptyClaim]));
    result = await manager.compile({ title: "主题H", sourceSlugs: sources.map((s) => s.slug) });
    expect(result.status).toBe("blocked");
    expect((result as { reason: string }).reason).toBe("output_invalid");

    const malformed = makeFakeLlm(() => "not json at all");
    manager = makeManager(malformed);
    result = await manager.compile({ title: "主题H", sourceSlugs: sources.map((s) => s.slug) });
    expect(result.status).toBe("blocked");
    expect((result as { reason: string }).reason).toBe("output_invalid");
    expect(pages.getBySlug("brain/topics/主题h")).toBeNull();
  });

  test("failed model call preserves the previous topic and throws", async () => {
    await seedSources();
    const sources = allSources();
    const llm = makeQueuedLlm([validModelOutput(sources)]);
    const manager = makeManager(llm);
    const created = await manager.compile({ title: "主题T", sourceSlugs: sources.map((s) => s.slug) });
    const slug = (created as { slug: string }).slug;
    const rawBefore = readFileSync(join(vaultPath, `${slug}.md`), "utf-8");

    const brokenLlm = makeFakeLlm(() => {
      throw new Error("LLM_UNAVAILABLE");
    });
    // A changed source makes the next compile reach the model phase.
    pages.update(sourceA.slug, { body: RECORD_A_BODY.replace("三月底", "五月底") });
    await expect(
      makeManager(brokenLlm).compile({ title: "主题T", sourceSlugs: sources.map((s) => s.slug) }),
    ).rejects.toThrow("LLM_UNAVAILABLE");
    expect(readFileSync(join(vaultPath, `${slug}.md`), "utf-8")).toBe(rawBefore);
  });

  test("model cannot promote trust states; observations/user thoughts/candidates stay labeled", async () => {
    await seedSources();
    const sources = allSources();
    const output = validModelOutput(sources);
    (output.observations[0] as unknown as Record<string, unknown>).trust_state = "trusted";
    output.observations[1].kind = "user_thought";
    output.observations[2].kind = "candidate";
    const llm = makeQueuedLlm([output]);
    const manager = makeManager(llm);

    const result = await manager.compile({ title: "主题I", sourceSlugs: sources.map((s) => s.slug) });
    expect(result.status).toBe("created");
    const slug = (result as { slug: string }).slug;
    const raw = readFileSync(join(vaultPath, `${slug}.md`), "utf-8");
    const { body } = parseFrontmatter(raw);

    expect(body).toContain("[观察]");
    expect(body).toContain("[用户想法]");
    expect(body).toContain("[候选]");
    expect(body).not.toContain("trusted");
  });

  // ─── No-op, freshness, refresh ────────────────────────────────────

  test("unchanged inputs compile to a no-op without a model call", async () => {
    await seedSources();
    const sources = allSources();
    const llm = makeQueuedLlm([validModelOutput(sources)]);
    const manager = makeManager(llm);

    const first = await manager.compile({ title: "主题J", sourceSlugs: sources.map((s) => s.slug) });
    expect(first.status).toBe("created");
    const slug = (first as { slug: string }).slug;
    expect(llm.calls.length).toBe(1);
    const versionsBefore = db.getVersions(slug).length;
    const rawBefore = readFileSync(join(vaultPath, `${slug}.md`), "utf-8");

    const second = await manager.compile({ title: "主题J", sourceSlugs: sources.map((s) => s.slug) });
    expect(second.status).toBe("unchanged");
    expect(llm.calls.length).toBe(1);
    expect(db.getVersions(slug).length).toBe(versionsBefore);
    expect(readFileSync(join(vaultPath, `${slug}.md`), "utf-8")).toBe(rawBefore);
  });

  test("freshness works after restart from disk state alone", async () => {
    await seedSources();
    const sources = allSources();
    const llm = makeQueuedLlm([validModelOutput(sources)]);
    const manager = makeManager(llm);
    const created = await manager.compile({ title: "主题K", sourceSlugs: sources.map((s) => s.slug) });
    const slug = (created as { slug: string }).slug;

    // A brand-new manager over the same DB/vault sees a fresh topic.
    const restarted = new TopicManager({
      db,
      pages: new PageManager(db, vaultPath, noLogger as never),
      pipeline,
      versions: new VersionManager(db, pages, vaultPath, noLogger as never),
      lance,
      llm,
      logger: noLogger as never,
    });
    const report = restarted.inspectFreshness(slug);
    expect(report).not.toBeNull();
    expect(report!.state).toBe("fresh");
    expect(report!.editedByUser).toBe(false);
    expect(report!.sources.every((s) => s.ok)).toBe(true);

    expect(restarted.inspectFreshness("brain/topics/bu-cun-zai")).toBeNull();
  });

  test("edited record invalidates freshness; refresh regenerates with a version snapshot", async () => {
    await seedSources();
    const sources = allSources();
    const llm = makeQueuedLlm([validModelOutput(sources)]);
    const manager = makeManager(llm);
    const created = await manager.compile({ title: "主题L", sourceSlugs: sources.map((s) => s.slug) });
    const slug = (created as { slug: string }).slug;

    // Correct the source record.
    const correctedBody = RECORD_A_BODY.replace("三月底", "四月中");
    pages.update(sourceA.slug, { body: correctedBody });
    const { chunks, embedResults } = await pipeline.embed(correctedBody);
    await pipeline.writeIndexes(sourceA.slug, chunks, embedResults);

    const stale = manager.inspectFreshness(slug);
    expect(stale!.state).toBe("stale");
    expect(stale!.reasons.some((r) => r.startsWith("source_hash_changed"))).toBe(true);

    const sourcesAfter = sources.map((s) =>
      s.slug === sourceA.slug ? { slug: s.slug, body: correctedBody } : s,
    );
    llm.calls.length = 0;
    const refreshLlm = makeQueuedLlm([validModelOutput(sourcesAfter)]);
    const refreshedManager = makeManager(refreshLlm);
    const result = await refreshedManager.compile({ title: "主题L", sourceSlugs: sources.map((s) => s.slug) });
    expect(result.status).toBe("refreshed");
    expect(refreshLlm.calls.length).toBe(1);
    expect(db.getVersions(slug).length).toBe(1);

    const fresh = manager.inspectFreshness(slug);
    expect(fresh!.state).toBe("fresh");
  });

  test("deleted source marks topic stale; refresh may use fewer sources but never zero", async () => {
    await seedSources();
    const sources = allSources();
    const llm = makeQueuedLlm([validModelOutput(sources)]);
    const manager = makeManager(llm);
    const created = await manager.compile({ title: "主题M", sourceSlugs: sources.map((s) => s.slug) });
    const slug = (created as { slug: string }).slug;

    await pages.delete(sourceC.slug);

    const stale = manager.inspectFreshness(slug);
    expect(stale!.state).toBe("stale");
    expect(stale!.reasons.some((r) => r.startsWith("source_missing"))).toBe(true);

    // Refresh with the two remaining sources is allowed for an existing topic.
    const remaining = [sourceA, sourceB];
    const refreshLlm = makeQueuedLlm([validModelOutput(remaining)]);
    const refreshed = await makeManager(refreshLlm).compile({
      title: "主题M",
      sourceSlugs: remaining.map((s) => s.slug),
    });
    expect(refreshed.status).toBe("refreshed");
    const raw = readFileSync(join(vaultPath, `${slug}.md`), "utf-8");
    const manifest = parseFrontmatter(raw).frontmatter.topic as Record<string, unknown>;
    expect((manifest.sources as unknown[]).length).toBe(2);
    const retired = manifest.retired_sources as Array<Record<string, unknown>>;
    expect(retired.map((r) => r.slug)).toContain(sourceC.slug);

    expect(manager.inspectFreshness(slug)!.state).toBe("fresh");

    // Zero valid sources blocks generation and keeps the old topic.
    await pages.delete(sourceA.slug);
    await pages.delete(sourceB.slug);
    const zero = await makeManager(makeQueuedLlm([])).compile({
      title: "主题M",
      sourceSlugs: [sourceA.slug, sourceB.slug],
    });
    expect(zero.status).toBe("blocked");
    expect((zero as { reason: string }).reason).toBe("zero_valid_sources");
    expect(readFileSync(join(vaultPath, `${slug}.md`), "utf-8")).toBe(raw);
  });

  test("governance trust changes invalidate freshness and rejected facts stay out of model material", async () => {
    await seedSources();
    const sources = allSources();

    // A rejected timeline fact on a source must not reach the model.
    db.rawDb
      .prepare("INSERT INTO timeline (page_slug, event_date, source, summary, trust_state) VALUES (?, ?, ?, ?, ?)")
      .run(sourceA.slug, "2026-01-05", "ner", "已被否决的结论：项目改名为主题Z", "rejected");

    const capture = makeFakeLlm(() => JSON.stringify(validModelOutput(sources)));
    const manager = makeManager(capture);
    const created = await manager.compile({ title: "主题N", sourceSlugs: sources.map((s) => s.slug) });
    expect(created.status).toBe("created");
    const prompt = capture.calls[0].messages.map((m) => m.content).join("\n");
    expect(prompt).not.toContain("主题Z");

    // Flipping a live timeline entry to superseded changes governance.
    const entryId = db.addTimelineEntry(sourceB.slug, "阶段二预算批复", "2026-02-01", "manual");
    expect(manager.inspectFreshness((created as { slug: string }).slug)!.state).toBe("stale");

    db.rawDb
      .prepare("UPDATE timeline SET trust_state = 'superseded' WHERE id = ?")
      .run(entryId);
    void entryId;

    // Refresh picks up the new governance fingerprint.
    const refreshLlm = makeQueuedLlm([validModelOutput(sources)]);
    const refreshed = await makeManager(refreshLlm).compile({
      title: "主题N",
      sourceSlugs: sources.map((s) => s.slug),
    });
    expect(refreshed.status).toBe("refreshed");
    expect(manager.inspectFreshness((created as { slug: string }).slug)!.state).toBe("fresh");
  });

  // ─── Race, cancellation, preservation ─────────────────────────────

  test("source edited during the model call aborts compile and preserves old topic", async () => {
    await seedSources();
    const sources = allSources();
    const llm = makeQueuedLlm([validModelOutput(sources)]);
    const manager = makeManager(llm);
    const created = await manager.compile({ title: "主题O", sourceSlugs: sources.map((s) => s.slug) });
    const slug = (created as { slug: string }).slug;
    const rawBefore = readFileSync(join(vaultPath, `${slug}.md`), "utf-8");
    const versionsBefore = db.getVersions(slug).length;

    // A legitimate source correction first, so the next compile gets past the
    // unchanged no-op gate and actually enters the model phase.
    const correctedA = RECORD_A_BODY.replace("三月底", "四月底");
    pages.update(sourceA.slug, { body: correctedA });
    const racedSources = sources.map((s) => (s.slug === sourceA.slug ? { slug: s.slug, body: correctedA } : s));

    const raceLlm = makeFakeLlm(() => {
      // Late source mutation lands while the "model" is working.
      const absPath = join(vaultPath, `${sourceB.slug}.md`);
      const current = parseFrontmatter(readFileSync(absPath, "utf-8"));
      writeFileSync(absPath, `---\ntitle: "${current.frontmatter.title}"\ntype: record\nslug: ${sourceB.slug}\n---\n被中途篡改的内容`, "utf-8");
      return JSON.stringify(validModelOutput(racedSources));
    });
    const raced = await makeManager(raceLlm).compile({
      title: "主题O",
      sourceSlugs: sources.map((s) => s.slug),
    });
    expect(raced.status).toBe("blocked");
    expect((raced as { reason: string }).reason).toBe("source_changed_during_compile");
    expect(readFileSync(join(vaultPath, `${slug}.md`), "utf-8")).toBe(rawBefore);
    expect(db.getVersions(slug).length).toBe(versionsBefore);
  });

  test("manual edit blocks silent overwrite and is reported by freshness", async () => {
    await seedSources();
    const sources = allSources();
    const llm = makeQueuedLlm([validModelOutput(sources)]);
    const manager = makeManager(llm);
    const created = await manager.compile({ title: "主题P", sourceSlugs: sources.map((s) => s.slug) });
    const slug = (created as { slug: string }).slug;

    pages.update(slug, { body: "用户手工补充的重要内容。" });
    const report = manager.inspectFreshness(slug);
    expect(report!.editedByUser).toBe(true);
    expect(report!.state).toBe("stale");

    const blocked = await makeManager(makeQueuedLlm([])).compile({
      title: "主题P",
      sourceSlugs: sources.map((s) => s.slug),
    });
    expect(blocked.status).toBe("blocked");
    expect((blocked as { reason: string }).reason).toBe("target_edited");

    const raw = readFileSync(join(vaultPath, `${slug}.md`), "utf-8");
    expect(parseFrontmatter(raw).body).toBe("用户手工补充的重要内容。");
  });

  test("cancellation after the model call leaves no trace", async () => {
    await seedSources();
    const sources = allSources();
    const llm = makeQueuedLlm([validModelOutput(sources)]);
    const manager = makeManager(llm);

    let cancel = false;
    const result = await manager.compile({
      title: "主题Q",
      sourceSlugs: sources.map((s) => s.slug),
      checkCancelled: () => {
        if (cancel) throw new Error("JOB_CANCELLED");
      },
      signal: undefined,
    });
    expect(result.status).toBe("created");
    const topicQ = (result as { slug: string }).slug;
    const rawBefore = readFileSync(join(vaultPath, `${topicQ}.md`), "utf-8");

    // Change a source legitimately so the next compile passes the unchanged
    // no-op gate and reaches the model phase; then cancel mid-flight: the
    // flag flips inside the model call, so the post-model check aborts
    // before any mutation.
    const correctedA = RECORD_A_BODY.replace("三月底", "四月底");
    pages.update(sourceA.slug, { body: correctedA });
    const racedSources = sources.map((s) => (s.slug === sourceA.slug ? { slug: s.slug, body: correctedA } : s));

    cancel = false;
    const cancelLlm = makeFakeLlm(() => {
      cancel = true;
      return JSON.stringify(validModelOutput(racedSources));
    });
    await expect(
      makeManager(cancelLlm).compile({
        title: "主题Q",
        sourceSlugs: sources.map((s) => s.slug),
        checkCancelled: () => {
          if (cancel) throw new Error("JOB_CANCELLED");
        },
      }),
    ).rejects.toThrow("JOB_CANCELLED");
    expect(readFileSync(join(vaultPath, `${topicQ}.md`), "utf-8")).toBe(rawBefore);
  });

  test("failed indexing prevents fresh reads and preserves the previous topic", async () => {
    await seedSources();
    const sources = allSources();
    const llm = makeQueuedLlm([validModelOutput(sources)]);
    const manager = makeManager(llm);
    const created = await manager.compile({ title: "主题R", sourceSlugs: sources.map((s) => s.slug) });
    const slug = (created as { slug: string }).slug;
    const rawBefore = readFileSync(join(vaultPath, `${slug}.md`), "utf-8");

    // Vector-layer fault: the first addChunks of the refresh fails; the
    // compensation re-index of the old content then succeeds.
    const originalAddChunks = lance.addChunks.bind(lance);
    let addChunksCalls = 0;
    (lance as unknown as { addChunks: typeof lance.addChunks }).addChunks = async (chunks) => {
      addChunksCalls++;
      if (addChunksCalls === 1) throw new Error("VECTOR_WRITE_FAILED");
      return originalAddChunks(chunks);
    };

    const sourcesUpdated = sources.map((s) =>
      s.slug === sourceA.slug ? { slug: s.slug, body: RECORD_A_BODY.replace("三月底", "五月底") } : s,
    );
    pages.update(sourceA.slug, { body: sourcesUpdated[0].body });
    const refreshLlm = makeQueuedLlm([validModelOutput(sourcesUpdated)]);
    await expect(
      makeManager(refreshLlm).compile({ title: "主题R", sourceSlugs: sources.map((s) => s.slug) }),
    ).rejects.toThrow();

    // Old topic content is back and readable; old indexes were restored.
    const restored = pages.getBySlugFresh(slug);
    expect(restored).not.toBeNull();
    expect(parseFrontmatter(readFileSync(join(vaultPath, `${slug}.md`), "utf-8")).body)
      .toBe(parseFrontmatter(rawBefore).body);
    expect(db.getChunksByPage(slug, { limit: 1 }).length).toBeGreaterThan(0);
  });

  test("failed indexing on a new topic leaves no page behind", async () => {
    await seedSources();
    const sources = allSources();

    const originalAddChunks = lance.addChunks.bind(lance);
    (lance as unknown as { addChunks: typeof lance.addChunks }).addChunks = async () => {
      throw new Error("VECTOR_WRITE_FAILED");
    };

    const llm = makeQueuedLlm([validModelOutput(sources)]);
    await expect(
      makeManager(llm).compile({ title: "主题S", sourceSlugs: sources.map((s) => s.slug) }),
    ).rejects.toThrow();

    const slug = generateSlug("主题S", "topic");
    expect(pages.getBySlugFresh(slug)).toBeNull();
    expect(existsSync(join(vaultPath, `${slug}.md`))).toBe(false);

    void originalAddChunks;
  });
});
