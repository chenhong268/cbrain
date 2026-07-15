import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CBrainDB } from "../storage/sqlite.js";
import { LanceDBManager } from "../storage/lancedb.js";
import { ZhipuEmbeddingProvider } from "../embedding/zhipu.js";
import { DeterministicEmbeddingProvider } from "../embedding/deterministic.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import { ZhipuLLMProvider } from "../llm/zhipu.js";
import type { CBrainDeps } from "../mcp/server.js";
import { resolveToolProfile } from "../mcp/tool-profiles.js";
import type { NerMode } from "../core/ingestion/ner-write-path.js";
import type { TrustedVaultBoundary } from "../core/maintenance/misplaced-vault-artifacts.js";

const CONFIG_FILE = "cbrain.json";

export interface CBrainConfig {
  vaultPath: string;
  dbPath: string;
  lancePath: string;
  runtimePath?: string;
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
    /** #252: ingest NER mode — sync (default) | defer | off. */
    ingest_mode?: "sync" | "defer" | "off";
  };
  reflect?: {
    llm_provider?: string;
    llm_model?: string;
    llm_api_key?: string;
    llm_base_url?: string;
    /** #238: DeepSeek request timeout in ms (default 30000). */
    timeoutMs?: number;
    /** #238: per-stage candidate cap (default 15). */
    maxEntities?: number;
    /** #238: total LLM-call budget across one reflect run (default 24). */
    maxLlmCalls?: number;
  };
  search?: {
    provider?: string; // "searxng"
    base_url?: string; // e.g. "http://localhost:8080"
  };
}

export interface LoadedCBrainConfig {
  config: CBrainConfig;
  configPath: string;
  configRoot: string;
}

export type IngestNerMode = NerMode;

const VALID_INGEST_NER_MODES = new Set<IngestNerMode>(["sync", "defer", "off"]);

/** #252: env > config > "sync". Invalid values fall back to "sync" (never throw). */
export function resolveIngestNerMode(env?: string, configMode?: string): IngestNerMode {
  const envMode = env?.trim().toLowerCase();
  if (envMode && VALID_INGEST_NER_MODES.has(envMode as IngestNerMode)) return envMode as IngestNerMode;
  if (envMode) {
    console.warn(`[cbrain] Invalid CBRAIN_INGEST_NER_MODE="${env}", falling back to sync.`);
  }
  if (configMode && VALID_INGEST_NER_MODES.has(configMode as IngestNerMode)) return configMode as IngestNerMode;
  if (configMode) {
    console.warn(`[cbrain] Invalid ner.ingest_mode="${configMode}" in config, falling back to sync.`);
  }
  return "sync";
}

export function resolveRuntimePath(config: CBrainConfig): string {
  if (config.runtimePath) return resolve(config.runtimePath);
  return join(dirname(resolve(config.dbPath)), "runtime");
}

class ConfigNotFoundError extends Error {
  constructor(
    readonly explicitPath?: string,
  ) {
    super(explicitPath
      ? `CBRAIN_CONFIG=${explicitPath} not found.`
      : `No ${CONFIG_FILE} found.`);
  }
}

function resolveConfigPath(startDir: string, explicitPath?: string): string {
  if (explicitPath) {
    const candidate = resolve(startDir, explicitPath);
    if (!existsSync(candidate)) throw new ConfigNotFoundError(explicitPath);
    return realpathSync(candidate);
  }

  let current = resolve(startDir);
  while (true) {
    const candidate = join(current, CONFIG_FILE);
    if (existsSync(candidate)) return realpathSync(candidate);
    const parent = resolve(current, "..");
    if (parent === current) throw new ConfigNotFoundError();
    current = parent;
  }
}

function loadResolvedConfig(startDir: string, explicitPath?: string): LoadedCBrainConfig {
  const configPath = resolveConfigPath(startDir, explicitPath);
  return {
    config: JSON.parse(readFileSync(configPath, "utf-8")),
    configPath,
    configRoot: dirname(configPath),
  };
}

function exitConfigNotFound(error: ConfigNotFoundError): never {
  if (error.explicitPath) {
    console.error(`Error: CBRAIN_CONFIG=${error.explicitPath} not found.`);
  } else {
    console.error("Error: No cbrain.json found. Run `cbrain init` first.");
  }
  process.exit(1);
}

export function loadConfigWithPath(
  startDir = process.cwd(),
  explicitPath = process.env.CBRAIN_CONFIG,
): LoadedCBrainConfig {
  try {
    return loadResolvedConfig(startDir, explicitPath);
  } catch (error) {
    if (error instanceof ConfigNotFoundError) exitConfigNotFound(error);
    throw error;
  }
}

export function findConfig(startDir = process.cwd()): CBrainConfig | null {
  try {
    return loadResolvedConfig(startDir).config;
  } catch (error) {
    if (error instanceof ConfigNotFoundError) return null;
    throw error;
  }
}

export function loadConfigSafe(
  startDir = process.cwd(),
  explicitPath = process.env.CBRAIN_CONFIG,
): LoadedCBrainConfig | null {
  try {
    return loadResolvedConfig(startDir, explicitPath);
  } catch {
    return null;
  }
}

export function loadConfig(): CBrainConfig {
  return loadConfigWithPath().config;
}

export function createDeps(
  config: CBrainConfig,
  requireEmbedding = true,
  vaultBoundary?: TrustedVaultBoundary,
): CBrainDeps {
  const db = new CBrainDB(config.dbPath);
  const embeddingProvider = config.embedding.provider ?? "zhipu";
  const isDeterministic = embeddingProvider === "deterministic";
  const apiKey = config.embedding.apiKey ?? process.env.ZHIPU_API_KEY;
  // (#204) deterministic provider is in-process: no credentials, no socket.
  // Production "zhipu" still requires an API key.
  if (!apiKey && requireEmbedding && !isDeterministic) {
    console.error("Error: ZHIPU_API_KEY not set (env or cbrain.json).");
    process.exit(1);
  }
  const embedding: EmbeddingProvider = isDeterministic
    ? new DeterministicEmbeddingProvider()
    : apiKey
      ? new ZhipuEmbeddingProvider(apiKey, config.embedding.baseUrl)
      : (undefined as unknown as EmbeddingProvider);
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

  // Search provider (optional — graceful degradation when absent)
  let search: CBrainDeps["search"];
  if (config.search?.provider === "searxng" && config.search.base_url) {
    const { SearXNGSearchProvider } = require("../search/provider.js");
    search = new SearXNGSearchProvider(config.search.base_url);
  }

  const nerIngestMode = resolveIngestNerMode(process.env.CBRAIN_INGEST_NER_MODE, config.ner?.ingest_mode);
  const toolProfile = resolveToolProfile(process.env.CBRAIN_MCP_TOOL_PROFILE);
  return { db, embedding, lance, vaultPath: config.vaultPath, vaultBoundary, dbPath: config.dbPath, llm, profileDir, runtimePath: resolveRuntimePath(config), search: search ?? undefined, nerIngestMode, toolProfile };
}
