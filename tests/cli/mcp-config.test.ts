import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const PROJECT_DIR = join(import.meta.dir, "..", "..");
const BIN = `bun run ${join(PROJECT_DIR, "src/cli/index.ts")}`;

describe("cbrain mcp-config", () => {
  const testDir = "/tmp/cbrain-test-mcp-config";

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function makeBrain(brainDir: string): string {
    mkdirSync(join(brainDir, "vault/brain/entities"), { recursive: true });
    const configPath = join(brainDir, "cbrain.json");
    writeFileSync(configPath, JSON.stringify({
      vaultPath: join(brainDir, "vault"),
      dbPath: join(brainDir, "brain.sqlite"),
      lancePath: join(brainDir, "lancedb"),
      runtimePath: join(brainDir, "runtime"),
      embedding: { provider: "zhipu" },
    }));
    return configPath;
  }

  test("outputs valid MCP config JSON from cwd", () => {
    const brainDir = join(testDir, "mybrain");
    const configPath = makeBrain(brainDir);

    const stdout = execSync(`${BIN} mcp-config`, {
      cwd: brainDir,
      encoding: "utf-8",
    });

    const parsed = JSON.parse(stdout);
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers.cbrain).toBeDefined();
    expect(parsed.mcpServers.cbrain.command).toBeTruthy();
    expect(parsed.mcpServers.cbrain.args).toContain("serve");
    expect(realpathSync(parsed.mcpServers.cbrain.env.CBRAIN_CONFIG)).toBe(realpathSync(configPath));
  });

  test("outputs valid MCP config with --config flag", () => {
    const brainDir = join(testDir, "mybrain");
    const configPath = makeBrain(brainDir);

    const stdout = execSync(`${BIN} mcp-config --config "${configPath}"`, {
      cwd: testDir,
      encoding: "utf-8",
    });

    const parsed = JSON.parse(stdout);
    expect(realpathSync(parsed.mcpServers.cbrain.env.CBRAIN_CONFIG)).toBe(realpathSync(configPath));
  });

  test("no credential values in output", () => {
    const brainDir = join(testDir, "mybrain");
    makeBrain(brainDir);

    const stdout = execSync(`${BIN} mcp-config`, {
      cwd: brainDir,
      encoding: "utf-8",
    });

    // Should not contain any API key pattern
    expect(stdout).not.toMatch(/api[_-]?key/i);
    expect(stdout).not.toMatch(/sk-/);
    expect(stdout).not.toMatch(/[a-f0-9]{32}/);
  });

  test("JSON output has no surrounding prose", () => {
    const brainDir = join(testDir, "mybrain");
    makeBrain(brainDir);

    const stdout = execSync(`${BIN} mcp-config`, {
      cwd: brainDir,
      encoding: "utf-8",
    });

    // First non-whitespace char must be '{'
    expect(stdout.trim()[0]).toBe("{");
    // Last non-whitespace char must be '}'
    expect(stdout.trim().at(-1)).toBe("}");
  });

  test("exits with error when no config found", () => {
    const emptyDir = join(testDir, "empty");
    mkdirSync(emptyDir, { recursive: true });

    let stderr = "";
    try {
      execSync(`${BIN} mcp-config`, {
        cwd: emptyDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect.unreachable("should have thrown");
    } catch (e: any) {
      stderr = e.stderr ?? "";
    }

    expect(stderr).toContain("No cbrain.json found");
  });

  test("resolveExecutable returns correct structure", async () => {
    const { resolveExecutable } = await import("../../src/cli/commands/mcp-config.js");
    const result = resolveExecutable();
    expect(result.command).toBeTruthy();
    expect(result.args).toBeInstanceOf(Array);
    expect(result.args.length).toBeGreaterThan(0);
    // Args must end with "serve"
    expect(result.args[result.args.length - 1]).toBe("serve");
  });

  test("handles paths with spaces correctly", () => {
    const brainDir = join(testDir, "my brain dir");
    const configPath = makeBrain(brainDir);

    const stdout = execSync(`${BIN} mcp-config --config "${configPath}"`, {
      cwd: testDir,
      encoding: "utf-8",
    });

    const parsed = JSON.parse(stdout);
    expect(realpathSync(parsed.mcpServers.cbrain.env.CBRAIN_CONFIG)).toBe(realpathSync(configPath));
  });

  // ── --config validation ──

  test("rejects nonexistent --config path", () => {
    let stderr = "";
    try {
      execSync(
        `${BIN} mcp-config --config "/tmp/cbrain-nonexistent-xyz/cbrain.json"`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch (e: any) {
      stderr = e.stderr ?? "";
    }

    expect(stderr).toContain("not found");
  });

  test("rejects malformed JSON in --config", () => {
    const badDir = join(testDir, "badjson");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "cbrain.json"), "NOT JSON{{{");

    let stderr = "";
    try {
      execSync(
        `${BIN} mcp-config --config "${join(badDir, "cbrain.json")}"`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch (e: any) {
      stderr = e.stderr ?? "";
    }

    expect(stderr).toContain("not valid JSON");
  });

  test("rejects structurally invalid config (missing required fields)", () => {
    const badDir = join(testDir, "missingfields");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "cbrain.json"), JSON.stringify({ foo: "bar" }));

    let stderr = "";
    try {
      execSync(
        `${BIN} mcp-config --config "${join(badDir, "cbrain.json")}"`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch (e: any) {
      stderr = e.stderr ?? "";
    }

    expect(stderr).toContain("missing required field");
  });

  test("rejects config missing lancePath", () => {
    const badDir = join(testDir, "nolance");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "cbrain.json"), JSON.stringify({
      vaultPath: "/tmp/vault",
      dbPath: "/tmp/brain.sqlite",
      embedding: { provider: "zhipu" },
    }));

    let stderr = "";
    try {
      execSync(
        `${BIN} mcp-config --config "${join(badDir, "cbrain.json")}"`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch (e: any) {
      stderr = e.stderr ?? "";
    }

    expect(stderr).toContain("lancePath");
  });

  test("rejects config missing embedding.provider", () => {
    const badDir = join(testDir, "noembedding");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "cbrain.json"), JSON.stringify({
      vaultPath: "/tmp/vault",
      dbPath: "/tmp/brain.sqlite",
      lancePath: "/tmp/lancedb",
      embedding: {},
    }));

    let stderr = "";
    try {
      execSync(
        `${BIN} mcp-config --config "${join(badDir, "cbrain.json")}"`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch (e: any) {
      stderr = e.stderr ?? "";
    }

    expect(stderr).toContain("embedding.provider");
  });

  test("rejects auto-discovered structurally invalid config", () => {
    const badDir = join(testDir, "autobad");
    mkdirSync(badDir, { recursive: true });
    // Config missing lancePath
    writeFileSync(join(badDir, "cbrain.json"), JSON.stringify({
      vaultPath: "/tmp/vault",
      dbPath: "/tmp/brain.sqlite",
      embedding: { provider: "zhipu" },
    }));

    let stderr = "";
    try {
      execSync(`${BIN} mcp-config`, {
        cwd: badDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e: any) {
      stderr = e.stderr ?? "";
    }

    expect(stderr).toContain("lancePath");
  });
});
