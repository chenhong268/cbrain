import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { PageManager } from "../../src/core/page.js";
import { DialogueIngest } from "../../src/core/ingestion/dialogue.js";
import { WritebackManager } from "../../src/core/safety/writeback.js";
import { insertSemanticLink } from "../../src/core/shared.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import type { Logger } from "../../src/core/logger.js";

/**
 * #539: semantic-link entry guard + the two callers that previously accepted a
 * self-edge (dialogue ingest and writeback). Real entry points are exercised;
 * only the LLM extraction result is faked.
 */

function mockLLM(response: string): LLMProvider {
  return {
    name: "mock",
    chat: async () => response,
  };
}

function mockEmbedding(): EmbeddingProvider {
  return {
    dimensions: 8,
    embed: async (text: string) => ({ embedding: new Array(8).fill(0).map((_, i) => text.length + i), tokenCount: text.length }),
    embedBatch: async (texts: string[]) =>
      texts.map((t) => ({ embedding: new Array(8).fill(0).map((_, i) => t.length + i), tokenCount: t.length })),
  };
}

function mockLance(): unknown {
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

describe("#539 semantic link guard (insertSemanticLink)", () => {
  let dir: string;
  let db: CBrainDB;

  const seedPage = (slug: string): void => {
    db.rawDb
      .prepare("INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, NULL)")
      .run(slug, "entity/person", slug, `${slug}.md`);
  };
  const linkRows = (): Array<Record<string, unknown>> =>
    db.rawDb.prepare("SELECT * FROM links ORDER BY id").all() as Array<Record<string, unknown>>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cbrain-539-core-"));
    db = new CBrainDB(join(dir, "test.sqlite"));
    seedPage("entity/a");
    seedPage("entity/b");
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects a self-reference locally without falling through to storage", () => {
    expect(insertSemanticLink(db, "entity/a", "entity/a", "提及", { context: "self", sourceType: "dialogue", confidence: 0.4 })).toBe(false);
    // 下属 carries a reverse relation: a leaked write would leave two rows.
    expect(insertSemanticLink(db, "entity/a", "entity/a", "下属", { sourceType: "dialogue", confidence: 0.4 })).toBe(false);
    expect(linkRows()).toEqual([]);
  });

  test("does not touch an existing historical self-loop row", () => {
    db.rawDb
      .prepare(
        `INSERT INTO links (from_slug, to_slug, relation, context, weight, strength, source_type, confidence, trust_state)
         VALUES ('entity/a', 'entity/a', '提及', 'historical', 0.4, 'weak', 'manual', 0.9, 'trusted')`,
      )
      .run();
    const before = linkRows();
    expect(insertSemanticLink(db, "entity/a", "entity/a", "提及", { sourceType: "dialogue" })).toBe(false);
    expect(linkRows()).toEqual(before);
  });

  test("keeps the existing canonical-duplicate and alias-conflict contracts", () => {
    // Canonical input keeps INSERT OR IGNORE semantics: the key is written once.
    expect(insertSemanticLink(db, "entity/a", "entity/b", "提及", { sourceType: "dialogue" })).toBe(true);
    expect(insertSemanticLink(db, "entity/a", "entity/b", "提及", { sourceType: "dialogue" })).toBe(true);
    expect(linkRows().length).toBe(1);

    // Alias input fails closed when the canonical edge already occupies the key.
    expect(insertSemanticLink(db, "entity/a", "entity/b", "上级", { sourceType: "dialogue" })).toBe(true);
    expect(insertSemanticLink(db, "entity/a", "entity/b", "领导", { sourceType: "dialogue" })).toBe(false);
    expect(linkRows().filter((r) => r.relation === "上级").length).toBe(1);
    expect(linkRows().filter((r) => r.relation === "领导").length).toBe(0);
  });
});

describe("#539 dialogue ingest", () => {
  let dir: string;
  let vaultPath: string;
  let db: CBrainDB;
  const warns: Array<{ module: string; message: string; details?: Record<string, unknown> }> = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cbrain-539-dialogue-"));
    vaultPath = join(dir, "vault");
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(join(dir, "test.sqlite"));
    warns.length = 0;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const fakeLogger = {
    info: () => {},
    warn: (module: string, message: string, details?: Record<string, unknown>) => {
      warns.push({ module, message, details });
    },
    error: () => {},
  } as unknown as Logger;

  test("a self-referential relation is skipped with a fixed reason while a sibling relation still lands", async () => {
    const extraction = JSON.stringify({
      entities: [
        { name: "实体A", type: "person", relevance: "high", context: "实体A与实体B共事" },
        { name: "实体B", type: "person", relevance: "high", context: "实体A与实体B共事" },
      ],
      relations: [
        { from: "实体A", to: "实体A", relation: "同事", context: "实体A与实体A共事" },
        { from: "实体A", to: "实体B", relation: "同事", context: "实体A与实体B共事" },
      ],
      events: [],
    });

    const dialogue = new DialogueIngest(
      db,
      mockEmbedding(),
      mockLance() as never,
      vaultPath,
      mockLLM(extraction),
      fakeLogger,
    );
    const result = await dialogue.ingest("用户：实体A和实体B是同事。");

    expect(result.newEntities).toBe(2);
    // The self-reference contributes no relation and must not inflate the counter.
    expect(result.newRelations).toBe(1);

    const rows = db.rawDb.prepare("SELECT from_slug, to_slug, relation, source_type FROM links ORDER BY id").all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0].from_slug).not.toBe(rows[0].to_slug);
    expect(rows[0].source_type).toBe("dialogue");
    expect(db.rawDb.prepare("SELECT COUNT(*) AS c FROM links WHERE from_slug = to_slug").get()).toEqual({ c: 0 });

    const selfWarns = warns.filter((w) => w.details?.code === "self_reference");
    expect(selfWarns.length).toBe(1);
    expect(selfWarns[0]?.details?.relation).toBe("同事");
  });
});

