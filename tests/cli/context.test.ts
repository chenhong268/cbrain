import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { createDeps, type CBrainConfig } from "../../src/cli/context.js";
import type { TrustedVaultBoundary } from "../../src/core/maintenance/misplaced-vault-artifacts.js";
import { OllamaEmbeddingProvider } from "../../src/embedding/ollama.js";
import { ZhipuEmbeddingProvider } from "../../src/embedding/zhipu.js";

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

  test("keeps a loaded config paired with its exact-byte rollout attestation", () => {
    const attestation = "a".repeat(64);
    const config = makeConfig();
    const deps = createDeps({
      config,
      configPath: "/tmp/cbrain-test-cli/cbrain.json",
      configRoot: "/tmp/cbrain-test-cli",
      rolloutConfigAttestation: attestation,
    }, false);
    try {
      expect(deps.vaultPath).toBe(config.vaultPath);
      expect(deps.rolloutConfigAttestation).toBe(attestation);
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

// #544: explicit provider branching. Local Ollama must be selectable without a
// cloud credential, an unknown provider must fail closed, and the legacy
// Zhipu / deterministic behaviour must be unchanged.
describe("embedding provider selection (#544)", () => {
  function withoutCloudKey<T>(fn: () => T): T {
    const saved = process.env.ZHIPU_API_KEY;
    delete process.env.ZHIPU_API_KEY;
    try {
      return fn();
    } finally {
      if (saved === undefined) delete process.env.ZHIPU_API_KEY;
      else process.env.ZHIPU_API_KEY = saved;
    }
  }

  test("ollama is selectable with no cloud credential and reports 1024 dims", () => {
    withoutCloudKey(() => {
      const deps = createDeps(makeConfig({ embedding: { provider: "ollama" } }), true);
      try {
        expect(deps.embedding).toBeInstanceOf(OllamaEmbeddingProvider);
        expect(deps.embedding.dimensions).toBe(1024);
      } finally {
        deps.db.close();
      }
    });
  });

  test("ollama accepts a custom base URL and model", () => {
    withoutCloudKey(() => {
      const deps = createDeps(makeConfig({
        embedding: {
          provider: "ollama",
          baseUrl: "http://127.0.0.1:12345",
          model: "qwen3-embedding:0.6b",
        },
      }), true);
      try {
        expect(deps.embedding).toBeInstanceOf(OllamaEmbeddingProvider);
      } finally {
        deps.db.close();
      }
    });
  });

  test("an unknown provider is rejected before any DB handle is opened", () => {
    const dbPath = `/tmp/cbrain-test-cli/unknown-provider-${process.pid}.sqlite`;
    if (existsSync(dbPath)) {
      throw new Error(`test precondition failed: ${dbPath} already exists`);
    }
    expect(() =>
      createDeps(
        makeConfig({ dbPath, embedding: { provider: "not-a-provider" } }),
        false,
      ),
    ).toThrow(/Unknown embedding\.provider "not-a-provider"/);
    expect(existsSync(dbPath)).toBe(false);
  });

  test("zhipu stays the default and still requires a key", () => {
    const deps = createDeps(makeConfig({ embedding: { provider: "zhipu", apiKey: "k" } }), true);
    try {
      expect(deps.embedding).toBeInstanceOf(ZhipuEmbeddingProvider);
    } finally {
      deps.db.close();
    }
  });

  test("an omitted provider defaults to the zhipu branch", () => {
    const config = makeConfig();
    config.embedding = { provider: undefined as unknown as string, apiKey: "k" };
    const deps = createDeps(config, true);
    try {
      expect(deps.embedding).toBeInstanceOf(ZhipuEmbeddingProvider);
    } finally {
      deps.db.close();
    }
  });

  test("deterministic stays credential-free and in-process", () => {
    withoutCloudKey(() => {
      const deps = createDeps(makeConfig({ embedding: { provider: "deterministic" } }), true);
      try {
        expect(deps.embedding.constructor.name).toBe("DeterministicEmbeddingProvider");
      } finally {
        deps.db.close();
      }
    });
  });

  test("local embedding does not disable an independently configured NER LLM", () => {
    withoutCloudKey(() => {
      const deps = createDeps(makeConfig({
        embedding: { provider: "ollama" },
        ner: { llm_api_key: "ner-only-key", llm_model: "glm-4-flash" },
      }), true);
      try {
        expect(deps.embedding).toBeInstanceOf(OllamaEmbeddingProvider);
        expect(deps.llm).toBeDefined();
      } finally {
        deps.db.close();
      }
    });
  });

  test("disabling NER still disables the LLM under the local provider", () => {
    withoutCloudKey(() => {
      const deps = createDeps(makeConfig({
        embedding: { provider: "ollama" },
        ner: { enabled: false, llm_api_key: "ner-only-key" },
      }), true);
      try {
        expect(deps.llm).toBeUndefined();
      } finally {
        deps.db.close();
      }
    });
  });
});
