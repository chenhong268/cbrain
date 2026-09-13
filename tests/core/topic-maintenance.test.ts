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
import { parseFrontmatter, stringifyFrontmatter } from "../../src/utils/frontmatter.js";
import { hashContent } from "../../src/core/shared.js";
import { JobQueue } from "../../src/core/jobs.js";
import { shouldProcessNerForWritePath } from "../../src/core/ingestion/ner-write-path.js";
import { SyncManager } from "../../src/core/maintenance/sync.js";
import { NerEngine } from "../../src/core/ingestion/ner.js";
import { TopicManager } from "../../src/core/topics/index.js";
import {
  TopicMaintenance,
  TOPIC_JOB_NAME,
  MAX_MANAGED_TOPICS,
  computeCatalogFingerprint,
  type TopicPreviewReport,
  type TopicRunReceipt,
} from "../../src/core/topics/maintenance.js";

// ─── Anonymous fixtures only (主题D / 记录甲 / 组织C style) ──────────

const BODY_A = "主题D的第一阶段完成了协议设计。\n组织C的数据接口可以使用。";
const BODY_B = "与组织C的对接会确认了联合方案范围。\n主题D进入第二阶段。";
const BODY_C = "用户想法：主题D应优先保证数据一致性。\n四月初复盘。";

interface LlmCall { messages: ChatMessage[] }

/** Parse the compile prompt's SOURCE sections and answer with a valid cited
 *  output — works for any source set without per-test plumbing. */
function smartResponse(messages: ChatMessage[]): string {
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  const sources: Array<{ slug: string; line: string }> = [];
  for (const m of user.matchAll(/### SOURCE (\S+)\n([^\n]*)/g)) {
    sources.push({ slug: m[1], line: m[2] });
  }
  if (sources.length === 0) throw new Error("smart fake llm: no SOURCE section in prompt");
  const claim = (s: { slug: string; line: string }, i: number) => ({
    text: `要点${i}：${s.line}`,
    kind: "observation" as const,
    sourceSlug: s.slug,
    quote: s.line,
  });
  return JSON.stringify({
    overview: [claim(sources[0], 0)],
    observations: sources.map((s, i) => claim(s, i)),
    details: [],
    open_questions: [],
  });
}

function makeSmartLlm(): LLMProvider & { calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  return {
    name: "smart-topic-llm",
    calls,
    chat: async (messages) => {
      calls.push({ messages });
      return smartResponse(messages);
    },
  };
}

function makeFailingLlm(): LLMProvider & { calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  return {
    name: "failing-topic-llm",
    calls,
    chat: async (messages) => {
      calls.push({ messages });
      throw new Error("model unavailable");
    },
  };
}

/** Model call that hangs until released OR until the compile signal aborts. */
function makeGatedLlm(): { llm: LLMProvider & { calls: LlmCall[] }; entered: Promise<void>; release: () => void } {
  const calls: LlmCall[] = [];
  let release!: () => void;
  let enteredResolve!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const entered = new Promise<void>((r) => { enteredResolve = r; });
  const llm: LLMProvider & { calls: LlmCall[] } = {
    name: "gated-topic-llm",
    calls,
    chat: async (messages, options) => {
      calls.push({ messages });
      enteredResolve();
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(new Error("llm aborted"));
        const signal = options?.signal;
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        gate.then(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }).catch(() => {});
      });
      return smartResponse(messages);
    },
  };
  return { llm, entered, release };
}

const noLogger = { info: () => {}, warn: () => {}, error: () => {} } as const;

const BASE_NOW = Date.UTC(2026, 8, 13, 0, 0, 0);
const MINUTE = 60_000;