describe("#539 writeback create_link", () => {
  let dir: string;
  let vaultPath: string;
  let db: CBrainDB;
  let pages: PageManager;
  let writeback: WritebackManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cbrain-539-writeback-"));
    vaultPath = join(dir, "vault");
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(join(dir, "test.sqlite"));
    pages = new PageManager(db, vaultPath);
    writeback = new WritebackManager(pages, db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a self-referential link fails with a fixed reason and leaves body and relations untouched", async () => {
    const pageA = pages.create({ title: "实体A", type: "entity/person", body: "实体A的正文。" });
    const pageB = pages.create({ title: "实体B", type: "entity/person", body: "实体B的正文。" });
    const bodyBefore = pages.getBySlug(pageA.slug)?.body;

    const rejected = await writeback.execute({
      action: "create_link",
      content: "",
      fromSlug: pageA.slug,
      toSlug: pageA.slug,
      relation: "同事",
      source: "query:539",
    });
    expect(rejected.success).toBe(false);
    expect(rejected.error).toBe("self-reference");
    expect(db.rawDb.prepare("SELECT COUNT(*) AS c FROM links").get()).toEqual({ c: 0 });
    expect(pages.getBySlug(pageA.slug)?.body).toBe(bodyBefore);

    // A sibling legal link still succeeds through the same entry point.
    const accepted = await writeback.execute({
      action: "create_link",
      content: "",
      fromSlug: pageA.slug,
      toSlug: pageB.slug,
      relation: "同事",
      source: "query:539",
    });
    expect(accepted.success).toBe(true);
    const rows = db.rawDb.prepare("SELECT from_slug, to_slug, relation, source_type FROM links ORDER BY id").all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0].from_slug).toBe(pageA.slug);
    expect(rows[0].to_slug).toBe(pageB.slug);
    expect(db.rawDb.prepare("SELECT COUNT(*) AS c FROM links WHERE from_slug = to_slug").get()).toEqual({ c: 0 });
    // The failed writeback must not have appended anything to the page file.
    expect(readFileSync(join(vaultPath, pages.getBySlug(pageB.slug)!.file_path), "utf-8")).not.toContain("query:539");
  });
});

describe("#539 page merge with historical loops", () => {
  let dir: string;
  let vaultPath: string;
  let db: CBrainDB;
  let pages: PageManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cbrain-539-merge-"));
    vaultPath = join(dir, "vault");
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(join(dir, "test.sqlite"));
    pages = new PageManager(db, vaultPath);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const injectEdge = (from: string, to: string, context: string): void => {
    db.rawDb
      .prepare("INSERT INTO links (from_slug, to_slug, relation, context) VALUES (?, ?, '同事', ?)")
      .run(from, to, context);
  };

  const edgeKeys = (): string[] =>
    (db.rawDb.prepare("SELECT from_slug, to_slug FROM links ORDER BY id").all() as Array<{ from_slug: string; to_slug: string }>).map(
      (r) => `${r.from_slug}|${r.to_slug}`,
    );

  test("merging two pages that each own a loop completes instead of failing on the unique key", async () => {
    const source = pages.create({ title: "实体A", type: "entity/person", body: "源正文。" });
    const target = pages.create({ title: "实体B", type: "entity/person", body: "目标正文。" });
    injectEdge(source.slug, source.slug, "source history loop");
    injectEdge(target.slug, target.slug, "target history loop");

    const merged = await pages.merge(source.slug, target.slug);

    expect(merged).not.toBeNull();
    expect(edgeKeys()).toEqual([`${target.slug}|${target.slug}`]);
    expect(db.rawDb.prepare("SELECT COUNT(*) AS c FROM links WHERE from_slug = to_slug").get()).toEqual({ c: 1 });
  });

  test("merge keeps the target loop, drops the source loop, and rewires third-party edges", async () => {
    const source = pages.create({ title: "实体A", type: "entity/person", body: "源正文。" });
    const target = pages.create({ title: "实体B", type: "entity/person", body: "目标正文。" });
    const third = pages.create({ title: "实体C", type: "entity/person", body: "第三方正文。" });
    injectEdge(source.slug, source.slug, "source history loop");
    injectEdge(target.slug, target.slug, "target history loop");
    injectEdge(third.slug, source.slug, "third party sees source");
    injectEdge(source.slug, third.slug, "source sees third party");

    const merged = await pages.merge(source.slug, target.slug);

    expect(merged).not.toBeNull();
    expect(edgeKeys()).toEqual([
      `${target.slug}|${target.slug}`,
      `${third.slug}|${target.slug}`,
      `${target.slug}|${third.slug}`,
    ]);
    expect(
      (db.rawDb.prepare("SELECT context FROM links WHERE from_slug = ? AND to_slug = ?").get(target.slug, target.slug) as { context: string }).context,
    ).toBe("target history loop");
    // No surviving edge may still point at the merged-away slug.
    expect(
      db.rawDb.prepare("SELECT COUNT(*) AS c FROM links WHERE from_slug = ? OR to_slug = ?").get(source.slug, source.slug),
    ).toEqual({ c: 0 });
  });
});
