import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { PageManager } from "../../src/core/page.js";
import type { LanceDBManager } from "../../src/storage/lancedb.js";

describe("PageManager", () => {
  const testDir = "/tmp/cbrain-test-pages";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let pm: PageManager;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    pm = new PageManager(db, vaultPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("create page writes file and indexes in SQLite", async () => {
    const page = pm.create({
      title: "张三",
      type: "entity/person",
      body: "# 张三\n\n星辰科技东区商务经理。",
      tags: ["人物", "星辰"],
    });

    expect(page.slug).toBe("brain/entities/person/张三");
    expect(page.title).toBe("张三");
    expect(page.type).toBe("entity/person");
    expect(page.tier).toBe(3);

    const filePath = join(vaultPath, "brain/entities/person/张三.md");
    expect(existsSync(filePath)).toBe(true);

    const fileContent = await Bun.file(filePath).text();
    expect(fileContent).toContain("title: 张三");
    expect(fileContent).toContain("星辰科技东区商务经理");
  });

  test("get page by slug reads from vault", () => {
    pm.create({
      title: "第一性原理",
      type: "concept/concept",
      body: "从最基本的事实出发推理。",
      tags: ["方法论"],
    });

    const page = pm.getBySlug("brain/concepts/concept/第一性原理");
    expect(page).not.toBeNull();
    expect(page!.title).toBe("第一性原理");
    expect(page!.body).toContain("从最基本的事实出发推理");
  });

  test("list pages filters by type", () => {
    pm.create({ title: "张三", type: "entity/person", body: "人物" });
    pm.create({ title: "MVP", type: "concept/concept", body: "最小可行产品" });
    pm.create({ title: "李四", type: "entity/person", body: "人物2" });

    const entities = pm.list({ type: "entity/person" });
    expect(entities.length).toBe(2);

    const concepts = pm.list({ type: "concept/concept" });
    expect(concepts.length).toBe(1);
  });

  test("update page modifies vault file and index", async () => {
    // Use brain/ path — raw/ pages are read-only
    pm.create({ title: "测试", type: "concept/concept", body: "原始内容" });
    const created = pm.getBySlug("brain/concepts/concept/测试");
    expect(created).not.toBeNull();

    const updated = pm.update(created!.slug, {
      body: "更新内容",
      tags: ["更新标签"],
    });

    expect(updated).not.toBeNull();
    expect(updated!.body).toBe("更新内容");

    const filePath = join(vaultPath, "brain/concepts/concept/测试.md");
    const fileContent = await Bun.file(filePath).text();
    expect(fileContent).toContain("更新内容");
  });

  test("raw update returns null (read-only)", () => {
    pm.create({ title: "原始", type: "record", body: "不要动" });
    const result = pm.update("raw/records/原始", { body: "动了" });
    expect(result).toBeNull();
  });

  test("delete page removes file and index", async () => {
    pm.create({ title: "临时", type: "concept/concept", body: "要删的" });
    const slug = "brain/concepts/concept/临时";

    const filePath = join(vaultPath, "brain/concepts/concept/临时.md");
    expect(existsSync(filePath)).toBe(true);

    const result = await pm.delete(slug);
    expect(result).toBe(true);
    expect(existsSync(filePath)).toBe(false);
    expect(pm.getBySlug(slug)).toBeNull();
  });

  test("delete cleans up LanceDB vectors", async () => {
    const deletedSlugs: string[] = [];
    const lanceMock = {
      deleteByPageSlug: mock(async (slug: string) => { deletedSlugs.push(slug); }),
    } as unknown as LanceDBManager;
    const pmWithLance = new PageManager(db, vaultPath, undefined, lanceMock);
    pmWithLance.create({ title: "临时", type: "concept/concept", body: "要删的" });
    const slug = "brain/concepts/concept/临时";

    const result = await pmWithLance.delete(slug);

    expect(result).toBe(true);
    expect(deletedSlugs).toEqual([slug]);
  });

  test("create refuses when vault file exists without DB row (orphan)", () => {
    // Simulate an orphan: vault file on disk but no DB row
    const { writeFileSync } = require("node:fs");
    const slug = "records/orphan-test";
    const filePath = join(vaultPath, "records/orphan-test.md");
    const originalContent = "# Orphan\n\nThis file has no DB row.";

    mkdirSync(join(vaultPath, "records"), { recursive: true });
    writeFileSync(filePath, originalContent, "utf-8");

    // create() must refuse to overwrite
    expect(() =>
      pm.create({ title: "Orphan Test", type: "record", body: "New content" })
    ).toThrow(/orphan/i);

    // File must remain byte-identical
    const fileContent = require("node:fs").readFileSync(filePath, "utf-8");
    expect(fileContent).toBe(originalContent);

    // No DB row created
    expect(db.getPage(slug)).toBeNull();
  });

  test("increment mention count", () => {
    pm.create({ title: "某公司", type: "entity/person", body: "被提到的公司" });
    pm.incrementMention("brain/entities/person/某公司");

    const page = pm.getBySlug("brain/entities/person/某公司");
    expect(page!.mention_count).toBe(1);
  });

  test("merge source into target deletes source, moves links, appends body", async () => {
    pm.create({ title: "王强", type: "entity/person", body: "Source body content." });
    pm.create({ title: "王强-1", type: "entity/person", body: "Target body content." });

    const sourceSlug = "brain/entities/person/王强";
    const targetSlug = "brain/entities/person/王强-1";

    // Add a link from source
    pm.create({ title: "某公司", type: "entity/person", body: "..." });
    db.rawDb.prepare("INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)")
      .run(sourceSlug, "brain/entities/person/某公司", "认识");

    const merged = await pm.merge(sourceSlug, targetSlug);
    expect(merged).not.toBeNull();
    expect(merged!.slug).toBe(targetSlug);

    // Source deleted
    expect(pm.getBySlug(sourceSlug)).toBeNull();

    // Target exists with merged body
    expect(merged!.body).toContain("Target body content.");
    expect(merged!.body).toContain("Source body content.");
    expect(merged!.body).toContain("合并自");

    // Link moved from source to target
    const link = db.rawDb.prepare(
      "SELECT from_slug FROM links WHERE from_slug = ? AND to_slug = ?"
    ).get(targetSlug, "brain/entities/person/某公司");
    expect(link).toBeDefined();
  });

  test("merge cleans up source LanceDB vectors", async () => {
    const deletedSlugs: string[] = [];
    const lanceMock = {
      deleteByPageSlug: mock(async (slug: string) => { deletedSlugs.push(slug); }),
    } as unknown as LanceDBManager;
    const pmWithLance = new PageManager(db, vaultPath, undefined, lanceMock);
    pmWithLance.create({ title: "源", type: "entity/person", body: "Source." });
    pmWithLance.create({ title: "目标", type: "entity/person", body: "Target." });

    const sourceSlug = "brain/entities/person/源";
    const targetSlug = "brain/entities/person/目标";

    const merged = await pmWithLance.merge(sourceSlug, targetSlug);

    expect(merged).not.toBeNull();
    expect(merged!.slug).toBe(targetSlug);
    expect(deletedSlugs).toEqual([sourceSlug]);
  });

  // ── patch() tests ──────────────────────────────────────────

  test("patch appends body to existing page", () => {
    const page = pm.create({ title: "笔记", type: "record", body: "原始内容", tags: ["旧标签"] });

    const patched = pm.patch(page.slug, { body_append: "追加内容" });
    expect(patched).not.toBeNull();
    expect(patched!.body).toContain("原始内容");
    expect(patched!.body).toContain("追加内容");
    // Appended content should come after original
    expect(patched!.body.indexOf("原始内容")).toBeLessThan(patched!.body.indexOf("追加内容"));
  });

  test("patch merges tags (union, dedup)", () => {
    const page = pm.create({ title: "笔记", type: "record", body: "内容", tags: ["旧标签", "共有"] });

    const patched = pm.patch(page.slug, { tags_merge: ["新标签", "共有"] });
    expect(patched).not.toBeNull();
    const tags = (patched!.frontmatter.tags as string[]).sort();
    expect(tags).toEqual(["共有", "新标签", "旧标签"].sort());
  });

  test("patch updates frontmatter fields via extra", () => {
    const page = pm.create({ title: "张三", type: "entity/person", body: "信息" });

    const patched = pm.patch(page.slug, { extra: { reports_to: "brain/entities/person/李四", confidence: 0.9 } });
    expect(patched).not.toBeNull();
    expect(patched!.frontmatter.reports_to).toBe("brain/entities/person/李四");
    expect(patched!.frontmatter.confidence).toBe(0.9);
    // Body should not change when only extra is provided
    expect(patched!.body).toContain("信息");
  });

  test("patch strips Known Relations before appending", () => {
    const page = pm.create({ title: "实体", type: "entity/person", body: "正文" });

    // Simulate a Known Relations section
    pm.update(page.slug, { body: "正文\n\n## Known Relations\n\n- 认识 → [[某人]]\n" });

    const patched = pm.patch(page.slug, { body_append: "追加信息" });
    expect(patched).not.toBeNull();
    // Old KR section should be stripped (syncLinksToMarkdown would rebuild it)
    expect(patched!.body).not.toContain("## Known Relations");
    expect(patched!.body).toContain("正文");
    expect(patched!.body).toContain("追加信息");
  });

  test("delete with Lance failure still commits and returns true (repair-required)", async () => {
    const failLance = {
      deleteByPageSlug: mock(async () => { throw new Error("lance boom"); }),
    } as unknown as LanceDBManager;
    const pmFail = new PageManager(db, vaultPath, undefined, failLance);
    pmFail.create({ title: "Alpha", type: "concept/concept", body: "to delete" });
    const slug = "brain/concepts/concept/alpha";

    const result = await pmFail.delete(slug);

    expect(result).toBe(true); // source-of-truth delete committed despite Lance failure
    expect(pmFail.getBySlug(slug)).toBeNull();
    // Recovery audit recorded.
    const pending = JSON.parse(db.getConfig("page_delete.lance_pending") ?? "[]") as string[];
    expect(pending).toContain(slug);
  });
});
