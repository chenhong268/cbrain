import type { Command } from "commander";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CBrainDB } from "../../storage/sqlite.js";
import { LanceDBManager } from "../../storage/lancedb.js";
import { loadConfig, createDeps } from "../context.js";
import { createServer } from "../../mcp/server.js";

export function register(program: Command) {
  program
    .command("serve")
    .description("Start MCP server (stdio transport)")
    .action(async () => {
      const config = loadConfig();
      const deps = createDeps(config);
      await deps.lance.connect(config.lancePath);
      console.error("> CBrain MCP Server 已启动\n");
      console.error("> Agent 配置（添加到你的 Agent MCP 配置中）：");
      console.error(JSON.stringify({ mcpServers: { cbrain: { command: "cbrain", args: ["serve"], cwd: resolve(config.vaultPath, "..") } } }, null, 2));
      console.error("");
      await createServer(deps).connect(new (await import("@modelcontextprotocol/sdk/server/stdio.js")).StdioServerTransport());
    });

  program
    .command("watch")
    .description("Watch vault for changes and auto-sync (daemon)")
    .action(async () => {
      const config = loadConfig();
      const db = new CBrainDB(config.dbPath);
      const apiKey = config.embedding.apiKey ?? process.env.ZHIPU_API_KEY;
      if (!apiKey) { console.error("Error: ZHIPU_API_KEY not set."); process.exit(1); }
      const embedding = new (await import("../../embedding/zhipu.js")).ZhipuEmbeddingProvider(apiKey, config.embedding.baseUrl);
      const lance = new LanceDBManager();
      await lance.connect(config.lancePath);
      const { SyncManager } = await import("../../core/sync.js");
      const sync = new SyncManager(db, embedding, lance);
      const { FileWatcher } = await import("../../core/watcher.js");
      const watcher = new FileWatcher(sync, config.vaultPath);
      watcher.start();
      console.log(`Watching ${config.vaultPath}`);
    });
}
