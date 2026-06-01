import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { PageManager } from "../../src/core/page.js";
import { WritebackManager } from "../../src/core/writeback.js";

let db: CBrainDB;
let pages: PageManager;
let writeback: WritebackManager;
let vaultPath: string;

beforeEach(() => {
  const tmp = mkdtempSync(join(tmpdir(), "cbrain-wb-"));
  vaultPath = join(tmp, "vault");
  mkdirSync(vaultPath, { recursive: true });
  db = new CBrainDB(join(tmp, "test.sqlite"));
  pages = new PageManager(db, vaultPath);
  writeback = new WritebackManager(pages, db);
});

describe("WritebackManager", () => {
  test("append insight to existing page", async () => {
    const page = pages.create({
      title: "Test Entity",
      type: "entity",
      body: "Original content.",
    });

    const result = await writeback.execute({
      action: "append",
      targetSlug: page.slug,
      content: "New insight discovered.",
      source: "query:test",
    });

    expect(result.success).toBe(true);
    expect(result.action).toBe("append");
    expect(result.slug).toBe(page.slug);

    const updated = pages.getBySlug(page.slug);
    expect(updated!.body).toContain("Original content.");
    expect(updated!.body).toContain("New insight discovered.");
    expect(updated!.body).toContain("Source: query:test");
  });

  test("append fails for missing targetSlug", async () => {
    const result = await writeback.execute({
      action: "append",
      content: "No target.",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("targetSlug required");
  });

  test("append fails for nonexistent page", async () => {
    const result = await writeback.execute({
      action: "append",
      targetSlug: "nonexistent",
      content: "Ghost content.",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Page not found");
  });

  test("create new concept page", async () => {
    const result = await writeback.execute({
      action: "create_concept",
      conceptTitle: "First Principles Thinking",
      content: "Break complex problems into fundamental truths.",
      source: "query:principles",
    });

    expect(result.success).toBe(true);
    expect(result.action).toBe("create_concept");
    expect(result.slug).toBeDefined();

    const page = pages.getBySlug(result.slug!);
    expect(page).not.toBeNull();
    expect(page!.title).toBe("First Principles Thinking");
    expect(page!.type).toBe("concept/concept");
    expect(page!.frontmatter.tags).toContain("agent-derived");
  });

  test("create_concept fails without title", async () => {
    const result = await writeback.execute({
      action: "create_concept",
      content: "No title concept.",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("conceptTitle required");
  });

  test("create link between two pages", async () => {
    const pageA = pages.create({
      title: "Alice",
      type: "entity",
      body: "A person.",
    });
    const pageB = pages.create({
      title: "Acme Corp",
      type: "entity",
      body: "A company.",
    });

    const result = await writeback.execute({
      action: "create_link",
      content: "",
      fromSlug: pageA.slug,
      toSlug: pageB.slug,
      relation: "works_at",
      source: "query:employees",
    });

    expect(result.success).toBe(true);

    const links = db.rawDb.prepare("SELECT * FROM links WHERE from_slug = ? AND to_slug = ?").all(pageA.slug, pageB.slug);
    expect(links.length).toBe(1);
    expect((links[0] as any).relation).toBe("任职");
  });

  test("create_link fails with missing params", async () => {
    const result = await writeback.execute({
      action: "create_link",
      content: "",
      fromSlug: "a",
      relation: "knows",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("required");
  });

  test("create_link fails for nonexistent source", async () => {
    const pageB = pages.create({
      title: "Bob",
      type: "entity",
      body: "B person.",
    });

    const result = await writeback.execute({
      action: "create_link",
      content: "",
      fromSlug: "ghost",
      toSlug: pageB.slug,
      relation: "knows",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Source page not found");
  });

  test("unknown action returns error", async () => {
    const result = await writeback.execute({
      action: "explode" as any,
      content: "boom",
    });
    expect(result.success).toBe(false);
  });
});
