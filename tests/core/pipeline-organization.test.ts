import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { ContentPipeline, type OrganizationProjectReason, type OrganizationProjectResult } from "../../src/core/ingestion/pipeline.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

const PERSON = "brain/entities/person/entity-a";
const ORG_A = "brain/entities/company/org-a";
const ORG_B = "brain/entities/organization/org-b";
const WRONG_TARGET = "brain/entities/person/entity-b";

describe("organization provenance projector", () => {
  const testDir = "/tmp/cbrain-test-pipeline-organization";
  let db: CBrainDB;
  let pipeline: ContentPipeline;

  const stubEmbedding: EmbeddingProvider = {
    embed: async () => ({ embedding: [], tokenCount: 0 }),
    embedBatch: async () => [],
    dimensions: 0,
  };

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(join(testDir, "test.sqlite"));
    pipeline = new ContentPipeline(db, stubEmbedding, new LanceDBManager());
    seedPage(PERSON, "实体A", "entity/person");
    seedPage(ORG_A, "组织C", "entity/company");
    seedPage(ORG_B, "组织D", "entity/organization");
    seedPage(WRONG_TARGET, "实体B", "entity/person");
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

  function links() {
    return db.getOutgoingLinks(PERSON, true).filter((link) => link.relation === "任职");
  }

  function project(frontmatter: Record<string, unknown>): OrganizationProjectResult {
    return pipeline.processOrganization(PERSON, frontmatter);
  }

  test("projects a manual organization by canonical slug", () => {
    expect(project({ organization: ORG_A, organization_source: "manual" })).toEqual({ status: "projected" });
    expect(links()).toHaveLength(1);
    expect(links()[0]).toMatchObject({ to_slug: ORG_A, trust_state: "trusted", source_type: "manual" });
  });

  test("uses exact title then unique alias, but rejects ambiguity", () => {
    expect(project({ organization: "组织C", organization_source: "agent" })).toEqual({ status: "projected" });
    expect(links()[0].to_slug).toBe(ORG_A);

    db.rawDb.prepare("DELETE FROM links WHERE from_slug = ? AND relation = '任职'").run(PERSON);
    db.addAlias(ORG_A, "组织别名");
    expect(project({ organization: "组织别名", organization_source: "manual" })).toEqual({ status: "projected" });
    expect(links()).toHaveLength(1);

    db.addAlias(ORG_B, "组织别名");
    expect(project({ organization: "组织别名", organization_source: "manual" })).toEqual({ status: "skipped", reason: "ambiguous_alias" });
    expect(links()).toHaveLength(1);

    db.addAlias(WRONG_TARGET, "错误目标别名");
    expect(project({ organization: "错误目标别名", organization_source: "manual" })).toEqual({ status: "skipped", reason: "invalid_target_type" });
    expect(links()).toHaveLength(1);
  });

  test("fails closed for source, source-page, target-type, self and empty values", () => {
    const cases: Array<[Record<string, unknown>, OrganizationProjectReason]> = [
      [{ organization: ORG_A }, "missing_source"],
      [{ organization: ORG_A, organization_source: "ner" }, "untrusted_source"],
      [{ organization: "", organization_source: "manual" }, "invalid_organization"],
      [{ organization: "missing", organization_source: "manual" }, "target_not_found"],
      [{ organization: WRONG_TARGET, organization_source: "manual" }, "invalid_target_type"],
      [{ organization: PERSON, organization_source: "agent" }, "self_reference"],
    ];
    for (const [frontmatter, reason] of cases) {
      expect(project(frontmatter)).toEqual({ status: "skipped", reason });
      expect(links()).toHaveLength(0);
    }

    db.rawDb.prepare("UPDATE pages SET type = 'record' WHERE slug = ?").run(PERSON);
    expect(project({ organization: ORG_A, organization_source: "manual" })).toEqual({ status: "skipped", reason: "invalid_source_type" });
    expect(links()).toHaveLength(0);
  });

  test("does not upgrade historical or NER organization fields", () => {
    expect(project({ organization: "组织C" })).toEqual({ status: "skipped", reason: "missing_source" });
    expect(project({ organization: ORG_A, organization_source: "ner" })).toEqual({ status: "skipped", reason: "untrusted_source" });
    db.insertLink(PERSON, ORG_A, "任职", null, 0.5, "medium", "ner", 0.5, true);
    expect(links()[0].trust_state).toBe("candidate");
  });

  test("is idempotent and preserves another employment edge", () => {
    db.insertLink(PERSON, ORG_B, "任职", null, 1.0, "strong", "manual", 0.95, true);
    expect(project({ organization: ORG_A, organization_source: "agent" })).toEqual({ status: "projected" });
    const first = links().find((link) => link.to_slug === ORG_A)!;
    db.rawDb.prepare("UPDATE links SET last_validated_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(first.id);
    expect(project({ organization: ORG_A, organization_source: "agent" })).toEqual({ status: "projected" });
    expect(links()).toHaveLength(2);
    const refreshed = links().find((link) => link.to_slug === ORG_A)!;
    expect(refreshed.last_validated_at).not.toBe("2020-01-01T00:00:00Z");
    expect(refreshed.id).toBe(first.id);
  });
});
