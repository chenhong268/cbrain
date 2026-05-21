import type { Command } from "commander";
import { join } from "node:path";
import { loadConfig, createDeps } from "../context.js";
import { createServer } from "../../mcp/server.js";
import { buildContext } from "../../mcp/context.js";
import { createHttpServer } from "../../http/server.js";
import { PidLock } from "../../utils/pid-lock.js";

async function initWatcher(config: ReturnType<typeof loadConfig>, deps: ReturnType<typeof createDeps>): Promise<void> {
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
  const logger = new Logger(join(config.vaultPath, "outputs"));
  new FileWatcher(watcherSync, config.vaultPath, { logger }).start();
  console.error("> Auto-sync watcher 已启动");
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

      const lock = new PidLock(deps.profileDir!, opts.http ? "http" : "stdio");
      lock.acquire(opts.force);
      const cleanup = () => lock.release();
      process.on("SIGTERM", cleanup);
      process.on("SIGINT", cleanup);
      process.on("exit", cleanup);

      if (opts.http) {
        await deps.lance.connect(config.lancePath);
        const warmupResult = await deps.lance.warmup();
        console.error(`> LanceDB warmed up (${warmupResult.elapsedMs}ms, tables: ${warmupResult.tables.join(", ")})`);
        const ctx = buildContext(deps);
        await initWatcher(config, deps);
        const server = createHttpServer(ctx);
        const port = parseInt(opts.port) || 3399;
        server.start(port);
        console.error("> CBrain HTTP Server → http://127.0.0.1:" + port);
        return;
      }

      // Load LanceDB + warmup before MCP server starts
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      await deps.lance.connect(config.lancePath);
      const warmupResult = await deps.lance.warmup();
      console.error(`> LanceDB warmed up (${warmupResult.elapsedMs}ms, tables: ${warmupResult.tables.join(", ")})`);

      const mcpServer = createServer(deps);
      const mcpReady = mcpServer.connect(new StdioServerTransport());
      await initWatcher(config, deps);
      console.error("");
      await mcpReady;
    });

}
