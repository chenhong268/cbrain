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
import type { IngestNerMode } from "../cli/context.js";
import { TOOL_PROFILE_ALLOWLISTS, type ToolProfile } from "./tool-profiles.js";
import type { TrustedVaultBoundary } from "../core/maintenance/misplaced-vault-artifacts.js";
import { installMcpValidationErrorBoundary } from "./validation-error-boundary.js";

export interface CBrainDeps {
  db: CBrainDB;
  embedding: EmbeddingProvider;
  lance: LanceDBManager;
  vaultPath: string;
  vaultBoundary?: TrustedVaultBoundary;
  dbPath?: string;
  llm?: LLMProvider;
  profileDir?: string;
  runtimePath: string;
  watcher?: import("../core/maintenance/watcher.js").FileWatcher;
  search?: import("../search/provider.js").SearchProvider;
  /** #252: resolved ingest NER mode (env > config > sync), threaded into buildContext. */
  nerIngestMode?: IngestNerMode;
  /** #251: resolved MCP tool surface profile (env > full), threaded into buildContext. */
  toolProfile?: ToolProfile;
}

/** Register dream job handler and start the background worker. Shared by MCP and HTTP paths. */
export function registerDreamWorker(ctx: ToolContext): void {
  ctx.jobs.register("dream", async (_data, jobId) => {
    const { runDream } = await import("../core/maintenance/dream.js");
    const { HealthChecker } = await import("../core/maintenance/health.js");
    const report = await runDream(
      ctx.vaultPath, ctx.db, ctx.sync, ctx.enrich,
      new HealthChecker(ctx.db, ctx.outputsDir, ctx.logger, ctx.vaultPath, ctx.vaultBoundary),
      ctx.outputsDir, ctx.logger, undefined, ctx.dbPath,
      ctx.llm ? { llm: ctx.llm, embedding: ctx.embedding, lance: ctx.lance } : undefined,
      ctx.lance,
      (stage, detail) => { try { ctx.db.updateJobProgress(jobId, stage, detail); } catch { /* non-critical */ } },
      ctx.pages,        // sharedPages (#252)
      ctx.pipeline,     // nerPipeline (#252)
      ctx.llm,          // deferred entity facts (#321)
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

/**
 * Install the sanitizeError wrapper + register every CBrain tool onto a McpServer.
 * Shared by stdio (`createServer`) and HTTP-MCP per-session servers (issue #213) so
 * tool behavior is byte-identical across transports — there is no second routing path.
 * Pure registration: does not build context, start jobs, or open anything.
 *
 * NOTE (issue #213 review): registerDreamWorker is deliberately NOT called here — it
 * must run exactly once per runtime, not once per MCP session.
 */
export function attachMcpTools(server: McpServer, ctx: ToolContext): void {
  const profile: ToolProfile = ctx.toolProfile ?? "full";
  const gate = profile === "full" ? null : new Set(TOOL_PROFILE_ALLOWLISTS[profile]);
  const restoreValidationBoundary = installMcpValidationErrorBoundary(server, ctx.logger);

  // registerTool: error-sanitize (unchanged) + profile gate (#251).
  // Gating happens BEFORE the sanitized handler is registered, so tools that pass
  // the gate keep byte-identical error-sanitization behavior. `full` (gate=null)
  // skips the check entirely → identical to pre-#251 behavior.
  const origRegister = server.registerTool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool = (name: string, def: any, handler: (...a: any[]) => Promise<any>) => {
    if (gate && !gate.has(name)) return; // #251: profile-filtered, skip registration
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
  };

  // server.tool: profile gate ONLY (#251). Deliberately NO try-catch — the 3 legacy
  // provenance tools are not error-sanitized today and the issue forbids changing
  // handler behavior. This patch is filter-only.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const origTool: (...args: any[]) => unknown = server.tool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).tool = (...args: any[]) => {
    const name = args[0];
    if (gate && typeof name === "string" && !gate.has(name)) return; // #251: filtered
    return origTool(...args);
  };

  try {
    registerAllTools(server, ctx);
  } finally {
    restoreValidationBoundary();
  }
}

export function createServer(deps: CBrainDeps): McpServer {
  const server = new McpServer({
    name: "cbrain",
    version,
  });
  const ctx = buildContext(deps);
  attachMcpTools(server, ctx);
  registerDreamWorker(ctx);
  return server;
}

export async function startServer(deps: CBrainDeps): Promise<void> {
  const server = createServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
