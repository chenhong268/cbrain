import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { resolveRuntimePath, type CBrainConfig } from "../../src/cli/context.js";

function makeConfig(overrides: Partial<CBrainConfig> = {}): CBrainConfig {
  return {
    vaultPath: "/tmp/cbrain-test-runtime/vault",
    dbPath: "/tmp/cbrain-test-runtime/brain.sqlite",
    lancePath: "/tmp/cbrain-test-runtime/lancedb",
    embedding: { provider: "zhipu" },
    ...overrides,
  };
}

describe("resolveRuntimePath", () => {
  const baseDir = "/tmp/cbrain-test-runtime";

  beforeEach(() => {
    if (existsSync(baseDir)) rmSync(baseDir, { recursive: true });
    mkdirSync(baseDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(baseDir)) rmSync(baseDir, { recursive: true });
  });

  test("defaults to profileDir/runtime when neither exists", () => {
    const config = makeConfig();
    const result = resolveRuntimePath(config);
    const expected = join(dirname(resolve(config.dbPath)), "runtime");
    expect(result).toBe(expected);
  });

  test("explicit runtimePath takes priority", () => {
    const customPath = join(baseDir, "custom-runtime");
    mkdirSync(customPath, { recursive: true });
    const config = makeConfig({ runtimePath: customPath });
    expect(resolveRuntimePath(config)).toBe(resolve(customPath));
  });

  test("prefers new runtime/ when it exists", () => {
    const config = makeConfig();
    const profileDir = dirname(resolve(config.dbPath));
    mkdirSync(join(profileDir, "runtime"), { recursive: true });
    mkdirSync(join(config.vaultPath, "outputs"), { recursive: true });
    expect(resolveRuntimePath(config)).toBe(join(profileDir, "runtime"));
  });

  test("falls back to vault/outputs when only legacy exists", () => {
    const config = makeConfig();
    mkdirSync(join(config.vaultPath, "outputs"), { recursive: true });
    expect(resolveRuntimePath(config)).toBe(join(config.vaultPath, "outputs"));
  });

  test("resolves relative runtimePath to absolute", () => {
    const config = makeConfig({ runtimePath: "some/relative/path" });
    const result = resolveRuntimePath(config);
    expect(result).toBe(resolve("some/relative/path"));
  });
});
