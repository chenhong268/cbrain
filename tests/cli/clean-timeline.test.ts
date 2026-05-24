import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { CBrainDB } from "../../src/storage/sqlite.js";

const PROJECT_DIR = join(import.meta.dir, "..", "..");
const BIN = `bun run ${join(PROJECT_DIR, "src/cli/index.ts")}`;

function makeDB(testDir: string): CBrainDB {
  return new CBrainDB(join(testDir, "brain.sqlite"));
}

function makeConfig(testDir: string): string {
  const vaultPath = join(testDir, "vault");
  mkdirSync(vaultPath, { recursive: true });

  const configPath = join(testDir, "cbrain.json");
  writeFileSync(configPath, JSON.stringify({
    vaultPath,
    dbPath: join(testDir, "brain.sqlite"),
    lancePath: join(testDir, "lancedb"),
    embedding: { provider: "zhipu" },
  }));
  return configPath;
}

function seedPage(db: CBrainDB, slug: string, type: string, title: string) {
  db.insertPage({ slug, type, title, filePath: `${slug}.md`, contentHash: `hash-${slug}` });
}

function runCleanTimeline(configPath: string, args: string): string {
  return execSync(
    `${BIN} clean-timeline ${args}`,
    { encoding: "utf-8", env: { ...process.env, CBRAIN_CONFIG: configPath } }
  );
}

