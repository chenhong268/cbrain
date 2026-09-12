import { hasKnownRelationsDrift } from "../../src/core/graph/known-relations-projector.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import { ContentPipeline } from "../../src/core/ingestion/pipeline.js";
import { IngestManager } from "../../src/core/ingestion/ingest.js";
import { JobQueueNerSubmitter, runNerBackfillStage } from "../../src/core/ingestion/ner-backfill.js";
import { NerEngine, type ExtractionResult } from "../../src/core/ingestion/ner.js";
import { PageManager } from "../../src/core/page.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import { CBrainDB } from "../../src/storage/sqlite.js";

const embedding: EmbeddingProvider = {
  dimensions: 4,
  embed: async () => ({ embedding: [0, 0, 0, 0], tokenCount: 1 }),
  embedBatch: async (texts) => texts.map(() => ({ embedding: [0, 0, 0, 0], tokenCount: 1 })),
};

function createLanceStub() {
  return {
    addChunks: async () => {},
    readRawVectorRows: async () => [],
    readL1VectorRows: async () => [],
    deleteRawChunksByPageSlug: async () => {},
    deleteL1VectorByPageSlug: async () => {},
    deleteByPageSlug: async () => {},
  };
}

/** Semantic-resolution LLM that never matches (keeps stub/duplicate outcomes intact). */
const noMatchLlm: LLMProvider = {
  name: "anonymous-provider",
  chat: async () => '{"matches":[]}',
};

function snapshotVault(vaultPath: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const walk = (abs: string, rel: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(abs, entry.name), childRel);
      else files.set(childRel, readFileSync(join(abs, entry.name)));
    }
  };
  walk(vaultPath, "");
  return files;
}

