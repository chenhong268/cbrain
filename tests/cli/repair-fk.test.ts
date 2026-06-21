import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { buildProgram } from "../../src/cli/program.js";

const tmp = "/tmp/cbrain-test-repair-fk-cli";

/** Build a DB via CBrainDB (full schema + migrate), then inject an orphan tag. */
function makeOrphanDb(dbPath: string): void {
  const db = new CBrainDB(dbPath);
  const internal = (db as unknown as { db: Database }).db;
  internal.exec("PRAGMA foreign_keys = OFF");
  internal.prepare("INSERT INTO tags (page_slug, tag) VALUES ('orphan-x', 'd')").run();
  internal.exec("PRAGMA foreign_keys = ON");
  db.close();
}

/** Capture console.error output from fn. */
function capture(fn: () => void): string {
  const orig = console.error;
  let out = "";
  console.error = (...args: unknown[]) => { out += args.map(String).join(" ") + "\n"; };
  try { fn(); } finally { console.error = orig; }
  return out;
}

describe("cbrain repair-fk CLI (#209)", () => {
  beforeEach(() => { if (existsSync(tmp)) rmSync(tmp, { recursive: true }); mkdirSync(tmp, { recursive: true }); });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true });
    delete process.env.CBRAIN_CONFIG;
  });

  test("dry-run reports orphan counts and does NOT modify DB", () => {
    const dbPath = join(tmp, "brain.sqlite");
    makeOrphanDb(dbPath);
    const configPath = join(tmp, "cbrain.json");
    writeFileSync(configPath, JSON.stringify({
      vaultPath: join(tmp, "vault"), dbPath, lancePath: join(tmp, "lancedb"),
      embedding: { provider: "deterministic" }, ner: { enabled: false },
    }));

    const out = capture(() => {
      process.env.CBRAIN_CONFIG = configPath;
      buildProgram().parse(["repair-fk"], { from: "user" });
    });
    expect(out).toMatch(/tags:\s*1/);
    expect(out).toMatch(/dry-run/i);
    // anonymized: no slug leak
    expect(out).not.toMatch(/orphan-x/);
    // DB unchanged
    const verify = new Database(dbPath);
    expect((verify.prepare("SELECT COUNT(*) c FROM tags").get() as { c: number }).c).toBe(1);
    verify.close();
  });

  test("--execute deletes orphans; FK clean after", () => {
    const dbPath = join(tmp, "brain.sqlite");
    makeOrphanDb(dbPath);
    const configPath = join(tmp, "cbrain.json");
    writeFileSync(configPath, JSON.stringify({
      vaultPath: join(tmp, "vault"), dbPath, lancePath: join(tmp, "lancedb"),
      embedding: { provider: "deterministic" }, ner: { enabled: false },
    }));

    const out = capture(() => {
      process.env.CBRAIN_CONFIG = configPath;
      buildProgram().parse(["repair-fk", "--execute"], { from: "user" });
    });
    expect(out).toMatch(/repaired/i);
    const verify = new Database(dbPath);
    expect((verify.prepare("SELECT COUNT(*) c FROM tags").get() as { c: number }).c).toBe(0);
    verify.close();
  });

  test("clean DB: reports nothing to repair", () => {
    const dbPath = join(tmp, "brain.sqlite");
    new CBrainDB(dbPath).close(); // clean DB, no orphans
    const configPath = join(tmp, "cbrain.json");
    writeFileSync(configPath, JSON.stringify({
      vaultPath: join(tmp, "vault"), dbPath, lancePath: join(tmp, "lancedb"),
      embedding: { provider: "deterministic" }, ner: { enabled: false },
    }));

    const out = capture(() => {
      process.env.CBRAIN_CONFIG = configPath;
      buildProgram().parse(["repair-fk"], { from: "user" });
    });
    expect(out).toMatch(/No FK violations/i);
  });

  test("--execute works on a DB where serve's migrate would FK-fail (the #209 blocker)", () => {
    const dbPath = join(tmp, "brain.sqlite");
    // Build a DB that serve would reject: reset one migration's completion marker
    // + inject orphan → a normal new CBrainDB() (migrate) would throw FKMigrationError.
    const db0 = new CBrainDB(dbPath);
    const internal = (db0 as unknown as { db: Database }).db;
    internal.prepare("DELETE FROM config WHERE key = ?").run("migration_v4_pages_constraint");
    internal.exec("PRAGMA foreign_keys = OFF");
    internal.prepare("INSERT INTO tags (page_slug, tag) VALUES ('orphan-fk', 'x')").run();
    internal.exec("PRAGMA foreign_keys = ON");
    db0.close();
    const fkConfigPath = join(tmp, "cbrain.json");
    writeFileSync(fkConfigPath, JSON.stringify({
      vaultPath: join(tmp, "vault"), dbPath, lancePath: join(tmp, "lancedb"),
      embedding: { provider: "deterministic" }, ner: { enabled: false },
    }));

    // repair-fk must NOT throw (skipMigrate) and must clean the orphan.
    const out = capture(() => {
      process.env.CBRAIN_CONFIG = fkConfigPath;
      buildProgram().parse(["repair-fk", "--execute"], { from: "user" });
    });
    expect(out).toMatch(/repaired/i);
    const verify = new Database(dbPath);
    expect((verify.prepare("SELECT COUNT(*) c FROM tags").get() as { c: number }).c).toBe(0);
    verify.close();

    // After repair, a normal CBrainDB (migrate) opens cleanly — serve would start.
    expect(() => new CBrainDB(dbPath).close()).not.toThrow();
  });
});
