import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";

// #476: page expiry is deliberate — never inferred from entity type, and blank
// values never count as expired. Covers insert/upsert write paths, the startup
// migration across real close/reopen, and both expiry query methods.

function rawInsertPage(
  db: CBrainDB,
  slug: string,
  type: string,
  title: string,
  expiresAt: string | null,
): void {
  db.rawDb
    .prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(slug, type, title, `${slug}.md`, `hash-${slug}`, expiresAt);
}

function expiresAtOf(db: CBrainDB, slug: string): string | null {
  const row = db.rawDb.prepare("SELECT expires_at FROM pages WHERE slug = ?").get(slug) as {
    expires_at: string | null;
  } | undefined;
  expect(row).toBeDefined();
  return row!.expires_at;
}

describe("page expiry contract (#476)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function openDb(): CBrainDB {
    const dir = mkdtempSync(join(tmpdir(), "cbrain-page-expiry-"));
    dirs.push(dir);
    return new CBrainDB(join(dir, "brain.sqlite"));
  }

  test("insertPage leaves entity pages without expiry NULL and preserves explicit values", () => {
    const db = openDb();
    try {
      db.insertPage({
        slug: "entity/person-a",
        type: "entity/person",
        title: "实体A",
        filePath: "a.md",
        contentHash: "h1",
      });
      db.insertPage({
        slug: "entity/person-b",
        type: "entity/person",
        title: "实体B",
        filePath: "b.md",
        contentHash: "h2",
        expiresAt: null,
      });
      db.insertPage({
        slug: "entity/person-c",
        type: "entity/person",
        title: "实体C",
        filePath: "c.md",
        contentHash: "h3",
        expiresAt: "2020-01-01",
      });
      db.insertPage({
        slug: "entity/person-d",
        type: "entity/person",
        title: "实体D",
        filePath: "d.md",
        contentHash: "h4",
        expiresAt: "2099-01-01",
      });
      db.insertPage({
        slug: "entity/person-e",
        type: "entity/person",
        title: "实体E",
        filePath: "e.md",
        contentHash: "h5",
        expiresAt: "",
      });

      expect(expiresAtOf(db, "entity/person-a")).toBeNull();
      expect(expiresAtOf(db, "entity/person-b")).toBeNull();
      expect(expiresAtOf(db, "entity/person-c")).toBe("2020-01-01");
      expect(expiresAtOf(db, "entity/person-d")).toBe("2099-01-01");
      expect(expiresAtOf(db, "entity/person-e")).toBe("");
    } finally {
      db.close();
    }
  });

  test("upsertPage inserts fresh entity pages without TTL and keeps existing explicit expiry", () => {
    const db = openDb();
    try {
      db.upsertPage({
        slug: "entity/org-a",
        type: "entity/organization",
        title: "组织A",
        filePath: "oa.md",
        contentHash: "h1",
      });
      expect(expiresAtOf(db, "entity/org-a")).toBeNull();

      rawInsertPage(db, "entity/org-b", "entity/organization", "组织B", "2031-01-01");
      db.upsertPage({
        slug: "entity/org-b",
        type: "entity/organization",
        title: "组织B更新",
        filePath: "ob.md",
        contentHash: "h2",
      });
      expect(expiresAtOf(db, "entity/org-b")).toBe("2031-01-01");
    } finally {
      db.close();
    }
  });

  test("unstamped entity pages stay NULL across real CBrainDB close/reopen; explicit dates unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "cbrain-page-expiry-reopen-"));
    dirs.push(dir);
    const dbPath = join(dir, "brain.sqlite");

    let db = new CBrainDB(dbPath);
    try {
      rawInsertPage(db, "entity/old-a", "entity/person", "旧实体A", null);
      rawInsertPage(db, "entity/old-b", "entity/book", "旧条目B", "2033-06-30");
      db.close();

      // Reopen: the startup migration must not stamp unstamped entity pages.
      db = new CBrainDB(dbPath);
      rawInsertPage(db, "entity/new-c", "entity/place", "新地点C", null);
      db.close();

      // Second reopen: pages added between restarts must also stay unstamped.
      db = new CBrainDB(dbPath);
      expect(expiresAtOf(db, "entity/old-a")).toBeNull();
      expect(expiresAtOf(db, "entity/old-b")).toBe("2033-06-30");
      expect(expiresAtOf(db, "entity/new-c")).toBeNull();
    } finally {
      db.close();
    }
  });

  test("getExpiredPages ignores NULL/empty/spaces expiry and keeps real expired entries", () => {
    const db = openDb();
    try {
      rawInsertPage(db, "entity/none", "entity/person", "无期限A", null);
      rawInsertPage(db, "entity/empty", "entity/person", "空值B", "");
      rawInsertPage(db, "entity/space", "entity/person", "空白C", "   ");
      rawInsertPage(db, "entity/past", "entity/person", "过期D", "2020-01-01");
      rawInsertPage(db, "entity/future", "entity/person", "未来E", "2099-01-01");

      const expired = db.getExpiredPages(new Date().toISOString());
      expect(expired.map((p) => p.slug)).toEqual(["entity/past"]);
    } finally {
      db.close();
    }
  });

  test("getExpiringSlugsInSet ignores NULL/empty/spaces expiry, keeps due-soon, drops future", () => {
    const db = openDb();
    try {
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      rawInsertPage(db, "entity/none2", "entity/person", "无期限甲", null);
      rawInsertPage(db, "entity/empty2", "entity/person", "空值乙", "");
      rawInsertPage(db, "entity/space2", "entity/person", "空白丙", "   ");
      rawInsertPage(db, "entity/due2", "entity/person", "将到期丁", tomorrow);
      rawInsertPage(db, "entity/old-exp2", "entity/person", "已过期戊", "2020-01-01");
      rawInsertPage(db, "entity/future2", "entity/person", "未来己", "2099-01-01");

      const expiring = db.getExpiringSlugsInSet(
        ["entity/none2", "entity/empty2", "entity/space2", "entity/due2", "entity/old-exp2", "entity/future2"],
        30,
      );
      expect(expiring.map((p) => p.slug).sort()).toEqual(["entity/due2", "entity/old-exp2"]);
    } finally {
      db.close();
    }
  });
});
