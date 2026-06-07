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
}

function installShutdownHandlers(handles: ShutdownHandles): void {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    handles.stopJobs?.();
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

      const mcpServer = createServer(deps);
      const transport = new StdioServerTransport();

      // ── Pipe resilience for stdio MCP ──────────────────────────
      // Hermes 0.16+ sends list_tools() every 180s as keepalive.
      // When the client reopens the pipe, the old write emits EPIPE/SIGPIPE.
      // Without handlers the process crashes silently.
      //
      // Fix #164: StdioServerTransport.send() never rejects, so a broken
      // pipe leaves every send() Promise forever pending → silent deadlock.
      // Mitigations:
      //   1. TOCTOU-free: register ALL error/close handlers BEFORE connect()
      //   2. Active cleanup on stdin close/end — the most reliable indicator
      //      that the client pipe is gone.
      //   3. Send timeout — wraps every transport send with a 5 s deadline so
      //      pending Promises are eventually unblocked.
      //   4. mcpReady .catch() — handles unhandled rejection on connect failure.
      process.on("SIGPIPE", () => { /* prevent default termination */ });
      process.stdout.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED" || err.code === "EBADF") {
          console.error("> stdio: stdout pipe closed (client reconnect expected)");
          // Best-effort: close transport so pending sends are unblocked
          transport.close().catch(() => {});
        } else {
          console.error("> stdio: unexpected stdout error", err);
        }
      });
      // stdin close/end are the primary signals that the client has detached.
      const handlePipeBreak = async () => {
        console.error("> stdio: stdin closed (client disconnected)");
        try { await transport.close(); } catch { /* already closed */ }
      };
      process.stdin.on("close", handlePipeBreak);
      process.stdin.on("end", handlePipeBreak);
      // Also catch errors for observability (EPIPE can surface on stdin)
      process.stdin.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") {
          console.error("> stdio: stdin error (client disconnect expected)");
        } else {
          console.error("> stdio: unexpected stdin error", err);
        }
      });

      // Wrap transport.send() with a 5-second timeout to prevent silent deadlock.
      // StdioServerTransport.send() never rejects; without a timeout a broken
      // pipe leaves every pending send() Promise forever waiting.
      const SEND_TIMEOUT_MS = 5000;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const originalSend = (transport as any).send.bind(transport);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (transport as any).send = async (message: any) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error("MCP send timeout after " + SEND_TIMEOUT_MS + "ms — pipe may be broken"));
          }, SEND_TIMEOUT_MS);
          originalSend(message)
            .then(resolve)
            .catch(reject)
            .finally(() => clearTimeout(timer));
        });
      };

      const mcpReady = mcpServer.connect(transport);
      // Handle connect failures to prevent unhandled promise rejection
      mcpReady.catch((err) => {
        console.error("> stdio: MCP connect failed", err);
      });

      // stdio MCP: watcher NOT started here — only HTTP server starts watcher
      console.error("> stdio MCP ready (no watcher — use --http for auto-sync)");

      installShutdownHandlers({ pidLock });
      await mcpReady;
    });
}
