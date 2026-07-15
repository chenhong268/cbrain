import { describe, test, expect } from "bun:test";
import { createDeps, type CBrainConfig } from "../../src/cli/context.js";
import type { TrustedVaultBoundary } from "../../src/core/maintenance/misplaced-vault-artifacts.js";

function makeConfig(overrides?: Partial<CBrainConfig>): CBrainConfig {
  return {
    vaultPath: "/tmp/cbrain-test-cli/vault",
    dbPath: "/tmp/cbrain-test-cli/test.sqlite",
    lancePath: "/tmp/cbrain-test-cli/lance",
    runtimePath: "/tmp/cbrain-test-cli/runtime",
    embedding: { provider: "deterministic" },
    ...overrides,
  };
}

describe("createDeps (#252)", () => {
  test("plain synthetic config does not infer a trusted vault boundary", () => {
    const deps = createDeps(makeConfig(), false);
    try {
      expect(deps.vaultBoundary).toBeUndefined();
    } finally {
      deps.db.close();
    }
  });

  test("preserves an explicitly supplied trusted vault boundary by identity", () => {
    const vaultBoundary = {
      configRoot: "/tmp/cbrain-test-cli",
      vaultPath: "/tmp/cbrain-test-cli/vault",
    } as unknown as TrustedVaultBoundary;
    const deps = createDeps(makeConfig(), false, vaultBoundary);
    try {
      expect(deps.vaultBoundary).toBe(vaultBoundary);
    } finally {
      deps.db.close();
    }
  });

  test("createDeps threads nerIngestMode from env into deps", () => {
    process.env.CBRAIN_INGEST_NER_MODE = "defer";
    try {
      // deterministic provider doesn't need an API key
      const config = makeConfig();
      const deps = createDeps(config);
      expect(deps.nerIngestMode).toBe("defer");
      deps.db.close();
    } finally {
      delete process.env.CBRAIN_INGEST_NER_MODE;
    }
  });

  test("createDeps threads nerIngestMode from config when env absent", () => {
    delete process.env.CBRAIN_INGEST_NER_MODE;
    const config = makeConfig({ ner: { ingest_mode: "off" } });
    const deps = createDeps(config);
    expect(deps.nerIngestMode).toBe("off");
    deps.db.close();
  });

  test("createDeps defaults to sync when neither env nor config set", () => {
    delete process.env.CBRAIN_INGEST_NER_MODE;
    const config = makeConfig();
    const deps = createDeps(config);
    expect(deps.nerIngestMode).toBe("sync");
    deps.db.close();
  });

  test("env overrides config", () => {
    process.env.CBRAIN_INGEST_NER_MODE = "defer";
    try {
      const config = makeConfig({ ner: { ingest_mode: "off" } });
      const deps = createDeps(config);
      expect(deps.nerIngestMode).toBe("defer");
      deps.db.close();
    } finally {
      delete process.env.CBRAIN_INGEST_NER_MODE;
    }
  });
});
