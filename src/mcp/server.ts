import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CBrainDB } from "../storage/sqlite.js";
import type { LanceDBManager } from "../storage/lancedb.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import type { LLMProvider } from "../llm/provider.js";
import type { ToolContext } from "./context.js";
import { buildContext } from "./context.js";
import { version } from "../version.js";
import { registerAllTools } from "./register.js";

export interface CBrainDeps {
  db: CBrainDB;
  embedding: EmbeddingProvider;
  lance: LanceDBManager;
  vaultPath: string;
  dbPath?: string;
  llm?: LLMProvider;
  profileDir?: string;
  runtimePath: string;
  watcher?: import("../core/watcher.js").FileWatcher;
  search?: import("../search/provider.js").SearchProvider;
}

/** Register dream job handler and start the background worker. Shared by MCP and HTTP paths. */
export function registerDreamWorker(ctx: ToolContext): void {
  ctx.jobs.register("dream", async (_data, jobId) => {
    const { runDream } = await import("../core/dream.js");
    const { HealthChecker } = await import("../core/health.js");
    const report = await runDream(
      ctx.vaultPath, ctx.db, ctx.sync, ctx.enrich,
      new HealthChecker(ctx.db, ctx.outputsDir, ctx.logger, ctx.vaultPath),
      ctx.outputsDir, ctx.logger, undefined, ctx.dbPath,
      ctx.llm ? { llm: ctx.llm, embedding: ctx.embedding, lance: ctx.lance } : undefined,
      ctx.lance,
      (stage, detail) => { try { ctx.db.updateJobProgress(jobId, stage, detail); } catch { /* non-critical */ } },
    );
    return report;
  });
  ctx.jobs.start();
}

/** Sanitize error message for MCP client — strip paths, SQL details, and stack traces. */
export function sanitizeError(msg: string): string {
  return msg
    .replace(/\/[^\s"'`\]]+\/[^\s"'`\]]+/g, "[path]")  // absolute paths (handles spaces)
    .replace(/\/[a-zA-Z]:[^\s"'`\]]+/g, "[path]")        // Windows paths
    .replace(/\b(SQLite\w*|no such \w+|UNIQUE constraint|FOREIGN KEY|constraint failed|database is locked|disk I\/O)[\s\S]*$/im, "[db-error]")
    .slice(0, 500);
}

export function createServer(deps: CBrainDeps): McpServer {
  const server = new McpServer({
    name: "cbrain",
    version,
  });

  // Unified error wrapper — every tool handler gets try-catch automatically
  const origRegister = server.registerTool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool = (name: string, def: any, handler: (...a: any[]) => Promise<any>) =>
    origRegister(name, def, async (...a: any[]) => {
      try {
        return await handler(...a);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: sanitizeError(msg) }) }],
          isError: true,
        };
      }
    });

  const ctx = buildContext(deps);
  registerAllTools(server, ctx);
  registerDreamWorker(ctx);

  return server;
}

export async function startServer(deps: CBrainDeps): Promise<void> {
  const server = createServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
