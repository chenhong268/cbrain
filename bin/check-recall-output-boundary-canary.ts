import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DeterministicEmbeddingProvider } from "../src/embedding/deterministic.js";
import { createHttpServer } from "../src/http/server.js";
import { buildContext } from "../src/mcp/context.js";
import { OUTPUT_MODE_ENV } from "../src/mcp/output-mode.js";
import type { CBrainDeps } from "../src/mcp/server.js";
import { CBrainDB } from "../src/storage/sqlite.js";
import { LanceDBManager } from "../src/storage/lancedb.js";

export interface RecallOutputBoundaryCanaryResult {
  ok: boolean;
  calls: number;
  directSchemasAdvertised: number;
  defaultAuditCount: number;
  temporaryStateRemoved: boolean;
  outputModeRestored: boolean;
}

interface RecallOutputBoundaryCanaryOptions {
  failAt?: "after-root" | "after-lance" | "after-env" | "after-server";
}

interface CallResult {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export async function runRecallOutputBoundaryCanary(
  options: RecallOutputBoundaryCanaryOptions = {},
): Promise<RecallOutputBoundaryCanaryResult> {
  const root = mkdtempSync(join(tmpdir(), "cbrain-recall-canary-"));
  let db: CBrainDB | undefined;
  let lance: LanceDBManager | undefined;
  let httpServer: ReturnType<ReturnType<typeof createHttpServer>["start"]> | undefined;
  let client: Client | undefined;
  let calls = 0;
  let defaultAuditCount = 0;
  let directSchemasAdvertised = 0;
  const originalMode = process.env[OUTPUT_MODE_ENV];

  try {
    if (options.failAt === "after-root") throw new Error("injected canary startup failure");
    const vaultPath = join(root, "vault");
    const runtimePath = join(root, "runtime");
    mkdirSync(vaultPath, { recursive: true });
    mkdirSync(runtimePath, { recursive: true });

    db = new CBrainDB(join(root, "brain.sqlite"));
    lance = new LanceDBManager();
    await lance.connect(join(root, "lancedb"));
    if (options.failAt === "after-lance") throw new Error("injected canary startup failure");
    const deps: CBrainDeps = {
      db,
      embedding: new DeterministicEmbeddingProvider(),
      lance,
      vaultPath,
      dbPath: join(root, "brain.sqlite"),
      runtimePath,
      toolProfile: "full",
    };

    process.env[OUTPUT_MODE_ENV] = "structured";
    let ctx: ReturnType<typeof buildContext>;
    try {
      if (options.failAt === "after-env") throw new Error("injected canary startup failure");
      ctx = buildContext(deps);
    } finally {
      if (originalMode === undefined) delete process.env[OUTPUT_MODE_ENV];
      else process.env[OUTPUT_MODE_ENV] = originalMode;
    }

    httpServer = createHttpServer(ctx).start(0);
    if (options.failAt === "after-server") throw new Error("injected canary startup failure");
    const endpoint = new URL(`http://127.0.0.1:${httpServer.port}/mcp`);
    client = new Client({ name: "recall-output-canary", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { "X-CBrain-Tool-Profile": "full" } },
    }));
    const listed = await client.listTools();
    for (const name of ["query", "deep_recall", "cbrain_recall"]) {
      if (!listed.tools.some((tool) => tool.name === name)) throw new Error(`missing canary tool: ${name}`);
    }
    directSchemasAdvertised = ["query", "deep_recall"].filter(
      (name) => listed.tools.find((tool) => tool.name === name)?.outputSchema !== undefined,
    ).length;
    if (directSchemasAdvertised !== 2) throw new Error("direct recall/query schemas were not advertised");
    if (listed.tools.find((tool) => tool.name === "cbrain_recall")?.outputSchema !== undefined) {
      throw new Error("frontdoor advertised a loose output schema");
    }

    const cases = [
      ["query", { query: "主题A" }],
      ["deep_recall", { query: "主题A" }],
      ["cbrain_recall", { query: "主题A之前讨论过吗" }],
    ] as const;

    for (const [name, args] of cases) {
      const result = await client.callTool({ name, arguments: args }) as unknown as CallResult;
      if (result.isError) throw new Error(`${name} returned an MCP error`);
      if (result.structuredContent?.schema_version !== 1) throw new Error(`${name} missing structured schema version`);
      const text = result.content.find((item) => item.type === "text")?.text;
      if (!text) throw new Error(`${name} missing text content`);
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed.raw !== undefined) throw new Error(`${name} exposed top-level raw`);
      if (parsed.audit !== undefined) defaultAuditCount += 1;
      calls += 1;
    }

  } finally {
    await client?.close().catch(() => {});
    httpServer?.stop(true);
    await lance?.close().catch(() => {});
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
  return {
    ok: true,
    calls,
    directSchemasAdvertised,
    defaultAuditCount,
    temporaryStateRemoved: !existsSync(root),
    outputModeRestored: process.env[OUTPUT_MODE_ENV] === originalMode,
  };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await runRecallOutputBoundaryCanary(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
