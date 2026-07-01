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
import type { ToolProfile } from "../../src/mcp/tool-profiles.js";
import { collectRegisteredToolNames } from "../helpers/mcp-inventory";

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

// === #251: tool surface profile gating ============================================

function buildCtxWithProfile(profile: ToolProfile) {
  return buildContext({ ...makeDeps(), toolProfile: profile });
}

async function listToolsWithProfile(profile: ToolProfile): Promise<string[]> {
  const server = new McpServer({ name: "cbrain-test", version: "0.0.0" });
  attachMcpTools(server, buildCtxWithProfile(profile));
  const names = await listToolsViaClient(server);
  return names.sort();
}

async function callToolsViaClient(server: McpServer, names: string[]): Promise<string[]> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "probe", version: "0.0.0" });
  await client.connect(clientSide);
  const out: string[] = [];
  for (const name of names) {
    try {
      const r = await client.callTool({ name, arguments: {} });
      out.push(JSON.stringify(r));
    } catch (e) {
      // SDK may surface a thrown handler error as a JSON-RPC error; capture its text.
      out.push(e instanceof Error ? e.message : String(e));
    }
  }
  await client.close();
  await server.close();
  return out;
}

describe("attachMcpTools profile gating (#251)", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(join(TEST_DIR, "vault"), { recursive: true });
    mkdirSync(join(TEST_DIR, "runtime"), { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("full exposes the complete inventory (no filtering)", async () => {
    const names = await listToolsWithProfile("full");
    const inventory = collectRegisteredToolNames();
    expect(names.length).toBe(inventory.length);
    expect(names).toEqual(inventory);
  });

  test("agent is bounded and excludes low-level/admin tools", async () => {
    const names = await listToolsWithProfile("agent");
    expect(names.length).toBeLessThanOrEqual(20);
    for (const t of ["query", "get_chunks", "dream", "sync", "health", "job_submit"]) {
      expect(names, `agent must exclude ${t}`).not.toContain(t);
    }
    for (const t of ["cbrain_recall", "deep_recall", "ingest", "status"]) {
      expect(names).toContain(t);
    }
  });

  test("maintenance keeps dream + health + job_* + sync reachable", async () => {
    const names = await listToolsWithProfile("maintenance");
    for (const t of ["dream", "dream_status", "dream_reset", "sync", "health", "relation_audit", "job_submit", "status"]) {
      expect(names).toContain(t);
    }
  });

  test("debug includes query + get_chunks + provenance", async () => {
    const names = await listToolsWithProfile("debug");
    for (const t of ["query", "get_chunks", "list_pages", "get_provenance", "set_trust_state", "confirm_evidence"]) {
      expect(names).toContain(t);
    }
  });

  test("legacy server.tool provenance tools are gated (agent excludes, debug includes)", async () => {
    const agent = await listToolsWithProfile("agent");
    const debug = await listToolsWithProfile("debug");
    for (const t of ["get_provenance", "set_trust_state", "confirm_evidence"]) {
      expect(agent).not.toContain(t);
      expect(debug).toContain(t);
    }
  });

  test("createServer (stdio) and attachMcpTools (/mcp session) expose the same surface for the same profile", async () => {
    const stdioNames = (await listToolsViaClient(createServer({ ...makeDeps(), toolProfile: "agent" }))).sort();
    const httpServer = new McpServer({ name: "cbrain-http", version: "0.0.0" });
    attachMcpTools(httpServer, buildCtxWithProfile("agent"));
    const httpNames = (await listToolsViaClient(httpServer)).sort();
    expect(httpNames).toEqual(stdioNames);
  });
});

describe("error sanitization asymmetry — behavioral (#251)", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(join(TEST_DIR, "vault"), { recursive: true });
    mkdirSync(join(TEST_DIR, "runtime"), { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("registerTool handler errors are sanitized; legacy server.tool handler errors are NOT", async () => {
    const server = new McpServer({ name: "cbrain-test", version: "0.0.0" });
    attachMcpTools(server, buildCtxWithProfile("full"));
    // Synthetic fixture message exercising the SQLite + path sanitize rules.
    const RAW = "SQLite: no such table: secrets at /tmp/sanitize-probe/fixture.sqlite3";
    // registerTool path — sanitized via the attachMcpTools wrapper.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool(
      "zzz_register_probe",
      { description: "probe", inputSchema: {} },
      async () => { throw new Error(RAW); },
    );
    // legacy server.tool path — filter-only patch, deliberately NOT wrapped.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).tool(
      "zzz_legacy_probe",
      "probe",
      {},
      async () => { throw new Error(RAW); },
    );
    const [regText, legacyText] = await callToolsViaClient(server, ["zzz_register_probe", "zzz_legacy_probe"]);
    // registerTool output: db-error tail replaced, raw fixture path gone.
    expect(regText).toContain("[db-error]");
    expect(regText).not.toContain("fixture.sqlite3");
    // server.tool output: raw message survives intact (NOT sanitized).
    expect(legacyText).toContain("no such table: secrets");
    expect(legacyText).not.toContain("[db-error]");
  });
});
