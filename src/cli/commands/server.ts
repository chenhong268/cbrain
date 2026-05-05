import type { Command } from "commander";
import { resolve } from "node:path";
import { loadConfig, createDeps } from "../context.js";
import { createServer } from "../../mcp/server.js";
import { buildContext } from "../../mcp/context.js";
import { createHttpServer } from "../../http/server.js";

export function register(program: Command) {
  program
    .command("serve")
    .description("Start MCP server (stdio transport)")
    .option("--http", "Start as HTTP server instead of stdio MCP")
    .option("--port <port>", "HTTP port", "3399")
    .action(async (opts) => {
      const config = loadConfig();
      const deps = createDeps(config);

      if (opts.http) {
        await deps.lance.connect(config.lancePath);
        const ctx = buildContext(deps);
        const { PageManager } = await import("../../core/page.js");
        const pages = new PageManager(deps.db, config.vaultPath);
        const nerApiKey = config.ner?.llm_api_key ?? config.embedding?.apiKey ?? process.env.ZHIPU_API_KEY;
        const { ZhipuLLMProvider } = await import("../../llm/zhipu.js");
        const { NerEngine } = await import("../../core/ner.js");
        const nerLLM = nerApiKey ? new ZhipuLLMProvider(nerApiKey, config.ner?.llm_base_url, config.ner?.llm_model) : undefined;
        const nerEngine = nerLLM ? new NerEngine(nerLLM) : undefined;
        const { SyncManager } = await import("../../core/sync.js");
        const watcherSync = new SyncManager(deps.db, deps.embedding, deps.lance, { pages, nerEngine });
        const { FileWatcher } = await import("../../core/watcher.js");
        new FileWatcher(watcherSync, config.vaultPath).start();
        console.error("> Auto-sync watcher 已启动");
        const server = createHttpServer(ctx);
        const port = parseInt(opts.port) || 3399;
        server.start(port);
        console.error("> CBrain HTTP Server → http://127.0.0.1:" + port);
        return;
      }

      // Start MCP server immediately — LanceDB loads in background
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      const mcpServer = createServer(deps);
      const mcpReady = mcpServer.connect(new StdioServerTransport());

      // Load LanceDB and watcher in background during MCP handshake
      deps.lance.connect(config.lancePath).then(() => {
        console.error("> LanceDB connected");
      });
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
      new FileWatcher(watcherSync, config.vaultPath).start();
      console.error("> Auto-sync watcher 已启动");
      console.error("");
      await mcpReady;
    });

}
