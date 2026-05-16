import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import { PageManager } from "../../src/core/page.js";

function createMockEmbedding() {
  return {
    dimensions: 128,
    embed: async (text: string) => ({
      embedding: new Array(128).fill(0).map((_, i) => (text.charCodeAt(i % text.length) ?? 0) / 65536),
      tokenCount: text.length,
    }),
    embedBatch: async (texts: string[]) =>
      texts.map((t) => ({
        embedding: new Array(128).fill(0).map((_, i) => (t.charCodeAt(i % t.length) ?? 0) / 65536),
        tokenCount: t.length,
      })),
  };
}

function createMockLanceDB() {
  return {
    connect: async () => {},
    addChunks: async () => {},
    search: async () => [],
    fullTextSearch: async () => [],
    deleteByPageSlug: async () => {},
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

function getTools(server: any) {
  return (server as any)._registeredTools as Record<string, any>;
}

function insertPage(db: CBrainDB, slug: string, title: string, filePath?: string) {
  const fp = filePath ?? `${slug.replace(/\//g, "_")}.md`;
  db.prepare(
    `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
  ).run(slug, title, fp, "h1");
}

function insertPageWithVault(db: CBrainDB, slug: string, title: string, vaultPath: string, filePath?: string) {
  const fp = filePath ?? `${slug.replace(/\//g, "_")}.md`;
  const dir = join(vaultPath, fp.substring(0, fp.lastIndexOf("/")));
  if (dir !== vaultPath) mkdirSync(dir, { recursive: true });
  writeFileSync(join(vaultPath, fp), `---\ntitle: ${title}\ntype: entity\nslug: ${slug}\n---\n${title} content`);
  insertPage(db, slug, title, fp);
}

describe("Batch Tools", () => {
  const testDir = "/tmp/cbrain-test-batch";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let deps: CBrainDeps;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    deps = {
      db,
      embedding: createMockEmbedding() as any,
      lance: createMockLanceDB() as any,
      vaultPath,
    };
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  describe("batch_delete_pages", () => {
    test("deletes multiple pages", async () => {
      insertPageWithVault(db, "entities/a", "A", vaultPath);
      insertPageWithVault(db, "entities/b", "B", vaultPath);
      insertPageWithVault(db, "entities/c", "C", vaultPath);

      const server = createServer(deps);
      const result = await getTools(server).batch_delete_pages.handler({
        slugs: ["entities/a", "entities/b", "entities/c"],
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.succeeded).toBe(3);
      expect(data.failed).toBe(0);
      expect(data.results).toHaveLength(3);
      expect(data.results.every((r: any) => r.success)).toBe(true);

      expect(db.prepare("SELECT COUNT(*) as c FROM pages").get() as { c: number }).toEqual({ c: 0 });
    });

    test("handles partial failures (missing pages)", async () => {
      insertPageWithVault(db, "entities/a", "A", vaultPath);

      const server = createServer(deps);
      const result = await getTools(server).batch_delete_pages.handler({
        slugs: ["entities/a", "entities/ghost"],
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.succeeded).toBe(1);
      expect(data.failed).toBe(1);
      expect(data.results[0].success).toBe(true);
      expect(data.results[1].success).toBe(false);
      expect(data.results[1].error).toBe("not found");
    });

    test("handles empty slugs array gracefully", async () => {
      const server = createServer(deps);
      const result = await getTools(server).batch_delete_pages.handler({
        slugs: ["entities/nonexistent"],
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.succeeded).toBe(0);
      expect(data.failed).toBe(1);
    });
  });

  describe("batch_add_links", () => {
    test("creates multiple links", async () => {
      insertPageWithVault(db, "entities/a", "A", vaultPath);
      insertPageWithVault(db, "entities/b", "B", vaultPath);
      insertPageWithVault(db, "entities/c", "C", vaultPath);

      const server = createServer(deps);
      const result = await getTools(server).batch_add_links.handler({
        links: [
          { from: "entities/a", to: "entities/b", relation: "认识" },
          { from: "entities/a", to: "entities/c", relation: "认识" },
        ],
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.succeeded).toBe(2);
      expect(data.failed).toBe(0);

      const linkCount = db.prepare("SELECT COUNT(*) as c FROM links").get() as { c: number };
      expect(linkCount.c).toBe(2);
    });

    test("rejects self-referencing links", async () => {
      insertPageWithVault(db, "entities/a", "A", vaultPath);

      const server = createServer(deps);
      const result = await getTools(server).batch_add_links.handler({
        links: [{ from: "entities/a", to: "entities/a", relation: "认识" }],
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.succeeded).toBe(0);
      expect(data.results[0].error).toBe("self-reference");
    });

    test("handles missing pages", async () => {
      insertPageWithVault(db, "entities/a", "A", vaultPath);

      const server = createServer(deps);
      const result = await getTools(server).batch_add_links.handler({
        links: [
          { from: "entities/a", to: "entities/ghost", relation: "认识" },
          { from: "entities/ghost2", to: "entities/a", relation: "认识" },
        ],
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.succeeded).toBe(0);
      expect(data.failed).toBe(2);
    });

    test("mixed success and failure", async () => {
      insertPageWithVault(db, "entities/a", "A", vaultPath);
      insertPageWithVault(db, "entities/b", "B", vaultPath);

      const server = createServer(deps);
      const result = await getTools(server).batch_add_links.handler({
        links: [
          { from: "entities/a", to: "entities/b", relation: "认识" },
          { from: "entities/a", to: "entities/ghost", relation: "认识" },
        ],
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.succeeded).toBe(1);
      expect(data.failed).toBe(1);
    });
  });

  describe("batch_merge_pages", () => {
    test("merges multiple pairs", async () => {
      mkdirSync(join(vaultPath, "brain/entities"), { recursive: true });
      writeFileSync(join(vaultPath, "brain/entities/Src1.md"), "---\ntitle: Src1\ntype: entity\nslug: entities/src1\n---\nSource 1");
      writeFileSync(join(vaultPath, "brain/entities/Tgt1.md"), "---\ntitle: Tgt1\ntype: entity\nslug: entities/tgt1\n---\nTarget 1");
      writeFileSync(join(vaultPath, "brain/entities/Src2.md"), "---\ntitle: Src2\ntype: entity\nslug: entities/src2\n---\nSource 2");
      writeFileSync(join(vaultPath, "brain/entities/Tgt2.md"), "---\ntitle: Tgt2\ntype: entity\nslug: entities/tgt2\n---\nTarget 2");

      insertPage(db, "entities/src1", "Src1", "brain/entities/Src1.md");
      insertPage(db, "entities/tgt1", "Tgt1", "brain/entities/Tgt1.md");
      insertPage(db, "entities/src2", "Src2", "brain/entities/Src2.md");
      insertPage(db, "entities/tgt2", "Tgt2", "brain/entities/Tgt2.md");

      const server = createServer(deps);
      const result = await getTools(server).batch_merge_pages.handler({
        pairs: [
          { source: "entities/src1", target: "entities/tgt1" },
          { source: "entities/src2", target: "entities/tgt2" },
        ],
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.succeeded).toBe(2);
      expect(data.failed).toBe(0);

      // Sources deleted, targets remain
      expect(db.prepare("SELECT slug FROM pages WHERE slug = ?").get("entities/src1")).toBeNull();
      expect(db.prepare("SELECT slug FROM pages WHERE slug = ?").get("entities/src2")).toBeNull();
      expect(db.prepare("SELECT slug FROM pages WHERE slug = ?").get("entities/tgt1")).toBeDefined();
      expect(db.prepare("SELECT slug FROM pages WHERE slug = ?").get("entities/tgt2")).toBeDefined();
    });

    test("detects cascading failure (target already deleted)", async () => {
      mkdirSync(join(vaultPath, "brain/entities"), { recursive: true });
      writeFileSync(join(vaultPath, "brain/entities/A.md"), "---\ntitle: A\ntype: entity\nslug: entities/a\n---\nA");
      writeFileSync(join(vaultPath, "brain/entities/B.md"), "---\ntitle: B\ntype: entity\nslug: entities/b\n---\nB");
      writeFileSync(join(vaultPath, "brain/entities/C.md"), "---\ntitle: C\ntype: entity\nslug: entities/c\n---\nC");

      insertPage(db, "entities/a", "A", "brain/entities/A.md");
      insertPage(db, "entities/b", "B", "brain/entities/B.md");
      insertPage(db, "entities/c", "C", "brain/entities/C.md");

      // Pair 1: a → b (a gets deleted)
      // Pair 2: c → a (a already deleted by pair 1)
      const server = createServer(deps);
      const result = await getTools(server).batch_merge_pages.handler({
        pairs: [
          { source: "entities/a", target: "entities/b" },
          { source: "entities/c", target: "entities/a" },
        ],
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.succeeded).toBe(1);
      expect(data.failed).toBe(1);
      expect(data.results[1].error).toContain("already deleted");
    });

    test("rejects same-page merge", async () => {
      insertPageWithVault(db, "entities/a", "A", vaultPath);

      const server = createServer(deps);
      const result = await getTools(server).batch_merge_pages.handler({
        pairs: [{ source: "entities/a", target: "entities/a" }],
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.succeeded).toBe(0);
      expect(data.results[0].error).toBe("same page");
    });
  });

  describe("getExpiryWarning", () => {
    test("returns undefined for null/undefined", async () => {
      const { getExpiryWarning } = await import("../../src/mcp/tools/trim.js");
      expect(getExpiryWarning(null)).toBeUndefined();
      expect(getExpiryWarning(undefined)).toBeUndefined();
      expect(getExpiryWarning()).toBeUndefined();
    });

    test("returns expired warning for past date", async () => {
      const { getExpiryWarning } = await import("../../src/mcp/tools/trim.js");
      const result = getExpiryWarning("2020-01-01");
      expect(result).toContain("已过期");
      expect(result).toContain("2020-01-01");
    });

    test("returns expiring-soon warning within 30 days", async () => {
      const { getExpiryWarning } = await import("../../src/mcp/tools/trim.js");
      const future = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const result = getExpiryWarning(future);
      expect(result).toContain("即将过期");
      expect(result).toContain(future);
    });

    test("returns undefined for far-future date", async () => {
      const { getExpiryWarning } = await import("../../src/mcp/tools/trim.js");
      const result = getExpiryWarning("2099-12-31");
      expect(result).toBeUndefined();
    });

    test("returns undefined for invalid date string", async () => {
      const { getExpiryWarning } = await import("../../src/mcp/tools/trim.js");
      const result = getExpiryWarning("not-a-date");
      expect(result).toBeUndefined();
    });
  });
});
