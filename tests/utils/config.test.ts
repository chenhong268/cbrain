import { describe, test, expect, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { loadConfig, applyEnvOverrides } from "../../src/utils/config";

describe("config", () => {
  const configPath = "test-cbrain.config.yaml";

  afterEach(() => {
    if (existsSync(configPath)) unlinkSync(configPath);
    delete process.env.CBRAIN_ZHIPU_API_KEY;
    delete process.env.ZHIPU_API_KEY;
    delete process.env.CBRAIN_VAULT_PATH;
  });

  test("returns defaults when no config file exists", () => {
    const config = loadConfig("/nonexistent/path");
    expect(config.embedding.provider).toBe("zhipu");
    expect(config.embedding.dimensions).toBe(2048);
    expect(config.search.rrf_k).toBe(60);
  });

  test("loads config from yaml file", () => {
    writeFileSync(
      configPath,
      `
vault_path: /tmp/my-vault
embedding:
  api_key: test-key-123
search:
  default_limit: 20
`,
    );
    const config = loadConfig(configPath);
    expect(config.vault_path).toBe("/tmp/my-vault");
    expect(config.embedding.api_key).toBe("test-key-123");
    expect(config.search.default_limit).toBe(20);
    expect(config.embedding.provider).toBe("zhipu");
  });

  test("env vars override config", () => {
    process.env.CBRAIN_ZHIPU_API_KEY = "env-key-456";
    process.env.CBRAIN_VAULT_PATH = "/tmp/env-vault";
    const config = applyEnvOverrides(loadConfig());
    expect(config.embedding.api_key).toBe("env-key-456");
    expect(config.vault_path).toBe("/tmp/env-vault");
  });
});