describe("topic wiki — discovery and maintenance", () => {
  const testDir = "/tmp/cbrain-test-topic-maint";
  const vaultPath = join(testDir, "vault");
  const dbPath = join(testDir, "test.sqlite");

  let db: CBrainDB;
  let pages: PageManager;
  let pipeline: ContentPipeline;
  let versions: VersionManager;
  let lance: LanceDBManager;
  let embedding: EmbeddingProvider;
  let queue: JobQueue;

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
    queue = new JobQueue(db);
  });

  afterEach(async () => {
    await lance.close();
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  const NUMERALS = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸", "子", "丑", "寅"];

  async function seedRecord(title: string, body: string, tags: string[] = []): Promise<string> {
    const page = pages.create({ title, type: "record", body });
    const { chunks, embedResults } = await pipeline.embed(body);
    await pipeline.writeIndexes(page.slug, chunks, embedResults);
    for (const tag of tags) db.addTag(page.slug, tag);
    return page.slug;
  }

  async function seedTaggedRecords(tag: string, count: number): Promise<string[]> {
    const slugs: string[] = [];
    for (let i = 0; i < count; i++) {
      slugs.push(await seedRecord(`记录${tag}${NUMERALS[i] ?? i}`, [BODY_A, BODY_B, BODY_C][i % 3], [tag]));
    }
    return slugs;
  }

  function makeMaintenance<T extends LLMProvider>(llm: T, budgets?: { maxTotalMaterialChars?: number }) {
    const manager = new TopicManager({
      db, pages, pipeline, versions, lance, llm,
      logger: noLogger as never,
      ...(budgets ? { budgets } : {}),
    });
    const maintenance = new TopicMaintenance({ db, jobs: queue, manager, vaultPath, logger: noLogger as never });
    maintenance.register();
    return { maintenance, llm, manager };
  }

  const smart = () => makeMaintenance(makeSmartLlm());

  async function runHandle(maintenance: TopicMaintenance, data: unknown): Promise<unknown> {
    return maintenance.handle(data, 0, {
      signal: new AbortController().signal,
      checkCancelled: () => {},
    });
  }

  // ─── Discovery ───────────────────────────────────────────────────

  test("tag seed counts DISTINCT records only, needs three", async () => {
    await seedTaggedRecords("主题D", 3);
    const { maintenance } = smart();
    const preview = (await runHandle(maintenance, { action: "preview" })) as TopicPreviewReport;
    const candidate = preview.candidates.find((c) => c.key === "tag:主题D");
    expect(candidate).toBeDefined();
    expect(candidate!.support).toBe(3);
    expect(candidate!.sourceSlugs).toHaveLength(3);
    expect(preview.enabled).toBe(false);
    expect(preview.spareSlots).toBe(MAX_MANAGED_TOPICS);
  });

  test("entity seed via Chinese 提及 link with source provenance", async () => {
    const entity = pages.create({ title: "组织C", type: "entity/organization", body: "组织C 简介。" });
    const slugs = await seedTaggedRecords("无关标签甲", 3);
    for (const slug of slugs) {
      db.insertLink(slug, entity.slug, "提及", null, 1, "medium", "ner", 0.8, false, { source_page_slug: slug });
    }
    const { maintenance } = smart();
    const preview = (await runHandle(maintenance, { action: "preview" })) as TopicPreviewReport;
    const candidate = preview.candidates.find((c) => c.key === `entity:${entity.slug}`);
    expect(candidate).toBeDefined();
    expect(candidate!.support).toBe(3);
    expect(candidate!.title).toBe("组织C（主题）");
  });

  test("entity-entity relations with record provenance seed their endpoints", async () => {
    // Distinct edge pairs (links are UNIQUE per from/to/relation, so each
    // edge carries exactly one provenance record).
    const e1 = pages.create({ title: "组织C", type: "entity/organization", body: "组织C。" });
    const e2 = pages.create({ title: "概念乙", type: "concept/technology", body: "概念乙。" });
    const e3 = pages.create({ title: "概念丙", type: "concept/technology", body: "概念丙。" });
    const e4 = pages.create({ title: "产品丁", type: "entity/product", body: "产品丁。" });
    const slugs = await seedTaggedRecords("无关标签乙", 3);
    const edges: Array<[string, string, string]> = [
      [e1.slug, e2.slug, "合作"],
      [e1.slug, e3.slug, "供应"],
      [e1.slug, e4.slug, "使用"],
    ];
    for (let i = 0; i < edges.length; i++) {
      const [from, to, relation] = edges[i];
      db.insertLink(from, to, relation, null, 1, "medium", "ner", 0.8, false, { source_page_slug: slugs[i] });
    }
    const { maintenance } = smart();
    const preview = (await runHandle(maintenance, { action: "preview" })) as TopicPreviewReport;
    // The hub endpoint gathers support from every provenanced edge it touches.
    const candidate = preview.candidates.find((c) => c.key === `entity:${e1.slug}`);
    expect(candidate).toBeDefined();
    expect(candidate!.support).toBe(3);
    // Peripheral endpoints touch only one edge each: below minimum, not offered.
    expect(preview.candidates.find((c) => c.key === `entity:${e2.slug}`)).toBeUndefined();
  });

  test("legacy record→entity links without provenance are excluded and counted", async () => {
    const entity = pages.create({ title: "组织C", type: "entity/organization", body: "组织C。" });
    const slugs = await seedTaggedRecords("无关标签丙", 3);
    for (const slug of slugs) {
      db.insertLink(slug, entity.slug, "提及", null, 1, "medium", "ner", 0.8, false, undefined);
    }
    const { maintenance } = smart();
    const preview = (await runHandle(maintenance, { action: "preview" })) as TopicPreviewReport;
    expect(preview.candidates.find((c) => c.key === `entity:${entity.slug}`)).toBeUndefined();
    expect(preview.excludedCounts.missingProvenanceLinks).toBeGreaterThanOrEqual(3);
  });

  test("generated pages never count as sources", async () => {
    const entity = pages.create({ title: "组织C", type: "entity/organization", body: "组织C。" });
    await seedRecord("记录甲", BODY_A, ["主题D"]);
    await seedRecord("记录乙", BODY_B, ["主题D"]);
    // Only two records; a tagged topic page and an insight must not bridge the gap.
    pages.create({ title: "已生成的主题页", type: "topic", body: "正文。", tags: ["主题D"] });
    pages.create({ title: "洞察丙", type: "insight", body: "洞察。", tags: ["主题D"] });
    db.addTag(entity.slug, "主题D");
    const { maintenance } = smart();
    const preview = (await runHandle(maintenance, { action: "preview" })) as TopicPreviewReport;
    expect(preview.candidates.find((c) => c.key === "tag:主题D")).toBeUndefined();
    expect(preview.excludedCounts.belowMinimum).toBeGreaterThanOrEqual(1);
  });

  test("deterministic ordering and exact-source-set duplicate collapse", async () => {
    // The SAME three records carry both alpha and beta → identical source sets collapse.
    const shared: string[] = [];
    for (let i = 0; i < 3; i++) {
      const slug = await seedRecord(`共享记录${NUMERALS[i]}`, [BODY_A, BODY_B, BODY_C][i]);
      db.addTag(slug, "alpha");
      db.addTag(slug, "beta");
      shared.push(slug);
    }
    await seedTaggedRecords("gamma", 4);
    const { maintenance } = smart();
    const preview = (await runHandle(maintenance, { action: "preview" })) as TopicPreviewReport;
    const keys = preview.candidates.map((c) => c.key);
    // gamma (support 4) ranks before alpha (3); alpha and beta collapsed — kept is the lower key.
    expect(keys).toEqual(["tag:gamma", "tag:alpha"]);
    const merged = preview.mergedDuplicateSeeds.find((m) => m.kept === "tag:alpha");
    expect(merged?.merged).toEqual(["tag:beta"]);
    const kept = preview.candidates.find((c) => c.key === "tag:alpha")!;
    expect([...kept.sourceSlugs].sort()).toEqual([...shared].sort());
  });

  test("more than twelve sources select twelve deterministically and report the omission", async () => {
    const slugs = await seedTaggedRecords("主题D", 13);
    const { maintenance } = smart();
    const preview = (await runHandle(maintenance, { action: "preview" })) as TopicPreviewReport;
    const candidate = preview.candidates.find((c) => c.key === "tag:主题D")!;
    expect(candidate.support).toBe(13);
    expect(candidate.sourceSlugs).toHaveLength(12);
    expect(candidate.omittedSources).toBe(1);
    const sorted = [...slugs].sort();
    expect(candidate.sourceSlugs).toEqual(sorted.slice(0, 12));
  });

  // ─── Enablement, creation, budget ────────────────────────────────

  test("disabled maintenance never enqueues; enabled tick fills up to five total", async () => {
    for (const tag of ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6"]) {
      await seedTaggedRecords(tag, 3);
    }
    const { maintenance, llm } = smart();
    expect(maintenance.tick(BASE_NOW)).toBe(false);
    expect(db.listJobs("pending").filter((j) => j.name === TOPIC_JOB_NAME)).toHaveLength(0);

    await runHandle(maintenance, { action: "enable" });
    expect(db.getConfig("topic.enabled")).toBe("true");
    // Enabling starts the cadence timer, whose immediate startup tick
    // enqueues exactly one scheduled fill job.
    const pending = db.listJobs("pending").filter((j) => j.name === TOPIC_JOB_NAME);
    expect(pending).toHaveLength(1);
    expect(maintenance.tick(BASE_NOW)).toBe(false); // coalesced while active
    const receipt = (await runHandle(maintenance, JSON.parse(pending[0].data!))) as TopicRunReceipt;
    expect(receipt.counts.created).toBe(MAX_MANAGED_TOPICS);
    expect(db.listPageSlugs({ type: "topic" })).toHaveLength(MAX_MANAGED_TOPICS);

    // Repeated reconciliation must not add a sixth topic nor call the model again.
    const callsAfterFirst = llm.calls.length;
    const topicsNow = db.listPageSlugs({ type: "topic" }).slice().sort();
    const second = (await runHandle(maintenance, { action: "refresh" })) as TopicRunReceipt;
    expect(db.listPageSlugs({ type: "topic" })).toHaveLength(MAX_MANAGED_TOPICS);
    expect(db.listPageSlugs({ type: "topic" }).slice().sort()).toEqual(topicsNow);
    expect(llm.calls.length).toBe(callsAfterFirst);
    expect(second.counts.unchanged + second.counts.reattested).toBe(MAX_MANAGED_TOPICS);
  });

  test("enable with explicit candidateKeys creates only the selection; failures stay pending", async () => {
    await seedTaggedRecords("tag-good", 3);
    // Oversize candidates: material over the compiler budget must reject, never truncate.
    await seedRecord("超大记录", `${BODY_A}\n${"补充细节。".repeat(60000)}`, ["tag-big"]);
    await seedRecord("超大记录乙", `${BODY_B}\n${"更多细节。".repeat(60000)}`, ["tag-big"]);
    await seedRecord("超大记录丙", `${BODY_C}\n${"其余细节。".repeat(60000)}`, ["tag-big"]);
    await seedTaggedRecords("tag-generic", 4);
    const { maintenance, llm } = makeMaintenance(makeSmartLlm(), { maxTotalMaterialChars: 150_000 });

    const receipt = (await runHandle(maintenance, {
      action: "enable",
      candidateKeys: ["tag:tag-good", "tag:tag-big"],
    })) as unknown as {
      created: Array<{ key: string }>; blocked: Array<{ key: string; reason: string }>; pendingSelection: string[];
    };
    expect(receipt.created.map((c) => c.key)).toEqual(["tag:tag-good"]);
    expect(receipt.blocked.find((b) => b.key === "tag:tag-big")?.reason).toBe("material_over_budget");
    expect(receipt.pendingSelection).toEqual(["tag:tag-big"]);
    expect(db.getConfig("topic.pending_selection")).toBe(JSON.stringify(["tag:tag-big"]));
    expect(db.listPageSlugs({ type: "topic" })).toHaveLength(1);

    // A later scheduler run retries the SAME failed selection and must not
    // silently fill the spare slot with the higher-ranked generic candidate.
    const callsBefore = llm.calls.length;
    const retry = (await runHandle(maintenance, { action: "refresh", scheduled: true })) as TopicRunReceipt;
    expect(retry.counts.created).toBe(0);
    expect(db.listPageSlugs({ type: "topic" })).toHaveLength(1);
    expect(llm.calls.length).toBe(callsBefore); // oversize candidate rejected before any model call
  });

  test("candidate below three distinct records is not offered nor creatable", async () => {
    await seedTaggedRecords("小种子", 2);
    const { maintenance } = smart();
    const preview = (await runHandle(maintenance, { action: "preview" })) as TopicPreviewReport;
    expect(preview.candidates.find((c) => c.key === "tag:小种子")).toBeUndefined();
    const bad = (await runHandle(maintenance, { action: "enable", candidateKeys: ["tag:小种子"] })) as unknown as { invalidKeys: string[]; enabled: boolean };
    expect(bad.invalidKeys).toEqual(["tag:小种子"]);
    expect(bad.enabled).toBe(false);
    expect(db.getConfig("topic.enabled")).toBeNull();
  });

  test("same-name tag avoids the global title collision via the suffix; occupied suffix blocks", async () => {
    // A record page already holds the plain title the tag would otherwise
    // want — pages.title is globally UNIQUE.
    pages.create({ title: "同名主题", type: "record", body: "同名正文。" });
    await seedTaggedRecords("同名主题", 3);
    // Another candidate whose SUFFIXED title is already occupied.
    pages.create({ title: "占用乙（主题）", type: "record", body: "占用正文。" });
    await seedTaggedRecords("占用乙", 3);
    const { maintenance } = smart();
    const preview = (await runHandle(maintenance, { action: "preview" })) as TopicPreviewReport;
    const candidate = preview.candidates.find((c) => c.key === "tag:同名主题")!;
    expect(candidate.title).toBe("同名主题（主题）");

    await runHandle(maintenance, { action: "enable", candidateKeys: ["tag:同名主题"] });
    expect(db.listPageSlugs({ type: "topic" })).toHaveLength(1);

    const blocked = (await runHandle(maintenance, { action: "enable", candidateKeys: ["tag:占用乙"] })) as unknown as {
      blocked: Array<{ reason: string }>; created: unknown[];
    };
    expect(blocked.created).toHaveLength(0);
    expect(blocked.blocked[0]?.reason).toBe("title_conflict");
    expect(db.listPageSlugs({ type: "topic" })).toHaveLength(1); // no random fallback name
    expect(db.getPageByTitle("占用乙（主题）")!.type).toBe("record"); // existing page untouched
  });

  // ─── Catalog fingerprint and freshness ───────────────────────────

  test("unchanged catalog and inputs: pure no-op, no model, no write", async () => {
    await seedTaggedRecords("主题D", 3);
    const { maintenance, llm } = smart();
    await runHandle(maintenance, { action: "enable", candidateKeys: ["tag:主题D"] });
    const topicSlug = db.listPageSlugs({ type: "topic" })[0];
    const rawAfterCreate = readFileSync(join(vaultPath, db.getPageFilePath(topicSlug)!), "utf-8");
    const updatedAtAfterCreate = db.getPage(topicSlug)!.updated_at;
    const callsAfterCreate = llm.calls.length;
    expect(callsAfterCreate).toBe(1);

    const receipt = (await runHandle(maintenance, { action: "refresh" })) as TopicRunReceipt;
    expect(receipt.counts.unchanged).toBe(1);
    expect(llm.calls.length).toBe(callsAfterCreate);
    expect(readFileSync(join(vaultPath, db.getPageFilePath(topicSlug)!), "utf-8")).toBe(rawAfterCreate);
    expect(db.getPage(topicSlug)!.updated_at).toBe(updatedAtAfterCreate);
  });

  test("unrelated catalog change reattests the manifest proof without a model call", async () => {
    await seedTaggedRecords("主题D", 3);
    const { maintenance, llm } = smart();
    await runHandle(maintenance, { action: "enable", candidateKeys: ["tag:主题D"] });
    const topicSlug = db.listPageSlugs({ type: "topic" })[0];
    const bodyBefore = parseFrontmatter(readFileSync(join(vaultPath, db.getPageFilePath(topicSlug)!), "utf-8")).body;
    const catalogBefore = computeCatalogFingerprint(db);
    const callsAfterCreate = llm.calls.length;

    // A DB-visible record unrelated to the topic's chosen inputs.
    await seedRecord("无关新记录", "与主题D完全无关的新记录。");
    expect(computeCatalogFingerprint(db)).not.toBe(catalogBefore);

    const receipt = (await runHandle(maintenance, { action: "refresh" })) as TopicRunReceipt;
    expect(receipt.counts.reattested).toBe(1);
    expect(llm.calls.length).toBe(callsAfterCreate);
    const rawAfter = readFileSync(join(vaultPath, db.getPageFilePath(topicSlug)!), "utf-8");
    expect(parseFrontmatter(rawAfter).body).toBe(bodyBefore);
    const manifest = parseFrontmatter(rawAfter).frontmatter.topic as { catalog?: string };
    expect(manifest.catalog).toBe(computeCatalogFingerprint(db));
    // Content hash proves the indexed bytes are the current bytes.
    expect(db.getPageContentHash(topicSlug)).toBe(hashContent(rawAfter));
  });

  test("relevant new source is incorporated on the next maintenance run", async () => {
    await seedTaggedRecords("主题D", 3);
    const { maintenance, llm } = smart();
    await runHandle(maintenance, { action: "enable", candidateKeys: ["tag:主题D"] });
    const topicSlug = db.listPageSlugs({ type: "topic" })[0];
    expect(llm.calls.length).toBe(1);

    const fresh = await seedRecord("新加入的记录", "主题D新增的第四条记录。", ["主题D"]);
    const receipt = (await runHandle(maintenance, { action: "refresh" })) as TopicRunReceipt;
    expect(receipt.counts.refreshed).toBe(1);
    expect(llm.calls.length).toBe(2);
    const manifest = parseFrontmatter(readFileSync(join(vaultPath, db.getPageFilePath(topicSlug)!), "utf-8")).frontmatter.topic as { sources: Array<{ slug: string }> };
    expect(manifest.sources.map((s) => s.slug)).toContain(fresh);
  });

  test("disk-level source edit refreshes the topic even though the DB catalog is blind to it", async () => {
    const slugs = await seedTaggedRecords("主题D", 3);
    const { maintenance } = smart();
    await runHandle(maintenance, { action: "enable", candidateKeys: ["tag:主题D"] });
    const topicSlug = db.listPageSlugs({ type: "topic" })[0];

    // Edit a source on disk WITHOUT syncing: DB hash/catalog stay unchanged.
    // Round-trip through the same frontmatter writer so the parsed body keeps
    // its shape (a hand-rolled raw write would shift the first body line).
    const sourcePath = join(vaultPath, db.getPageFilePath(slugs[0])!);
    const { frontmatter } = parseFrontmatter(readFileSync(sourcePath, "utf-8"));
    writeFileSync(sourcePath, stringifyFrontmatter(frontmatter, `${BODY_A}\n磁盘上补充的一行。`));

    const receipt = (await runHandle(maintenance, { action: "refresh" })) as TopicRunReceipt;
    expect(receipt.counts.refreshed).toBe(1);
    expect(maintenance.preview().managedTopics.find((t) => t.slug === topicSlug)?.freshness).toBe("fresh");
  });

  // ─── Scheduling lifecycle ────────────────────────────────────────

  test("tick coalesces: one pending job, deferred daily request is not lost", async () => {
    await seedTaggedRecords("主题D", 3);
    const { maintenance } = smart();
    await runHandle(maintenance, { action: "enable" });
    const t0 = Date.now();

    // The enable's startup tick already enqueued the single scheduled job.
    expect(db.listJobs("pending").filter((j) => j.name === TOPIC_JOB_NAME)).toHaveLength(1);
    expect(maintenance.tick(t0 + MINUTE)).toBe(false); // active job coalesces

    // Simulate the pending job running; a daily tick during the run defers.
    const running = db.listJobs("pending").filter((j) => j.name === TOPIC_JOB_NAME)[0];
    db.rawDb.prepare("UPDATE jobs SET status='running', started_at=datetime('now') WHERE id=?").run(running.id);
    expect(maintenance.tick(t0 + 24 * 60 * MINUTE)).toBe(false); // running: no second job
    db.rawDb.prepare("UPDATE jobs SET status='done' WHERE id=?").run(running.id);

    // Not yet due for the 30-minute cadence, but the deferred daily
    // reconcile survives as a single follow-up request.
    expect(maintenance.tick(t0 + 24 * 60 * MINUTE + 2 * MINUTE)).toBe(true);
    expect(db.listJobs("pending").filter((j) => j.name === TOPIC_JOB_NAME)).toHaveLength(1);
  });

  test("failure cadence: model failure completes the job once and the next attempt waits for the tick", async () => {
    await seedTaggedRecords("主题D", 3);
    const { maintenance } = makeMaintenance(makeFailingLlm());
    await runHandle(maintenance, { action: "enable", candidateKeys: ["tag:主题D"] });
    const t0 = Date.now(); // the enable's startup tick marked this as the last attempt

    // Drive the real queue: the job must finish 'done' with an error receipt (no hot retry).
    const id = queue.submit(TOPIC_JOB_NAME, { action: "refresh" });
    const work = queue.work(5);
    await new Promise((r) => setTimeout(r, 250));
    queue.stop();
    await work;
    const job = db.getJob(id)!;
    expect(job.status).toBe("done");
    expect(job.attempts).toBe(1);
    expect((JSON.parse(job.result!) as { blocked: Array<{ reason: string }> }).blocked[0].reason).toBe("model_error");

    expect(maintenance.tick(t0 + 10 * MINUTE)).toBe(false);
    expect(maintenance.tick(t0 + 31 * MINUTE)).toBe(true);
  });

  test("restart recovery resets just-crashed running topic jobs only, and reconciles when enabled", async () => {
    await seedTaggedRecords("主题D", 3);
    // A topic job that crashed moments ago (started_at = now) must be
    // recovered at single-writer startup — a TTL-only reset would leave it
    // blocking every future tick forever.
    db.rawDb.prepare("INSERT INTO jobs (name, status, started_at) VALUES ('topic-wiki','running',datetime('now'))").run();
    db.rawDb.prepare("INSERT INTO jobs (name, status, started_at) VALUES ('ner-backfill','running',datetime('now'))").run();

    const { maintenance } = smart();
    await runHandle(maintenance, { action: "enable" });
    maintenance.startup(BASE_NOW);
    const topicJobs = db.listJobs().filter((j) => j.name === TOPIC_JOB_NAME);
    expect(topicJobs.some((j) => j.status === "pending")).toBe(true);
    expect(topicJobs.some((j) => j.status === "running")).toBe(false);
    const ner = db.listJobs().filter((j) => j.name === "ner-backfill");
    expect(ner.every((j) => j.status === "running")).toBe(true);
  });

  test("a second explicit enable cannot exceed five total topics", async () => {
    const keys = ["主题甲", "主题乙", "主题丙", "主题丁", "主题戊"];
    for (const key of keys) await seedTaggedRecords(key, 3);
    const { maintenance } = smart();
    await runHandle(maintenance, { action: "enable", candidateKeys: keys.map((k) => `tag:${k}`) });
    expect(db.listPageSlugs({ type: "topic" })).toHaveLength(MAX_MANAGED_TOPICS);

    await seedTaggedRecords("主题己", 3);
    const receipt = (await runHandle(maintenance, { action: "enable", candidateKeys: ["tag:主题己"] })) as unknown as {
      created: unknown[]; blocked: Array<{ reason: string }>;
    };
    expect(db.listPageSlugs({ type: "topic" })).toHaveLength(MAX_MANAGED_TOPICS);
    expect(receipt.created).toHaveLength(0);
    expect(receipt.blocked[0]?.reason).toBe("at_capacity");
  });

  test("an explicit selection stays authoritative after all selected topics succeed", async () => {
    await seedTaggedRecords("chosen", 3);
    await seedTaggedRecords("generic", 4); // higher support — would win generic auto-fill
    const { maintenance, llm } = smart();
    await runHandle(maintenance, { action: "enable", candidateKeys: ["tag:chosen"] });
    expect(db.listPageSlugs({ type: "topic" })).toHaveLength(1);
    expect(db.getConfig("topic.pending_selection")).toBeNull(); // selection fully materialized

    const callsBefore = llm.calls.length;
    const receipt = (await runHandle(maintenance, { action: "refresh", scheduled: true })) as TopicRunReceipt;
    expect(receipt.counts.created).toBe(0);
    expect(db.listPageSlugs({ type: "topic" })).toHaveLength(1); // no silent generic fill to 5
    expect(llm.calls.length).toBe(callsBefore);
    expect(receipt.counts.unchanged + receipt.counts.reattested).toBe(1);
  });

  test("refresh coalescing never swallows a fresh request into a running preview or enable", async () => {
    await seedTaggedRecords("主题D", 3);
    const { maintenance } = smart();
    db.rawDb.prepare("INSERT INTO jobs (name, data, status) VALUES ('topic-wiki', ?, 'running')").run(JSON.stringify({ action: "preview" }));
    const submitted = maintenance.controlSubmit({ action: "refresh" })!;
    expect(submitted.coalesced).toBe(false);
    const job = db.getJob(submitted.id)!;
    expect(job.status).toBe("pending");
    expect((JSON.parse(job.data!) as { action: string }).action).toBe("refresh");
  });

  test("disable through the real job submission path cancels pending and running work", async () => {
    await seedTaggedRecords("主题D", 3);
    const { llm, entered } = makeGatedLlm();
    const { maintenance } = makeMaintenance(llm);
    await runHandle(maintenance, { action: "enable" });

    const refreshId = queue.submit(TOPIC_JOB_NAME, { action: "refresh" });
    const work = queue.work(5);
    await entered; // the refresh job is inside the model call
    const extraId = queue.submit(TOPIC_JOB_NAME, { action: "refresh" }); // pending follow-up

    const controlled = maintenance.controlSubmit({ action: "disable" });
    expect(controlled).not.toBeNull();
    expect(db.getConfig("topic.enabled")).toBe("false");
    expect(db.getJob(refreshId)!.status).toBe("cancelled"); // running job cancelled immediately
    expect(db.getJob(extraId)!.status).toBe("cancelled"); // pending job cancelled
    expect(db.getJob(controlled!.id)!.status).toBe("pending"); // audit row retained
    // The abort is threaded into the compile's model request, so the running
    // work settles promptly without any manual release.
    await new Promise((r) => setTimeout(r, 200));
    queue.stop();
    await work;
    expect(db.listPageSlugs({ type: "topic" })).toHaveLength(0); // nothing published after cancel
    expect(maintenance.tick(BASE_NOW + 60 * MINUTE)).toBe(false);
  });

  test("stop() cancels the active compile and prevents post-stop publication", async () => {
    await seedTaggedRecords("主题D", 3);
    const { llm, entered } = makeGatedLlm();
    const { maintenance } = makeMaintenance(llm);
    await runHandle(maintenance, { action: "enable" });
    const id = queue.submit(TOPIC_JOB_NAME, { action: "refresh" });
    const work = queue.work(5);
    await entered;
    // stop() cancels the running job — the abort reaches the in-flight model
    // call through the compile signal — and holds until it settles.
    await maintenance.stop();
    queue.stop();
    await work;
    expect(db.getJob(id)!.status).toBe("cancelled");
    expect(db.listPageSlugs({ type: "topic" })).toHaveLength(0);
    expect(maintenance.tick(BASE_NOW + 90 * MINUTE)).toBe(false); // timer stopped
  });

  test("stop() during the index await holds until compensation settles and restores prior bytes", async () => {
    const slugs = await seedTaggedRecords("主题D", 3);
    const signals: AbortSignal[] = [];
    const llm: LLMProvider = {
      name: "capture-signal-llm",
      chat: async (messages, options) => {
        if (options?.signal) signals.push(options.signal);
        return smartResponse(messages);
      },
    };
    const { maintenance } = makeMaintenance(llm);
    await runHandle(maintenance, { action: "enable", candidateKeys: ["tag:主题D"] });
    const topicSlug = db.listPageSlugs({ type: "topic" })[0];
    const rawBefore = readFileSync(join(vaultPath, db.getPageFilePath(topicSlug)!), "utf-8");

    // Force a refresh: edit a source on disk so the topic is stale
    // (round-tripped through the frontmatter writer to keep the body shape).
    const sourcePath = join(vaultPath, db.getPageFilePath(slugs[0])!);
    const { frontmatter } = parseFrontmatter(readFileSync(sourcePath, "utf-8"));
    writeFileSync(sourcePath, stringifyFrontmatter(frontmatter, `${BODY_A}\n磁盘上修改的一行。`));

    // Hang the refresh's index write until its job signal aborts; the
    // abort-threaded cancellation then lands inside the post-index window.
    const realWrite = pipeline.writeIndexes.bind(pipeline);
    let hangArmed = true;
    let hangEnteredResolve!: () => void;
    const hangEntered = new Promise<void>((r) => { hangEnteredResolve = r; });
    pipeline.writeIndexes = async (slug, chunks, embedResults) => {
      if (hangArmed) {
        hangArmed = false;
        hangEnteredResolve();
        const signal = signals[signals.length - 1];
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return realWrite(slug, chunks, embedResults);
    };

    const id = queue.submit(TOPIC_JOB_NAME, { action: "refresh" });
    const work = queue.work(5);
    await hangEntered;
    await maintenance.stop(); // cancel → abort → index write completes → post-await cancel → compensation
    queue.stop();
    await work;

    expect(db.getJob(id)!.status).toBe("cancelled");
    // Compensation restored the pre-refresh bytes BEFORE stop() resolved —
    // the writer lock is never released over in-flight topic writes.
    expect(readFileSync(join(vaultPath, db.getPageFilePath(topicSlug)!), "utf-8")).toBe(rawBefore);
    expect(maintenance.preview().managedTopics.find((t) => t.slug === topicSlug)?.freshness).not.toBe("invalid");
  });

  test("vanished seed derives an empty selection: no manifest fallback, no reattest", async () => {
    await seedTaggedRecords("主题甲", 3);
    const { maintenance } = smart();
    await runHandle(maintenance, { action: "enable", candidateKeys: ["tag:主题甲"] });
    const slug = db.listPageSlugs({ type: "topic" })[0];
    const catalogBefore = computeCatalogFingerprint(db);

    // The seed loses ALL members (tags removed from every record).
    for (const record of db.listPageSlugs({ type: "record" })) db.deleteTagsByPage(record);
    expect(computeCatalogFingerprint(db)).not.toBe(catalogBefore);

    const receipt = (await runHandle(maintenance, { action: "refresh" })) as TopicRunReceipt;
    expect(receipt.counts.blocked).toBeGreaterThan(0);
    expect(receipt.blocked[0]?.reason).toBe("too_few_sources");
    const manifest = parseFrontmatter(readFileSync(join(vaultPath, db.getPageFilePath(slug)!), "utf-8")).frontmatter.topic as { catalog?: string };
    // Old membership was never reattested against the changed catalog.
    expect(manifest.catalog).not.toBe(computeCatalogFingerprint(db));
    expect(maintenance.preview().managedTopics.find((t) => t.slug === slug)?.freshness).not.toBe("fresh");
  });

  test("refresh rejects candidateKeys instead of silently ignoring them (enable-only contract)", async () => {
    await seedTaggedRecords("主题甲", 3);
    await seedTaggedRecords("主题乙", 3);
    const { maintenance } = smart();
    await runHandle(maintenance, { action: "enable", candidateKeys: ["tag:主题甲"] });
    const exec = { signal: new AbortController().signal, checkCancelled: () => {} };
    await expect(maintenance.handle({ action: "refresh", candidateKeys: ["tag:主题乙"] }, 0, exec))
      .rejects.toThrow("candidateKeys is enable-only");
    // The submit hook rejects the payload the same way — no job row created
    // (the one existing row is the enable's own startup tick).
    const rowsBefore = db.listJobs().filter((j) => j.name === TOPIC_JOB_NAME).length;
    expect(maintenance.controlSubmit({ action: "refresh", candidateKeys: ["tag:主题乙"] })).toBeNull();
    expect(db.listJobs().filter((j) => j.name === TOPIC_JOB_NAME)).toHaveLength(rowsBefore);
    expect(db.listPageSlugs({ type: "topic" })).toHaveLength(1); // no silent second creation
  });

  test("explicit refresh coalesces onto an existing pending refresh job", async () => {
    await seedTaggedRecords("主题D", 3);
    const { maintenance } = smart();
    const first = maintenance.controlSubmit({ action: "refresh" })!;
    const second = maintenance.controlSubmit({ action: "refresh" })!;
    expect(second.id).toBe(first.id);
    expect(second.coalesced).toBe(true);
    expect(db.listJobs("pending").filter((j) => j.name === TOPIC_JOB_NAME)).toHaveLength(1);
  });

  test("invalid job data fails; preview never writes config or calls the model", async () => {
    await seedTaggedRecords("主题D", 3);
    const { maintenance, llm } = smart();
    const exec = { signal: new AbortController().signal, checkCancelled: () => {} };
    await expect(maintenance.handle({ action: "explode" }, 0, exec)).rejects.toThrow();
    await expect(maintenance.handle({ action: "enable", candidateKeys: ["a", "b", "c", "d", "e", "f"] }, 0, exec)).rejects.toThrow();
    await runHandle(maintenance, { action: "preview" });
    expect(db.getConfig("topic.enabled")).toBeNull();
    expect(llm.calls).toHaveLength(0);
  });
});

// ─── Write-path integration: NER admission, wikilinks, type inference ──

describe("topic wiki — write-path exclusion", () => {
  const testDir = "/tmp/cbrain-test-topic-writpath";
  const vaultPath = join(testDir, "vault");
  const dbPath = join(testDir, "test.sqlite");

  let db: CBrainDB;
  let pages: PageManager;
  let lance: LanceDBManager;
  let embedding: EmbeddingProvider;
  let nerLlm: LLMProvider & { calls: unknown[] };

  beforeEach(async () => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(join(vaultPath, "brain", "topics"), { recursive: true });
    db = new CBrainDB(dbPath);
    pages = new PageManager(db, vaultPath, noLogger as never);
    lance = new LanceDBManager();
    await lance.connect(join(testDir, "lancedb"));
    embedding = new DeterministicEmbeddingProvider();
    nerLlm = {
      name: "fake-ner-llm",
      calls: [],
      chat: async () => {
        nerLlm.calls.push(1);
        return JSON.stringify({ entities: [], relations: [], events: [], facts: [] });
      },
    } as LLMProvider & { calls: unknown[] };
  });

  afterEach(async () => {
    await lance.close();
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("bare topic type is excluded from NER write-path admission", () => {
    expect(shouldProcessNerForWritePath("正文", "record")).toBe(true);
    expect(shouldProcessNerForWritePath("正文", "entity/person")).toBe(false);
    expect(shouldProcessNerForWritePath("正文", "topic")).toBe(false);
  });

  test("syncAll: managed-path pages emit no NER calls and no wikilink edges; missing frontmatter type infers topic", async () => {
    const entity = pages.create({ title: "组织C", type: "entity/organization", body: "组织C。" });
    const mentionBefore = db.getPage(entity.slug)!.mention_count;

    // A managed-area file that RETYPES itself as record while quoting wiki
    // syntax: the reserved path is a generated surface regardless of the
    // claimed type — no NER, no graph edges, no mention inflation.
    writeFileSync(
      join(vaultPath, "brain/topics/主题d-试.md"),
      `---\ntitle: 主题D试\ntype: record\n---\n\n引用原文："详见 [[组织C]] 的接口说明。"`,
    );
    // A second topic file WITHOUT a frontmatter type must never become a record.
    writeFileSync(
      join(vaultPath, "brain/topics/无类型主题.md"),
      `---\ntitle: 无类型主题\n---\n\n正文没有类型标记。`,
    );

    const sync = new SyncManager(db, embedding, lance, {
      pages,
      nerEngine: new NerEngine(nerLlm),
      logger: noLogger as never,
      nerMode: "sync",
    });
    await sync.syncAll(vaultPath);

    expect(nerLlm.calls).toHaveLength(0);
    const withType = db.getPageByTitle("主题D试")!;
    expect(withType).toBeDefined();
    const withoutType = db.getPageByTitle("无类型主题")!;
    expect(withoutType.type).toBe("topic");
    const edges = db.rawDb.prepare("SELECT COUNT(*) AS c FROM links WHERE from_slug = ?").get(withType.slug) as { c: number };
    expect(edges.c).toBe(0);
    expect(db.getPage(entity.slug)!.mention_count).toBe(mentionBefore);
  });
});
