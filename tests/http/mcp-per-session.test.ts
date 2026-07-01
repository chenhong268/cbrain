import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildContext } from "../../src/mcp/context.js";
import type { CBrainDeps } from "../../src/mcp/server.js";
import { createHttpServer } from "../../src/http/server.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { DeterministicEmbeddingProvider } from "../../src/embedding/deterministic.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import { collectRegisteredToolNames } from "../helpers/mcp-inventory";

const TEST_DIR = "/tmp/cbrain-test-per-session";
const PROTOCOL_VERSION = "2025-11-25";

function makeDeps(): CBrainDeps {
  const dbPath = join(TEST_DIR, "brain.sqlite");
  const vaultPath = join(TEST_DIR, "vault");
  const runtimePath = join(TEST_DIR, "runtime");
  return {
    db: new CBrainDB(dbPath),
    embedding: new DeterministicEmbeddingProvider(),
    lance: new LanceDBManager(),
    vaultPath,
    dbPath,
    runtimePath,
  };
}

describe("HTTP /mcp per-session tool profiles (#260)", () => {
  let httpServer: ReturnType<ReturnType<typeof createHttpServer>["start"]>;
  let endpoint: URL;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(join(TEST_DIR, "vault"), { recursive: true });
    mkdirSync(join(TEST_DIR, "runtime"), { recursive: true });
    const ctx = buildContext(makeDeps()); // default toolProfile = "full"
    httpServer = createHttpServer(ctx).start(0);
    endpoint = new URL(`http://127.0.0.1:${httpServer.port}/mcp`);
  });
  afterEach(() => {
    httpServer.stop(true);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  async function listTools(profileHeader?: string): Promise<string[]> {
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: profileHeader ? { headers: { "X-CBrain-Tool-Profile": profileHeader } } : {},
    });
    const client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close();
    return tools.map((t) => t.name).sort();
  }

  test("client A (header agent) → bounded ≤20, excludes admin/low-level tools", async () => {
    const names = await listTools("agent");
    expect(names.length).toBeLessThanOrEqual(20);
    for (const t of ["query", "get_chunks", "dream", "sync", "health", "job_submit"]) {
      expect(names, `agent must exclude ${t}`).not.toContain(t);
    }
    for (const t of ["cbrain_recall", "deep_recall", "ingest", "status"]) {
      expect(names).toContain(t);
    }
  });

  test("client B (header maintenance) → dream/health/job_* reachable, no agent frontdoor", async () => {
    const names = await listTools("maintenance");
    for (const t of ["dream", "dream_status", "dream_reset", "health", "sync", "job_submit", "status"]) {
      expect(names, `maintenance must include ${t}`).toContain(t);
    }
    expect(names).not.toContain("cbrain_recall");
  });

  test("client C (no header, no metadata) → full inventory", async () => {
    const names = await listTools();
    const inventory = collectRegisteredToolNames();
    expect(names.length).toBe(inventory.length);
    expect(names).toEqual(inventory);
  });

  test("client D (header bogus) → initialize rejected, no session created", async () => {
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { "X-CBrain-Tool-Profile": "bogus" } },
    });
    const client = new Client({ name: "e2e-bad", version: "0.0.0" });
    await expect(client.connect(transport)).rejects.toThrow();
  });

  test("client E (initialize _meta.cbrainToolProfile=debug) → session established (metadata path)", async () => {
    // SDK client cannot inject params._meta, so hand-fire initialize like the maintenance wrapper.
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "meta-probe", version: "1.0" },
          _meta: { cbrainToolProfile: "debug" },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
    // Tool-surface correctness for metadata→debug is covered jointly by
    // resolveSessionProfile unit tests (metadata→debug) and attach-tools.test.ts (debug→query/get_chunks).
  });

  test("client F (agent session) → dream unreachable; profile fixed for session", async () => {
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { "X-CBrain-Tool-Profile": "agent" } },
    });
    const client = new Client({ name: "e2e-fixed", version: "0.0.0" });
    await client.connect(transport);
    // dream is gated out of agent and the profile is fixed at initialize — a later
    // tools/call (which carries no profile header) still cannot reach dream. The SDK
    // surfaces unknown-tool as either a thrown error or an isError result, so accept both.
    let threw = false;
    let result: { isError?: boolean } | undefined;
    try {
      result = await client.callTool({ name: "dream", arguments: {} }) as { isError?: boolean };
    } catch {
      threw = true;
    }
    expect(threw || result?.isError === true).toBe(true);
    await client.close();
  });

  test("three sessions on one runtime get three different surfaces (acceptance #8)", async () => {
    const [agent, maint, full] = await Promise.all([
      listTools("agent"),
      listTools("maintenance"),
      listTools(),
    ]);
    expect(agent).not.toEqual(maint);
    expect(agent).not.toEqual(full);
    expect(maint).not.toEqual(full);
    expect(full.length).toBeGreaterThan(agent.length);
    expect(full.length).toBeGreaterThan(maint.length);
  });
});
