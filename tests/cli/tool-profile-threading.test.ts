import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { DeterministicEmbeddingProvider } from "../../src/embedding/deterministic.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import { buildContext } from "../../src/mcp/context.js";
import { createDeps } from "../../src/cli/context.js";
import type { CBrainConfig } from "../../src/cli/context.js";

const TEST_DIR = "/tmp/cbrain-test-tool-profile-thread";
const ORIG_ENV = process.env.CBRAIN_MCP_TOOL_PROFILE;

function depsBase() {
  return {
    db: new CBrainDB(join(TEST_DIR, "brain.sqlite")),
    embedding: new DeterministicEmbeddingProvider(),
    lance: new LanceDBManager(),
    vaultPath: join(TEST_DIR, "vault"),
    dbPath: join(TEST_DIR, "brain.sqlite"),
    runtimePath: join(TEST_DIR, "runtime"),
  };
}

const config: CBrainConfig = {
  vaultPath: join(TEST_DIR, "vault"),
  dbPath: join(TEST_DIR, "brain.sqlite"),
  lancePath: join(TEST_DIR, "lance"),
  embedding: { provider: "deterministic" },
};

function setupDirs() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, "vault"), { recursive: true });
  mkdirSync(join(TEST_DIR, "runtime"), { recursive: true });
}
function teardownDirs() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
}

describe("buildContext threads toolProfile", () => {
  beforeEach(setupDirs);
  afterEach(teardownDirs);

  test("explicit profile is set on ctx", () => {
    const ctx = buildContext({ ...depsBase(), toolProfile: "agent" });
    expect(ctx.toolProfile).toBe("agent");
  });

  test("defaults to full when absent", () => {
    const ctx = buildContext({ ...depsBase() });
    expect(ctx.toolProfile).toBe("full");
  });
});

describe("createDeps resolves CBRAIN_MCP_TOOL_PROFILE", () => {
  beforeEach(() => {
    setupDirs();
    delete process.env.CBRAIN_MCP_TOOL_PROFILE;
  });
  afterEach(() => {
    teardownDirs();
    if (ORIG_ENV === undefined) delete process.env.CBRAIN_MCP_TOOL_PROFILE;
    else process.env.CBRAIN_MCP_TOOL_PROFILE = ORIG_ENV;
  });

  test("env threads through to deps.toolProfile", () => {
    process.env.CBRAIN_MCP_TOOL_PROFILE = "maintenance";
    const deps = createDeps(config, false);
    expect(deps.toolProfile).toBe("maintenance");
  });

  test("absent env → full", () => {
    delete process.env.CBRAIN_MCP_TOOL_PROFILE;
    const deps = createDeps(config, false);
    expect(deps.toolProfile).toBe("full");
  });
});
