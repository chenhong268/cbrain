import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { IngestManager } from "../../src/core/ingestion/ingest.js";
import { generateSlug, looksLikePath } from "../../src/utils/slug.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

function createMockEmbeddingProvider(): EmbeddingProvider {
  return {
    dimensions: 128,
    embed: async (text: string) => {
      const vec = new Array(128).fill(0);
      for (let i = 0; i < text.length; i++) vec[i % 128] += text.charCodeAt(i) / 65536;
      return { embedding: vec, tokenCount: text.length };
    },
    embedBatch: async (texts: string[]) =>
      texts.map((t) => {
        const vec = new Array(128).fill(0);
        for (let i = 0; i < t.length; i++) vec[i % 128] += t.charCodeAt(i) / 65536;
        return { embedding: vec, tokenCount: t.length };
      }),
  };
}

function createMockLanceDB() {
  return {
    connect: async () => {},
    addChunks: async () => {},
    search: async () => [],
    fullTextSearch: async () => [],
    deleteByPageSlug: async () => {},
    deleteRawChunksByPageSlug: async () => {},
    deleteL1VectorByPageSlug: async () => {},
    readRawVectorRows: async () => [],
    readL1VectorRows: async () => [],
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

describe("Ingest markdown dedup + path validation (#190)", () => {
  const testDir = "/tmp/cbrain-test-ingest-md-dedup";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let ingest: IngestManager;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    ingest = new IngestManager(db, createMockEmbeddingProvider(), createMockLanceDB() as never, vaultPath);
  });
  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function count(table: string): number {
    return (db.rawDb.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
  }

  test("re-ingesting an existing frontmatter-slug entity is a no-op duplicate", async () => {
    const md = `---\ntitle: Alpha\ntype: entity/person\nslug: brain/entities/person/alpha\n---\n\nalpha body`;
    await ingest.ingest({ content: md, type: "markdown" });
    const pages = count("pages");
    const chunks = count("chunks");
    const links = count("links");

    const r = await ingest.ingest({ content: md, type: "markdown" });

    expect(r.outcome).toBe("duplicate");
    expect(r.created).toBe(false);
    expect(r.duplicateOf?.slug).toBe("brain/entities/person/alpha");
    // No duplicate index/link state, no new page.
    expect(count("pages")).toBe(pages);
    expect(count("chunks")).toBe(chunks);
    expect(count("links")).toBe(links);
  });

  test("--allow-duplicate bypasses the frontmatter-slug no-op (proceeds to re-index)", async () => {
    const md = `---\ntitle: Beta\ntype: entity/person\nslug: brain/entities/person/beta\n---\n\nbeta body`;
    await ingest.ingest({ content: md, type: "markdown" });

    const r = await ingest.ingest({ content: md, type: "markdown", allowDuplicate: true });

    expect(r.outcome).not.toBe("duplicate"); // proceeded (updated/re-indexed), not no-op
  });

  test("entity/person title existing under a different slug -> conservative no-op duplicate", async () => {
    await ingest.ingest({
      content: `---\ntitle: Gamma\ntype: entity/person\nslug: brain/entities/person/gamma\n---\n\ngamma body`,
      type: "markdown",
    });

    // New markdown declares a DIFFERENT slug but the SAME person title.
    const r = await ingest.ingest({
      content: `---\ntitle: Gamma\ntype: entity/person\nslug: brain/entities/person/gamma-two\n---\n\ngamma two`,
      type: "markdown",
    });

    expect(r.outcome).toBe("duplicate");
    expect(r.duplicateOf?.slug).toBe("brain/entities/person/gamma");
  });

  test("path-like markdown title is rejected (VALIDATION_ERROR); no page created", async () => {
    const pagesBefore = count("pages");
    await expect(
      ingest.ingest({
        content: `---\ntitle: /Users/example/secret.md\ntype: entity/person\n---\n\nbody`,
        type: "markdown",
      }),
    ).rejects.toThrow(/VALIDATION_ERROR|path/i);
    expect(count("pages")).toBe(pagesBefore);
  });

  test("ingestText rejects a path-like title derived from content (forgot @)", async () => {
    const pagesBefore = count("pages");
    // content is a bare path string — first line is path-like
    await expect(
      ingest.ingest({ content: "/tmp/cbrain-example/secret.md", type: "text" }),
    ).rejects.toThrow(/VALIDATION_ERROR|path/i);
    expect(count("pages")).toBe(pagesBefore);
  });

  test("normal slash titles ingest fine (no false VALIDATION_ERROR) — regression", async () => {
    for (const title of ["A/B 测试", "风险/收益", "MCP/CLI 对比", "Q1/Q2 review"]) {
      const r = await ingest.ingest({
        content: `---\ntitle: "${title}"\ntype: concept/concept\n---\n\nbody for ${title}`,
        type: "markdown",
      });
      expect(r.outcome).toBe("created");
      expect(r.slug.includes("untitled-")).toBe(false); // real slug, not a path-derived untitled
    }
  });
});

describe("looksLikePath detects only real filesystem paths (#190)", () => {
  test("rejects real paths: absolute, home, drive, UNC, backslash, relative+ext", () => {
    for (const p of [
      "/Users/example/secret.md", "/tmp/a", "~/vault/n.md",
      "C:\\Users\\example\\note.md", "\\\\server\\share\\file",
      "foo/bar.md", "a/b.txt", "deep/rel/path.json",
    ]) {
      expect(looksLikePath(p)).toBe(true);
    }
  });
  test("allows normal slash / plain titles", () => {
    for (const t of ["A/B 测试", "风险/收益", "MCP/CLI 对比", "Q1/Q2 review", "Q1/Q2 v1.2", "普通标题", "Alpha"]) {
      expect(looksLikePath(t)).toBe(false);
    }
  });
});

describe("generateSlug: real paths -> untitled, slash titles -> real slug (#190)", () => {
  test("real path titles yield untitled-*, never a flattened path", () => {
    for (const p of ["/Users/example/vault/note.md", "~/vault/note.md", "C:\\Users\\example\\note.md", "foo/bar.md"]) {
      const slug = generateSlug(p, "record");
      expect(slug.startsWith("records/untitled-")).toBe(true);
    }
    expect(generateSlug("/Users/example/vault/note.md", "record"))
      .not.toMatch(/users|example|vault|note/i);
  });
  test("normal slash titles produce a real slug, NOT untitled", () => {
    for (const title of ["A/B 测试", "风险/收益", "MCP/CLI 对比", "Q1/Q2 review"]) {
      const slug = generateSlug(title, "record");
      expect(slug.startsWith("records/")).toBe(true);
      expect(slug.startsWith("records/untitled-")).toBe(false);
    }
  });
});
