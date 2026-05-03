import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { PageManager } from "../../src/core/page.js";

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
      type: "entity",
      body: "# 张三\n\n诺华制药东区商务经理。",
      tags: ["人物", "诺华"],
    });

    expect(page.slug).toBe("brain/entities/张三");
    expect(page.title).toBe("张三");
    expect(page.type).toBe("entity");
    expect(page.tier).toBe(3);

    const filePath = join(vaultPath, "brain/entities/张三.md");
    expect(existsSync(filePath)).toBe(true);

    const fileContent = await Bun.file(filePath).text();
    expect(fileContent).toContain("title: 张三");
    expect(fileContent).toContain("诺华制药东区商务经理");
  });

  test("get page by slug reads from vault", () => {
    pm.create({
      title: "第一性原理",
      type: "concept",
      body: "从最基本的事实出发推理。",
      tags: ["方法论"],
    });

    const page = pm.getBySlug("brain/concepts/第一性原理");
    expect(page).not.toBeNull();
    expect(page!.title).toBe("第一性原理");
    expect(page!.body).toContain("从最基本的事实出发推理");
  });

  test("list pages filters by type", () => {
    pm.create({ title: "张三", type: "entity", body: "人物" });
    pm.create({ title: "MVP", type: "concept", body: "最小可行产品" });
    pm.create({ title: "李四", type: "entity", body: "人物2" });

    const entities = pm.list({ type: "entity" });
    expect(entities.length).toBe(2);

    const concepts = pm.list({ type: "concept" });
    expect(concepts.length).toBe(1);
  });

  test("update page modifies vault file and index", async () => {
    // Use brain/ path — raw/ pages are read-only
    pm.create({ title: "测试", type: "concept", body: "原始内容" });
    const created = pm.getBySlug("brain/concepts/测试");
    expect(created).not.toBeNull();

    const updated = pm.update(created!.slug, {
      body: "更新内容",
      tags: ["更新标签"],
    });

    expect(updated).not.toBeNull();
    expect(updated!.body).toBe("更新内容");

    const filePath = join(vaultPath, "brain/concepts/测试.md");
    const fileContent = await Bun.file(filePath).text();
    expect(fileContent).toContain("更新内容");
  });

  test("raw update returns null (read-only)", () => {
    pm.create({ title: "原始", type: "record", body: "不要动" });
    const result = pm.update("raw/records/原始", { body: "动了" });
    expect(result).toBeNull();
  });

  test("delete page removes file and index", () => {
    pm.create({ title: "临时", type: "concept", body: "要删的" });
    const slug = "brain/concepts/临时";

    const filePath = join(vaultPath, "brain/concepts/临时.md");
    expect(existsSync(filePath)).toBe(true);

    const result = pm.delete(slug);
    expect(result).toBe(true);
    expect(existsSync(filePath)).toBe(false);
    expect(pm.getBySlug(slug)).toBeNull();
  });

  test("increment mention count", () => {
    pm.create({ title: "某公司", type: "entity", body: "被提到的公司" });
    pm.incrementMention("brain/entities/某公司");

    const page = pm.getBySlug("brain/entities/某公司");
    expect(page!.mention_count).toBe(1);
  });

  test("merge source into target deletes source, moves links, appends body", () => {
    pm.create({ title: "王强", type: "entity", body: "Source body content." });
    pm.create({ title: "王强-1", type: "entity", body: "Target body content." });

    const sourceSlug = "brain/entities/王强";
    const targetSlug = "brain/entities/王强-1";

    // Add a link from source
    pm.create({ title: "某公司", type: "entity", body: "..." });
    db.prepare("INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)")
      .run(sourceSlug, "brain/entities/某公司", "认识");

    const merged = pm.merge(sourceSlug, targetSlug);
    expect(merged).not.toBeNull();
    expect(merged!.slug).toBe(targetSlug);

    // Source deleted
    expect(pm.getBySlug(sourceSlug)).toBeNull();

    // Target exists with merged body
    expect(merged!.body).toContain("Target body content.");
    expect(merged!.body).toContain("Source body content.");
    expect(merged!.body).toContain("合并自");

    // Link moved from source to target
    const link = db.prepare(
      "SELECT from_slug FROM links WHERE from_slug = ? AND to_slug = ?"
    ).get(targetSlug, "brain/entities/某公司");
    expect(link).toBeDefined();
  });
});
