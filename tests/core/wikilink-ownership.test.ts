import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import { ContentPipeline } from "../../src/core/ingestion/pipeline.js";
import { PageManager } from "../../src/core/page.js";
import { CBrainDB } from "../../src/storage/sqlite.js";

const embedding: EmbeddingProvider = {
  embed: async () => ({ embedding: [], tokenCount: 0 }),
  embedBatch: async () => [],
  dimensions: 0,
};

describe("wikilink replacement ownership (#329)", () => {
  let dir: string;
  let db: CBrainDB;
  let pipeline: ContentPipeline;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cbrain-wikilink-pipeline-"));
    db = new CBrainDB(join(dir, "brain.sqlite"));
    const pages = new PageManager(db, join(dir, "vault"));
    pipeline = new ContentPipeline(db, embedding, {} as never, { pages });

    for (const [slug, title] of [
      ["records/source", "记录A"],
      ["brain/entities/ner-survives", "主题B"],
      ["brain/entities/stale-wikilink", "主题C"],
      ["brain/entities/manual", "主题D"],
      ["brain/entities/promoted", "主题E"],
      ["brain/entities/dialogue", "主题F"],
      ["brain/entities/new-wikilink", "主题G"],
    ] as const) {
      db.upsertPage({
        slug,
        title,
        type: slug.startsWith("records/") ? "record" : "entity/concept",
        filePath: `${slug}.md`,
      });
    }

    db.insertLink("records/source", "brain/entities/ner-survives", "提及", null, 0.3, "weak", "ner", 0.5);
    db.insertLink("records/source", "brain/entities/stale-wikilink", "提及", null, 0.3, "weak", "wikilink", 0.9);
    db.insertLink("records/source", "brain/entities/manual", "提及", "人工确认", 1, "strong", "manual", 1);
    db.insertLink("records/source", "brain/entities/promoted", "提及", null, 0.3, "weak", "ner", 0.5);
    db.insertLink("records/source", "brain/entities/dialogue", "提及", null, 0.4, "medium", "dialogue", 0.7);
    db.insertLink("records/source", "brain/entities/ner-survives", "相关", null, 0.8, "strong", "agent", 0.8);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("replaces only wikilink-owned mentions and promotes explicit same-edge evidence", () => {
    const result = pipeline.replaceWikilinks(
      "records/source",
      "继续保留 [[主题D]]，提升 [[主题E]]，并新增 [[主题G]]。",
    );

    expect(result.count).toBe(3);
    const links = db.getOutgoingLinks("records/source", true);
    const mentions = new Map(
      links.filter((link) => link.relation === "提及").map((link) => [link.to_slug, link]),
    );

    expect(mentions.has("brain/entities/stale-wikilink")).toBe(false);
    expect(mentions.get("brain/entities/ner-survives")?.source_type).toBe("ner");
    expect(mentions.get("brain/entities/dialogue")?.source_type).toBe("dialogue");
    expect(mentions.get("brain/entities/manual")).toMatchObject({
      source_type: "manual",
      context: "人工确认",
      weight: 1,
      confidence: 1,
    });
    expect(mentions.get("brain/entities/promoted")).toMatchObject({
      source_type: "wikilink",
      trust_state: "trusted",
      confidence: 0.9,
    });
    expect(mentions.get("brain/entities/new-wikilink")).toMatchObject({
      source_type: "wikilink",
      trust_state: "trusted",
    });
    expect(links.some((link) => link.relation === "相关")).toBe(true);
  });
});
