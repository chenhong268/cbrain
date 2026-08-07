import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";

const PERSON = "brain/entities/person/entity-a";
const ORG_A = "brain/entities/company/org-a";
const ORG_B = "brain/entities/organization/org-b";

describe("organization provenance storage helpers", () => {
  const testDir = "/tmp/cbrain-test-organization-lifecycle";
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(join(testDir, "test.sqlite"));
    seedPage(PERSON, "实体A", "entity/person");
    seedPage(ORG_A, "组织C", "entity/company");
    seedPage(ORG_B, "组织D", "entity/organization");
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function seedPage(slug: string, title: string, type: string): void {
    db?.rawDb.prepare(
      `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(slug, type, title, `${slug}.md`, `hash-${slug}`, 0, 3);
  }

  test("returns all exact title matches instead of arbitrary first row", () => {
    // The production schema normally prevents duplicate titles; keep this
    // resolver test honest by simulating a legacy/corrupt collision.
    db.rawDb.exec("DROP INDEX IF EXISTS idx_pages_title_uniq");
    seedPage("brain/entities/concept/title-collision", "组织C", "concept/topic");
    expect(db.getPagesByExactTitle("组织C").map((row) => row.slug)).toEqual([ORG_A, "brain/entities/concept/title-collision"]);
  });

  test("returns every alias owner for ambiguity checks", () => {
    db.addAlias(ORG_A, "组织别名");
    db.addAlias(ORG_B, "组织别名");
    expect(db.getPagesByAlias("组织别名").map((row) => row.slug)).toEqual([ORG_A, ORG_B]);
  });

  test("upserts one trusted employment edge without reverse or superseding other employment", () => {
    db.upsertTrustedOrganizationEmployment(PERSON, ORG_A, "manual", 0.95, {
      source_page_slug: PERSON,
      evidence: "organization_source:manual",
    });
    db.insertLink(PERSON, ORG_B, "任职", null, 1.0, "strong", "manual", 0.95, true, {
      source_page_slug: PERSON,
      evidence: "other-employment",
    });

    db.upsertTrustedOrganizationEmployment(PERSON, ORG_A, "agent", 0.95, {
      source_page_slug: PERSON,
      evidence: "organization_source:agent",
    });

    const rows = db.getOutgoingLinks(PERSON, true).filter((link) => link.relation === "任职");
    expect(rows).toHaveLength(2);
    const current = rows.find((link) => link.to_slug === ORG_A)!;
    expect(current.trust_state).toBe("trusted");
    expect(current.source_type).toBe("agent");
    expect(current.evidence).toBe("organization_source:agent");
    expect(db.getIncomingLinks(ORG_A, true).filter((link) => link.relation === "任职")).toHaveLength(1);
    expect(db.rawDb.prepare(
      "SELECT COUNT(*) AS count FROM links WHERE from_slug = ? AND to_slug = ? AND relation = '任职'",
    ).get(PERSON, ORG_A)).toEqual({ count: 1 });
  });

  test("refreshes validation timestamp and upgrades candidate in place", () => {
    db.insertLink(PERSON, ORG_A, "任职", null, 0.5, "medium", "ner", 0.5, true, {
      source_page_slug: PERSON,
      evidence: "candidate",
    });
    db.rawDb.prepare(
      "UPDATE links SET last_validated_at = '2020-01-01T00:00:00Z' WHERE from_slug = ? AND to_slug = ? AND relation = '任职'",
    ).run(PERSON, ORG_A);

    db.upsertTrustedOrganizationEmployment(PERSON, ORG_A, "manual", 0.95, {
      source_page_slug: PERSON,
      evidence: "organization_source:manual",
    });

    const row = db.rawDb.prepare(
      "SELECT trust_state, source_type, confidence, last_validated_at FROM links WHERE from_slug = ? AND to_slug = ? AND relation = '任职'",
    ).get(PERSON, ORG_A) as { trust_state: string; source_type: string; confidence: number; last_validated_at: string };
    expect(row.trust_state).toBe("trusted");
    expect(row.source_type).toBe("manual");
    expect(row.confidence).toBe(0.95);
    expect(row.last_validated_at).not.toBe("2020-01-01T00:00:00Z");
  });
});