describe("clean-timeline", () => {
  const testDir = "/tmp/cbrain-test-clean-timeline";

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("deletes NULL event_date entries", () => {
    const configPath = makeConfig(testDir);
    const db = makeDB(testDir);
    seedPage(db, "test/slug", "entity/person", "Test");

    db.prepare("INSERT INTO timeline (page_slug, event_date, summary) VALUES ($slug, $date, $summary)")
      .run({ $slug: "test/slug", $date: null, $summary: "null date entry" });
    db.prepare("INSERT INTO timeline (page_slug, event_date, summary) VALUES ($slug, $date, $summary)")
      .run({ $slug: "test/slug", $date: "2024-01-01", $summary: "valid entry" });
    db.close();

    const result = runCleanTimeline(configPath, "--execute");
    expect(result).toContain("1 deleted");

    const db2 = makeDB(testDir);
    const remaining = db2.prepare("SELECT COUNT(*) as cnt FROM timeline WHERE event_date IS NULL").get() as any;
    expect(remaining.cnt).toBe(0);
    db2.close();
  });

  test("normalizes year-only dates to YYYY-01-01", () => {
    const configPath = makeConfig(testDir);
    const db = makeDB(testDir);
    seedPage(db, "test/slug", "entity/company", "Test");

    db.prepare("INSERT INTO timeline (page_slug, event_date, summary) VALUES ($slug, $date, $summary)")
      .run({ $slug: "test/slug", $date: "2024", $summary: "year only" });
    db.close();

    const result = runCleanTimeline(configPath, "--execute");
    expect(result).toContain("1 normalized");

    const db2 = makeDB(testDir);
    const row = db2.prepare("SELECT event_date FROM timeline WHERE summary = 'year only'").get() as any;
    expect(row.event_date).toBe("2024-01-01");
    db2.close();
  });

  test("normalizes month-only dates to YYYY-MM-01", () => {
    const configPath = makeConfig(testDir);
    const db = makeDB(testDir);
    seedPage(db, "test/slug", "entity/company", "Test");

    db.prepare("INSERT INTO timeline (page_slug, event_date, summary) VALUES ($slug, $date, $summary)")
      .run({ $slug: "test/slug", $date: "2024-06", $summary: "month only" });
    db.close();

    const result = runCleanTimeline(configPath, "--execute");
    expect(result).toContain("1 normalized");

    const db2 = makeDB(testDir);
    const row = db2.prepare("SELECT event_date FROM timeline WHERE summary = 'month only'").get() as any;
    expect(row.event_date).toBe("2024-06-01");
    db2.close();
  });

  test("deletes unparseable date strings", () => {
    const configPath = makeConfig(testDir);
    const db = makeDB(testDir);
    seedPage(db, "test/slug", "entity/drug", "Test");

    db.prepare("INSERT INTO timeline (page_slug, event_date, summary) VALUES ($slug, $date, $summary)")
      .run({ $slug: "test/slug", $date: "已完成", $summary: "status not date" });
    db.prepare("INSERT INTO timeline (page_slug, event_date, summary) VALUES ($slug, $date, $summary)")
      .run({ $slug: "test/slug", $date: "null", $summary: "string null" });
    db.close();

    const result = runCleanTimeline(configPath, "--execute");
    expect(result).toContain("2 deleted");

    const db2 = makeDB(testDir);
    const remaining = db2.prepare("SELECT COUNT(*) as cnt FROM timeline WHERE page_slug = 'test/slug'").get() as any;
    expect(remaining.cnt).toBe(0);
    db2.close();
  });

  test("deduplicates identical (slug, date, summary) entries", () => {
    const configPath = makeConfig(testDir);
    const db = makeDB(testDir);
    seedPage(db, "test/slug", "concept/model", "Test");

    const stmt = db.prepare("INSERT INTO timeline (page_slug, event_date, summary) VALUES ($slug, $date, $summary)");
    stmt.run({ $slug: "test/slug", $date: "2024-03-15", $summary: "duplicate event" });
    stmt.run({ $slug: "test/slug", $date: "2024-03-15", $summary: "duplicate event" });
    stmt.run({ $slug: "test/slug", $date: "2024-03-15", $summary: "unique event" });
    db.close();

    const result = runCleanTimeline(configPath, "--execute");
    expect(result).toContain("Duplicates:       1");
    expect(result).toContain("1 deleted");

    const db2 = makeDB(testDir);
    const remaining = db2.prepare("SELECT COUNT(*) as cnt FROM timeline WHERE page_slug = 'test/slug'").get() as any;
    expect(remaining.cnt).toBe(2);
    db2.close();
  });

  test("dry-run reports but does not modify", () => {
    const configPath = makeConfig(testDir);
    const db = makeDB(testDir);
    seedPage(db, "test/slug", "entity/person", "Test");

    db.prepare("INSERT INTO timeline (page_slug, event_date, summary) VALUES ($slug, $date, $summary)")
      .run({ $slug: "test/slug", $date: null, $summary: "null date" });
    db.close();

    const result = runCleanTimeline(configPath, "--dry-run");
    expect(result).toContain("DRY RUN");

    const db2 = makeDB(testDir);
    const remaining = db2.prepare("SELECT COUNT(*) as cnt FROM timeline WHERE event_date IS NULL").get() as any;
    expect(remaining.cnt).toBe(1);
    db2.close();
  });

  test("parses Chinese year formats", () => {
    const configPath = makeConfig(testDir);
    const db = makeDB(testDir);
    seedPage(db, "test/slug", "entity/person", "Test");

    db.prepare("INSERT INTO timeline (page_slug, event_date, summary) VALUES ($slug, $date, $summary)")
      .run({ $slug: "test/slug", $date: "1926年", $summary: "chinese year" });
    db.prepare("INSERT INTO timeline (page_slug, event_date, summary) VALUES ($slug, $date, $summary)")
      .run({ $slug: "test/slug", $date: "公元前384", $summary: "ancient" });
    db.close();

    const result = runCleanTimeline(configPath, "--execute");
    expect(result).toContain("2 normalized");

    const db2 = makeDB(testDir);
    const rows = db2.prepare("SELECT event_date, summary FROM timeline WHERE page_slug = 'test/slug' ORDER BY event_date").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].event_date).toBe("-0384-01-01");
    expect(rows[1].event_date).toBe("1926-01-01");
    db2.close();
  });
});
