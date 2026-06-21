import type { Command } from "commander";
import { loadConfig, createDeps, resolveRuntimePath } from "../context.js";
import { createServer, registerDreamWorker } from "../../mcp/server.js";
import { buildContext } from "../../mcp/context.js";
import { createHttpServer } from "../../http/server.js";
import { PidLock, evaluateWriterGate, type WriterOwner } from "../../utils/pid-lock.js";
import { WatcherLock } from "../../utils/watcher-lock.js";
import { DEFAULT_STOP_DEADLINE_MS, type FileWatcher } from "../../core/watcher.js";
import { dirname, resolve } from "node:path";
export interface ShutdownHandles {
  httpServer?: { stop(immediate?: boolean): void };
  watcher?: FileWatcher;
  pidLock: PidLock;
  watcherLock?: WatcherLock;
  stopJobs?: () => void;
  stopMcp?: () => void;
}

/** Bounded deadline for draining watcher sync work on shutdown. */
export const SHUTDOWN_DRAIN_MS = DEFAULT_STOP_DEADLINE_MS;

/**
 * Ordered graceful shutdown. Pure: touches no `process` globals, so it is
 * unit-testable. Ordering (issue #186): stop accepting work → stop HTTP →
 * drain the watcher (ownership locks still held) → release locks. A sync error
 * during drain is caught so it can never skip lock release; the timeout
 * diagnostic exposes only counts — never paths or content.
 */
export async function performGracefulShutdown(
  handles: ShutdownHandles,
  drainDeadlineMs: number = SHUTDOWN_DRAIN_MS,
): Promise<void> {
  // 1. Stop accepting new work.
  handles.stopJobs?.();
  handles.stopMcp?.();

  // 2. Stop HTTP from accepting new sync-triggering requests.
  handles.httpServer?.stop(true);

  // 3. Drain watcher in-flight work while ownership locks are still held.
  if (handles.watcher) {
    try {
      const result = await handles.watcher.stop(drainDeadlineMs);
      if (!result.drained) {
        console.error(
          `> watcher drain timed out after ${drainDeadlineMs}ms ` +
          `(active=${result.activeCount}, pending=${result.pendingCount}); ` +
          `in-flight sync may be interrupted on exit`,
        );
      }
    } catch (e: unknown) {
      console.error("> watcher drain failed:", e instanceof Error ? e.message : String(e));
    }
  }

  // 4. Release ownership locks only after drain completes (or deadline).
  handles.watcherLock?.release();
  handles.pidLock.release();
}

function installShutdownHandlers(handles: ShutdownHandles): void {
  let shuttingDown = false;
  const run = (): void => {
    if (shuttingDown) return;
    shuttingDown = true; // idempotent SIGINT/SIGTERM
    void performGracefulShutdown(handles).finally(() => {
      // Force exit after the sequence completes so an async drain can't hang forever.
      // The "exit" handler below best-effort releases locks too.
      process.exit(0);
    });
  };

  process.on("SIGTERM", run);
  process.on("SIGINT", run);
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

/**
 * Fail-fast diagnostic when the profile-wide writer gate denies startup (issue #208).
 * Emits PID, transport, lockId, startedAt, and concrete remediation. Sanitized: only
 * operational fields (pid/transport/profile dir) — never vault content or file bodies.
 */
function reportWriterConflict(profileDir: string, owners: WriterOwner[]): void {
  const lines = owners.map((o) => {
    const lock = o.lockId ? `  lockId=${o.lockId}` : "";
    return `    PID ${o.pid}   transport=${o.transport}${lock}   started ${o.startedAt.toISOString()}`;
  });
  console.error(
    "✗ CBrain refused to start: another write-capable runtime owns this profile.\n" +
    `\n  Profile: ${profileDir}\n` +
    `\n  Active writer(s):\n${lines.join("\n")}\n` +
    "\n  Only ONE write-capable CBrain runtime may open this profile at a time (issue #208).\n" +
    "  Concurrent writers corrupt brain.sqlite and the LanceDB index.\n" +
    "\n  Suggested fix:\n" +
    "    1. If a writer above is stale (process crashed), delete its pid file and retry.\n" +
    "    2. For multi-agent access, run ONE `cbrain serve --http` and connect agents to it.\n" +
    "    3. Emergency rescue ONLY (will corrupt data): CBRAIN_UNSAFE_ALLOW_MULTI_WRITER=1",
  );
}

export function register(program: Command) {
  program
    .command("serve")
    .description("Start MCP server (stdio transport)")
    .option("--http", "Start as HTTP server instead of stdio MCP")
    .option("--port <port>", "HTTP port", "3399")
    .option("--force", "Skip stale PID cleanup (does NOT bypass writer gate)")
    .action(async (opts) => {
      const config = loadConfig();
      const profileDir = dirname(resolve(config.dbPath));

      // ── profile-wide single-writer gate (issue #208) ──
      // MUST run before createDeps() opens SQLite and before lance.connect().
      const gate = evaluateWriterGate(profileDir, {
        unsafeBypass: process.env.CBRAIN_UNSAFE_ALLOW_MULTI_WRITER === "1",
      });
      if (gate.cleanedStale.length > 0) {
        console.error(`> Cleaned ${gate.cleanedStale.length} stale CBrain pid file(s) before start`);
      }
      if (!gate.allow) {
        reportWriterConflict(profileDir, gate.owners);
        process.exit(1);
      }
      if (gate.bypassed) {
        console.error(
          "⚠️ UNSAFE: CBRAIN_UNSAFE_ALLOW_MULTI_WRITER=1 — writer gate BYPASSED; " +
          "concurrent writes WILL corrupt brain.sqlite/LanceDB. Not for production.",
        );
      }

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
