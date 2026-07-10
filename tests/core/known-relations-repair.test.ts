import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairKnownRelations } from "../../src/core/maintenance/known-relations-repair.js";
import { PageManager } from "../../src/core/page.js";
import { CBrainDB } from "../../src/storage/sqlite.js";

describe("repairKnownRelations (#323)", () => {
  let root: string;
  let db: CBrainDB;
  let pages: PageManager;
  let slugA: string;
  let slugB: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cbrain-kr-repair-"));
    db = new CBrainDB(join(root, "brain.sqlite"));
    pages = new PageManager(db, root);
    slugA = pages.create({ slug: "entity/a", title: "实体A", type: "entity/person", body: "正文A", tags: [] }).slug;
    slugB = pages.create({ slug: "entity/b", title: "实体B", type: "entity/person", body: "正文B", tags: [] }).slug;
    db.insertLink(slugA, slugB, "协作", null, 1, "strong", "manual", 0.9);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const content = (slug: string) => {
    const page = db.getPage(slug)!;
    return readFileSync(join(root, page.file_path), "utf8");
  };

  test("dry-run reports a bounded batch and writes nothing", () => {
    const beforeA = content(slugA);
    const beforeB = content(slugB);
    const result = repairKnownRelations({ db, pages, vaultPath: root, execute: false, limit: 1 });

    expect(result.candidates).toBe(2);
    expect(result.selected).toBe(1);
    expect(result.remaining).toBe(1);
    expect(result.repaired).toBe(0);
    expect(content(slugA)).toBe(beforeA);
    expect(content(slugB)).toBe(beforeB);
  });

  test("execute repairs at most limit and converges idempotently", () => {
    const first = repairKnownRelations({ db, pages, vaultPath: root, execute: true, limit: 1 });
    expect(first.repaired).toBe(1);
    expect(first.remaining).toBe(1);
    expect([content(slugA), content(slugB)].filter((body) => body.includes("## Known Relations"))).toHaveLength(1);

    const second = repairKnownRelations({ db, pages, vaultPath: root, execute: true, limit: 1 });
    expect(second.repaired).toBe(1);
    expect(second.remaining).toBe(0);
    const third = repairKnownRelations({ db, pages, vaultPath: root, execute: true, limit: 1 });
    expect(third.candidates).toBe(0);
    expect(third.repaired).toBe(0);
  });

  test("candidate reports_to is never projected", () => {
    db.rawDb.prepare("DELETE FROM links").run();
    db.insertLink(slugA, slugB, "reports_to", null, 1, "strong", "ner", 0.5);
    db.rawDb.prepare("UPDATE links SET trust_state='candidate'").run();

    const result = repairKnownRelations({ db, pages, vaultPath: root, execute: true, limit: 10 });
    expect(result.candidates).toBe(0);
    expect(content(slugA)).not.toContain("Known Relations");
    expect(content(slugB)).not.toContain("Known Relations");
  });

  test("one write failure is isolated and does not stop the next page", () => {
    const syncSlug = (slug: string) => {
      if (slug === slugA) throw new Error("private path detail");
      pages.syncLinksToMarkdown(slug);
    };
    const result = repairKnownRelations({ db, pages, vaultPath: root, execute: true, limit: 2, syncSlug });
    expect(result.failed).toBe(1);
    expect(result.repaired).toBe(1);
    expect(JSON.stringify(result)).not.toContain(slugA);
    expect(JSON.stringify(result)).not.toContain("private path");
  });

  test("post-write verification uses current links, not the scan snapshot", () => {
    const syncSlug = (slug: string) => {
      db.rawDb.prepare("DELETE FROM links").run();
      pages.syncLinksToMarkdown(slug);
    };
    const result = repairKnownRelations({ db, pages, vaultPath: root, execute: true, limit: 1, syncSlug });
    expect(result.repaired).toBe(1);
    expect(result.failed).toBe(0);
  });
});
