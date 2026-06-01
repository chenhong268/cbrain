import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

function runtimeDir(dbPath: string) {
  return join(dirname(dbPath), "runtime");
}

function createMockEmbedding(): EmbeddingProvider {
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
    deleteRawChunksByPageSlug: async () => {},
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

function getTools(server: unknown) {
  return (server as any)._registeredTools as Record<string, any>;
}

async function callTool(server: unknown, name: string, args: Record<string, unknown> = {}) {
  const tools = getTools(server);
  const tool = tools[name];
  if (!tool) throw new Error(`Tool ${name} not found`);
  const result = await tool.handler(args);
  const text = result.content[0].text;
  return JSON.parse(text);
}

const groundedResult = JSON.stringify({
  query: "当时怎么设计的",
  answer: "采用了三层架构方案",
  confidence: "high",
  facts: ["采用了三层架构", "角色分工明确"],
  user_thoughts: ["我觉得需要失败恢复机制"],
  candidates: ["可能有预算约束"],
  conflicts: ["架构选型有分歧"],
  gaps: ["缺失败恢复设计"],
  sources: [{ slug: "entities/xxx", evidence_count: 2 }],
  must_not_claim: [],
});

describe("MCP export_grounded_artifact tool", () => {
  const testDir = "/tmp/cbrain-test-mcp-artifact";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let server: any;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    const deps: CBrainDeps = {
      db,
      embedding: createMockEmbedding(),
      lance: createMockLanceDB() as any,
      vaultPath,
      runtimePath: runtimeDir(dbPath),
    };
    server = createServer(deps);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("tool is registered", () => {
    const tools = getTools(server);
    expect("export_grounded_artifact" in tools).toBe(true);
  });

  test("writes HTML file to artifacts directory", async () => {
    const result = await callTool(server, "export_grounded_artifact", {
      result_json: groundedResult,
      title: "设计回顾",
    });

    expect(result.path).toBeDefined();
    expect(existsSync(result.path)).toBe(true);
    expect(result.path).toContain("artifacts");

    const html = readFileSync(result.path, "utf-8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("设计回顾");
  });

  test("output path is not inside vault", async () => {
    const result = await callTool(server, "export_grounded_artifact", {
      result_json: groundedResult,
    });

    expect(result.path).not.toContain("vault");
  });

  test("returns metadata", async () => {
    const result = await callTool(server, "export_grounded_artifact", {
      result_json: groundedResult,
      title: "测试报告",
    });

    expect(result.path).toBeDefined();
    expect(result.title).toBe("测试报告");
    expect(result.status).toBe("ok");
    expect(result.byte_size).toBeGreaterThan(0);
    expect(result.privacy_gate).toBe("not_required");
  });

  test("privacy gate blocks when social context requested without review", async () => {
    const result = await callTool(server, "export_grounded_artifact", {
      result_json: groundedResult,
      include_social_context: true,
      privacy_reviewed: false,
    });

    expect(result.error).toBe("privacy_gate_blocked");
    expect(result.message).toContain("隐私审查");
  });

  test("privacy gate passes when social context with review", async () => {
    const result = await callTool(server, "export_grounded_artifact", {
      result_json: groundedResult,
      include_social_context: true,
      privacy_reviewed: true,
    });

    expect(result.path).toBeDefined();
    expect(result.privacy_gate).toBe("passed");
    expect(existsSync(result.path)).toBe(true);

    const html = readFileSync(result.path, "utf-8");
    expect(html).toContain("社交情境");
  });

  test("rejects invalid JSON", async () => {
    const result = await callTool(server, "export_grounded_artifact", {
      result_json: "not valid json{{{",
    });

    expect(result.error).toBe("invalid_json");
  });

  test("anonymize produces no raw slugs in output", async () => {
    const result = await callTool(server, "export_grounded_artifact", {
      result_json: groundedResult,
      anonymize: true,
    });

    const html = readFileSync(result.path, "utf-8");
    expect(html).not.toContain("entities/xxx");
  });

  test("path traversal filename returns error", async () => {
    const result = await callTool(server, "export_grounded_artifact", {
      result_json: groundedResult,
      filename: "../escape.html",
    });

    expect(result.error).toBe("invalid_filename");
  });

  test("multi-level path traversal returns error", async () => {
    const result = await callTool(server, "export_grounded_artifact", {
      result_json: groundedResult,
      filename: "../../etc/passwd.html",
    });

    expect(result.error).toBe("invalid_filename");
  });

  test("backslash in filename returns error", async () => {
    const result = await callTool(server, "export_grounded_artifact", {
      result_json: groundedResult,
      filename: "sub\\\\dir.html",
    });

    expect(result.error).toBe("invalid_filename");
  });

  test("filename without .html gets suffix added", async () => {
    const result = await callTool(server, "export_grounded_artifact", {
      result_json: groundedResult,
      filename: "my-report",
    });

    expect(result.path).toBeDefined();
    expect(result.path).toMatch(/my-report\.html$/);
    expect(existsSync(result.path)).toBe(true);
  });

  test("anonymize returns source_labels_only metadata", async () => {
    const result = await callTool(server, "export_grounded_artifact", {
      result_json: groundedResult,
      anonymize: true,
    });

    expect(result.anonymization).toBe("source_labels_only");
  });

  test("no anonymize returns none metadata", async () => {
    const result = await callTool(server, "export_grounded_artifact", {
      result_json: groundedResult,
    });

    expect(result.anonymization).toBe("none");
  });

  test("anonymize HTML includes privacy warning", async () => {
    const result = await callTool(server, "export_grounded_artifact", {
      result_json: groundedResult,
      anonymize: true,
    });

    const html = readFileSync(result.path, "utf-8");
    expect(html).toContain("仅来源标识已匿名");
  });
});
