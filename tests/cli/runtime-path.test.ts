import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync } from "node:fs";
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

  test("defaults to profileDir/runtime", () => {
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

  test("returns profileDir/runtime even when vault/outputs exists", () => {
    const config = makeConfig();
    mkdirSync(join(config.vaultPath, "outputs"), { recursive: true });
    const profileDir = dirname(resolve(config.dbPath));
    expect(resolveRuntimePath(config)).toBe(join(profileDir, "runtime"));
  });

  test("resolves relative runtimePath to absolute", () => {
    const config = makeConfig({ runtimePath: "some/relative/path" });
    const result = resolveRuntimePath(config);
    expect(result).toBe(resolve("some/relative/path"));
  });
});

describe("migrate-runtime CLI", () => {
  const BIN = `bun run ${join(import.meta.dir, "..", "..", "src/cli/index.ts")}`;
  const testDir = "/tmp/cbrain-test-migrate";
  const brainDir = join(testDir, "mybrain");

  function initBrain() {
    const { execSync } = require("node:child_process");
    execSync(`${BIN} init --dir ${brainDir}`, { encoding: "utf-8" });
  }

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("dry-run shows migration plan when vault/outputs exists", () => {
    initBrain();
    const { mkdirSync: mkdir, writeFileSync } = require("node:fs");
    const outputsDir = join(brainDir, "vault", "outputs");
    mkdir(join(outputsDir, "logs"), { recursive: true });
    writeFileSync(join(outputsDir, "logs", "test.log"), "hello");

    const { execSync } = require("node:child_process");
    const output = execSync(`${BIN} migrate-runtime --dry-run`, {
      cwd: brainDir,
      encoding: "utf-8",
    });
    expect(output).toContain("DRY RUN");
    expect(output).toContain("文件数:   1");
    // Source not deleted
    expect(existsSync(join(outputsDir, "logs", "test.log"))).toBe(true);
  });

  test("reports no migration needed when vault/outputs absent", () => {
    initBrain();
    const { execSync } = require("node:child_process");
    const output = execSync(`${BIN} migrate-runtime --dry-run`, {
      cwd: brainDir,
      encoding: "utf-8",
    });
    expect(output).toContain("无需迁移");
  });

  test("execute copies files and removes source", () => {
    initBrain();
    const { mkdirSync: mkdir, writeFileSync, readFileSync } = require("node:fs");
    const outputsDir = join(brainDir, "vault", "outputs");
    mkdir(join(outputsDir, "logs"), { recursive: true });
    writeFileSync(join(outputsDir, "logs", "test.log"), "hello world");

    const { execSync } = require("node:child_process");
    const output = execSync(`${BIN} migrate-runtime --execute`, {
      cwd: brainDir,
      encoding: "utf-8",
    });
    expect(output).toContain("已迁移");

    // Target has the files
    const runtimeDir = join(brainDir, "runtime");
    expect(existsSync(join(runtimeDir, "logs", "test.log"))).toBe(true);
    expect(readFileSync(join(runtimeDir, "logs", "test.log"), "utf-8")).toBe("hello world");

    // Source removed
    expect(existsSync(outputsDir)).toBe(false);
  });

  test("rejects when target already has files", () => {
    initBrain();
    const { mkdirSync: mkdir, writeFileSync } = require("node:fs");
    const outputsDir = join(brainDir, "vault", "outputs");
    mkdir(join(outputsDir, "logs"), { recursive: true });
    writeFileSync(join(outputsDir, "logs", "old.log"), "old");

    const runtimeDir = join(brainDir, "runtime");
    mkdir(join(runtimeDir, "existing"), { recursive: true });
    writeFileSync(join(runtimeDir, "existing", "data.txt"), "exists");

    const { execSync } = require("node:child_process");
    expect(() => {
      execSync(`${BIN} migrate-runtime --execute`, {
        cwd: brainDir,
        encoding: "utf-8",
        stdio: "pipe",
      });
    }).toThrow(/拒绝覆盖/);

    // Source untouched
    expect(existsSync(join(outputsDir, "logs", "old.log"))).toBe(true);
    // Target untouched
    expect(readFileSync(join(runtimeDir, "existing", "data.txt"), "utf-8") ?? "").toContain("exists");
  });

  test("does not auto-delete user content files", () => {
    initBrain();
    const { mkdirSync: mkdir, writeFileSync } = require("node:fs");
    const outputsDir = join(brainDir, "vault", "outputs");
    mkdir(outputsDir, { recursive: true });
    writeFileSync(join(outputsDir, "notes.md"), "# my important notes");

    const { execSync } = require("node:child_process");
    execSync(`${BIN} migrate-runtime --execute`, {
      cwd: brainDir,
      encoding: "utf-8",
    });

    // File preserved in target
    const runtimeDir = join(brainDir, "runtime");
    expect(existsSync(join(runtimeDir, "notes.md"))).toBe(true);
  });
});
