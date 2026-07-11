// #327 Fix 2 — real MCP transport regression test.
//
// The bug (Codex found via real MCP transport): graph_query and get_timeline registered
// outputSchema UNCONDITIONALLY, but the legacy handler returns NO structuredContent.
// The MCP SDK Client validates structuredContent against outputSchema on real transport
// calls (Client.callTool), so every legacy call failed with MCP error -32602. The existing
// direct-handler tests (output-trust-boundary.test.ts) call tool.handler(args) directly,
// bypassing SDK validation — a false green.
//
// This file calls the tools through the REAL protocol: InMemoryTransport + Client.callTool.
// It is the load-bearing contract that would have caught the bug. It runs BOTH modes.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import { OUTPUT_MODE_ENV } from "../../src/mcp/output-mode.js";

// Deterministic mock providers — no network, no LLM. The tools under test (graph_query,
// get_timeline) only touch DB + pages, so the embedding/lance providers are never called.
function createMockEmbedding() {
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
    connect: async () => {}, addChunks: async () => {}, search: async () => [],
    fullTextSearch: async () => [], deleteByPageSlug: async () => {}, deleteRawChunksByPageSlug: async () => {},
    close: async () => {}, createFTSIndex: async () => {},
  };
}
function makeDeps(db: CBrainDB, vaultPath: string, runtimePath: string): CBrainDeps {
  return { db, embedding: createMockEmbedding() as never, lance: createMockLanceDB() as never, vaultPath, runtimePath };
}
function freshRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `cbrain-${label}-`));
}

async function wireTransport(server: McpServer): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "transport-probe", version: "0.0.0" });
  await client.connect(clientSide);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

/** Find a tool's advertised outputSchema (if any) via the real protocol (tools/list). */
async function getToolOutputSchema(client: Client, name: string): Promise<unknown> {
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === name);
  return tool?.outputSchema;
}

