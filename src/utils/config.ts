import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export interface CBrainConfig {
  vault_path: string;
  db_path: string;
  lancedb_path: string;
  embedding: {
    provider: string;
    model: string;
    dimensions: number;
    api_key: string;
    base_url: string;
  };
  ner: {
    enabled: boolean;
    llm_provider: string;
    llm_model: string;
    llm_api_key: string;
    llm_base_url: string;
  };
  search: {
    default_limit: number;
    rrf_k: number;
  };
}

const DEFAULT_CONFIG: CBrainConfig = {
  vault_path: "./vault",
  db_path: "./cbrain.sqlite",
  lancedb_path: "./.lance",
  embedding: {
    provider: "zhipu",
    model: "embedding-3",
    dimensions: 2048,
    api_key: "",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
  },
  ner: {
    enabled: true,
    llm_provider: "zhipu",
    llm_model: "glm-4-flash",
    llm_api_key: "",
    llm_base_url: "https://open.bigmodel.cn/api/paas/v4",
  },
  search: {
    default_limit: 10,
    rrf_k: 60,
  },
};

export function loadConfig(configPath?: string): CBrainConfig {
  const envDir = process.env.CBRAIN_DIR;
  const paths = [
    configPath,
    envDir && resolve(envDir, "cbrain.json"),
    envDir && resolve(envDir, "cbrain.config.yaml"),
    "cbrain.json",
    "cbrain.config.local.yaml",
    "cbrain.config.yaml",
  ].filter(Boolean) as string[];

  for (const p of paths) {
    if (existsSync(p)) {
      const raw = readFileSync(p, "utf-8");
      const parsed = (p.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw)) as Partial<CBrainConfig>;
      return mergeConfig(DEFAULT_CONFIG, normalizeJsonConfig(parsed));
    }
  }

  return { ...DEFAULT_CONFIG };
}

interface NormalizedConfig {
  vault_path?: string;
  db_path?: string;
  lancedb_path?: string;
  embedding?: Partial<CBrainConfig["embedding"]>;
  ner?: Partial<CBrainConfig["ner"]>;
  search?: Partial<CBrainConfig["search"]>;
}

function normalizeJsonConfig(raw: Record<string, unknown>): NormalizedConfig {
  return {
    vault_path: (raw.vaultPath ?? raw.vault_path) as string | undefined,
    db_path: (raw.dbPath ?? raw.db_path) as string | undefined,
    lancedb_path: (raw.lancePath ?? raw.lancedb_path ?? raw.lancedbPath) as string | undefined,
    embedding: raw.embedding as NormalizedConfig["embedding"],
    ner: raw.ner as NormalizedConfig["ner"],
    search: raw.search as NormalizedConfig["search"],
  };
}

function mergeConfig(
  base: CBrainConfig,
  override: NormalizedConfig,
): CBrainConfig {
  return {
    ...base,
    ...override,
    vault_path: override.vault_path
      ? resolve(override.vault_path)
      : base.vault_path,
    db_path: override.db_path ? resolve(override.db_path) : base.db_path,
    lancedb_path: override.lancedb_path
      ? resolve(override.lancedb_path)
      : base.lancedb_path,
    embedding: { ...base.embedding, ...override.embedding },
    ner: { ...base.ner, ...override.ner },
    search: { ...base.search, ...override.search },
  };
}

export function applyEnvOverrides(config: CBrainConfig): CBrainConfig {
  const envApiKey =
    process.env.CBRAIN_ZHIPU_API_KEY || process.env.ZHIPU_API_KEY;
  if (envApiKey) {
    config.embedding.api_key = envApiKey;
    config.ner.llm_api_key = envApiKey;
  }
  const envVault = process.env.CBRAIN_VAULT_PATH;
  if (envVault) {
    config.vault_path = resolve(envVault);
  }
  return config;
}
