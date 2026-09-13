import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import { PageManager } from "../../src/core/page.js";
import { ContentPipeline } from "../../src/core/ingestion/pipeline.js";
import { NerEngine } from "../../src/core/ingestion/ner.js";
import { runNerBackfillStage } from "../../src/core/ingestion/ner-backfill.js";
import { DeterministicEmbeddingProvider } from "../../src/embedding/deterministic.js";

/**
 * #511 Task 3 — execution-time NER admission on the CURRENT DB page.
 * Submit-site guards cannot establish execution-time admission: a legacy
 * queued NER job for a record whose file now lives under the managed topic
 * path must make ZERO model calls and ZERO edges, while an ordinary record
 * job in the same stage still backfills normally.
 */
describe("deferred NER execution gate for managed topic paths (#511 Task 3)", () => {
  let root: string;
  let vault: string;
  let db: CBrainDB;
  let lance: LanceDBManager;
  let modelCalls: number;

  beforeEach(async () => {
    root = mkdtempSync("/tmp/cbrain-test-topic-ner-gate-");
    vault = join(root, "vault");
    mkdirSync(vault, { recursive: true });
    db = new CBrainDB(join(root, "brain.sqlite"));
    lance = new LanceDBManager();
    await lance.connect(join(root, "lance"));
    modelCalls = 0;
  });

  afterEach(async () => {
    await lance.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** Queue a legacy pending {slug} job (no sourceFingerprint — the exact
   *  pre-existing payload shape), optionally move the record's file under the
   *  managed topic path like a stray/legacy placement would leave behind. */
  const seedQueuedRecord = (managed: boolean) => {
    const pages = new PageManager(db, vault, undefined, lance);
    const target = pages.create({ title: "匿名实体甲", type: "entity/person", body: "匿名实体甲是本测试中的人物。" });
    const source = pages.create({
      title: "匿名记录乙",
      type: "record",
      body: "匿名记录乙完整记载：匿名实体甲参与了主题D的讨论，并提出了一个明确的观察。",
    });
    const id = db.submitJob("ner-backfill", { slug: source.slug });
    expect(db.getJob(id)?.status).toBe("pending");
    expect(JSON.parse(db.getJob(id)!.data!)).toEqual({ slug: source.slug });
    if (managed) {
      const managedPath = "brain/topics/anonymous-derived.md";
      mkdirSync(dirname(join(vault, managedPath)), { recursive: true });
      renameSync(join(vault, source.file_path), join(vault, managedPath));
      db.rawDb.prepare("UPDATE pages SET file_path = ? WHERE slug = ?").run(managedPath, source.slug);
      expect(db.getPage(source.slug)?.type).toBe("record");
      expect(db.getPage(source.slug)?.file_path).toBe(managedPath);
    }
    return { targetSlug: target.slug, sourceSlug: source.slug, jobId: id };
  };

  const runStage = async () => {
    const llm = {
      name: "anonymous-ner-fixture",
      chat: async () => {
        modelCalls++;
        return JSON.stringify({
          entities: [{ name: "匿名实体甲", type: "person", relevance: "high", context: "参与主题D讨论" }],
          relations: [],
          events: [],
        });
      },
    };
    const freshPages = new PageManager(db, vault, undefined, lance);
    const pipeline = new ContentPipeline(db, new DeterministicEmbeddingProvider(), lance, {
      pages: freshPages,
      nerEngine: new NerEngine(llm),
    });
    const counts = await runNerBackfillStage(db, pipeline, freshPages, { maxItems: 1 });
    return { counts, edges: db.getAllLinks().length };
  };

  test("ordinary record backfill still calls the model and makes the edge", async () => {
    const { targetSlug, sourceSlug, jobId } = seedQueuedRecord(false);
    const { counts } = await runStage();
    expect(modelCalls).toBeGreaterThan(0);
    expect(db.getAllLinks().some((l) => l.from_slug === sourceSlug && l.to_slug === targetSlug)).toBe(true);
    expect(counts.processed).toBe(1);
    expect(db.getJob(jobId)?.status).toBe("done");
  });

  test("queued record now under brain/topics: zero model calls, zero edges", async () => {
    const { targetSlug, sourceSlug, jobId } = seedQueuedRecord(true);
    const { counts } = await runStage();
    expect(modelCalls).toBe(0);
    expect(db.getAllLinks().some((l) => l.from_slug === sourceSlug && l.to_slug === targetSlug)).toBe(false);
    expect(db.getJob(jobId)?.status).toBe("done");
    expect(counts.processed).toBe(1);
  });
});
