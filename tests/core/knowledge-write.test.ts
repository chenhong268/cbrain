import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { PageManager } from "../../src/core/page.js";
import { ContentPipeline } from "../../src/core/pipeline.js";
import { GraphManager } from "../../src/core/graph.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import { addKnowledge, resolveOrCreate, type KnowledgeWriteDeps } from "../../src/core/knowledge-write.js";

describe("add_knowledge", () => {
  const testDir = "/tmp/cbrain-test-knowledge-write";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let pages: PageManager;
  let deps: KnowledgeWriteDeps;

  const stubEmbedding: EmbeddingProvider = {
    embed: async () => ({ embedding: [], tokenCount: 0 }),
    embedBatch: async () => [],
    dimensions: 0,
  };

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    pages = new PageManager(db, vaultPath);
    const lance = new LanceDBManager();
    const pipeline = new ContentPipeline(db, stubEmbedding, lance);
    const graph = new GraphManager(db);
    deps = { db, pages, pipeline, graph };
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function seedEntity(slug: string, title: string, type: string, body = "") {
    const filePath = `${slug}.md`;
    const fullPath = join(vaultPath, filePath);
    mkdirSync(join(vaultPath, ...slug.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(fullPath, `---\ntitle: "${title}"\ntype: ${type}\nslug: ${slug}\n---\n${body}`);
    db.rawDb.prepare(
      `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(slug, type, title, filePath, `hash-${slug}`, 0, 3);
  }

  // ── resolveOrCreate ─────────────────────────────────────

  test("resolves existing entity by slug", () => {
    seedEntity("brain/entities/person/ren-wu-a", "人物A", "entity/person");
    const result = resolveOrCreate("brain/entities/person/ren-wu-a", "person", deps, false);
    expect(result.action).toBe("resolved");
    expect(result.slug).toBe("brain/entities/person/ren-wu-a");
  });

  test("resolves existing entity by title", () => {
    seedEntity("brain/entities/person/ren-wu-a", "人物A", "entity/person");
    const result = resolveOrCreate("人物A", "person", deps, false);
    expect(result.action).toBe("resolved");
    expect(result.slug).toBe("brain/entities/person/ren-wu-a");
  });

  test("creates stub for unknown entity", () => {
    const result = resolveOrCreate("人物B", "person", deps, false);
    expect(result.action).toBe("stub_created");
    expect(result.slug).toContain("entities/person");
    // Verify page exists
    const page = pages.getBySlug(result.slug);
    expect(page).not.toBeNull();
    expect(page!.title).toBe("人物B");
  });

  test("dry_run predicts slug without creating", () => {
    const result = resolveOrCreate("人物C", "person", deps, true);
    expect(result.action).toBe("would_create_stub");
    expect(result.slug).toContain("entities/person");
    // Verify page was NOT created
    const page = pages.getBySlug(result.slug);
    expect(page).toBeNull();
  });

  test("record type falls back to entity/person", () => {
    const result = resolveOrCreate("测试人物", "record", deps, false);
    expect(result.action).toBe("stub_created");
    expect(result.slug).toContain("entities/person");
    // Verify it's NOT a record
    const page = pages.getBySlug(result.slug);
    expect(page!.type).not.toBe("record");
  });

  test("unknown type falls back to entity/person", () => {
    const result = resolveOrCreate("测试人物", "nonexistent_type", deps, false);
    expect(result.action).toBe("stub_created");
    expect(result.slug).toContain("entities/person");
  });

  // ── Hierarchy ────────────────────────────────────────────

  test("sets hierarchy via setHierarchy", async () => {
    seedEntity("brain/entities/person/a", "人物A", "entity/person");
    seedEntity("brain/entities/person/b", "人物B", "entity/person");
    const result = await addKnowledge({
      subject: "人物A",
      hierarchy: { reports_to: "人物B" },
    }, deps);
    expect(result.summary.succeeded).toBe(1);
    expect(result.applied[0].type).toBe("hierarchy");
    expect(result.applied[0].success).toBe(true);
    // Verify frontmatter
    const page = pages.getBySlug("brain/entities/person/a");
    expect(page!.frontmatter.reports_to).toBe("brain/entities/person/b");
  });

  test("hierarchy self-reference fails", async () => {
    seedEntity("brain/entities/person/a", "人物A", "entity/person");
    const result = await addKnowledge({
      subject: "人物A",
      hierarchy: { reports_to: "人物A" },
    }, deps);
    expect(result.applied[0].success).toBe(false);
    expect(result.applied[0].error).toContain("自己");
  });

  // ── Relations ────────────────────────────────────────────

  test("agent/dialogue source_type creates candidate (not trusted) link", async () => {
    seedEntity("brain/entities/person/a", "人物A", "entity/person");
    seedEntity("brain/entities/company/corp", "组织D", "entity/company");
    // agent
    await addKnowledge({
      subject: "人物A",
      relations: [{ target: "组织D", relation: "任职" }],
      source_type: "agent",
    }, deps);
    let links = db.getOutgoingLinks("brain/entities/person/a", true);
    expect(links[0].trust_state).toBe("candidate");
    // dialogue
    db.deleteLink("brain/entities/person/a", "brain/entities/company/corp", "任职");
    await addKnowledge({
      subject: "人物A",
      relations: [{ target: "组织D", relation: "合作" }],
      source_type: "dialogue",
    }, deps);
    links = db.getOutgoingLinks("brain/entities/person/a", true);
    const coopLink = links.find(l => l.relation === "合作");
    expect(coopLink!.trust_state).toBe("candidate");
  });

  test("creates graph link between entities", async () => {
    seedEntity("brain/entities/person/a", "人物A", "entity/person");
    seedEntity("brain/entities/company/corp", "组织D", "entity/company");
    const result = await addKnowledge({
      subject: "人物A",
      relations: [{ target: "组织D", relation: "任职" }],
    }, deps);
    expect(result.summary.succeeded).toBe(1);
    expect(result.applied[0].success).toBe(true);
    // Verify link
    const links = db.getOutgoingLinks("brain/entities/person/a");
    const workLink = links.find(l => l.relation === "任职");
    expect(workLink).toBeDefined();
    expect(workLink!.source_type).toBe("agent");
    expect(workLink!.confidence).toBe(0.9);
  });

  test("relation with evidence stores provenance", async () => {
    seedEntity("brain/entities/person/a", "人物A", "entity/person");
    seedEntity("brain/entities/person/b", "人物B", "entity/person");
    await addKnowledge({
      subject: "人物A",
      relations: [{ target: "人物B", relation: "认识" }],
      evidence: "对话中用户明确说明",
      source_type: "dialogue",
    }, deps);
    const links = db.getOutgoingLinks("brain/entities/person/a");
    const link = links.find(l => l.relation === "认识");
    expect(link).toBeDefined();
    expect(link!.evidence).toBe("对话中用户明确说明");
    expect(link!.source_type).toBe("dialogue");
  });

  test("self-referencing relation is rejected", async () => {
    seedEntity("brain/entities/person/a", "人物A", "entity/person");
    const result = await addKnowledge({
      subject: "人物A",
      relations: [{ target: "人物A", relation: "认识" }],
    }, deps);
    expect(result.applied[0].success).toBe(false);
    expect(result.applied[0].error).toContain("self");
  });

  // ── Fields ───────────────────────────────────────────────

  test("writes field to empty frontmatter", async () => {
    seedEntity("brain/entities/person/a", "人物A", "entity/person");
    const result = await addKnowledge({
      subject: "人物A",
      facts: [{ field: "current_title", value: "产品总监" }],
    }, deps);
    expect(result.applied[0].success).toBe(true);
    const page = pages.getBySlug("brain/entities/person/a");
    expect(page!.frontmatter.current_title).toBe("产品总监");
  });

  test("field conflict — does not overwrite existing value", async () => {
    seedEntity("brain/entities/person/a", "人物A", "entity/person");
    // Set initial value
    pages.update("brain/entities/person/a", { extra: { current_title: "工程师" } });
    const result = await addKnowledge({
      subject: "人物A",
      facts: [{ field: "current_title", value: "产品总监" }],
    }, deps);
    expect(result.applied[0].success).toBe(false);
    expect(result.applied[0].error).toContain("already has value");
    // Original value unchanged
    const page = pages.getBySlug("brain/entities/person/a");
    expect(page!.frontmatter.current_title).toBe("工程师");
  });

  test("reserved field is rejected", async () => {
    seedEntity("brain/entities/person/a", "人物A", "entity/person");
    const result = await addKnowledge({
      subject: "人物A",
      facts: [{ field: "slug", value: "hacked-slug" }],
    }, deps);
    expect(result.applied[0].success).toBe(false);
    expect(result.applied[0].error).toContain("reserved");
    // Verify original slug unchanged
    const page = pages.getBySlug("brain/entities/person/a");
    expect(page).not.toBeNull();
  });

  test("reserved field 'type' is rejected", async () => {
    seedEntity("brain/entities/person/a", "人物A", "entity/person");
    const result = await addKnowledge({
      subject: "人物A",
      facts: [{ field: "type", value: "concept/topic" }],
    }, deps);
    expect(result.applied[0].success).toBe(false);
    expect(result.applied[0].error).toContain("reserved");
  });

  // ── Notes ────────────────────────────────────────────────

  test("appends note to entity body", async () => {
    seedEntity("brain/entities/person/a", "人物A", "entity/person", "Initial bio");
    const result = await addKnowledge({
      subject: "人物A",
      note: "本周完成了Q3 OKR评审",
    }, deps);
    expect(result.applied[0].success).toBe(true);
    const page = pages.getBySlug("brain/entities/person/a");
    expect(page!.body).toContain("Q3 OKR评审");
    expect(page!.body).toContain("Initial bio");
  });

  // ── Dry Run ──────────────────────────────────────────────

  test("dry_run returns plan without writing", async () => {
    seedEntity("brain/entities/person/a", "人物A", "entity/person");
    const result = await addKnowledge({
      subject: "人物A",
      relations: [{ target: "人物G", relation: "认识" }],
      note: "一条备注",
      mode: "dry_run",
    }, deps);
    expect(result.mode).toBe("dry_run");
    expect(result.stubs_created).toHaveLength(0);
    // New entity should NOT be created
    const newEntity = db.getEntitySlugByTitle("人物G");
    expect(newEntity).toBeNull();
    // No link should exist
    const links = db.getOutgoingLinks("brain/entities/person/a");
    expect(links).toHaveLength(0);
    // Plan should list planned operations
    expect(result.applied.length).toBeGreaterThanOrEqual(2);
  });

  test("dry_run marks reserved field as failed", async () => {
    seedEntity("brain/entities/person/a", "人物A", "entity/person");
    const result = await addKnowledge({
      subject: "人物A",
      facts: [
        { field: "slug", value: "hacked" },
        { field: "current_title", value: "工程师" },
      ],
      mode: "dry_run",
    }, deps);
    expect(result.applied).toHaveLength(2);
    expect(result.applied[0].success).toBe(false);
    expect(result.applied[0].error).toContain("reserved");
    expect(result.applied[1].success).toBe(true);
    expect(result.summary.failed).toBe(1);
    expect(result.summary.succeeded).toBe(1);
  });

  // ── Error Isolation ──────────────────────────────────────

  test("relation failure does not block other operations", async () => {
    seedEntity("brain/entities/person/a", "人物A", "entity/person");
    const result = await addKnowledge({
      subject: "人物A",
      relations: [{ target: "人物A", relation: "认识" }], // self-ref → fails
      facts: [{ field: "current_title", value: "工程师" }],
    }, deps);
    // Field should succeed even though relation failed
    expect(result.summary.succeeded).toBe(1);
    expect(result.summary.failed).toBe(1);
    expect(result.applied.find(a => a.type === "field")!.success).toBe(true);
    expect(result.applied.find(a => a.type === "relation")!.success).toBe(false);
  });

  // ── Integration: full pipeline ───────────────────────────

  test("creates stub + sets hierarchy + adds relation + field in one call", async () => {
    seedEntity("brain/entities/person/manager", "人物E", "entity/person");
    const result = await addKnowledge({
      subject: "人物F",
      subject_type: "person",
      hierarchy: { reports_to: "人物E" },
      relations: [{ target: "组织D", target_type: "company", relation: "任职" }],
      facts: [{ field: "current_title", value: "高级工程师" }],
      note: "刚入职，分配到华东区团队",
      source_type: "dialogue",
      evidence: "用户在对话中介绍",
    }, deps);

    expect(result.summary.succeeded).toBe(4);
    expect(result.stubs_created.length).toBeGreaterThanOrEqual(2); // 人物F + 组织D

    // Verify hierarchy
    const subjectPage = db.getEntitySlugByTitle("人物F");
    expect(subjectPage).not.toBeNull();
    const page = pages.getBySlug(subjectPage!);
    expect(page!.frontmatter.reports_to).toBe("brain/entities/person/manager");
    expect(page!.frontmatter.current_title).toBe("高级工程师");
    expect(page!.body).toContain("华东区团队");
  });
});
