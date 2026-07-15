import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OUTPUT_MODE_ENV } from "../../src/mcp/output-mode.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import { JobQueue } from "../../src/core/jobs.js";
import { CBrainDB } from "../../src/storage/sqlite.js";

const PROJECT_ROOT = join(import.meta.dir, "../..");

type AgentFacingRow = {
  case_id?: string;
  input: string;
  category: string;
  expected_tool: string | null;
  expected_args: Record<string, unknown>;
  expected_outcome?: string;
  required_profile?: string;
  forbidden_tools?: string[];
};

function readRows(): AgentFacingRow[] {
  return readFileSync(join(PROJECT_ROOT, "skills/agent-facing.routing-eval.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AgentFacingRow);
}

function createMockEmbedding() {
  return {
    dimensions: 128,
    embed: async (text: string) => ({
      embedding: new Array(128).fill(0).map((_, index) =>
        (text.charCodeAt(index % text.length) ?? 0) / 65536),
      tokenCount: text.length,
    }),
    embedBatch: async (texts: string[]) => texts.map((text) => ({
      embedding: new Array(128).fill(0).map((_, index) =>
        (text.charCodeAt(index % text.length) ?? 0) / 65536),
      tokenCount: text.length,
    })),
  };
}

function createMockLanceDB() {
  return {
    connect: async () => {},
    addChunks: async () => {},
    search: async () => [{
      pageSlug: "entity/anonymous-sentinel",
      chunkIndex: 0,
      content: "匿名检索 Sentinel /tmp/agent-contract-private.txt",
      _distance: 0.05,
    }],
    fullTextSearch: async () => [],
    deleteByPageSlug: async () => {},
    deleteRawChunksByPageSlug: async () => {},
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

async function wireTransport(server: McpServer): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "agent-profile-probe", version: "0.0.0" });
  try {
    await client.connect(clientSide);
  } catch (error) {
    await server.close();
    throw error;
  }
  return {
    client,
    close: async () => {
      try {
        await client.close();
      } finally {
        await server.close();
      }
    },
  };
}

async function withStructuredAgentClient(
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "cbrain-agent-profile-"));
  const vaultPath = join(root, "vault");
  mkdirSync(vaultPath, { recursive: true });
  const previousMode = process.env[OUTPUT_MODE_ENV];
  const startSpy = spyOn(JobQueue.prototype, "start").mockImplementation(() => {});
  let db: CBrainDB | undefined;
  let close: (() => Promise<void>) | undefined;

  try {
    process.env[OUTPUT_MODE_ENV] = "structured";
    const activeDb = new CBrainDB(join(root, "test.sqlite"));
    db = activeDb;
    const deps: CBrainDeps = {
      db: activeDb,
      embedding: createMockEmbedding() as never,
      lance: createMockLanceDB() as never,
      vaultPath,
      runtimePath: join(root, "runtime"),
      toolProfile: "agent",
    };
    const transport = await wireTransport(createServer(deps));
    close = transport.close;
    await run(transport.client);
  } finally {
    try {
      if (close) await close();
    } finally {
      try {
        db?.close();
      } finally {
        try {
          if (existsSync(root)) rmSync(root, { recursive: true });
        } finally {
          try {
            if (previousMode === undefined) delete process.env[OUTPUT_MODE_ENV];
            else process.env[OUTPUT_MODE_ENV] = previousMode;
          } finally {
            startSpy.mockRestore();
          }
        }
      }
    }
  }
}

describe.serial("real Agent-facing MCP profile contract", () => {
  test("real agent tools/list satisfies every executable Agent-facing route", async () => {
    await withStructuredAgentClient(async (client) => {
      const { tools } = await client.listTools();
      const names = new Set(tools.map((tool) => tool.name));
      const rows = readRows();

      const missingExpectedTools = [...new Set(
        rows
          .map((row) => row.expected_tool)
          .filter((tool): tool is string => tool !== null && !names.has(tool)),
      )].sort();
      expect(missingExpectedTools).toEqual([]);
      for (const excluded of ["query", "summarize", "run_discovery"]) {
        expect(names.has(excluded)).toBe(false);
      }
      for (const required of ["cbrain_recall", "next_actions", "read_discoveries"]) {
        expect(names.has(required)).toBe(true);
      }
      expect(names.has("profile")).toBe(true);
      expect(names.has("append_page")).toBe(false);

      const fixedCategoryTools = new Map([
        ["search", "cbrain_recall"],
        ["grounded_recall", "cbrain_recall"],
        ["keyword_debug", "cbrain_recall"],
        ["overview", "cbrain_recall"],
        ["operational", "next_actions"],
      ]);
      for (const [category, expectedTool] of fixedCategoryTools) {
        const categoryRows = rows.filter((row) => row.category === category);
        expect(categoryRows.length).toBeGreaterThan(0);
        for (const row of categoryRows) expect(row.expected_tool).toBe(expectedTool);
      }

      const boundaries = rows.filter((row) => row.expected_tool === null);
      expect(boundaries).toHaveLength(1);
      const [boundary] = boundaries;
      expect(rows.filter((row) => row.case_id === "run_discovery_request")).toEqual([boundary]);
      expect(boundary?.case_id).toBe("run_discovery_request");
      expect(boundary?.category).toBe("profile_boundary");
      expect(boundary?.expected_outcome).toBe("requires_full_profile");
      expect(boundary?.expected_tool).toBeNull();
      expect(boundary?.required_profile).toBe("full");
      expect(boundary?.forbidden_tools).toContain("run_discovery");
      expect(boundary?.forbidden_tools).toContain("read_discoveries");
    });
  });

  test("real fixture tools execute debug and overview routes with specific safe projections", async () => {
    await withStructuredAgentClient(async (client) => {
      const rows = readRows();
      for (const category of ["keyword_debug", "overview"] as const) {
        const row = rows.find((candidate) => candidate.category === category);
        expect(row).toBeDefined();
        if (!row) continue;

        expect(row.expected_tool).toBe("cbrain_recall");
        if (!row.expected_tool) throw new Error(`missing executable tool for ${category}`);
        const result = await client.callTool({
          name: row.expected_tool,
          arguments: { query: row.input, ...row.expected_args },
        });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toBeDefined();
        const structured = result.structuredContent as {
          data?: { details?: Record<string, unknown> };
        };
        const details = structured.data?.details;
        expect(details).toBeDefined();
        if (category === "keyword_debug") {
          expect(details?.result_count).toBeGreaterThan(0);
          expect(details?.results).toBeArray();
          expect((details?.results as unknown[]).length).toBeGreaterThan(0);
        } else {
          expect(details?.topic).toBe(row.input);
          expect(details?.stats).toEqual({ totalEntities: 1, totalLinks: 0, totalEvents: 0 });
        }

        const blob = JSON.stringify({
          content: result.content,
          structuredContent: result.structuredContent,
        });
        for (const forbidden of [
          "raw", "routing", "next_tool", "score", "slug", "body", "stack",
          "search_meta", "strategy_path", "/tmp/agent-contract-private.txt",
        ]) {
          expect(blob).not.toContain(forbidden);
        }
        expect(blob).not.toMatch(/\/(?:[^/"\\\s]+\/)+[^/"\\\s]+/);
      }
    });
  });
});
