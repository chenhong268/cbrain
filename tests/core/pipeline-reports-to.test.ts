import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { ContentPipeline } from "../../src/core/pipeline.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

describe("processReportsTo", () => {
  const testDir = "/tmp/cbrain-test-reports-to";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let pipeline: ContentPipeline;

  // Minimal stubs — processReportsTo only uses db
  const stubEmbedding: EmbeddingProvider = {
    embed: async () => ({ embedding: [], tokenCount: 0 }),
    embedBatch: async () => [],
    dimensions: 0,
  };
  const stubLance = new LanceDBManager();

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    pipeline = new ContentPipeline(db, stubEmbedding, stubLance);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function seedPage(slug: string, title: string, type: string) {
    db.rawDb.prepare(
      `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(slug, type, title, `${slug}.md`, `hash-${slug}`, 0, 3);
  }

  test("creates graph link from frontmatter reports_to", () => {
    seedPage("brain/entities/person/person-a", "人物甲", "entity/person");
    seedPage("brain/entities/person/person-b", "人物乙", "entity/person");

    pipeline.processReportsTo("brain/entities/person/person-a", {
      reports_to: "brain/entities/person/person-b",
    });

    const links = db.getOutgoingLinks("brain/entities/person/person-a");
    const reportsLink = links.find((l) => l.relation === "reports_to");
    expect(reportsLink).toBeDefined();
    expect(reportsLink!.to_slug).toBe("brain/entities/person/person-b");
    expect(reportsLink!.source_type).toBe("agent");
    expect(reportsLink!.confidence).toBe(0.95);
  });

  test("skips when reports_to is missing", () => {
    seedPage("brain/entities/person/person-a", "人物甲", "entity/person");
    pipeline.processReportsTo("brain/entities/person/person-a", {});
    const links = db.getOutgoingLinks("brain/entities/person/person-a");
    expect(links.filter((l) => l.relation === "reports_to")).toHaveLength(0);
  });

  test("skips when reports_to target does not exist", () => {
    seedPage("brain/entities/person/person-a", "人物甲", "entity/person");
    // No person-b seeded
    pipeline.processReportsTo("brain/entities/person/person-a", {
      reports_to: "brain/entities/person/person-b",
    });
    const links = db.getOutgoingLinks("brain/entities/person/person-a");
    expect(links.filter((l) => l.relation === "reports_to")).toHaveLength(0);
  });

  test("skips when reports_to is self-referential", () => {
    seedPage("brain/entities/person/person-a", "人物甲", "entity/person");
    pipeline.processReportsTo("brain/entities/person/person-a", {
      reports_to: "brain/entities/person/person-a",
    });
    const links = db.getOutgoingLinks("brain/entities/person/person-a");
    expect(links.filter((l) => l.relation === "reports_to")).toHaveLength(0);
  });

  test("replaces stale link when reports_to changes", () => {
    seedPage("brain/entities/person/person-a", "人物甲", "entity/person");
    seedPage("brain/entities/person/person-b", "人物乙", "entity/person");
    seedPage("brain/entities/person/person-c", "人物丙", "entity/person");

    // First set
    pipeline.processReportsTo("brain/entities/person/person-a", {
      reports_to: "brain/entities/person/person-b",
    });
    let links = db.getOutgoingLinks("brain/entities/person/person-a");
    expect(links.find((l) => l.relation === "reports_to")!.to_slug).toBe("brain/entities/person/person-b");

    // Change
    pipeline.processReportsTo("brain/entities/person/person-a", {
      reports_to: "brain/entities/person/person-c",
    });
    links = db.getOutgoingLinks("brain/entities/person/person-a");
    const reportsLinks = links.filter((l) => l.relation === "reports_to");
    expect(reportsLinks).toHaveLength(1);
    expect(reportsLinks[0].to_slug).toBe("brain/entities/person/person-c");
  });

  test("idempotent — duplicate calls do not create duplicate links", () => {
    seedPage("brain/entities/person/person-a", "人物甲", "entity/person");
    seedPage("brain/entities/person/person-b", "人物乙", "entity/person");

    pipeline.processReportsTo("brain/entities/person/person-a", {
      reports_to: "brain/entities/person/person-b",
    });
    pipeline.processReportsTo("brain/entities/person/person-a", {
      reports_to: "brain/entities/person/person-b",
    });

    const links = db.getOutgoingLinks("brain/entities/person/person-a");
    expect(links.filter((l) => l.relation === "reports_to")).toHaveLength(1);
  });
});
