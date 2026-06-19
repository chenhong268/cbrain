import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

function createMockEmbedding(): EmbeddingProvider {
  return {
    dimensions: 128,
    embed: async (text: string) => ({
      embedding: new Array(128).fill(0).map((_, i) => (text.charCodeAt(i % Math.max(text.length, 1)) ?? 0) / 65536),
      tokenCount: text.length,
    }),
    embedBatch: async (texts: string[]) =>
      texts.map((t) => ({
        embedding: new Array(128).fill(0).map((_, i) => (t.charCodeAt(i % Math.max(t.length, 1)) ?? 0) / 65536),
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
    deleteRawChunksByPageSlug: async () => {},
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

function getTools(server: any) {
  return (server as any)._registeredTools as Record<string, any>;
}

function seedPage(db: CBrainDB, vaultPath: string, slug: string, title: string, type: string): void {
  db.upsertPage({ slug, type, title, filePath: `${slug}.md`, contentHash: `h-${slug}` });
  const dir = join(vaultPath, ...slug.split("/").slice(0, -1));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(vaultPath, `${slug}.md`),
    `---\ntitle: "${title}"\ntype: ${type}\nslug: ${slug}\n---\n`,
  );
}

describe("cbrain_recall front-door tool (#199)", () => {
  const testDir = "/tmp/cbrain-test-frontdoor";
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
      embedding: createMockEmbedding(),
      lance: createMockLanceDB() as any,
      vaultPath,
      runtimePath: join(testDir, "runtime"),
    };
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("tool is registered", () => {
    const server = createServer(deps);
    expect("cbrain_recall" in getTools(server)).toBe(true);
  });

  test("natural-language content recall routes to deep_recall, not query", async () => {
    const server = createServer(deps);
    const result = await getTools(server).cbrain_recall.handler({
      query: "之前项目E当时怎么设计的",
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.display).toBeString();
    expect(data.summary.status).toBe("empty");
    expect(data.raw.routing.chosen_route).toBe("content_recall");
    expect(data.raw.routing.next_tool).toBe("deep_recall");
    expect(data.raw.routing.next_tool).not.toBe("query");
    expect(data.raw.routing.latency_ms).toBeGreaterThanOrEqual(0);
  });

  test("debug wording is the only route that selects query", async () => {
    const server = createServer(deps);
    const result = await getTools(server).cbrain_recall.handler({
      query: "debug 一下关键词主题C在哪些页面出现",
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.raw.routing.chosen_route).toBe("debug_search");
    expect(data.raw.routing.next_tool).toBe("query");
  });

  test("hierarchy route executes get_org_tree-compatible path", async () => {
    seedPage(db, vaultPath, "entities/entity-a", "实体A", "entity/person");
    seedPage(db, vaultPath, "entities/entity-b", "实体B", "entity/person");
    db.rawDb.prepare(
      `INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state) VALUES (?, ?, ?, ?, ?)`,
    ).run("entities/entity-b", "entities/entity-a", "reports_to", "agent", "candidate");

    const server = createServer(deps);
    const result = await getTools(server).cbrain_recall.handler({
      query: "实体A的下属和组织架构",
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.raw.routing.chosen_route).toBe("hierarchy");
    expect(data.raw.routing.next_tool).toBe("get_org_tree");
    expect(data.summary.status).toBe("ok");
    expect(data.display).toContain("组织架构");
    expect(data.display).not.toContain("entities/");
  });

  test("display and summary do not expose routing diagnostics", async () => {
    const server = createServer(deps);
    const result = await getTools(server).cbrain_recall.handler({
      query: "主题A之前讨论过吗",
    });
    const data = JSON.parse(result.content[0].text);
    const visible = `${data.display}\n${data.summary.message}`;

    for (const term of ["raw", "routing", "chosen_route", "next_tool", "score", "trace", "reason_codes", "slug"]) {
      expect(visible).not.toContain(term);
    }
    expect(data.raw.routing.chosen_route).toBe("grounded_recall");
    expect(data.raw.routing.next_tool).toBe("deep_recall");
  });
});
