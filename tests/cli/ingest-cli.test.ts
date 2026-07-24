import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
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

    // Deterministic, fully in-process: no socket, no HTTP, no credentials, no
    // wall-clock network timeout. NER disabled so ingest never needs an LLM.
    // (#382) Replaces the old http://127.0.0.1:1 refused-port oracle.
    const configPath = join(brainDir, "cbrain.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    config.embedding.provider = "deterministic";
    config.ner = { enabled: false };
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

  /** Total persisted page count — opens/closes its own DB connection. */
  function pageCount(): number {
    const db = new CBrainDB(dbPath);
    const c = (db.rawDb.prepare("SELECT COUNT(*) c FROM pages").get() as { c: number }).c;
    db.close();
    return c;
  }

  /** Chunk rows written for a slug — proof the page was actually indexed. */
  function chunkCountForSlug(slug: string): number {
    const db = new CBrainDB(dbPath);
    const r = db.rawDb.prepare("SELECT COUNT(*) c FROM chunks WHERE page_slug = ?").get(slug) as { c: number };
    db.close();
    return r.c;
  }

  /** The first page slug that isn't `exclude` (the newly-created second page). */
  function otherPageSlug(exclude: string): string | undefined {
    const db = new CBrainDB(dbPath);
    const rows = db.rawDb.prepare("SELECT slug FROM pages WHERE slug != ?").all(exclude) as Array<{ slug: string }>;
    db.close();
    return rows[0]?.slug;
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

  test("duplicate output format: shows existing title, no extra page", async () => {
    const body = "这是CLI去重测试的固定内容";
    const { normalizeAndHashBody } = await import("../../src/core/shared.js");
    const hash = normalizeAndHashBody(body);

    seedPageWithHash("records/cli-dedup-test", "CLI去重原始", body, hash);
    expect(pageCount()).toBe(1);

    // Ingest same body with different title — durable-source dedup gate fires
    // BEFORE embedding, so no second page and no indexing side effects.
    const result = runIngest([body, "--title", "CLI去重新标题"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Duplicate");
    expect(result.stdout).toContain("CLI去重原始");
    // Short-circuit proven: still one page, no chunks written.
    expect(pageCount()).toBe(1);
    expect(chunkCountForSlug("records/cli-dedup-test")).toBe(0);
  });

  test("--allow-duplicate bypasses dedup and creates a second indexed page (#382)", async () => {
    const body = "这是CLI允许重复测试的固定内容";
    const { normalizeAndHashBody } = await import("../../src/core/shared.js");
    const hash = normalizeAndHashBody(body);

    const seededSlug = "records/cli-allow-dup";
    seedPageWithHash(seededSlug, "CLI允许重复原始", body, hash);
    expect(pageCount()).toBe(1);

    // --allow-duplicate bypasses the durable-source dedup gate. With the
    // in-process deterministic provider the command must SUCCEED and produce a
    // genuinely distinct second page — not merely fail to reach a dead port.
    const result = runIngest([body, "--title", "CLI允许重复新标题", "--allow-duplicate"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("Duplicate");
    expect(result.stdout).toContain("✓ Created:");

    // A second, distinct page now exists and was actually indexed (chunks written).
    expect(pageCount()).toBe(2);
    const newSlug = otherPageSlug(seededSlug);
    expect(newSlug).toBeDefined();
    expect(chunkCountForSlug(newSlug ?? "")).toBeGreaterThan(0);
  });

  test("ingest @existing-entity.md --type markdown is a no-op duplicate (#191)", () => {
    // Seed an existing entity page (DB row + vault file with frontmatter slug).
    const slug = "brain/entities/person/shiti-a";
    const relPath = `${slug}.md`;
    mkdirSync(join(vaultPath, ...slug.split("/").slice(0, -1)), { recursive: true });
    const md = `---\ntitle: 实体A\ntype: entity/person\nslug: ${slug}\n---\n\n实体A 简介`;
    const filePath = join(vaultPath, relPath);
    writeFileSync(filePath, md, "utf-8");
    {
      const db = new CBrainDB(dbPath);
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?,?,?,?,?,?,?)`,
      ).run(slug, "entity/person", "实体A", relPath, `hash-${slug}`, 0, 3);
      db.close();
    }

    const result = runIngest([`@${filePath}`, "--type", "markdown"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Duplicate");
    // No new page created; no junk records/ page
    {
      const db = new CBrainDB(dbPath);
      const c = (db.rawDb.prepare("SELECT COUNT(*) c FROM pages").get() as { c: number }).c;
      db.close();
      expect(c).toBe(1);
    }
    const recordsDir = join(vaultPath, "records");
    expect(existsSync(recordsDir) ? readdirSync(recordsDir).length : 0).toBe(0);
    // Sanitized: the local absolute path of @file is never echoed back.
    expect(result.stdout + result.stderr).not.toContain(filePath);
  });

  test("ingest @file with markdown frontmatter and no --type routes as markdown (#198)", () => {
    // Frontmatter slug points at an existing page → markdown path short-circuits
    // as a duplicate WITHOUT embedding. The bug (default --type text) routes to
    // the text path and creates a spurious page instead of short-circuiting.
    const slug = "brain/entities/person/shi-ti-cli";
    const relPath = `${slug}.md`;
    mkdirSync(join(vaultPath, ...slug.split("/").slice(0, -1)), { recursive: true });
    const md = `---\ntitle: 实体CLI\ntype: entity/person\nslug: ${slug}\n---\n\n实体CLI 简介`;
    writeFileSync(join(vaultPath, relPath), md, "utf-8");
    {
      const db = new CBrainDB(dbPath);
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?,?,?,?,?,?,?)`,
      ).run(slug, "entity/person", "实体CLI", relPath, `hash-${slug}`, 0, 3);
      db.close();
    }

    const srcPath = join(testDir, "temp_source.md");
    writeFileSync(srcPath, md, "utf-8");

    const result = runIngest([`@${srcPath}`]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Duplicate");
    // Source path never echoed back
    expect(result.stdout + result.stderr).not.toContain(srcPath);
  });
});

describe("cbrain ingest --ner-mode (#252)", () => {
  let testDir: string;
  let brainDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cbrain-test-nermode-"));
    brainDir = join(testDir, "mybrain");
    dbPath = join(brainDir, "brain.sqlite");

    execSync(`${BIN} init --dir ${brainDir}`, { encoding: "utf-8" });

    // Deterministic embedding (no network) + NER disabled (no LLM needed).
    const configPath = join(brainDir, "cbrain.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    config.embedding.provider = "deterministic";
    config.ner = { enabled: false };
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
      env: { ...process.env },
    });
    return {
      stdout: result.stdout?.trim() ?? "",
      stderr: result.stderr?.trim() ?? "",
      exitCode: result.status ?? 1,
    };
  }

  function countNerBackfillJobs(): number {
    const db = new CBrainDB(dbPath);
    const row = db.rawDb.prepare("SELECT COUNT(*) AS c FROM jobs WHERE status = 'pending' AND name = 'ner-backfill'").get() as { c: number } | undefined;
    db.close();
    return row?.c ?? 0;
  }

  test("env CBRAIN_INGEST_NER_MODE=defer creates a ner-backfill job", () => {
    const env = { ...process.env, CBRAIN_INGEST_NER_MODE: "defer" };
    const result = spawnSync("bun", ["run", join(PROJECT_DIR, "src/cli/index.ts"), "ingest", "匿名正文", "--type", "text"], {
      encoding: "utf-8",
      cwd: brainDir,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    expect(result.status ?? 1).toBe(0);
    expect(countNerBackfillJobs()).toBe(1);
  });

  test("invalid --ner-mode falls back to sync (no throw, no job)", () => {
    const result = runIngest(["匿名正文", "--type", "text", "--ner-mode", "garbage"]);
    expect(result.exitCode).toBe(0);
    expect(countNerBackfillJobs()).toBe(0);
  });

  test("env defer + --ner-mode off → no job (CLI flag beats env)", () => {
    const env = { ...process.env, CBRAIN_INGEST_NER_MODE: "defer" };
    const result = spawnSync("bun", ["run", join(PROJECT_DIR, "src/cli/index.ts"), "ingest", "匿名正文", "--type", "text", "--ner-mode", "off"], {
      encoding: "utf-8",
      cwd: brainDir,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    expect(result.status ?? 1).toBe(0);
    expect(countNerBackfillJobs()).toBe(0);
  });

  test("env sync + --ner-mode defer → creates job (CLI flag beats env)", () => {
    const env = { ...process.env, CBRAIN_INGEST_NER_MODE: "sync" };
    const result = spawnSync("bun", ["run", join(PROJECT_DIR, "src/cli/index.ts"), "ingest", "匿名正文", "--type", "text", "--ner-mode", "defer"], {
      encoding: "utf-8",
      cwd: brainDir,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    expect(result.status ?? 1).toBe(0);
    expect(countNerBackfillJobs()).toBe(1);
  });
});
