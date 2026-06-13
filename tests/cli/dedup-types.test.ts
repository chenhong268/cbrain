import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { CBrainDB } from "../../src/storage/sqlite.js";

const PROJECT_DIR = join(import.meta.dir, "..", "..");
const BIN = `bun run ${join(PROJECT_DIR, "src/cli/index.ts")}`;

function makeDB(testDir: string): CBrainDB {
  return new CBrainDB(join(testDir, "brain.sqlite"));
}

/** Drop the title unique index so dedup tests can seed duplicate titles.
 *  In production, duplicates should not exist — but dedup tests deliberately
 *  create them to verify the merge/dedup CLI commands work. */
function dropTitleUniqueIndex(db: CBrainDB): void {
  db.rawDb.exec("DROP INDEX IF EXISTS idx_pages_title_uniq");
}

function makeConfig(testDir: string): string {
  const vaultPath = join(testDir, "vault");
  mkdirSync(join(vaultPath, "records"), { recursive: true });
  mkdirSync(join(vaultPath, "brain/entities/book"), { recursive: true });
  mkdirSync(join(vaultPath, "brain/entities/company"), { recursive: true });
  mkdirSync(join(vaultPath, "brain/entities/drug"), { recursive: true });
  mkdirSync(join(vaultPath, "brain/entities/product"), { recursive: true });
  mkdirSync(join(vaultPath, "brain/entities/organization"), { recursive: true });
  mkdirSync(join(vaultPath, "brain/entities/person"), { recursive: true });
  mkdirSync(join(vaultPath, "brain/concepts/concept"), { recursive: true });
  mkdirSync(join(vaultPath, "brain/concepts/psychology"), { recursive: true });
  mkdirSync(join(vaultPath, "brain/concepts/model"), { recursive: true });
  mkdirSync(join(vaultPath, "brain/concepts/pharma"), { recursive: true });
  mkdirSync(join(vaultPath, "brain/concepts/technology"), { recursive: true });

  const configPath = join(testDir, "cbrain.json");
  writeFileSync(configPath, JSON.stringify({
    vaultPath,
    dbPath: join(testDir, "brain.sqlite"),
    lancePath: join(testDir, "lancedb"),
    embedding: { provider: "zhipu" },
  }));
  return configPath;
}

function seedPage(db: CBrainDB, testDir: string, slug: string, type: string, title: string, mentions = 0) {
  const vaultPath = join(testDir, "vault");
  const relPath = `${slug}.md`;
  const absPath = join(vaultPath, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, `---\ntitle: "${title}"\ntype: "${type}"\n---\n\nContent about ${title}.`);
  db.insertPage({ slug, type, title, filePath: relPath, contentHash: `hash-${slug}` });
  for (let i = 0; i < mentions; i++) {
    db.incrementMentionCount(slug);
  }
}

function runDedup(configPath: string, args: string): string {
  return execSync(
    `${BIN} dedup-types ${args}`,
    { encoding: "utf-8", env: { ...process.env, CBRAIN_CONFIG: configPath } }
  );
}

describe("dedup-types", () => {
  const testDir = "/tmp/cbrain-test-dedup-types";

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("merges within affinity group (drug + company)", () => {
    const configPath = makeConfig(testDir);
    const db = makeDB(testDir);
    dropTitleUniqueIndex(db);

    seedPage(db, testDir, "brain/entities/drug/凯丽隆", "entity/drug", "凯丽隆", 5);
    seedPage(db, testDir, "brain/entities/company/凯丽隆", "entity/company", "凯丽隆", 0);
    db.close();

    const dryRun = runDedup(configPath, "--all --dry-run");
    expect(dryRun).toContain("凯丽隆");
    expect(dryRun).toContain("entity/drug");

    const result = runDedup(configPath, "--all --execute");
    expect(result).toContain("merged");
  });

  test("cross-layer entity vs concept picks winner by mention count", () => {
    const configPath = makeConfig(testDir);
    const db = makeDB(testDir);
    dropTitleUniqueIndex(db);

    seedPage(db, testDir, "brain/entities/book/反脆弱", "entity/book", "反脆弱", 3);
    seedPage(db, testDir, "brain/concepts/concept/反脆弱", "concept/concept", "反脆弱", 0);
    seedPage(db, testDir, "brain/concepts/psychology/反脆弱", "concept/psychology", "反脆弱", 0);
    db.close();

    const dryRun = runDedup(configPath, "--all --dry-run");
    expect(dryRun).toContain("反脆弱");
    expect(dryRun).toContain("entity/book");
  });

  test("does not merge with record type", () => {
    const configPath = makeConfig(testDir);
    const db = makeDB(testDir);
    dropTitleUniqueIndex(db);

    seedPage(db, testDir, "brain/concepts/model/para", "concept/model", "PARA", 2);
    seedPage(db, testDir, "records/para", "record", "PARA", 1);
    db.close();

    const dryRun = runDedup(configPath, "--all --dry-run");
    expect(dryRun).not.toContain("→ keep record");
  });

  test("concept affinity group uses priority order", () => {
    const configPath = makeConfig(testDir);
    const db = makeDB(testDir);
    dropTitleUniqueIndex(db);

    seedPage(db, testDir, "brain/concepts/model/第一性原理", "concept/model", "第一性原理", 0);
    seedPage(db, testDir, "brain/concepts/concept/第一性原理", "concept/concept", "第一性原理", 5);
    db.close();

    const dryRun = runDedup(configPath, "--all --dry-run");
    expect(dryRun).toContain("第一性原理");
    // concept/model should win by affinity priority even with fewer mentions
    expect(dryRun).toContain("concept/model");
  });

  test("no duplicates produces clean output", () => {
    const configPath = makeConfig(testDir);
    const db = makeDB(testDir);

    seedPage(db, testDir, "brain/entities/company/novartis", "entity/company", "Novartis", 10);
    db.close();

    const dryRun = runDedup(configPath, "--all --dry-run");
    expect(dryRun).toContain("No cross-type duplicates found");
  });
});
