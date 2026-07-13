import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import { OUTPUT_MODE_ENV } from "../../src/mcp/output-mode.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import {
  LEGACY_DEEP_RECALL_GOLDEN,
  LEGACY_FRONTDOOR_GOLDEN,
  LEGACY_QUERY_GOLDEN,
} from "./fixtures/recall-output-legacy-goldens.js";

function mockEmbedding() {
  return {
    dimensions: 8,
    embed: async () => ({ embedding: new Array(8).fill(0), tokenCount: 1 }),
    embedBatch: async (texts: string[]) => texts.map(() => ({ embedding: new Array(8).fill(0), tokenCount: 1 })),
  };
}

function mockLance() {
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

function tools(server: unknown) {
  return (server as {
    _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
  })._registeredTools;
}

async function call(server: unknown, name: string, args: Record<string, unknown>) {
  const result = await tools(server)[name].handler(args) as {
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  };
  return { result, parsed: JSON.parse(result.content[0].text) as Record<string, unknown> };
}

async function withOutputMode(mode: "legacy" | "structured", fn: () => Promise<void>): Promise<void> {
  const previous = process.env[OUTPUT_MODE_ENV];
  process.env[OUTPUT_MODE_ENV] = mode;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env[OUTPUT_MODE_ENV];
    else process.env[OUTPUT_MODE_ENV] = previous;
  }
}

