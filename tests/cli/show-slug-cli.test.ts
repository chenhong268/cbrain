import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { CBrainDB } from "../../src/storage/sqlite.js";

const PROJECT_DIR = join(import.meta.dir, "..", "..");
const BIN = `bun run ${join(PROJECT_DIR, "src/cli/index.ts")}`;

describe("CLI show — slug resolution", () => {
  let testDir: string;
  let brainDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cbrain-test-show-cli-"));
    brainDir = join(testDir, "mybrain");
    dbPath = join(brainDir, "brain.sqlite");

    execSync(`${BIN} init --dir ${brainDir}`, { encoding: "utf-8" });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  /** Seed a page into the DB (bypasses full pipeline for speed) */
  function seedPage(slug: string, title: string, type: string, body = "") {
    const db = new CBrainDB(dbPath);
    const vaultPath = join(brainDir, "vault");
    const filePath = `${slug}.md`;
    // Create the vault file so show can read it
    const fullPath = join(vaultPath, filePath);
    mkdirSync(join(vaultPath, ...slug.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(fullPath, `---\ntitle: "${title}"\ntype: ${type}\nslug: ${slug}\n---\n${body}`);
    db.rawDb.prepare(
      `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(slug, type, title, filePath, `hash-${slug}`, 0, 3);
    db.close();
  }

  function show(slug: string): { stdout: string; stderr: string; exitCode: number } {
    const result = spawnSync("bun", ["run", join(PROJECT_DIR, "src/cli/index.ts"), "show", slug], {
      encoding: "utf-8",
      cwd: brainDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.status ?? 1,
    };
  }

  test("full slug brain/... resolves directly", () => {
    seedPage("brain/entities/person/test-person", "Test Person", "entity/person", "Bio text");
    const result = show("brain/entities/person/test-person");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Test Person");
    expect(result.stdout).toContain("brain/entities/person/test-person");
  });

  test("full slug records/... resolves directly", () => {
    seedPage("records/my-note", "My Note", "record", "Note content");
    const result = show("records/my-note");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("My Note");
  });

  test("bare slug falls back to brain/ prefix", () => {
    seedPage("brain/entities/person/test-person", "Test Person", "entity/person", "Bio text");
    const result = show("entities/person/test-person");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Test Person");
  });

  test("bare slug falls back to records/ prefix", () => {
    seedPage("records/my-note", "My Note", "record", "Note content");
    const result = show("my-note");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("My Note");
  });

  test("ambiguous slug warns and resolves", () => {
    seedPage("brain/shared-name", "Brain Version", "entity/person");
    seedPage("records/shared-name", "Records Version", "record");
    const result = show("shared-name");
    // Should succeed (picks first match) but warn about ambiguity
    expect(result.exitCode).toBe(0);
    expect(result.stderr + result.stdout).toContain("Ambiguous");
  });

  test("records/ prefix swapped to brain/ when not found", () => {
    seedPage("brain/entities/person/test-person", "Test Person", "entity/person", "Bio text");
    // User types records/entities/person/test but page is in brain/
    const result = show("records/entities/person/test-person");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Test Person");
  });

  test("non-existent slug returns error", () => {
    const result = show("does-not-exist-at-all");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Page not found");
  });
});

describe("CLI delete — slug resolution", () => {
  let testDir: string;
  let brainDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cbrain-test-delete-cli-"));
    brainDir = join(testDir, "mybrain");
    dbPath = join(brainDir, "brain.sqlite");

    execSync(`${BIN} init --dir ${brainDir}`, { encoding: "utf-8" });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function seedPage(slug: string, title: string, type: string) {
    const db = new CBrainDB(dbPath);
    const vaultPath = join(brainDir, "vault");
    const filePath = `${slug}.md`;
    const fullPath = join(vaultPath, filePath);
    mkdirSync(join(vaultPath, ...slug.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(fullPath, `---\ntitle: "${title}"\ntype: ${type}\nslug: ${slug}\n---\nContent`);
    db.rawDb.prepare(
      `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(slug, type, title, filePath, `hash-${slug}`, 0, 3);
    db.close();
  }

  function deleteSlug(slug: string): { stdout: string; stderr: string; exitCode: number } {
    const result = spawnSync("bun", ["run", join(PROJECT_DIR, "src/cli/index.ts"), "delete", slug], {
      encoding: "utf-8",
      cwd: brainDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.status ?? 1,
    };
  }

  test("deletes with full slug", () => {
    seedPage("brain/entities/person/del-me", "Delete Me", "entity/person");
    const result = deleteSlug("brain/entities/person/del-me");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Deleted");
  });

  test("deletes with bare slug via fallback", () => {
    seedPage("records/fallback-del", "Fallback Del", "record");
    const result = deleteSlug("fallback-del");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Deleted: records/fallback-del");
  });

  test("ambiguous slug REFUSES to delete", () => {
    seedPage("brain/shared-del", "Brain Version", "entity/person");
    seedPage("records/shared-del", "Records Version", "record");
    const result = deleteSlug("shared-del");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Ambiguous");
    expect(result.stderr).toContain("Please specify the full slug to delete");

    // Verify neither page was deleted
    const db = new CBrainDB(dbPath);
    expect(db.getPage("brain/shared-del")).not.toBeNull();
    expect(db.getPage("records/shared-del")).not.toBeNull();
    db.close();
  });

  test("non-existent slug returns error", () => {
    const result = deleteSlug("no-such-page");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Page not found");
  });
});
