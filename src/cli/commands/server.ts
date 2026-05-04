import type { Command } from "commander";
import { existsSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { CBrainDB } from "../../storage/sqlite.js";
import { LanceDBManager } from "../../storage/lancedb.js";
import { loadConfig, createDeps } from "../context.js";
import { createServer } from "../../mcp/server.js";

function acquireServeLock(dbDir: string): string {
  const pidFile = join(dbDir, "cbrain.pid");

  if (existsSync(pidFile)) {
    const raw = readFileSync(pidFile, "utf-8").trim();
    const existingPid = parseInt(raw, 10);
    if (!isNaN(existingPid)) {
      try {
        process.kill(existingPid, 0);
        console.error(`cbrain serve 已在运行 (PID ${existingPid})。`);
        console.error(`如需重启，请先执行 kill ${existingPid}。`);
        process.exit(1);
      } catch {
        // PID not alive — stale file, overwrite
      }
    }
  }

  writeFileSync(pidFile, String(process.pid), "utf-8");
  return pidFile;
}

function releaseServeLock(pidFile: string): void {
  try { unlinkSync(pidFile); } catch { /* ignore */ }
}

export function register(program: Command) {
  program
    .command("serve")
    .description("Start MCP server (stdio transport)")
    .action(async () => {
      const config = loadConfig();
      const dbDir = dirname(config.dbPath);
      const pidFile = acquireServeLock(dbDir);

      process.on("exit", () => releaseServeLock(pidFile));
      process.on("SIGINT", () => { releaseServeLock(pidFile); process.exit(0); });
      process.on("SIGTERM", () => { releaseServeLock(pidFile); process.exit(0); });

      const deps = createDeps(config);
      await deps.lance.connect(config.lancePath);
      console.error("> CBrain MCP Server 已启动\n");
      console.error("> Agent 配置（添加到你的 Agent MCP 配置中）：");
      console.error(JSON.stringify({ mcpServers: { cbrain: { command: "cbrain", args: ["serve"], cwd: resolve(config.vaultPath, "..") } } }, null, 2));
      console.error("");
      // Start file watcher — reuse deps' embedding/lance, create SyncManager once
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
      await createServer(deps).connect(new (await import("@modelcontextprotocol/sdk/server/stdio.js")).StdioServerTransport());
    });

}
