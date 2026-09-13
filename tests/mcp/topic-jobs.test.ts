import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { PageManager } from "../../src/core/page.js";
import { createServer, attachMcpTools, type CBrainDeps } from "../../src/mcp/server.js";
import { buildContext, type ToolContext } from "../../src/mcp/context.js";
import { performGracefulShutdown } from "../../src/cli/commands/server.js";
import type { TopicMaintenance } from "../../src/core/topics/maintenance.js";
import type { LLMProvider, ChatMessage } from "../../src/llm/provider.js";

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
    connect: async () => {},
    addChunks: async () => {},
    search: async () => [],
    fullTextSearch: async () => [],
    deleteByPageSlug: async () => {},
    deleteRawChunksByPageSlug: async () => {},
    deleteL1VectorByPageSlug: async () => {},
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

/** Real anonymous record files on disk (discovery is DB-only, but the
 *  compiler reads sources from the vault — raw DB rows would exit
 *  source_not_found before any model call). */
function seedRealTaggedRecords(db: CBrainDB, vaultPath: string) {
  const pages = new PageManager(db, vaultPath);
  for (let i = 0; i < 3; i++) {
    pages.create({ title: `匿名记录${i}`, type: "record", body: `匿名记录${i}的正文材料。`, tags: ["主题D"] });
  }
}

function getTools(server: unknown) {
  return (server as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }> })._registeredTools;
}

async function callTool(server: unknown, name: string, args: Record<string, unknown> = {}) {
  const tools = getTools(server);
  const tool = tools[name];
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool.handler(args);
}