describe("entity title collision (#467)", () => {
  let dir: string;
  let vaultPath: string;
  let db: CBrainDB;
  let pages: PageManager;
  let pipeline: ContentPipeline;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cbrain-467-collision-"));
    vaultPath = join(dir, "vault");
    db = new CBrainDB(join(dir, "brain.sqlite"));
    pages = new PageManager(db, vaultPath);
    pipeline = new ContentPipeline(db, embedding, createLanceStub() as never, {
      pages,
      nerEngine: new NerEngine(noMatchLlm),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const extraction = (
    entities: ExtractionResult["entities"],
    relations: ExtractionResult["relations"] = [],
    facts: ExtractionResult["facts"] = [],
  ): ExtractionResult => ({ entities, relations, events: [], facts, filtered: [] });

  const pagesByTitle = (title: string): Array<{ slug: string; type: string }> =>
    db.rawDb.prepare("SELECT slug, type FROM pages WHERE title = ?").all(title) as Array<{ slug: string; type: string }>;

  test("same-extraction names sharing a canonical slug reuse one stub without partial failure", async () => {
    const source = pages.create({ title: "匿名记录甲", type: "record", body: "实体A及实体A®均出现在这条记录中。" });
    const result = await pipeline.processNer(source.slug, source.body, "record", true, extraction([
      { name: "实体A", type: "drug", relevance: "high", context: "匿名资料" },
      { name: "实体A®", type: "drug", relevance: "high", context: "匿名资料" },
    ]));
    const targets = db.rawDb.prepare("SELECT slug FROM pages WHERE type='entity/drug'").all() as Array<{ slug: string }>;
    expect(targets).toHaveLength(1);
    expect(result?.resolvedSlugs).toEqual([targets[0].slug]);
    const mentions = db.rawDb.prepare("SELECT to_slug FROM links WHERE from_slug=? AND relation='提及'").all(source.slug);
    expect(mentions).toEqual([{ to_slug: targets[0].slug }]);
    expect(pages.getBySlug(targets[0].slug)?.title).toBe("实体A");
  });

  test("canonical slug occupied by a different title retains its body and type", async () => {
    const source = pages.create({ title: "匿名记录甲", type: "record", body: "匿名来源正文" });
    const occupied = pages.create({ slug: "brain/entities/drug/实体a", title: "实体B", type: "entity/drug", body: "已有正文必须保留。" });
    const before = readFileSync(join(vaultPath, occupied.file_path));
    const result = await pipeline.processNer(source.slug, source.body, "record", true, extraction([
      { name: "实体A", type: "drug", relevance: "high", context: "匿名资料" },
    ]));
    expect(result?.resolvedSlugs).toEqual([occupied.slug]);
    expect(readFileSync(join(vaultPath, occupied.file_path))).toEqual(before);
    expect(pages.getBySlug(occupied.slug)?.type).toBe("entity/drug");
    expect(pagesByTitle("实体A")).toEqual([]);
    expect(db.getSlugByAlias("实体A")).toBeNull();
  });

  test("insight same-title deferred extraction completes and preserves the occupier", async () => {
    const source = pages.create({ title: "匿名记录甲", type: "record", body: "本次讨论主题甲的应用及其与组织丙的关系。" });
    const insight = pages.create({ title: "主题甲", type: "insight", body: "这是必须保留的已有洞察正文。" });
    const org = pages.create({ title: "组织丙", type: "entity/organization", body: "匿名组织介绍。" });

    const beforeVault = snapshotVault(vaultPath);
    const sourceBody = pages.getBySlug(source.slug)?.body ?? "";

    const result = await pipeline.processNer(
      source.slug,
      sourceBody,
      "record",
      true,
      extraction(
        [
          { name: "主题甲", type: "concept", relevance: "high", context: "知识主题" },
          { name: "组织丙", type: "organization", relevance: "high", context: "研究组织" },
        ],
        [{ from: "主题甲", to: "组织丙", relation: "提及", context: "组织研究该主题" }],
        [{ entity: "主题甲", field: "industry", value: "匿名行业", confidence: 0.9, evidence: "匿名原文" }],
      ),
      new Set(),
      undefined,
      false,
    );

    // Occupier preserved: type, body, frontmatter bytes — no fact write, no overwrite.
    expect(pagesByTitle("主题甲")).toEqual([{ slug: insight.slug, type: "insight" }]);
    expect(db.getEntityType(insight.slug)).toBe("insight");
    expect(pages.getBySlug(insight.slug)?.body).toBe("这是必须保留的已有洞察正文。");
    expect(snapshotVault(vaultPath)).toEqual(beforeVault);

    // Candidate reference exists: source record links to the occupier; entity exact routing intact.
    const mentionLinks = db.rawDb.prepare(
      "SELECT to_slug FROM links WHERE from_slug = ? AND to_slug IN (?, ?) AND relation = '提及'",
    ).all(source.slug, insight.slug, org.slug) as Array<{ to_slug: string }>;
    expect(mentionLinks.map((l) => l.to_slug).sort()).toEqual([insight.slug, org.slug].sort());

    // Extraction relation written with the occupier as endpoint.
    const relationLink = db.rawDb.prepare(
      "SELECT * FROM links WHERE from_slug = ? AND to_slug = ?",
    ).get(insight.slug, org.slug) as { relation: string } | undefined;
    expect(relationLink?.relation).toBe("提及");
    expect(result?.relations).toBe(1);
  });

  test("source page's own title extracted → no self-link, no new page, source unchanged", async () => {
    const source = pages.create({ title: "源记录", type: "record", body: "记录自身命名的正文。" });
    const beforeVault = snapshotVault(vaultPath);
    const sourceBody = pages.getBySlug(source.slug)?.body ?? "";

    await pipeline.processNer(
      source.slug,
      sourceBody,
      "record",
      true,
      extraction([{ name: "源记录", type: "concept", relevance: "high", context: "自身标题" }]),
      new Set(),
      undefined,
      false,
    );

    expect(pagesByTitle("源记录")).toEqual([{ slug: source.slug, type: "record" }]);
    expect(db.getEntityType(source.slug)).toBe("record");
    expect(pages.getBySlug(source.slug)?.body).toBe("记录自身命名的正文。");
    expect(snapshotVault(vaultPath)).toEqual(beforeVault);

    const selfLinks = db.rawDb.prepare(
      "SELECT * FROM links WHERE from_slug = ? AND to_slug = ?",
    ).all(source.slug, source.slug) as unknown[];
    expect(selfLinks).toHaveLength(0);
  });

  test("entity exact routing and unoccupied stub creation unchanged", async () => {
    const existing = pages.create({ title: "李工", type: "entity/person", body: "已有人员。" });
    const source = pages.create({ title: "另一记录", type: "record", body: "提到李工与新人物。" });
    const sourceBody = pages.getBySlug(source.slug)?.body ?? "";

    await pipeline.processNer(
      source.slug,
      sourceBody,
      "record",
      true,
      extraction([
        { name: "李工", type: "person", relevance: "high", context: "人员" },
        { name: "新人物", type: "person", relevance: "high", context: "新出现" },
      ]),
      new Set(),
      undefined,
      false,
    );

    expect(pagesByTitle("李工")).toEqual([{ slug: existing.slug, type: "entity/person" }]);
    const stub = pagesByTitle("新人物");
    expect(stub).toHaveLength(1);
    expect(stub[0].type).toBe("entity/person");
    const stubTags = db.rawDb.prepare(
      "SELECT tag FROM tags WHERE page_slug = ?",
    ).all(stub[0].slug) as Array<{ tag: string }>;
    expect(stubTags.map((t) => t.tag)).toContain("auto-extracted");
  });

  test("deferred ner-backfill job completes processed on insight title collision", async () => {
    const seed = new IngestManager(
      db, embedding, createLanceStub() as never, vaultPath, undefined, undefined, { nerMode: "off" },
    );
    const source = await seed.ingest({
      type: "text",
      content: "讨论主题甲的匿名记录正文。",
      title: "记录A",
      skipNer: true,
    });
    const insight = pages.create({ title: "主题甲", type: "insight", body: "必须保留的洞察正文。" });
    const beforeVault = snapshotVault(vaultPath);
    expect(new JobQueueNerSubmitter(db).submitDeferredNer({ slug: source.slug }).pending).toBe(true);

    const workingLlm: LLMProvider = {
      name: "anonymous-provider",
      chat: async () => JSON.stringify({
        entities: [{ name: "主题甲", type: "concept", relevance: "high", context: "知识主题" }],
        relations: [],
        events: [],
      }),
    };
    const working = new ContentPipeline(db, embedding, createLanceStub() as never, {
      pages,
      nerEngine: new NerEngine(workingLlm),
    });

    const counts = await runNerBackfillStage(db, working, pages);

    expect(counts.processed).toBe(1);
    expect(counts.failed).toBe(0);
    expect(counts.timed_out).toBe(0);
    const [job] = db.listJobs("done");
    expect(JSON.parse(job.result ?? "{}").outcome).toBe("processed");

    expect(pagesByTitle("主题甲")).toEqual([{ slug: insight.slug, type: "insight" }]);
    expect(snapshotVault(vaultPath)).toEqual(beforeVault);
    const mentionLink = db.rawDb.prepare(
      "SELECT * FROM links WHERE from_slug = ? AND to_slug = ? AND relation = '提及'",
    ).get(source.slug, insight.slug) as { to_slug: string } | undefined;
    expect(mentionLink?.to_slug).toBe(insight.slug);
  });
  test("governed type move projects existing neighbors absent from extraction", async () => {
    const source = pages.create({ title: "来源D", type: "record", body: "主题A参与匿名记录" });
    const old = pages.create({ title: "主题A", type: "concept/concept", body: "主题A匿名正文" });
    const neighbor = pages.create({ title: "主题B", type: "concept/concept", body: "主题B匿名正文" });
    db.insertLink(neighbor.slug, old.slug, "提及", null, 0.9, "strong", "manual", 0.95);
    pages.syncAffectedSlugs([old.slug, neighbor.slug]);
    const result = await pipeline.processNer(source.slug, source.body, "record", true, extraction([
      { name: "主题A", type: "model", relevance: "high", context: "匿名" },
    ]), new Set(), () => {}, true);
    expect(result?.resolvedSlugs).not.toContain(old.slug);
    const links = db.getAllLinks();
    const content = readFileSync(join(vaultPath, neighbor.file_path), "utf8");
    expect(hasKnownRelationsDrift(content, links.filter(l => l.from_slug === neighbor.slug), links.filter(l => l.to_slug === neighbor.slug))).toBe(false);
  });
});
