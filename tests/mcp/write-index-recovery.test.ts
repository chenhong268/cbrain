import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildContext, indexPage, type ToolContext } from "../../src/mcp/context.js";
import { attachMcpTools } from "../../src/mcp/server.js";
import { DeterministicEmbeddingProvider } from "../../src/embedding/deterministic.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import { hashContent } from "../../src/core/shared.js";

describe("write failures remain recoverable by ordinary sync (#451)", () => {
  let root: string;
  let ctx: ToolContext;
  let server: McpServer;
  let embedding: DeterministicEmbeddingProvider;
  let slug: string;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "cbrain-write-recovery-"));
    mkdirSync(join(root, "vault"));
    embedding = new DeterministicEmbeddingProvider();
    const lance = new LanceDBManager();
    await lance.connect(join(root, "lance"));
    ctx = buildContext({ db: new CBrainDB(join(root, "brain.sqlite")), vaultPath: join(root, "vault"),
      runtimePath: join(root, "runtime"), embedding, lance, nerIngestMode: "off" });
    slug = ctx.pages.create({ title: "实体A", type: "entity/person", body: "originalfixturetoken" }).slug;
    await indexPage(ctx.pipeline, slug, "originalfixturetoken");
    server = new McpServer({ name: "fixture", version: "1" });
    attachMcpTools(server, ctx);
  });
  afterEach(async () => {
    await server.close();
    await ctx.lance.close();
    ctx.db.close();
    rmSync(root, { recursive: true, force: true });
  });
  async function invoke(name: string, args: unknown) {
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }> })._registeredTools;
    return tools[name].handler(args);
  }
  async function assertRecovered(token: string) {
    expect((await ctx.sync.syncPage(slug, ctx.vaultPath)).success).toBe(true);
    expect(ctx.db.ftsSearch(token).some(row => row.page_slug === slug)).toBe(true);
    expect((await ctx.lance.readRawVectorRows(slug)).some(row => row.content.includes(token))).toBe(true);
    const raw = readFileSync(join(ctx.vaultPath, ctx.db.getPageFilePath(slug)!), "utf8");
    expect(ctx.db.getPageContentHash(slug)).toBe(hashContent(raw));
    expect((await ctx.sync.syncPage(slug, ctx.vaultPath)).skipped).toBe(true);
  }
  for (const name of ["put_page", "append_page"]) {
    test(`${name} reports failed indexing and preserves retry marker across projection`, async () => {
      const embed = embedding.embedBatch.bind(embedding);
      embedding.embedBatch = async () => { throw new Error("FIXTURE_EMBED_FAILED"); };
      const result = await invoke(name, { slug, content: "replacementfixturetoken", mode: "replace", separator: "\n\n" });
      expect(JSON.stringify(result)).toContain("index_sync_failed");
      expect(ctx.db.getPageContentHash(slug)).toBeNull();
      ctx.pages.syncLinksToMarkdown(slug);
      expect(ctx.db.getPageContentHash(slug)).toBeNull();
      embedding.embedBatch = embed;
      await assertRecovered("replacementfixturetoken");
      if (name === "put_page") expect(ctx.db.getChunksByPage(slug).some(row => row.content.includes("originalfixturetoken"))).toBe(false);
    });
  }
  test("merged source content is indexed on the next sync and source indexes are gone", async () => {
    const source = ctx.pages.create({ title: "实体B", type: "entity/person", body: "uniquesourcefixturetoken" });
    await indexPage(ctx.pipeline, source.slug, source.body);
    await ctx.pages.merge(source.slug, slug);
    expect(ctx.db.getPageContentHash(slug)).toBeNull();
    ctx.pages.syncLinksToMarkdown(slug);
    expect(ctx.db.getPageContentHash(slug)).toBeNull();
    await assertRecovered("uniquesourcefixturetoken");
    expect(ctx.db.getPage(source.slug)).toBeNull();
    expect(ctx.db.ftsSearch("uniquesourcefixturetoken").map(row => row.page_slug)).toEqual([slug]);
    expect(await ctx.lance.readRawVectorRows(source.slug)).toEqual([]);
  });
  test("an older in-flight index cannot mark newer file contents as synchronized", async () => {
    ctx.pages.update(slug, { body: "intermediatefixturetoken" });
    const embed = embedding.embedBatch.bind(embedding);
    embedding.embedBatch = async texts => {
      ctx.pages.update(slug, { body: "newestfixturetoken" });
      return embed(texts);
    };
    await indexPage(ctx.pipeline, slug, "intermediatefixturetoken");
    expect(ctx.db.getPageContentHash(slug)).toBeNull();
    embedding.embedBatch = embed;
    await assertRecovered("newestfixturetoken");
  });
});