async function waitJobDone(db: CBrainDB, id: number, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const job = db.getJob(id);
    if (job && (job.status === "done" || job.status === "failed")) return job;
    if (Date.now() - start > timeoutMs) throw new Error(`job ${id} did not finish`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("topic-wiki jobs through the MCP job tool", () => {
  const testDir = "/tmp/cbrain-test-mcp-topic-jobs";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  const runtimePath = join(testDir, "runtime");
  let db: CBrainDB;
  let deps: CBrainDeps;
  let capturedCtx: ToolContext | undefined;
  let maintenance: TopicMaintenance | undefined;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    deps = {
      db,
      embedding: createMockEmbedding() as never,
      lance: createMockLanceDB() as never,
      vaultPath,
      runtimePath,
    };
    capturedCtx = undefined;
    maintenance = undefined;
  });

  afterEach(async () => {
    if (maintenance) await maintenance.stop();
    capturedCtx?.jobs.stop();
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function seedThreeTaggedRecords() {
    for (let i = 0; i < 3; i++) {
      db.rawDb.prepare(
        "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run(`records/rec-${i}`, "record", `匿名记录${i}`, `records/rec-${i}.md`, `h${i}`);
      db.rawDb.prepare("INSERT OR IGNORE INTO tags (page_slug, tag) VALUES (?, ?)").run(`records/rec-${i}`, "主题D");
    }
  }

  test("createServer exposes topic maintenance exactly once per runtime via the context hook", () => {
    const server = createServer(deps, (ctx) => { capturedCtx = ctx; });
    // The hook fires during construction (before registerDreamWorker assigns
    // the field); the runtime registration is observable on the context
    // afterwards — exactly one scheduler per runtime.
    maintenance = capturedCtx?.topicMaintenance;
    expect(maintenance).toBeDefined();
    expect(capturedCtx?.topicMaintenance).toBe(maintenance);
    // attachMcpTools-only contexts (HTTP MCP sessions) never get a scheduler.
    const sessionCtx = buildContext(deps);
    const sessionServer = new McpServer({ name: "cbrain-session", version: "0" });
    attachMcpTools(sessionServer, sessionCtx);
    expect(sessionCtx.topicMaintenance).toBeUndefined();
    expect(getTools(server).job).toBeDefined();
  });

  test("submit preview through the job tool returns candidates once the queue executes it", async () => {
    seedThreeTaggedRecords();
    const server = createServer(deps, (ctx) => { capturedCtx = ctx; });
    maintenance = capturedCtx?.topicMaintenance;
    const result = (await callTool(server, "job", {
      action: "submit",
      name: "topic-wiki",
      data: { action: "preview" },
    })) as { content: Array<{ text: string }> };
    const receipt = JSON.parse(result.content[0].text) as { id: number; name: string; status: string };
    expect(receipt.name).toBe("topic-wiki");
    expect(receipt.status).toBe("pending");
    const job = await waitJobDone(db, receipt.id);
    expect(job.status).toBe("done");
    const report = JSON.parse(job.result!) as { candidates: Array<{ key: string; support: number }> };
    const candidate = report.candidates.find((c) => c.key === "tag:主题D");
    expect(candidate?.support).toBe(3);
  });

  test("submit disable applies immediate control semantics and keeps the job receipt", async () => {
    seedThreeTaggedRecords();
    const server = createServer(deps, (ctx) => { capturedCtx = ctx; });
    maintenance = capturedCtx?.topicMaintenance;
    const refresh = (await callTool(server, "job", {
      action: "submit",
      name: "topic-wiki",
      data: { action: "refresh" },
    })) as { content: Array<{ text: string }> };
    const refreshId = (JSON.parse(refresh.content[0].text) as { id: number }).id;
    expect(db.getJob(refreshId)!.status).toBe("pending");

    const disable = (await callTool(server, "job", {
      action: "submit",
      name: "topic-wiki",
      data: { action: "disable" },
    })) as { content: Array<{ text: string }> };
    const disableReceipt = JSON.parse(disable.content[0].text) as { id: number; name: string };
    expect(disableReceipt.name).toBe("topic-wiki");
    // The pending refresh was cancelled immediately; the disable audit row exists.
    expect(db.getJob(refreshId)!.status).toBe("cancelled");
    expect(db.getJob(disableReceipt.id)).not.toBeNull();
    expect(db.getConfig("topic.enabled")).toBe("false");
  });

  test("submit enable with oversized candidateKeys is rejected without enqueueing", async () => {
    const server = createServer(deps, (ctx) => { capturedCtx = ctx; });
    maintenance = capturedCtx?.topicMaintenance;
    const result = (await callTool(server, "job", {
      action: "submit",
      name: "topic-wiki",
      data: { action: "enable", candidateKeys: ["a", "b", "c", "d", "e", "f"] },
    })) as { content: Array<{ text: string }>; isError?: boolean };
    const parsed = JSON.parse(result.content[0].text) as { success?: boolean; code?: string; id?: number };
    expect(parsed.success).toBe(false);
    expect(parsed.code).toBe("TOPIC_JOB_INVALID_DATA");
    expect(db.listJobs().filter((j) => j.name === "topic-wiki")).toHaveLength(0);
  });

  test("graceful shutdown stops topic maintenance before the job loop", async () => {
    const order: string[] = [];
    await performGracefulShutdown({
      pidLock: { release: () => { order.push("pidLock"); } } as never,
      stopJobs: () => { order.push("stopJobs"); },
      stopTopicMaintenance: () => { order.push("stopTopics"); },
    });
    expect(order.indexOf("stopTopics")).toBeLessThan(order.indexOf("stopJobs"));
    expect(order[order.length - 1]).toBe("pidLock");
  });

  test("owned createServer close aborts and drains active topic model work", async () => {
    seedRealTaggedRecords(db, vaultPath);
    let enteredResolve!: () => void;
    let release!: () => void;
    let capturedSignal: AbortSignal | undefined;
    const entered = new Promise<void>((r) => { enteredResolve = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const hangLlm: LLMProvider = {
      name: "close-drain-llm",
      chat: async (_messages: ChatMessage[], options?: { signal?: AbortSignal }) => {
        capturedSignal = options?.signal;
        enteredResolve();
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(new Error("cancelled"));
          if (capturedSignal?.aborted) return onAbort();
          capturedSignal?.addEventListener("abort", onAbort, { once: true });
          gate.then(() => {
            capturedSignal?.removeEventListener("abort", onAbort);
            resolve();
          }).catch(() => {});
        });
        throw new Error("test release");
      },
    };
    let closeCtx: ToolContext | undefined;
    db.setConfig("topic.enabled", "true"); // startup reconciliation enqueues immediately at construction
    const server = createServer(
      { ...deps, llm: hangLlm, runtimePath: join(testDir, "runtime-close") },
      (ctx) => { closeCtx = ctx; capturedCtx = ctx; },
    );
    maintenance = closeCtx?.topicMaintenance;
    await entered; // the background job loop is inside the hanging model call

    await server.close(); // owned runtime close: must abort AND drain, not just the transport
    expect(capturedSignal?.aborted).toBe(true);
    expect(db.listPageSlugs({ type: "topic" })).toHaveLength(0);
    release();
    await maintenance!.stop();
    // Closing is idempotent and still performs the SDK close.
    await server.close();
  });

  test("passive transport close also triggers the owned topic drain", async () => {
    seedRealTaggedRecords(db, vaultPath);
    let enteredResolve!: () => void;
    let release!: () => void;
    let capturedSignal: AbortSignal | undefined;
    const entered = new Promise<void>((r) => { enteredResolve = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const hangLlm: LLMProvider = {
      name: "passive-close-llm",
      chat: async (_messages: ChatMessage[], options?: { signal?: AbortSignal }) => {
        capturedSignal = options?.signal;
        enteredResolve();
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(new Error("cancelled"));
          if (capturedSignal?.aborted) return onAbort();
          capturedSignal?.addEventListener("abort", onAbort, { once: true });
          gate.then(() => {
            capturedSignal?.removeEventListener("abort", onAbort);
            resolve();
          }).catch(() => {});
        });
        throw new Error("test release");
      },
    };
    let closeCtx: ToolContext | undefined;
    db.setConfig("topic.enabled", "true");
    const server = createServer(
      { ...deps, llm: hangLlm, runtimePath: join(testDir, "runtime-passive") },
      (ctx) => { closeCtx = ctx; capturedCtx = ctx; },
    );
    maintenance = closeCtx?.topicMaintenance;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "probe-client", version: "0" });
    await client.connect(clientTransport);
    await entered; // in-flight topic model work under a connected transport

    await client.close(); // the CLIENT goes away — no server.close() call
    await new Promise((r) => setTimeout(r, 300)); // passive onclose chains the drain
    expect(capturedSignal?.aborted).toBe(true);
    expect(db.listPageSlugs({ type: "topic" })).toHaveLength(0);
    release();
  });

  test("graceful shutdown against a live maintenance stops future scheduling", async () => {
    seedThreeTaggedRecords();
    createServer(deps, (ctx) => { capturedCtx = ctx; });
    maintenance = capturedCtx?.topicMaintenance;
    // Enable and let one scheduled cycle run to completion (no topics to write).
    db.setConfig("topic.enabled", "true");
    const id = db.rawDb.prepare(
      "INSERT INTO jobs (name, data) VALUES ('topic-wiki', ?)"
    ).run(JSON.stringify({ action: "refresh", scheduled: true }));
    const job = await waitJobDone(db, Number(id.lastInsertRowid));
    expect(job.status).toBe("done");

    await performGracefulShutdown({
      pidLock: { release: () => {} } as never,
      stopTopicMaintenance: () => maintenance!.stop(),
    });
    expect(maintenance!.tick(Date.now() + 24 * 60 * 60_000)).toBe(false);
  });
});
