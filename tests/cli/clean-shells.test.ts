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

function makeConfig(testDir: string): string {
  const vaultPath = join(testDir, "vault");
  mkdirSync(join(vaultPath, "brain/entities/person"), { recursive: true });
  mkdirSync(join(vaultPath, "brain/entities/company"), { recursive: true });
  mkdirSync(join(vaultPath, "brain/concepts/concept"), { recursive: true });

  const configPath = join(testDir, "cbrain.json");
  writeFileSync(configPath, JSON.stringify({
    vaultPath,
    dbPath: join(testDir, "brain.sqlite"),
    lancePath: join(testDir, "lancedb"),
    embedding: { provider: "zhipu" },
  }));
  return configPath;
}

function seedPage(db: CBrainDB, testDir: string, slug: string, type: string, title: string, body?: string) {
  const vaultPath = join(testDir, "vault");
  const relPath = `${slug}.md`;
  const absPath = join(vaultPath, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, `---\ntitle: "${title}"\ntype: "${type}"\n---\n${body ? `\n${body}` : ""}`);
  db.insertPage({ slug, type, title, filePath: relPath, contentHash: `hash-${slug}` });
}

function runCleanShells(configPath: string, args: string): string {
  return execSync(
    `${BIN} clean-shells ${args}`,
    { encoding: "utf-8", env: { ...process.env, CBRAIN_CONFIG: configPath } }
  );
}

describe("clean-shells", () => {
  const testDir = "/tmp/cbrain-test-clean-shells";

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("dry-run identifies empty shells", () => {
    const configPath = makeConfig(testDir);
    const db = makeDB(testDir);

    // Empty shell: 0 mentions, 0 links, 0 aliases, no body
    seedPage(db, testDir, "brain/entities/person/ghost", "entity/person", "Ghost");
    // Non-empty: has mention + body
    seedPage(db, testDir, "brain/entities/company/novartis", "entity/company", "Novartis", "A pharmaceutical company.");
    db.incrementMentionCount("brain/entities/company/novartis");
    db.close();

    const result = runCleanShells(configPath, "--dry-run");
    expect(result).toContain("True empty shell entities: 1");
    expect(result).toContain("entity/person: 1");
    expect(result).toContain("Ghost");
    expect(result).not.toContain("Novartis");
  });

  test("execute deletes shell files and DB rows", () => {
    const configPath = makeConfig(testDir);
    const db = makeDB(testDir);

    seedPage(db, testDir, "brain/entities/person/ghost", "entity/person", "Ghost", "Some content.");
    seedPage(db, testDir, "brain/entities/company/alive", "entity/company", "Alive", "Some content.");
    db.insertLink("brain/entities/company/alive", "brain/entities/person/ghost", "提及", null, 0.5);
    db.close();

    // Ghost has a link now → not a shell. Create a real shell.
    const db2 = makeDB(testDir);
    seedPage(db2, testDir, "brain/concepts/concept/dust", "concept/concept", "Dust");
    db2.close();

    const vaultPath = join(testDir, "vault");
    expect(existsSync(join(vaultPath, "brain/concepts/concept/dust.md"))).toBe(true);

    const result = runCleanShells(configPath, "--execute");
    expect(result).toContain("Done: 1 deleted");
    expect(existsSync(join(vaultPath, "brain/concepts/concept/dust.md"))).toBe(false);
  });

  test("entities with links are not treated as shells", () => {
    const configPath = makeConfig(testDir);
    const db = makeDB(testDir);

    seedPage(db, testDir, "brain/entities/person/linked", "entity/person", "Linked");
    seedPage(db, testDir, "brain/entities/company/target", "entity/company", "Target");
    db.insertLink("brain/entities/person/linked", "brain/entities/company/target", "提及", null, 0.5);
    db.close();

    const result = runCleanShells(configPath, "--dry-run");
    expect(result).toContain("No empty shell entities found");
  });

  test("entities with aliases are not treated as shells", () => {
    const configPath = makeConfig(testDir);
    const db = makeDB(testDir);

    seedPage(db, testDir, "brain/entities/person/aliased", "entity/person", "Aliased");
    db.addAlias("brain/entities/person/aliased", "别名");
    db.close();

    const result = runCleanShells(configPath, "--dry-run");
    expect(result).toContain("No empty shell entities found");
  });

  test("--type filter only deletes matching type", () => {
    const configPath = makeConfig(testDir);
    const db = makeDB(testDir);

    seedPage(db, testDir, "brain/entities/person/p1", "entity/person", "P1");
    seedPage(db, testDir, "brain/concepts/concept/c1", "concept/concept", "C1");
    db.close();

    const result = runCleanShells(configPath, "--dry-run --type entity/person");
    expect(result).toContain("True empty shell entities: 1");
    expect(result).toContain("entity/person: 1");
    expect(result).not.toContain("concept");
  });

  test("record type pages are excluded from shell scan", () => {
    const configPath = makeConfig(testDir);
    const db = makeDB(testDir);

    seedPage(db, testDir, "records/my-note", "record", "My Note");
    db.close();

    const result = runCleanShells(configPath, "--dry-run");
    expect(result).toContain("No empty shell entities found");
  });

  test("--execute preserves the vault file when SQLite delete fails (#187)", () => {
    const configPath = makeConfig(testDir);
    const db = makeDB(testDir);

    // A real shell: 0 mentions, 0 links, 0 aliases, no body.
    seedPage(db, testDir, "brain/concepts/concept/dust", "concept/concept", "Dust");
    // Inject a SQLite failure on the pages DELETE (persists in the db file the
    // subprocess opens). If clean-shells still did unlink+cascade directly, the
    // vault file would be gone after the cascade aborts. Routing through the safe
    // primitive restores it.
    db.rawDb.exec(
      "CREATE TRIGGER stop_del_187 BEFORE DELETE ON pages " +
      "BEGIN SELECT RAISE(ABORT, 'injected sqlite failure'); END",
    );
    db.close();

    const vaultFile = join(testDir, "vault", "brain/concepts/concept/dust.md");
    expect(existsSync(vaultFile)).toBe(true);

    // The delete fails (caught per-shell), but the vault file must survive.
    let out = "";
    try {
      out = runCleanShells(configPath, "--execute");
    } catch (e) {
      out = (e as { stdout?: string }).stdout ?? "";
    }

    expect(existsSync(vaultFile)).toBe(true); // vault file preserved (safe primitive restored it)
    expect(out).toMatch(/Failed|dust/i);
    // Page row intact — the cascade transaction rolled back.
    const db2 = makeDB(testDir);
    expect(db2.getPageFilePath("brain/concepts/concept/dust")).not.toBeNull();
    db2.close();
  });
});
