import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { CBrainDB } from "../../src/storage/sqlite.js";

const PROJECT_DIR = join(import.meta.dir, "..", "..");
const BIN = `bun run ${join(PROJECT_DIR, "src/cli/index.ts")}`;

describe("CLI ingest — dedup flags and output", () => {
  let testDir: string;
  let brainDir: string;
  let dbPath: string;
  let vaultPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cbrain-test-ingest-cli-"));
    brainDir = join(testDir, "mybrain");
    dbPath = join(brainDir, "brain.sqlite");
    vaultPath = join(brainDir, "vault");

    execSync(`${BIN} init --dir ${brainDir}`, { encoding: "utf-8" });

    // Point embedding to a local port that refuses connections — fully offline,
    // no external network access. Connection refused is deterministic and instant.
    const configPath = join(brainDir, "cbrain.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    config.embedding.baseUrl = "http://127.0.0.1:1";
    config.embedding.apiKey = "test-offline-key";
    writeFileSync(configPath, JSON.stringify(config, null, 2));
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function runIngest(args: string[]): { stdout: string; stderr: string; exitCode: number } {
    const result = spawnSync("bun", ["run", join(PROJECT_DIR, "src/cli/index.ts"), "ingest", ...args], {
      encoding: "utf-8",
      cwd: brainDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      stdout: result.stdout?.trim() ?? "",
      stderr: result.stderr?.trim() ?? "",
      exitCode: result.status ?? 1,
    };
  }

  /** Seed a page with a known ingest hash directly into DB + vault */
  function seedPageWithHash(slug: string, title: string, body: string, ingestHash: string) {
    const db = new CBrainDB(dbPath);
    const filePath = `${slug}.md`;
    mkdirSync(join(vaultPath, ...slug.split("/").slice(0, -1)), { recursive: true });
    const fullPath = join(vaultPath, filePath);
    const content = `---\ntitle: "${title}"\ntype: record\nslug: ${slug}\n---\n\n${body}`;
    writeFileSync(fullPath, content, "utf-8");
    db.rawDb.prepare(
      `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(slug, "record", title, filePath, `hash-${slug}`, 0, 3);
    db.rawDb.prepare(
      "UPDATE pages SET ingest_content_hash = ? WHERE slug = ?",
    ).run(ingestHash, slug);
    db.close();
  }

  test("--help lists --allow-duplicate flag", () => {
    const result = spawnSync("bun", ["run", join(PROJECT_DIR, "src/cli/index.ts"), "ingest", "--help"], {
      encoding: "utf-8",
      cwd: brainDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = result.stdout ?? "";
    expect(output).toContain("--allow-duplicate");
    expect(output).toContain("Allow duplicate content");
  });

  test("duplicate output format: shows existing title", async () => {
    const body = "这是CLI去重测试的固定内容";
    const { normalizeAndHashBody } = await import("../../src/core/shared.js");
    const hash = normalizeAndHashBody(body);

    seedPageWithHash("records/cli-dedup-test", "CLI去重原始", body, hash);

    // Ingest same body with different title — dedup gate fires BEFORE embedding
    const result = runIngest([body, "--title", "CLI去重新标题"]);
    expect(result.stdout).toContain("Duplicate");
    expect(result.stdout).toContain("CLI去重原始");
    // Dedup short-circuits — no network access attempted
    expect(result.exitCode).toBe(0);
  });

  test("--allow-duplicate bypasses dedup, hits offline embedding failure", async () => {
    const body = "这是CLI允许重复测试的固定内容";
    const { normalizeAndHashBody } = await import("../../src/core/shared.js");
    const hash = normalizeAndHashBody(body);

    seedPageWithHash("records/cli-allow-dup", "CLI允许重复原始", body, hash);

    // With --allow-duplicate, dedup gate is bypassed → embedding is attempted
    // → hits http://127.0.0.1:1 which refuses connections → deterministic failure
    const result = runIngest([body, "--title", "CLI允许重复新标题", "--allow-duplicate"]);
    expect(result.stdout).not.toContain("Duplicate");
    // Should fail with a connection error, not a dedup message
    expect(result.exitCode).not.toBe(0);
  });
});
