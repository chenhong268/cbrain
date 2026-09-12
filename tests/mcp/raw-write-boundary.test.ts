import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildContext, type ToolContext } from "../../src/mcp/context.js";
import { attachMcpTools } from "../../src/mcp/server.js";
import { DeterministicEmbeddingProvider } from "../../src/embedding/deterministic.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { getOntology } from "../../src/ontology/loader.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";

describe("raw physical write boundary (#455)", () => {
  let root: string;
  let ctx: ToolContext;
  let server: McpServer;
  const slug = "entities/fixture-a";
  let target: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cbrain-raw-boundary-"));
    const vaultPath = join(root, "vault");
    mkdirSync(join(vaultPath, "raw"), { recursive: true });
    ctx = buildContext({ db: new CBrainDB(join(root, "brain.sqlite")), vaultPath,
      runtimePath: join(root, "runtime"), embedding: new DeterministicEmbeddingProvider(), lance: new LanceDBManager() });
    const body = `---\ntitle: 实体A\ntype: entity/person\nslug: ${slug}\n---\n原始资料A。`;
    writeFileSync(join(vaultPath, "raw/a.md"), body);
    ctx.db.insertPage({ slug, type: "entity/person", title: "实体A", filePath: "raw/a.md", contentHash: "original" });
    ctx.db.createVersion(slug, "旧版本原始资料");
    target = ctx.pages.create({ title: "实体B", type: "entity/person", body: "资料B。" }).slug;
    server = new McpServer({ name: "fixture", version: "1" });
    attachMcpTools(server, ctx);
  });
  afterEach(async () => {
    await server.close();
    ctx.db.close();
    rmSync(root, { recursive: true, force: true });
  });
  function snapshot() {
    return JSON.stringify({
      raw: readFileSync(join(ctx.vaultPath, "raw/a.md"), "utf8"),
      target: readFileSync(join(ctx.vaultPath, ctx.db.getPageFilePath(target)!), "utf8"),
      rows: ["pages", "versions", "links", "timeline", "tags", "aliases"].map(table =>
        ctx.db.rawDb.prepare(`SELECT * FROM ${table}`).all()),
    });
  }
  for (const operation of ["update", "patch", "delete", "merge-source", "merge-target", "type", "move", "revert"] as const) {
    test(`${operation} rejects indexed raw before any side effect`, async () => {
      const before = snapshot();
      const call = async () => {
        switch (operation) {
          case "update": return ctx.pages.update(slug, { body: "变更" });
          case "patch": return ctx.pages.patch(slug, { body_append: "变更" });
          case "delete": return ctx.pages.delete(slug);
          case "merge-source": return ctx.pages.merge(slug, target);
          case "merge-target": return ctx.pages.merge(target, slug);
          case "type": return ctx.pages.updateType(slug, "entity/person");
          case "move": return ctx.pages.movePageAtomic(slug, "brain/entities/person/fixture-c", "entity/person", ctx.pages.getBySlug(slug)!.frontmatter, "变更");
          case "revert": return ctx.versions.revertToVersion(slug, 1);
        }
      };
      await expect(call()).rejects.toThrow("RAW_PAGE_READ_ONLY");
      expect(snapshot()).toBe(before);
    });
  }
  for (const [name, args] of [
    ["put_page", { slug, content: "替换", mode: "replace" }],
    ["put_page", { slug, content: "追加", mode: "patch" }],
    ["append_page", { slug, content: "追加", separator: "\n\n" }],
    ["timeline", { action: "add", slug, summary: "事件A", eventDate: "2026-01-01" }],
  ] as const) {
    test(`${name} reports a sanitized failure without versions or timeline changes`, async () => {
      const before = snapshot();
      const registered = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ isError?: boolean; content: unknown }> }> })._registeredTools;
      const result = await registered[name].handler(args);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("RAW_PAGE_READ_ONLY");
      expect(snapshot()).toBe(before);
    });
  }
  test("a brain symlink to raw is protected using its physical path", () => {
    mkdirSync(join(ctx.vaultPath, "brain"), { recursive: true });
    symlinkSync(join(ctx.vaultPath, "raw/a.md"), join(ctx.vaultPath, "brain/alias.md"));
    ctx.db.rawDb.prepare("UPDATE pages SET file_path = 'brain/alias.md' WHERE slug = ?").run(slug);
    const before = snapshot();
    expect(() => ctx.pages.update(slug, { body: "变更" })).toThrow("RAW_PAGE_READ_ONLY");
    expect(snapshot()).toBe(before);
  });
  test("creating through a directory symlink into raw is rejected", () => {
    const recordDir = join(ctx.vaultPath, getOntology().getVaultDir("record"));
    mkdirSync(dirname(recordDir), { recursive: true });
    symlinkSync(join(ctx.vaultPath, "raw"), recordDir);
    const before = snapshot();
    expect(() => ctx.pages.create({ slug: "brain/records/fixture-record", type: "record", title: "记录A", body: "记录内容" })).toThrow("RAW_PAGE_READ_ONLY");
    expect(snapshot()).toBe(before);
  });
  test("a dangling file symlink cannot create a raw original", () => {
    const recordDir = join(ctx.vaultPath, getOntology().getVaultDir("record"));
    mkdirSync(recordDir, { recursive: true });
    symlinkSync(join(ctx.vaultPath, "raw/new.md"), join(recordDir, "fixture-record.md"));
    const before = snapshot();
    expect(() => ctx.pages.create({ slug: "fixture-record", type: "record", title: "记录A", body: "记录内容" })).toThrow("VAULT_WRITE_PATH_UNRESOLVED");
    expect(existsSync(join(ctx.vaultPath, "raw/new.md"))).toBe(false);
    expect(snapshot()).toBe(before);
  });
  test("timeline cannot mutate indexed raw even when its file is absent", async () => {
    unlinkSync(join(ctx.vaultPath, "raw/a.md"));
    const before = ctx.db.rawDb.prepare("SELECT * FROM timeline").all();
    const registered = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ isError?: boolean }> }> })._registeredTools;
    expect((await registered.timeline.handler({ action: "add", slug, summary: "事件A" })).isError).toBe(true);
    expect(ctx.db.rawDb.prepare("SELECT * FROM timeline").all()).toEqual(before);
  });
  test("ordinary brain records remain writable", () => {
    const page = ctx.pages.create({ title: "记录A", type: "record", body: "初始资料。" });
    expect(ctx.pages.patch(page.slug, { body_append: "新增资料。" })?.body).toContain("新增资料。");
  });
});
