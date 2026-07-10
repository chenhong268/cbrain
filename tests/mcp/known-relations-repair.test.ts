import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import { PageManager } from "../../src/core/page.js";
import { CBrainDB } from "../../src/storage/sqlite.js";

function getTools(server: unknown) {
  return (server as any)._registeredTools as Record<string, { handler: (args: any) => Promise<any> }>;
}

describe("repair_known_relations MCP (#323)", () => {
  let db: CBrainDB;
  let deps: CBrainDeps;
  let root: string;
  let slugA: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cbrain-mcp-kr-repair-"));
    db = new CBrainDB(join(root, "brain.sqlite"));
    const pages = new PageManager(db, root);
    slugA = pages.create({ slug: "entity/a", title: "实体A", type: "entity/person", body: "正文A", tags: [] }).slug;
    const slugB = pages.create({ slug: "entity/b", title: "实体B", type: "entity/person", body: "正文B", tags: [] }).slug;
    db.insertLink(slugA, slugB, "协作", null, 1, "strong", "manual", 0.9);
    deps = {
      db,
      vaultPath: root,
      runtimePath: join(root, "runtime"),
      embedding: { dimensions: 2, embed: async () => ({ embedding: [0, 0], tokenCount: 0 }), embedBatch: async () => [] },
      lance: { close: async () => {} } as any,
    };
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const pageContent = () => {
    const row = db.getPage(slugA)!;
    return readFileSync(join(root, row.file_path), "utf8");
  };

  test("defaults to dry-run and returns scalar-only audit", async () => {
    const before = pageContent();
    const result = await getTools(createServer(deps)).repair_known_relations.handler({});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.summary.dryRun).toBe(true);
    expect(payload.summary.candidates).toBe(2);
    expect(payload.raw).toBeNull();
    expect(pageContent()).toBe(before);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(slugA);
    expect(serialized).not.toContain(root);
  });

  test("execute without explicit limit fails before write", async () => {
    const before = pageContent();
    const result = await getTools(createServer(deps)).repair_known_relations.handler({ execute: true });
    expect(result.isError).toBe(true);
    expect(pageContent()).toBe(before);
  });

  test("execute repairs only the requested batch", async () => {
    const result = await getTools(createServer(deps)).repair_known_relations.handler({ execute: true, limit: 1 });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.summary.repaired).toBe(1);
    expect(payload.summary.remaining).toBe(1);
  });
});
