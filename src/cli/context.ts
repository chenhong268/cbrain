import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CBrainDB } from "../storage/sqlite.js";
import { LanceDBManager } from "../storage/lancedb.js";
import { ZhipuEmbeddingProvider } from "../embedding/zhipu.js";
import { ZhipuLLMProvider } from "../llm/zhipu.js";
import type { CBrainDeps } from "../mcp/server.js";

const CONFIG_FILE = "cbrain.json";

export interface CBrainConfig {
  vaultPath: string;
  dbPath: string;
  lancePath: string;
  embedding: {
    provider: string;
    apiKey?: string;
    baseUrl?: string;
  };
  ner?: {
    enabled?: boolean;
    llm_provider?: string;
    llm_model?: string;
    llm_api_key?: string;
    llm_base_url?: string;
  };
  reflect?: {
    llm_provider?: string;
    llm_model?: string;
    llm_api_key?: string;
    llm_base_url?: string;
  };
}

export function findConfig(startDir?: string): CBrainConfig | null {
  const dir = startDir ?? process.cwd();
  const configPath = join(dir, CONFIG_FILE);
  if (existsSync(configPath)) {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  }
  const parent = resolve(dir, "..");
  if (parent === dir) return null;
  return findConfig(parent);
}

export function loadConfig(): CBrainConfig {
  // 1. CBRAIN_CONFIG: explicit path to config file (no search)
  if (process.env.CBRAIN_CONFIG) {
    const p = process.env.CBRAIN_CONFIG;
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
    console.error(`Error: CBRAIN_CONFIG=${p} not found.`);
    process.exit(1);
  }
  // 2. Search upward from cwd
  const config = findConfig();
  if (!config) {
    console.error("Error: No cbrain.json found. Run `cbrain init` first.");
    process.exit(1);
  }
  return config;
}

export function createDeps(config: CBrainConfig, requireEmbedding = true): CBrainDeps {
  const db = new CBrainDB(config.dbPath);
  const apiKey = config.embedding.apiKey ?? process.env.ZHIPU_API_KEY;
  if (!apiKey && requireEmbedding) {
    console.error("Error: ZHIPU_API_KEY not set (env or cbrain.json).");
    process.exit(1);
  }
  const embedding = apiKey
    ? new ZhipuEmbeddingProvider(apiKey, config.embedding.baseUrl)
    : (undefined as unknown as ZhipuEmbeddingProvider);
  const lance = new LanceDBManager();

  const nerEnabled = config.ner?.enabled !== false;
  const nerApiKey = config.ner?.llm_api_key ?? apiKey ?? process.env.ZHIPU_API_KEY;
  const llm = (nerEnabled && nerApiKey)
    ? (() => {
        const provider = config.ner?.llm_provider;
        if (provider === "deepseek") {
          const { DeepSeekLLMProvider } = require("../llm/deepseek.js");
          return new DeepSeekLLMProvider(nerApiKey, config.ner?.llm_base_url, config.ner?.llm_model);
        }
        return new ZhipuLLMProvider(nerApiKey, config.ner?.llm_base_url, config.ner?.llm_model);
      })()
    : undefined;

  const profileDir = dirname(resolve(config.dbPath));

  return { db, embedding, lance, vaultPath: config.vaultPath, llm, profileDir };
}
