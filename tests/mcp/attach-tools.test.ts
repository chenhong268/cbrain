import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer, attachMcpTools } from "../../src/mcp/server.js";
import { buildContext } from "../../src/mcp/context.js";
import type { CBrainDeps } from "../../src/mcp/server.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { DeterministicEmbeddingProvider } from "../../src/embedding/deterministic.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";

const TEST_DIR = "/tmp/cbrain-test-attach-tools";

function makeDeps(): CBrainDeps {
  const dbPath = join(TEST_DIR, "brain.sqlite");
  const vaultPath = join(TEST_DIR, "vault");
  const runtimePath = join(TEST_DIR, "runtime");
  const db = new CBrainDB(dbPath);
  return {
    db,
    embedding: new DeterministicEmbeddingProvider(),
    lance: new LanceDBManager(),
    vaultPath,
    dbPath,
    runtimePath,
  };
}

async function listToolsViaClient(server: McpServer): Promise<string[]> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "probe", version: "0.0.0" });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  await client.close();
  await server.close();
  return names;
}

describe("attachMcpTools (shared registration, issue #213)", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(join(TEST_DIR, "vault"), { recursive: true });
    mkdirSync(join(TEST_DIR, "runtime"), { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("attachMcpTools registers the full tool set onto a bare McpServer", async () => {
    const server = new McpServer({ name: "cbrain-test", version: "0.0.0" });
    const ctx = buildContext(makeDeps());
    attachMcpTools(server, ctx);
    const names = await listToolsViaClient(server);
    expect(names.length).toBeGreaterThan(20); // CBrain registers 30+ tool groups
    expect(names).toContain("status");
  });

  test("createServer (stdio path) and attachMcpTools expose the same representative tools", async () => {
    // createServer registers via attachMcpTools internally + runs registerDreamWorker once.
    const stdioServer = createServer(makeDeps());
    const stdioNames = await listToolsViaClient(stdioServer);

    const httpServer = new McpServer({ name: "cbrain-http", version: "0.0.0" });
    attachMcpTools(httpServer, buildContext(makeDeps()));
    const httpNames = await listToolsViaClient(httpServer);

    // Same registration path → identical tool set (stdio may add dream tools on top, so
    // assert the HTTP set is a subset of stdio AND both contain the representative tools).
    expect(stdioNames).toContain("status");
    expect(httpNames).toContain("status");
    for (const name of httpNames) {
      expect(stdioNames).toContain(name);
    }
  });
});
