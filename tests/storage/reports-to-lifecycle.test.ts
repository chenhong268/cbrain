import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";

// Anonymous fixtures — sentinel slugs only, no real names/orgs/paths (#233).
const FROM = "entities/person-alpha";
const MGR_A = "entities/person-beta";
const MGR_B = "entities/person-gamma";

describe("reports_to lifecycle helpers", () => {
  const testDir = "/tmp/cbrain-test-reports-to-lifecycle";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    for (const s of [FROM, MGR_A, MGR_B]) {
      db.rawDb.prepare(
        `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(s, "entity/person", s, `${s}.md`, `h-${s}`, 0, 3);
    }
  });
  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  describe("getActiveReportsToLinks", () => {
    test("returns only non-superseded, non-rejected reports_to edges", () => {
      db.insertLink(FROM, MGR_A, "reports_to", null, 1.0, "strong", "agent", 0.95);
      db.supersedeReportsTo(FROM); // mark A superseded
      db.insertLink(FROM, MGR_B, "reports_to", null, 1.0, "strong", "agent", 0.95); // B active

      const active = db.getActiveReportsToLinks(FROM);
      expect(active).toHaveLength(1);
      expect(active[0].to_slug).toBe(MGR_B);
    });

    test("excludes non-reports_to relations", () => {
      db.insertLink(FROM, MGR_A, "提及", null, 0.3, "weak", "wikilink", 0.9);
      expect(db.getActiveReportsToLinks(FROM)).toHaveLength(0);
    });
  });

  describe("supersedeReportsTo", () => {
    test("marks active reports_to superseded, preserves row + evidence", () => {
      db.insertLink(FROM, MGR_A, "reports_to", null, 1.0, "strong", "agent", 0.95,
        undefined, { source_page_slug: FROM, evidence: "frontmatter-sync" });
      const n = db.supersedeReportsTo(FROM);
      expect(n).toBe(1);

      // Row preserved; trust_state flipped; evidence intact
      const rows = db.rawDb.prepare(
        `SELECT to_slug, trust_state, evidence, source_page_slug FROM links
         WHERE from_slug = ? AND relation = 'reports_to'`,
      ).all(FROM) as Array<{ to_slug: string; trust_state: string; evidence: string; source_page_slug: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].trust_state).toBe("superseded");
      expect(rows[0].evidence).toBe("frontmatter-sync");
      expect(rows[0].source_page_slug).toBe(FROM);
    });

    test("spares exceptToSlug", () => {
      db.insertLink(FROM, MGR_A, "reports_to", null, 1.0, "strong", "agent", 0.95);
      db.insertLink(FROM, MGR_B, "reports_to", null, 1.0, "strong", "agent", 0.95);
      const n = db.supersedeReportsTo(FROM, MGR_B);
      expect(n).toBe(1); // only A superseded
      const active = db.getActiveReportsToLinks(FROM).map((l) => l.to_slug);
      expect(active).toEqual([MGR_B]);
    });

    test("does not touch already-superseded edges (idempotent)", () => {
      db.insertLink(FROM, MGR_A, "reports_to", null, 1.0, "strong", "agent", 0.95);
      db.supersedeReportsTo(FROM);
      const n = db.supersedeReportsTo(FROM); // nothing active
      expect(n).toBe(0);
    });
  });

  describe("upsertActiveReportsTo", () => {
    test("inserts new edge as trusted+active", () => {
      db.upsertActiveReportsTo(FROM, MGR_A, "agent", 0.95, { source_page_slug: FROM });
      const active = db.getActiveReportsToLinks(FROM);
      expect(active).toHaveLength(1);
      expect(active[0].to_slug).toBe(MGR_A);
      expect(active[0].trust_state).toBe("trusted");
      expect(active[0].source_type).toBe("agent");
    });

    test("reactivates an existing superseded row instead of no-op (INSERT OR IGNORE trap)", () => {
      // upsertActiveReportsTo handles ONE edge. The caller (processReportsTo)
      // composes supersede + upsert; here we isolate the reactivation primitive.
      db.upsertActiveReportsTo(FROM, MGR_A, "agent", 0.95, { source_page_slug: FROM });
      db.supersedeReportsTo(FROM); // manager changed away -> A superseded
      expect(db.getActiveReportsToLinks(FROM)).toHaveLength(0);

      // Reactivate the same edge — must UPDATE the existing superseded row,
      // not silently no-op (plain INSERT OR IGNORE would leave it superseded).
      db.upsertActiveReportsTo(FROM, MGR_A, "agent", 0.95, { source_page_slug: FROM });
      const active = db.getActiveReportsToLinks(FROM);
      expect(active).toHaveLength(1);
      expect(active[0].to_slug).toBe(MGR_A);
      expect(active[0].trust_state).toBe("trusted");

      // No duplicate row created
      const cnt = db.rawDb.prepare(
        `SELECT COUNT(*) AS c FROM links WHERE from_slug = ? AND to_slug = ? AND relation = 'reports_to'`,
      ).get(FROM, MGR_A) as { c: number };
      expect(cnt.c).toBe(1);
    });

    test("preserves existing evidence when reactivating unless overridden", () => {
      db.upsertActiveReportsTo(FROM, MGR_A, "agent", 0.95, { evidence: "original-evidence" });
      db.supersedeReportsTo(FROM);
      db.upsertActiveReportsTo(FROM, MGR_A, "agent", 0.95); // no evidence override
      const row = db.rawDb.prepare(
        `SELECT evidence, trust_state FROM links WHERE from_slug = ? AND to_slug = ? AND relation = 'reports_to'`,
      ).get(FROM, MGR_A) as { evidence: string; trust_state: string };
      expect(row.trust_state).toBe("trusted");
      expect(row.evidence).toBe("original-evidence");
    });

    test("refreshes last_validated_at on reactivation (no stale decay)", () => {
      db.upsertActiveReportsTo(FROM, MGR_A, "agent", 0.95, { source_page_slug: FROM });
      // Force a stale last_validated_at, then supersede + reactivate.
      db.rawDb.prepare(
        "UPDATE links SET last_validated_at = '2020-01-01T00:00:00Z' WHERE from_slug = ? AND relation = 'reports_to'",
      ).run(FROM);
      db.supersedeReportsTo(FROM);
      db.upsertActiveReportsTo(FROM, MGR_A, "agent", 0.95, { source_page_slug: FROM });

      const row = db.rawDb.prepare(
        "SELECT last_validated_at FROM links WHERE from_slug = ? AND to_slug = ? AND relation = 'reports_to'",
      ).get(FROM, MGR_A) as { last_validated_at: string };
      expect(row.last_validated_at).not.toBe("2020-01-01T00:00:00Z");
      expect(row.last_validated_at > "2020-01-01").toBe(true);
    });
  });

  describe("non-reports_to regression", () => {
    test("supersedeReportsTo leaves other relations untouched", () => {
      db.insertLink(FROM, MGR_A, "提及", null, 0.3, "weak", "wikilink", 0.9);
      db.insertLink(FROM, MGR_B, "任职", null, 0.5, "medium", "ner", 0.5);
      const n = db.supersedeReportsTo(FROM);
      expect(n).toBe(0);
      const mentions = db.getOutgoingLinks(FROM).filter((l) => l.relation === "提及");
      expect(mentions).toHaveLength(1);
      expect(mentions[0].trust_state).toBe("trusted"); // wikilink -> trusted
    });
  });

  describe("backward compatibility", () => {
    test("legacy rows with NULL trust_state transition cleanly", () => {
      // Simulate a pre-trust_state DB: raw row, trust_state NULL
      db.rawDb.prepare(
        `INSERT INTO links (from_slug, to_slug, relation, weight, strength, source_type, confidence)
         VALUES (?, ?, 'reports_to', 1.0, 'strong', 'agent', 0.95)`,
      ).run(FROM, MGR_A);
      // Active read sees NULL-trust_state rows
      expect(db.getActiveReportsToLinks(FROM)).toHaveLength(1);
      // Supersede transitions NULL -> superseded
      expect(db.supersedeReportsTo(FROM)).toBe(1);
      expect(db.getActiveReportsToLinks(FROM)).toHaveLength(0);
      // Upsert reactivates
      db.upsertActiveReportsTo(FROM, MGR_A, "agent", 0.95);
      expect(db.getActiveReportsToLinks(FROM)).toHaveLength(1);
    });
  });

  describe("getCurrentReportsToLinks (current-fact semantics)", () => {
    test("outgoing: returns only trusted/user_thought/NULL — excludes candidate", () => {
      db.upsertActiveReportsTo(FROM, MGR_A, "agent", 0.95); // trusted
      db.insertLink(FROM, MGR_B, "reports_to", null, 0.5, "weak", "ner", 0.5); // candidate

      const current = db.getCurrentReportsToLinks(FROM, "outgoing");
      expect(current.map((l) => l.to_slug)).toEqual([MGR_A]);
    });

    test("NULL trust_state counts as current (legacy compatibility)", () => {
      // Column has DEFAULT 'candidate', so NULL must be inserted explicitly.
      db.rawDb.prepare(
        `INSERT INTO links (from_slug, to_slug, relation, weight, strength, source_type, confidence, trust_state)
         VALUES (?, ?, 'reports_to', 1.0, 'strong', 'agent', 0.95, NULL)`,
      ).run(FROM, MGR_A);
      expect(db.getCurrentReportsToLinks(FROM, "outgoing")).toHaveLength(1);
    });

    test("incoming: returns only current subordinates (excludes candidate)", () => {
      const SUB = "entities/person-delta";
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(SUB, "entity/person", SUB, `${SUB}.md`, `h-${SUB}`, 0, 3);

      db.upsertActiveReportsTo(FROM, MGR_A, "agent", 0.95); // FROM -> MGR_A trusted
      db.insertLink(SUB, MGR_A, "reports_to", null, 0.5, "weak", "ner", 0.5); // SUB -> MGR_A candidate

      const subs = db.getCurrentReportsToLinks(MGR_A, "incoming");
      expect(subs.map((l) => l.from_slug)).toEqual([FROM]);
    });
  });

  describe("link-count metrics exclude inactive (MEDIUM)", () => {
    test("getLinkCountForSlug excludes superseded/rejected edges", () => {
      db.upsertActiveReportsTo(FROM, MGR_A, "agent", 0.95); // active trusted
      db.rawDb.prepare(
        `INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', 'superseded', 'agent')`,
      ).run(FROM, MGR_B);
      expect(db.getLinkCountForSlug(FROM)).toBe(1); // only the active edge
    });

    test("batchGetLinkCounts excludes superseded/rejected edges", () => {
      db.upsertActiveReportsTo(FROM, MGR_A, "agent", 0.95);
      db.rawDb.prepare(
        `INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', 'rejected', 'agent')`,
      ).run(FROM, MGR_B);
      const counts = db.batchGetLinkCounts([FROM, MGR_A]);
      expect(counts.get(FROM)).toBe(1);
      expect(counts.get(MGR_A)).toBe(1);
    });

    test("getPagesWithLinkCount excludes superseded/rejected from link_count", () => {
      db.upsertActiveReportsTo(FROM, MGR_A, "agent", 0.95);
      db.rawDb.prepare(
        `INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', 'superseded', 'agent')`,
      ).run(FROM, MGR_B);
      const rows = db.getPagesWithLinkCount(["entity/person"]);
      const fromRow = rows.find((r) => r.slug === FROM);
      expect(fromRow?.link_count).toBe(1);
    });

    test("default link-count helpers exclude candidate reports_to but keep ordinary candidate links", () => {
      db.rawDb.prepare(
        `INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', 'candidate', 'ner')`,
      ).run(FROM, MGR_A);
      db.rawDb.prepare(
        `INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'related', 'candidate', 'ner')`,
      ).run(FROM, MGR_B);

      expect(db.getLinkCountBySlug(FROM)).toBe(1);
      expect(db.getLinkCountForSlug(FROM)).toBe(1);
      expect(db.batchGetLinkCounts([FROM]).get(FROM)).toBe(1);
      const rows = db.getPagesWithLinkCount(["entity/person"]);
      expect(rows.find((r) => r.slug === FROM)?.link_count).toBe(1);

      const links = db.getLinksForSlugs([FROM]).get(FROM);
      expect(links?.outgoing).toEqual([MGR_B]);
    });

    test("getLinkCountBySlug excludes superseded/rejected (parity with getLinkCountForSlug)", () => {
      db.upsertActiveReportsTo(FROM, MGR_A, "agent", 0.95);
      db.rawDb.prepare(
        `INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', 'superseded', 'agent')`,
      ).run(FROM, MGR_B);
      expect(db.getLinkCountBySlug(FROM)).toBe(1);
    });

    test("getHighConnectivityEntities excludes superseded/rejected from neighbor count", () => {
      db.upsertActiveReportsTo(FROM, MGR_A, "agent", 0.95);
      db.rawDb.prepare(
        `INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', 'superseded', 'agent')`,
      ).run(FROM, MGR_B);
      // FROM has 1 active neighbor (MGR_A) + 1 superseded (MGR_B). minNeighbors=2 must NOT match.
      const hi = db.getHighConnectivityEntities(2);
      expect(hi.find((r) => r.slug === FROM)).toBeUndefined();
      const hi1 = db.getHighConnectivityEntities(1);
      expect(hi1.find((r) => r.slug === FROM)).toBeDefined();
    });

    test("findEmptyShells treats superseded-only pages as empty shells", () => {
      // ISOLATED has only a superseded edge -> no active connection -> empty shell
      const ISOLATED = "entities/person-epsilon";
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, 'entity/person', ?, ?, ?, 0, 3)`,
      ).run(ISOLATED, ISOLATED, `${ISOLATED}.md`, `h-${ISOLATED}`);
      db.rawDb.prepare(
        `INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', 'superseded', 'agent')`,
      ).run(ISOLATED, MGR_A);

      const shells = db.findEmptyShells();
      expect(shells.find((s) => s.slug === ISOLATED)).toBeDefined();
    });

    test("getLinkCount() total excludes superseded/rejected", () => {
      db.upsertActiveReportsTo(FROM, MGR_A, "agent", 0.95);
      db.rawDb.prepare(
        `INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', 'superseded', 'agent')`,
      ).run(FROM, MGR_B);
      expect(db.getLinkCount()).toBe(1);
    });

    test("linkExists returns false for superseded-only, true once active", () => {
      db.rawDb.prepare(
        `INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', 'superseded', 'agent')`,
      ).run(FROM, MGR_A);
      expect(db.linkExists(FROM, MGR_A, "reports_to")).toBe(false);
      db.upsertActiveReportsTo(FROM, MGR_A, "agent", 0.95);
      expect(db.linkExists(FROM, MGR_A, "reports_to")).toBe(true);
    });

    test("getHotnessStats linkP95 excludes superseded/rejected", () => {
      // FROM has 1 active edge + 1 superseded edge (different target).
      // linkP95 = max active link count per slug. Unfiltered it would be 2.
      db.upsertActiveReportsTo(FROM, MGR_A, "agent", 0.95);
      db.rawDb.prepare(
        `INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', 'superseded', 'agent')`,
      ).run(FROM, MGR_B);
      const stats = db.getHotnessStats();
      expect(stats.linkP95).toBe(1);
    });
  });
});
