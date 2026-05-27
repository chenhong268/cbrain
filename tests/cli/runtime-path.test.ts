import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

  function exec(args: string, cwd?: string) {
    const { execSync } = require("node:child_process");
    return execSync(`${BIN} ${args}`, { cwd: cwd ?? brainDir, encoding: "utf-8" });
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
    const outputsDir = join(brainDir, "vault", "outputs");
    mkdirSync(join(outputsDir, "logs"), { recursive: true });
    writeFileSync(join(outputsDir, "logs", "test.log"), "hello");

    const output = exec("migrate-runtime --dry-run");
    expect(output).toContain("DRY RUN");
    expect(output).toContain("文件数:   1");
    expect(existsSync(join(outputsDir, "logs", "test.log"))).toBe(true);
  });

  test("reports no migration needed when vault/outputs absent", () => {
    initBrain();
    const output = exec("migrate-runtime --dry-run");
    expect(output).toContain("无需迁移");
  });

  test("execute copies files and removes source", () => {
    initBrain();
    const outputsDir = join(brainDir, "vault", "outputs");
    mkdirSync(join(outputsDir, "logs"), { recursive: true });
    writeFileSync(join(outputsDir, "logs", "test.log"), "hello world");

    const output = exec("migrate-runtime --execute");
    expect(output).toContain("已迁移");

    const runtimeDir = join(brainDir, "runtime");
    expect(existsSync(join(runtimeDir, "logs", "test.log"))).toBe(true);
    expect(readFileSync(join(runtimeDir, "logs", "test.log"), "utf-8")).toBe("hello world");
    expect(existsSync(outputsDir)).toBe(false);
  });

  test("archives conflicting target files instead of aborting", () => {
    initBrain();
    const outputsDir = join(brainDir, "vault", "outputs");
    mkdirSync(join(outputsDir, "logs"), { recursive: true });
    writeFileSync(join(outputsDir, "logs", "old.log"), "old data");

    // Simulate new version already having created runtime files
    const runtimeDir = join(brainDir, "runtime");
    mkdirSync(join(runtimeDir, "existing"), { recursive: true });
    writeFileSync(join(runtimeDir, "existing", "data.txt"), "exists");

    const output = exec("migrate-runtime --execute");
    expect(output).toContain("归档");

    // Source removed
    expect(existsSync(outputsDir)).toBe(false);

    // Migrated files present
    expect(existsSync(join(runtimeDir, "logs", "old.log"))).toBe(true);

    // Old target was archived (directory renamed)
    const entries = readdirSync(brainDir).filter(e => e.startsWith("runtime.pre-migrate-"));
    expect(entries.length).toBe(1);
    expect(existsSync(join(brainDir, entries[0], "existing", "data.txt"))).toBe(true);
  });

  test("handles new runtime files present before migration (dry-run)", () => {
    initBrain();
    const outputsDir = join(brainDir, "vault", "outputs");
    mkdirSync(join(outputsDir, "logs"), { recursive: true });
    writeFileSync(join(outputsDir, "logs", "legacy.log"), "legacy");

    const runtimeDir = join(brainDir, "runtime");
    mkdirSync(join(runtimeDir, "health"), { recursive: true });
    writeFileSync(join(runtimeDir, "health", "report.json"), "{}");

    const output = exec("migrate-runtime --dry-run");
    expect(output).toContain("目标已有");
    expect(output).toContain("归档");
    // Nothing actually moved
    expect(existsSync(join(outputsDir, "logs", "legacy.log"))).toBe(true);
    expect(existsSync(join(runtimeDir, "health", "report.json"))).toBe(true);
  });

  test("does not auto-delete user content files", () => {
    initBrain();
    const outputsDir = join(brainDir, "vault", "outputs");
    mkdirSync(outputsDir, { recursive: true });
    writeFileSync(join(outputsDir, "notes.md"), "# my important notes");

    exec("migrate-runtime --execute");

    const runtimeDir = join(brainDir, "runtime");
    expect(existsSync(join(runtimeDir, "notes.md"))).toBe(true);
  });
});

describe("migrate-runtime with custom runtimePath", () => {
  const BIN = `bun run ${join(import.meta.dir, "..", "..", "src/cli/index.ts")}`;
  const testDir = "/tmp/cbrain-test-migrate-custom";
  const brainDir = join(testDir, "mybrain");
  const customRuntime = join(testDir, "custom-rt");

  function initBrainWithCustomRuntime() {
    const { execSync } = require("node:child_process");
    execSync(`${BIN} init --dir ${brainDir}`, { encoding: "utf-8" });
    // Inject custom runtimePath into config
    const configPath = join(brainDir, "cbrain.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    config.runtimePath = customRuntime;
    writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("migrates to custom runtimePath instead of default", () => {
    initBrainWithCustomRuntime();
    const outputsDir = join(brainDir, "vault", "outputs");
    mkdirSync(join(outputsDir, "logs"), { recursive: true });
    writeFileSync(join(outputsDir, "logs", "custom.log"), "custom content");

    const { execSync } = require("node:child_process");
    const output = execSync(`${BIN} migrate-runtime --execute`, {
      cwd: brainDir,
      encoding: "utf-8",
    });
    expect(output).toContain(customRuntime);
    expect(existsSync(join(customRuntime, "logs", "custom.log"))).toBe(true);
    expect(readFileSync(join(customRuntime, "logs", "custom.log"), "utf-8")).toBe("custom content");
    expect(existsSync(outputsDir)).toBe(false);
  });
});
