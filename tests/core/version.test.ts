import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { PageManager } from "../../src/core/page.js";
import { VersionManager } from "../../src/core/version.js";

describe("VersionManager", () => {
  const testDir = "/tmp/cbrain-test-version";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let pages: PageManager;
  let vm: VersionManager;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    pages = new PageManager(db, vaultPath);
    vm = new VersionManager(db, pages, vaultPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function createPage(slug: string, title: string, body: string, type = "entity") {
    const relPath = `${slug.replace("/", "-")}.md`;
    const filePath = join(vaultPath, relPath);
    const content = `---\ntitle: "${title}"\ntype: ${type}\n---\n${body}`;
    writeFileSync(filePath, content, "utf-8");

    db.rawDb.prepare(
      `INSERT OR REPLACE INTO pages (slug, type, title, file_path, content_hash)
       VALUES (?, ?, ?, ?, ?)`
    ).run(slug, type, title, relPath, "h1");
  }

  describe("createVersion", () => {
    test("creates a version snapshot for existing page", () => {
      createPage("entities/test", "Test", "Hello world");
      const version = vm.createVersion("entities/test");
      expect(version).toBe(1);
    });

    test("returns null for non-existent page", () => {
      const version = vm.createVersion("entities/ghost");
      expect(version).toBeNull();
    });
  });

  describe("getVersions", () => {
    test("returns empty array when no versions exist", () => {
      const versions = vm.getVersions("entities/test");
      expect(versions).toEqual([]);
    });

    test("lists versions in reverse order", () => {
      createPage("entities/test", "Test", "v1");
      vm.createVersion("entities/test");

      // Update and create another version
      const filePath = join(vaultPath, "entities-test.md");
      writeFileSync(filePath, "---\ntitle: \"Test\"\ntype: entity\n---\nv2", "utf-8");
      db.rawDb.prepare(
        `UPDATE pages SET content_hash = ? WHERE slug = ?`
      ).run("h2", "entities/test");
      vm.createVersion("entities/test");

      const versions = vm.getVersions("entities/test");
      expect(versions.length).toBe(2);
      expect(versions[0].version).toBe(2);
      expect(versions[1].version).toBe(1);
    });
  });

  describe("getVersion", () => {
    test("returns version detail", () => {
      createPage("entities/test", "Test", "Some content");
      vm.createVersion("entities/test");

      const ver = vm.getVersion("entities/test", 1);
      expect(ver).not.toBeNull();
      expect(ver!.version).toBe(1);
      expect(ver!.content).toBe("Some content");
    });

    test("returns null for non-existent version", () => {
      const ver = vm.getVersion("entities/test", 999);
      expect(ver).toBeNull();
    });
  });

  describe("revertToVersion", () => {
    test("reverts page content to an older version", () => {
      createPage("entities/test", "Test", "v1 content");
      vm.createVersion("entities/test");

      // Update file to v2
      const filePath = join(vaultPath, "entities-test.md");
      writeFileSync(filePath, "---\ntitle: \"Test\"\ntype: entity\n---\nv2 content", "utf-8");
      vm.createVersion("entities/test");

      // Revert to v1
      const result = vm.revertToVersion("entities/test", 1);
      expect(result).toBe(true);

      const page = pages.getBySlug("entities/test");
      expect(page).not.toBeNull();
      expect(page!.body).toBe("v1 content");
    });

    test("returns false for non-existent version", () => {
      createPage("entities/test", "Test", "content");
      const result = vm.revertToVersion("entities/test", 999);
      expect(result).toBe(false);
    });

    test("returns false for non-existent page", () => {
      const result = vm.revertToVersion("entities/ghost", 1);
      expect(result).toBe(false);
    });
  });
});
