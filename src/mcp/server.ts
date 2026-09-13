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
import { registerTopicWorker } from "../core/topics/maintenance.js";
import {
  installMcpValidationErrorBoundary,
  markMcpHandlerInvocation,
} from "./validation-error-boundary.js";

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
  /** #357: attestation of the exact config bytes parsed before dependency creation. */
  rolloutConfigAttestation?: string;
  /** #385: configured identity slug for personal current-state guard. */
  identityPersonSlug?: string;
}

/** Register dream job handler and start the background worker. Shared by MCP and HTTP paths. */
export function registerDreamWorker(ctx: ToolContext): void {
  ctx.jobs.register("dream", async (_data, jobId, execution) => {
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
      execution.checkCancelled,
    );
    return report;
  });
  // #510 Task 2: register the topic worker at this same once-per-runtime
  // site (before the worker loop starts) — never in attachMcpTools, which
  // runs once per HTTP MCP session and would create one timer per session.
  ctx.topicMaintenance = registerTopicWorker({
    db: ctx.db,
    jobs: ctx.jobs,
    pages: ctx.pages,
    pipeline: ctx.pipeline,
    versions: ctx.versions,
    lance: ctx.lance,
    ...(ctx.llm ? { llm: ctx.llm } : {}),
    vaultPath: ctx.vaultPath,
    logger: ctx.logger,
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
      markMcpHandlerInvocation(a);
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
    const callbackIndex = args.length - 1;
    const callback = args[callbackIndex];
    if (typeof callback === "function") {
      args[callbackIndex] = async (...callbackArgs: any[]) => {
        markMcpHandlerInvocation(callbackArgs);
        return await callback(...callbackArgs);
      };
    }
    return origTool(...args);
  };

  try {
    registerAllTools(server, ctx);
  } finally {
    restoreValidationBoundary();
  }
}

export function createServer(deps: CBrainDeps, onContext?: (ctx: ToolContext) => void): McpServer {
  const server = new McpServer({
    name: "cbrain",
    version,
  });
  const ctx = buildContext(deps);
  onContext?.(ctx);
  attachMcpTools(server, ctx);
  registerDreamWorker(ctx);
  // #510 Task 2: owned runtime lifecycle. This server OWNS the job loop and
  // the topic scheduler (the stdio runtime path), so closing it — actively
  // via close() or passively when the transport goes away — must abort and
  // actually drain in-flight topic work (model calls, indexing, rollback
  // compensation) through ONE memoized shutdown promise: concurrent or
  // repeated close() calls all await the same drain and can never observe a
  // "finished" close while the first drain is still running. The original
  // SDK close always still runs. Per-session HTTP MCP servers are built with
  // attachMcpTools only and keep the plain SDK semantics, so a session
  // closing never stops the shared HTTP runtime.
  let ownedShutdown: Promise<void> | null = null;
  const runOwnedShutdown = (): Promise<void> => {
    if (!ownedShutdown) {
      ownedShutdown = (async () => {
        await ctx.topicMaintenance?.stop();
        ctx.jobs.stop();
      })();
    }
    return ownedShutdown;
  };

  const originalClose = server.close.bind(server);
  (server as { close: () => Promise<void> }).close = async (): Promise<void> => {
    try {
      await runOwnedShutdown();
    } finally {
      await originalClose();
    }
  };

  // Passive transport close (client disconnect / EOF) reaches the SDK's
  // public protocol onclose; chain it onto the same drain while preserving
  // any previously-installed handler.
  const protocol = server.server;
  const previousOnclose = protocol.onclose?.bind(protocol);
  protocol.onclose = () => {
    previousOnclose?.();
    void runOwnedShutdown().catch(() => { /* best effort; CLI exit path awaits the drain explicitly */ });
  };
  return server;
}

export async function startServer(deps: CBrainDeps): Promise<void> {
  const server = createServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
