import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CBrainDB } from "../../src/storage/sqlite.js";

/**
 * #539: self-reference rejection at the storage write entries, plus local
 * atomicity of explicit merge rewiring.
 *
 * Full-row comparisons (`SELECT *`, stable ORDER BY id) are used on purpose:
 * comparing only from/to/relation/context cannot show whether the metadata
 * columns survived. Historical self-loops are injected with raw SQL — they
 * must not be reachable through the new guards.
 */
describe("#539 storage write entries", () => {
  let dir: string;
  let db: CBrainDB;

  const SEEDED = ["entity/a", "entity/b", "entity/c", "entity/hub", "entity/n", "entity/o"];

  const seedPage = (slug: string): void => {
    db.rawDb
      .prepare("INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, NULL)")
      .run(slug, "entity", slug, `${slug}.md`);
  };

  const linkRows = (): Array<Record<string, unknown>> =>
    db.rawDb.prepare("SELECT * FROM links ORDER BY id").all() as Array<Record<string, unknown>>;

  const pageRows = (): Array<Record<string, unknown>> =>
    db.rawDb.prepare("SELECT * FROM pages ORDER BY slug").all() as Array<Record<string, unknown>>;

  interface RawLink {
    context?: string | null;
    weight?: number;
    strength?: string;
    source_type?: string;
    confidence?: number;
    source_page_slug?: string | null;
    trust_state?: string | null;
    evidence?: string | null;
    last_validated_at?: string | null;
    effective_weight?: number | null;
  }

  /** Inject a historical row with raw SQL: the new guards must not sit on this path. */
  const injectLink = (from: string, to: string, relation: string, extra: RawLink = {}): void => {
    db.rawDb
      .prepare(
        `INSERT INTO links
          (from_slug, to_slug, relation, context, weight, strength, source_type,
           confidence, source_page_slug, trust_state, evidence, last_validated_at, effective_weight)
         VALUES ($from, $to, $rel, $ctx, $w, $s, $st, $c, $sps, $ts, $ev, $lva, $ew)`,
      )
      .run({
        $from: from,
        $to: to,
        $rel: relation,
        $ctx: extra.context ?? null,
        $w: extra.weight ?? 1.0,
        $s: extra.strength ?? "medium",
        $st: extra.source_type ?? "ner",
        $c: extra.confidence ?? 0.5,
        $sps: extra.source_page_slug ?? null,
        $ts: extra.trust_state ?? "candidate",
        $ev: extra.evidence ?? null,
        $lva: extra.last_validated_at ?? null,
        $ew: extra.effective_weight ?? null,
      });
  };

  const keys = (): string[] =>
    linkRows()
      .map((r) => `${r.from_slug}|${r.to_slug}|${r.relation}`)
      .sort();

  const rowByKey = (from: string, to: string, relation: string): Record<string, unknown> => {
    const row = linkRows().find(
      (r) => r.from_slug === from && r.to_slug === to && r.relation === relation,
    );
    if (!row) throw new Error(`missing row ${from}|${to}|${relation}`);
    return row;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cbrain-539-storage-"));
    db = new CBrainDB(join(dir, "test.sqlite"));
    for (const slug of SEEDED) seedPage(slug);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("insertLink rejects a self-reference before any write: no forward row and no derived reverse row", () => {
    const before = linkRows();
    // 下属 carries a reverse relation (上级), so a leaked write would add two rows.
    expect(db.insertLink("entity/a", "entity/a", "下属")).toBe(false);
    expect(db.insertLink("entity/a", "entity/a", "提及")).toBe(false);
    expect(linkRows()).toEqual(before);
    expect(linkRows().length).toBe(0);
  });

  test("insertLink does not update or delete an existing historical self-loop", () => {
    injectLink("entity/a", "entity/a", "提及", {
      context: "历史自环",
      weight: 0.42,
      strength: "strong",
      source_type: "manual",
      trust_state: "trusted",
      evidence: "ev-539",
      confidence: 0.9,
      source_page_slug: "entity/a",
      effective_weight: 0.31,
      last_validated_at: "2026-01-02 03:04:05",
    });
    injectLink("entity/a", "entity/a", "上级", { context: "历史反向自环" });
    const before = linkRows();

    expect(db.insertLink("entity/a", "entity/a", "提及")).toBe(false);
    expect(db.insertLink("entity/a", "entity/a", "上级")).toBe(false);

    expect(linkRows()).toEqual(before);
  });

  test("upsertWikilinkMention rejects a self-reference and does not downgrade an existing manual loop", () => {
    expect(db.upsertWikilinkMention("entity/a", "entity/a")).toBe(false);
    expect(linkRows()).toEqual([]);

    injectLink("entity/a", "entity/a", "提及", {
      context: "manual context",
      weight: 0.77,
      strength: "strong",
      source_type: "manual",
      trust_state: "trusted",
      confidence: 0.95,
      source_page_slug: "entity/manual-source",
      evidence: "manual-ev",
    });
    const before = linkRows();

    expect(db.upsertWikilinkMention("entity/a", "entity/a")).toBe(false);
    expect(linkRows()).toEqual(before);
    expect(rowByKey("entity/a", "entity/a", "提及").source_type).toBe("manual");
  });

  test("legal edges keep their contracts: new edge, derived reverse, duplicate, and manual ownership", () => {
    expect(db.insertLink("entity/a", "entity/b", "下属")).toBe(true);
    const afterFirst = linkRows();
    expect(keys()).toEqual(["entity/a|entity/b|下属", "entity/b|entity/a|上级"]);

    // Duplicate key is a no-op, not a new edge.
    expect(db.insertLink("entity/a", "entity/b", "下属")).toBe(false);
    expect(linkRows()).toEqual(afterFirst);

    // Wikilink mention: physical first insert reports true, repeat reports false.
    expect(db.upsertWikilinkMention("entity/a", "entity/c")).toBe(true);
    expect(db.upsertWikilinkMention("entity/a", "entity/c")).toBe(false);

    // A manual row still occupies the key and must not be downgraded.
    db.rawDb
      .prepare("UPDATE links SET source_type = 'manual', context = 'curated' WHERE from_slug = 'entity/a' AND to_slug = 'entity/c' AND relation = '提及'")
      .run();
    expect(db.upsertWikilinkMention("entity/a", "entity/c")).toBe(false);
    const manual = rowByKey("entity/a", "entity/c", "提及");
    expect(manual.source_type).toBe("manual");
    expect(manual.context).toBe("curated");
  });

  test("rewireLinks(old === new) is a no-op on rows and page state", () => {
    injectLink("entity/a", "entity/a", "提及", { context: "loop entity/a" });
    injectLink("entity/a", "entity/b", "提及", { context: "see entity/a" });
    injectLink("entity/b", "entity/a", "提及");
    const beforeLinks = linkRows();
    const beforePages = pageRows();

    db.rewireLinks("entity/a", "entity/a");

    expect(linkRows()).toEqual(beforeLinks);
    expect(pageRows()).toEqual(beforePages);
  });

  test("merge collapse: a source history loop plus a target history loop alone must not throw", () => {
    // Minimal live reproduction: with only o→o and n→n present, none of the
    // existence-based pre-deletes matches, so the second UPDATE pushes the
    // rewritten loop onto the occupied n→n key.
    injectLink("entity/o", "entity/o", "提及", { context: "source history loop" });
    injectLink("entity/n", "entity/n", "提及", { context: "target history loop" });

    expect(() => db.rewireLinks("entity/o", "entity/n")).not.toThrow();

    expect(keys()).toEqual(["entity/n|entity/n|提及"]);
    expect(rowByKey("entity/n", "entity/n", "提及").context).toBe("target history loop");
  });

  test("merge collapse: bidirectional same-relation rewiring keeps only the target loop", () => {
    injectLink("entity/o", "entity/n", "提及");
    injectLink("entity/n", "entity/o", "提及");
    injectLink("entity/o", "entity/o", "提及", { context: "source history loop" });
    injectLink("entity/n", "entity/n", "提及", { context: "target history loop" });
    injectLink("entity/c", "entity/c", "提及", { context: "unrelated loop" });

    expect(() => db.rewireLinks("entity/o", "entity/n")).not.toThrow();

    // The collapse set (o→n, n→o, o→o) is dropped; the target loop and the
    // unrelated loop are not in it and must survive exactly once.
    expect(keys()).toEqual([
      "entity/c|entity/c|提及",
      "entity/n|entity/n|提及",
    ]);
    expect(rowByKey("entity/n", "entity/n", "提及").context).toBe("target history loop");
    expect(rowByKey("entity/c", "entity/c", "提及").context).toBe("unrelated loop");
  });

  test("merge rewrite keeps third-party in/out edges with all metadata columns intact", () => {
    injectLink("entity/c", "entity/o", "提及", {
      context: "entity/c sees entity/o",
      weight: 0.6,
      strength: "strong",
      source_type: "ner",
      trust_state: "candidate",
      evidence: "ev-c-o",
      confidence: 0.8,
      effective_weight: 0.55,
      last_validated_at: "2026-02-03 04:05:06",
    });
    injectLink("entity/o", "entity/hub", "提及", {
      context: "entity/o sees entity/hub",
      weight: 0.25,
      strength: "weak",
      source_type: "wikilink",
      trust_state: "trusted",
      evidence: "ev-o-hub",
      confidence: 0.7,
    });
    const beforeIn = rowByKey("entity/c", "entity/o", "提及");
    const beforeOut = rowByKey("entity/o", "entity/hub", "提及");

    db.rewireLinks("entity/o", "entity/n");

    expect(keys()).toEqual(["entity/c|entity/n|提及", "entity/n|entity/hub|提及"]);
    const afterIn = rowByKey("entity/c", "entity/n", "提及");
    const afterOut = rowByKey("entity/n", "entity/hub", "提及");

    const changedIn = Object.keys(afterIn).filter((k) => afterIn[k] !== beforeIn[k]).sort();
    const changedOut = Object.keys(afterOut).filter((k) => afterOut[k] !== beforeOut[k]).sort();
    // Only the rewired endpoint and the context that referenced the old slug may move.
    expect(changedIn).toEqual(["context", "to_slug"]);
    expect(changedOut).toEqual(["context", "from_slug"]);
    expect(afterIn.effective_weight).toBe(0.55);
    expect(afterIn.last_validated_at).toBe("2026-02-03 04:05:06");
    expect(afterOut.id).toBe(beforeOut.id);
  });

  test("merge rewrite is atomic: a mid-operation failure rolls every prior statement back", () => {
    const fixture = (): void => {
      injectLink("entity/o", "entity/c", "提及", { context: "o sees c" });
      injectLink("entity/c", "entity/o", "提及", { context: "c sees o" });
    };
    fixture();

    // Control: without the injection the same fixture is partially rewritten by
    // the from_slug statement before the to_slug statement runs.
    db.rewireLinks("entity/o", "entity/n");
    expect(keys()).toEqual(["entity/c|entity/n|提及", "entity/n|entity/c|提及"]);

    // Reset to the original fixture, then make the to_slug statement fail.
    db.rawDb.prepare("DELETE FROM links").run();
    fixture();
    const before = linkRows();
    db.rawDb.exec(`
      CREATE TRIGGER inject_539_rewire_failure BEFORE UPDATE ON links
      WHEN NEW.to_slug = 'entity/n' AND OLD.to_slug = 'entity/o'
      BEGIN SELECT RAISE(ABORT, 'injected rewire failure'); END;
    `);

    expect(() => db.rewireLinks("entity/o", "entity/n")).toThrow("injected rewire failure");
    expect(linkRows()).toEqual(before);

    db.rawDb.exec("DROP TRIGGER inject_539_rewire_failure");
  });

  test("#508 compensation still restores a historical self-loop snapshot (the guard is not on the restore path)", () => {
    injectLink("entity/a", "entity/a", "提及", {
      context: "historical loop",
      weight: 0.33,
      strength: "weak",
      source_type: "wikilink",
      trust_state: "trusted",
      confidence: 0.9,
      source_page_slug: "entity/a",
      last_validated_at: "2026-03-04 05:06:07",
      effective_weight: 0.3,
    });
    injectLink("entity/a", "entity/b", "提及", { source_type: "wikilink", trust_state: "trusted" });
    const snapshot = db.getOutgoingLinks("entity/a");
    expect(snapshot.length).toBe(2);
    // Recorded boundary: this case asserts the restored edge SET, including the
    // historical self-loop. Full field fidelity is NOT asserted: the snapshot does
    // not project effective_weight / last_validated_at, so those two columns are
    // known to come back NULL (#508 field gap; not fixed this round).
    expect(snapshot.map((l) => l.to_slug).sort()).toEqual(["entity/a", "entity/b"]);

    db.deleteWikilinkMentions("entity/a");
    expect(linkRows()).toEqual([]);

    db.restoreOutgoingMentionLinks("entity/a", snapshot);
    expect(keys()).toEqual(["entity/a|entity/a|提及", "entity/a|entity/b|提及"]);
  });
});