describe("#331 recall/query structured output boundary", () => {
  let root: string;
  let db: CBrainDB;
  let deps: CBrainDeps;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cbrain-output-331-"));
    const vaultPath = join(root, "vault");
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(join(root, "brain.sqlite"));
    deps = {
      db,
      embedding: mockEmbedding() as never,
      lance: mockLance() as never,
      vaultPath,
      runtimePath: join(root, "runtime"),
    };
  });

  afterEach(() => {
    db.close();
    if (existsSync(root)) rmSync(root, { recursive: true });
  });

  test("legacy mode keeps each existing top-level contract", async () => {
    await withOutputMode("legacy", async () => {
      const originalNow = Date.now;
      Date.now = () => 1000;
      try {
        const server = createServer(deps);
        const query = await call(server, "query", { query: "主题A" });
        const recall = await call(server, "deep_recall", { query: "主题A" });
        const frontdoor = await call(server, "cbrain_recall", { query: "主题A之前讨论过吗" });
        const queryWithRawFlag = await call(server, "query", { query: "主题A", include_raw: true });
        const frontdoorWithRawFlag = await call(server, "cbrain_recall", {
          query: "主题A之前讨论过吗",
          include_raw: true,
        });

        expect(query.parsed.schema_version).toBeUndefined();
        expect(query.parsed.raw).toBeDefined();
        expect(query.parsed.results).toBeArray();
        expect(recall.parsed.schema_version).toBeUndefined();
        expect(recall.parsed.raw).toBeUndefined();
        expect(recall.parsed.entities).toBeArray();
        expect(frontdoor.parsed.schema_version).toBeUndefined();
        expect(frontdoor.parsed.raw).toBeDefined();
        expect(query.result.structuredContent).toBeUndefined();
        expect(recall.result.structuredContent).toBeUndefined();
        expect(frontdoor.result.structuredContent).toBeUndefined();
        expect(query.result.content[0].text).toBe(LEGACY_QUERY_GOLDEN);
        expect(recall.result.content[0].text).toBe(LEGACY_DEEP_RECALL_GOLDEN);
        expect(frontdoor.result.content[0].text).toBe(LEGACY_FRONTDOOR_GOLDEN);
        expect(queryWithRawFlag.result.content[0].text).toBe(LEGACY_QUERY_GOLDEN);
        expect(frontdoorWithRawFlag.result.content[0].text).toBe(LEGACY_FRONTDOOR_GOLDEN);
      } finally {
        Date.now = originalNow;
      }
    });
  });

  test("structured query returns only bounded semantic data by default", async () => {
    await withOutputMode("structured", async () => {
      const server = createServer(deps);
      const { parsed, result } = await call(server, "query", { query: "主题A" });

      expect(parsed.schema_version).toBe(1);
      expect(parsed.display).toBe("已完成关键词检索。");
      expect(parsed.summary).toMatchObject({ message: "已完成关键词检索。" });
      expect(parsed.data).toEqual({ result_count: 0, results: [] });
      expect(parsed.audit).toBeUndefined();
      expect(parsed.raw).toBeUndefined();
      expect(result.structuredContent).toBeDefined();
    });
  });

  test("structured deep_recall covers empty and grounded branches without raw by default", async () => {
    await withOutputMode("structured", async () => {
      const server = createServer(deps);
      const empty = await call(server, "deep_recall", { query: "主题A" });
      const grounded = await call(server, "deep_recall", { query: "主题A", grounded: true });

      expect(empty.parsed.schema_version).toBe(1);
      expect(empty.parsed.display).toBe("已完成记忆检索。");
      expect(empty.parsed.data).toMatchObject({ query: "主题A", entities: [] });
      expect(empty.parsed.audit).toBeUndefined();
      expect(grounded.parsed.schema_version).toBe(1);
      expect(grounded.parsed.data).toMatchObject({ confidence: "low", facts: [], must_not_claim: [] });
      expect(grounded.parsed.audit).toBeUndefined();
      expect(empty.result.structuredContent).toBeDefined();
      expect(grounded.result.structuredContent).toBeDefined();
    });
  });

  test("structured deep_recall preserves non-empty compact and grounded evidence semantics", async () => {
    db.upsertPage({
      slug: "entity/entity-a",
      type: "entity/person",
      title: "实体A",
      filePath: "entity-a.md",
      contentHash: "hash-a",
    });
    db.rawDb.prepare("UPDATE pages SET tier = 1, mention_count = 5 WHERE slug = ?").run("entity/entity-a");
    writeFileSync(join(root, "vault", "entity-a.md"), "---\ntitle: 实体A\ntype: entity/person\n---\n实体A的正常正文内容。");
    const indexedContent = `实体A的独特fts关键词正常片段${"。实体A补充内容".repeat(80)}`;
    db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, 0, ?)")
      .run("entity/entity-a", indexedContent);
    db.rawDb.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)")
      .run("entity/entity-a", indexedContent);
    db.rawDb.prepare(
      "INSERT INTO timeline (page_slug, summary, event_date, source, trust_state) VALUES (?, ?, ?, 'manual', 'trusted')",
    ).run("entity/entity-a", "实体A完成了事项B", "2026-01-02");
    const ftsRows = db.ftsSearch("实体A", 5);
    expect(ftsRows.length).toBeGreaterThan(0);

    await withOutputMode("structured", async () => {
      const server = createServer(deps);
      const normal = await call(server, "deep_recall", { query: "实体A", detail: "normal" });
      const grounded = await call(server, "deep_recall", { query: "实体A", grounded: true });

      const normalData = normal.parsed.data as { entities: Array<Record<string, unknown>> };
      expect(normalData.entities[0]).toMatchObject({ title: "实体A" });
      expect(normalData.entities[0].snippet).toBeString();
      expect(normalData.entities[0].slug).toBeUndefined();
      expect(normalData.entities[0].body).toBeUndefined();
      const groundedData = grounded.parsed.data as Record<string, unknown>;
      expect(groundedData.facts).toBeArray();
      expect(groundedData).not.toHaveProperty("sources");
      expect(normal.result.structuredContent).toBeDefined();
      expect(grounded.result.structuredContent).toBeDefined();
    });
  });

  test("structured frontdoor returns bounded route-aware details", async () => {
    await withOutputMode("structured", async () => {
      const server = createServer(deps);
      const { parsed, result } = await call(server, "cbrain_recall", { query: "主题A之前讨论过吗" });

      expect(parsed.schema_version).toBe(1);
      expect(parsed.display).toBe("已完成 CBrain 检索。");
      expect(parsed.data).toHaveProperty("answer");
      expect(parsed.data).toHaveProperty("details");
      expect(parsed.audit).toBeUndefined();
      expect(JSON.stringify(parsed.data)).not.toContain("chosen_route");
      expect(result.structuredContent).toBeDefined();
    });
  });

  test("structured frontdoor content route excludes full page bodies", async () => {
    db.upsertPage({
      slug: "entity/entity-body",
      type: "entity/person",
      title: "实体正文标记",
      filePath: "entity-body.md",
      contentHash: "hash-body",
    });
    writeFileSync(
      join(root, "vault", "entity-body.md"),
      "---\ntitle: 实体正文标记\ntype: entity/person\n---\nFULL-BODY-SECRET",
    );
    db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, 0, ?)")
      .run("entity/entity-body", "实体正文标记 可见摘要 FULL-BODY-SECRET");
    db.rawDb.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)")
      .run("entity/entity-body", "实体正文标记 可见摘要 FULL-BODY-SECRET");

    await withOutputMode("structured", async () => {
      const server = createServer(deps);
      const { parsed } = await call(server, "cbrain_recall", { query: "实体正文标记", detail: "normal" });
      const blob = JSON.stringify(parsed.data);
      expect(blob).toContain("实体正文标记");
      expect(blob).not.toContain("FULL-BODY-SECRET");
      expect(blob).not.toContain('"body"');
    });
  });

  test("structured include_raw moves redacted diagnostics under audit only", async () => {
    await withOutputMode("structured", async () => {
      const server = createServer(deps);
      const outputs = await Promise.all([
        call(server, "query", { query: "主题A", include_raw: true }),
        call(server, "deep_recall", { query: "主题A", include_raw: true }),
        call(server, "cbrain_recall", { query: "主题A之前讨论过吗", include_raw: true }),
      ]);

      for (const { parsed } of outputs) {
        expect(parsed.raw).toBeUndefined();
        expect(parsed.audit).toHaveProperty("raw");
      }
    });
  });

  test("query opt-in audit matches structuredContent, keeps locators, and redacts credential/path", async () => {
    const sentinels = ["sk-abcd1234efgh5678", "/Users/private/secret.md", "普通审计内容"];
    for (let index = 0; index < sentinels.length; index += 1) {
      const slug = `concepts/audit-${index}`;
      db.upsertPage({ slug, type: "concept", title: `审计实体${index}`, filePath: `audit-${index}.md`, contentHash: `h-${index}` });
      db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, 0, ?)")
        .run(slug, `审计共同标记 ${sentinels[index]}`);
      db.rawDb.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)")
        .run(slug, `审计共同标记 ${sentinels[index]}`);
    }

    await withOutputMode("structured", async () => {
      const server = createServer(deps);
      const { parsed, result } = await call(server, "query", { query: "审计共同标记", include_raw: true });
      expect(parsed.audit).toEqual(result.structuredContent?.audit);
      const auditBlob = JSON.stringify(parsed.audit);
      expect(auditBlob).toContain("concepts/audit-");
      expect(auditBlob).not.toContain("sk-abcd1234efgh5678");
      expect(auditBlob).not.toContain("/Users/private");
      expect(JSON.stringify(parsed.data)).not.toContain("concepts/audit-");
    });
  });

  test.each([
    ["credential", "攻击标记A", "sk-abcd1234efgh5678", false],
    ["absolute path", "攻击标记B", "/Users/private/secret.md", false],
    ["fullwidth internal term", "攻击标记C", "ｓｃｏｒｅ＝0.9", false],
    ["bidi control", "攻击标记D", `安全\u202E文本`, false],
    ["slug-like value", "攻击标记E", "entities/private", false],
    ["normal text", "攻击标记F", "普通可读内容", true],
  ])("query sanitizes independent %s fixture through the real handler", async (_label, marker, sentinel, visible) => {
    db.upsertPage({
      slug: `concepts/${marker}`,
      type: "concept",
      title: marker,
      filePath: `${marker}.md`,
      contentHash: `hash-${marker}`,
    });
    db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, 0, ?)")
      .run(`concepts/${marker}`, `${marker} ${sentinel}`);
    db.rawDb.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)")
      .run(`concepts/${marker}`, `${marker} ${sentinel}`);

    await withOutputMode("structured", async () => {
      const server = createServer(deps);
      const { parsed, result } = await call(server, "query", { query: marker, strategy: "fts" });
      const blob = `${JSON.stringify(parsed.data)}${JSON.stringify(result.structuredContent)}`;
      if (visible) expect(blob).toContain(sentinel);
      else expect(blob).not.toContain(sentinel);
      expect(blob).not.toContain("\u202E");
    });
  });

  test("frontdoor debug route retains bounded semantic details without routing diagnostics", async () => {
    await withOutputMode("structured", async () => {
      const server = createServer(deps);
      const { parsed } = await call(server, "cbrain_recall", {
        query: "debug 一下主题A在哪些页面出现",
      });
      const data = parsed.data as { details?: Record<string, unknown> };
      expect(data.details).toBeDefined();
      expect(Object.keys(data.details ?? {}).length).toBeGreaterThan(0);
      expect(JSON.stringify(data)).not.toContain("chosen_route");
      expect(JSON.stringify(data)).not.toContain("latency_ms");
    });
  });

  test("frontdoor hierarchy route keeps labels while removing slugs and traversal internals", async () => {
    for (const [slug, title] of [["entity/entity-a", "实体A"], ["entity/entity-b", "实体B"]] as const) {
      db.upsertPage({ slug, type: "entity/person", title, filePath: `${title}.md`, contentHash: `hash-${title}` });
      writeFileSync(join(root, "vault", `${title}.md`), `---\ntitle: ${title}\ntype: entity/person\n---\n`);
    }
    db.rawDb.prepare(
      "INSERT INTO links (from_slug, to_slug, relation, source_type, confidence, trust_state) VALUES (?, ?, 'reports_to', 'manual', 1, 'trusted')",
    ).run("entity/entity-b", "entity/entity-a");

    await withOutputMode("structured", async () => {
      const server = createServer(deps);
      const { parsed } = await call(server, "cbrain_recall", { query: "实体A的下属和组织架构" });
      const blob = JSON.stringify(parsed.data);
      expect(blob).toContain("实体A");
      expect(blob).toContain("实体B");
      expect(blob).not.toContain("entity/entity-");
      expect(blob).not.toContain("parent_slug");
      expect(blob).not.toContain("depth");
    });
  });
});
