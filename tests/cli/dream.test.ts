import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { CBrainDB } from "../../src/storage/sqlite.js";

const PROJECT_DIR = join(import.meta.dir, "..", "..");
const BIN = `bun run ${join(PROJECT_DIR, "src/cli/index.ts")}`;

describe("CLI dream", () => {
  let testDir: string;
  let brainDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cbrain-test-dream-cli-"));
    brainDir = join(testDir, "mybrain");
    dbPath = join(brainDir, "brain.sqlite");
    execSync(`${BIN} init --dir ${brainDir}`, { encoding: "utf-8" });

    // Write dummy API key so createDeps doesn't exit(1)
    const configPath = join(brainDir, "cbrain.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    config.embedding.apiKey = "test-key-for-cli-tests";
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("locked/skipped: exits non-zero with warning", () => {
    const db = new CBrainDB(dbPath);
    db.setConfig("dream.lock", String(Date.now()));
    db.close();

    try {
      execSync(`${BIN} dream`, { cwd: brainDir, encoding: "utf-8" });
      expect.unreachable("should have exited with code 1");
    } catch (e: unknown) {
      const err = e as { status: number; stdout: string };
      expect(err.status).toBe(1);
      expect(err.stdout).toContain("⚠️");
      expect(err.stdout).toContain("已跳过");
    }
  });

  test("normal completion: exits 0 with success output and lanceOrphans", () => {
    const output = execSync(`${BIN} dream`, {
      cwd: brainDir,
      encoding: "utf-8",
      timeout: 60_000,
    });

    expect(output).toContain("🌙");
    expect(output).toContain("向量孤儿");
    expect(output).toContain("过期 stub");
    expect(output).toContain("⏱");

    // Should NOT contain the skip warning
    expect(output).not.toContain("已跳过");
  });
});
