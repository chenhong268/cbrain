import type { Command } from "commander";
import { loadConfig, createDeps, resolveRuntimePath } from "../context.js";
import { createServer, registerDreamWorker } from "../../mcp/server.js";
import { buildContext } from "../../mcp/context.js";
import { createHttpServer } from "../../http/server.js";
import { PidLock } from "../../utils/pid-lock.js";
import { WatcherLock } from "../../utils/watcher-lock.js";
import type { FileWatcher } from "../../core/watcher.js";
interface ShutdownHandles {
  httpServer?: { stop(immediate?: boolean): void };
  watcher?: FileWatcher;
  pidLock: PidLock;
  watcherLock?: WatcherLock;
  stopJobs?: () => void;
  stopMcp?: () => void;
}

function installShutdownHandlers(handles: ShutdownHandles): void {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    handles.stopJobs?.();
    handles.stopMcp?.();
    handles.watcher?.stop();
    handles.httpServer?.stop(true);
    handles.watcherLock?.release();
    handles.pidLock.release();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // "exit" fires on process.exit() but NOT on SIGTERM default — lock cleanup only
  process.on("exit", () => {
    handles.watcherLock?.release();
    handles.pidLock.release();
  });
}

async function initWatcher(config: ReturnType<typeof loadConfig>, deps: ReturnType<typeof createDeps>): Promise<{ watcher: FileWatcher; lock: WatcherLock } | undefined> {
  const watcherLock = new WatcherLock(deps.profileDir!);
  const lockResult = watcherLock.tryAcquire();
  if (!lockResult.acquired) {
    console.error(`> Watcher NOT started: ${lockResult.reason}`);
    return undefined;
  }

  const { PageManager } = await import("../../core/page.js");
  const pages = new PageManager(deps.db, config.vaultPath);
  const nerApiKey = config.ner?.llm_api_key ?? config.embedding?.apiKey ?? process.env.ZHIPU_API_KEY;
  const { ZhipuLLMProvider } = await import("../../llm/zhipu.js");
  const { NerEngine } = await import("../../core/ner.js");
  const nerLLM = nerApiKey ? new ZhipuLLMProvider(nerApiKey, config.ner?.llm_base_url, config.ner?.llm_model) : undefined;
  const nerEngine = nerLLM ? new NerEngine(nerLLM) : undefined;
  console.error(`> Watcher NER: ${nerEngine ? "enabled" : "DISABLED (no API key)"}`);
  const { SyncManager } = await import("../../core/sync.js");
  const watcherSync = new SyncManager(deps.db, deps.embedding, deps.lance, { pages, nerEngine });
  const { FileWatcher } = await import("../../core/watcher.js");
  const { Logger } = await import("../../core/logger.js");
  const logger = new Logger(resolveRuntimePath(config));
  const watcher = new FileWatcher(watcherSync, config.vaultPath, { logger, db: deps.db });
  watcher.start();

  console.error("> Auto-sync watcher 已启动 (HTTP)");
  return { watcher, lock: watcherLock };
}

export function register(program: Command) {
  program
    .command("serve")
    .description("Start MCP server (stdio transport)")
    .option("--http", "Start as HTTP server instead of stdio MCP")
    .option("--port <port>", "HTTP port", "3399")
    .option("--force", "Skip PID lock check")
    .action(async (opts) => {
      const config = loadConfig();
      const deps = createDeps(config);

      const pidLock = new PidLock(deps.profileDir!, opts.http ? "http" : "stdio", process.env.CBRAIN_LOCK_ID);
      pidLock.acquire(opts.force);

      if (opts.http) {
        await deps.lance.connect(config.lancePath);
        const warmupResult = await deps.lance.warmup();
        console.error(`> LanceDB warmed up (${warmupResult.elapsedMs}ms, tables: ${warmupResult.tables.join(", ")})`);

        const watcherResult = await initWatcher(config, deps);
        deps.watcher = watcherResult?.watcher;
        const ctx = buildContext(deps);
        registerDreamWorker(ctx);
        const httpApp = createHttpServer(ctx);
        const port = parseInt(opts.port, 10) || 3399;
        const httpServer = httpApp.start(port);
        console.error("> CBrain HTTP Server → http://127.0.0.1:" + port);

        installShutdownHandlers({
          httpServer,
          watcher: watcherResult?.watcher,
          pidLock,
          watcherLock: watcherResult?.lock,
          stopJobs: () => ctx.jobs.stop(),
        });
        return;
      }

      // Load LanceDB + warmup before MCP server starts
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      await deps.lance.connect(config.lancePath);
      const warmupResult = await deps.lance.warmup();
      console.error(`> LanceDB warmed up (${warmupResult.elapsedMs}ms, tables: ${warmupResult.tables.join(", ")})`);

      // ── Pipe resilience for stdio MCP (registered BEFORE connect) ──
      // Hermes 0.16+ sends list_tools() every 180s as keepalive.
      // Fix #164: handlers must be registered BEFORE connect() to avoid TOCTOU.
      process.on("SIGPIPE", () => { /* prevent default termination (Bun kills by default) */ });

      process.stdout.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED" || err.code === "EBADF") {
          console.error("> stdio: stdout pipe closed (client reconnect expected)");
        } else {
          console.error("> stdio: unexpected stdout error", err);
        }
      });

      process.stdin.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED" || err.code === "EBADF") {
          console.error("> stdio: stdin pipe closed (client reconnect expected)");
        } else {
          console.error("> stdio: unexpected stdin error", err);
        }
      });

      const mcpServer = createServer(deps);
      const transport = new StdioServerTransport();

      // Fix #164: when stdin closes (client disconnect), actively close MCP server.
      // Without this, SDK's send() Promise permanently hangs → silent deadlock.
      let pipeDead = false;
      transport.onclose = () => {
        pipeDead = true;
        console.error("> stdio: transport closed");
      };

      const mcpStdin = process.stdin;
      const handlePipeDeath = (reason: string) => {
        if (pipeDead) return;
        pipeDead = true;
        console.error(`> stdio: ${reason}, shutting down MCP server`);
        mcpServer.close().catch(() => {});
        // Exit after brief delay to allow cleanup; Hermes will respawn.
        setTimeout(() => process.exit(0), 500);
      };
      mcpStdin.on("close", () => handlePipeDeath("stdin closed by client"));
      mcpStdin.on("end", () => handlePipeDeath("stdin end-of-stream"));

      const mcpReady = mcpServer.connect(transport).catch((err: unknown) => {
        console.error("> stdio MCP connect failed:", err);
        process.exit(1);
      });
      console.error("> stdio MCP ready (no watcher — use --http for auto-sync)");

      installShutdownHandlers({
        pidLock,
        stopMcp: () => { mcpServer.close().catch(() => {}); },
      });
      await mcpReady;
    });
}
