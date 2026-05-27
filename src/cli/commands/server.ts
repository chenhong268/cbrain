import type { Command } from "commander";
import { loadConfig, createDeps, resolveRuntimePath } from "../context.js";
import { createServer } from "../../mcp/server.js";
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
}

function installShutdownHandlers(handles: ShutdownHandles): void {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
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
        const httpApp = createHttpServer(ctx);
        const port = parseInt(opts.port, 10) || 3399;
        const httpServer = httpApp.start(port);
        console.error("> CBrain HTTP Server → http://127.0.0.1:" + port);

        installShutdownHandlers({
          httpServer,
          watcher: watcherResult?.watcher,
          pidLock,
          watcherLock: watcherResult?.lock,
        });
        return;
      }

      // Load LanceDB + warmup before MCP server starts
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      await deps.lance.connect(config.lancePath);
      const warmupResult = await deps.lance.warmup();
      console.error(`> LanceDB warmed up (${warmupResult.elapsedMs}ms, tables: ${warmupResult.tables.join(", ")})`);

      const mcpServer = createServer(deps);
      const mcpReady = mcpServer.connect(new StdioServerTransport());
      // stdio MCP: watcher NOT started here — only HTTP server starts watcher
      console.error("> stdio MCP ready (no watcher — use --http for auto-sync)");

      installShutdownHandlers({ pidLock });
      await mcpReady;
    });
}
