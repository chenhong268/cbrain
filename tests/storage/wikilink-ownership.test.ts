import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";

describe("wikilink mention ownership (#329)", () => {
  let dir: string;
  let db: CBrainDB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cbrain-wikilink-owner-"));
    db = new CBrainDB(join(dir, "brain.sqlite"));
    for (const [slug, title] of [
      ["records/source", "记录A"],
      ["brain/entities/topic-ner", "主题B"],
      ["brain/entities/topic-wiki", "主题C"],
      ["brain/entities/topic-manual", "主题D"],
    ] as const) {
      db.upsertPage({ slug, title, type: slug.startsWith("records/") ? "record" : "entity/concept", filePath: `${slug}.md` });
    }
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("deleting wikilink mentions preserves NER and manual mentions", () => {
    db.insertLink("records/source", "brain/entities/topic-ner", "提及", null, 0.3, "weak", "ner", 0.5);
    db.insertLink("records/source", "brain/entities/topic-wiki", "提及", null, 0.3, "weak", "wikilink", 0.9);
    db.insertLink("records/source", "brain/entities/topic-manual", "提及", null, 1, "strong", "manual", 1);

    db.deleteWikilinkMentions("records/source");

    const links = db.getOutgoingLinks("records/source", true);
    expect(links.map((link) => [link.to_slug, link.source_type])).toEqual([
      ["brain/entities/topic-ner", "ner"],
      ["brain/entities/topic-manual", "manual"],
    ]);
  });

  test("upserting a wikilink promotes an existing NER candidate in place", () => {
    db.insertLink("records/source", "brain/entities/topic-ner", "提及", "旧上下文", 0.3, "weak", "ner", 0.5);

    db.upsertWikilinkMention("records/source", "brain/entities/topic-ner");

    const links = db.getOutgoingLinks("records/source", true);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      to_slug: "brain/entities/topic-ner",
      relation: "提及",
      source_type: "wikilink",
      trust_state: "trusted",
      confidence: 0.9,
      weight: 0.3,
      strength: "weak",
      source_page_slug: "records/source",
    });
  });

  test("upserting a wikilink does not downgrade an existing manual edge", () => {
    db.insertLink("records/source", "brain/entities/topic-manual", "提及", "人工确认", 1, "strong", "manual", 1);

    db.upsertWikilinkMention("records/source", "brain/entities/topic-manual");

    const [link] = db.getOutgoingLinks("records/source", true);
    expect(link).toMatchObject({
      source_type: "manual",
      trust_state: "trusted",
      confidence: 1,
      weight: 1,
      strength: "strong",
      context: "人工确认",
    });
  });
});
