import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OUTPUT_MODE_ENV } from "../../src/mcp/output-mode.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import { CBrainDB } from "../../src/storage/sqlite.js";

const PROJECT_ROOT = join(import.meta.dir, "../..");

type AgentFacingRow = {
  input: string;
  category: string;
  expected_tool: string | null;
  expected_args: Record<string, unknown>;
  expected_outcome?: string;
  required_profile?: string;
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
    search: async () => [],
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
      await client.close();
      await server.close();
    },
  };
}

async function withStructuredAgentClient(
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "cbrain-agent-profile-"));
  const vaultPath = join(root, "vault");
  mkdirSync(vaultPath, { recursive: true });
  const db = new CBrainDB(join(root, "test.sqlite"));
  const previousMode = process.env[OUTPUT_MODE_ENV];
  process.env[OUTPUT_MODE_ENV] = "structured";
  let close: (() => Promise<void>) | undefined;

  try {
    const deps: CBrainDeps = {
      db,
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
    if (close) await close();
    db.close();
    if (existsSync(root)) rmSync(root, { recursive: true });
    if (previousMode === undefined) delete process.env[OUTPUT_MODE_ENV];
    else process.env[OUTPUT_MODE_ENV] = previousMode;
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

      for (const category of ["grounded_recall", "operational", "keyword_debug"]) {
        expect(rows.some((row) => row.category === category && row.expected_tool !== null)).toBe(true);
      }

      const boundary = rows.find((row) => row.expected_outcome === "requires_full_profile");
      expect(boundary?.expected_tool).toBeNull();
      expect(boundary?.required_profile).toBe("full");
    });
  });

  test("real cbrain_recall calls execute debug and overview routes without structured leakage", async () => {
    await withStructuredAgentClient(async (client) => {
      const rows = readRows();
      for (const category of ["keyword_debug", "overview"] as const) {
        const row = rows.find((candidate) => candidate.category === category);
        expect(row).toBeDefined();
        if (!row) continue;

        const result = await client.callTool({
          name: "cbrain_recall",
          arguments: { query: row.input, ...row.expected_args },
        });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toBeDefined();
        const blob = JSON.stringify(result);
        for (const forbidden of ["\"raw\"", "routing", "next_tool", "search_meta", "strategy_path"]) {
          expect(blob).not.toContain(forbidden);
        }
      }
    });
  });
});