interface TextContentItem { type: "text"; text: string }
interface CallToolTransportResult {
  content: TextContentItem[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
/** The SDK callTool return type is index-signature-heavy; narrow to the fields we assert on. */
function asTransportResult(result: { [x: string]: unknown }): CallToolTransportResult {
  return result as unknown as CallToolTransportResult;
}
function firstText(result: CallToolTransportResult): TextContentItem {
  const item = result.content.find((c) => c.type === "text");
  if (!item) throw new Error("no text content item in transport result");
  return item;
}

async function withEnv(key: string, value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { await fn(); } finally {
    if (prev === undefined) delete process.env[key]; else process.env[key] = prev;
  }
}

// ============================================================================
// LEGACY MODE — the regression. Before the fix this threw -32602 on every real call.
// ============================================================================
describe("#327 transport — legacy mode: real Client.callTool does not -32602 (#327 Fix 2)", () => {
  let root: string;
  let db: CBrainDB;
  let deps: CBrainDeps;

  beforeEach(() => {
    root = freshRoot("transport-legacy");
    const vaultPath = join(root, "vault");
    const runtimePath = join(root, "runtime");
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(join(root, "test.sqlite"));
    deps = makeDeps(db, vaultPath, runtimePath);
    // Seed: two pages + a link + a timeline entry (the tools' only data dependencies).
    db.rawDb.prepare("INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)")
      .run("entities/a", "entity/person", "实体A", "a.md", "h1");
    db.rawDb.prepare("INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)")
      .run("entities/b", "entity/person", "实体B", "b.md", "h1");
    db.rawDb.prepare("INSERT OR IGNORE INTO links (from_slug, to_slug, relation, source_type, confidence, trust_state) VALUES (?, ?, ?, 'manual', 0.9, 'candidate')")
      .run("entities/b", "entities/a", "认识");
    db.rawDb.prepare("INSERT INTO timeline (page_slug, summary, event_date, source, trust_state) VALUES (?, ?, ?, 'manual', 'candidate')")
      .run("entities/a", "加入了组织Sentinel", "2025-01-15");
  });
  afterEach(() => {
    db.close();
    if (existsSync(root)) rmSync(root, { recursive: true });
  });

  test("graph_query: callTool succeeds, returns text, NO structuredContent, tool has NO outputSchema", async () => {
    await withEnv(OUTPUT_MODE_ENV, "legacy", async () => {
      const server = createServer(deps);
      const { client, close } = await wireTransport(server);
      try {
        // The load-bearing assertion: before the fix this threw -32602
        // "Tool graph_query has an output schema but did not return structured content".
        const result = asTransportResult(await client.callTool({ name: "graph_query", arguments: { slug: "entities/a", mode: "backlinks" } }));
        expect(result.isError).toBeFalsy();
        expect(result.content.length).toBeGreaterThan(0);
        const textItem = firstText(result);
        const parsed = JSON.parse(textItem.text);
        // legacy envelope shape
        expect(Object.keys(parsed).sort()).toEqual(["display", "raw", "summary"]);
        // NO structuredContent in legacy mode (byte-compat with main)
        expect(result.structuredContent).toBeUndefined();
        // The tool MUST NOT advertise an outputSchema in legacy mode — that's the fix.
        const advertised = await getToolOutputSchema(client, "graph_query");
        expect(advertised).toBeUndefined();
      } finally {
        await close();
      }
    });
  });

  test("get_timeline: callTool succeeds, returns text, NO structuredContent, tool has NO outputSchema", async () => {
    await withEnv(OUTPUT_MODE_ENV, "legacy", async () => {
      const server = createServer(deps);
      const { client, close } = await wireTransport(server);
      try {
        const result = asTransportResult(await client.callTool({ name: "get_timeline", arguments: { slug: "entities/a" } }));
        expect(result.isError).toBeFalsy();
        const textItem = firstText(result);
        const parsed = JSON.parse(textItem.text);
        expect(Object.keys(parsed).sort()).toEqual(["display", "raw", "summary"]);
        expect(result.structuredContent).toBeUndefined();
        const advertised = await getToolOutputSchema(client, "get_timeline");
        expect(advertised).toBeUndefined();
      } finally {
        await close();
      }
    });
  });

  test("graph_query shortest_path: callTool succeeds in legacy mode (no -32602)", async () => {
    await withEnv(OUTPUT_MODE_ENV, "legacy", async () => {
      const server = createServer(deps);
      const { client, close } = await wireTransport(server);
      try {
        const result = asTransportResult(await client.callTool({
          name: "graph_query",
          arguments: { slug: "entities/a", mode: "shortest_path", target: "entities/b" },
        }));
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toBeUndefined();
        firstText(result); // throws if no text content
      } finally {
        await close();
      }
    });
  });
});

// ============================================================================
// STRUCTURED MODE — outputSchema IS advertised and structuredContent is validated.
// ============================================================================
describe("#327 transport — structured mode: real Client.callTool returns validated structuredContent (#327 Fix 2)", () => {
  let root: string;
  let db: CBrainDB;
  let deps: CBrainDeps;

  beforeEach(() => {
    root = freshRoot("transport-structured");
    const vaultPath = join(root, "vault");
    const runtimePath = join(root, "runtime");
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(join(root, "test.sqlite"));
    deps = makeDeps(db, vaultPath, runtimePath);
    db.rawDb.prepare("INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)")
      .run("entities/a", "entity/person", "实体A", "a.md", "h1");
    db.rawDb.prepare("INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)")
      .run("entities/b", "entity/person", "实体B", "b.md", "h1");
    db.rawDb.prepare("INSERT OR IGNORE INTO links (from_slug, to_slug, relation, source_type, confidence, trust_state) VALUES (?, ?, ?, 'manual', 0.9, 'candidate')")
      .run("entities/b", "entities/a", "认识");
    db.rawDb.prepare("INSERT INTO timeline (page_slug, summary, event_date, source, trust_state) VALUES (?, ?, ?, 'manual', 'candidate')")
      .run("entities/a", "加入了组织Sentinel", "2025-01-15");
  });
  afterEach(() => {
    db.close();
    if (existsSync(root)) rmSync(root, { recursive: true });
  });

  test("graph_query: callTool succeeds, returns structuredContent, tool DOES advertise outputSchema", async () => {
    await withEnv(OUTPUT_MODE_ENV, "structured", async () => {
      const server = createServer(deps);
      const { client, close } = await wireTransport(server);
      try {
        const result = asTransportResult(await client.callTool({ name: "graph_query", arguments: { slug: "entities/a", mode: "backlinks" } }));
        expect(result.isError).toBeFalsy();
        // structuredContent IS present and validates against the advertised outputSchema
        // (Client.callTool would have thrown -32602 if it didn't validate).
        expect(result.structuredContent).toBeDefined();
        const sc = result.structuredContent as Record<string, unknown>;
        expect(sc.schema_version).toBe(1);
        const advertised = await getToolOutputSchema(client, "graph_query");
        expect(advertised).toBeDefined();
      } finally {
        await close();
      }
    });
  });

  test("get_timeline: callTool succeeds, returns structuredContent, tool DOES advertise outputSchema", async () => {
    await withEnv(OUTPUT_MODE_ENV, "structured", async () => {
      const server = createServer(deps);
      const { client, close } = await wireTransport(server);
      try {
        const result = asTransportResult(await client.callTool({ name: "get_timeline", arguments: { slug: "entities/a" } }));
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toBeDefined();
        const sc = result.structuredContent as Record<string, unknown>;
        expect(sc.schema_version).toBe(1);
        expect(Array.isArray((sc.data as { events: unknown[] }).events)).toBe(true);
        const advertised = await getToolOutputSchema(client, "get_timeline");
        expect(advertised).toBeDefined();
      } finally {
        await close();
      }
    });
  });

  test("graph_query shortest_path: structuredContent validates in structured mode", async () => {
    await withEnv(OUTPUT_MODE_ENV, "structured", async () => {
      const server = createServer(deps);
      const { client, close } = await wireTransport(server);
      try {
        const result = asTransportResult(await client.callTool({
          name: "graph_query",
          arguments: { slug: "entities/a", mode: "shortest_path", target: "entities/b" },
        }));
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toBeDefined();
        const sc = result.structuredContent as Record<string, unknown>;
        expect(sc.schema_version).toBe(1);
      } finally {
        await close();
      }
    });
  });
});
