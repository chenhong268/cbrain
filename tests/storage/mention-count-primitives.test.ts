import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";

const SOURCE = "records/source-a";
const TARGET = "brain/entities/entity-b";
const OTHER = "brain/entities/entity-c";

function mentionCount(db: CBrainDB, slug: string): number {
  return db.getPage(slug)?.mention_count ?? Number.NaN;
}

/**
 * #508: the storage primitives must let a caller tell a PHYSICAL new row from a
 * conflict update, and must let an attempt reverse exactly what it committed.
 */
describe("#508 mention-count primitives", () => {
  let dir: string;
  let db: CBrainDB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cbrain-508-primitives-"));
    db = new CBrainDB(join(dir, "brain.sqlite"));
    db.upsertPage({ slug: SOURCE, title: "记录A", type: "record", filePath: `${SOURCE}.md` });
    db.upsertPage({ slug: TARGET, title: "实体B", type: "entity/concept", filePath: `${TARGET}.md` });
    db.upsertPage({ slug: OTHER, title: "实体C", type: "entity/concept", filePath: `${OTHER}.md` });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("decrementMentionCount reverses exactly one increment and is not clamped at zero", () => {
    db.incrementMentionCount(TARGET);
    expect(mentionCount(db, TARGET)).toBe(1);

    db.decrementMentionCount(TARGET);
    expect(mentionCount(db, TARGET)).toBe(0);

    // A second reversal must stay observable. A silent clamp at zero would make
    // a double compensation look like a successful one.
    db.decrementMentionCount(TARGET);
    expect(mentionCount(db, TARGET)).toBe(-1);
  });

  test("decrementMentionCount accepts a grouped amount", () => {
    db.incrementMentionCount(TARGET);
    db.incrementMentionCount(TARGET);
    db.incrementMentionCount(TARGET);

    db.decrementMentionCount(TARGET, 2);
    expect(mentionCount(db, TARGET)).toBe(1);
  });

  test("upsertWikilinkMention reports a physical row, not a conflict update", () => {
    expect(db.upsertWikilinkMention(SOURCE, TARGET)).toBe(true);
    expect(db.upsertWikilinkMention(SOURCE, TARGET)).toBe(false);
    expect(db.getOutgoingLinks(SOURCE, true)).toHaveLength(1);
  });

  test("upsertWikilinkMention reports no new row when manual evidence owns the key", () => {
    db.insertLink(SOURCE, TARGET, "提及", "人工确认", 1, "strong", "manual", 1);

    expect(db.upsertWikilinkMention(SOURCE, TARGET)).toBe(false);

    // The manual contract is unaffected: evidence, weight, and strength survive.
    const [link] = db.getOutgoingLinks(SOURCE, true);
    expect(link).toMatchObject({
      to_slug: TARGET,
      source_type: "manual",
      context: "人工确认",
      weight: 1,
      strength: "strong",
    });
  });

  test("linkExists and INSERT OR IGNORE disagree about an inactive row occupying the key", () => {
    db.insertLink(SOURCE, TARGET, "reports_to", null, 0.3, "weak", "ner", 0.5);
    expect(db.supersedeReportsTo(SOURCE)).toBe(1);

    // The row is inactive, so the activity-scoped view says "absent"...
    expect(db.linkExists(SOURCE, TARGET, "reports_to")).toBe(false);

    // ...but the physical row still occupies the unique key, so INSERT OR IGNORE
    // cannot create anything. This is why a physical existence probe — not
    // changes() and not linkExists() — has to decide whether a mention is new.
    expect(db.insertLink(SOURCE, TARGET, "reports_to", null, 0.3, "weak", "ner", 0.5)).toBe(false);
  });

  test("insertLink reports the forward insert only, never the automatic reverse edge", () => {
    const relation = "下属";

    // A forward-only row: the reverse slot (上级) is deliberately still free.
    expect(db.insertLink(SOURCE, TARGET, relation, null, 1, "strong", "manual", 1, true)).toBe(true);

    // The forward statement is IGNOREd while the reverse insert succeeds, so a
    // `changes` read taken AFTER the reverse write would wrongly report success.
    expect(db.insertLink(SOURCE, TARGET, relation, null, 1, "strong", "manual", 1)).toBe(false);
  });

  test("deleteWikilinkMentions leaves non-wikilink evidence in place", () => {
    db.insertLink(SOURCE, TARGET, "提及", null, 0.3, "weak", "ner", 0.5);
    db.insertLink(SOURCE, OTHER, "提及", "人工确认", 1, "strong", "manual", 1);

    db.deleteWikilinkMentions(SOURCE);

    expect(db.getOutgoingLinks(SOURCE, true).map((link) => [link.to_slug, link.source_type])).toEqual([
      [TARGET, "ner"],
      [OTHER, "manual"],
    ]);
  });
});
